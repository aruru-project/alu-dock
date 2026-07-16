import assert from "node:assert/strict";
import test from "node:test";

import {
  piToolResultNormalizerExtension,
  subagentDetailsContainFailure,
} from "../src/pi/pi-tool-result-normalizer.js";

test("subagent result normalization follows bounded child failure evidence", () => {
  assert.equal(subagentDetailsContainFailure({ mode: "single", results: [{ exitCode: 0 }] }), false);
  assert.equal(subagentDetailsContainFailure({ mode: "single", results: [{ exitCode: 1 }] }), true);
  assert.equal(subagentDetailsContainFailure({ mode: "parallel", results: [{ exitCode: 0 }, { timedOut: true }] }), true);
  assert.equal(subagentDetailsContainFailure({ mode: "chain", results: [{ exitCode: 0, children: [{ state: "failed" }] }] }), false);
  assert.equal(subagentDetailsContainFailure({ mode: "single", timedOut: true, results: [] }), true);
  assert.equal(subagentDetailsContainFailure({ mode: "management", results: [] }), false);
  assert.equal(subagentDetailsContainFailure({ results: Array(10_000) }), true, "oversized sparse telemetry must fail closed in bounded time");
  assert.equal(subagentDetailsContainFailure({ results: [null, 7, "failure", { exitCode: 0 }] }), false);

  let reads = 0;
  const growingResults: unknown[] = [];
  Object.defineProperty(growingResults, 0, {
    configurable: true,
    get: () => {
      reads += 1;
      growingResults.length = 10_000;
      return { exitCode: 0 };
    },
  });
  growingResults.length = 1;
  assert.equal(subagentDetailsContainFailure({ results: growingResults }), false);
  assert.equal(reads, 1, "the inspected result count must be captured before getters can grow it");

  const hostileDetails = new Proxy({}, { get: () => { throw new Error("hostile getter"); } });
  assert.equal(subagentDetailsContainFailure(hostileDetails), true, "malformed telemetry must fail closed without throwing");
});

test("inline Pi hook marks only failed subagent completions as errors", () => {
  let handler: ((event: Record<string, unknown>) => unknown) | undefined;
  piToolResultNormalizerExtension({
    on: (event: string, next: (value: Record<string, unknown>) => unknown) => {
      assert.equal(event, "tool_result");
      handler = next;
    },
  } as never);
  assert.ok(handler);

  assert.deepEqual(handler!({
    toolName: "subagent",
    isError: false,
    details: { mode: "single", results: [{ exitCode: 7 }] },
  }), { isError: true });
  assert.equal(handler!({
    toolName: "subagent",
    isError: false,
    details: { mode: "single", results: [{ exitCode: 0 }] },
  }), undefined);
  assert.equal(handler!({
    toolName: "read",
    isError: false,
    details: { results: [{ exitCode: 1 }] },
  }), undefined);
  assert.equal(handler!({
    toolName: "subagent",
    isError: true,
    details: { results: [{ exitCode: 1 }] },
  }), undefined);
});
