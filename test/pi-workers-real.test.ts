import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkerIncidentStore } from "../src/control/worker-incident-store.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { appendDockAttachmentContext } from "../src/pi/dock-attachment-context.js";
import { RuntimeEffectUnknownError } from "../src/core/managed-instance.js";
import { PiWorkerProcess } from "../src/pi/worker-process.js";
import { OrderedWorkerSender, WorkerFrameReceiver, type WorkerIdentity } from "../src/pi/worker-protocol.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("Pi extensions and workspace shells use the same Pi version as their Dock Worker", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-pi-runtime-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const emptyBin = join(root, "empty-bin");
  const probe = join(root, "pi-runtime.json");
  await Promise.all([
    mkdir(cwd),
    mkdir(sessionDir),
    mkdir(emptyBin),
    mkdir(join(agentDir, "extensions"), { recursive: true }),
  ]);
  await writeFile(join(agentDir, "extensions", "pi-runtime-probe.ts"), `
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(stderr.trim() || \`Pi child exited \${code}\`)));
  });
}

export default async function () {
  const version = await run(process.execPath, [process.argv[1], "--version"]);
  const shellVersion = process.platform === "win32"
    ? await run(process.env.ComSpec, ["/d", "/s", "/c", "pi --version"])
    : await run("/bin/sh", ["-c", "pi --version"]);
  await writeFile(${JSON.stringify(probe)}, JSON.stringify({
    version,
    shellVersion,
    piCodingAgent: process.env.PI_CODING_AGENT,
    aiAgent: process.env.AI_AGENT,
  }));
}
`, "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  const workerEnvironment = { ...process.env };
  for (const key of Object.keys(workerEnvironment)) {
    if (key.toLowerCase() === "path") delete workerEnvironment[key];
  }
  workerEnvironment.PATH = emptyBin;
  workerEnvironment.PI_OFFLINE = "1";
  workerEnvironment.PI_PACKAGE_DIR = join(root, "wrong-pi-package");

  const instance = await createPiInstance({
    id: "pi-runtime-probe", hostEpoch: "pi-runtime-host", creationOperationId: "pi-runtime-create",
    cwd, agentDir, sessionDir, projectTrusted: false, tools: [], workerEnvironment,
  });
  try {
    const observed = JSON.parse(await readFile(probe, "utf8")) as Record<string, unknown>;
    assert.deepEqual(observed, {
      version: instance.snapshot().executor.version,
      shellVersion: instance.snapshot().executor.version,
      piCodingAgent: "true",
      aiAgent: "pi",
    });
  } finally {
    await instance.disposeUnpublished();
  }
});

test("real Pi Worker projects persisted session entries into canonical conversation records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-conversation-records-"));
  const cwd = join(root, "cwd");
  const sessionDir = join(root, "sessions");
  const agentDir = join(root, "agent");
  const attachmentContextKey = Buffer.alloc(32, 7);
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentDir)]);
  await writeFile(join(agentDir, ".alu-dock-attachment-context-key"), `${attachmentContextKey.toString("base64")}\n`, { mode: 0o600 });
  context.after(() => rm(root, { recursive: true, force: true }));

  const manager = SessionManager.create(cwd, sessionDir);
  type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "question" }], timestamp: 1 } as SessionMessage);
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
    ],
    api: "openai-responses", provider: "fixture", model: "fixture", usage: ZERO_USAGE,
    stopReason: "toolUse", timestamp: 2,
  } as SessionMessage);
  manager.appendMessage({
    role: "toolResult", toolCallId: "call-1", toolName: "read",
    content: [{ type: "text", text: "file contents" }], isError: false, details: { status: "complete" }, timestamp: 3,
  } as SessionMessage);
  manager.appendMessage({
    role: "bashExecution", command: "printf ok", output: "ok", exitCode: 0,
    cancelled: false, truncated: false, timestamp: 4,
  } as SessionMessage);
  const attachment = {
    fileId: "123e4567-e89b-42d3-a456-426614174000", name: "private notes.txt", sizeBytes: 12,
    mediaType: "text/plain", sha256: "a".repeat(64), storedAt: "2026-08-16T00:00:00.000Z",
  };
  manager.appendMessage({ role: "user", content: [{ type: "text", text: appendDockAttachmentContext("attachment question", [attachment], attachmentContextKey) }], timestamp: 5 } as SessionMessage);
  const imageAttachment = {
    fileId: "223e4567-e89b-42d3-a456-426614174000", name: "camera.png", sizeBytes: 19,
    mediaType: "image/png", sha256: "52143c1adc509dc364626e36d0c2cd944b44c17283cfe1d90780a960a69ad795",
    storedAt: "2026-08-19T00:00:00.000Z",
  };
  manager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: appendDockAttachmentContext("image question", [imageAttachment], attachmentContextKey) },
      { type: "image", data: "Zml4dHVyZS1pbWFnZS1ieXRlcw==", mimeType: "image/png" },
    ],
    timestamp: 6,
  } as SessionMessage);
  manager.appendMessage({
    role: "toolResult", toolCallId: "attachment-resolve", toolName: "dock_attachment_resolve",
    content: [{ type: "text", text: "Attachment is available at '/private/host/attachments/private notes.txt'." }],
    isError: false, details: { type: "resolve", attachment }, timestamp: 6,
  } as SessionMessage);
  manager.appendMessage({
    role: "toolResult", toolCallId: "legacy-show", toolName: "show_image",
    content: [{ type: "text", text: "/private/legacy-show.png" }], isError: false,
    details: { path: "/private/legacy-show.png", base64: "cHJpdmF0ZQ==" }, timestamp: 7,
  } as SessionMessage);
  manager.appendCustomMessageEntry("visible-extension", [{ type: "text", text: "extension says hi" }], true, { decision: "keep" });
  manager.appendCustomMessageEntry("hidden-extension", "private state", false, { secret: true });
  manager.appendCustomEntry("extension-state", { count: 2 });
  manager.appendModelChange("fixture", "model-2");
  manager.appendThinkingLevelChange("high");
  manager.appendSessionInfo("Canonical records");
  manager.appendLabelChange(manager.getLeafId()!, "checkpoint");

  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const instance = await createPiInstance({
    id: "canonical-records", hostEpoch: "canonical-records-host", creationOperationId: "canonical-records-create",
    cwd, agentDir, sessionDir, sessionFile,
    projectTrusted: false, tools: [],
  });
  try {
    const records = (await instance.getHistoryPage(undefined, 200)).entries;
    assert.ok(records.length >= 10);
    assert.ok(records.every((record) => record.recordId === record.entryId));
    assert.deepEqual(records.slice(0, 4).map((record) => [record.kind, record.source, record.visibility]), [
      ["message", "user", "conversation"],
      ["message", "assistant", "conversation"],
      ["message", "tool", "conversation"],
      ["bash_execution", "runtime", "conversation"],
    ]);
    const assistant = records.find((record) => record.source === "assistant");
    assert.ok(assistant?.content.some((block) => block.type === "thinking" && block.text === "plan"));
    assert.ok(assistant?.content.some((block) => block.type === "tool_call" && block.toolCallId === "call-1"));
    const tool = records.find((record) => record.source === "tool");
    const toolResult = tool?.content.find((block) => block.type === "tool_result");
    assert.equal(toolResult?.type === "tool_result" ? toolResult.toolCallId : undefined, "call-1");
    assert.equal(toolResult?.type === "tool_result" ? toolResult.text : undefined, "file contents");
    assert.equal(toolResult?.type === "tool_result" ? toolResult.isError : undefined, false);
    assert.deepEqual(tool?.metadata, { status: "complete" });
    const visible = records.find((record) => record.customType === "visible-extension");
    assert.equal(visible?.kind, "custom_message");
    assert.equal(visible?.visibility, "conversation");
    assert.deepEqual(visible?.metadata, { decision: "keep" });
    assert.equal(records.find((record) => record.customType === "hidden-extension")?.visibility, "hidden");
    assert.equal(records.find((record) => record.customType === "extension-state")?.visibility, "metadata");
    assert.equal(records.find((record) => record.kind === "model_change")?.modelId, "model-2");
    assert.equal(records.find((record) => record.kind === "thinking_level_change")?.thinkingLevel, "high");
    assert.equal(records.find((record) => record.kind === "session_info")?.name, "Canonical records");
    assert.equal(records.find((record) => record.kind === "label")?.label, "checkpoint");
    const attachmentUser = records.find((record) => record.source === "user" && record.attachments !== undefined);
    assert.deepEqual(attachmentUser?.attachments, [attachment]);
    assert.deepEqual(attachmentUser?.content, [{ type: "text", text: "attachment question" }]);
    const imageUser = records.find((record) => record.source === "user" && record.attachments?.[0]?.fileId === imageAttachment.fileId);
    assert.deepEqual(imageUser?.attachments, [imageAttachment]);
    assert.deepEqual(imageUser?.content, [
      { type: "text", text: "image question" },
      {
        type: "image", mimeType: "image/png", contentRef: `image-${imageAttachment.sha256}`,
        fileId: imageAttachment.fileId,
      },
    ]);
    const attachmentTool = records.find((record) => record.toolName === "dock_attachment_resolve");
    assert.doesNotMatch(JSON.stringify(attachmentTool), /private\/host/u);
    const legacyShowImage = records.find((record) => record.toolName === "show_image");
    assert.match(JSON.stringify(legacyShowImage), /older session/u);
    assert.doesNotMatch(JSON.stringify(legacyShowImage), /private\/legacy-show|cHJpdmF0ZQ|"metadata"/u);

    const conversation = await instance.getConversationHistory(undefined, 50);
    for (const item of conversation.entries.filter(({ entry }) => entry.recordId === attachmentUser?.recordId || entry.recordId === attachmentTool?.recordId || entry.recordId === legacyShowImage?.recordId)) {
      const content = await instance.getConversationContent(item.contentRef);
      assert.doesNotMatch(JSON.stringify(content), /private\/host|private\/legacy-show|cHJpdmF0ZQ|alu_dock_attachments_v1/u);
    }
    const oldImage = conversation.entries.find(({ entry }) => entry.entryId === imageUser?.entryId);
    assert.ok(oldImage);
    const imageRef = oldImage.entry.content.find((block) => block.type === "image")?.contentRef;
    assert.ok(imageRef);
    const image = await instance.getConversationImage(imageRef);
    assert.equal(image.sha256, imageAttachment.sha256);
    assert.equal(image.sizeBytes, imageAttachment.sizeBytes);
    assert.equal(Buffer.from(image.data, "base64").toString("utf8"), "fixture-image-bytes");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "later message" }], timestamp: 8 } as SessionMessage);
    await instance.reloadSession("stable-image-refresh");
    const refreshed = await instance.getConversationHistory(undefined, 50);
    const refreshedImage = refreshed.entries.find(({ entry }) => entry.entryId === oldImage.entry.entryId);
    assert.equal(refreshedImage?.contentRef, oldImage.contentRef);
    assert.deepEqual(refreshedImage?.entry.content.find((block) => block.type === "image"), oldImage.entry.content.find((block) => block.type === "image"));
  } finally {
    await instance.disposeUnpublished();
  }
});

test("one crashed Worker leaves a saved diagnostic while other work continues", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-two-workers-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const incidentRoot = join(root, "incidents");
  const incidentStore = new WorkerIncidentStore(incidentRoot);
  const pids: number[] = [];
  const first = await createPiInstance({
    id: "worker-first", hostEpoch: "worker-host", creationOperationId: "create-first", name: "Windows migration",
    cwd: process.cwd(), agentDir: join(root, "agent-first"), sessionDir: join(root, "sessions-first"),
    projectTrusted: false, tools: [], onWorkerSpawn: (pid) => pids.push(pid),
    workerIncidentRecorder: incidentStore.recorder("Windows worker"),
  });
  const second = await createPiInstance({
    id: "worker-second", hostEpoch: "worker-host", creationOperationId: "create-second",
    cwd: process.cwd(), agentDir: join(root, "agent-second"), sessionDir: join(root, "sessions-second"),
    projectTrusted: false, tools: [], onWorkerSpawn: (pid) => pids.push(pid),
    workerIncidentRecorder: incidentStore.recorder("Windows worker"),
  });
  try {
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
    if (process.platform === "linux") {
      assert.equal(await readlink(`/proc/${pids[0]}/cwd`), process.cwd());
      assert.equal(await readlink(`/proc/${pids[1]}/cwd`), process.cwd());
    }
    assert.equal(first.snapshot().lifecycle, "active");
    assert.equal(second.snapshot().lifecycle, "active");
    process.kill(pids[0]!, "SIGKILL");
    for (let attempt = 0; attempt < 100 && first.snapshot().lifecycle !== "runtime_error"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(first.snapshot().lifecycle, "runtime_error");
    assert.equal(first.snapshot().runtimeGeneration, 1);
    assert.equal(first.snapshot().interruption?.reason, "replacement_failed");
    const incidents = await new WorkerIncidentStore(incidentRoot).list();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.instanceId, "worker-first");
    assert.equal(incidents[0]?.workName, "Windows migration");
    assert.equal(incidents[0]?.machineName, "Windows worker");
    assert.match(incidents[0]?.cause ?? "", /Pi worker exited/u);
    assert.equal(second.snapshot().lifecycle, "active");
    assert.equal(second.snapshot().execution, "idle");
    await second.disposeUnpublished();
    assert.equal(processExists(pids[1]!), false, "graceful Host disposal must reap the worker");
    assert.equal((await new WorkerIncidentStore(incidentRoot).list()).length, 1, "normal recovery work must not create or remove crash evidence");
  } finally {
    await Promise.allSettled([first.disposeUnpublished(), second.disposeUnpublished()]);
  }
});

test("cross-project session replacement updates the Worker process cwd before extension rebind", async (context) => {
  if (process.platform !== "linux") { context.skip("/proc cwd proof requires Linux"); return; }
  const root = await mkdtemp(join(tmpdir(), "alu-dock-worker-cwd-"));
  const cwdA = join(root, "project-a");
  const cwdB = join(root, "project-b");
  await mkdir(cwdA, { recursive: true });
  await mkdir(cwdB, { recursive: true });
  await mkdir(join(root, "target-sessions"), { recursive: true });
  const sourceAgentDir = join(root, "source-agent");
  const cwdProbe = join(root, "extension-factory-cwd.txt");
  await mkdir(join(sourceAgentDir, "extensions"), { recursive: true });
  await writeFile(join(sourceAgentDir, "extensions", "cwd-probe.ts"), `
import { appendFileSync } from "node:fs";
export default function () {
  appendFileSync(${JSON.stringify(cwdProbe)}, process.cwd() + "\\n");
}
`, "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  const target = SessionManager.create(cwdB, join(root, "target-sessions"));
  type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];
  target.appendMessage({ role: "user", content: [{ type: "text", text: "cross-project target" }], timestamp: Date.now() } as SessionMessage);
  target.appendMessage({
    role: "assistant", content: [{ type: "text", text: "target answer" }], api: "openai-responses",
    provider: "openai", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as SessionMessage);
  const targetFile = target.getSessionFile();
  assert.ok(targetFile);
  const targetHeader = JSON.parse((await readFile(targetFile!, "utf8")).split("\n", 1)[0]!) as { cwd?: string };
  assert.equal(targetHeader.cwd, cwdB);

  let sourcePid = 0;
  const source = await createPiInstance({
    id: "cwd-source", hostEpoch: "cwd-host", creationOperationId: "cwd-source-create",
    cwd: cwdA, agentDir: sourceAgentDir, sessionDir: join(root, "source-sessions"),
    projectTrusted: true, tools: [], onWorkerSpawn: (pid) => { sourcePid = pid; },
  });
  try {
    assert.equal(await readlink(`/proc/${sourcePid}/cwd`), cwdA);
    assert.deepEqual((await readFile(cwdProbe, "utf8")).trim().split("\n"), [cwdA]);
    assert.equal((await source.switchSession("cwd-switch", targetFile!, { canonicalCwd: cwdB, projectTrusted: true })).cancelled, false);
    assert.equal(await readlink(`/proc/${sourcePid}/cwd`), cwdB);
    assert.equal(source.snapshot().cwd, cwdB);
    assert.deepEqual(
      (await readFile(cwdProbe, "utf8")).trim().split("\n"),
      [cwdA, cwdB],
      "replacement extension factories must observe the target cwd during construction",
    );
  } finally {
    await source.disposeUnpublished();
  }
});

test("accepted abort may outlive its old control deadline without killing a healthy Worker (July 28 incident)", async () => {
  let workerPid = 0;
  const instance = await createPiInstance({
    id: "slow-abort", hostEpoch: "slow-abort-host", creationOperationId: "slow-abort-create",
    cwd: process.cwd(), agentDir: join(tmpdir(), "slow-abort-agent"), projectTrusted: false, tools: [],
    workerEntry: fileURLToPath(new URL("./fixtures/slow-abort-pi-worker.js", import.meta.url)),
    workerTimeouts: { controlMs: 30, termMs: 200 },
    onWorkerSpawn: (pid) => { workerPid = pid; },
  });
  try {
    const startedAt = Date.now();
    await instance.abort("slow-abort-operation");

    assert.ok(Date.now() - startedAt >= 100, "the fixture must exceed the former control deadline");
    assert.equal(instance.snapshot().lifecycle, "active");
    assert.equal(processExists(workerPid), true);
    assert.ok((await instance.getSettings()).length > 0, "the Worker transport must remain reusable after abort");
  } finally {
    await instance.disposeUnpublished();
  }
  assert.equal(processExists(workerPid), false);
});

test("accepted Worker mutation loss is effect_unknown only after process reap and is never replayed", async () => {
  let workerPid = 0;
  const instance = await createPiInstance({
    id: "accepted-loss", hostEpoch: "accepted-loss-host", creationOperationId: "accepted-loss-create",
    cwd: process.cwd(), agentDir: join(tmpdir(), "accepted-loss-agent"), projectTrusted: false, tools: [],
    workerEntry: fileURLToPath(new URL("./fixtures/hanging-pi-worker.js", import.meta.url)),
    workerTimeouts: { mutationMs: 100, termMs: 200 },
    onWorkerSpawn: (pid) => { workerPid = pid; },
  });
  try {
    await assert.rejects(
      instance.setActiveTools(["read"], "accepted-worker-operation"),
      (error: unknown) => error instanceof RuntimeEffectUnknownError && error.operationId === "accepted-worker-operation",
    );
    assert.equal(processExists(workerPid), false, "effect_unknown must not settle before the old Worker owner is reaped");
    assert.equal(instance.snapshot().lifecycle, "runtime_error");
    assert.equal(instance.snapshot().interruption?.reason, "replacement_failed");
    assert.equal(instance.snapshot().runtimeGeneration, 1);
  } finally {
    await instance.disposeUnpublished();
  }
});

test("malformed success after Worker mutation acceptance remains effect_unknown until reap", async () => {
  let workerPid = 0;
  const instance = await createPiInstance({
    id: "malformed-accepted", hostEpoch: "malformed-host", creationOperationId: "malformed-create",
    cwd: process.cwd(), agentDir: join(tmpdir(), "malformed-accepted-agent"), projectTrusted: false, tools: [],
    workerEntry: fileURLToPath(new URL("./fixtures/hanging-pi-worker.js", import.meta.url)),
    workerTimeouts: { mutationMs: 1_000, termMs: 200 },
    onWorkerSpawn: (pid) => { workerPid = pid; },
  });
  try {
    await assert.rejects(
      instance.updateSetting({ key: "autoCompaction", value: true }, "malformed-setting-operation"),
      (error: unknown) => error instanceof RuntimeEffectUnknownError && error.operationId === "malformed-setting-operation",
    );
    assert.equal(processExists(workerPid), false, "accepted malformed success must settle only after Worker reap");
    assert.equal(instance.snapshot().lifecycle, "runtime_error");
  } finally {
    await instance.disposeUnpublished();
  }
});

test("stuck extension disposal is bounded, reaps the process tree, and self-terminates after Host IPC loss", async (context) => {
  if (process.platform !== "linux") { context.skip("process-group proof requires Linux"); return; }
  const root = await mkdtemp(join(tmpdir(), "alu-dock-worker-reap-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const descendantFile = join(root, "descendant.pid");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(agentDir, "extensions", "stuck-dispose.ts"), `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));
  });
  pi.on("session_shutdown", () => new Promise(() => {}));
}
`, "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  let workerPid = 0;
  const instance = await createPiInstance({
    id: "worker-reap", hostEpoch: "worker-reap-host", creationOperationId: "create-reap",
    cwd: process.cwd(), agentDir, sessionDir, projectTrusted: true, tools: [],
    workerTimeouts: { controlMs: 200, gracefulShutdownMs: 200, termMs: 300 },
    onWorkerSpawn: (pid) => { workerPid = pid; },
  });
  context.after(() => instance.disposeUnpublished().catch(() => {}));
  const descendantPid = await waitForPidFile(descendantFile);
  process.kill(workerPid, "SIGKILL");
  for (let attempt = 0; attempt < 200 && instance.snapshot().lifecycle !== "runtime_error"; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.equal(instance.snapshot().lifecycle, "runtime_error");
  assert.equal(processExists(workerPid), false);
  assert.equal(processExists(descendantPid), false, "unexpected Worker exit must still reap extension descendants before runtime_lost");

  await rm(descendantFile, { force: true });
  let disposeWorkerPid = 0;
  const disposeInstance = await createPiInstance({
    id: "worker-dispose", hostEpoch: "worker-reap-host", creationOperationId: "create-dispose",
    cwd: process.cwd(), agentDir, sessionDir: join(root, "dispose-sessions"), projectTrusted: true, tools: [],
    workerTimeouts: { controlMs: 200, gracefulShutdownMs: 200, termMs: 300 },
    onWorkerSpawn: (pid) => { disposeWorkerPid = pid; },
  });
  context.after(() => disposeInstance.disposeUnpublished().catch(() => {}));
  const disposeDescendantPid = await waitForPidFile(descendantFile);
  const startedAt = Date.now();
  await disposeInstance.disposeUnpublished();
  assert.ok(Date.now() - startedAt < 2_500, "stuck disposal must be bounded by supervisor deadlines");
  assert.equal(processExists(disposeWorkerPid), false);
  assert.equal(processExists(disposeDescendantPid), false, "Worker process-group termination must SIGKILL descendants that ignore SIGTERM");

  await rm(descendantFile, { force: true });
  const orphanIdentity: WorkerIdentity = { hostEpoch: "orphan-host", instanceId: "orphan-instance", runtimeGeneration: 1, workerIncarnation: "orphan-incarnation" };
  const orphan = new PiWorkerProcess({
    identity: orphanIdentity,
    init: { cwd: process.cwd(), agentDir, sessionDir: join(root, "orphan-sessions"), projectTrusted: true, tools: [] },
    environment: { ...process.env },
  });
  const orphanReceiver = new WorkerFrameReceiver(() => true);
  const orphanSender = new OrderedWorkerSender(orphanIdentity, (message, callback) => orphan.child.send(message, callback));
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("orphan worker did not start")), 10_000);
    orphan.child.on("message", (raw) => {
      try {
        const envelope = orphanReceiver.accept(raw);
        if (envelope?.kind === "call" && envelope.capability === "dock.identity") {
          void orphanSender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result: { identity: orphanIdentity, capabilities: ["dock.identity"] } }).catch(rejectReady);
        }
        if (envelope?.kind === "ready") { clearTimeout(timer); resolveReady(); }
      } catch (error) { clearTimeout(timer); rejectReady(error); }
    });
    orphan.child.once("error", rejectReady);
  });
  context.after(() => orphan.terminate().catch(() => {}));
  const orphanPid = orphan.child.pid!;
  const orphanDescendantPid = await waitForPidFile(descendantFile);
  orphan.child.disconnect();
  for (let attempt = 0; attempt < 100 && processExists(orphanPid); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.equal(processExists(orphanPid), false, "detached Worker must self-terminate when Host IPC disappears");
  assert.equal(processExists(orphanDescendantPid), false, "Host-loss watchdog must terminate extension descendants");
});

async function waitForPidFile(path: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("extension descendant PID was not published");
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
