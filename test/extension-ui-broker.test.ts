import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionUiBroker,
  ExtensionUiRequestError,
  InteractionExpiredError,
  InteractionInvalidResponseError,
  InteractionLifecycleCancelledError,
  InteractionWrongLeaseError,
  type ExtensionUiEventSink,
} from "../src/core/extension-ui-broker.js";
import type { EventDataMap } from "../src/core/instance-dto.js";

function harness() {
  let generation = 1;
  let nextId = 0;
  let projectionChanges = 0;
  let nowMs = Date.parse("2026-07-15T00:00:00.000Z");
  const events: Array<{ type: string; data: unknown }> = [];
  const broker = new ExtensionUiBroker(
    () => new Date(nowMs),
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
    advanceTime(milliseconds: number) { nowMs += milliseconds; },
  };
}

function requested(events: Array<{ type: string; data: unknown }>): EventDataMap["interaction.requested"][] {
  return events
    .filter((event) => event.type === "interaction.requested")
    .map((event) => event.data as EventDataMap["interaction.requested"]);
}

test("extension UI dialogs wait without a controller and activate on the first claim", async () => {
  const { broker, events, advanceTime } = harness();
  await assert.rejects(broker.select("Oversized", ["x".repeat(8_001)]), ExtensionUiRequestError);
  await assert.rejects(broker.select("Collision", ["same\n", "same"]), ExtensionUiRequestError);
  await assert.rejects(
    broker.select("Aggregate", Array.from({ length: 33 }, (_, index) => `${index}:`.padEnd(8_000, "x"))),
    ExtensionUiRequestError,
  );

  let settled = false;
  const selected = broker.select("Choose", ["yes", "no"]).then((value) => { settled = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(requested(events).length, 0);
  advanceTime(6 * 60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "dialogs without an explicit extension timeout must survive beyond five minutes");

  const claim = await broker.claimController();
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;
  const request = requested(events)[0]!;
  assert.equal(request.expiresAt, undefined);
  await broker.respond(claim.leaseToken, request.interactionId, { method: "select", value: "yes" });
  assert.equal(await selected, "yes");
  assert.equal(events.filter((event) => event.type === "extension.error").length, 3);
});

test("the latest lease serializes dialogs and validates method-specific responses", async () => {
  const { broker, events } = harness();
  const firstClaim = await broker.claimController();
  assert.deepEqual(firstClaim, { status: "acquired", leaseToken: "id-1", controllerId: "id-2" });
  const claim = await broker.claimController();
  assert.deepEqual(claim, { status: "acquired", leaseToken: "id-3", controllerId: "id-4" });

  const selected = broker.select("Pick\u001b[2J", ["A\u001b[2J", "B"]);
  const confirmed = broker.confirm("Proceed?", "Apply it?");
  await Promise.resolve();
  const first = requested(events)[0];
  assert.ok(first && first.method === "select");
  assert.equal(first.title, "Pick[2J");
  assert.deepEqual(first.options, ["A[2J", "B"]);
  assert.equal(first.expiresAt, undefined);
  assert.deepEqual(broker.projection().activeInteraction, { id: first.interactionId, method: "select" });

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

test("detach preserves an interaction for the next lease while signal and generation changes cancel", async () => {
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

  let confirmationSettled = false;
  const confirmed = broker.confirm("Delete", "Really?").then((value) => { confirmationSettled = true; return value; });
  await Promise.resolve();
  const confirmationRequest = requested(events).at(-1)!;
  await broker.releaseController(claim.leaseToken, "detach");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(confirmationSettled, false);
  assert.equal(events.some((event) => event.type === "interaction.cancelled" && (event.data as { reason?: string }).reason === "detach"), false);

  const replacementClaim = await broker.claimController();
  assert.equal(replacementClaim.status, "acquired");
  if (replacementClaim.status !== "acquired") return;
  assert.equal(requested(events).at(-1)?.interactionId, confirmationRequest.interactionId);
  await broker.respond(replacementClaim.leaseToken, confirmationRequest.interactionId, { method: "confirm", confirmed: true });
  assert.equal(await confirmed, true);
  broker.setStatus("fixture", "ready");
  const input = broker.input("Name");
  await new Promise<void>((resolve) => setImmediate(resolve));
  broker.beginGenerationChange();
  await assert.rejects(input, (error: unknown) => error instanceof InteractionLifecycleCancelledError && error.reason === "replacement");
  assert.equal(events.some((event) => event.type === "interaction.cancelled" && (event.data as { reason?: string }).reason === "replacement"), true);
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
    binary: `attachment: ${rawBase64}`,
    workerstatus: "busynow",
  });
  assert.equal(events.some((event) => event.type === "extension.notification" && (event.data as { message?: string }).message === "hello[2J"), true);
  assert.equal(events.some((event) => event.type === "extension.widget_changed" && (event.data as { placement?: string }).placement === "belowEditor"), true);
  assert.equal(events.some((event) => event.type === "extension.widget_changed" && (event.data as { key?: string }).key === "oversized"), false);
  assert.equal(events.some((event) => event.type === "extension.error" && /widget content is too large/u.test(String((event.data as { error?: string }).error))), true);
  assert.equal(JSON.stringify(events).includes("data:image/png;base64"), true);
  assert.equal(JSON.stringify(events).includes(rawBase64), true);

  const claim = await broker.claimController();
  if (claim.status !== "acquired") return;
  await assert.rejects(broker.select("Invalid", []), ExtensionUiRequestError);
  const pending = Array.from({ length: 16 }, (_, index) => broker.confirm(`Confirm ${index}`, "continue?")
    .then((value) => ({ status: "resolved" as const, value }), (error: unknown) => ({ status: "rejected" as const, error })));
  const overflow = broker.confirm("Overflow", "continue?");
  await assert.rejects(overflow, ExtensionUiRequestError);
  assert.equal(events.some((event) => event.type === "interaction.cancelled" && (event.data as { reason?: string }).reason === "overflow"), true);
  await broker.cancelForHostDrain();
  const drained = await Promise.all(pending);
  assert.equal(drained.every((outcome) => outcome.status === "rejected"
    && outcome.error instanceof InteractionLifecycleCancelledError
    && outcome.error.reason === "host_draining"), true);
});
