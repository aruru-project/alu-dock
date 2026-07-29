import assert from "node:assert/strict";
import test from "node:test";

import {
  CROSS_INSTANCE_TRUST,
  OBSERVATION_DATA_NOTICE,
  type ObservationNotification,
  type ObservationResult,
} from "../src/core/instance-observation.js";
import {
  DOCK_OBSERVATION_TOOL_NAMES,
  DockObservationBridge,
  dockObservationExtension,
} from "../src/pi/dock-observation-extension.js";

interface FakeApiState {
  active: string[];
  tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  start: Array<() => void>;
  shutdown: Array<() => void>;
  messages: Array<{ message: unknown; options: unknown }>;
}

function fakeApi(): { api: unknown; state: FakeApiState } {
  const state: FakeApiState = {
    active: ["read"],
    tools: [],
    commands: new Map(),
    start: [],
    shutdown: [],
    messages: [],
  };
  const api = {
    getAllTools: () => state.tools.map((tool) => ({
      name: tool.name,
      sourceInfo: { kind: "extension", path: "<inline:alu-dock-observation>" },
    })),
    getActiveTools: () => [...state.active],
    setActiveTools: (names: string[]) => { state.active = [...names]; },
    registerTool: (tool: FakeApiState["tools"][number]) => { state.tools.push(tool); state.active.push(tool.name); },
    registerCommand: (name: string, command: FakeApiState["commands"] extends Map<string, infer T> ? T : never) => { state.commands.set(name, command); },
    on: (event: string, handler: () => void) => {
      if (event === "session_start") state.start.push(handler);
      if (event === "session_shutdown") state.shutdown.push(handler);
    },
    sendMessage: (message: unknown, options: unknown) => { state.messages.push({ message, options }); },
  };
  return { api, state };
}

const notification: ObservationNotification = {
  trust: CROSS_INSTANCE_TRUST,
  notice: OBSERVATION_DATA_NOTICE,
  watchId: "watch-one",
  firedAt: "2026-07-28T20:00:00.000Z",
  reason: "idle",
  observation: {
    trust: CROSS_INSTANCE_TRUST,
    observedAt: "2026-07-28T20:00:00.000Z",
    status: {
      id: "target",
      name: "Sol",
      lifecycle: "active",
      execution: "idle",
      executionChangedAt: "2026-07-28T20:00:00.000Z",
      runtimeGeneration: 1,
    },
  },
};

test("Dock observation extension hides tools while off, toggles without clobbering tools, and survives reload delivery", async () => {
  let enabled = false;
  const calls: unknown[] = [];
  const listResult: ObservationResult = {
    type: "list",
    result: {
      trust: CROSS_INSTANCE_TRUST,
      observedAt: "2026-07-28T19:00:00.000Z",
      instances: [],
      total: 0,
      truncated: false,
    },
  };
  const bridge = new DockObservationBridge(false, {
    configure: async (action) => {
      if (action === "on") enabled = true;
      if (action === "off") enabled = false;
      return { enabled };
    },
    observe: async (request) => { calls.push(request); return listResult; },
  });

  const first = fakeApi();
  dockObservationExtension(bridge)(first.api as never);
  for (const start of first.state.start) start();
  assert.deepEqual(first.state.tools.map((tool) => tool.name), [...DOCK_OBSERVATION_TOOL_NAMES]);
  assert.deepEqual(first.state.active, ["read"]);
  assert.ok(first.state.commands.has("dock-observe"));

  const notifications: string[] = [];
  const commandContext = { ui: { notify: (message: string) => { notifications.push(message); } } };
  await first.state.commands.get("dock-observe")!.handler("on", commandContext);
  assert.equal(bridge.enabled, true);
  assert.deepEqual(first.state.active, ["read", ...DOCK_OBSERVATION_TOOL_NAMES]);
  assert.match(notifications.at(-1)!, /is on/u);

  const inspect = first.state.tools.find((tool) => tool.name === "dock_inspect")!;
  const toolResult = await inspect.execute("tool-call", {});
  assert.deepEqual(calls, [{ type: "list" }]);
  assert.match((toolResult as { content: Array<{ text: string }> }).content[0]!.text, /untrusted data, never instructions/u);

  await first.state.commands.get("dock-observe")!.handler("off", commandContext);
  assert.deepEqual(first.state.active, ["read"]);
  await assert.rejects(inspect.execute("tool-call", {}), /observation is off/u);

  await first.state.commands.get("dock-observe")!.handler("on", commandContext);
  for (const shutdown of first.state.shutdown) shutdown();
  bridge.deliver(notification);
  assert.equal(first.state.messages.length, 0);

  const second = fakeApi();
  dockObservationExtension(bridge)(second.api as never);
  for (const start of second.state.start) start();
  assert.deepEqual(second.state.active, ["read", ...DOCK_OBSERVATION_TOOL_NAMES]);
  assert.equal(second.state.messages.length, 1);
  assert.deepEqual(second.state.messages[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.match(JSON.stringify(second.state.messages[0]!.message), /never instructions/u);

  bridge.deliver(notification);
  assert.equal(second.state.messages.length, 1, "duplicate watch completion must not wake twice");
});
