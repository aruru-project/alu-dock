import assert from "node:assert/strict";
import test from "node:test";

import { JsonLineDecoder, JsonLineError } from "../src/control/json-lines.js";
import {
  capabilityForRequest,
  parseAbortResult,
  parseClientHello,
  parseControlEventEnvelope,
  parseControlRequest,
  parseControlResponse,
  parseEventsResult,
  parseForgetResult,
  parseHostInfoResult,
  parseHistoryResult,
  parseInteractionRespondResult,
  parseListResult,
  parseModelConfigurationResult,
  parsePruneResult,
  parsePromptResult,
  parseQueueDequeueResult,
  parseReopenResult,
  parseSessionsResult,
  parseSessionCompactionResult,
  parseSessionInventoryResult,
  parseSessionNameResult,
  parseSessionReloadResult,
  parseSessionReplacementResult,
  parseSessionTreeResult,
  parseSessionNavigateResult,
  parseSessionForkResult,
  parseSessionCloneResult,
  parseStatusResult,
  parseToolsResult,
  parseSettingsResult,
  parseSettingUpdateResult,
  parseResourcesResult,
  parseCommandsResult,
  ProtocolValidationError,
  requiredCapabilities,
} from "../src/control/protocol.js";
import { SETTING_DEFINITIONS, SETTING_KEYS, type SettingKey, type SettingValueMap } from "../src/core/config-projection.js";

test("JSONL decoder preserves split UTF-8 and treats Unicode separators as data", () => {
  const decoder = new JsonLineDecoder();
  const line = JSON.stringify({ text: "你\u2028好" });
  const encoded = Buffer.from(`${line}\n`, "utf8");
  const split = encoded.indexOf(Buffer.from("你")) + 1;
  assert.deepEqual(decoder.push(encoded.subarray(0, split)), []);
  assert.deepEqual(decoder.push(encoded.subarray(split)), [line]);
  assert.deepEqual(decoder.finish(), []);
});

test("JSONL decoder rejects oversized and unterminated records", () => {
  const oversized = new JsonLineDecoder(4);
  assert.throws(() => oversized.push("12345"), (error: unknown) => error instanceof JsonLineError && error.code === "record_too_large");
  const incomplete = new JsonLineDecoder();
  incomplete.push('{"ok":true}');
  assert.throws(() => incomplete.finish(), (error: unknown) => error instanceof JsonLineError && error.code === "incomplete_record");
});

test("V2 hello is closed, bounded, and rejects duplicate capabilities", () => {
  const hello = { kind: "hello", requestId: "h1", versions: [2], client: { name: "test", version: "0.1.0", clientId: "c1" }, requiredCapabilities: ["core.v2"] };
  assert.deepEqual(parseClientHello(hello), hello);
  assert.throws(() => parseClientHello({ ...hello, extra: true }), /Unexpected field/);
  assert.throws(() => parseClientHello({ ...hello, requiredCapabilities: ["core.v2", "core.v2"] }), /must be unique/);
  assert.throws(() => parseClientHello({ ...hello, versions: [1, 2.5] }), /bounded positive integer array/);
});

function validSnapshot(): Record<string, unknown> {
  return {
    id: "i1", creationOperationId: "op-create", cwd: "/tmp/project",
    lifecycle: "active", execution: "idle", compacting: false, lastRun: "never", reopenable: false,
    runtimeGeneration: 1, ownerHostEpoch: "epoch-1",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: "fixture", piSessionId: "pi-1" }, extensionStatus: {}, toolsExpanded: false,
    createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 },
  };
}

function validEvent(type = "message.delta", data: Record<string, unknown> = { messageId: "m1", block: "text", delta: "hello" }): Record<string, unknown> {
  return { scope: "instance", sequence: 1, instanceId: "i1", runtimeGeneration: 1, occurredAt: "2026-07-14T00:00:00.000Z", type, data };
}

test("toolsExpanded request, snapshot, and event contracts are strict", () => {
  const base = { kind: "request", version: 2, requestId: "tools-expanded-1", type: "extension.tools_expanded.set" };
  assert.deepEqual(parseControlRequest({
    ...base,
    params: { operationId: "operation-1", instanceId: "i1", expectedRuntimeGeneration: 1, expanded: true },
  }), {
    ...base,
    params: { operationId: "operation-1", instanceId: "i1", expectedRuntimeGeneration: 1, expanded: true },
  });
  assert.throws(() => parseControlRequest({
    ...base,
    params: { operationId: "operation-1", instanceId: "i1", expectedRuntimeGeneration: 1, expanded: true, extra: true },
  }), /Unexpected field/u);
  assert.throws(() => parseControlRequest({
    ...base,
    params: { operationId: "operation-1", instanceId: "i1", expectedRuntimeGeneration: 0, expanded: "yes" },
  }), /expectedRuntimeGeneration|expanded/u);

  assert.equal(parseStatusResult({ instance: { ...validSnapshot(), toolsExpanded: true } }).instance.toolsExpanded, true);
  const { toolsExpanded: _missing, ...withoutToolsExpanded } = validSnapshot();
  assert.throws(() => parseStatusResult({ instance: withoutToolsExpanded }), /toolsExpanded/u);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), toolsExpanded: "yes" } }), /toolsExpanded/u);

  const envelope = (data: unknown) => ({
    kind: "event", version: 2, requestId: "attach-1", hostEpoch: "epoch-1",
    event: validEvent("extension.tools_expanded_changed", data as Record<string, unknown>),
  });
  const parsedEvent = parseControlEventEnvelope(envelope({ expanded: true }), "attach-1", "epoch-1").event;
  assert.equal(parsedEvent.type, "extension.tools_expanded_changed");
  if (parsedEvent.type !== "extension.tools_expanded_changed") assert.fail("unexpected event type");
  assert.equal(parsedEvent.data.expanded, true);
  assert.throws(() => parseControlEventEnvelope(envelope({ expanded: true, extra: true }), "attach-1", "epoch-1"), /Unexpected field/u);
  assert.throws(() => parseControlEventEnvelope(envelope({ expanded: 1 }), "attach-1", "epoch-1"), /expanded/u);
});

test("Git branch snapshot and event projections are closed, bounded, and terminal-safe", () => {
  const branchSnapshot = parseStatusResult({ instance: { ...validSnapshot(), gitBranch: "feature/live" } });
  assert.equal(branchSnapshot.instance.gitBranch, "feature/live");
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), gitBranch: "unsafe\nbranch" } }), /terminal-safe/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), gitBranch: "x".repeat(257) } }), /bounded string/);

  const envelope = (data: Record<string, unknown>) => ({
    kind: "event", version: 2, requestId: "branch-stream", hostEpoch: "epoch-1",
    event: validEvent("git.branch_changed", data),
  });
  assert.deepEqual(parseControlEventEnvelope(envelope({ branch: "main" }), "branch-stream", "epoch-1").event.data, { branch: "main" });
  assert.deepEqual(parseControlEventEnvelope(envelope({}), "branch-stream", "epoch-1").event.data, {});
  assert.throws(() => parseControlEventEnvelope(envelope({ branch: "main", extra: true }), "branch-stream", "epoch-1"), /Unexpected field/);
});

test("V2 requests reject unsupported versions, unknown fields, invalid cursors, and invalid enums", () => {
  assert.throws(
    () => parseControlRequest({ version: 3, requestId: "r1", type: "ping" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "unsupported_protocol",
  );
  const base = { kind: "request", version: 2, requestId: "r2" };
  assert.throws(() => parseControlRequest({ ...base, type: "host.info", params: { extra: true } }), /Unexpected field/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", follow: false, controller: "observe", since: { hostEpoch: "e1", instanceId: "i1", runtimeGeneration: 1, sequence: -1 } },
  }), (error: unknown) => error instanceof ProtocolValidationError && error.code === "invalid_request");
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", follow: false, controller: "observe", since: 4 },
  }), (error: unknown) => error instanceof ProtocolValidationError && error.code === "invalid_request");
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", follow: false, controller: "claim" },
  }), /requires a follow attach stream/);
  const legacyAttach = parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", follow: true, controller: "observe" },
  });
  assert.equal(legacyAttach.type === "instance.attach" && "replay" in legacyAttach.params, false);
  const conversationAttach = parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", follow: true, controller: "observe", replay: "conversation_bootstrap" },
  });
  assert.equal(conversationAttach.type === "instance.attach" ? conversationAttach.params.replay : undefined, "conversation_bootstrap");
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", follow: false, controller: "observe", replay: "conversation_bootstrap" },
  }), /requires a fresh follow stream/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", since: { hostEpoch: "e1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, follow: true, controller: "observe", replay: "conversation_bootstrap" },
  }), /without a cursor/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "command.submit",
    params: { operationId: "op1", instanceId: "i1", message: "hello", delivery: "parallel" },
  }), /unsupported value/);

  assert.deepEqual(parseControlRequest({
    ...base,
    type: "model.set",
    params: { operationId: "op1", instanceId: "i1", provider: "local", modelId: "qwen/test" },
  }), {
    ...base,
    type: "model.set",
    params: { operationId: "op1", instanceId: "i1", provider: "local", modelId: "qwen/test" },
  });
  assert.deepEqual(parseControlRequest({ ...base, type: "session.history", params: { instanceId: "i1", beforeEntryId: "entry-2", limit: 200 } }).params, { instanceId: "i1", beforeEntryId: "entry-2", limit: 200 });
  assert.throws(() => parseControlRequest({ ...base, type: "session.history", params: { instanceId: "i1", limit: 201 } }), /between 1 and 200/);
  assert.deepEqual(parseControlRequest({ ...base, type: "session.inventory", params: { cwd: "/tmp/project", scope: "cwd" } }), {
    ...base, type: "session.inventory", params: { cwd: "/tmp/project", scope: "cwd" },
  });
  assert.throws(() => parseControlRequest({ ...base, type: "session.inventory", params: { cwd: "relative", scope: "all" } }), /must be absolute/);
  assert.deepEqual(parseControlRequest({ ...base, type: "session.list", params: { instanceId: "i1", scope: "all" } }), {
    ...base, type: "session.list", params: { instanceId: "i1", scope: "all" },
  });
  assert.throws(() => parseControlRequest({ ...base, type: "session.list", params: { instanceId: "i1", scope: "project" } }), /unsupported value/);
  assert.deepEqual(parseControlRequest({ ...base, type: "command.abort", params: { operationId: "abort-op", instanceId: "i1" } }).params, { operationId: "abort-op", instanceId: "i1" });
  assert.throws(() => parseControlRequest({ ...base, type: "command.abort", params: { operationId: "abort-op", instanceId: "i1", force: true } }), /Unexpected field/);
  assert.deepEqual(parseControlRequest({ ...base, type: "queue.dequeue", params: { operationId: "dequeue-op", instanceId: "i1" } }).params, { operationId: "dequeue-op", instanceId: "i1" });
  assert.throws(() => parseControlRequest({ ...base, type: "queue.dequeue", params: { operationId: "dequeue-op", instanceId: "i1", abort: true } }), /Unexpected field/);
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "instance.list",
    params: { selector: "actionable", cursor: { revision: 7, offset: 100, selector: "actionable" }, limit: 100 },
  }).params, { selector: "actionable", cursor: { revision: 7, offset: 100, selector: "actionable" }, limit: 100 });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.list",
    params: { selector: "all", cursor: { revision: 7, offset: 100, selector: "actionable" }, limit: 100 },
  }), /selector does not match/u);
  assert.throws(() => parseControlRequest({ ...base, type: "instance.list", params: { selector: "all", limit: 101 } }), /must not exceed 100/u);
  assert.equal(capabilityForRequest("instance.adopt"), "session.adopt.v1");
  assert.equal(capabilityForRequest("session.inventory"), "session.inventory.v1");
  assert.equal(capabilityForRequest("extension.tools_expanded.set"), "extension_ui.tools-expanded.v1");
  assert.deepEqual(requiredCapabilities("events.replay-purpose.v1"), ["core.v2", "events.follow", "extension_ui.tools-expanded.v1", "git.branch-footer.v1", "events.replay-purpose.v1"]);

  const adopted = parseControlRequest({
    ...base,
    type: "instance.adopt",
    params: { operationId: "adopt-1", sessionFile: "/tmp/session.jsonl", name: "adopted" },
  });
  assert.deepEqual(adopted.params, {
    operationId: "adopt-1", sessionFile: "/tmp/session.jsonl", name: "adopted",
    trustChallengeId: undefined, projectTrustDecision: undefined,
  });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.adopt",
    params: { operationId: "adopt-2", sessionFile: "relative.jsonl" },
  }), /must be absolute/);

  const trustedCreate = parseControlRequest({
    ...base,
    type: "instance.create",
    params: {
      operationId: "create-1",
      cwd: "/tmp/project",
      trustChallengeId: "challenge-1",
      projectTrustDecision: "deny_once",
    },
  });
  assert.equal(trustedCreate.type, "instance.create");
  assert.equal(trustedCreate.params.projectTrustDecision, "deny_once");
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.create",
    params: { operationId: "create-1", cwd: "/tmp/project", trustChallengeId: "challenge-1" },
  }), /must be supplied together/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.create",
    params: { operationId: "create-1", cwd: "/tmp/project", trustChallengeId: "challenge-1", projectTrustDecision: "allow" },
  }), /unsupported value/);
});

test("instance list pages are revision-bound, bounded, and closed", () => {
  const instance = validSnapshot();
  const parsed = parseListResult({
    instances: [instance],
    page: {
      revision: 4,
      total: 2,
      hiddenStopped: 3,
      nextCursor: { revision: 4, offset: 1, selector: "actionable" },
    },
  });
  assert.equal(parsed.instances.length, 1);
  assert.deepEqual(parsed.page.nextCursor, { revision: 4, offset: 1, selector: "actionable" });
  assert.throws(() => parseListResult({
    instances: [instance],
    page: {
      revision: 4,
      total: 2,
      hiddenStopped: 3,
      nextCursor: { revision: 5, offset: 1, selector: "actionable" },
    },
  }), /inconsistent/u);
  assert.throws(() => parseListResult({
    instances: [],
    page: {
      revision: 4,
      total: 2,
      hiddenStopped: 0,
      nextCursor: { revision: 4, offset: 0, selector: "all" },
    },
  }), /inconsistent/u);
  assert.throws(() => parseListResult({ instances: [], page: { revision: 4, total: 0, hiddenStopped: 0, extra: true } }), /Unexpected field/u);
});

test("catalog maintenance requests and receipts are closed and never claim Pi session deletion", () => {
  const base = { kind: "request", version: 2, requestId: "maintenance-request" };
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "instance.forget",
    params: { operationId: "forget-1", instanceId: "i1" },
  }).params, { operationId: "forget-1", instanceId: "i1" });
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "catalog.prune",
    params: { operationId: "prune-1", selector: "stopped" },
  }).params, { operationId: "prune-1", selector: "stopped" });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "catalog.prune",
    params: { operationId: "prune-1", selector: "all" },
  }), /unsupported value/u);

  assert.deepEqual(parseForgetResult({ receipt: {
    operationId: "forget-1",
    forgottenId: "i1",
    previousLifecycle: "host_lost",
    piSessionFilesDeleted: 0,
  } }).receipt, {
    operationId: "forget-1",
    forgottenId: "i1",
    previousLifecycle: "host_lost",
    piSessionFilesDeleted: 0,
  });
  assert.throws(() => parseForgetResult({ receipt: {
    operationId: "forget-1", forgottenId: "i1", previousLifecycle: "stopped", piSessionFilesDeleted: 1,
  } }), /must not delete/u);

  assert.deepEqual(parsePruneResult({ receipt: {
    operationId: "prune-1",
    selector: "stopped",
    forgottenIds: ["i1", "i2"],
    forgottenCount: 2,
    hasMore: false,
    piSessionFilesDeleted: 0,
  } }).receipt.forgottenIds, ["i1", "i2"]);
  assert.throws(() => parsePruneResult({ receipt: {
    operationId: "prune-1", selector: "stopped", forgottenIds: ["i1"], forgottenCount: 2, hasMore: false, piSessionFilesDeleted: 0,
  } }), /must match/u);
});

test("Stage 5 reopen requests and results are closed and generation-bounded", () => {
  const base = { kind: "request", version: 2, requestId: "reopen-request" };
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "instance.reopen",
    params: {
      operationId: "reopen-1",
      instanceId: "i1",
      sessionFile: "/tmp/session.jsonl",
      trustChallengeId: "challenge-1",
      projectTrustDecision: "trust_once",
    },
  }).params, {
    operationId: "reopen-1",
    instanceId: "i1",
    sessionFile: "/tmp/session.jsonl",
    trustChallengeId: "challenge-1",
    projectTrustDecision: "trust_once",
  });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.reopen",
    params: { operationId: "reopen-1", instanceId: "i1", sessionFile: "relative.jsonl" },
  }), /must be absolute/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.reopen",
    params: { operationId: "reopen-1", instanceId: "i1", trustChallengeId: "challenge-1" },
  }), /must be supplied together/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.reopen",
    params: { operationId: "reopen-1", instanceId: "i1", replay: true },
  }), /Unexpected field/);

  const instance = {
    ...validSnapshot(),
    runtimeGeneration: 2,
    eventCursor: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 2, sequence: 1 },
  };
  assert.deepEqual(parseReopenResult({ operationId: "reopen-1", previousLifecycle: "host_lost", instance }), {
    operationId: "reopen-1", previousLifecycle: "host_lost", instance: parseStatusResult({ instance }).instance,
  });
  assert.throws(() => parseReopenResult({ operationId: "reopen-1", previousLifecycle: "host_lost", instance, replayed: true }), /Unexpected field/);
  assert.throws(() => parseReopenResult({ operationId: "reopen-1", previousLifecycle: "stopped", instance }), /unsupported value/);
});

test("Stage 4 interaction requests, responses, and controller leases are closed", () => {
  const base = { kind: "request", version: 2, requestId: "interaction-request" };
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "interaction.respond",
    params: {
      operationId: "respond-1", instanceId: "i1", leaseToken: "lease-1", interactionId: "dialog-1",
      response: { method: "confirm", confirmed: true },
    },
  }).params, {
    operationId: "respond-1", instanceId: "i1", leaseToken: "lease-1", interactionId: "dialog-1",
    response: { method: "confirm", confirmed: true },
  });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "interaction.respond",
    params: {
      operationId: "respond-1", instanceId: "i1", leaseToken: "lease-1", interactionId: "dialog-1",
      response: { method: "confirm", value: "yes" },
    },
  }), /Unexpected field|confirmed/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "interaction.respond",
    params: {
      operationId: "respond-1", instanceId: "i1", leaseToken: "lease-1", interactionId: "dialog-1",
      response: { method: "select", cancelled: false },
    },
  }), /must be true/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "interaction.respond",
    params: {
      operationId: "respond-1", instanceId: "i1", leaseToken: "lease-1", interactionId: "dialog-1",
      response: { method: "editor", value: "data:image/png;base64,A0+/A0+/A0+/" },
    },
  }), /cannot contain binary/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "interaction.respond",
    params: {
      operationId: "respond-1", instanceId: "i1", leaseToken: "lease-1", interactionId: "dialog-1",
      response: { method: "input", value: "A0+/".repeat(32) },
    },
  }), /cannot contain binary/);
  assert.deepEqual(parseInteractionRespondResult({ interactionId: "dialog-1", state: "already_resolved" }), {
    interactionId: "dialog-1", state: "already_resolved",
  });
  assert.throws(() => parseInteractionRespondResult({ interactionId: "dialog-1", state: "resolved", extra: true }), /Unexpected field/);

  const attach = parseEventsResult({
    instance: validSnapshot(),
    page: { events: [], earliest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, latest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, truncated: false, epochChanged: false, generationChanged: false },
    recentHistory: [], historyTruncated: false, pendingMessages: [], controller: { status: "acquired", leaseToken: "lease-1" }, following: true,
  });
  assert.deepEqual(attach.controller, { status: "acquired", leaseToken: "lease-1" });
  assert.throws(() => parseEventsResult({
    ...attach,
    controller: { status: "acquired" },
  }), /leaseToken/);
  assert.throws(() => parseControlEventEnvelope({
    kind: "event", version: 2, requestId: "stream-1", hostEpoch: "epoch-1",
    event: validEvent("extension.notification", { message: "data:image/png;base64,A0+/", level: "info" }),
  }, "stream-1", "epoch-1"), /cannot contain binary/);
  assert.throws(() => parseControlEventEnvelope({
    kind: "event", version: 2, requestId: "stream-1", hostEpoch: "epoch-1",
    event: validEvent("extension.status_changed", { key: "__proto__", text: "unsafe" }),
  }, "stream-1", "epoch-1"), /unsafe/);
});

test("Stage 3 session command requests and results are closed", () => {
  const base = { kind: "request", version: 2, requestId: "session-r" };
  assert.deepEqual(parseControlRequest({ ...base, type: "session.new", params: { operationId: "op-new", instanceId: "i1", parentSession: "/tmp/parent.jsonl" } }).params, { operationId: "op-new", instanceId: "i1", parentSession: "/tmp/parent.jsonl" });
  assert.deepEqual(parseControlRequest({ ...base, type: "session.name", params: { operationId: "op-name", instanceId: "i1", name: "" } }).params, { operationId: "op-name", instanceId: "i1", name: "" });
  assert.deepEqual(parseControlRequest({ ...base, type: "session.compact", params: { operationId: "op-compact", instanceId: "i1", customInstructions: "keep decisions" } }).params, { operationId: "op-compact", instanceId: "i1", customInstructions: "keep decisions" });
  assert.deepEqual(parseControlRequest({ ...base, type: "session.reload", params: { operationId: "op-reload", instanceId: "i1" } }).params, { operationId: "op-reload", instanceId: "i1" });
  assert.equal(parseControlRequest({ ...base, type: "session.switch", params: { operationId: "op-switch", instanceId: "i1", sessionFile: "/tmp/s.jsonl", trustChallengeId: "challenge", projectTrustDecision: "trust_once" } }).type, "session.switch");
  assert.throws(() => parseControlRequest({ ...base, type: "session.switch", params: { operationId: "op-switch", instanceId: "i1", sessionFile: "/tmp/s.jsonl", trustChallengeId: "challenge" } }), /must be supplied together/);
  assert.throws(() => parseControlRequest({ ...base, type: "session.compact", params: { operationId: "op", instanceId: "i1", customInstructions: "" } }), /non-empty/);
  assert.throws(() => parseControlRequest({ ...base, type: "session.reload", params: { operationId: "op", instanceId: "i1", force: true } }), /Unexpected field/);

  assert.equal(parseSessionReplacementResult({ cancelled: false, instance: validSnapshot() }).cancelled, false);
  assert.equal(parseSessionNameResult({ instance: { ...validSnapshot(), name: "renamed" } }).instance.name, "renamed");
  assert.deepEqual(parseSessionCompactionResult({ result: { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 123 }, instance: validSnapshot() }).result, { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 123 });
  assert.equal(parseSessionReloadResult({ instance: validSnapshot(), resources: [], diagnostics: [] }).resources.length, 0);
  assert.throws(() => parseSessionCompactionResult({ result: { summary: "summary", firstKeptEntryId: "kept", tokensBefore: -1 }, instance: validSnapshot() }), /non-negative/);
  assert.throws(() => parseSessionReloadResult({ instance: validSnapshot(), resources: [], diagnostics: [], raw: true }), /Unexpected field/);
});

test("Stage 6 tree, navigate, fork, and clone DTOs are closed and cursor-bounded", () => {
  const base = { kind: "request", version: 2, requestId: "tree-r" };
  assert.deepEqual(parseControlRequest({ ...base, type: "session.tree", params: { instanceId: "i1", limit: 2 } }).params, {
    instanceId: "i1", treeRevision: undefined, afterEntryId: undefined, limit: 2,
  });
  assert.deepEqual(parseControlRequest({ ...base, type: "session.tree", params: { instanceId: "i1", treeRevision: "g1-revision", afterEntryId: "e2", limit: 2 } }).params, {
    instanceId: "i1", treeRevision: "g1-revision", afterEntryId: "e2", limit: 2,
  });
  assert.throws(() => parseControlRequest({ ...base, type: "session.tree", params: { instanceId: "i1", treeRevision: "g1-revision", limit: 2 } }), /requires both/);
  assert.throws(() => parseControlRequest({ ...base, type: "session.tree", params: { instanceId: "i1", limit: 201 } }), /between 1 and 200/);

  assert.deepEqual(parseControlRequest({
    ...base,
    type: "session.navigate",
    params: { operationId: "navigate-1", instanceId: "i1", targetId: "e1", summarize: true, customInstructions: "keep decisions", replaceInstructions: true, label: "branch" },
  }).params, {
    operationId: "navigate-1", instanceId: "i1", targetId: "e1", summarize: true, customInstructions: "keep decisions", replaceInstructions: true, label: "branch",
  });
  assert.throws(() => parseControlRequest({ ...base, type: "session.navigate", params: { operationId: "navigate-1", instanceId: "i1", targetId: "e1", customInstructions: "orphan" } }), /require summarize=true/);
  assert.throws(() => parseControlRequest({ ...base, type: "session.navigate", params: { operationId: "navigate-1", instanceId: "i1", targetId: "e1", summarize: true, replaceInstructions: true } }), /requires customInstructions/);
  assert.equal(parseControlRequest({ ...base, type: "session.fork", params: { operationId: "fork-1", instanceId: "i1", entryId: "e1" } }).type, "session.fork");
  assert.equal(parseControlRequest({ ...base, type: "session.clone", params: { operationId: "clone-1", instanceId: "i1", entryId: "e2" } }).type, "session.clone");
  assert.throws(() => parseControlRequest({ ...base, type: "session.fork", params: { operationId: "fork-1", instanceId: "i1", entryId: "e1", position: "at" } }), /Unexpected field/);

  const node = { entryId: "e1", depth: 0, kind: "message", role: "user", displayClass: "content", timestamp: "2026-07-14T00:00:00.000Z", summary: "hello", hasChildren: true };
  assert.deepEqual(parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [node], leafId: "e1", total: 2, truncated: true, nextAfterEntryId: "e1" }), {
    treeRevision: "g1-revision", nodes: [node], leafId: "e1", total: 2, truncated: true, nextAfterEntryId: "e1",
  });
  assert.throws(() => parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [{ ...node, raw: true }], total: 1, truncated: false }), /Unexpected field/);
  const { displayClass: _displayClass, ...missingDisplayClass } = node;
  assert.throws(() => parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [missingDisplayClass], total: 1, truncated: false }), /displayClass/);
  assert.throws(() => parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [{ ...node, displayClass: "structural", state: "error" }], total: 1, truncated: false }), /state invariant/);
  assert.throws(() => parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [{ ...node, role: undefined, kind: "message" }], total: 1, truncated: false }), /role invariant/);
  assert.throws(() => parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [node], total: 2, truncated: true, nextAfterEntryId: "other" }), /last returned entry/);
  assert.throws(() => parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [{ ...node, summary: `tool: ${"A0+/".repeat(32)}` }], total: 1, truncated: false }), /cannot contain binary/);
  assert.throws(() => parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [{ ...node, depth: 100_001 }], total: 1, truncated: false }), /depth exceeds 100000/);
  assert.throws(() => parseSessionTreeResult({ treeRevision: "g1-revision", nodes: [], total: 100_001, truncated: false }), /total exceeds 100000/);

  assert.equal(parseSessionNavigateResult({ cancelled: false, editorText: "re-edit me", instance: validSnapshot() }).editorText, "re-edit me");
  assert.throws(() => parseSessionNavigateResult({ cancelled: false, aborted: true, instance: validSnapshot() }), /must be cancelled/);
  assert.equal(parseSessionForkResult({ cancelled: false, selectedText: "fork prompt", instance: validSnapshot() }).selectedText, "fork prompt");
  assert.throws(() => parseSessionForkResult({ cancelled: false, instance: validSnapshot() }), /must return selected text/);
  assert.throws(() => parseSessionForkResult({ cancelled: false, selectedText: `attachment: ${"A0+/".repeat(32)}`, instance: validSnapshot() }), /cannot contain binary/);
  assert.equal(parseSessionCloneResult({ cancelled: false, instance: validSnapshot() }).cancelled, false);
});

test("Stage 1C projection requests are closed and setting updates are discriminated", () => {
  const base = { kind: "request", version: 2, requestId: "projection-r" };
  assert.deepEqual(parseControlRequest({ ...base, type: "tool.set_active", params: { operationId: "op", instanceId: "i1", names: ["read", "write"] } }).params, { operationId: "op", instanceId: "i1", names: ["read", "write"] });
  assert.throws(() => parseControlRequest({ ...base, type: "tool.set_active", params: { operationId: "op", instanceId: "i1", names: ["read", "read"] } }), /must be unique/);
  assert.throws(() => parseControlRequest({ ...base, type: "settings.update", params: { operationId: "op", instanceId: "i1", update: { key: "editorPaddingX", value: 4 } } }), /out of range/);
  assert.throws(() => parseControlRequest({ ...base, type: "settings.update", params: { operationId: "op", instanceId: "i1", update: { key: "warnings", value: { token: true } } } }), /Unexpected field/);
  assert.throws(() => parseControlRequest({ ...base, type: "settings.update", params: { operationId: "op", instanceId: "i1", update: { key: "proxy", value: true } } }), /Unsupported setting key/);
  assert.throws(() => parseControlRequest({ ...base, type: "settings.update", params: { operationId: "op", instanceId: "i1", update: { key: "compactionReserveTokens", value: 16_384 } } }), /read-only/);
  assert.throws(() => parseControlRequest({ ...base, type: "resource.get", params: { instanceId: "i1", includeContent: true } }), /Unexpected field/);
  assert.throws(() => parseControlRequest({ ...base, type: "command.catalog", params: { instanceId: "i1", prefix: "x", extra: true } }), /Unexpected field/);
});

test("Stage 1C projection result parsers omit open shapes and enforce frozen metadata", () => {
  const tools = { tools: [{ name: "read", description: "Read", active: true, source: { kind: "built-in" }, parameterSchema: { type: "object" } }], instance: validSnapshot() };
  assert.equal(parseToolsResult(tools).tools[0]?.name, "read");
  assert.throws(() => parseToolsResult({ ...tools, tools: [{ ...tools.tools[0], execute: () => undefined }] }), /Unexpected field/);
  assert.throws(() => parseToolsResult({ ...tools, tools: [{ ...tools.tools[0], source: { kind: "built-in", path: "/spoofed" } }] }), /cannot carry path/);
  assert.throws(() => parseToolsResult({ ...tools, tools: [{ ...tools.tools[0], parameterSchema: { fn: () => undefined } }] }), /must be a JSON object/);
  assert.throws(() => parseToolsResult({ ...tools, tools: [{ ...tools.tools[0], parameterSchema: { ["x".repeat(257)]: true } }] }), /bounded string/);
  assert.deepEqual(parseResourcesResult({ resources: [{ kind: "prompt", name: "safe", path: "/p.md", source: { kind: "prompt" } }], diagnostics: [] }).resources[0], { kind: "prompt", name: "safe", path: "/p.md", source: { kind: "prompt" } });
  assert.throws(() => parseResourcesResult({ resources: [{ kind: "prompt", name: "unsafe", content: "secret" }], diagnostics: [] }), /Unexpected field/);
  assert.deepEqual(parseCommandsResult({ commands: [{ name: "x", source: { kind: "extension" }, argumentCompletions: true }] }).commands[0]?.argumentCompletions, true);
  assert.throws(() => parseCommandsResult({ commands: [{ name: "x", source: { kind: "extension" }, argumentCompletions: true, handler: "secret" }] }), /Unexpected field/);

  const values: SettingValueMap = { autoCompaction: true, compactionReserveTokens: 16_384, compactionKeepRecentTokens: 20_000, autoRetry: true, enableSkillCommands: true, hideThinking: false, showCacheMissNotices: false, showHardwareCursor: false, clearOnShrink: true, showTerminalProgress: true, quietStartup: false, collapseChangelog: false, enableInstallTelemetry: true, steeringMode: "all", followUpMode: "all", transport: "auto", doubleEscapeAction: "tree", treeFilterMode: "default", defaultProjectTrust: "ask", httpIdleTimeoutMs: 0, editorPaddingX: 0, outputPad: 0, autocompleteMaxVisible: 10, warnings: {} };
  const settingDtos = SETTING_KEYS.map((key) => settingDto(key, values));
  assert.equal(parseSettingsResult({ settings: settingDtos }).settings.length, SETTING_KEYS.length);
  assert.throws(() => parseSettingsResult({ settings: settingDtos.slice(1) }), new RegExp(`all ${SETTING_KEYS.length} keys`));
  const enabled = settingDtos.find((setting) => setting.key === "enableSkillCommands");
  assert.throws(() => parseSettingsResult({ settings: settingDtos.map((setting) => setting === enabled ? { ...setting, reloadRequired: false } : setting) }), /metadata/);
  assert.throws(() => parseSettingUpdateResult({ setting: enabled, instance: validSnapshot(), reloadRequired: false, hostRestartRequired: false }), /inconsistent/);
});

test("canonical projection ordering handles names that are prefixes of hyphenated names", () => {
  const source = { kind: "extension" as const, package: "npm:fixture", path: "/fixture/index.ts" };
  const commands = [
    { name: "chain", description: "Chain", source, argumentCompletions: true },
    { name: "chain-prompts", description: "Chain prompts", source, argumentCompletions: false },
    { name: "run", description: "Run", source, argumentCompletions: true },
    { name: "run-chain", description: "Run chain", source, argumentCompletions: true },
  ];
  assert.deepEqual(parseCommandsResult({ commands }).commands.map((command) => command.name), ["chain", "chain-prompts", "run", "run-chain"]);
  assert.throws(() => parseCommandsResult({ commands: [commands[1], commands[0]] }), /deterministically sorted/);
  assert.deepEqual(parseCommandsResult({ commands: commands.slice(0, 2), total: 4, truncated: true }), {
    commands: commands.slice(0, 2), total: 4, truncated: true,
  });
  assert.throws(() => parseCommandsResult({ commands: commands.slice(0, 2), total: 4, truncated: false }), /metadata is inconsistent/u);

  const tools = [
    { name: "run", description: "Run", active: true, source },
    { name: "run-chain", description: "Run chain", active: true, source },
  ];
  assert.deepEqual(parseToolsResult({ tools, instance: validSnapshot() }).tools.map((tool) => tool.name), ["run", "run-chain"]);

  const resources = [
    { kind: "prompt", name: "chain", path: "/fixture/chain.md", source: { kind: "prompt" } },
    { kind: "prompt", name: "chain-prompts", path: "/fixture/chain-prompts.md", source: { kind: "prompt" } },
  ];
  const diagnostics = [
    { severity: "warning", message: "run", source: "fixture" },
    { severity: "warning", message: "run-chain", source: "fixture" },
  ];
  assert.deepEqual(parseResourcesResult({ resources, diagnostics }), {
    resources,
    diagnostics,
    resourceTotal: 2,
    resourcesTruncated: false,
    diagnosticTotal: 2,
    diagnosticsTruncated: false,
  });
});

function settingDto(key: SettingKey, values: SettingValueMap): Record<string, unknown> {
  const definition = SETTING_DEFINITIONS[key];
  return { key, value: values[key], source: "effective", writable: definition.writable, valueType: definition.valueType,
    ...(definition.allowedValues ? { allowedValues: [...definition.allowedValues] } : {}),
    ...(definition.min === undefined ? {} : { min: definition.min }), ...(definition.max === undefined ? {} : { max: definition.max }),
    reloadRequired: definition.reloadRequired, hostRestartRequired: definition.hostRestartRequired };
}

test("history results are closed and pagination-consistent", () => {
  const entry = { entryId: "h2", parentId: "h1", role: "assistant", timestamp: "2026-07-14T00:00:00.000Z", content: [{ type: "text", text: "answer" }], stopReason: "stop" };
  const result = parseHistoryResult({ entries: [entry], hasEarlier: true, nextBeforeEntryId: "h2", instance: validSnapshot() });
  assert.deepEqual(result.entries[0], { ...entry, summaryKind: undefined, error: undefined });
  assert.equal(parseHistoryResult({ entries: [{ ...entry, role: "system", summaryKind: "compaction" }], hasEarlier: false, instance: validSnapshot() }).entries[0]?.summaryKind, "compaction");
  assert.throws(() => parseHistoryResult({ entries: [{ ...entry, summaryKind: "unknown" }], hasEarlier: false, instance: validSnapshot() }), /unsupported value/);
  assert.throws(() => parseHistoryResult({ entries: [entry], hasEarlier: false, nextBeforeEntryId: "h2", instance: validSnapshot() }), /cursor is inconsistent/);
  assert.throws(() => parseHistoryResult({ entries: [{ ...entry, content: [{ type: "text", text: "x", raw: true }] }], hasEarlier: false, instance: validSnapshot() }), /Unexpected field/);
});

test("session metrics are closed, finite, non-negative, and percentage-bounded", () => {
  const metrics = {
    messages: { user: 1, assistant: 2, toolCalls: 3, toolResults: 3, total: 9 },
    tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, total: 180 },
    cost: 0.01,
    context: { tokens: 900, contextWindow: 2_000, percent: 45 },
  };
  assert.deepEqual(parseStatusResult({ instance: { ...validSnapshot(), metrics } }).instance.metrics, metrics);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), metrics: { ...metrics, cost: -1 } } }), /non-negative/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), metrics: { ...metrics, context: { ...metrics.context, percent: 101 } } } }), /between 0 and 100/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), metrics: { ...metrics, raw: true } } }), /Unexpected field/);
});

test("abort result is closed and cannot claim a still-running instance", () => {
  const idle = validSnapshot();
  assert.equal(parseAbortResult({ instance: idle }).instance.execution, "idle");
  assert.throws(() => parseAbortResult({ instance: { ...idle, execution: "running", activeCommandId: "run-1" } }), /must not still be running/);
  assert.throws(() => parseAbortResult({ instance: idle, extra: true }), /Unexpected field/);
});

test("prompt receipts distinguish immediate extension commands from the running parent", () => {
  const instance = { ...validSnapshot(), execution: "running", activeCommandId: "parent-op" };
  const extensionReceipt = {
    accepted: true,
    instanceId: "i1",
    operationId: "extension-op",
    kind: "extension_command",
    delivery: "prompt",
    queued: false,
    acceptedAt: "2026-07-14T00:00:01.000Z",
  };
  assert.equal(parsePromptResult({ receipt: extensionReceipt, instance }).receipt.kind, "extension_command");
  assert.throws(() => parsePromptResult({ receipt: { ...extensionReceipt, kind: "prompt" }, instance }), /does not match instance state/);
  assert.throws(() => parsePromptResult({ receipt: { ...extensionReceipt, delivery: "steer" }, instance }), /must be immediate prompt delivery/);
  assert.throws(() => parsePromptResult({ receipt: { ...extensionReceipt, queued: true }, instance }), /must be immediate prompt delivery/);
  const { kind: _kind, ...missingKind } = extensionReceipt;
  assert.throws(() => parsePromptResult({ receipt: missingKind, instance }), /unsupported value/);
});

test("queue pending and dequeue DTOs are closed, bounded, and count-consistent", () => {
  const pending = {
    queueItemId: "queue-1",
    operationId: "queue-op",
    delivery: "steer",
    text: "change direction",
    acceptedAt: "2026-07-14T00:00:00.000Z",
  };
  const parsed = parseQueueDequeueResult({
    receipt: { operationId: "dequeue-op", instanceId: "i1", restored: [pending], inFlight: [] },
    instance: validSnapshot(),
  });
  assert.deepEqual(parsed.receipt.restored, [pending]);
  assert.throws(() => parseQueueDequeueResult({
    receipt: { operationId: "dequeue-op", instanceId: "other", restored: [pending], inFlight: [] },
    instance: validSnapshot(),
  }), /does not match instance/);
  assert.throws(() => parseQueueDequeueResult({
    receipt: { operationId: "dequeue-op", instanceId: "i1", restored: [{ ...pending, payload: true }], inFlight: [] },
    instance: validSnapshot(),
  }), /Unexpected field/);
  assert.throws(() => parseQueueDequeueResult({
    receipt: { operationId: "dequeue-op", instanceId: "i1", restored: [{ ...pending, text: "unsafe\u001b[2J" }], inFlight: [] },
    instance: validSnapshot(),
  }), /terminal control/);

  const queued = parseControlEventEnvelope({
    kind: "event", version: 2, requestId: "stream-1", hostEpoch: "epoch-1",
    event: validEvent("message.queued", pending),
  }, "stream-1", "epoch-1");
  assert.equal(queued.event.type, "message.queued");
  assert.throws(() => parseControlEventEnvelope({
    kind: "event", version: 2, requestId: "stream-1", hostEpoch: "epoch-1",
    event: validEvent("message.submitted", { operationId: "queue-op", messageId: "user-queue-op", role: "user", text: "consumed", delivery: "steer" }),
  }, "stream-1", "epoch-1"), /queueItemId/);
  assert.throws(() => parseControlEventEnvelope({
    kind: "event", version: 2, requestId: "stream-1", hostEpoch: "epoch-1",
    event: validEvent("queue.cleared", { steering: 1, followUp: 0, total: 1, queueItemIds: ["queue-1"], reason: "unknown" }),
  }, "stream-1", "epoch-1"), /unsupported value/);
});

test("host info accepts only the closed healthy and mutation-drain states", () => {
  const base = {
    host: { pid: 1, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "epoch-1", startedAt: "2026-07-14T00:00:00.000Z" },
    catalog: { schemaVersion: 1, revision: 2, lastReconciledAt: "2026-07-14T00:00:00.000Z" },
    paths: { socket: "/tmp/dock.sock", state: "memory:/tmp/dock.sock" },
    diagnostics: [],
  };
  assert.equal(parseHostInfoResult({ ...base, state: "ready" }).state, "ready");
  assert.equal(parseHostInfoResult({ ...base, state: "mutation_faulted" }).state, "mutation_faulted");
  assert.equal(parseHostInfoResult({ ...base, state: "draining" }).state, "draining");
  assert.throws(() => parseHostInfoResult({ ...base, state: "writable" }), /state/);
  assert.throws(() => parseHostInfoResult({ ...base, state: "ready", catalog: { ...base.catalog, schemaVersion: 2 } }), /schema is incompatible/);
});

test("model persistence and session list results are closed", () => {
  assert.deepEqual(parseModelConfigurationResult({ instance: validSnapshot(), settingsWrite: { persisted: true } }).settingsWrite, { persisted: true });
  assert.throws(() => parseModelConfigurationResult({ instance: validSnapshot(), settingsWrite: { persisted: false } }), /must be true/);
  assert.deepEqual(parseSessionsResult({ sessions: [{ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp", updatedAt: "2026-07-14T00:00:00.000Z" }] }).sessions[0], {
    sessionId: "s1", sessionFile: "/tmp/s1.jsonl", name: undefined, cwd: "/tmp", updatedAt: "2026-07-14T00:00:00.000Z",
  });
  assert.throws(() => parseSessionsResult({ sessions: [{ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp", raw: true }] }), /Unexpected field/);
  assert.throws(() => parseSessionsResult({ sessions: [
    { sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp" },
    { sessionId: "s1", sessionFile: "/tmp/s2.jsonl", cwd: "/tmp" },
  ] }), /Session IDs must be unique/);
  assert.throws(() => parseSessionsResult({ sessions: [
    { sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp" },
    { sessionId: "s2", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp" },
  ] }), /Session files must be unique/);
  assert.deepEqual(parseSessionInventoryResult({
    sessions: [{ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp" }],
    query: { cwd: "/tmp", scope: "all" }, total: 2, truncated: true,
  }), {
    sessions: [{ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", name: undefined, cwd: "/tmp", updatedAt: undefined }],
    query: { cwd: "/tmp", scope: "all" }, total: 2, truncated: true,
    incomplete: false, diagnostics: [], diagnosticsTruncated: false,
  });
  assert.deepEqual(parseSessionInventoryResult({
    sessions: [], query: { cwd: "/tmp", scope: "all" }, total: 0, truncated: false,
    incomplete: true,
    diagnostics: [{ message: "Could not read one session", path: "/tmp/broken.jsonl" }],
    diagnosticsTruncated: false,
  }).diagnostics, [{ message: "Could not read one session", path: "/tmp/broken.jsonl" }]);
  assert.throws(() => parseSessionInventoryResult({ sessions: [], query: { cwd: "/tmp", scope: "all" }, total: 2, truncated: false }), /truncation metadata/);
  assert.throws(() => parseSessionInventoryResult({
    sessions: [], query: { cwd: "/tmp", scope: "all" }, total: 0, truncated: false,
    incomplete: false, diagnostics: [{ message: "hidden failure" }], diagnosticsTruncated: false,
  }), /Complete session inventory/u);
});

test("response, snapshot, replay, and event parsers reject open or inconsistent DTOs", () => {
  const trustResponse = parseControlResponse({
    kind: "response", version: 2, requestId: "r1", hostEpoch: "epoch-1", ok: false,
    error: {
      code: "project_trust_required", message: "Project trust decision required", retryable: false,
      details: {
        challengeId: "challenge-1", operationId: "operation-1", cwd: "/tmp/project",
        choices: ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"],
        expiresAt: "2026-07-14T00:01:00.000Z",
      },
    },
  }, "r1", "epoch-1");
  assert.equal(trustResponse.ok, false);
  if (trustResponse.ok) assert.fail("Expected trust error response");
  assert.equal(trustResponse.error.details?.challengeId, "challenge-1");
  const expiredReceipt = parseControlResponse({
    kind: "response", version: 2, requestId: "r1", hostEpoch: "epoch-1", ok: false,
    error: {
      code: "operation_receipt_expired", message: "receipt expired", retryable: false,
      details: { operationId: "operation-1", queryHint: "Query current state; do not retry this operation ID" },
    },
  }, "r1", "epoch-1");
  assert.equal(expiredReceipt.ok, false);
  if (expiredReceipt.ok) assert.fail("Expected expired receipt response");
  assert.equal(expiredReceipt.error.details?.operationId, "operation-1");
  assert.throws(() => parseControlResponse({
    kind: "response", version: 2, requestId: "r1", hostEpoch: "epoch-1", ok: false,
    error: {
      code: "project_trust_required", message: "missing", retryable: false,
      details: {
        challengeId: "challenge-1", operationId: "operation-1", cwd: "/tmp/project",
        choices: ["trust_once", "trust_once"], expiresAt: "2026-07-14T00:01:00.000Z",
      },
    },
  }, "r1", "epoch-1"), /incomplete or duplicated/);
  assert.throws(() => parseControlResponse({ kind: "response", version: 2, requestId: "r1", hostEpoch: "epoch-1", ok: false, error: { code: "project_trust_required", message: "missing", retryable: false, details: { arbitrary: true } } }, "r1", "epoch-1"), /Unexpected field/);
  assert.throws(() => parseControlResponse({ kind: "response", version: 2, requestId: "r1", hostEpoch: "epoch-1", ok: false, error: { code: "not_found", message: "missing", retryable: false, details: { arbitrary: true } } }, "r1", "epoch-1"), /does not allow details/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), extra: true } }), /Unexpected field/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), pending: { steering: 1, followUp: 1, total: 1 } } }), /total is inconsistent/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), lifecycle: "stopped", execution: "idle", ownerHostEpoch: undefined } }), /Lifecycle\/execution/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), compacting: true } }), /compacting requires running/);
  assert.equal(parseStatusResult({ instance: { ...validSnapshot(), execution: "running", compacting: true } }).instance.compacting, true);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), eventCursor: { hostEpoch: "epoch-1", instanceId: "other", runtimeGeneration: 1, sequence: 1 } } }), /cursor domain/);

  const envelope = (event: unknown): Record<string, unknown> => ({ kind: "event", version: 2, requestId: "attach-1", hostEpoch: "epoch-1", event });
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("message.delta", { messageId: "m1", delta: "missing block" })), "attach-1", "epoch-1"), /block/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("message.delta", { messageId: "m1", block: "text", delta: "x", extra: true })), "attach-1", "epoch-1"), /Unexpected field/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("future.unknown", {})), "attach-1", "epoch-1"), /Unsupported event type/);

  assert.throws(() => parseEventsResult({
    instance: validSnapshot(),
    page: { events: [validEvent()], earliest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, latest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, truncated: false, epochChanged: false, generationChanged: false },
    recentHistory: [], historyTruncated: true, pendingMessages: [], controller: { status: "observing" }, following: false, extra: true,
  }), /Unexpected field/);
  assert.throws(() => parseEventsResult({
    instance: validSnapshot(),
    page: { events: [{ ...validEvent(), instanceId: "other" }], earliest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, latest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, truncated: false, epochChanged: false, generationChanged: false },
    recentHistory: [], historyTruncated: true, pendingMessages: [], controller: { status: "observing" }, following: false,
  }), /cursor domain\/order/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("settings.changed", { key: "unknown", value: true, reloadRequired: false, hostRestartRequired: false })), "attach-1", "epoch-1"), /Unsupported setting key/);
});
