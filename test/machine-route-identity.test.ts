import assert from "node:assert/strict";
import test from "node:test";

import { parseControlRequest } from "../src/control/protocol.js";
import { recordForMainHost, requestForNativeHost } from "../src/control/machine-route-identity.js";

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


test("routed child creation preserves global parent identity and policy through the real request codec", () => {
  const request = parseControlRequest({ kind: "request", version: 2, requestId: "child-create", type: "instance.create", params: {
    operationId: "child-operation", cwd: "/workspace/project", hostId: "machine-1", parentId: "global-parent",
    workerConfig: { toolPolicy: { allowedTools: ["read", "dock_send"] }, collaboration: { parentId: "global-parent", parentName: "Coordinator" } },
  } });
  const wire = JSON.parse(JSON.stringify(requestForNativeHost(request, undefined)));
  const native = parseControlRequest(wire);
  assert.equal(native.type, "instance.create");
  if (native.type !== "instance.create") assert.fail("expected create");
  assert.equal(native.params.hostId, undefined);
  assert.equal(native.params.parentId, "global-parent");
  assert.equal(native.params.operationId, "child-operation");
  assert.deepEqual(native.params.workerConfig, { toolPolicy: { allowedTools: ["read", "dock_send"] }, collaboration: { parentId: "global-parent", parentName: "Coordinator" } });
});
