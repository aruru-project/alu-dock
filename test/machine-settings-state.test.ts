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

    await fixture.state.writeMainConnections({ enabled: true, port: 43127 });
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
