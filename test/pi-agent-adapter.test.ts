import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { PUBLISHED_FILE_DETAIL_KEY } from "../src/pi/show-image-extension.js";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { parseConversationFrame, parseConversationHistoryBody, parseConversationContentBody } from "../src/control/protocol.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { InstanceEventJournal } from "../src/core/instance-event-journal.js";
import { AgentConversationCursorError } from "../src/core/agent-worker.js";
import { PiAgentAdapter, type PiAgentAdapterOptions, PiConversationProjector, projectAgentSessionEvents } from "../src/pi/pi-agent-adapter.js";
import { appendDockAttachmentContext } from "../src/pi/dock-attachment-context.js";
import { TransientFileRegistry } from "../src/pi/transient-file-registry.js";

const ATTACHMENT_CONTEXT_KEY = Buffer.alloc(32, 7);

test("a live tool-result image uses a stable opaque conversation content reference without event bytes", () => {
  const registry = new TransientFileRegistry();
  const imageData = "a".repeat(70_000);
  const projected = projectAgentSessionEvents({
    type: "tool_execution_end", toolCallId: "image-call", toolName: "read",
    result: { content: [{ type: "image", mimeType: "image/png", data: imageData }] }, isError: false,
  } as never, registry);
  const frames = projected.flatMap((event) => new PiConversationProjector(ATTACHMENT_CONTEXT_KEY).project(event));
  const serialized = JSON.stringify(frames);
  assert.equal(serialized.includes(imageData), false);
  const data = (frames[0] as unknown as { frame: { data: { content: Array<{ contentRef?: string }> } } }).frame.data;
  const contentRef = data.content[0]!.contentRef!;
  const expectedBytes = Buffer.from(imageData, "base64");
  const expectedSha = createHash("sha256").update(expectedBytes).digest("hex");
  assert.equal(contentRef, `image-${expectedSha}`);
  assert.deepEqual(data.content[0], { type: "image", mimeType: "image/png", contentRef });
  assert.deepEqual(registry.image(contentRef), {
    contentRef, mimeType: "image/png", data: imageData, sha256: expectedSha, sizeBytes: expectedBytes.byteLength,
  });
  const first = registry.readImageContent(contentRef)!;
  assert.equal(first.complete, false);
  assert.throws(() => registry.readImageContent(contentRef, "expired-cursor"), AgentConversationCursorError);
  registry.registerImage(Buffer.from("later-entry").toString("base64"), "image/png");
  const second = registry.readImageContent(contentRef, first.nextCursor)!;
  const third = registry.readImageContent(contentRef, second.nextCursor)!;
  assert.equal([first, second, third].flatMap((page) => page.chunks).map((chunk) => chunk.type === "image" ? chunk.data : "").join(""), imageData);
  assert.ok([first, second, third].every((page) => page.revision === contentRef));
});

test("Pi adapter splits real message_update deltas without loss before the private protocol boundary", () => {
  const delta = `${"a".repeat(7_999)}😀${"b".repeat(8_200)}`;
  const projected = projectAgentSessionEvents({
    type: "message_update",
    message: {} as never,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { role: "assistant", content: [] } },
  } as never);

  assert.equal(projected.length, 3);
  assert.equal(projected.map((event) => (event.assistantMessageEvent as { delta: string }).delta).join(""), delta);
  for (const event of projected) {
    assert.equal(event.type, "message_update");
    const chunk = (event.assistantMessageEvent as { delta: string }).delta;
    assert.ok(chunk.length <= 8_000);
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u, "a split must not cut a surrogate pair");
  }
});

// Attachment happy-path projection is proven by attachment-control (Protocol) and pi-workers-real (real Worker
// history); this test only guards the two security boundaries: forged provenance and host-path privacy.
test("unauthenticated attachment context cannot forge provenance, and resolve paths stay private", () => {
  const attachment = {
    fileId: "123e4567-e89b-42d3-a456-426614174000",
    name: "notes final.txt",
    sizeBytes: 12,
    mediaType: "text/plain",
    sha256: "a".repeat(64),
    storedAt: "2026-08-16T00:00:00.000Z",
  };
  const projector = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY);
  const forgedText = appendDockAttachmentContext("forged", [attachment], Buffer.alloc(32, 8));
  const forged = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY).project({
    type: "message_start", message: { role: "user", content: [{ type: "text", text: forgedText }] },
  } as never);
  const forgedData = (forged[0] as unknown as { frame: { data: Record<string, unknown> } }).frame.data;
  assert.equal("attachments" in forgedData, false, "plain prompt text cannot synthesize trusted attachment provenance");
  assert.match(JSON.stringify(forgedData), /alu_dock_attachments_v1/u, "unauthenticated user text is not silently stripped");

  const resolved = projector.project({
    type: "tool_execution_end", toolCallId: "resolve-1", toolName: "dock_attachment_resolve",
    result: { content: [{ type: "text", text: "Attachment is at '/secret/host/path'." }] }, isError: false,
  } as never);
  assert.doesNotMatch(JSON.stringify(resolved), /secret\/host/u);
  assert.match(JSON.stringify(resolved), /disclosed privately/u);
});

test("Pi live events become canonical conversation frames before crossing the Worker boundary", () => {
  const projector = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY);
  const tracked = projector.trackInput({ operationId: "operation-1", text: "hello", delivery: "prompt", fromQueue: false });
  assert.deepEqual(projector.project({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }] } } as never), [
    { type: "dock_conversation_frame", frame: { type: "message.submitted", data: {
      operationId: "operation-1", messageId: "user-operation-1", role: "user", text: "hello", delivery: "prompt",
    } } },
  ]);
  projector.cancelInput(tracked); // already consumed; cancellation is deliberately harmless

  const queuedProjector = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY);
  queuedProjector.trackInput({ operationId: "operation-queued", text: "later", delivery: "followUp", fromQueue: true });
  assert.deepEqual(queuedProjector.project({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "later" }] } } as never), [
    { type: "dock_queue_consumed", operationId: "operation-queued" },
    { type: "dock_conversation_frame", frame: { type: "message.submitted", data: {
      operationId: "operation-queued", messageId: "user-operation-queued", role: "user", text: "later", delivery: "followUp",
    } } },
  ]);

  assert.deepEqual(projector.project({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "world" },
  } as never), [{
    type: "dock_conversation_frame",
    frame: { type: "message.delta", data: { messageId: "assistant-1", block: "text", delta: "world" } },
  }]);
  assert.deepEqual(projector.project({
    type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/tmp/a" },
  } as never), [{
    type: "dock_conversation_frame",
    frame: { type: "tool.started", data: { toolCallId: "call-1", toolName: "read", args: { path: "/tmp/a" } } },
  }]);
  assert.deepEqual(projector.project({
    type: "tool_execution_end", toolCallId: "call-1", toolName: "read",
    result: { content: [{ type: "text", text: "file" }] }, isError: false,
  } as never), [{
    type: "dock_conversation_frame",
    frame: { type: "tool.completed", data: { toolCallId: "call-1", toolName: "read", text: "file", isError: false, content: [{ type: "text", text: "file" }] } },
  }]);
  assert.deepEqual(projector.project({
    type: "message_end",
    message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "file" }] },
  } as never), [], "one tool result has one canonical live lifecycle");

  assert.deepEqual(projector.project({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "world" }], stopReason: "stop" },
  } as never), [{
    type: "dock_conversation_frame",
    frame: { type: "message.completed", data: {
      messageId: "assistant-1", role: "assistant", content: [{ type: "text", text: "world" }], stopReason: "stop",
    } },
  }]);
  assert.deepEqual(projector.project({ type: "agent_settled", operationId: "operation-1" } as never), [
    { type: "agent_settled", operationId: "operation-1", stopReason: "stop" },
  ]);
});

// #301/#302: use public Pi persistence and the production adapter read surface;
// only runtime startup is inert (no provider, extensions, Git watchers or Host).
async function reader(manager: SessionManager, registry = new TransientFileRegistry()) {
  return PiAgentAdapter.create({
    runtime: {
      session: { sessionManager: manager, subscribe: () => () => {}, bindExtensions: async () => {} },
      services: { cwd: process.cwd() },
      setBeforeSessionInvalidate() {}, setRebindSession() {}, dispose: async () => {},
    } as unknown as PiAgentAdapterOptions["runtime"],
    attachmentContextKey: ATTACHMENT_CONTEXT_KEY, publishedFiles: registry,
    gitBranchObserverFactory: async () => ({ branch: undefined, dispose() {} }),
  });
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("#301 SDK user events retain trusted image identity through live and history projection", async () => {
  const registry = new TransientFileRegistry();
  const manager = SessionManager.inMemory(process.cwd());
  const adapter = await reader(manager, registry);
  const attachment = {
    fileId: "223e4567-e89b-42d3-a456-426614174000", name: "photo.png", mediaType: "image/png",
    sizeBytes: 68, sha256: createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"), storedAt: "2026-09-18T00:00:00.000Z",
  };
  const changed = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.from("changed")]).toString("base64");
  for (const plainText of ["look", "x".repeat(9_000)]) {
    const text = appendDockAttachmentContext(plainText, [attachment], ATTACHMENT_CONTEXT_KEY);
    const message = { role: "user" as const, content: [
      { type: "text" as const, text },
      { type: "image" as const, mimeType: "image/png", data: PNG },
      { type: "image" as const, mimeType: "image/png", data: changed },
      { type: "image" as const, mimeType: "image/jpeg", data: PNG },
    ], timestamp: Date.now() };
    const projector = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY);
    projector.trackInput({ operationId: "send", text: plainText, runtimeText: text, delivery: "prompt", fromQueue: false, attachments: [attachment] });
    const rawFrames: unknown[] = [];
    // Pi emits the user message before entering the model stream. Disable that
    // boundary entirely: no provider request or credentials are involved.
    const agent = new Agent({ streamFn: () => { throw new Error("No provider in projection test"); } });
    agent.subscribe((event) => {
      if ((event.type !== "message_start" && event.type !== "message_end") || event.message.role !== "user") return;
      for (const projected of projectAgentSessionEvents(event as never, registry).flatMap((value) => projector.project(value))) {
        if (projected.type === "dock_conversation_frame") rawFrames.push(projected.frame);
      }
    });
    await agent.prompt(message);
    const frames = rawFrames.map((frame) => parseConversationFrame(frame));
    const completed = frames.find((frame) => frame.type === "message.completed")!;
    if (completed.type !== "message.completed") throw new Error("missing completion");
    manager.appendMessage(message);
    const history = adapter.getHistory().at(-1)!;
    const images = completed.data.content.filter((block) => block.type === "image");
    assert.equal(images[0]?.fileId, attachment.fileId);
    assert.equal(images[1]?.fileId, undefined, "transformed bytes are not the upload");
    assert.equal(images[2]?.fileId, undefined, "same bytes with a different MIME are not a trusted match");
    assert.deepEqual(completed.data.content, history.content);
    for (const image of images) assert.equal("sha256" in image || "data" in image || "path" in image, false);
    assert.equal(adapter.getConversationImage(images[0]!.contentRef!).data, PNG);
    assert.doesNotMatch(JSON.stringify(completed), /alu_dock_attachments_v1/u);
  }
});

test("#301 read image descriptors survive preview trimming and completeness describes the emitted content", async (context) => {
  const manager = SessionManager.inMemory(process.cwd());
  const registry = new TransientFileRegistry();
  const adapter = await reader(manager, registry);
  // A valid 2 MiB PNG, using an ancillary tEXt chunk rather than fake image data.
  const base = Buffer.from(PNG, "base64");
  const payload = Buffer.alloc(2 * 1024 * 1024 - base.length - 12, 120);
  payload.write("Diagnostic\0", 0, "latin1");
  const chunk = Buffer.concat([Buffer.from("tEXt"), payload]);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(payload.length); checksum.writeUInt32BE(crc32(chunk));
  const png = Buffer.concat([base.subarray(0, 33), length, chunk, checksum, base.subarray(33)]);
  const largeImage = png.toString("base64");
  const root = await mkdtemp(join(tmpdir(), "alu-projection-image-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "published.png");
  await writeFile(path, base);
  const published = await registry.publish(path);
  const add = (message: Parameters<SessionManager["appendMessage"]>[0]) => manager.appendMessage(message);
  const short = add({ role: "toolResult", toolCallId: "read-short", toolName: "read", isError: false, timestamp: 1,
    content: [{ type: "text", text: "first" }, { type: "image", mimeType: "image/png", data: largeImage }, { type: "text", text: "second" }] });
  const textOnly = add({ role: "toolResult", toolCallId: "read-text", toolName: "read", isError: false, timestamp: 1,
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] });
  const imageOnly = add({ role: "toolResult", toolCallId: "read-only", toolName: "read", isError: false, timestamp: 1,
    content: [{ type: "image", mimeType: "image/png", data: PNG }] });
  const long = add({ role: "toolResult", toolCallId: "read-long", toolName: "read", isError: false, timestamp: 2,
    content: [{ type: "text", text: "x".repeat(40_001) }, { type: "image", mimeType: "image/png", data: PNG }] });
  const many = add({ role: "user", timestamp: 3, content: [
    ...Array.from({ length: 100 }, () => ({ type: "text" as const, text: "t".repeat(8_000) })), { type: "image", mimeType: "image/png", data: PNG },
  ] });
  const summary = manager.appendCompaction("summary", short, 42);
  const metadata = manager.appendSessionInfo("named");
  const publishedId = add({ role: "toolResult", toolCallId: "show", toolName: "show_image", isError: false, timestamp: 4,
    content: [{ type: "text", text: "Published image." }], details: { [PUBLISHED_FILE_DETAIL_KEY]: published } });
  const assistant = (argumentsValue: Record<string, unknown>) => add({ role: "assistant", content: [
    { type: "toolCall", id: "args", name: "read", arguments: argumentsValue },
  ], api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 5,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const shortArgs = assistant({ path: "image.png" });
  const longArgs = assistant({ text: "a".repeat(40_001) });
  const longSummary = manager.branchWithSummary(manager.getLeafId()!, "s".repeat(8_001));
  const page = parseConversationHistoryBody(await adapter.getConversationHistory());
  const item = (id: string) => page.entries.find(({ entry }) => entry.entryId === id)!;
  const descriptor = item(short);
  assert.deepEqual(descriptor.entry.content.map((block) => block.type), ["tool_result", "image", "tool_result"]);
  assert.equal(descriptor.contentComplete, false, "an image descriptor is not inline bytes for legacy readers");
  assert.equal(descriptor.totalBlocks, 3, "text on opposite sides of an image must stay on those sides");
  assert.equal(item(textOnly).contentComplete, true);
  assert.equal(item(textOnly).totalBlocks, 1);
  // Existing Web complete_content behavior: true returns entry.content as-is;
  // only false enters conversation.content. Its image renderer needs data,
  // not just a contentRef. Keep that legacy decision path working unchanged.
  const body = descriptor.contentComplete ? undefined
    : parseConversationContentBody(await adapter.getConversationContent(descriptor.contentRef));
  assert.ok(body, "the legacy reader must fetch the missing native image bytes");
  assert.equal(body.revision, page.revision);
  assert.deepEqual(body.chunks.map((chunk) => chunk.type), ["tool_result", "image"]);
  assert.equal(body.chunks[0]?.type === "tool_result" && body.chunks[0].text, "first");
  const image = descriptor.entry.content.find((block) => block.type === "image")!;
  const imageBody = adapter.getConversationImage(image.contentRef!);
  assert.deepEqual(Buffer.from(imageBody.data, "base64"), png);
  assert.equal(imageBody.sha256, createHash("sha256").update(png).digest("hex"));
  assert.equal(imageBody.sizeBytes, 2_097_152);
  let legacy = body;
  const pages = [body];
  while (!legacy.complete) {
    legacy = parseConversationContentBody(await adapter.getConversationContent(descriptor.contentRef, legacy.nextCursor));
    pages.push(legacy);
  }
  assert.equal(pages.length, 88, "the legacy content API remains lossless with its frozen chunk size");
  assert.ok(pages.every((value) => value.revision === page.revision));
  assert.equal(pages.flatMap((value) => value.chunks).map((value) => value.type === "image" ? value.data : "").join(""), largeImage);
  const ordered = pages.flatMap((value) => value.chunks).filter((value) => value.type !== "image" || value.offset === 0);
  assert.deepEqual(ordered.map((value) => value.type === "tool_result" ? value.text : value.type), ["first", "image", "second"]);
  assert.deepEqual(ordered.map((value) => value.blockIndex), [0, 1, 2]);
  context.diagnostic("2 MiB PNG: descriptor history=1, image body=1 (2097152 verified bytes); legacy record content=88 requests, exact base64 and revision match");
  assert.equal(item(imageOnly).contentComplete, false);
  assert.equal(item(imageOnly).totalBlocks, 2);
  assert.equal(item(publishedId).contentComplete, true);
  assert.equal(item(publishedId).totalBlocks, 1);
  assert.deepEqual(item(publishedId).entry.content.find((block) => block.type === "tool_result")?.publishedFile, published);
  assert.equal(item(shortArgs).contentComplete, true);
  assert.equal(item(longArgs).contentComplete, false);
  const argsFirst = parseConversationContentBody(await adapter.getConversationContent(item(longArgs).contentRef));
  const argsLast = parseConversationContentBody(await adapter.getConversationContent(item(longArgs).contentRef, argsFirst.nextCursor));
  assert.equal(argsLast.complete, true);
  const argumentsJson = [...argsFirst.chunks, ...argsLast.chunks].map((value) => value.type === "tool_call" ? value.argumentsJson : "").join("");
  assert.deepEqual(JSON.parse(argumentsJson), { text: "a".repeat(40_001) });
  assert.equal(item(longSummary).contentComplete, false);
  const summaryBody = await adapter.getConversationContent(item(longSummary).contentRef);
  assert.equal(summaryBody.complete, true);
  assert.equal(summaryBody.chunks[0]?.type === "text" && summaryBody.chunks[0].text, "s".repeat(8_001));
  assert.equal(item(long).contentComplete, false);
  assert.equal(item(many).contentComplete, false);
  for (const id of [long, many]) assert.ok(item(id).entry.content.some((block) => block.type === "image" && block.contentRef));
  assert.equal(item(summary).contentComplete, true);
  assert.equal(item(metadata).contentComplete, true);
  assert.equal(item(metadata).totalBlocks, 0);
  // Byte slimming is a second preview transform, and must not keep a stale true flag.
  for (let i = 0; i < 140; i++) add({ role: "user", content: "z".repeat(4_000), timestamp: i + 10 });
  const slim = parseConversationHistoryBody(await adapter.getConversationHistory(undefined, 200));
  assert.equal(slim.entries.find(({ entry }) => entry.entryId === short)!.entry.content.some((block) => block.type === "image"), true);
  assert.equal(slim.entries.find(({ entry }) => entry.entryId === imageOnly)!.contentComplete, false, "image bytes still require continuation after page slimming");
  assert.deepEqual(slim.entries.find(({ entry }) => entry.entryId === publishedId)!.entry.content.find((block) => block.type === "tool_result")?.publishedFile, published);
  for (const value of slim.entries.filter(({ entry }) => entry.source === "user")) assert.equal(value.contentComplete, false);
});

test("#302 reading old content and earlier pages survives append but not branch or Session replacement", async () => {
  const manager = SessionManager.inMemory(process.cwd());
  const adapter = await reader(manager);
  const firstId = manager.appendMessage({ role: "user", content: "a".repeat(64_001), timestamp: 1 });
  const callId = manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "pending", name: "read", arguments: {} }],
    api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  manager.appendMessage({ role: "user", content: "tail", timestamp: 2 });
  const recent = await adapter.getConversationHistory(undefined, 1);
  const earlier = await adapter.getConversationHistory(recent.nextCursor, 1);
  const oldest = await adapter.getConversationHistory(earlier.nextCursor, 1);
  const descriptor = oldest.entries[0]!;
  assert.equal(descriptor.entry.entryId, firstId);
  manager.appendMessage({ role: "user", content: "append before first content request", timestamp: 3 });
  const chunks = [await adapter.getConversationContent(descriptor.contentRef)];
  for (let i = 0; i < 2; i++) {
    if (i === 0) manager.appendMessage({ role: "toolResult", toolCallId: "pending", toolName: "read", isError: false,
      content: [{ type: "text", text: "result arrived after the scan began" }], timestamp: 4 });
    else manager.appendMessage({ role: "user", content: `append ${i}`, timestamp: i + 4 });
    chunks.push(await adapter.getConversationContent(descriptor.contentRef, chunks.at(-1)!.nextCursor));
    const reread = await adapter.getConversationHistory(recent.nextCursor, 1);
    assert.equal(reread.revision, earlier.revision);
    assert.equal(reread.entries[0]!.entry.entryId, callId);
    assert.equal((await adapter.getConversationHistory(reread.nextCursor, 1)).entries[0]!.entry.entryId, firstId);
  }
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.revision === earlier.revision));
  assert.equal(chunks.at(-1)!.complete, true);
  assert.equal(chunks.flatMap((page) => page.chunks).map((chunk) => chunk.type === "text" ? chunk.text : "").join(""), "a".repeat(64_001));
  manager.branch(firstId);
  manager.appendMessage({ role: "user", content: "different branch", timestamp: 10 });
  await assert.rejects(adapter.getConversationContent(descriptor.contentRef, chunks[0]!.nextCursor), AgentConversationCursorError);
  await assert.rejects(adapter.getConversationHistory(recent.nextCursor), AgentConversationCursorError);
  const branch = await adapter.getConversationHistory();
  assert.notEqual(branch.revision, earlier.revision);
  assert.equal(branch.entries[0]!.contentRef, descriptor.contentRef, "immutable record refs stay opaque and stable");
  manager.newSession();
  await assert.rejects(adapter.getConversationContent(descriptor.contentRef), AgentConversationCursorError);
  assert.notEqual((await adapter.getConversationHistory()).revision, branch.revision);
});

// Review P1: a returned descriptor must remain independently readable after
// unrelated live images evict the bounded registry, even within a >1024-image page.
test("historical image descriptors directly recover original bytes after other image activity", async () => {
  const manager = SessionManager.inMemory(process.cwd());
  const registry = new TransientFileRegistry();
  const adapter = await reader(manager, registry);
  const png = (index: number) => {
    const base = Buffer.from(PNG, "base64");
    const payload = Buffer.from(`probe\0${index}`);
    const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length); chunk.write("tEXt", 4); payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([base.subarray(0, -12), chunk, base.subarray(-12)]).toString("base64");
  };
  const firstId = manager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: PNG }], timestamp: 1 });
  const initial = await adapter.getConversationHistory();
  const original = initial.entries[0]!.entry.content.find((block) => block.type === "image")!;
  assert.equal(adapter.getConversationImage(original.contentRef!).data, PNG);
  const activity = (start: number) => {
    for (let i = start; i < start + 1024; i++) projectAgentSessionEvents({ type: "tool_execution_update", toolCallId: "live", toolName: "read",
      partialResult: { content: [{ type: "image", mimeType: "image/png", data: png(i) }] },
    } as never, registry);
  };
  activity(0);
  const refreshed = await adapter.getConversationHistory();
  assert.deepEqual(refreshed.entries[0]!.entry.content[0], original);
  assert.equal(adapter.getConversationImage(original.contentRef!).data, PNG, "no body prefetch is necessary");
  activity(1024);
  const oldImageApi = await adapter.getConversationContent(original.contentRef!);
  assert.equal(oldImageApi.chunks[0]?.type === "image" && oldImageApi.chunks[0].data, PNG);

  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "many-images", name: "read", arguments: {} }],
    api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const expected = new Map<string, string[]>();
  for (let group = 0; group < 6; group++) {
    const data = Array.from({ length: 190 }, (_, i) => png(2048 + group * 190 + i));
    const id = manager.appendMessage({ role: "toolResult", toolCallId: "many-images", toolName: "read", isError: false, timestamp: group + 3,
      content: data.map((value) => ({ type: "image", mimeType: "image/png", data: value })),
    });
    expected.set(id, data);
  }
  const page = parseConversationHistoryBody(await adapter.getConversationHistory(undefined, 1));
  assert.equal(page.entries.length, 7, "one accepted semantic page can contain more images than the registry");
  let read = 0;
  let groupRef = "";
  for (const item of page.entries) {
    const images = item.entry.content.filter((block) => block.type === "image");
    for (const [index, image] of images.entries()) {
      const body = adapter.getConversationImage(image.contentRef!);
      assert.equal(body.data, expected.get(item.entry.entryId)![index]);
      assert.equal(body.sha256, createHash("sha256").update(Buffer.from(body.data, "base64")).digest("hex"));
      read++; groupRef = image.contentRef!;
    }
  }
  assert.equal(read, 1140);
  manager.branch(firstId);
  activity(4096);
  assert.throws(() => adapter.getConversationImage(groupRef), AgentConversationCursorError, "an evicted image cannot be restored from an abandoned branch");
  assert.equal(adapter.getConversationImage(original.contentRef!).data, PNG);
});

// Review's real 100-long-text + late toolCall reproducer: the canonical record
// used by Host and the Worker's descriptor page must both keep the tool group.
test("long assistant previews keep tool identities and their results in one history page", async () => {
  const manager = SessionManager.inMemory(process.cwd());
  const adapter = await reader(manager);
  manager.appendMessage({ role: "assistant", content: [
    ...Array.from({ length: 100 }, () => ({ type: "text" as const, text: "x".repeat(8000) })),
    { type: "toolCall", id: "late-tool", name: "read", arguments: { path: "x".repeat(8000) } },
  ], api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  manager.appendMessage({ role: "toolResult", toolCallId: "late-tool", toolName: "read", isError: false, timestamp: 2, content: [{ type: "text", text: "tool answer" }] });
  const canonical = adapter.getHistory();
  const call = canonical[0]!.content.find((block) => block.type === "tool_call");
  assert.ok(call);
  assert.equal(call.toolCallId, "late-tool");
  assert.deepEqual(call.args, {});
  assert.ok(call.omittedFields?.length);
  const host = new InstanceEventJournal({ hostEpoch: "test", instanceId: "test", initialRuntimeGeneration: 1, initialHistory: canonical });
  const worker = parseConversationHistoryBody(await adapter.getConversationHistory(undefined, 1));
  assert.deepEqual(host.historyPage(undefined, 1).entries.map((entry) => entry.source), ["assistant", "tool"]);
  assert.deepEqual(worker.entries.map(({ entry }) => entry.source), ["assistant", "tool"]);
  assert.ok(worker.entries[0]!.entry.content.some((block) => block.type === "tool_call" && block.toolCallId === "late-tool"));
  assert.equal(worker.hasEarlier, false);
  assert.equal(worker.entries[0]!.contentComplete, false);
});
