import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

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
import { ATTACHMENT_STORE_INTERNAL_DIRECTORY, ATTACHMENT_STORE_MANIFEST_DIRECTORY } from "./attachment-store-layout.js";
import { hardenWindowsPrivatePath, noFollowFlag, syncPrivateDirectory } from "../platform/private-state.js";
const ATTACHMENT_DIRECTORY = "attachments";
const TEMP_DIRECTORY = "tmp";
const FILE_DIRECTORY = "files";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_STORAGE_NAME_BYTES = 240;
const SHA256 = /^[a-f0-9]{64}$/u;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface ContentManifest {
  schemaVersion: 1;
  sha256: string;
  sizeBytes: number;
  storageName: string;
}

interface AttachmentMetadataManifest {
  schemaVersion: 1;
  attachment: AttachmentDto;
}

interface AttachmentRecord {
  attachment: AttachmentDto;
  content: ContentManifest;
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
  private attachments: string;
  private temporary: string;
  private files: string;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private readonly contentByDigest = new Map<string, ContentManifest>();
  private readonly byFileId = new Map<string, AttachmentRecord>();
  private readonly byIdentity = new Map<string, AttachmentRecord>();
  private readonly commitTails = new Map<string, Promise<void>>();

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("Attachment store path must be absolute");
    this.root = resolve(root);
    this.internal = join(this.root, ATTACHMENT_STORE_INTERNAL_DIRECTORY);
    this.manifests = join(this.internal, ATTACHMENT_STORE_MANIFEST_DIRECTORY);
    this.attachments = join(this.internal, ATTACHMENT_DIRECTORY);
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
    const record = this.byFileId.get(fileId);
    if (!record) throw new AttachmentNotFoundError(fileId);
    await this.assertStoredFile(record.content, fileId, true);
    return structuredClone(record.attachment);
  }

  async list(): Promise<AttachmentDto[]> {
    await this.initialize();
    return [...this.byFileId.values()]
      .map((record) => structuredClone(record.attachment))
      .sort((left, right) => right.storedAt.localeCompare(left.storedAt) || left.fileId.localeCompare(right.fileId));
  }

  async resolve(fileId: string): Promise<{ attachment: AttachmentDto; path: string }> {
    await this.initialize();
    validateFileId(fileId);
    const record = this.byFileId.get(fileId);
    if (!record) throw new AttachmentNotFoundError(fileId);
    const path = await this.assertStoredFile(record.content, fileId, true);
    return { attachment: structuredClone(record.attachment), path };
  }

  async commit(path: string, input: BeginAttachmentUpload, actualSha256: string): Promise<AttachmentUploadResult> {
    return this.withDigestLock(actualSha256, async () => {
      const displayName = safeAttachmentName(input.name);
      let content = await this.readContentByDigest(actualSha256);
      let status: AttachmentUploadResult["status"] = "reused";
      if (content) {
        await this.acceptOrRepairContent(path, content, input.sizeBytes);
      } else {
        const storageName = await this.publishContent(path, displayName);
        const candidate: ContentManifest = {
          schemaVersion: 1,
          sha256: actualSha256,
          sizeBytes: input.sizeBytes,
          storageName,
        };
        const candidatePath = join(this.files, storageName);
        try {
          if (await this.publishContentManifest(candidate)) {
            content = candidate;
            this.contentByDigest.set(actualSha256, content);
            status = "stored";
          } else {
            const winner = await this.readContentByDigest(actualSha256);
            if (!winner) throw new Error("Concurrent attachment commit did not publish a readable content manifest");
            await this.acceptOrRepairContent(candidatePath, winner, input.sizeBytes);
            content = winner;
          }
        } catch (error) {
          await unlink(candidatePath).catch(() => {});
          throw error;
        }
      }

      const identity = attachmentIdentity(actualSha256, displayName, input.mediaType);
      const existing = this.byIdentity.get(identity);
      if (existing) return { attachment: structuredClone(existing.attachment), status: "reused" };

      const attachment: AttachmentDto = {
        fileId: randomUUID(),
        name: displayName,
        sizeBytes: input.sizeBytes,
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
        sha256: actualSha256,
        storedAt: new Date().toISOString(),
      };
      await this.publishAttachmentManifest({ schemaVersion: 1, attachment });
      this.registerAttachment(attachment, content);
      return { attachment: structuredClone(attachment), status };
    });
  }

  private async performInitialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootDetails = await lstat(this.root);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) throw new Error("Attachment store root must be a regular directory");
    const canonicalRoot = await realpath(this.root);
    if (relative(canonicalRoot, this.root) !== "") {
      // A canonical root may live below a symlinked XDG/home parent. The root
      // itself must not be a symlink, and all managed children are checked below.
      this.root = canonicalRoot;
      this.internal = join(this.root, ATTACHMENT_STORE_INTERNAL_DIRECTORY);
      this.manifests = join(this.internal, ATTACHMENT_STORE_MANIFEST_DIRECTORY);
      this.attachments = join(this.internal, ATTACHMENT_DIRECTORY);
      this.temporary = join(this.internal, TEMP_DIRECTORY);
      this.files = join(this.root, FILE_DIRECTORY);
    }
    await mkdir(this.internal, { recursive: true, mode: 0o700 });
    await mkdir(this.manifests, { recursive: true, mode: 0o700 });
    await mkdir(this.attachments, { recursive: true, mode: 0o700 });
    await mkdir(this.temporary, { recursive: true, mode: 0o700 });
    await mkdir(this.files, { recursive: true, mode: 0o700 });
    const managed = [this.internal, this.manifests, this.attachments, this.temporary, this.files];
    await Promise.all(managed.map(assertManagedDirectory));
    await Promise.all(managed.map((path) => chmod(path, 0o700)));
    await hardenWindowsPrivatePath(this.root, true);
    await Promise.all(managed.map((path) => hardenWindowsPrivatePath(path, true)));

    for (const name of await readdir(this.temporary)) await unlink(join(this.temporary, name)).catch(() => {});
    const referenced = new Set<string>();
    for (const name of await readdir(this.manifests)) {
      if (!name.endsWith(".json") || !SHA256.test(name.slice(0, -5))) throw new Error("Attachment store contains an invalid content manifest name");
      const content = await readContentManifest(join(this.manifests, name));
      if (`${content.sha256}.json` !== name) throw new Error("Attachment content manifest digest does not match its name");
      this.registerContent(content);
      referenced.add(content.storageName);
    }
    for (const name of await readdir(this.attachments)) {
      if (!name.endsWith(".json") || !FILE_ID.test(name.slice(0, -5))) throw new Error("Attachment store contains an invalid attachment manifest name");
      const manifest = await readAttachmentManifest(join(this.attachments, name));
      if (`${manifest.attachment.fileId}.json` !== name) throw new Error("Attachment metadata manifest ID does not match its name");
      const content = this.contentByDigest.get(manifest.attachment.sha256);
      if (!content || content.sizeBytes !== manifest.attachment.sizeBytes) throw new Error("Attachment metadata refers to unavailable content");
      this.registerAttachment(manifest.attachment, content);
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
      const destination = join(this.files, candidate);
      let published = false;
      try {
        await link(temporaryPath, destination);
        published = true;
        await chmod(destination, 0o600);
        await hardenWindowsPrivatePath(destination, false);
        await syncDirectory(this.files);
        await unlink(temporaryPath);
        return candidate;
      } catch (error) {
        if (!published && (error as NodeJS.ErrnoException).code === "EEXIST") continue;
        if (published) {
          await unlink(destination).catch(() => {});
          await syncDirectory(this.files).catch(() => {});
        }
        throw error;
      }
    }
    throw new Error("Attachment filename collision limit was reached");
  }

  private async readContentByDigest(sha256: string): Promise<ContentManifest | undefined> {
    const cached = this.contentByDigest.get(sha256);
    if (cached) return cached;
    try {
      const content = await readContentManifest(join(this.manifests, `${sha256}.json`));
      if (content.sha256 !== sha256) throw new Error("Attachment content manifest digest is inconsistent");
      this.registerContent(content);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async publishContentManifest(manifest: ContentManifest): Promise<boolean> {
    const temporary = join(this.temporary, `content-${randomUUID()}.json`);
    const destination = join(this.manifests, `${manifest.sha256}.json`);
    let published = false;
    try {
      await writeNewJson(temporary, manifest);
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      published = true;
      await syncDirectory(this.manifests);
      return true;
    } catch (error) {
      if (published) {
        await unlink(destination).catch(() => {});
        await syncDirectory(this.manifests).catch(() => {});
      }
      throw error;
    } finally { await unlink(temporary).catch(() => {}); }
  }

  private async publishAttachmentManifest(manifest: AttachmentMetadataManifest): Promise<void> {
    const temporary = join(this.temporary, `attachment-${randomUUID()}.json`);
    const destination = join(this.attachments, `${manifest.attachment.fileId}.json`);
    let published = false;
    try {
      await writeNewJson(temporary, manifest);
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Attachment file ID collision");
        throw error;
      }
      published = true;
      await syncDirectory(this.attachments);
    } catch (error) {
      if (published) {
        await unlink(destination).catch(() => {});
        await syncDirectory(this.attachments).catch(() => {});
      }
      throw error;
    } finally { await unlink(temporary).catch(() => {}); }
  }

  private async acceptOrRepairContent(provisionalPath: string, content: ContentManifest, expectedSizeBytes: number): Promise<void> {
    if (content.sizeBytes !== expectedSizeBytes) throw new AttachmentIntegrityError("Attachment content manifest size is inconsistent");
    const storedPath = join(this.files, content.storageName);
    let valid = false;
    try {
      const details = await lstat(storedPath);
      valid = details.isFile() && !details.isSymbolicLink() && details.size === content.sizeBytes
        && await hashFile(storedPath) === content.sha256;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (valid) {
      if (resolve(provisionalPath) !== resolve(storedPath)) await unlink(provisionalPath);
      return;
    }
    if (resolve(provisionalPath) === resolve(storedPath)) throw new AttachmentIntegrityError("Attachment content could not be repaired in place");
    await rename(provisionalPath, storedPath);
    await chmod(storedPath, 0o600);
    await hardenWindowsPrivatePath(storedPath, false);
    await syncDirectory(this.files);
  }

  private registerContent(content: ContentManifest): void {
    const existing = this.contentByDigest.get(content.sha256);
    if (existing && (existing.sizeBytes !== content.sizeBytes || existing.storageName !== content.storageName)) {
      throw new Error("Attachment store contains conflicting content manifests");
    }
    this.contentByDigest.set(content.sha256, content);
  }

  private registerAttachment(attachment: AttachmentDto, content: ContentManifest): void {
    if (attachment.sha256 !== content.sha256 || attachment.sizeBytes !== content.sizeBytes) {
      throw new Error("Attachment metadata does not match its stored content");
    }
    const existingId = this.byFileId.get(attachment.fileId);
    if (existingId) {
      if (!sameAttachment(existingId.attachment, attachment)) throw new Error("Attachment store contains a duplicate file ID");
      return;
    }
    const identity = attachmentIdentity(attachment.sha256, attachment.name, attachment.mediaType);
    const existingIdentity = this.byIdentity.get(identity);
    const record = { attachment, content };
    this.byFileId.set(attachment.fileId, record);
    if (!existingIdentity
      || attachment.storedAt.localeCompare(existingIdentity.attachment.storedAt) < 0
      || (attachment.storedAt === existingIdentity.attachment.storedAt && attachment.fileId.localeCompare(existingIdentity.attachment.fileId) < 0)) {
      this.byIdentity.set(identity, record);
    }
  }

  private async assertStoredFile(content: ContentManifest, fileId: string, verifyHash: boolean): Promise<string> {
    const path = join(this.files, content.storageName);
    let details;
    try { details = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AttachmentNotFoundError(fileId);
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size !== content.sizeBytes) {
      throw new AttachmentIntegrityError(`Attachment ${fileId} no longer matches its stored metadata`);
    }
    if (verifyHash && await hashFile(path) !== content.sha256) {
      throw new AttachmentIntegrityError(`Attachment ${fileId} no longer matches its stored digest`);
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

function attachmentIdentity(sha256: string, name: string, mediaType: string | undefined): string {
  return JSON.stringify([sha256, name, mediaType ?? null]);
}

function sameAttachment(left: AttachmentDto, right: AttachmentDto): boolean {
  return left.fileId === right.fileId
    && left.name === right.name
    && left.sizeBytes === right.sizeBytes
    && left.mediaType === right.mediaType
    && left.sha256 === right.sha256
    && left.storedAt === right.storedAt;
}

async function readContentManifest(path: string): Promise<ContentManifest> {
  return parseContentManifest(await readBoundedManifest(path));
}

async function readAttachmentManifest(path: string): Promise<AttachmentMetadataManifest> {
  const raw = await readBoundedManifest(path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Attachment metadata manifest is invalid");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "attachment"]);
  if (value.schemaVersion !== 1) throw new Error("Attachment metadata manifest version is unsupported");
  return { schemaVersion: 1, attachment: parseAttachment(value.attachment) };
}

async function readBoundedManifest(path: string): Promise<unknown> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_MANIFEST_BYTES) throw new Error("Attachment manifest is not a bounded regular file");
  await hardenWindowsPrivatePath(path, false);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseContentManifest(raw: unknown): ContentManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Attachment content manifest is invalid");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "sha256", "sizeBytes", "storageName"]);
  if (value.schemaVersion !== 1
    || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)
    || !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0 || (value.sizeBytes as number) > MAX_ATTACHMENT_BYTES
    || typeof value.storageName !== "string" || safeAttachmentName(value.storageName) !== value.storageName) {
    throw new Error("Attachment content manifest metadata is invalid");
  }
  return { schemaVersion: 1, sha256: value.sha256, sizeBytes: value.sizeBytes as number, storageName: value.storageName };
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
  if (value.mediaType !== undefined && (typeof value.mediaType !== "string" || value.mediaType.length < 1 || value.mediaType.length > MAX_ATTACHMENT_MEDIA_TYPE_CHARS || /[\u0000-\u001f\u007f-\u009f]/u.test(value.mediaType))) throw new Error("Attachment metadata media type is invalid");
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
  await hardenWindowsPrivatePath(path, false);
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
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
  if (!details.isDirectory() || details.isSymbolicLink() || relative(await realpath(path), resolve(path)) !== "") {
    throw new Error("Attachment store contains a non-canonical managed directory");
  }
}

async function syncDirectory(path: string): Promise<void> {
  await syncPrivateDirectory(path);
}
