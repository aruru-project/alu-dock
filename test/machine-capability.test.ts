import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/control/json-lines.js";
import { MainMachineState, SubHostMachineState } from "../src/control/machine-state.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { MainMachineController, SubHostMachineConnection } from "../src/control/machine-transport.js";

// New Client / new Main / old target: old Protocol V2 Hosts already reject a
// missing feature in hello. Main must not erase that fact or drop the machine.
test("a target without system selection reports that fact without disconnecting its machine", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-capability-"));
  let main: DockHost | undefined, upstream: SubHostMachineConnection | undefined;
  try {
    const mainState = new MainMachineState(join(root, "main"), "Main");
    await mainState.initialize();
    const subState = new SubHostMachineState(join(root, "sub"));
    await subState.prepare(await mainState.createJoin(), "Old target");
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address(); assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const settings = new MachineSettingsState(join(root, "settings"));
    await settings.writeMainConnections({ enabled: true, port: address.port });
    const registry = new DockRegistry(async () => { throw new Error("Discovery must not create a Worker"); });
    const controller = new MainMachineController({ state: mainState, settingsState: settings, bindAddress: "127.0.0.1",
      mainHostEpoch: registry.hostEpoch, localSnapshots: () => [] });
    main = new DockHost({ registry, socketPath: join(root, "main.sock"), remoteInstances: controller });
    const hellos: unknown[] = [];
    upstream = new SubHostMachineConnection({ state: subState, address: "127.0.0.1", port: address.port,
      hostEpoch: "old-target-epoch", snapshots: () => [], acceptProtocolSocket: (socket) => {
        const decoder = new JsonLineDecoder();
        socket.on("data", (chunk) => {
          for (const line of decoder.push(chunk)) {
            const value = JSON.parse(line);
            if (value.kind !== "hello") continue;
            hellos.push(value.requiredCapabilities);
            socket.end(encodeJsonLine({ kind: "hello_error", requestId: value.requestId,
              error: { code: "capability_missing", message: "Required capabilities are unavailable", missing: ["system.templates.v1"] } }));
          }
        });
      } });
    await main.start(); await upstream.start();
    const client = new DockClient({ socketPath: main.socketPath, timeoutMs: 2_000 });
    let target;
    for (let attempt = 0; attempt < 100; attempt++) {
      target = (await client.machines()).machines.find((item) => item.name === "Old target" && item.available);
      if (target) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(target);
    await assert.rejects(client.systemCatalog(root, target.hostId), (error: unknown) => {
      assert.ok(error instanceof ControlClientError);
      assert.equal(error.code, "capability_missing");
      assert.deepEqual(error.details, { missing: ["system.templates.v1"] });
      return true;
    });
    assert.deepEqual(hellos, [["core.v2", "system.templates.v1"]]);
    assert.equal((await client.machines()).machines.find((item) => item.hostId === target.hostId)?.available, true);
  } finally {
    await upstream?.stop(); await main?.stop(); await rm(root, { recursive: true, force: true });
  }
});
