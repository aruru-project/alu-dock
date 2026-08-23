import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { currentMachineRole, MachineSettingsState } from "../src/control/machine-settings-state.js";

async function temporaryState(): Promise<{ state: MachineSettingsState; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-settings-"));
  return { state: new MachineSettingsState(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a saved role applies on the next startup while the live process keeps its current surface", async () => {
  const fixture = await temporaryState();
  try {
    const initial = await fixture.state.read();
    assert.equal(initial.role, "main");
    assert.equal(initial.main.connectionsEnabled, false);

    const enabled = await fixture.state.writeMainConnections({ enabled: true, port: 43127 });
    await assert.rejects(
      fixture.state.writeMainConnections({ enabled: false, port: 43128 }, initial.revision),
      /settings changed/u,
    );
    await fixture.state.writeMainListenerStatus({
      schemaVersion: 1,
      configRevision: enabled.revision,
      state: "listening",
      activePort: 43127,
      updatedAt: "2026-08-23T00:00:00.000Z",
    });
    assert.deepEqual(await fixture.state.readMainListenerStatus(), {
      schemaVersion: 1,
      configRevision: enabled.revision,
      state: "listening",
      activePort: 43127,
      updatedAt: "2026-08-23T00:00:00.000Z",
    });
    const subhost = await fixture.state.switchToSubHost({ mainAddress: "main.lan", port: 43127, name: "Studio" });
    assert.equal(subhost.role, "subhost");
    assert.deepEqual(subhost.subhost, { mainAddress: "main.lan", port: 43127, name: "Studio" });
    assert.equal(currentMachineRole(subhost, { connected: false }, true), "main");
    assert.equal(currentMachineRole(subhost, { connected: false }, false), "subhost");

    const main = await fixture.state.switchToMain();
    assert.equal(main.role, "main");
    assert.equal(main.main.connectionsEnabled, true);
    assert.equal((await fixture.state.read()).role, "main");
    assert.equal(currentMachineRole(main, { connected: true, processId: 42 }, false), "subhost");
  } finally {
    await fixture.cleanup();
  }
});
