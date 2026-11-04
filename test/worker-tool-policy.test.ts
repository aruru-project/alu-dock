import assert from "node:assert/strict";
import test from "node:test";
import { parseAllowedTools } from "../src/core/worker-tool-policy.js";

test("a child's tool grant means exact capabilities, including an empty grant", () => {
  assert.deepEqual(parseAllowedTools([]), []);
  assert.deepEqual(parseAllowedTools(["read", "mcp__github__search"]), ["read", "mcp__github__search"]);
  // Security boundary: a ceiling must not become Pi's additive tool selection or a wildcard grant.
  for (const value of [["+write"], ["-read"], ["mcp__*"], ["read", "read"], [""], null, "read", { allowedTools: [] }]) {
    assert.throws(() => parseAllowedTools(value));
  }
});
