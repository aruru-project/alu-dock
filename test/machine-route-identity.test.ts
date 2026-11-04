import assert from "node:assert/strict";
import test from "node:test";

import { recordForMainHost } from "../src/control/machine-route-identity.js";

const route = { hostId: "machine-1", mainInstanceId: "main-instance", nativeInstanceId: "native-instance", mainHostEpoch: "main-epoch", nativeHostEpoch: "native-epoch" };

test("machine identity projection leaves Agent event data and error details byte-for-byte semantic", () => {
  const args = { instanceId: "native-instance", hostEpoch: "native-epoch", nested: { id: "native-instance" } };
  const event = {
    kind: "event", version: 2, requestId: "r", hostEpoch: "native-epoch",
    event: { scope: "instance", sequence: 2, instanceId: "native-instance", runtimeGeneration: 1, occurredAt: "2026-08-21T00:00:00.000Z", type: "tool.execution_start", data: { toolCallId: "c", toolName: "fixture", args } },
  };
  const mapped = recordForMainHost(event, route) as typeof event;
  assert.equal(mapped.hostEpoch, "main-epoch");
  assert.equal(mapped.event.instanceId, "main-instance");
  assert.deepEqual(mapped.event.data.args, args);

  const error = { kind: "response", version: 2, requestId: "r", hostEpoch: "native-epoch", ok: false, error: { code: "request_failed", message: "failed", retryable: false, details: args } };
  const mappedError = recordForMainHost(error, route) as typeof error;
  assert.equal(mappedError.hostEpoch, "main-epoch");
  assert.deepEqual(mappedError.error.details, args);
});
