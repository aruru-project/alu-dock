import { parseDockToolsRequest } from "../src/core/dock-tools-codec.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constrainDelegatedTools } from "../src/control/delegation-tool-policy.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { DockHost } from "../src/control/dock-host.js";
import { MainMachineDockToolsPort, type MainMachineDockToolsAuthority } from "../src/control/main-machine-dock-tools.js";
import { SubHostDockToolsPort, type SubHostMachineConnection } from "../src/control/machine-transport.js";
import type { DockToolsRequest } from "../src/core/dock-tools.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

const grants = ["read", "dock_create", "dock_spawn"];
const policy = { allowedTools: grants };

test("delegated tool selection inherits, narrows, and never expands the source grant", () => {
  for (const type of ["create", "spawn"] as const) {
    const request: DockToolsRequest = type === "create"
      ? { type, operationId: "create", cwd: "/tmp" }
      : { type, operationId: "spawn", name: "child", task: "review" };
    assert.deepEqual(constrainDelegatedTools(request, policy), { ...request, allowedTools: grants });
    assert.deepEqual(constrainDelegatedTools({ ...request, allowedTools: [] }, policy), { ...request, allowedTools: [] });
    assert.deepEqual(constrainDelegatedTools({ ...request, allowedTools: ["read"] }, policy), { ...request, allowedTools: ["read"] });
    assert.throws(() => constrainDelegatedTools({ ...request, allowedTools: ["write"] }, policy), /permission ceiling/);
    assert.throws(() => constrainDelegatedTools({ ...request, allowedTools: ["mcp__*"] }, policy));
    assert.equal(constrainDelegatedTools(request, undefined), request);
  }
});

test("source Host enforces create/spawn ceiling locally and before Main/SubHost routing; UI creation stays independent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-delegation-policy-"));
  const registry = new DockRegistry(async (input) => {
    const runtime = new DelayedAgentWorkerConnection(input.id);
    return new ManagedInstance({ ...input, session: runtime, initialHistory: runtime.getHistory() });
  });
  context.after(async () => { await registry.stopAll(); await rm(root, { recursive: true, force: true }); });
  new DockHost({ socketPath: join(root, "unused.sock"), registry });
  const parent = await registry.create({ operationId: "parent", cwd: root, workerConfig: { toolPolicy: policy } });
  for (const type of ["create", "spawn"] as const) {
    const request: DockToolsRequest = type === "create"
      ? { type, operationId: "create-local", cwd: root }
      : { type, operationId: "spawn-local", name: "child", task: "review" };
    await assert.rejects(registry.invokeDockTool(parent.id, { ...request, allowedTools: ["write"] }), /permission ceiling/);
    const created = await registry.invokeDockTool(parent.id, request);
    assert.ok(created.type === "create" || created.type === "spawn");
    const inherited = registry.authorizeDockToolRequest(created.instance.id, { type: "create", operationId: "grandchild", cwd: root });
    assert.ok(inherited.type === "create");
    assert.deepEqual(inherited.allowedTools, grants, "child's persisted Host policy retains the ceiling");
  }
  const seen: DockToolsRequest[] = [];
  const routed = async (_source: string, request: DockToolsRequest) => { seen.push(parseDockToolsRequest(JSON.parse(JSON.stringify(request)))); return { type: "machines" as const, machines: [] }; };
  const main = new MainMachineDockToolsPort({ local: () => registry, mainHostId: async () => "main",
    authority: () => ({ invoke: (source: string, _machine: string, request: DockToolsRequest) => routed(source, request) }) as unknown as MainMachineDockToolsAuthority });
  const sub = new SubHostDockToolsPort({ local: () => registry, upstream: { invokeDockTool: routed } as unknown as SubHostMachineConnection });
  for (const port of [main, sub]) for (const type of ["create", "spawn"] as const) {
    const request: DockToolsRequest = type === "create"
      ? { type, operationId: "route-create", cwd: root, machine: "another-machine" }
      : { type, operationId: "route-spawn", name: "child", task: "review" };
    await assert.rejects(port.invokeDockTool(parent.id, { ...request, allowedTools: ["write"] }), /permission ceiling/);
    const before = seen.length;
    await port.invokeDockTool(parent.id, request);
    assert.equal(seen.length, before + 1);
    assert.deepEqual(seen.at(-1), { ...request, allowedTools: grants });
  }
  const userChild = await registry.create({ operationId: "user-child", cwd: root, parentId: parent.id, workerConfig: { toolPolicy: { allowedTools: ["write"] } } });
  const userGrant = registry.authorizeDockToolRequest(userChild.id, { type: "create", operationId: "user-grandchild", cwd: root });
  assert.ok(userGrant.type === "create");
  assert.deepEqual(userGrant.allowedTools, ["write"], "explicit owner-created work is not constrained by another worker");
});
