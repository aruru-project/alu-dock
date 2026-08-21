import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { MAX_SOURCE_FILE_TRANSFER_BYTES } from "../core/source-file.js";
import { MAX_WORKSPACE_SCAN_ENTRIES } from "./workspace-browser.js";
import {
  normalizeWorkspaceRelativePath,
  type WorkspaceEntryDto,
  type WorkspaceEntryListResult,
  type WorkspaceListCursor,
} from "./protocol.js";

export type InstanceWorkspaceErrorCode =
  | "instance_not_active"
  | "workspace_entry_not_found"
  | "workspace_entry_unavailable"
  | "workspace_entry_not_directory"
  | "workspace_entry_not_file"
  | "workspace_file_too_large"
  | "workspace_changed";

export class InstanceWorkspaceError extends Error {
  constructor(readonly code: InstanceWorkspaceErrorCode, message: string, readonly retryable = false) {
    super(message);
    this.name = "InstanceWorkspaceError";
  }
}

export class InstanceWorkspace {
  constructor(private readonly instanceId: string, private readonly rootPath: string) {}

  async list(path: string, cursor: WorkspaceListCursor | undefined, limit: number): Promise<WorkspaceEntryListResult> {
    const requested = normalizeWorkspaceRelativePath(path);
    const root = await canonicalRoot(this.rootPath);
    const directory = await canonicalTarget(root, requested);
    const directoryInfo = await safeStat(directory, "workspace_entry_not_found");
    if (!directoryInfo.isDirectory()) throw new InstanceWorkspaceError("workspace_entry_not_directory", "This workspace entry is not a folder. Choose a folder and try again.");

    const entries: WorkspaceEntryDto[] = [];
    let scannedEntries = 0;
    try {
      const stream = await opendir(directory);
      for await (const item of stream) {
        scannedEntries += 1;
        const entry = await describeEntry(root, requested, join(directory, item.name), item.name);
        if (entry) entries.push(entry);
        if (scannedEntries > MAX_WORKSPACE_SCAN_ENTRIES) {
          throw new InstanceWorkspaceError("workspace_entry_unavailable", "This folder has too many entries to show. Open a more specific folder and try again.");
        }
      }
    } catch (error) {
      if (error instanceof InstanceWorkspaceError) throw error;
      throw unavailable(error);
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.kind.localeCompare(right.kind));
    const revision = createHash("sha256").update(directory).update("\0").update(entries.map((entry) => `${entry.name}\0${entry.kind}\0${entry.targetKind ?? ""}`).join("\0")).digest("base64url").slice(0, 32);
    if (cursor && cursor.revision !== revision) throw new InstanceWorkspaceError("workspace_changed", "This folder changed. Open it again to see the latest entries.", true);
    const offset = cursor?.offset ?? 0;
    if (offset > entries.length) throw new InstanceWorkspaceError("workspace_changed", "This folder changed. Open it again to see the latest entries.", true);
    const page = entries.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      instanceId: this.instanceId,
      path: requested,
      revision,
      entries: page,
      total: entries.length,
      truncated: nextOffset < entries.length,
      ...(nextOffset < entries.length ? { nextCursor: { revision, offset: nextOffset } } : {}),
    };
  }

  async get(path: string): Promise<WorkspaceEntryDto> {
    const requested = normalizeWorkspaceRelativePath(path);
    const root = await canonicalRoot(this.rootPath);
    if (requested === ".") {
      const info = await safeStat(root, "workspace_entry_not_found");
      return { path: ".", name: ".", kind: "directory", hidden: false, ...(info.isFile() ? { sizeBytes: info.size } : {}) };
    }
    const parentPath = requested.split("/").slice(0, -1).join("/") || ".";
    const parent = await canonicalTarget(root, parentPath);
    assertContained(root, parent);
    const entry = await describeEntry(root, parentPath, join(parent, basename(requested)), basename(requested));
    if (!entry) throw new InstanceWorkspaceError("workspace_entry_unavailable", "This workspace entry is not a regular file or folder. Choose another entry.");
    return entry;
  }

  async openFile(path: string): Promise<{ entry: WorkspaceEntryDto; handle: FileHandle }> {
    const requested = normalizeWorkspaceRelativePath(path);
    const root = await canonicalRoot(this.rootPath);
    const entry = await this.get(requested);
    const target = await canonicalTarget(root, requested);
    if (entry.kind === "directory" || (entry.kind === "symlink" && entry.targetKind !== "file")) {
      throw new InstanceWorkspaceError("workspace_entry_not_file", "This workspace entry is not a readable file. Choose a file and try again.");
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile()) throw new InstanceWorkspaceError("workspace_entry_not_file", "This workspace entry is not a readable file. Choose a file and try again.");
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
      assertContained(root, openedPath);
      if (info.size > MAX_SOURCE_FILE_TRANSFER_BYTES) {
        throw new InstanceWorkspaceError("workspace_file_too_large", "This file is larger than 100 MiB. Choose a smaller file and try again.");
      }
      return { entry: { ...entry, sizeBytes: info.size }, handle };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof InstanceWorkspaceError) throw error;
      throw unavailable(error);
    }
  }
}

async function describeEntry(root: string, requestedPath: string, physicalPath: string, name: string): Promise<WorkspaceEntryDto | undefined> {
  const path = requestedPath === "." ? name : `${requestedPath}/${name}`;
  let info: Stats;
  try { info = await lstat(physicalPath); }
  catch (error) { throw unavailable(error); }
  const common = { path, name, hidden: name.startsWith(".") };
  if (!info.isSymbolicLink()) {
    if (info.isDirectory()) return { ...common, kind: "directory" };
    if (info.isFile()) return { ...common, kind: "file", sizeBytes: info.size };
    return undefined;
  }
  try {
    const target = await realpath(physicalPath);
    assertContained(root, target);
    const targetInfo = await stat(target);
    if (targetInfo.isFile()) return { ...common, kind: "symlink", targetKind: "file", sizeBytes: targetInfo.size };
    if (targetInfo.isDirectory()) return { ...common, kind: "symlink", targetKind: "directory" };
  } catch {
    return { ...common, kind: "symlink", targetKind: "unavailable" };
  }
  return { ...common, kind: "symlink", targetKind: "unavailable" };
}

async function canonicalRoot(path: string): Promise<string> {
  try { return await realpath(resolve(path)); }
  catch (error) { throw unavailable(error); }
}

async function canonicalTarget(root: string, path: string): Promise<string> {
  try {
    const target = await realpath(path === "." ? root : resolve(root, ...path.split("/")));
    assertContained(root, target);
    return target;
  } catch (error) {
    if (error instanceof InstanceWorkspaceError) throw error;
    throw unavailable(error);
  }
}

function assertContained(root: string, target: string): void {
  const fromRoot = relative(root, target);
  if (fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))) return;
  throw new InstanceWorkspaceError("workspace_entry_unavailable", "That entry points outside this workspace. Choose an entry inside the workspace.");
}

async function safeStat(path: string, missingCode: InstanceWorkspaceErrorCode): Promise<Stats> {
  try { return await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new InstanceWorkspaceError(missingCode, "This workspace entry no longer exists. Refresh the folder and try again.", true);
    throw unavailable(error);
  }
}

function unavailable(error: unknown): InstanceWorkspaceError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new InstanceWorkspaceError("workspace_entry_not_found", "This workspace entry no longer exists. Refresh the folder and try again.", true);
  if (code === "EACCES" || code === "EPERM") return new InstanceWorkspaceError("workspace_entry_unavailable", "This workspace entry cannot be read with your current permissions. Choose another entry or update its permissions.");
  return new InstanceWorkspaceError("workspace_entry_unavailable", "This workspace entry cannot be opened right now. Refresh the folder and try again.", true);
}
