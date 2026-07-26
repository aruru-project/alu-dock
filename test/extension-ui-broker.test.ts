import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionUiBroker,
  InteractionExpiredError,
  InteractionInvalidResponseError,
  InteractionWrongLeaseError,
  type ExtensionUiEventSink,
} from "../src/core/extension-ui-broker.js";
import type { EventDataMap } from "../src/core/instance-dto.js";

function harness() {
  let generation = 1;
  let nextId = 0;
  let projectionChanges = 0;
  const events: Array<{ type: string; data: unknown }> = [];
  const broker = new ExtensionUiBroker(
    () => new Date("2026-07-15T00:00:00.000Z"),
    () => `id-${++nextId}`,
  );
  const sink: ExtensionUiEventSink = {
    generation: () => generation,
    emit: (type, data) => { events.push({ type, data }); },
    projectionChanged: () => { projectionChanges += 1; },
  };
  broker.bind(sink);
  return {
    broker,
    events,
    get projectionChanges() { return projectionChanges; },
    setGeneration(value: number) { generation = value; },
  };
}

function requested(events: Array<{ type: string; data: unknown }>): EventDataMap["interaction.requested"][] {
  return events
    .filter((event) => event.type === "interaction.requested")
    .map((event) => event.data as EventDataMap["interaction.requested"]);
}

test("extension UI dialogs fail closed immediately without a controller", async () => {
  const { broker, events } = harness();
  assert.equal(await broker.select("Choose", ["yes", "no"]), undefined);
  assert.equal(await broker.confirm("Delete", "Really?"), false);
  assert.equal(await broker.input("Name"), undefined);
  assert.equal(await broker.editor("Body", "draft"), undefined);
  assert.equal(await broker.select("Oversized", ["x".repeat(8_001)]), undefined);
  assert.equal(await broker.select("Collision", ["same\n", "same"]), undefined);
  assert.equal(await broker.select("Aggregate", Array.from({ length: 33 }, (_, index) => `${index}:`.padEnd(8_000, "x"))), undefined);
  assert.equal(requested(events).length, 0);
  assert.equal(events.filter((event) => event.type === "extension.error").length, 3);
});

test("one lease serializes dialogs and validates method-specific responses", async () => {
  const { broker, events } = harness();
  const claim = await broker.claimController();
  assert.deepEqual(claim, { status: "acquired", leaseToken: "id-1", controllerId: "id-2" });
  assert.deepEqual(await broker.claimController(), { status: "unavailable" });
  if (claim.status !== "acquired") return;

  const selected = broker.select("Pick\u001b[2J", ["A\u001b[2J", "B"]);
  const confirmed = broker.confirm("Proceed?", "Apply it?");
  await Promise.resolve();
  const first = requested(events)[0];
  assert.ok(first && first.method === "select");
  assert.equal(first.title, "Pick[2J");
  assert.deepEqual(first.options, ["A[2J", "B"]);
  assert.equal(broker.projection().activeInteraction?.id, first.interactionId);

  await assert.rejects(
    broker.respond(claim.leaseToken, first.interactionId, { method: "select", value: "missing" }),
    InteractionInvalidResponseError,
  );
  assert.deepEqual(
    await broker.respond(claim.leaseToken, first.interactionId, { method: "select", value: "A[2J" }),
    { interactionId: first.interactionId, state: "resolved" },
  );
  assert.equal(await selected, "A\u001b[2J", "the extension receives its original option value");

  const second = requested(events)[1];
  assert.ok(second && second.method === "confirm");
  assert.deepEqual(
    await broker.respond(claim.leaseToken, second.interactionId, { method: "confirm", cancelled: true }),
    { interactionId: second.interactionId, state: "resolved" },
  );
  assert.equal(await confirmed, false);
  assert.equal(broker.projection().activeInteraction, undefined);

  assert.deepEqual(
    await broker.respond(claim.leaseToken, first.interactionId, { method: "select", value: "A[2J" }),
    { interactionId: first.interactionId, state: "already_resolved" },
  );
});

test("wrong leases, detach, signal, and generation changes resolve fail closed", async () => {
  const { broker, events, setGeneration } = harness();
  const claim = await broker.claimController();
  if (claim.status !== "acquired") return;
  const controller = new AbortController();
  const selected = broker.select("Pick", ["A"], { signal: controller.signal });
  await Promise.resolve();
  const first = requested(events)[0]!;
  await assert.rejects(
    broker.respond("wrong-token", first.interactionId, { method: "select", value: "A" }),
    InteractionWrongLeaseError,
  );
  controller.abort();
  assert.equal(await selected, undefined);
  await assert.rejects(
    broker.respond(claim.leaseToken, first.interactionId, { method: "select", value: "A" }),
    InteractionExpiredError,
  );

  const confirmed = broker.confirm("Delete", "Really?");
  await Promise.resolve();
  await broker.releaseController(claim.leaseToken, "detach");
  assert.equal(await confirmed, false);
  assert.equal(events.some((event) => event.type === "interaction.cancelled" && (event.data as { reason?: string }).reason === "detach"), true);

  const replacementClaim = await broker.claimController();
  assert.equal(replacementClaim.status, "acquired");
  broker.setStatus("fixture", "ready");
  const input = broker.input("Name");
  broker.beginGenerationChange();
  assert.equal(await input, undefined);
  setGeneration(2);
  await broker.completeGenerationChange();
  assert.deepEqual(broker.projection().extensionStatus, {});
  assert.deepEqual(await broker.claimController(), { status: "acquired", leaseToken: "id-8", controllerId: "id-9" });
});

test("controller directives are targeted, bounded, dropped without a lease, and never replayed to a fresh lease", async () => {
  const harnessState = harness();
  const { broker, events } = harnessState;
  broker.setTitle("dropped");
  broker.setEditorText("dropped");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "extension.title_set" || event.type === "extension.editor_text_set"), false);

  const first = await broker.claimController();
  assert.equal(first.status, "acquired");
  if (first.status !== "acquired") return;
  assert.notEqual(first.leaseToken, first.controllerId);
  broker.setTitle(`Review\u001b[2J\n${"x".repeat(2_100)}`);
  broker.setEditorText(`line one\r\nline two\u001b[2J`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const title = events.find((event) => event.type === "extension.title_set")?.data as EventDataMap["extension.title_set"];
  const editorText = events.find((event) => event.type === "extension.editor_text_set")?.data as EventDataMap["extension.editor_text_set"];
  assert.equal(title.controllerId, first.controllerId);
  assert.ok(title.title.length <= 2_048);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(title.title), false);
  assert.deepEqual(editorText, { controllerId: first.controllerId, text: "line one\nline two[2J" });

  await broker.releaseController(first.leaseToken);
  broker.setTitle("detached");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeFresh = events.length;
  const fresh = await broker.claimController();
  assert.equal(fresh.status, "acquired");
  if (fresh.status !== "acquired") return;
  assert.notEqual(fresh.controllerId, first.controllerId);
  assert.equal(events.length, beforeFresh);
  broker.beginGenerationChange();
  broker.setEditorText("suspended");
  harnessState.setGeneration(2);
  await broker.completeGenerationChange();
  assert.equal(events.some((event) => event.type === "extension.editor_text_set" && (event.data as { text?: string }).text === "suspended"), false);
});

test("tool expansion is readable, emits same-value authoritative events, and resets per generation", async () => {
  const harnessState = harness();
  const { broker, events } = harnessState;
  assert.equal(broker.getToolsExpanded(), false);
  assert.equal(broker.projection().toolsExpanded, false);

  broker.setToolsExpanded(true);
  broker.setToolsExpanded(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(broker.getToolsExpanded(), true);
  assert.equal(broker.projection().toolsExpanded, true);
  assert.deepEqual(events.filter((item) => item.type === "extension.tools_expanded_changed").map((item) => item.data), [
    { expanded: true },
    { expanded: true },
  ]);

  broker.beginGenerationChange();
  assert.equal(broker.getToolsExpanded(), false);
  harnessState.setGeneration(2);
  await broker.completeGenerationChange();
  assert.equal(broker.projection().toolsExpanded, false);
});

test("dialog timeout wins the serialized race and resolves fail closed", async () => {
  const { broker, events } = harness();
  const claim = await broker.claimController();
  if (claim.status !== "acquired") return;
  const confirmed = broker.confirm("Timeout", "Do not wait forever", { timeout: 5 });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  assert.equal(await confirmed, false);
  assert.equal(events.some((event) => event.type === "interaction.cancelled" && (event.data as { reason?: string }).reason === "timeout"), true);
});

test("notifications, statuses, widgets, and overflow remain closed and bounded", async () => {
  const { broker, events } = harness();
  broker.notify("hello\u001b[2J", "warning");
  broker.setStatus("worker\nstatus", "busy\nnow");
  broker.setStatus("__proto__", "unsafe");
  broker.setWidget("jobs", ["one\nline"], "belowEditor");
  const rawBase64 = "A0+/".repeat(32);
  broker.notify("data:image/png;base64,A0+/A0+/", "info");
  broker.setStatus("binary", `attachment: ${rawBase64}`);
  broker.setWidget("binary", [rawBase64]);
  broker.setWidget("oversized", Array.from({ length: 33 }, () => "x".repeat(8_000)));
  assert.deepEqual(broker.projection().extensionStatus, {
    binary: "[binary/image payload omitted]",
    workerstatus: "busynow",
  });
  assert.equal(events.some((event) => event.type === "extension.notification" && (event.data as { message?: string }).message === "hello[2J"), true);
  assert.equal(events.some((event) => event.type === "extension.widget_changed" && (event.data as { placement?: string }).placement === "belowEditor"), true);
  assert.equal(events.some((event) => event.type === "extension.widget_changed" && (event.data as { key?: string }).key === "oversized"), false);
  assert.equal(events.some((event) => event.type === "extension.error" && /widget payload exceeds/u.test(String((event.data as { error?: string }).error))), true);
  assert.equal(JSON.stringify(events).includes("data:image/png;base64"), false);
  assert.equal(JSON.stringify(events).includes(rawBase64), false);

  const claim = await broker.claimController();
  if (claim.status !== "acquired") return;
  const pending = Array.from({ length: 16 }, (_, index) => broker.confirm(`Confirm ${index}`, "continue?"));
  const overflow = broker.confirm("Overflow", "continue?");
  assert.equal(await overflow, false);
  assert.equal(events.some((event) => event.type === "interaction.cancelled" && (event.data as { reason?: string }).reason === "overflow"), true);
  await broker.cancelForHostDrain();
  assert.deepEqual(await Promise.all(pending), Array.from({ length: 16 }, () => false));
});
