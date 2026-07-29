import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { InstanceObservationHostPort } from "../src/core/instance-observation.js";
import { DOCK_OBSERVATION_TOOL_NAMES } from "../src/pi/dock-observation-extension.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("real Pi Worker toggles Dock observation tools and preserves the grant across reload without a model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-observation-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-network" } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" }));

  let enabled = false;
  const observationHostPort: InstanceObservationHostPort = {
    observationGrant: () => enabled,
    configureObservation: async (_source, next) => { enabled = next; return { enabled }; },
    observe: async () => ({
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
        observationHostPort,
        observationGrant: false,
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
    assert.ok(commands.commands.some((command) => command.name === "dock-observe"), JSON.stringify({ commands, resources, events: instance.eventsSince().events }));
    const initial = await instance.listTools();
    for (const name of DOCK_OBSERVATION_TOOL_NAMES) {
      assert.equal(initial.tools.find((tool) => tool.name === name)?.active, false);
    }

    await instance.submit("/dock-observe on", "prompt", "observation-on");
    await waitFor(() => enabled, "Dock observation command did not reach the Host port");
    const active = await instance.listTools();
    for (const name of DOCK_OBSERVATION_TOOL_NAMES) {
      assert.equal(active.tools.find((tool) => tool.name === name)?.active, true);
    }

    await instance.reloadSession("observation-reload");
    const reloaded = await instance.listTools();
    for (const name of DOCK_OBSERVATION_TOOL_NAMES) {
      assert.equal(reloaded.tools.find((tool) => tool.name === name)?.active, true);
    }

    await instance.submit("/dock-observe off", "prompt", "observation-off");
    await waitFor(() => !enabled, "Dock observation off command did not reach the Host port");
    const disabled = await instance.listTools();
    for (const name of DOCK_OBSERVATION_TOOL_NAMES) {
      assert.equal(disabled.tools.find((tool) => tool.name === name)?.active, false);
    }
  } finally {
    await instance.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
