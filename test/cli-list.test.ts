import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_HUMAN_LIST_INSTANCES,
  renderHumanInstanceList,
  selectHumanInstanceList,
  terminalDisplayWidth,
} from "../src/cli-list.js";
import type { InstanceSnapshot } from "../src/core/managed-instance.js";

test("human list has an actionable empty state", () => {
  assert.equal(
    renderHumanInstanceList([], 80),
    "No Alu Dock instances.\nStart one: alu-dock new\n",
  );
});

test("human list default selection hides only stopped history and reports how to reveal it", () => {
  const active = instance(1);
  const lost = instance(2, { lifecycle: "host_lost", execution: "unavailable", ownerHostEpoch: undefined, reopenable: true });
  const failed = instance(3, { lifecycle: "runtime_error", execution: "unavailable", ownerHostEpoch: undefined });
  const stopped = instance(4, { lifecycle: "stopped", execution: "unavailable", ownerHostEpoch: undefined });
  const selected = selectHumanInstanceList([stopped, failed, lost, active], false);
  assert.deepEqual(selected.instances.map((item) => item.id), [failed.id, lost.id, active.id]);
  assert.equal(selected.hiddenStopped, 1);
  const output = renderHumanInstanceList(selected.instances, 80, { mode: "actionable", hiddenStopped: selected.hiddenStopped });
  assert.match(output, /Alu Dock actionable · 3 · 1 stopped hidden/u);
  assert.match(output, /History: alu-dock list --all/u);
  assert.doesNotMatch(output, new RegExp(stopped.id.slice(0, 8), "u"));

  const empty = renderHumanInstanceList([], 43, { mode: "actionable", hiddenStopped: 25 });
  assert.match(empty, /No actionable Alu Dock instances/u);
  assert.match(empty, /25 stopped hidden/u);
  assert.match(empty, /list --all/u);
  assert.equal(selectHumanInstanceList([stopped], true).hiddenStopped, 0);
});

test("human list orders decision-relevant state and omits machine-only snapshot fields", () => {
  const running = instance(1, {
    name: "active\u001b[2J\nrun",
    lifecycle: "active",
    execution: "running",
    pending: { steering: 1, followUp: 1, total: 2 },
    runtimeGeneration: 7,
    executor: {
      kind: "pi-sdk",
      piSessionId: "secret-pi-running",
      sessionFile: "/secret/session-running.jsonl",
      model: { provider: "openai-codex", id: "gpt-test" },
    },
  });
  const idle = instance(2, { name: "idle", lifecycle: "active", execution: "idle" });
  const recoverable = instance(3, {
    name: "recover me",
    lifecycle: "host_lost",
    execution: "unavailable",
    reopenable: true,
  });
  const stopped = instance(4, { name: "old", lifecycle: "stopped", execution: "unavailable" });
  const output = renderHumanInstanceList([stopped, recoverable, idle, running], 120);

  assert.ok(output.indexOf(running.id.slice(0, 8)) < output.indexOf(idle.id.slice(0, 8)));
  assert.ok(output.indexOf(idle.id.slice(0, 8)) < output.indexOf(recoverable.id.slice(0, 8)));
  assert.ok(output.indexOf(recoverable.id.slice(0, 8)) < output.indexOf(stopped.id.slice(0, 8)));
  for (const expected of [
    "active [2J run", "active/running", "g7", "openai-codex/gpt-test", "pending 2",
    "host_lost/unavailable", "reopenable", "/workspace/project-1",
  ]) assert.match(output, new RegExp(escapeRegExp(expected), "u"));
  assert.doesNotMatch(output, /\u001b/u);
  for (const secret of [
    "creation-operation-secret", "secret-pi-running", "session-running.jsonl",
    "epoch-secret", "entry-secret", "999999", "eventCursor", "metrics",
  ]) assert.doesNotMatch(output, new RegExp(escapeRegExp(secret), "u"));
});

test("human list is terminal-safe and display-width bounded at narrow and wide sizes", () => {
  const unsafe = instance(5, {
    name: "中文名称很长\u0000\u009b\u202e safe tail",
    cwd: "/workspace/项目/非常长的目录/with spaces/and-more-components",
    runtimeGeneration: 123,
    executor: {
      kind: "pi-sdk",
      piSessionId: "pi-unsafe",
      model: { provider: "提供商", id: "模型-😀-very-long-name" },
    },
  });
  for (const width of [32, 43, 80, 120]) {
    const output = renderHumanInstanceList([unsafe], width);
    assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    for (const line of output.trimEnd().split("\n")) assert.ok(terminalDisplayWidth(line) <= width, `${width}: ${line}`);
    assert.match(output, new RegExp(unsafe.id.slice(0, width < 40 ? 6 : 8), "u"));
    assert.match(output, /active\/idle/u);
    assert.match(output, /g123/u);
    assert.match(output, /中文/u);
  }
  assert.equal(terminalDisplayWidth("中文"), 4);
  assert.equal(terminalDisplayWidth("e\u0301"), 1);
  assert.equal(terminalDisplayWidth("😀"), 2);
});

test("human list caps large catalogs and reports omitted records", () => {
  const instances = Array.from({ length: 150 }, (_, index) => instance(index + 10, {
    id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
    name: `historical ${index}`,
    lifecycle: "stopped",
    execution: "unavailable",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const output = renderHumanInstanceList(instances, 80);
  const projectedRecords = output.split("\n").filter((line) => /^○ /u.test(line));
  assert.equal(projectedRecords.length, MAX_HUMAN_LIST_INSTANCES);
  assert.match(output, /Showing 100 of 150 · 50 older records omitted/u);
  assert.ok(output.split("\n").length <= 207);
  assert.match(projectedRecords[0] ?? "", /00000149/u);
  assert.doesNotMatch(output, /historical 0(?:\n|$)/u);
});

function instance(index: number, overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  return {
    id: `dock${String(index).padStart(4, "0")}-0000-4000-8000-000000000000`,
    creationOperationId: `creation-operation-secret-${index}`,
    name: `instance ${index}`,
    cwd: `/workspace/project-${index}`,
    lifecycle: "active",
    execution: "idle",
    lastRun: "never",
    reopenable: false,
    runtimeGeneration: 1,
    ownerHostEpoch: "epoch-secret",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: {
      kind: "pi-sdk",
      piSessionId: `pi-secret-${index}`,
      sessionFile: `/secret/session-${index}.jsonl`,
      model: { provider: "fixture", id: "default" },
    },
    metrics: {
      messages: { user: 1, assistant: 1, toolCalls: 0, toolResults: 0, total: 2 },
      tokens: { input: 999_999, output: 1, cacheRead: 0, cacheWrite: 0, total: 1_000_000 },
      cost: 999_999,
    },
    extensionStatus: { secret: "entry-secret" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    eventCursor: {
      hostEpoch: "epoch-secret",
      instanceId: `dock${index}`,
      runtimeGeneration: 1,
      sequence: 999_999,
    },
    ...overrides,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
