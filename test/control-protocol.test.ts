import assert from "node:assert/strict";
import test from "node:test";

import { JsonLineDecoder, JsonLineError } from "../src/control/json-lines.js";
import {
  parseClientHello,
  parseControlEventEnvelope,
  parseControlRequest,
  parseControlResponse,
  parseEventsResult,
  parseHostInfoResult,
  parseModelConfigurationResult,
  parseSessionsResult,
  parseStatusResult,
  parseToolsResult,
  parseSettingsResult,
  parseSettingUpdateResult,
  parseResourcesResult,
  parseCommandsResult,
  ProtocolValidationError,
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
    lifecycle: "active", execution: "idle", lastRun: "never", reopenable: false,
    runtimeGeneration: 1, ownerHostEpoch: "epoch-1",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: "fixture", piSessionId: "pi-1" }, extensionStatus: {},
    createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 },
  };
}

function validEvent(type = "message.delta", data: Record<string, unknown> = { messageId: "m1", block: "text", delta: "hello" }): Record<string, unknown> {
  return { scope: "instance", sequence: 1, instanceId: "i1", runtimeGeneration: 1, occurredAt: "2026-07-14T00:00:00.000Z", type, data };
}

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
  assert.deepEqual(parseControlRequest({ ...base, type: "session.list", params: { instanceId: "i1", scope: "all" } }), {
    ...base, type: "session.list", params: { instanceId: "i1", scope: "all" },
  });
  assert.throws(() => parseControlRequest({ ...base, type: "session.list", params: { instanceId: "i1", scope: "project" } }), /unsupported value/);

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

test("Stage 1C projection requests are closed and setting updates are discriminated", () => {
  const base = { kind: "request", version: 2, requestId: "projection-r" };
  assert.deepEqual(parseControlRequest({ ...base, type: "tool.set_active", params: { operationId: "op", instanceId: "i1", names: ["read", "write"] } }).params, { operationId: "op", instanceId: "i1", names: ["read", "write"] });
  assert.throws(() => parseControlRequest({ ...base, type: "tool.set_active", params: { operationId: "op", instanceId: "i1", names: ["read", "read"] } }), /must be unique/);
  assert.throws(() => parseControlRequest({ ...base, type: "settings.update", params: { operationId: "op", instanceId: "i1", update: { key: "editorPaddingX", value: 4 } } }), /out of range/);
  assert.throws(() => parseControlRequest({ ...base, type: "settings.update", params: { operationId: "op", instanceId: "i1", update: { key: "warnings", value: { token: true } } } }), /Unexpected field/);
  assert.throws(() => parseControlRequest({ ...base, type: "settings.update", params: { operationId: "op", instanceId: "i1", update: { key: "proxy", value: true } } }), /Unsupported setting key/);
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

  const values: SettingValueMap = { autoCompaction: true, autoRetry: true, enableSkillCommands: true, hideThinking: false, showCacheMissNotices: false, showHardwareCursor: false, clearOnShrink: true, showTerminalProgress: true, quietStartup: false, steeringMode: "all", followUpMode: "all", transport: "auto", doubleEscapeAction: "tree", treeFilterMode: "default", defaultProjectTrust: "ask", httpIdleTimeoutMs: 0, editorPaddingX: 0, outputPad: 0, autocompleteMaxVisible: 10, warnings: {} };
  const settingDtos = SETTING_KEYS.map((key) => settingDto(key, values));
  assert.equal(parseSettingsResult({ settings: settingDtos }).settings.length, 20);
  assert.throws(() => parseSettingsResult({ settings: settingDtos.slice(1) }), /all 20 keys/);
  const enabled = settingDtos.find((setting) => setting.key === "enableSkillCommands");
  assert.throws(() => parseSettingsResult({ settings: settingDtos.map((setting) => setting === enabled ? { ...setting, reloadRequired: false } : setting) }), /metadata/);
  assert.throws(() => parseSettingUpdateResult({ setting: enabled, instance: validSnapshot(), reloadRequired: false, hostRestartRequired: false }), /inconsistent/);
});

function settingDto(key: SettingKey, values: SettingValueMap): Record<string, unknown> {
  const definition = SETTING_DEFINITIONS[key];
  return { key, value: values[key], source: "effective", writable: true, valueType: definition.valueType,
    ...(definition.allowedValues ? { allowedValues: [...definition.allowedValues] } : {}),
    ...(definition.min === undefined ? {} : { min: definition.min }), ...(definition.max === undefined ? {} : { max: definition.max }),
    reloadRequired: definition.reloadRequired, hostRestartRequired: definition.hostRestartRequired };
}

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
});

test("model persistence and session list results are closed", () => {
  assert.deepEqual(parseModelConfigurationResult({ instance: validSnapshot(), settingsWrite: { persisted: true } }).settingsWrite, { persisted: true });
  assert.throws(() => parseModelConfigurationResult({ instance: validSnapshot(), settingsWrite: { persisted: false } }), /must be true/);
  assert.deepEqual(parseSessionsResult({ sessions: [{ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp", updatedAt: "2026-07-14T00:00:00.000Z" }] }).sessions[0], {
    sessionId: "s1", sessionFile: "/tmp/s1.jsonl", name: undefined, cwd: "/tmp", updatedAt: "2026-07-14T00:00:00.000Z",
  });
  assert.throws(() => parseSessionsResult({ sessions: [{ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp", raw: true }] }), /Unexpected field/);
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
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), eventCursor: { hostEpoch: "epoch-1", instanceId: "other", runtimeGeneration: 1, sequence: 1 } } }), /cursor domain/);

  const envelope = (event: unknown): Record<string, unknown> => ({ kind: "event", version: 2, requestId: "attach-1", hostEpoch: "epoch-1", event });
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("message.delta", { messageId: "m1", delta: "missing block" })), "attach-1", "epoch-1"), /block/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("message.delta", { messageId: "m1", block: "text", delta: "x", extra: true })), "attach-1", "epoch-1"), /Unexpected field/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("future.unknown", {})), "attach-1", "epoch-1"), /Unsupported event type/);

  assert.throws(() => parseEventsResult({
    instance: validSnapshot(),
    page: { events: [validEvent()], earliest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, latest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, truncated: false, epochChanged: false, generationChanged: false },
    recentHistory: [], historyTruncated: true, controller: { status: "observing" }, following: false, extra: true,
  }), /Unexpected field/);
  assert.throws(() => parseEventsResult({
    instance: validSnapshot(),
    page: { events: [{ ...validEvent(), instanceId: "other" }], earliest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, latest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, truncated: false, epochChanged: false, generationChanged: false },
    recentHistory: [], historyTruncated: true, controller: { status: "observing" }, following: false,
  }), /cursor domain\/order/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("settings.changed", { key: "unknown", value: true, reloadRequired: false, hostRestartRequired: false })), "attach-1", "epoch-1"), /Unsupported setting key/);
});
