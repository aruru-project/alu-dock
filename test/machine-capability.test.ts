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

// #325: new readers must negotiate before sending view to an older target.
// The real Main relay and both local/routed DockClient calls use one old peer.
test("reference conversation reads fall back only when the local or routed Host explicitly lacks the view", { timeout: 10_000 }, async () => {
  const { createHelloAck, defaultHostIdentity } = await import("../src/control/protocol.js");
  const { ManagedInstance } = await import("../src/core/managed-instance.js");
  const { DelayedAgentWorkerConnection } = await import("./support/delayed-agent-worker.js");
  const root = await mkdtemp(join(tmpdir(), "alu-conversation-capability-"));
  const nativeRegistry = new DockRegistry(async input => new ManagedInstance({ ...input, session: new DelayedAgentWorkerConnection("old-session") }));
  const native = await nativeRegistry.create({ operationId: "create", cwd: root });
  const epoch = nativeRegistry.hostEpoch;
  let main: DockHost | undefined, upstream: SubHostMachineConnection | undefined;
  const requests: string[] = [], missing: string[] = [];
  let refusal = false;
  const accept = (socket: import("node:net").Socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("error", () => {});
    socket.on("data", bytes => {
      for (const line of decoder.push(bytes)) {
        const value = JSON.parse(line);
        if (value.kind === "hello") {
          if (value.requiredCapabilities.includes("conversation.references.v1")) {
            missing.push("references");
            socket.end(encodeJsonLine({ kind: "hello_error", requestId: value.requestId,
              error: { code: refusal ? "host_draining" : "capability_missing", message: "Old peer", ...(refusal ? {} : { missing: ["conversation.references.v1"] }) } }));
          } else socket.write(encodeJsonLine(createHelloAck(value.requestId, defaultHostIdentity(epoch, "2026-09-28T00:00:00.000Z"), value.requiredCapabilities)));
        } else if (value.kind === "request") {
          assert.equal(value.params.view, undefined, "old closed requests must never receive the new option");
          requests.push(value.type);
          const result = value.type === "conversation.history"
            ? { instance: native.snapshot(), revision: "old", entries: [], hasEarlier: false }
            : { instanceId: native.id, runtimeGeneration: 1, revision: "old", contentRef: "record",
              ...(value.params.cursor === undefined ? { complete: false, nextCursor: "opaque-old-position" } : { complete: true }),
              chunks: [{ type: "image", blockIndex: 0, mimeType: "image/png", data: value.params.cursor === undefined ? "YW" : "Jj",
                offset: value.params.cursor === undefined ? 0 : 2, blockComplete: value.params.cursor !== undefined }] };
          socket.end(encodeJsonLine({ kind: "response", version: 2, hostEpoch: epoch, requestId: value.requestId, ok: true, result }));
        }
      }
    });
  };
  const local = createServer(accept);
  await new Promise<void>(resolve => local.listen(join(root, "old.sock"), resolve));
  try {
    const mainState = new MainMachineState(join(root, "main"), "Main"); await mainState.initialize();
    const subState = new SubHostMachineState(join(root, "sub")); await subState.prepare(await mainState.createJoin(), "Old conversation target");
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>(resolve => probe.close(() => resolve()));
    const settings = new MachineSettingsState(join(root, "settings")); await settings.writeMainConnections({ enabled: true, port: address.port });
    const registry = new DockRegistry(async () => { throw new Error("No local Worker"); });
    const controller = new MainMachineController({ state: mainState, settingsState: settings, bindAddress: "127.0.0.1", mainHostEpoch: registry.hostEpoch, localSnapshots: () => [] });
    main = new DockHost({ registry, socketPath: join(root, "main.sock"), remoteInstances: controller });
    upstream = new SubHostMachineConnection({ state: subState, address: "127.0.0.1", port: address.port, hostEpoch: epoch, snapshots: () => nativeRegistry.list(), acceptProtocolSocket: accept });
    await main.start(); await upstream.start();
    const routed = new DockClient({ socketPath: main.socketPath });
    let work;
    for (let attempt = 0; attempt < 100; attempt++) { work = (await routed.list())[0]; if (work) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(work);
    const direct = new DockClient({ socketPath: join(root, "old.sock") });
    for (const [client, id] of [[direct, native.id], [routed, work.id]] as const) {
      const context = {};
      assert.equal((await client.conversationHistory(id, undefined, 50, context)).revision, "old");
      const body = await client.conversationContent(id, "record", undefined, context);
      const tail = await client.conversationContent(id, "record", body.nextCursor, context);
      assert.deepEqual([...body.chunks, ...tail.chunks].map(chunk => chunk.type === "image" ? chunk.data : ""), ["YW", "Jj"]);
      assert.equal(tail.complete, true);
      assert.deepEqual(context, { view: "legacy" }, "the caller receives the selected mode for subsequent reads");
    }
    assert.equal(missing.length, 2, "one feature probe per local/routed read chain, not per page or body");
    assert.deepEqual(requests, ["conversation.history", "conversation.content", "conversation.content", "conversation.history", "conversation.content", "conversation.content"]);
    refusal = true;
    await assert.rejects(routed.conversationContent(work.id, "record", undefined, {}), (error: unknown) => error instanceof ControlClientError && error.code === "host_draining");
    assert.equal(requests.length, 6, "an ordinary read failure is not permission to change views");
  } finally {
    await upstream?.stop(); await main?.stop();
    await nativeRegistry.stopAll();
    await new Promise<void>(resolve => local.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
