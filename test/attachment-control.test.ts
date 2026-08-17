import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AttachmentService } from "../src/control/attachment-service.js";
import { AttachmentStorageState } from "../src/control/attachment-storage-state.js";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

function source(name: string, bytes: Buffer, mediaType?: string) {
  return {
    name,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(mediaType === undefined ? {} : { mediaType }),
    async *open(): AsyncIterable<Uint8Array> {
      // Deliberately cross the 512 KiB Protocol V2 upload-frame boundary.
      yield bytes.subarray(0, 700_000);
      yield bytes.subarray(700_000);
    },
  };
}

test("Hosts without attachment storage do not advertise attachments.v1", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-attachment-capability-"));
  const socketPath = join(root, "dock.sock");
  const registry = new DockRegistry(async () => { throw new Error("runtime not expected"); });
  const host = new DockHost({ socketPath, registry });
  await host.start();
  try {
    let opened = false;
    await assert.rejects(new DockClient({ socketPath }).uploadAttachment({
      name: "unavailable.bin", sizeBytes: 0,
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      async *open() { opened = true; },
    }, "unavailable-upload"), (error: unknown) => error instanceof Error && "code" in error && error.code === "capability_missing");
    assert.equal(opened, false);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Protocol V2 separates logical attachment metadata from deduplicated content", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-attachment-control-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "dock.sock");
  const storagePath = join(root, "permanent files");
  const state = new AttachmentStorageState(join(root, "state"), storagePath);
  const service = new AttachmentService(state);
  const registry = new DockRegistry(async () => { throw new Error("runtime not expected"); }, undefined, { attachmentHostPort: service });
  const host = new DockHost({ socketPath, registry, attachmentService: service });
  await host.start();
  try {
    const bytes = Buffer.alloc(900_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const client = new DockClient({ socketPath });
    const first = await client.uploadAttachment(source("报告 / final copy.bin", bytes, "application/octet-stream"), "upload-one");
    assert.equal(first.status, "stored");
    assert.equal(first.attachment.name, "报告 _ final copy.bin");
    assert.equal(first.attachment.sizeBytes, bytes.byteLength);
    assert.equal(first.attachment.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.doesNotMatch(JSON.stringify(first), new RegExp(storagePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    const resolved = await service.accessAttachments("instance-a", { type: "resolve", fileId: first.attachment.fileId });
    assert.equal(resolved.type, "resolve");
    if (resolved.type !== "resolve") throw new Error("unexpected list result");
    assert.deepEqual(await readFile(resolved.path), bytes);

    let reopened = false;
    const recovered = await client.uploadAttachment({ ...source("报告 / final copy.bin", bytes, "application/octet-stream"), async *open() { reopened = true; yield bytes; } }, "upload-one");
    assert.deepEqual(recovered, first);
    assert.equal(reopened, false, "a repeated operation receipt must not request the body again");
    await assert.rejects(client.uploadAttachment(source("different.dat", Buffer.from("different")), "upload-one"), (error: unknown) => (
      error instanceof Error && "code" in error && error.code === "operation_conflict"
    ));

    const duplicate = await client.uploadAttachment(source("another-name.dat", bytes), "upload-two");
    assert.equal(duplicate.status, "reused");
    assert.notEqual(duplicate.attachment.fileId, first.attachment.fileId);
    assert.equal(duplicate.attachment.name, "another-name.dat");
    assert.equal(duplicate.attachment.mediaType, undefined);
    const duplicateResolved = await service.accessAttachments("instance-a", { type: "resolve", fileId: duplicate.attachment.fileId });
    assert.equal(duplicateResolved.type, "resolve");
    if (duplicateResolved.type !== "resolve") throw new Error("unexpected list result");
    assert.equal(duplicateResolved.path, resolved.path, "logical attachments with identical bytes share one stored file");

    const exactRepeat = await client.uploadAttachment(source("another-name.dat", bytes), "upload-three");
    assert.equal(exactRepeat.status, "reused");
    assert.deepEqual(exactRepeat.attachment, duplicate.attachment, "identical logical metadata remains stable across uploads");

    const typedAlias = await client.uploadAttachment(source("another-name.dat", bytes, "text/plain"), "upload-four");
    assert.equal(typedAlias.status, "reused");
    assert.notEqual(typedAlias.attachment.fileId, duplicate.attachment.fileId);
    assert.equal(typedAlias.attachment.mediaType, "text/plain");

    await assert.rejects(client.uploadAttachment({
      name: "partial.bin", sizeBytes: 20, sha256: createHash("sha256").update(Buffer.alloc(20)).digest("hex"),
      async *open() { yield Buffer.alloc(5); throw new Error("source disconnected"); },
    }, "upload-partial"), /source disconnected/u);
    const afterDisconnect = await service.accessAttachments("instance-b", { type: "list" });
    assert.equal(afterDisconnect.type === "list" ? afterDisconnect.total : -1, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recoveredPartial = await client.uploadAttachment(source("partial.bin", Buffer.alloc(20)), "upload-partial");
    assert.equal(recoveredPartial.status, "stored", "a pre-completion disconnect must leave the operation retryable");

    const restarted = new AttachmentService(state);
    const listed = await restarted.accessAttachments("instance-b", { type: "list" });
    assert.equal(listed.type, "list");
    if (listed.type !== "list") throw new Error("unexpected resolve result");
    assert.deepEqual(new Set(listed.attachments.map((attachment) => attachment.fileId)), new Set([
      first.attachment.fileId, duplicate.attachment.fileId, typedAlias.attachment.fileId, recoveredPartial.attachment.fileId,
    ]));
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("attachment DTOs remain canonical across Queue, events, and conversation without passive projection negotiation", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-attachment-command-"));
  const socketPath = join(root, "dock.sock");
  const state = new AttachmentStorageState(join(root, "state"), join(root, "attachments"));
  const service = new AttachmentService(state);
  let worker: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    worker = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: worker });
  }, undefined, { attachmentHostPort: service });
  const host = new DockHost({ socketPath, registry, attachmentService: service });
  await host.start();
  try {
    const client = new DockClient({ socketPath });
    const bytes = Buffer.from("queue attachment");
    const uploaded = await client.uploadAttachment(source("queue notes.txt", bytes, "text/plain"), "queue-upload");
    const instance = await client.create(root, "attachment-work", "create-attachment-work");
    await client.prompt(instance.id, "start run", "prompt", "start-run");
    await client.prompt(instance.id, "inspect queued file", "steer", "queued-attachment", undefined, [uploaded.attachment.fileId]);

    const queued = await client.read(instance.id, undefined, "conversation_bootstrap");
    assert.equal(queued.pendingMessages.length, 1);
    assert.deepEqual(queued.pendingMessages[0]!.attachments, [uploaded.attachment]);
    assert.doesNotMatch(JSON.stringify(queued), /\/files\//u);

    assert.equal(worker?.consumeNextQueued(), "inspect queued file");
    worker?.settle("done");
    await new Promise((resolve) => setImmediate(resolve));
    const replay = await client.read(instance.id, queued.page.latest, "event_log");
    const submitted = replay.page.events.find((event) => event.type === "message.submitted" && event.data.operationId === "queued-attachment");
    assert.equal(submitted?.type, "message.submitted", JSON.stringify(replay.page.events));
    if (submitted?.type === "message.submitted") assert.deepEqual(submitted.data.attachments, [uploaded.attachment]);
    const history = await client.conversationHistory(instance.id, undefined, 50);
    const queuedRecord = history.entries.map((entry) => entry.entry).find((entry) => entry.source === "user" && entry.content.some((block) => block.type === "text" && block.text === "inspect queued file"));
    assert.deepEqual(queuedRecord?.attachments, [uploaded.attachment]);
    assert.doesNotMatch(JSON.stringify(history), /\/files\//u);

    await registry.get(instance.id).waitForIdle();
    await client.prompt(instance.id, "start dequeue run", "prompt", "dequeue-run");
    await client.prompt(instance.id, "restore queued file", "steer", "dequeue-attachment", undefined, [uploaded.attachment.fileId]);
    const restored = await client.dequeue(instance.id, "dequeue-shared-queue");
    assert.deepEqual(restored.receipt.restored[0]?.attachments, [uploaded.attachment]);
    assert.equal((await client.read(instance.id)).pendingMessages.length, 0);
    worker?.settle("dequeue done");
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent uploads separate logical metadata while deduplicating content", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-attachment-race-"));
  const state = new AttachmentStorageState(join(root, "state"), join(root, "files"));
  const service = new AttachmentService(state);
  try {
    const bytes = Buffer.from("same bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const left = await service.beginUpload({ name: "same name.txt", sizeBytes: bytes.length, sha256: digest });
    const right = await service.beginUpload({ name: "different display.txt", sizeBytes: bytes.length, sha256: digest });
    await Promise.all([left.write(bytes), right.write(bytes)]);
    const results = await Promise.all([left.complete(), right.complete()]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["reused", "stored"]);
    assert.notEqual(results[0]!.attachment.fileId, results[1]!.attachment.fileId);
    assert.deepEqual(new Set(results.map((result) => result.attachment.name)), new Set(["same name.txt", "different display.txt"]));
    const resolvedAliases = await Promise.all(results.map((result) => service.accessAttachments("instance", { type: "resolve", fileId: result.attachment.fileId })));
    assert.ok(resolvedAliases.every((result) => result.type === "resolve"));
    assert.equal((resolvedAliases[0] as { path: string }).path, (resolvedAliases[1] as { path: string }).path);

    const other = Buffer.from("different bytes");
    const otherSink = await service.beginUpload({ name: "same name.txt", sizeBytes: other.length, sha256: createHash("sha256").update(other).digest("hex") });
    await otherSink.write(other);
    const otherResult = await otherSink.complete();
    assert.equal(otherResult.attachment.name, "same name.txt", "display metadata is independent of physical filename collisions");
    const otherResolved = await service.accessAttachments("instance", { type: "resolve", fileId: otherResult.attachment.fileId });
    assert.equal(otherResolved.type, "resolve");
    if (otherResolved.type !== "resolve") throw new Error("unexpected list result");
    assert.notEqual(otherResolved.path, (resolvedAliases[0] as { path: string }).path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attachment directory setting applies locally and becomes immutable after the first commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-attachment-settings-"));
  const firstRoot = join(root, "first permanent root");
  const secondRoot = join(root, "second root");
  const state = new AttachmentStorageState(join(root, "state"), join(root, "default"));
  try {
    const saved = await state.writeDirectory(firstRoot);
    assert.equal(saved.directory, firstRoot);
    const service = new AttachmentService(state);
    const bytes = Buffer.from("permanent");
    const sink = await service.beginUpload({ name: "kept.txt", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await assert.rejects(state.writeDirectory(secondRoot), /cannot be changed while an upload is active/u);
    await sink.write(bytes);
    await sink.complete();
    await assert.rejects(state.writeDirectory(secondRoot), /cannot be changed after files have been stored/u);
    assert.equal((await state.readSettings()).directory, firstRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command admission rejects same-size attachment corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-attachment-corrupt-"));
  const service = new AttachmentService(new AttachmentStorageState(join(root, "state"), join(root, "store")));
  try {
    const bytes = Buffer.from("original");
    const sink = await service.beginUpload({ name: "original.bin", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await sink.write(bytes);
    const stored = await sink.complete();
    const resolved = await service.accessAttachments("instance", { type: "resolve", fileId: stored.attachment.fileId });
    if (resolved.type !== "resolve") assert.fail("expected resolve result");
    await writeFile(resolved.path, Buffer.from("corrupt!"));
    await assert.rejects(service.getMany([stored.attachment.fileId]), /no longer matches its stored digest/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attachment storage rejects symlinked managed directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-attachment-symlink-"));
  const store = join(root, "store");
  const outside = join(root, "outside");
  await mkdir(join(store, ".alu-dock"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(store, ".alu-dock", "manifests"));
  const service = new AttachmentService(new AttachmentStorageState(join(root, "state"), store));
  try {
    await assert.rejects(service.beginUpload({ name: "blocked", sizeBytes: 0, sha256: createHash("sha256").digest("hex") }), /non-canonical managed directory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed attachment verification publishes no file or metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-attachment-failure-"));
  const state = new AttachmentStorageState(join(root, "state"), join(root, "files"));
  const service = new AttachmentService(state);
  try {
    const sink = await service.beginUpload({
      name: "any.data",
      sizeBytes: 3,
      sha256: "0".repeat(64),
    });
    await sink.write(Buffer.from("abc"));
    await assert.rejects(sink.complete(), /SHA-256/u);
    const listed = await service.accessAttachments("instance", { type: "list" });
    assert.equal(listed.type, "list");
    if (listed.type === "list") assert.equal(listed.total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
