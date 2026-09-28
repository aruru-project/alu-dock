import { FileChannel } from "./file-channel.js";
import { FileTransferSourceError } from "./file-transfer.js";
import { fileBytes } from "../core/source-file.js";
import { FILE_TRANSFER_CHUNK_BYTES } from "./protocol.js";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { MAX_PUBLISHED_FILE_BYTES, PublishedFileUnavailableError } from "../core/published-file.js";
import { ResourceContentError } from "../core/resource-content.js";
import { assertUnchangedSource, inspectSourceFile, MAX_SOURCE_FILE_PATH_CHARS, MAX_SOURCE_FILE_TRANSFER_BYTES, openUnchangedSource } from "../core/source-file.js";
import type { DockRegistry } from "./dock-registry.js";
import { InstanceWorkspace, InstanceWorkspaceError } from "./instance-workspace.js";
import type { FileTransferRequest } from "./protocol.js";
import type { SystemService } from "./system-service.js";

interface HostFileSource {
  handle: FileHandle;
  maximumBytes: number;
  sizeBytes?: number;
  result: Record<string, unknown>;
  verify?: () => Promise<void>;
  release(): void;
}

/** Business source selection only. No wire records, upload storage, or Worker byte transport. */
async function openHostFileSource(request: Exclude<FileTransferRequest, { type: "attachment.upload" }>, registry: DockRegistry, systems: SystemService | undefined, abort: AbortController): Promise<HostFileSource> {
  const instanceId = "instanceId" in request.params ? request.params.instanceId : undefined;
  const instance = instanceId === undefined ? undefined : registry.get(instanceId);
  // A source query may wait for a session change. Bind the transfer to the
  // generation that actually resolved it, not the one before that wait.
  let generation: number | undefined;
  const assertCurrent = () => {
    if (instance && (instance.snapshot().lifecycle !== "active" || (generation !== undefined && instance.runtimeGeneration !== generation))) {
      if (request.type === "workspace.file.read") throw new InstanceWorkspaceError("instance_not_active", "This work is not running. Reopen it and try again.");
      if (request.type === "resource.content") throw new ResourceContentError();
      throw new PublishedFileUnavailableError();
    }
    abort.signal.throwIfAborted();
  };
  assertCurrent();
  const release = instance?.subscribe(() => { try { assertCurrent(); } catch (error) { abort.abort(error); } }) ?? (() => {});
  let handle: FileHandle | undefined;
  try {
    if (request.type === "workspace.file.read") {
      const snapshot = instance!.snapshot();
      if (snapshot.lifecycle !== "active") throw new InstanceWorkspaceError("instance_not_active", "This work is not running. Reopen it and try again.");
      const opened = await new InstanceWorkspace(instanceId!, snapshot.cwd).openFile(request.params.path);
      handle = opened.handle;
      assertCurrent();
      return { handle, maximumBytes: MAX_SOURCE_FILE_TRANSFER_BYTES, result: { entry: opened.entry }, verify: async () => assertCurrent(), release };
    }
    if (request.type === "deliverable.download") {
      const opened = await instance!.openDeliverable(request.params.deliveryRef);
      handle = opened.handle;
      assertCurrent();
      return { handle, maximumBytes: MAX_SOURCE_FILE_TRANSFER_BYTES, sizeBytes: opened.dto.sizeBytes, result: { deliverable: opened.dto }, verify: async () => { assertCurrent(); await opened.verify(); }, release };
    }
    if (request.type === "file.read") {
      if ((request.params.offset ?? 0) !== 0) throw new PublishedFileUnavailableError();
      const resolved = await instance!.resolveRegisteredFile("published", request.params.fileRef);
      generation = resolved.runtimeGeneration;
      assertCurrent();
      if (resolved.source.kind !== "published" || resolved.source.file.fileRef !== request.params.fileRef) throw new PublishedFileUnavailableError();
      const { source, file } = resolved.source;
      handle = await openUnchangedSource(source);
      assertCurrent();
      const opened = handle;
      return { handle, maximumBytes: MAX_PUBLISHED_FILE_BYTES, sizeBytes: file.sizeBytes,
        result: { instanceId, runtimeGeneration: resolved.runtimeGeneration, file },
        verify: async () => { assertCurrent(); assertUnchangedSource(source, await opened.stat()); }, release };
    }
    if ((request.params.offset ?? 0) !== 0) throw new ResourceContentError();
    let path: string;
    if (request.type === "system.content") {
      if (!systems) throw new ResourceContentError();
      path = await systems.contentPath(request.params.cwd, request.params.id);
    } else {
      const resolved = await instance!.resolveRegisteredFile("resource", request.params.contentRef);
      generation = resolved.runtimeGeneration;
      assertCurrent();
      if (resolved.source.kind !== "resource") throw new ResourceContentError();
      path = resolved.source.path;
    }
    const source = await inspectSourceFile(path, { maxPathChars: MAX_SOURCE_FILE_PATH_CHARS, maxBytes: Number.MAX_SAFE_INTEGER });
    const revision = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    if (request.params.revision !== undefined && request.params.revision !== revision) throw new ResourceContentError();
    handle = await openUnchangedSource(source);
    assertCurrent();
    const opened = handle;
    return { handle, maximumBytes: Number.MAX_SAFE_INTEGER, sizeBytes: source.size, result: { revision },
      verify: async () => { assertCurrent(); assertUnchangedSource(source, await opened.stat()); }, release };
  } catch (error) {
    release();
    await handle?.close().catch(() => {});
    if (request.type === "file.read") throw new PublishedFileUnavailableError();
    if (request.type === "resource.content" || request.type === "system.content") throw new ResourceContentError();
    throw error;
  }
}

export async function sendHostFile(request: Exclude<FileTransferRequest, { type: "attachment.upload" }>, registry: DockRegistry, systems: SystemService | undefined, channel: FileChannel): Promise<Record<string, unknown>> {
  const source = await openHostFileSource(request, registry, systems, channel.abort);
  try {
    await channel.ready("download", request.type === "file.read"
      ? { file: source.result.file, runtimeGeneration: source.result.runtimeGeneration }
      : source.result);
    const summary = await channel.send({ source: fileBytes(source.handle, { sizeBytes: source.sizeBytes, chunkBytes: FILE_TRANSFER_CHUNK_BYTES, signal: channel.abort.signal }), maximumBytes: source.maximumBytes,
      ...(source.sizeBytes === undefined ? {} : { expected: { sizeBytes: source.sizeBytes } }) });
    await source.verify?.();
    await channel.write({ kind: "file_complete", ...summary });
    return { ...source.result, ...summary };
  } catch (error) {
    if (request.type === "resource.content" || request.type === "system.content") throw new ResourceContentError();
    if (request.type === "workspace.file.read") {
      if (error instanceof FileTransferSourceError && error.reason === "too_large") throw new InstanceWorkspaceError("workspace_file_too_large", "This file grew beyond 100 MiB. Use a smaller file and try again.");
      throw new InstanceWorkspaceError("workspace_entry_unavailable", "This file could not be read completely. Refresh the folder and try again.");
    }
    throw new PublishedFileUnavailableError();
  } finally {
    source.release();
    await source.handle.close().catch(() => {});
    channel.dispose();
  }
}
