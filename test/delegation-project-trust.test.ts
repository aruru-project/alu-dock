import { parseDockToolsRequest } from "../src/core/dock-tools-codec.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockRegistry } from "../src/control/dock-registry.js";
import { DockHost } from "../src/control/dock-host.js";
import { ProjectTrustCoordinator, ProjectTrustRequiredError } from "../src/control/project-trust.js";
import { MainMachineDockToolsPort, type MainMachineDockToolsAuthority } from "../src/control/main-machine-dock-tools.js";
import { SubHostDockToolsPort, type SubHostMachineConnection } from "../src/control/machine-transport.js";
import { systemToolOperation } from "../src/control/system-tools.js";
import type { DockToolsRequest } from "../src/core/dock-tools.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

test("trust_once is inherited only by operation-bound same-workspace children of a live source", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "alu-child-trust-"));
  const other = join(cwd, "subdirectory");
  await mkdir(other);
  let remembered = false;
  const factoryTrust: boolean[] = [];
  const coordinator = () => new ProjectTrustCoordinator({ requiresTrust: () => true, savedDecision: () => null,
    defaultDecision: () => "ask", remember: () => { remembered = true; } });
  const createRegistry = () => new DockRegistry(async (input) => {
    factoryTrust.push(input.projectTrusted);
    const runtime = new DelayedAgentWorkerConnection(input.id);
    return new ManagedInstance({ ...input, session: runtime, initialHistory: runtime.getHistory() });
  }, undefined, { trustPreflight: coordinator() });
  const registry = createRegistry(), remoteRegistry = createRegistry();
  context.after(async () => { await registry.stopAll(); await remoteRegistry.stopAll(); await rm(cwd, { recursive: true, force: true }); });
  new DockHost({ socketPath: join(cwd, "unused.sock"), registry });
  let challenge: ProjectTrustRequiredError | undefined;
  await assert.rejects(registry.create({ cwd, operationId: "parent" }), (error: unknown) => {
    assert.ok(error instanceof ProjectTrustRequiredError); challenge = error; return true;
  });
  const parent = await registry.create({ cwd, operationId: "parent", trustChallengeId: challenge!.details.challengeId, projectTrustDecision: "trust_once" });
  const spawned = await registry.invokeDockTool(parent.id, { type: "spawn", operationId: "spawn-local", name: "Reviewer", task: "Review" });
  assert.equal(spawned.type, "spawn");
  assert.equal(factoryTrust.at(-1), true);
  // No persistent decision and no blanket permission for an unrelated create.
  assert.equal(remembered, false);
  await assert.rejects(registry.create({ cwd, operationId: "unrelated" }), ProjectTrustRequiredError);
  const forward = async (_source: string, request: DockToolsRequest) => {
    request = parseDockToolsRequest(JSON.parse(JSON.stringify(request)));
    assert.ok(request.type === "spawn");
    const child = await registry.create({ cwd, operationId: systemToolOperation(request.operationId, "create") });
    assert.equal(child.resolvedProjectTrust()?.projectTrusted, true);
    return { type: "machines" as const, machines: [] };
  };
  const main = new MainMachineDockToolsPort({ local: () => registry, mainHostId: async () => "main",
    authority: () => ({ invoke: (source: string, _machine: string, request: DockToolsRequest) => forward(source, request) }) as unknown as MainMachineDockToolsAuthority });
  const sub = new SubHostDockToolsPort({ local: () => registry, upstream: { invokeDockTool: forward } as unknown as SubHostMachineConnection });
  for (const [index, port] of [main, sub].entries()) await port.invokeDockTool(parent.id, { type: "spawn", operationId: `routed-${index}`, name: "Child", task: "Review" });

  const newCwdRequest = { type: "create" as const, operationId: "different-cwd", cwd: other };
  registry.authorizeDockToolRequest(parent.id, newCwdRequest);
  await assert.rejects(registry.create(newCwdRequest), ProjectTrustRequiredError);
  const remoteRequest = { type: "create" as const, operationId: "remote", cwd };
  registry.authorizeDockToolRequest(parent.id, remoteRequest);
  await assert.rejects(remoteRegistry.create(remoteRequest), ProjectTrustRequiredError, "another Host cannot inherit origin trust");

  // A session switch's changed trust is authoritative even in the original cwd.
  parent.setResolvedProjectTrust({ canonicalCwd: cwd, projectTrusted: false });
  registry.authorizeDockToolRequest(parent.id, { type: "create", operationId: "denied-session", cwd });
  const denied = await registry.create({ operationId: "denied-session", cwd });
  assert.equal(denied.resolvedProjectTrust()?.projectTrusted, false);
  assert.equal(factoryTrust.at(-1), false);
  parent.setResolvedProjectTrust({ canonicalCwd: cwd, projectTrusted: true });
  registry.authorizeDockToolRequest(parent.id, { type: "create", operationId: "stale", cwd });
  await registry.stop(parent.id, "stop-parent");
  await assert.rejects(registry.create({ cwd, operationId: "stale" }), ProjectTrustRequiredError, "stopped/unavailable source cannot supply trust");
  assert.equal(remembered, false);
});
