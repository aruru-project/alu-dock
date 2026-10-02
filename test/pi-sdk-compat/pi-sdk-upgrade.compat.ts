import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AttachmentService } from "../../src/control/attachment-service.js";
import { AttachmentStorageState } from "../../src/control/attachment-storage-state.js";
import { DockClient } from "../../src/control/dock-client.js";
import { DockHost } from "../../src/control/dock-host.js";
import { DockRegistry } from "../../src/control/dock-registry.js";
import type { InstanceAttachmentHostPort } from "../../src/core/instance-attachments.js";
import type { DockEvent } from "../../src/core/managed-instance.js";
import { createPiInstance, resolvePiReopenTarget } from "../../src/pi/create-pi-instance.js";

const PROVIDER = "sdk-compat-loopback";
const MODEL = "sdk-compat-model";
const TOOL_PROMPT = "SDK_COMPAT_TOOL: read fixture.txt and report its contents";
const HOLD_PROMPT = "SDK_COMPAT_HOLD: keep this turn running";
const ERROR_PROMPT = "SDK_COMPAT_ERROR: surface the provider failure";
const RECOVERY_PROMPT = "SDK_COMPAT_RECOVERY: prove the worker recovered";
const TEMPLATE_COMMAND = "/queued-template";
const TEMPLATE_PROMPT = "SDK_COMPAT_TEMPLATE_EXPANDED: consume this queued template";
const HANDLED_PROMPT = "SDK_COMPAT_HANDLED: an input hook takes this over";
const SETTLE_FIRST_PROMPT = "SDK_COMPAT_SETTLE_FIRST: finish while an extension holds settlement";
const SETTLE_SECOND_PROMPT = "SDK_COMPAT_SETTLE_SECOND: sent before settlement finished";
const SETTLE_TAKEBACK_PROMPT = "SDK_COMPAT_SETTLE_TAKEBACK: taken back before settlement finished";
const HANDOFF_PROMPT = "SDK_COMPAT_HANDOFF: held during compaction, handed over after settlement";
const HANDOFF_TAKEBACK_PROMPT = "SDK_COMPAT_HANDOFF_TAKEBACK: held during compaction, taken back before settlement";
const OVERFLOW_PROMPT = "SDK_COMPAT_OVERFLOW: exceed the context window";
const AFTER_COMPACTION_PROMPT = "SDK_COMPAT_AFTER_COMPACTION: steer the retried turn";
const SUMMARY_TEXT = "SDK_COMPAT_SUMMARY: the earlier conversation";
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const COMPACT_PROMPT = "SDK_COMPAT_COMPACT: report a context-filling answer";
const CONTINUE_TEXT = "SDK_COMPAT_CONTINUE: an extension continues after automatic compaction";
const SUMMARIZATION_MARKER = "You are a context summarization assistant";
const FIXTURE_TEXT = "sdk-compat-read-sentinel";

/** Pi SDK admission gate. Intentionally not named *.test.ts; ordinary npm test must not collect it. */
test("Pi SDK remains compatible through the production Dock and Worker boundary", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-pi-sdk-compat-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const homeDir = join(root, "home");
  const socketPath = join(root, "dock.sock");
  const priorSessionFile = join(sessionDir, "pi-0.81.1-session.jsonl");
  const holdSettle = join(root, "hold-settle");
  const settleEntered = join(root, "settle-entered");
  const holdInput = join(root, "hold-input");
  const inputEntered = join(root, "input-entered");
  const continueAfterCompaction = join(root, "continue-after-compaction");
  const fixture = new LoopbackChatFixture();
  const workerPids: number[] = [];
  const events: DockEvent[] = [];
  let host: DockHost | undefined;
  let client: DockClient | undefined;
  let follower: Awaited<ReturnType<DockClient["streamEvents"]>> | undefined;

  try {
    await Promise.all([mkdir(cwd), mkdir(join(agentDir, "prompts"), { recursive: true }), mkdir(join(agentDir, "extensions"), { recursive: true }), mkdir(sessionDir), mkdir(homeDir), chmod(root, 0o700)]);
    await Promise.all([
      writeFile(join(cwd, "fixture.txt"), `${FIXTURE_TEXT}\n`, "utf8"),
      writeFile(priorSessionFile, priorPiSession(cwd), { encoding: "utf8", mode: 0o600 }),
    ]);
    await fixture.start();
    await Promise.all([
      writeFile(join(agentDir, "models.json"), JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: `${fixture.origin}/v1`,
            api: "openai-completions",
            apiKey: "sdk-compat-dummy-literal-key",
            models: [{
              id: MODEL,
              name: "SDK compatibility loopback model",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 32_000,
              maxTokens: 2_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }],
          },
        },
      }), "utf8"),
      writeFile(join(agentDir, "settings.json"), JSON.stringify({
        defaultProvider: PROVIDER,
        defaultModel: MODEL,
        retry: { enabled: false },
        // Any earlier message may be summarized once a reply reports a nearly full context.
        compaction: { enabled: true, keepRecentTokens: 1 },
      }), "utf8"),
      writeFile(join(agentDir, "extensions", "sdk-compat-hooks.ts"), `
import { existsSync, rmSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("input", async (event) => {
    if (!event.text.startsWith(${JSON.stringify(HANDLED_PROMPT)})) return { action: "continue" };
    if (existsSync(${JSON.stringify(holdInput)})) writeFileSync(${JSON.stringify(inputEntered)}, "");
    for (let attempt = 0; attempt < 500 && existsSync(${JSON.stringify(holdInput)}); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    return { action: "handled" };
  });
  pi.on("agent_settled", async () => {
    if (!existsSync(${JSON.stringify(holdSettle)})) return;
    writeFileSync(${JSON.stringify(settleEntered)}, "");
    for (let attempt = 0; attempt < 500 && existsSync(${JSON.stringify(holdSettle)}); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  });
  pi.on("agent_before_settle", async () => {
    if (!existsSync(${JSON.stringify(continueAfterCompaction)})) return undefined;
    rmSync(${JSON.stringify(continueAfterCompaction)});
    return {
      entries: [{ type: "custom_message", customType: "sdk-compat-continue", content: ${JSON.stringify(CONTINUE_TEXT)}, display: false }],
      continue: true,
    };
  });
}
`, "utf8"),
      writeFile(join(agentDir, "prompts", "queued-template.md"), [
        "---",
        "description: SDK compatibility queued template",
        "---",
        TEMPLATE_PROMPT,
        "",
      ].join("\n"), "utf8"),
    ]);

    const workerEnvironment = sanitizedWorkerEnvironment(homeDir);
    const attachmentService = new AttachmentService(new AttachmentStorageState(join(root, "state"), join(root, "attachments")));
    // Resolving an attachment can be held, so a reply can finish while it is read.
    const attachmentResolution = new Pause();
    const attachments: InstanceAttachmentHostPort = {
      async accessAttachments(sourceInstanceId, request) {
        if (request.type === "resolve") await attachmentResolution.pass();
        return attachmentService.accessAttachments(sourceInstanceId, request);
      },
    };
    const registry = new DockRegistry(
      // This is the Registry's production Pi factory. The scenario enters only through DockClient.
      (input) => createPiInstance({
        ...input,
        agentDir,
        sessionDir,
        workerEnvironment,
        onWorkerSpawn: (pid) => workerPids.push(pid),
      }),
      () => "pi-sdk-compat-instance",
      { reopenTargetResolver: { resolve: resolvePiReopenTarget }, attachmentHostPort: attachments },
    );
    host = new DockHost({ socketPath, registry, attachmentService });
    client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 8_000 });
    await host.start();
    const created = await client.create(
      cwd,
      "Pi SDK compatibility",
      "sdk-create",
      undefined,
      undefined,
      { excludeTools: ["bash"] },
    );
    assert.equal(workerPids.length, 1);
    assert.notEqual(workerPids[0], process.pid, "Pi must run in an independent OS process");
    assert.deepEqual(created.executor.model, { provider: PROVIDER, id: MODEL });
    const models = await client.models(created.id);
    assert.ok(models.models.some((model) => model.provider === PROVIDER && model.id === MODEL));
    assert.deepEqual(models.instance.executor.model, { provider: PROVIDER, id: MODEL });
    const tools = await client.tools(created.id);
    assert.equal(tools.tools.some((tool) => tool.name === "bash"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "read"), true);

    const switched = await client.switchSession(created.id, priorSessionFile, "sdk-open-prior-session");
    assert.equal(switched.instance.runtimeGeneration, 2);
    assert.deepEqual(switched.instance.executor.model, { provider: PROVIDER, id: MODEL });
    assert.deepEqual(workerPids, [workerPids[0]!], "opening an existing session must stay inside the current Worker");
    const priorHistory = (await client.history(created.id)).entries;
    assert.ok(priorHistory.some((entry) => entry.source === "user" && textOf(entry.content).includes("prior Pi 0.81.1 session")));

    follower = await client.streamEvents(created.id, { onEvent: (event) => events.push(event) });

    // An input hook may take over a message. The receipt stays as before, and the
    // handled message must not claim the next run: the tool run below waits for its own ID.
    const handledEvent = events.length;
    const handled = await client.prompt(created.id, HANDLED_PROMPT, "prompt", "sdk-handled");
    assert.equal(handled.receipt.queued, false);
    await waitForEvent(events, handledEvent, (event) => event.type === "command.handled" && event.data.operationId === "sdk-handled");

    const firstEvent = events.length;
    const accepted = await client.prompt(created.id, TOOL_PROMPT, "prompt", "sdk-tool-run");
    assert.equal(accepted.receipt.delivery, "prompt");
    assert.equal(accepted.receipt.queued, false);
    const firstSettled = await waitForEvent(events, firstEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-tool-run");
    assert.equal(firstSettled.type, "run.settled");
    assert.equal(firstSettled.data.result, "succeeded");
    const firstRunEvents = events.slice(firstEvent);
    assert.ok(firstRunEvents.some((event) => event.type === "message.delta" && event.data.delta.length > 0), "provider text must stream as deltas");
    assert.ok(firstRunEvents.some((event) => event.type === "tool.started" && event.data.toolName === "read"));
    assert.ok(firstRunEvents.some((event) => event.type === "tool.completed" && event.data.toolName === "read" && !event.data.isError && event.data.text.includes(FIXTURE_TEXT)));
    assert.ok(fixture.requests.some((body) => hasToolResult(body, FIXTURE_TEXT)), "Pi must continue the provider turn with the real read result");
    assert.ok(fixture.requests.some((body) => JSON.stringify(body).includes("Pi Worker managed by Alu Dock")), "the managed Worker identity must reach Pi's system prompt");
    // Pi 0.99 records system prompt and tool changes as system messages; clients never show them as conversation.
    assert.equal(firstRunEvents.some((event) => event.type === "message.completed" && event.data.role === "system"), false);

    const initialHistory = (await client.history(created.id)).entries;
    assert.equal(initialHistory.some((entry) => entry.visibility === "conversation" && entry.source === "system"), false);
    assert.ok(initialHistory.some((entry) => entry.source === "user" && textOf(entry.content).includes(TOOL_PROMPT)));
    assert.ok(initialHistory.some((entry) => entry.source === "tool" && entry.toolName === "read" && textOf(entry.content).includes(FIXTURE_TEXT)));
    assert.ok(initialHistory.some((entry) => entry.source === "assistant" && textOf(entry.content).includes("read completed successfully")));

    // Regression: the 2026-08-22 /sol-checkup incident left its Dock queue item in flight
    // because Pi queued the expanded template body while Dock tracked the slash command.
    const templateEvent = events.length;
    await client.prompt(created.id, HOLD_PROMPT, "prompt", "sdk-template-hold");
    await waitForEvent(events, templateEvent, (event) => event.type === "message.delta" && event.data.delta.includes("holding"));
    const queuedTemplate = await client.prompt(created.id, TEMPLATE_COMMAND, "steer", "sdk-template-queued");
    assert.equal(queuedTemplate.receipt.queued, true);
    fixture.releaseHold();
    const templateSubmitted = await waitForEvent(events, templateEvent, (event) => (
      event.type === "message.submitted" && event.data.operationId === "sdk-template-queued"
    ));
    assert.equal(templateSubmitted.type, "message.submitted");
    assert.equal(templateSubmitted.data.text, TEMPLATE_COMMAND);
    await waitForEvent(events, templateEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-template-hold");
    assert.equal((await client.status(created.id)).pending.total, 0);
    assert.ok(fixture.requests.some((body) => lastUserText(body).includes(TEMPLATE_PROMPT)));

    const holdEvent = events.length;
    await client.prompt(created.id, HOLD_PROMPT, "prompt", "sdk-hold-run");
    await waitForEvent(events, holdEvent, (event) => event.type === "message.delta" && event.data.delta.includes("holding"));
    const steered = await client.prompt(created.id, "queued steer must not run", "steer", "sdk-steer");
    const followed = await client.prompt(created.id, "queued follow-up must not run", "followUp", "sdk-follow-up");
    assert.equal(steered.receipt.queued, true);
    assert.equal(steered.receipt.delivery, "steer");
    assert.equal(followed.receipt.queued, true);
    assert.equal(followed.receipt.delivery, "followUp");
    // Pi 0.99 lets input hooks take over queued input too; it must not wait in the Queue.
    await client.prompt(created.id, `${HANDLED_PROMPT} while running`, "steer", "sdk-handled-running");
    await waitForEvent(events, holdEvent, (event) => event.type === "command.handled" && event.data.operationId === "sdk-handled-running");
    assert.equal(events.slice(holdEvent).some((event) => event.type === "message.queued" && event.data.operationId === "sdk-handled-running"), false);
    assert.equal((await client.status(created.id)).pending.total, 2);
    const restored = await client.abortRestoreQueue(created.id, "sdk-abort-restore");
    assert.deepEqual(restored.receipt.restored.map((item) => item.operationId).sort(), ["sdk-follow-up", "sdk-steer"]);
    assert.equal(restored.instance.pending.total, 0);
    const aborted = await waitForEvent(events, holdEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-hold-run");
    assert.equal(aborted.type, "run.settled");
    assert.equal(aborted.data.result, "aborted");
    assert.equal(fixture.requests.some((body) => JSON.stringify(body).includes("queued steer must not run") || JSON.stringify(body).includes("queued follow-up must not run")), false);

    const errorEvent = events.length;
    await client.prompt(created.id, ERROR_PROMPT, "prompt", "sdk-error-run");
    const failed = await waitForEvent(events, errorEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-error-run");
    assert.equal(failed.type, "run.settled");
    assert.equal(failed.data.result, "failed");
    assert.match(failed.data.error ?? "", /deterministic provider failure/);
    assert.equal((await client.status(created.id)).lifecycle, "active", "a provider failure must not lose the Worker");

    const recoveryEvent = events.length;
    await client.prompt(created.id, RECOVERY_PROMPT, "prompt", "sdk-recovery-run");
    const recovered = await waitForEvent(events, recoveryEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-recovery-run");
    assert.equal(recovered.type, "run.settled");
    assert.equal(recovered.data.result, "succeeded");

    // Pi 0.99 defers input that arrives while an extension still handles agent_settled.
    // Dock keeps it in its Queue meanwhile: Escape hands it back at once, and nothing starts afterwards.
    await writeFile(holdSettle, "");
    const takeBackEvent = events.length;
    await client.prompt(created.id, SETTLE_FIRST_PROMPT, "prompt", "sdk-settle-first");
    await waitForFile(settleEntered);
    const held = await client.prompt(created.id, SETTLE_TAKEBACK_PROMPT, "auto", "sdk-settle-takeback");
    assert.equal(held.receipt.queued, true);
    const handedBack = await client.abortRestoreQueue(created.id, "sdk-settle-escape");
    assert.deepEqual(handedBack.receipt.restored.map((item) => item.operationId), ["sdk-settle-takeback"]);
    await Promise.all([rm(holdSettle), rm(settleEntered)]);
    await waitForEvent(events, takeBackEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-settle-first");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fixture.requests.some((body) => JSON.stringify(body).includes(SETTLE_TAKEBACK_PROMPT)), false, "returned input never starts");
    assert.equal((await client.status(created.id)).pending.total, 0);

    // A reply can finish while an attached image is still being read. The message is
    // accepted rather than reported as failed, and runs exactly once after the extension finishes.
    const imagePath = join(root, "photo.png");
    await writeFile(imagePath, ONE_PIXEL_PNG);
    const uploaded = await client.uploadFile(imagePath, "image/png", "sdk-upload-image", created.id);
    await writeFile(holdSettle, "");
    const settleEvent = events.length;
    await client.prompt(created.id, HOLD_PROMPT, "prompt", "sdk-settle-hold");
    await waitForEvent(events, settleEvent, (event) => event.type === "message.delta" && event.data.delta.includes("holding"));
    attachmentResolution.close();
    const withImage = client.prompt(created.id, SETTLE_SECOND_PROMPT, "auto", "sdk-settle-second", undefined, [uploaded.attachment.fileId])
      .then((value) => value, (error: unknown) => error);
    await attachmentResolution.waitUntilHeld();
    fixture.releaseHold();
    await waitForFile(settleEntered);
    attachmentResolution.open();
    const settleAccepted = await withImage;
    assert.ok(!(settleAccepted instanceof Error), `input sent before settlement must be accepted: ${String(settleAccepted)}`);
    assert.equal((settleAccepted as Awaited<ReturnType<DockClient["prompt"]>>).receipt.queued, true);
    await Promise.all([rm(holdSettle), rm(settleEntered)]);
    const settledSecond = await waitForEvent(events, settleEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-settle-second");
    assert.equal(settledSecond.type, "run.settled");
    assert.equal(settledSecond.data.result, "succeeded");
    assert.equal(fixture.requests.filter((body) => lastUserText(body).includes(SETTLE_SECOND_PROMPT)).length, 1);
    assert.equal((await client.status(created.id)).pending.total, 0);

    // An input hook may still be working on a message when the reply ends. If it takes the
    // message over while an extension finishes the run, the sender gets a receipt, not an
    // error inviting a resend, and no Queue item is left behind.
    await Promise.all([writeFile(holdSettle, ""), writeFile(holdInput, "")]);
    const lateHandledEvent = events.length;
    await client.prompt(created.id, HOLD_PROMPT, "prompt", "sdk-late-handled-run");
    await waitForEvent(events, lateHandledEvent, (event) => event.type === "message.delta" && event.data.delta.includes("holding"));
    const lateHandled = client.prompt(created.id, `${HANDLED_PROMPT} as the reply ends`, "steer", "sdk-late-handled")
      .then((value) => value, (error: unknown) => error);
    await waitForFile(inputEntered);
    fixture.releaseHold();
    await waitForFile(settleEntered);
    await rm(holdInput);
    const lateReceipt = await lateHandled;
    assert.ok(!(lateReceipt instanceof Error), `input an extension took over must not be reported as failed: ${String(lateReceipt)}`);
    await waitForEvent(events, lateHandledEvent, (event) => event.type === "command.handled" && event.data.operationId === "sdk-late-handled");
    assert.equal(events.slice(lateHandledEvent).some((event) => event.type === "message.queued" && event.data.operationId === "sdk-late-handled"), false);
    await Promise.all([rm(holdSettle), rm(settleEntered), rm(inputEntered)]);
    await waitForEvent(events, lateHandledEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-late-handled-run");
    assert.equal((await client.status(created.id)).pending.total, 0);

    // After overflow compaction Pi retries the turn, and Dock hands it the messages it held meanwhile.
    // One an extension takes over leaves the Queue and does not claim a later run.
    const overflowEvent = events.length;
    await client.prompt(created.id, OVERFLOW_PROMPT, "prompt", "sdk-overflow-run");
    await fixture.waitForHeldSummarization();
    await waitForEvent(events, overflowEvent, (event) => event.type === "compaction.started");
    const handledHeld = await client.prompt(created.id, `${HANDLED_PROMPT} after compaction`, "auto", "sdk-handled-after-compaction");
    assert.equal(handledHeld.receipt.queued, true);
    await client.prompt(created.id, AFTER_COMPACTION_PROMPT, "auto", "sdk-steer-after-compaction");
    fixture.releaseSummarization();
    const handledAt = await waitForEvent(events, overflowEvent, (event) => event.type === "command.handled" && event.data.operationId === "sdk-handled-after-compaction");
    await waitForEvent(events, events.indexOf(handledAt), (event) => event.type === "queue.changed" && event.data.steering === 1);
    await fixture.waitForHeldReply();
    fixture.releaseHold();
    await waitForEvent(events, overflowEvent, (event) => event.type === "message.submitted" && event.data.operationId === "sdk-steer-after-compaction");
    const overflowSettled = await waitForEvent(events, overflowEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-overflow-run");
    assert.equal(overflowSettled.type, "run.settled");
    assert.equal(overflowSettled.data.result, "succeeded");
    assert.equal((await client.status(created.id)).pending.total, 0);
    const afterHandledEvent = events.length;
    await client.prompt(created.id, RECOVERY_PROMPT, "prompt", "sdk-after-handled");
    await waitForEvent(events, afterHandledEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-after-handled");
    assert.equal(fixture.requests.some((body) => JSON.stringify(body).includes(HANDLED_PROMPT)), false, "handled input never reaches the model");

    // Aborting while Pi compacts to recover from an overflow ends the run as aborted, not failed.
    fixture.rejectNextOverflow();
    const overflowAbortEvent = events.length;
    await client.prompt(created.id, OVERFLOW_PROMPT, "prompt", "sdk-overflow-abort-run");
    await fixture.waitForHeldSummarization();
    await waitForEvent(events, overflowAbortEvent, (event) => event.type === "compaction.started");
    await client.abort(created.id, "sdk-overflow-abort");
    const overflowAborted = await waitForEvent(events, overflowAbortEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-overflow-abort-run");
    assert.equal(overflowAborted.type, "run.settled");
    assert.equal(overflowAborted.data.result, "aborted");
    assert.equal((await client.status(created.id)).lastRun, "aborted");
    // Pi compacts that overflow before the next prompt, which then runs normally.
    fixture.answerSummarization();
    const afterOverflowAbortEvent = events.length;
    await client.prompt(created.id, RECOVERY_PROMPT, "prompt", "sdk-after-overflow-abort");
    const afterOverflowAbort = await waitForEvent(events, afterOverflowAbortEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-after-overflow-abort");
    assert.equal(afterOverflowAbort.type, "run.settled");
    assert.equal(afterOverflowAbort.data.result, "succeeded");
    fixture.holdSummarization();

    // Dock hands over input it held during automatic compaction once that ends. If an
    // extension is still finishing the run then, the input stays in Dock's Queue until
    // agent_settled: it runs exactly once afterwards, and Escape returns it at once.
    await writeFile(holdSettle, "");
    const handoffEvent = events.length;
    await client.prompt(created.id, COMPACT_PROMPT, "prompt", "sdk-handoff-run");
    await fixture.waitForHeldSummarization();
    await waitForEvent(events, handoffEvent, (event) => event.type === "compaction.started");
    const handoff = await client.prompt(created.id, HANDOFF_PROMPT, "auto", "sdk-handoff");
    assert.equal(handoff.receipt.queued, true);
    fixture.answerSummarization();
    await waitForFile(settleEntered);
    await Promise.all([rm(holdSettle), rm(settleEntered)]);
    const handedOver = await waitForEvent(events, handoffEvent, (event) => event.type === "message.submitted" && event.data.operationId === "sdk-handoff");
    await waitForEvent(events, events.indexOf(handedOver), (event) => event.type === "run.settled");
    fixture.holdSummarization();
    assert.equal(fixture.requests.filter((body) => lastUserText(body).includes(HANDOFF_PROMPT)).length, 1);
    assert.equal((await client.status(created.id)).pending.total, 0);

    await writeFile(holdSettle, "");
    const handoffEscapeEvent = events.length;
    await client.prompt(created.id, COMPACT_PROMPT, "prompt", "sdk-handoff-escape-run");
    await fixture.waitForHeldSummarization();
    await waitForEvent(events, handoffEscapeEvent, (event) => event.type === "compaction.started");
    await client.prompt(created.id, HANDOFF_TAKEBACK_PROMPT, "auto", "sdk-handoff-takeback");
    fixture.answerSummarization();
    await waitForFile(settleEntered);
    const escaped = await Promise.race([
      client.abortRestoreQueue(created.id, "sdk-handoff-escape"),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
    ]);
    assert.notEqual(escaped, "blocked", "Escape must not wait for the extension to finish the run");
    if (escaped !== "blocked") assert.deepEqual(escaped.receipt.restored.map((item) => item.operationId), ["sdk-handoff-takeback"]);
    fixture.holdSummarization();
    await Promise.all([rm(holdSettle), rm(settleEntered)]);
    await waitForEvent(events, handoffEscapeEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-handoff-escape-run");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fixture.requests.some((body) => JSON.stringify(body).includes(HANDOFF_TAKEBACK_PROMPT)), false, "returned input never starts");
    assert.equal((await client.status(created.id)).pending.total, 0);

    // Pi 0.99 compacts inside the run, and an extension may ask to continue it afterwards.
    // Abort during automatic compaction must end the run, so the model is not called again.
    await writeFile(continueAfterCompaction, "");
    const compactEvent = events.length;
    await client.prompt(created.id, COMPACT_PROMPT, "prompt", "sdk-compact-run");
    await fixture.waitForHeldSummarization();
    await waitForEvent(events, compactEvent, (event) => event.type === "compaction.started");
    await client.abort(created.id, "sdk-compact-abort");
    const compactSettled = await waitForEvent(events, compactEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-compact-run");
    assert.equal(compactSettled.type, "run.settled");
    assert.equal(compactSettled.data.result, "aborted");
    assert.ok(events.slice(compactEvent).some((event) => event.type === "compaction.completed" && event.data.aborted === true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fixture.requests.some((body) => JSON.stringify(body).includes(CONTINUE_TEXT)), false, "no model request may follow an abort during automatic compaction");
    const afterCompactionAbort = await client.status(created.id);
    assert.equal(afterCompactionAbort.execution === "running", false);
    assert.equal(afterCompactionAbort.lastRun, "aborted");
    await rm(continueAfterCompaction, { force: true });

    await client.nameSession(created.id, "SDK compatibility persisted", "sdk-name");
    const beforeReloadHistory = (await client.history(created.id)).entries;
    const initialWorkerPid = workerPids[0]!;
    const reload = await client.reloadSession(created.id, "sdk-reload");
    assert.equal(reload.instance.name, "SDK compatibility persisted");
    assert.deepEqual(reload.instance.executor.model, { provider: PROVIDER, id: MODEL });
    assert.equal(reload.instance.runtimeGeneration, 3);
    assert.deepEqual(workerPids, [initialWorkerPid], "session reload must stay inside the current Worker process");
    assert.equal(processExists(initialWorkerPid), true);
    const afterReloadHistory = (await client.history(created.id)).entries;
    assert.ok(afterReloadHistory.length >= beforeReloadHistory.length);
    assert.ok(afterReloadHistory.some((entry) => entry.source === "assistant" && textOf(entry.content).includes("worker recovered")));

    const killedPid = initialWorkerPid;
    process.kill(killedPid, "SIGKILL");
    const runtimeError = await waitForStatus(client, created.id, (snapshot) => snapshot.lifecycle === "runtime_error");
    assert.equal(runtimeError.reopenable, true);
    assert.equal(processExists(killedPid), false);

    const reopened = await client.reopen(created.id, "sdk-reopen");
    assert.equal(reopened.previousLifecycle, "runtime_error");
    assert.equal(reopened.instance.lifecycle, "active");
    assert.deepEqual(reopened.instance.executor.model, { provider: PROVIDER, id: MODEL });
    assert.equal(workerPids.length, 2);
    assert.notEqual(workerPids[1], killedPid);
    const reopenedHistory = (await client.history(created.id)).entries;
    assert.ok(reopenedHistory.some((entry) => entry.source === "user" && textOf(entry.content).includes("prior Pi 0.81.1 session")));
    assert.ok(reopenedHistory.some((entry) => entry.source === "user" && textOf(entry.content).includes(TOOL_PROMPT)));
    assert.ok(reopenedHistory.some((entry) => entry.source === "tool" && textOf(entry.content).includes(FIXTURE_TEXT)));
    assert.ok(reopenedHistory.some((entry) => entry.source === "assistant" && textOf(entry.content).includes("worker recovered")));

    const livePid = workerPids.at(-1)!;
    const stopped = await client.stop(created.id, "sdk-stop");
    assert.equal(stopped.instance.lifecycle, "stopped");
    assert.equal(processExists(livePid), false, "Host stop must reap the reopened Worker");
    assert.ok(fixture.requestCount >= 5);
  } finally {
    follower?.close();
    await follower?.done.catch(() => {});
    client?.closeActiveConnections();
    if (host) await host.stop().catch(() => {});
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

/** Frozen Pi 0.81.1 v3 records: the candidate SDK must parse them rather than generate its own fixture. */
function priorPiSession(cwd: string): string {
  const timestamp = "2026-07-23T00:00:00.000Z";
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return [
    JSON.stringify({ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000811", timestamp, cwd }),
    JSON.stringify({ type: "model_change", id: "08110001", parentId: null, timestamp, provider: PROVIDER, modelId: MODEL }),
    JSON.stringify({ type: "thinking_level_change", id: "08110002", parentId: "08110001", timestamp, thinkingLevel: "off" }),
    JSON.stringify({ type: "session_info", id: "08110003", parentId: "08110002", timestamp, name: "Pi 0.81.1 compatibility fixture" }),
    JSON.stringify({ type: "message", id: "08110004", parentId: "08110003", timestamp, message: { role: "user", content: "prior Pi 0.81.1 session", timestamp: 1 } }),
    JSON.stringify({
      type: "message",
      id: "08110005",
      parentId: "08110004",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "prior session answer" }],
        api: "openai-completions",
        provider: PROVIDER,
        model: MODEL,
        usage,
        stopReason: "stop",
        timestamp: 2,
      },
    }),
    "",
  ].join("\n");
}

class LoopbackChatFixture {
  readonly requests: unknown[] = [];
  requestCount = 0;
  origin = "";
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((request, response) => { void this.respond(request, response); });
  private pendingHoldResponse: ServerResponse | undefined;
  /** One compaction may ask for several summaries (history and a split turn's prefix). */
  private readonly heldSummaries: ServerResponse[] = [];
  private answerSummaries = false;
  private overflowRejected = false;
  private holdNextReply = false;

  async start(): Promise<void> {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  releaseHold(): void {
    const response = this.pendingHoldResponse;
    assert.ok(response, "the fixture must have an active held response");
    this.pendingHoldResponse = undefined;
    finish(response, "stop");
  }

  /** Answer this compaction's summaries; the turn Pi then retries is held instead. */
  releaseSummarization(): void {
    assert.ok(this.heldSummaries.length > 0, "the fixture must have a held compaction summary");
    this.answerSummaries = true;
    this.holdNextReply = true;
    for (const response of this.heldSummaries.splice(0)) answerSummary(response);
  }

  /** Answer summaries, held or still to come, until holdSummarization(); no reply is held. */
  answerSummarization(): void {
    this.answerSummaries = true;
    this.holdNextReply = false;
    for (const response of this.heldSummaries.splice(0)) answerSummary(response);
  }

  holdSummarization(): void {
    this.answerSummaries = false;
  }

  rejectNextOverflow(): void {
    this.overflowRejected = false;
  }

  async waitForHeldReply(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (this.pendingHoldResponse) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Pi never retried the turn after compaction");
  }

  async waitForHeldSummarization(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (this.heldSummaries.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Pi never requested an automatic compaction summary");
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.socket.remoteAddress, "127.0.0.1");
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer sdk-compat-dummy-literal-key");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    this.requests.push(body);
    this.requestCount += 1;
    const latestUserText = lastUserText(body);

    // A summarization request quotes the whole conversation, so recognise it before any prompt text.
    if (JSON.stringify(body).includes(SUMMARIZATION_MARKER)) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (this.answerSummaries) answerSummary(response);
      else {
        this.heldSummaries.push(response);
        // An aborted compaction closes its request; a later one must not find it.
        response.once("close", () => {
          const index = this.heldSummaries.indexOf(response);
          if (index >= 0) this.heldSummaries.splice(index, 1);
        });
      }
      return;
    }
    if (this.holdNextReply) {
      this.holdNextReply = false;
      this.answerSummaries = false;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      sendDelta(response, { role: "assistant", content: "retried turn " });
      this.pendingHoldResponse = response;
      return;
    }
    if (latestUserText.includes(OVERFLOW_PROMPT) && !this.overflowRejected) {
      this.overflowRejected = true;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "This endpoint's maximum context length is 32000 tokens. However, you requested about 40000 tokens.", type: "invalid_request_error" } }));
      return;
    }
    if (latestUserText.includes(ERROR_PROMPT)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "deterministic provider failure", type: "invalid_request_error" } }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    if (latestUserText.includes(HOLD_PROMPT)) {
      sendDelta(response, { role: "assistant", content: "holding turn open" });
      this.pendingHoldResponse = response;
      response.once("close", () => {
        if (this.pendingHoldResponse === response) this.pendingHoldResponse = undefined;
      });
      return;
    }
    if (latestUserText.includes(TOOL_PROMPT) && !hasToolResult(body, FIXTURE_TEXT)) {
      sendDelta(response, { role: "assistant", content: "reading fixture; " });
      sendDelta(response, { tool_calls: [{ index: 0, id: "sdk_read_call", type: "function", function: { name: "read", arguments: "{\"path\":\"fixture.txt\"}" } }] });
      finish(response, "tool_calls");
      return;
    }
    if (latestUserText.includes(TOOL_PROMPT) && hasToolResult(body, FIXTURE_TEXT)) {
      sendDelta(response, { role: "assistant", content: "read completed " });
      sendDelta(response, { content: "successfully" });
      finish(response, "stop");
      return;
    }
    if (latestUserText.includes(RECOVERY_PROMPT)) {
      sendDelta(response, { role: "assistant", content: "worker " });
      sendDelta(response, { content: "recovered" });
      finish(response, "stop");
      return;
    }
    if (latestUserText.includes(COMPACT_PROMPT)) {
      sendDelta(response, { role: "assistant", content: "context is nearly full" });
      finish(response, "stop", { prompt_tokens: 19_990, completion_tokens: 10, total_tokens: 20_000 });
      return;
    }
    sendDelta(response, { role: "assistant", content: "fixture response" });
    finish(response, "stop");
  }
}

function answerSummary(response: ServerResponse): void {
  sendDelta(response, { role: "assistant", content: SUMMARY_TEXT });
  finish(response, "stop");
}

/** Holds one waiting step until the test lets it continue. */
class Pause {
  private gate: Promise<void> | undefined;
  private release = (): void => {};
  private held = false;

  close(): void {
    this.held = false;
    this.gate = new Promise((resolve) => { this.release = resolve; });
  }

  open(): void {
    this.gate = undefined;
    this.release();
  }

  async pass(): Promise<void> {
    if (!this.gate) return;
    this.held = true;
    await this.gate;
  }

  async waitUntilHeld(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (this.held) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("the held step never started");
  }
}

function sendDelta(response: ServerResponse, delta: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-sdk-compat",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
}

function finish(
  response: ServerResponse,
  finishReason: "stop" | "tool_calls",
  usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-sdk-compat",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage,
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function requestMessages(body: unknown): unknown[] {
  if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return [];
  return body.messages;
}

function lastUserText(body: unknown): string {
  const user = requestMessages(body).findLast((message) => message !== null && typeof message === "object"
    && "role" in message && message.role === "user") as { content?: unknown } | undefined;
  if (typeof user?.content === "string") return user.content;
  if (!Array.isArray(user?.content)) return "";
  return user.content.flatMap((block) => block !== null && typeof block === "object"
    && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("");
}

function hasToolResult(body: unknown, expected: string): boolean {
  return requestMessages(body).some((message) => message !== null && typeof message === "object"
    && "role" in message && message.role === "tool"
    && "content" in message && typeof message.content === "string" && message.content.includes(expected));
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => block.text ?? "").join("");
}

async function waitForEvent(
  events: readonly DockEvent[],
  from: number,
  predicate: (event: DockEvent) => boolean,
): Promise<DockEvent> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = events.slice(from).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for event; recent events: ${events.slice(from).map((event) => event.type).join(", ")}`);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${path}`);
}

async function waitForStatus(
  client: DockClient,
  instanceId: string,
  predicate: (snapshot: Awaited<ReturnType<DockClient["status"]>>) => boolean,
): Promise<Awaited<ReturnType<DockClient["status"]>>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = await client.status(instanceId);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for instance state");
}

function sanitizedWorkerEnvironment(homeDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    PI_OFFLINE: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
