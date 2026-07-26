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
      ctx.ui.setTitle("fixture controller title");
      ctx.ui.setEditorText("fixture draft\\r\\nsecond line");
      ctx.ui.setToolsExpanded(true);
      ctx.ui.setWidget("fixture", ["worker widget"]);
      ctx.ui.notify("fixture body\\u001b[2J", "info");
      const confirmed = await ctx.ui.confirm("Approve fixture", "This stays local.");
      ctx.ui.notify(confirmed ? "fixture approved" : "fixture denied", confirmed ? "info" : "error");
    },
  });
  pi.registerCommand("invalid-ui", {
    handler: async (_args, ctx) => {
      await ctx.ui.select("Too many", Array.from({ length: 201 }, (_, index) => String(index)));
    },
  });
  pi.registerCommand("ui-headroom", {
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("headroom", "x".repeat(3000));
    },
  });
  pi.registerCommand("ui-component", {
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("component", () => ({ render: (width) => ["component:" + width] }));
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
  let leaseToken = claim.leaseToken;
  let responseTask: Promise<unknown> = Promise.resolve();
  const unsubscribe = instance.subscribe((event) => {
    events.push(event);
    if (event.type === "interaction.requested" && event.data.method === "confirm") {
      responseTask = instance.respondInteraction(leaseToken, event.data.interactionId, { method: "confirm", confirmed: true });
    }
  });

  try {
    const receipt = await instance.submit("/ui-fixture", "followUp", "real-extension-command");
    assert.deepEqual({ kind: receipt.kind, delivery: receipt.delivery, queued: receipt.queued }, { kind: "extension_command", delivery: "prompt", queued: false });
    assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages, []);
    await responseTask;
    await instance.waitForIdle();
    const snapshot = instance.snapshot();
    assert.equal(snapshot.lifecycle, "active");
    assert.equal(snapshot.execution, "idle");
    assert.equal(snapshot.lastRun, "never");
    assert.deepEqual(snapshot.metrics?.messages, { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 });
    assert.deepEqual(snapshot.extensionStatus, { fixture: "ready[2J" });
    assert.equal(snapshot.toolsExpanded, true);
    const handled = events.find((event) => event.type === "command.handled" && event.data.operationId === "real-extension-command");
    assert.equal(handled?.type, "command.handled");
    if (handled?.type !== "command.handled") assert.fail("extension command was not projected as handled");
    assert.equal(handled.data.kind, "extension_command");
    assert.equal(events.some((event) => event.type === "message.queued" || event.type === "message.submitted"), false);
    assert.equal(events.some((event) => event.type === "run.started"), false);
    assert.equal(events.some((event) => event.type === "interaction.resolved"), true);
    assert.equal(events.some((event) => event.type === "extension.title_set"
      && event.data.controllerId === claim.controllerId
      && event.data.title === "fixture controller title"), true);
    assert.equal(events.some((event) => event.type === "extension.editor_text_set"
      && event.data.controllerId === claim.controllerId
      && event.data.text === "fixture draft\nsecond line"), true);
    const notifications = events
      .filter((event): event is Extract<DockEvent, { type: "extension.notification" }> => event.type === "extension.notification")
      .map((event) => event.data.message);
    assert.deepEqual(notifications, ["fixture body[2J", "fixture approved"]);
    const widget = events.find((event) => event.type === "extension.widget_changed" && event.data.key === "fixture");
    assert.equal(widget?.type, "extension.widget_changed");
    if (widget?.type === "extension.widget_changed") assert.deepEqual(widget.data.lines, ["worker widget"]);

    assert.equal((await instance.newSession("ui-generation-reset")).cancelled, false);
    assert.equal(instance.snapshot().toolsExpanded, false);
    assert.deepEqual(instance.snapshot().extensionStatus, {});
    await instance.submit("/invalid-ui", "followUp", "invalid-ui-command");
    await instance.waitForIdle();
    assert.equal(instance.snapshot().lifecycle, "active");
    assert.equal(events.some((event) => event.type === "extension.error" && /select options/.test(event.data.error)), true);

    await instance.submit("/ui-headroom", "followUp", "ui-headroom-command");
    await instance.waitForIdle();
    assert.equal(instance.snapshot().lifecycle, "active");
    assert.equal(instance.snapshot().extensionStatus?.headroom?.length, 2_048);

    assert.equal((await instance.reloadSession("ui-reload")).cancelled, false);
    assert.equal(instance.snapshot().toolsExpanded, false);
    const reloadClaim = await instance.claimInteractionController();
    assert.equal(reloadClaim.status, "acquired");
    if (reloadClaim.status !== "acquired") assert.fail("controller was not reacquired after reload");
    leaseToken = reloadClaim.leaseToken;
    assert.notEqual(reloadClaim.controllerId, claim.controllerId);
    await instance.submit("/ui-fixture", "followUp", "ui-after-reload");
    await responseTask;
    await instance.waitForIdle();
    assert.equal(instance.snapshot().lifecycle, "active");
    assert.equal(instance.snapshot().extensionStatus?.fixture, "ready[2J");
    const reloadTitle = events.findLast((event) => event.type === "extension.title_set");
    const reloadEditor = events.findLast((event) => event.type === "extension.editor_text_set");
    assert.equal(reloadTitle?.type, "extension.title_set");
    if (reloadTitle?.type === "extension.title_set") assert.equal(reloadTitle.data.controllerId, reloadClaim.controllerId);
    assert.equal(reloadEditor?.type, "extension.editor_text_set");
    if (reloadEditor?.type === "extension.editor_text_set") assert.equal(reloadEditor.data.controllerId, reloadClaim.controllerId);

    await instance.submit("/ui-component", "followUp", "component-after-reload");
    instance.setExtensionWidgetViewport(leaseToken, instance.snapshot().runtimeGeneration, { width: 73, height: 24 });
    for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "extension.widget_changed" && event.data.key === "component"); attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    const component = events.findLast((event) => event.type === "extension.widget_changed" && event.data.key === "component");
    assert.equal(component?.type, "extension.widget_changed");
    if (component?.type === "extension.widget_changed") assert.deepEqual(component.data.lines, ["component:73"]);
  } finally {
    unsubscribe();
    await instance.stop();
  }
});
