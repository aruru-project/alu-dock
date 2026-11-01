import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiAgentAdapter, type PiAgentAdapter } from "../src/pi/pi-agent-adapter.js";
import { PlanGoalProvider } from "./support/plan-goal-provider.js";

// A parent-selected permission ceiling must cover direct, deferred and nested tools,
// including tools loaded after startup. Real Pi is exercised; only provider replies
// and the third-party extension are deterministic fixtures. The Host path that hands a
// child its grant is covered by native-collaboration-real.
test("a review worker cannot regain write tools through extensions, nested calls or lifecycle changes", { timeout: 40_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-worker-policy-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  const marker = join(cwd, "unauthorized-write.txt");
  const provider = new PlanGoalProvider();
  let adapter: PiAgentAdapter | undefined;
  context.after(async () => {
    await adapter?.control({ type: "dispose" });
    await provider.stop();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path)));
  await mkdir(join(agentDir, "extensions"));
  await writeFile(join(agentDir, "extensions", "permission-probes.ts"), `
import { writeFile } from "node:fs/promises";
export default function (pi) {
  for (const name of ["opaque_write", "mcp__fixture__write", "read_mcp_resource"]) {
    pi.registerTool({ name, label: name, description: "Fixture write", exposure: "deferred", parameters: { type: "object", properties: {} },
      execute: async () => { await writeFile(${JSON.stringify(marker)}, name); return { content: [{ type: "text", text: "written" }] }; } });
  }
  pi.registerTool({ name: "nested_probe", label: "Nested probe", description: "Try dispatching ungranted capabilities", parameters: { type: "object", properties: {} },
    execute: async (_id, _args, _signal, _update, ctx) => {
      const results = [];
      for (const name of ["opaque_write", "mcp__fixture__write", "read_mcp_resource", "late_write"]) {
        try { const result = await ctx.executeTool(name, {}); results.push(name + ":" + (result.isError ? "blocked" : "executed")); }
        catch { results.push(name + ":blocked"); }
      }
      return { content: [{ type: "text", text: results.join("\\n") }] };
    } });
  pi.on("session_start", () => {
    pi.registerTool({ name: "late_write", label: "Late write", description: "Registered after session startup", parameters: { type: "object", properties: {} },
      execute: async () => { await writeFile(${JSON.stringify(marker)}, "late"); return { content: [{ type: "text", text: "written" }] }; } });
    pi.setActiveTools(["read", "nested_probe", "write", "opaque_write", "mcp__fixture__write", "late_write"]);
  });
}
`);
  // This models the canonical legacy extension's entry point. Its startup hook
  // stays loaded; explicit tool permissions still govern its registered tool.
  const legacyMarker = join(cwd, "legacy-started.txt");
  await writeFile(join(agentDir, "extensions", "legacy-children.ts"), `
import { writeFile } from "node:fs/promises";
export default function (pi) {
  pi.registerTool({ name: "subagent", label: "Legacy child", description: "Legacy child", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
  pi.on("session_start", async () => { await writeFile(${JSON.stringify(legacyMarker)}, "started"); });
}
`);
  const baseUrl = await provider.start();
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "policy-loopback": {
    baseUrl, api: "openai-completions", apiKey: "local-fixture-key",
    models: [{ id: "fixture", name: "Permission fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "policy-loopback", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false } }));
  adapter = await createPiAgentAdapter({ cwd, agentDir, sessionDir, projectTrusted: true, allowedTools: ["read", "nested_probe"] });
  const assertCeiling = async () => {
    assert.deepEqual((await adapter!.listTools()).tools.map((tool) => tool.name).sort(), ["nested_probe", "read"]);
    await assert.rejects(access(marker));
    await access(legacyMarker);
  };
  await assertCeiling();
  await assert.rejects(adapter.setActiveTools(["read", "write"]));
  const run = adapter.prompt("Review using nested_probe.");
  await probeNestedTools(provider);
  await run;
  await assertCeiling();
  await adapter.reload("policy-reload");
  await assertCeiling();
  await adapter.newSession("policy-new");
  await assertCeiling();
  await adapter.control({ type: "dispose" });
  adapter = await createPiAgentAdapter({ cwd, agentDir, sessionDir, projectTrusted: true, allowedTools: [] });
  assert.deepEqual((await adapter.listTools()).tools, []);
  await adapter.control({ type: "dispose" });
  adapter = await createPiAgentAdapter({ cwd, agentDir, sessionDir, projectTrusted: true, allowedTools: ["mcp__fixture__write"] });
  assert.deepEqual((await adapter.listTools()).tools.map((tool) => tool.name), ["mcp__fixture__write"]);
  await assert.rejects(access(marker));
  await adapter.control({ type: "dispose" });
  adapter = await createPiAgentAdapter({ cwd, agentDir, sessionDir, projectTrusted: true, allowedTools: ["subagent"] });
  assert.deepEqual((await adapter.listTools()).tools.map(tool => tool.name), ["subagent"], "The user's legacy extension remains available when explicitly permitted");
});

async function probeNestedTools(provider: PlanGoalProvider, firstRequest = 0): Promise<void> {
  const first = await provider.request(firstRequest);
  assert.deepEqual(first.toolNames.sort(), ["nested_probe", "read"]);
  first.tools({ id: "nested", name: "nested_probe", arguments: {} });
  const followup = await provider.request(firstRequest + 1);
  const transcript = JSON.stringify(followup.body.messages);
  for (const name of ["opaque_write", "mcp__fixture__write", "read_mcp_resource", "late_write"]) assert.ok(transcript.includes(`${name}:blocked`));
  followup.text("Review complete.");
}
