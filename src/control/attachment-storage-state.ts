import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";

import { ATTACHMENT_STORE_INTERNAL_DIRECTORY, ATTACHMENT_STORE_MANIFEST_DIRECTORY } from "./attachment-store-layout.js";
import { hardenWindowsPrivatePath, syncPrivateDirectory } from "../platform/private-state.js";

const SETTINGS_FILE = "attachment-storage.json";
const CHANGE_FILE = ".attachment-storage-changing.json";
const ACTIVE_UPLOAD_DIRECTORY = ".attachment-active-uploads";
const MAX_SETTINGS_BYTES = 64 * 1024;
const CHANGE_WAIT_ATTEMPTS = 500;

export interface AttachmentStorageSettings {
  schemaVersion: 1;
  revision: number;
  directory: string;
}

export class AttachmentStorageState {
  readonly filePath: string;
  private readonly changePath: string;
  private readonly activeUploadDirectory: string;

  constructor(readonly stateRoot: string, readonly defaultDirectory = defaultAttachmentDirectory()) {
    const root = resolve(stateRoot);
    this.filePath = join(root, SETTINGS_FILE);
    this.changePath = join(root, CHANGE_FILE);
    this.activeUploadDirectory = join(root, ACTIVE_UPLOAD_DIRECTORY);
  }

  async readSettings(): Promise<AttachmentStorageSettings> {
    try {
      if (process.platform === "win32") {
        const info = await lstat(this.filePath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Attachment storage settings are not a regular file");
        await hardenWindowsPrivatePath(this.filePath, false);
      }
      const bytes = await readFile(this.filePath);
      if (bytes.byteLength > MAX_SETTINGS_BYTES) throw new Error("Attachment storage settings are too large");
      return parseSettings(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const directory = resolve(this.defaultDirectory);
        return {
          schemaVersion: 1,
          revision: 0,
          directory: await realpath(directory).catch((pathError: unknown) => {
            if ((pathError as NodeJS.ErrnoException).code === "ENOENT") return directory;
            throw pathError;
          }),
        };
      }
      if (error instanceof SyntaxError) throw new Error("Attachment storage settings are not valid JSON");
      throw error;
    }
  }

  async writeDirectory(directory: string): Promise<AttachmentStorageSettings> {
    if (!isAbsolute(directory)) throw new Error("Attachment directory must be an absolute path");
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(directory)) throw new Error("Attachment directory contains an invalid character");
    const releaseChange = await this.claimDirectoryChange();
    try {
      if (await this.activeUploadCount() > 0) throw new Error("Attachment directory cannot be changed while an upload is active");
      const current = await this.readSettings();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const details = await stat(directory);
      if (!details.isDirectory()) throw new Error("Attachment directory must be a directory");
      const canonical = await realpath(directory);
      if (canonical !== current.directory && await hasCommittedAttachments(current.directory)) {
        throw new Error("Attachment directory cannot be changed after files have been stored; move the complete store before changing it");
      }
      const next: AttachmentStorageSettings = {
        schemaVersion: 1,
        revision: current.revision + 1,
        directory: canonical,
      };
      await writeAtomicJson(this.filePath, next);
      return next;
    } finally { await releaseChange(); }
  }

  async acquireUploadLease(): Promise<{ settings: AttachmentStorageSettings; release(): Promise<void> }> {
    await mkdir(this.activeUploadDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.activeUploadDirectory, 0o700);
    await hardenWindowsPrivatePath(this.activeUploadDirectory, true);
    for (let attempt = 0; attempt < CHANGE_WAIT_ATTEMPTS; attempt += 1) {
      if (await this.directoryChangeInProgress()) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        continue;
      }
      const settings = await this.readSettings();
      const marker = join(this.activeUploadDirectory, `${process.pid}-${randomUUID()}.lease`);
      const handle = await open(marker, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, revision: settings.revision, directory: settings.directory })}\n`, "utf8");
      } finally { await handle.close(); }
      if (!await this.directoryChangeInProgress()) {
        const confirmed = await this.readSettings();
        if (confirmed.revision === settings.revision && confirmed.directory === settings.directory) {
          let released = false;
          return {
            settings,
            release: async () => {
              if (released) return;
              released = true;
              await unlink(marker).catch(() => {});
            },
          };
        }
      }
      await unlink(marker).catch(() => {});
    }
    throw new Error("Attachment storage settings remained busy for too long");
  }

  private async claimDirectoryChange(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.changePath), { recursive: true, mode: 0o700 });
    await hardenWindowsPrivatePath(dirname(this.changePath), true);
    for (let attempt = 0; attempt < CHANGE_WAIT_ATTEMPTS; attempt += 1) {
      const token = randomUUID();
      try {
        const handle = await open(this.changePath, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8"); }
        finally { await handle.close(); }
        await hardenWindowsPrivatePath(this.changePath, false);
        return async () => {
          const owner = await readClaim(this.changePath);
          if (owner?.token === token) await unlink(this.changePath).catch(() => {});
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await removeDeadClaim(this.changePath)) continue;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    throw new Error("Attachment storage settings are busy");
  }

  private async directoryChangeInProgress(): Promise<boolean> {
    if (await removeDeadClaim(this.changePath)) return false;
    try { await stat(this.changePath); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async activeUploadCount(): Promise<number> {
    try {
      let active = 0;
      for (const name of await readdir(this.activeUploadDirectory)) {
        const pid = Number.parseInt(name.split("-", 1)[0] ?? "", 10);
        if (!Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid)) await unlink(join(this.activeUploadDirectory, name)).catch(() => {});
        else active += 1;
      }
      return active;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
}

export function attachmentStorageStateRoot(catalogPath: string): string {
  return dirname(resolve(catalogPath));
}

export function defaultAttachmentDirectory(): string {
  if (process.platform === "win32") {
    const localData = process.env.LOCALAPPDATA;
    return join(localData && isAbsolute(localData) ? localData : join(homedir(), "AppData", "Local"), "Alu Dock", "attachments");
  }
  const configured = process.env.XDG_DATA_HOME;
  const dataRoot = configured && isAbsolute(configured)
    ? configured
    : join(homedir(), ".local", "share");
  return join(dataRoot, "alu-dock", "attachments");
}

async function hasCommittedAttachments(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(join(directory, ATTACHMENT_STORE_INTERNAL_DIRECTORY, ATTACHMENT_STORE_MANIFEST_DIRECTORY));
    return entries.some((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readClaim(path: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; token?: unknown };
    return Number.isSafeInteger(raw.pid) && (raw.pid as number) > 0 && typeof raw.token === "string"
      ? { pid: raw.pid as number, token: raw.token }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function removeDeadClaim(path: string): Promise<boolean> {
  const claim = await readClaim(path);
  if (claim !== undefined && processAlive(claim.pid)) return false;
  if (claim === undefined) {
    try {
      const details = await stat(path);
      if (Date.now() - details.mtimeMs < 60_000) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  try { await unlink(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function parseSettings(raw: unknown): AttachmentStorageSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Attachment storage settings are invalid");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join("\u0000") !== ["directory", "revision", "schemaVersion"].sort().join("\u0000")) throw new Error("Attachment storage settings contain unsupported fields");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new Error("Attachment storage settings version is unsupported");
  if (typeof value.directory !== "string" || !isAbsolute(value.directory) || value.directory.length > 16_384 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.directory)) throw new Error("Attachment storage directory is invalid");
  return { schemaVersion: 1, revision: value.revision as number, directory: resolve(value.directory) };
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await hardenWindowsPrivatePath(parent, true);
  const temporary = join(parent, `.${SETTINGS_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
    await hardenWindowsPrivatePath(path, false);
    await syncPrivateDirectory(parent);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
