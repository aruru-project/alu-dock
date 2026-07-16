import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiInstance } from "../src/pi/create-pi-instance.js";
import type { DockEvent } from "../src/core/managed-instance.js";

test("real Pi extension command brokers UI and completes without a model run", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-real-extension-ui-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await chmod(root, 0o700);
  await writeFile(join(agentDir, "extensions", "ui-fixture.ts"), `
export default function (pi) {
  pi.registerCommand("ui-fixture", {
    description: "Exercise the Alu Dock extension UI broker",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("fixture", "ready\\u001b[2J");
      ctx.ui.notify("fixture body\\u001b[2J", "info");
      const confirmed = await ctx.ui.confirm("Approve fixture", "This stays local.");
      ctx.ui.notify(confirmed ? "fixture approved" : "fixture denied", confirmed ? "info" : "error");
    },
  });
}
`, "utf8");
  context.after(async () => { await rm(root, { recursive: true, force: true }); });

  const instance = await createPiInstance({
    cwd: process.cwd(),
    name: "extension-ui-real",
    projectTrusted: true,
    agentDir,
    sessionDir,
  });
  const events: DockEvent[] = [];
  const claim = await instance.claimInteractionController();
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;
  let responseTask: Promise<unknown> = Promise.resolve();
  const unsubscribe = instance.subscribe((event) => {
    events.push(event);
    if (event.type === "interaction.requested" && event.data.method === "confirm") {
      responseTask = instance.respondInteraction(claim.leaseToken, event.data.interactionId, { method: "confirm", confirmed: true });
    }
  });

  try {
    const receipt = await instance.submit("/ui-fixture", "followUp", "real-extension-command");
    assert.deepEqual({ delivery: receipt.delivery, queued: receipt.queued }, { delivery: "prompt", queued: false });
    assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages, []);
    await responseTask;
    await instance.waitForIdle();
    const snapshot = instance.snapshot();
    assert.equal(snapshot.lifecycle, "active");
    assert.equal(snapshot.execution, "idle");
    assert.equal(snapshot.lastRun, "never");
    assert.deepEqual(snapshot.metrics?.messages, { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 });
    assert.deepEqual(snapshot.extensionStatus, { fixture: "ready[2J" });
    const handled = events.find((event) => event.type === "command.handled" && event.data.operationId === "real-extension-command");
    assert.equal(handled?.type, "command.handled");
    if (handled?.type !== "command.handled") assert.fail("extension command was not projected as handled");
    assert.equal(handled.data.kind, "extension_command");
    assert.equal(events.some((event) => event.type === "message.queued" || event.type === "message.submitted"), false);
    assert.equal(events.some((event) => event.type === "run.started"), false);
    assert.equal(events.some((event) => event.type === "interaction.resolved"), true);
    const notifications = events
      .filter((event): event is Extract<DockEvent, { type: "extension.notification" }> => event.type === "extension.notification")
      .map((event) => event.data.message);
    assert.deepEqual(notifications, ["fixture body[2J", "fixture approved"]);
  } finally {
    unsubscribe();
    await instance.stop();
  }
});
