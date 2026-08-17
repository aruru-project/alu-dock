import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILE_ID_CHARS,
  MAX_ATTACHMENT_LIST_ITEMS,
  MAX_ATTACHMENT_MEDIA_TYPE_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
  type AttachmentAccessRequest,
  type AttachmentAccessResult,
  type AttachmentDto,
  type AttachmentUploadResult,
  type InstanceAttachmentHostPort,
} from "../core/instance-attachments.js";
import type { AttachmentStorageState } from "./attachment-storage-state.js";

const INTERNAL_DIRECTORY = ".alu-dock";
const MANIFEST_DIRECTORY = "manifests";
const TEMP_DIRECTORY = "tmp";
const FILE_DIRECTORY = "files";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_STORAGE_NAME_BYTES = 240;
const SHA256 = /^[a-f0-9]{64}$/u;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface AttachmentManifest {
  schemaVersion: 1;
  attachment: AttachmentDto;
  storageName: string;
}

export interface BeginAttachmentUpload {
  name: string;
  sizeBytes: number;
  mediaType?: string;
  sha256: string;
}

export interface AttachmentUploadSink {
  readonly expectedSizeBytes: number;
  readonly receivedSizeBytes: number;
  write(chunk: Buffer): Promise<void>;
  complete(): Promise<AttachmentUploadResult>;
  abort(): Promise<void>;
}

export class AttachmentNotFoundError extends Error {
  readonly code = "attachment_not_found";
  constructor(readonly fileId: string) {
    super(`Attachment ${fileId} is unavailable`);
    this.name = "AttachmentNotFoundError";
  }
}

export class AttachmentIntegrityError extends Error {
  readonly code = "attachment_integrity";
  constructor(message: string) { super(message); this.name = "AttachmentIntegrityError"; }
}

export class AttachmentUnavailableError extends Error {
  readonly code = "attachment_unavailable";
  constructor() { super("Attachment storage is unavailable"); this.name = "AttachmentUnavailableError"; }
}

/** Host-owned attachment authority shared by Unix Socket, mTLS, and Worker reverse capabilities. */
export class AttachmentService implements InstanceAttachmentHostPort {
  private cached: { revision: number; directory: string; store: AttachmentStore } | undefined;
  private refresh: { revision: number; directory: string; promise: Promise<AttachmentStore> } | undefined;

  constructor(private readonly state: AttachmentStorageState) {}

  async beginUpload(input: BeginAttachmentUpload): Promise<AttachmentUploadSink> {
    validateUploadInput(input);
    const lease = await this.state.acquireUploadLease();
    try {
      const sink = await (await this.storeForSettings(lease.settings)).beginUpload(input);
      return new LeasedAttachmentUploadSink(sink, lease.release);
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async get(fileId: string): Promise<AttachmentDto> {
    try { return await (await this.currentStore()).get(fileId); }
    catch (error) { throw publicAttachmentError(error); }
  }

  async getMany(fileIds: readonly string[]): Promise<AttachmentDto[]> {
    try {
      const store = await this.currentStore();
      const seen = new Set<string>();
      const attachments: AttachmentDto[] = [];
      for (const fileId of fileIds) {
        if (seen.has(fileId)) throw new Error("Attachment references must be unique");
        seen.add(fileId);
        attachments.push(await store.get(fileId));
      }
      return attachments;
    } catch (error) { throw publicAttachmentError(error); }
  }

  async accessAttachments(sourceInstanceId: string, request: AttachmentAccessRequest): Promise<AttachmentAccessResult> {
    // Dock is local and single-user: source identity fences the reverse call,
    // but attachments intentionally have no per-instance ACL or namespace.
    void sourceInstanceId;
    try {
      const store = await this.currentStore();
      if (request.type === "list") {
        const all = await store.list();
        return {
          type: "list",
          attachments: all.slice(0, MAX_ATTACHMENT_LIST_ITEMS),
          total: all.length,
          truncated: all.length > MAX_ATTACHMENT_LIST_ITEMS,
        };
      }
      const resolved = await store.resolve(request.fileId);
      return { type: "resolve", ...resolved };
    } catch (error) { throw publicAttachmentError(error); }
  }

  private async currentStore(): Promise<AttachmentStore> {
    return this.storeForSettings(await this.state.readSettings());
  }

  private async storeForSettings(settings: { revision: number; directory: string }): Promise<AttachmentStore> {
    if (this.cached?.revision === settings.revision && this.cached.directory === settings.directory) return this.cached.store;
    if (this.refresh) {
      if (this.refresh.revision === settings.revision && this.refresh.directory === settings.directory) return this.refresh.promise;
      await this.refresh.promise;
      return this.storeForSettings(settings);
    }
    let refresh!: { revision: number; directory: string; promise: Promise<AttachmentStore> };
    const promise = (async () => {
      const store = new AttachmentStore(settings.directory);
      await store.initialize();
      this.cached = { revision: settings.revision, directory: settings.directory, store };
      return store;
    })().finally(() => { if (this.refresh === refresh) this.refresh = undefined; });
    refresh = { revision: settings.revision, directory: settings.directory, promise };
    this.refresh = refresh;
    return promise;
  }
}

export class AttachmentStore {
  root: string;
  private internal: string;
  private manifests: string;
  private temporary: string;
  private files: string;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private readonly byFileId = new Map<string, AttachmentManifest>();
  private readonly commitTails = new Map<string, Promise<void>>();

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("Attachment store path must be absolute");
    this.root = resolve(root);
    this.internal = join(this.root, INTERNAL_DIRECTORY);
    this.manifests = join(this.internal, MANIFEST_DIRECTORY);
    this.temporary = join(this.internal, TEMP_DIRECTORY);
    this.files = join(this.root, FILE_DIRECTORY);
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.performInitialize();
    return this.initializePromise;
  }

  async beginUpload(input: BeginAttachmentUpload): Promise<AttachmentUploadSink> {
    await this.initialize();
    const path = join(this.temporary, `upload-${randomUUID()}.part`);
    const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    return new FileAttachmentUploadSink(this, path, handle, input);
  }

  async get(fileId: string): Promise<AttachmentDto> {
    await this.initialize();
    validateFileId(fileId);
    const manifest = this.byFileId.get(fileId);
    if (!manifest) throw new AttachmentNotFoundError(fileId);
    await this.assertStoredFile(manifest, true);
    return structuredClone(manifest.attachment);
  }

  async list(): Promise<AttachmentDto[]> {
    await this.initialize();
    return [...this.byFileId.values()]
      .map((manifest) => structuredClone(manifest.attachment))
      .sort((left, right) => right.storedAt.localeCompare(left.storedAt) || left.fileId.localeCompare(right.fileId));
  }

  async resolve(fileId: string): Promise<{ attachment: AttachmentDto; path: string }> {
    await this.initialize();
    validateFileId(fileId);
    const manifest = this.byFileId.get(fileId);
    if (!manifest) throw new AttachmentNotFoundError(fileId);
    const path = await this.assertStoredFile(manifest, true);
    return { attachment: structuredClone(manifest.attachment), path };
  }

  async commit(path: string, input: BeginAttachmentUpload, actualSha256: string): Promise<AttachmentUploadResult> {
    return this.withDigestLock(actualSha256, async () => {
      const existing = await this.readManifestByDigest(actualSha256);
      if (existing) {
        const storedPath = join(this.files, existing.storageName);
        let valid = false;
        try {
          const details = await lstat(storedPath);
          valid = details.isFile() && !details.isSymbolicLink() && details.size === existing.attachment.sizeBytes
            && await hashFile(storedPath) === existing.attachment.sha256;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (valid) await unlink(path);
        else {
          await rename(path, storedPath);
          await chmod(storedPath, 0o600);
          await syncDirectory(this.files);
        }
        return { attachment: structuredClone(existing.attachment), status: "reused" };
      }

      const name = safeAttachmentName(input.name);
      const storageName = await this.publishContent(path, name);
      const attachment: AttachmentDto = {
        fileId: randomUUID(),
        name: storageName,
        sizeBytes: input.sizeBytes,
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
        sha256: actualSha256,
        storedAt: new Date().toISOString(),
      };
      const manifest: AttachmentManifest = { schemaVersion: 1, attachment, storageName };
      const manifestPath = join(this.manifests, `${actualSha256}.json`);
      const temporaryManifest = join(this.temporary, `manifest-${randomUUID()}.json`);
      try {
        await writeNewJson(temporaryManifest, manifest);
        try {
          await link(temporaryManifest, manifestPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await unlink(join(this.files, storageName)).catch(() => {});
          const winner = await this.readManifestByDigest(actualSha256);
          if (!winner) throw new Error("Concurrent attachment commit did not publish a readable manifest");
          return { attachment: structuredClone(winner.attachment), status: "reused" };
        }
        await syncDirectory(this.manifests);
        this.byFileId.set(attachment.fileId, manifest);
        return { attachment: structuredClone(attachment), status: "stored" };
      } catch (error) {
        await unlink(join(this.files, storageName)).catch(() => {});
        throw error;
      } finally {
        await unlink(temporaryManifest).catch(() => {});
      }
    });
  }

  private async performInitialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootDetails = await lstat(this.root);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) throw new Error("Attachment store root must be a regular directory");
    const canonicalRoot = await realpath(this.root);
    if (canonicalRoot !== this.root) {
      // A canonical root may live below a symlinked XDG/home parent. The root
      // itself must not be a symlink, and all managed children are checked below.
      this.root = canonicalRoot;
      this.internal = join(this.root, INTERNAL_DIRECTORY);
      this.manifests = join(this.internal, MANIFEST_DIRECTORY);
      this.temporary = join(this.internal, TEMP_DIRECTORY);
      this.files = join(this.root, FILE_DIRECTORY);
    }
    await mkdir(this.internal, { recursive: true, mode: 0o700 });
    await mkdir(this.manifests, { recursive: true, mode: 0o700 });
    await mkdir(this.temporary, { recursive: true, mode: 0o700 });
    await mkdir(this.files, { recursive: true, mode: 0o700 });
    await Promise.all([this.internal, this.manifests, this.temporary, this.files].map(assertManagedDirectory));
    await Promise.all([this.internal, this.manifests, this.temporary, this.files].map((path) => chmod(path, 0o700)));

    for (const name of await readdir(this.temporary)) await unlink(join(this.temporary, name)).catch(() => {});
    const referenced = new Set<string>();
    for (const name of await readdir(this.manifests)) {
      if (!SHA256.test(name.slice(0, -5)) || !name.endsWith(".json")) throw new Error("Attachment store contains an invalid manifest name");
      const manifest = await readManifest(join(this.manifests, name));
      if (`${manifest.attachment.sha256}.json` !== name) throw new Error("Attachment manifest digest does not match its name");
      if (this.byFileId.has(manifest.attachment.fileId)) throw new Error("Attachment store contains a duplicate file ID");
      this.byFileId.set(manifest.attachment.fileId, manifest);
      referenced.add(manifest.storageName);
    }
    for (const name of await readdir(this.files)) {
      if (!referenced.has(name)) await unlink(join(this.files, name)).catch(() => {});
    }
    this.initialized = true;
  }

  private async publishContent(temporaryPath: string, requestedName: string): Promise<string> {
    const extension = extname(requestedName);
    const stem = extension.length > 0 && extension !== requestedName ? requestedName.slice(0, -extension.length) : requestedName;
    for (let number = 1; number < 100_000; number += 1) {
      const candidate = number === 1 ? requestedName : clampStorageName(`${stem} (${number})${extension}`);
      try {
        await link(temporaryPath, join(this.files, candidate));
        await chmod(join(this.files, candidate), 0o600);
        await syncDirectory(this.files);
        await unlink(temporaryPath);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("Attachment filename collision limit was reached");
  }

  private async readManifestByDigest(sha256: string): Promise<AttachmentManifest | undefined> {
    try {
      const manifest = await readManifest(join(this.manifests, `${sha256}.json`));
      this.byFileId.set(manifest.attachment.fileId, manifest);
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async assertStoredFile(manifest: AttachmentManifest, verifyHash: boolean): Promise<string> {
    const path = join(this.files, manifest.storageName);
    let details;
    try { details = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AttachmentNotFoundError(manifest.attachment.fileId);
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size !== manifest.attachment.sizeBytes) {
      throw new AttachmentIntegrityError(`Attachment ${manifest.attachment.fileId} no longer matches its stored metadata`);
    }
    if (verifyHash && await hashFile(path) !== manifest.attachment.sha256) {
      throw new AttachmentIntegrityError(`Attachment ${manifest.attachment.fileId} no longer matches its stored digest`);
    }
    const canonical = await realpath(path);
    if (!canonical.startsWith(`${this.files}/`)) throw new AttachmentIntegrityError("Attachment resolved outside its managed store");
    return canonical;
  }

  private async withDigestLock<T>(digest: string, work: () => Promise<T>): Promise<T> {
    const previous = this.commitTails.get(digest) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const tail = previous.then(() => current);
    this.commitTails.set(digest, tail);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.commitTails.get(digest) === tail) this.commitTails.delete(digest);
    }
  }
}

class LeasedAttachmentUploadSink implements AttachmentUploadSink {
  private released = false;

  constructor(private readonly sink: AttachmentUploadSink, private readonly releaseLease: () => Promise<void>) {}

  get expectedSizeBytes(): number { return this.sink.expectedSizeBytes; }
  get receivedSizeBytes(): number { return this.sink.receivedSizeBytes; }
  write(chunk: Buffer): Promise<void> { return this.sink.write(chunk); }

  async complete(): Promise<AttachmentUploadResult> {
    try { return await this.sink.complete(); }
    finally { await this.release(); }
  }

  async abort(): Promise<void> {
    try { await this.sink.abort(); }
    finally { await this.release(); }
  }

  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.releaseLease();
  }
}

class FileAttachmentUploadSink implements AttachmentUploadSink {
  private hash: Hash | undefined = createHash("sha256");
  private received = 0;
  private finished = false;

  constructor(
    private readonly store: AttachmentStore,
    private readonly path: string,
    private handle: FileHandle | undefined,
    private readonly input: BeginAttachmentUpload,
  ) {}

  get expectedSizeBytes(): number { return this.input.sizeBytes; }
  get receivedSizeBytes(): number { return this.received; }

  async write(chunk: Buffer): Promise<void> {
    if (this.finished || !this.handle || !this.hash) throw new Error("Attachment upload is already closed");
    if (!Buffer.isBuffer(chunk) || chunk.byteLength === 0) throw new Error("Attachment chunks must contain bytes");
    if (this.received + chunk.byteLength > this.input.sizeBytes || this.received + chunk.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment upload exceeds its declared size");
    }
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(chunk, offset, chunk.byteLength - offset, this.received + offset);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > chunk.byteLength - offset) {
        throw new Error("Attachment storage made no forward write progress");
      }
      offset += bytesWritten;
    }
    this.hash.update(chunk);
    this.received += chunk.byteLength;
  }

  async complete(): Promise<AttachmentUploadResult> {
    if (this.finished || !this.handle || !this.hash) throw new Error("Attachment upload is already closed");
    this.finished = true;
    const handle = this.handle;
    this.handle = undefined;
    const hash = this.hash;
    this.hash = undefined;
    try {
      if (this.received !== this.input.sizeBytes) throw new Error(`Attachment upload received ${this.received} bytes; expected ${this.input.sizeBytes}`);
      const digest = hash.digest("hex");
      if (digest !== this.input.sha256) throw new AttachmentIntegrityError("Attachment SHA-256 does not match the client declaration");
      await handle.sync();
      await handle.close();
      return await this.store.commit(this.path, this.input, digest);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(this.path).catch(() => {});
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.hash = undefined;
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close().catch(() => {});
    await unlink(this.path).catch(() => {});
  }
}

function validateUploadInput(input: BeginAttachmentUpload): void {
  if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > MAX_ATTACHMENT_NAME_CHARS) throw new Error("Attachment name is invalid");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment size must be between 0 and ${MAX_ATTACHMENT_BYTES} bytes`);
  if (!SHA256.test(input.sha256)) throw new Error("Attachment SHA-256 must be 64 lowercase hexadecimal characters");
  if (input.mediaType !== undefined && (typeof input.mediaType !== "string" || input.mediaType.length < 1 || input.mediaType.length > MAX_ATTACHMENT_MEDIA_TYPE_CHARS || /[\u0000-\u001f\u007f-\u009f]/u.test(input.mediaType))) {
    throw new Error("Attachment media type is invalid");
  }
}

function validateFileId(fileId: string): void {
  if (typeof fileId !== "string" || fileId.length > MAX_ATTACHMENT_FILE_ID_CHARS || !FILE_ID.test(fileId)) throw new AttachmentNotFoundError(String(fileId));
}

export function safeAttachmentName(input: string): string {
  let safe = input.normalize("NFC").replace(/[\\/\u0000-\u001f\u007f-\u009f]/gu, "_").trim();
  if (safe === "" || safe === "." || safe === "..") safe = "attachment";
  return clampStorageName(safe);
}

function clampStorageName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_STORAGE_NAME_BYTES) return name;
  const extension = extname(name);
  const usableExtension = Buffer.byteLength(extension, "utf8") <= 64 ? extension : "";
  const stem = usableExtension ? name.slice(0, -usableExtension.length) : name;
  let result = "";
  for (const character of stem) {
    if (Buffer.byteLength(`${result}${character}${usableExtension}`, "utf8") > MAX_STORAGE_NAME_BYTES) break;
    result += character;
  }
  return `${result || "attachment"}${usableExtension}`;
}

async function readManifest(path: string): Promise<AttachmentManifest> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_MANIFEST_BYTES) throw new Error("Attachment manifest is not a bounded regular file");
  return parseManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function parseManifest(raw: unknown): AttachmentManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Attachment manifest is invalid");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "attachment", "storageName"]);
  if (value.schemaVersion !== 1 || typeof value.storageName !== "string" || safeAttachmentName(value.storageName) !== value.storageName) throw new Error("Attachment manifest metadata is invalid");
  const attachment = parseAttachment(value.attachment);
  if (attachment.name !== value.storageName) throw new Error("Attachment manifest name is inconsistent");
  return { schemaVersion: 1, attachment, storageName: value.storageName };
}

function parseAttachment(raw: unknown): AttachmentDto {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Attachment metadata is invalid");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["fileId", "name", "sizeBytes", "sha256", "storedAt"], ["mediaType"]);
  validateFileId(value.fileId as string);
  if (typeof value.name !== "string" || safeAttachmentName(value.name) !== value.name) throw new Error("Attachment metadata name is invalid");
  if (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0 || (value.sizeBytes as number) > MAX_ATTACHMENT_BYTES) throw new Error("Attachment metadata size is invalid");
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Error("Attachment metadata digest is invalid");
  if (typeof value.storedAt !== "string" || !Number.isFinite(Date.parse(value.storedAt))) throw new Error("Attachment metadata timestamp is invalid");
  if (value.mediaType !== undefined && (typeof value.mediaType !== "string" || value.mediaType.length < 1 || value.mediaType.length > MAX_ATTACHMENT_MEDIA_TYPE_CHARS)) throw new Error("Attachment metadata media type is invalid");
  return {
    fileId: value.fileId as string,
    name: value.name,
    sizeBytes: value.sizeBytes as number,
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType as string }),
    sha256: value.sha256,
    storedAt: value.storedAt,
  };
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Attachment record contains unsupported fields");
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, position);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}

function publicAttachmentError(error: unknown): Error {
  if (error instanceof AttachmentNotFoundError || error instanceof AttachmentIntegrityError || error instanceof AttachmentUnavailableError) return error;
  return new AttachmentUnavailableError();
}

async function assertManagedDirectory(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error("Attachment store contains a non-canonical managed directory");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
