import assert from "node:assert/strict";
import test from "node:test";
import { AgentSettingsWriteError, type AgentModelState, type ThinkingLevel } from "../src/core/agent-worker.js";
import { ManagedInstance, type DockEvent } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

// Card 271 review: a plugin can change model while a Dock Thinking setter is
// awaiting persistence. The Worker response then contains both actual changes.
class ConcurrentModelWorker extends DelayedAgentWorkerConnection {
  target = "local";
  failWrite = false;
  override async setThinkingLevel(level: ThinkingLevel): Promise<AgentModelState> {
    await super.selectModel("fixture", this.target);
    const state = await super.setThinkingLevel(level);
    this.emit({ type: "dock_model_state_observed", modelState: state, runtimeGeneration: 1 });
    if (this.failWrite) throw new AgentSettingsWriteError("thinking", "write", true, [{ scope: "global", message: "fixture disk failure" }]);
    return state;
  }
}

test("a Thinking request reports a concurrent model change even when saving fails", async () => {
  const worker = new ConcurrentModelWorker("concurrent-model");
  const instance = new ManagedInstance({ id: "concurrent-model", hostEpoch: "fixture-host", cwd: "/fixture", session: worker,
    executor: { kind: "fixture", model: { provider: "fixture", id: "default" }, thinkingLevel: "off" } });
  const events: DockEvent[] = [];
  instance.subscribe((event) => events.push(event));
  try {
    for (const failWrite of [false, true]) {
      worker.failWrite = failWrite;
      worker.target = failWrite ? "default" : "local";
      const before = events.length;
      if (failWrite) await assert.rejects(instance.setThinkingLevel("high"), AgentSettingsWriteError);
      else await instance.setThinkingLevel("high");
      assert.equal(instance.snapshot().executor.model?.id, worker.target);
      const changes = events.slice(before);
      assert.equal(changes.filter((event) => event.type === "model.changed" && event.data.id === worker.target).length, 1);
      assert.equal(changes.filter((event) => event.type === "thinking.changed" && event.data.requested === "high").length, 1);
      assert.equal(changes.filter((event) => event.type === "settings.write_failed").length, failWrite ? 1 : 0);
    }
    worker.failWrite = false;
    const before = events.length;
    await instance.setThinkingLevel("low");
    assert.equal(events.slice(before).filter((event) => event.type === "model.changed").length, 0, "ordinary Thinking changes do not invent another model change");
    assert.equal(events.slice(before).filter((event) => event.type === "thinking.changed").length, 1);
  } finally { await instance.disposeUnpublished(); }
});
