import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerToolPolicy, workerToolSelection } from "../src/pi/worker-tool-policy.js";

test("a worker's tool grant means exact capabilities, including an empty grant", () => {
  assert.equal(parseWorkerToolPolicy(undefined), undefined);
  assert.deepEqual(parseWorkerToolPolicy({ allowedTools: [] }), { allowedTools: [] });
  const names = ["read", "mcp__github__search"];
  const policy = parseWorkerToolPolicy({ allowedTools: names });
  names.push("write");
  assert.deepEqual(policy, { allowedTools: ["read", "mcp__github__search"] });
  // A permission ceiling must not become Pi's additive tool selection or a wildcard grant.
  for (const allowedTools of [["+write"], ["-read"], ["mcp__*"], ["read", "read"], [""]]) {
    assert.throws(() => parseWorkerToolPolicy({ allowedTools }));
  }
  for (const value of [null, [], "read", { allowedTools: "read" }, { allowedTools: [], unrestricted: true }]) {
    assert.throws(() => parseWorkerToolPolicy(value));
  }
  assert.deepEqual(workerToolSelection(undefined, undefined), {});
  assert.deepEqual(workerToolSelection({ allowedTools: ["read", "read_mcp_resource"] }, ["bash"]), {
    tools: ["read", "read_mcp_resource"],
    excludeTools: ["bash", "mcp__*", "list_mcp_resources", "list_mcp_resource_templates"],
  });
  assert.deepEqual(workerToolSelection({ allowedTools: ["read", "mcp__github__search"] }, undefined), {
    tools: ["read", "mcp__github__search"], excludeTools: [],
  });
});
