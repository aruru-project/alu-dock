import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DockToolsHostPort } from "../src/core/dock-tools.js";
import { DOCK_TOOL_NAMES } from "../src/pi/dock-tools-extension.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("real Pi Worker toggles all Dock tools and its bundled skill across reload without a model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-tools-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-network" } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" }));

  let enabled = false;
  const dockToolsHostPort: DockToolsHostPort = {
    dockToolsEnabled: () => enabled,
    configureDockTools: async (_source, next) => { enabled = next; return { enabled }; },
    invokeDockTool: async () => ({
      type: "list",
      result: {
        trust: "untrusted_cross_instance",
        observedAt: "2026-07-28T20:00:00.000Z",
        instances: [],
        total: 0,
        truncated: false,
        includesHistory: false,
      },
    }),
    attachObservationSink: () => () => {},
  };

  const previousPiOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const instance = await (async () => {
    try {
      return await createPiInstance({
        cwd,
        agentDir,
        sessionDir,
        projectTrusted: true,
        dockToolsHostPort,
        dockToolsEnabled: false,
        workerEnvironment: { ...process.env },
        workerTimeouts: { mutationMs: 10_000 },
      });
    } finally {
      if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousPiOffline;
    }
  })();

  try {
    const commands = await instance.getCommands();
    const resources = await instance.getResources();
    assert.ok(commands.commands.some((command) => command.name === "dock-tools"), JSON.stringify({ commands, resources, events: instance.eventsSince().events }));
    const initial = await instance.listTools();
    assert.equal(resources.resources.some((resource) => resource.kind === "skill" && resource.name === "dock-tools"), false);
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(initial.tools.find((tool) => tool.name === name)?.active, false);
    }

    await instance.submit("/dock-tools on", "prompt", "observation-on");
    await waitFor(() => enabled, "Dock tools command did not reach the Host port");
    await waitFor(() => instance.snapshot().execution === "idle", "Dock tools reload did not finish");
    const active = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(active.tools.find((tool) => tool.name === name)?.active, true);
    }
    await waitFor(async () => (await instance.getResources()).resources.some((resource) => resource.kind === "skill" && resource.name === "dock-tools"), "Dock tools skill did not appear after reload");

    await instance.reloadSession("dock-tools-reload");
    const reloaded = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(reloaded.tools.find((tool) => tool.name === name)?.active, true);
    }

    await instance.submit("/dock-tools off", "prompt", "observation-off");
    await waitFor(() => !enabled, "Dock tools off command did not reach the Host port");
    await waitFor(() => instance.snapshot().execution === "idle", "Dock tools off reload did not finish");
    const disabled = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(disabled.tools.find((tool) => tool.name === name)?.active, false);
    }
    await waitFor(async () => !(await instance.getResources()).resources.some((resource) => resource.kind === "skill" && resource.name === "dock-tools"), "Dock tools skill did not disappear after reload");
  } finally {
    await instance.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
