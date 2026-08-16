import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  WorkspaceDirectoryEntry,
  WorkspaceListCursor,
  WorkspaceListResult,
} from "./protocol.js";

const MAX_BROWSABLE_DIRECTORIES = 100_000;
const SNAPSHOT_CACHE_SIZE = 2;
const SNAPSHOT_TTL_MS = 60_000;

export interface WorkspaceListRequest {
  path: string;
  cursor?: WorkspaceListCursor;
  limit: number;
}

export interface WorkspaceBrowser {
  list(request: WorkspaceListRequest): Promise<WorkspaceListResult>;
}

type WorkspaceBrowseErrorCode =
  | "workspace_changed"
  | "workspace_not_found"
  | "workspace_not_directory"
  | "workspace_permission_denied"
  | "workspace_too_large"
  | "workspace_unavailable";

export class WorkspaceBrowseError extends Error {
  constructor(
    readonly code: WorkspaceBrowseErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkspaceBrowseError";
  }
}

interface WorkspaceSnapshot {
  path: string;
  parent?: string;
  revision: string;
  fingerprint: string;
  entries: WorkspaceDirectoryEntry[];
  cachedAt: number;
}

/** Host-owned, read-only directory discovery. It never changes a process cwd. */
export class FileSystemWorkspaceBrowser implements WorkspaceBrowser {
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();

  async list(request: WorkspaceListRequest): Promise<WorkspaceListResult> {
    const requestedPath = resolve(request.path);
    const canonicalPath = await canonicalDirectory(requestedPath);
    const currentStats = await directoryStats(canonicalPath);
    const fingerprint = statsFingerprint(currentStats);
    const snapshot = await this.snapshot(canonicalPath, fingerprint, request.cursor?.revision);
    const offset = request.cursor?.offset ?? 0;
    if (offset > snapshot.entries.length) {
      throw new WorkspaceBrowseError(
        "workspace_changed",
        "This folder changed while it was loading. Refresh it and try again.",
        true,
      );
    }
    const entries = snapshot.entries.slice(offset, offset + request.limit);
    const nextOffset = offset + entries.length;
    const truncated = nextOffset < snapshot.entries.length;
    return {
      path: snapshot.path,
      ...(snapshot.parent === undefined ? {} : { parent: snapshot.parent }),
      revision: snapshot.revision,
      entries,
      total: snapshot.entries.length,
      truncated,
      ...(truncated ? { nextCursor: { revision: snapshot.revision, offset: nextOffset } } : {}),
    };
  }

  private async snapshot(path: string, fingerprint: string, expectedRevision?: string): Promise<WorkspaceSnapshot> {
    this.pruneCache();
    if (expectedRevision !== undefined) {
      const cached = this.snapshots.get(cacheKey(path, expectedRevision));
      if (cached && cached.fingerprint === fingerprint) {
        cached.cachedAt = Date.now();
        return cached;
      }
    }

    const scanned = await scanDirectory(path, fingerprint);
    if (expectedRevision !== undefined && scanned.revision !== expectedRevision) {
      throw new WorkspaceBrowseError(
        "workspace_changed",
        "This folder changed while it was loading. Refresh it and try again.",
        true,
      );
    }
    this.remember(scanned);
    return scanned;
  }

  private remember(snapshot: WorkspaceSnapshot): void {
    const key = cacheKey(snapshot.path, snapshot.revision);
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
    while (this.snapshots.size > SNAPSHOT_CACHE_SIZE) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
  }

  private pruneCache(): void {
    const cutoff = Date.now() - SNAPSHOT_TTL_MS;
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.cachedAt < cutoff) this.snapshots.delete(key);
    }
  }
}

async function scanDirectory(path: string, initialFingerprint: string): Promise<WorkspaceSnapshot> {
  const entries: WorkspaceDirectoryEntry[] = [];
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (entry.isDirectory()) {
        entries.push({ name: entry.name, kind: "directory", hidden: entry.name.startsWith(".") });
      } else if (entry.isSymbolicLink() && await symbolicLinkMayBeDirectory(join(path, entry.name))) {
        entries.push({ name: entry.name, kind: "symlink", hidden: entry.name.startsWith(".") });
      }
      if (entries.length > MAX_BROWSABLE_DIRECTORIES) {
        throw new WorkspaceBrowseError(
          "workspace_too_large",
          "This folder contains too many folders to browse at once. Enter the path you want directly.",
        );
      }
    }
  } catch (error) {
    throw mapFileSystemError(error, path);
  }

  const finalFingerprint = statsFingerprint(await directoryStats(path));
  if (finalFingerprint !== initialFingerprint) {
    throw new WorkspaceBrowseError(
      "workspace_changed",
      "This folder changed while it was loading. Refresh it and try again.",
      true,
    );
  }
  entries.sort(compareEntries);
  const revision = createHash("sha256")
    .update(path)
    .update("\0")
    .update(entries.map((entry) => `${entry.name}\0${entry.kind}`).join("\0"))
    .digest("base64url")
    .slice(0, 32);
  const parent = dirname(path);
  return {
    path,
    ...(parent === path ? {} : { parent }),
    revision,
    fingerprint: finalFingerprint,
    entries,
    cachedAt: Date.now(),
  };
}

async function symbolicLinkMayBeDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = errnoCode(error);
    return code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "ELOOP";
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw mapFileSystemError(error, path);
  }
  const stats = await directoryStats(canonical);
  if (!stats.isDirectory()) {
    throw new WorkspaceBrowseError(
      "workspace_not_directory",
      `${safePath(path)} is not a folder. Enter a folder path and try again.`,
    );
  }
  return canonical;
}

async function directoryStats(path: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error) {
    throw mapFileSystemError(error, path);
  }
}

function mapFileSystemError(error: unknown, path: string): WorkspaceBrowseError {
  if (error instanceof WorkspaceBrowseError) return error;
  const displayPath = safePath(path);
  const code = errnoCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new WorkspaceBrowseError(
      "workspace_permission_denied",
      `You do not have permission to open ${displayPath}. Choose another folder or enter a different path.`,
    );
  }
  if (code === "ENOENT") {
    return new WorkspaceBrowseError(
      "workspace_not_found",
      `${displayPath} does not exist. Check the path or choose another folder.`,
    );
  }
  if (code === "ENOTDIR") {
    return new WorkspaceBrowseError(
      "workspace_not_directory",
      `${displayPath} is not a folder. Enter a folder path and try again.`,
    );
  }
  if (code === "ELOOP") {
    return new WorkspaceBrowseError(
      "workspace_unavailable",
      `${displayPath} contains a symbolic-link loop. Choose another folder.`,
    );
  }
  return new WorkspaceBrowseError(
    "workspace_unavailable",
    `Could not open ${displayPath}. Try again or choose another folder.`,
    true,
  );
}

function compareEntries(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry): number {
  if (left.name === right.name) return left.kind.localeCompare(right.kind);
  return left.name < right.name ? -1 : 1;
}

function statsFingerprint(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function cacheKey(path: string, revision: string): string {
  return `${path}\0${revision}`;
}

function errnoCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function safePath(path: string): string {
  const safe = path
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return safe.length > 240 ? `${safe.slice(0, 239)}…` : safe || "That path";
}
