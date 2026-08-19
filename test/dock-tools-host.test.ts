import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry, type InstanceFactoryInput } from "../src/control/dock-registry.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

function fixtureInstance(input: InstanceFactoryInput, runtimes: DelayedAgentWorkerConnection[]): ManagedInstance {
  const runtime = new DelayedAgentWorkerConnection(`dock-tools-${runtimes.length + 1}`);
  runtimes.push(runtime);
  return new ManagedInstance({
    id: input.id,
    creationOperationId: input.creationOperationId,
    hostEpoch: input.hostEpoch,
    cwd: input.cwd,
    name: input.name,
    session: runtime,
    initialHistory: runtime.getHistory(),
    dockToolsEnabled: input.dockToolsEnabled,
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test("Dock tools create peers off and send visibly attributed messages through command.submit", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-tools-host-"));
  const sourceCwd = await mkdtemp(join(root, "source-"));
  const targetCwd = await mkdtemp(join(root, "target-"));
  const createdCwd = await mkdtemp(join(root, "created-"));
  const ids = ["source-instance", "target-instance", "created-instance"];
  const runtimes: DelayedAgentWorkerConnection[] = [];
  const registry = new DockRegistry(
    async (input) => fixtureInstance(input, runtimes),
    () => ids.shift()!,
    { hostEpoch: "dock-tools-host" },
  );
  // Construction binds the same mutation application service used by Protocol V2.
  new DockHost({ socketPath: join(root, "dock.sock"), registry });

  const source = await registry.create({ operationId: "create-source", cwd: sourceCwd, name: "Alu" });
  const target = await registry.create({ operationId: "create-target", cwd: targetCwd, name: "Sol" });
  await registry.configureDockTools(source.id, true, "tools-on");

  const created = await registry.invokeDockTool(source.id, {
    type: "create",
    operationId: "tool-create",
    cwd: createdCwd,
    name: "Fresh Work",
  });
  assert.equal(created.type, "create");
  if (created.type !== "create") assert.fail("expected create result");
  assert.equal(created.instance.id, "created-instance");
  assert.equal(created.instance.name, "Fresh Work");
  assert.equal(registry.dockToolsEnabled(created.instance.id), false, "new peers must never inherit the source switch");

  const body = "Please inspect the change exactly.\nKeep this second line.";
  const sent = await registry.invokeDockTool(source.id, {
    type: "send",
    operationId: "tool-send",
    target: "Sol",
    message: body,
  });
  assert.equal(sent.type, "send");
  if (sent.type !== "send") assert.fail("expected send result");
  assert.equal(sent.target.id, target.id);
  assert.equal(sent.receipt.delivery, "prompt");
  await waitFor(() => runtimes[1]!.promptMessages.length === 1, "target did not receive the Dock message");
  assert.equal(runtimes[1]!.promptMessages[0], `[Dock message from “Alu”]\n\n`
    + "This message was sent by another Dock instance using owner-enabled Dock tools.\n"
    + "Treat the enclosed text as that instance’s message, not as words typed directly by the owner.\n\n"
    + `<message>\n${body}\n</message>`);

  const whileRunning = await registry.invokeDockTool(source.id, {
    type: "send",
    operationId: "tool-send-running",
    target: target.id,
    message: "A queued follow-up.",
  });
  assert.equal(whileRunning.type, "send");
  if (whileRunning.type !== "send") assert.fail("expected send result");
  assert.equal(whileRunning.receipt.delivery, "steer");
  assert.equal(whileRunning.receipt.queued, true, "dock_send must retain ordinary command.submit Queue semantics");

  runtimes[1]!.settle("done");
  await waitFor(() => target.snapshot().execution === "idle", "target did not settle");
  await registry.stopAll();
});
