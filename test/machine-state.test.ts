import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TLSSocket } from "node:tls";

import type { DockToolsHostPort } from "../src/core/dock-tools.js";
import type { InstanceSnapshot } from "../src/core/managed-instance.js";
import { MainMachineState, SubHostMachineState, writeMachineJoinFile } from "../src/control/machine-state.js";
import { MAX_MACHINE_CONNECTIONS, MainMachineController, parseCompletedMachineInventory, SubHostDockToolsPort, SubHostMachineConnection, writeMachine } from "../src/control/machine-transport.js";
import type { ControlRequest } from "../src/control/protocol.js";

function snapshot(id: string, hostEpoch = "subhost-epoch"): InstanceSnapshot {
  return {
    id,
    creationOperationId: `create-${id}`,
    displayName: id,
    cwd: `/tmp/${id}`,
    lifecycle: "active",
    execution: "idle",
    compacting: false,
    lastRun: "never",
    reopenable: false,
    runtimeGeneration: 1,
    ownerHostEpoch: hostEpoch,
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: "fixture", piSessionId: `pi-${id}` },
    extensionStatus: {},
    toolsExpanded: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    executionChangedAt: "2026-01-01T00:00:00.000Z",
    eventCursor: { hostEpoch, instanceId: id, runtimeGeneration: 1, sequence: 0 },
  };
}

function snapshotAtGeneration(id: string, runtimeGeneration: number, hostEpoch = "subhost-epoch"): InstanceSnapshot {
  const value = snapshot(id, hostEpoch);
  return { ...value, runtimeGeneration, eventCursor: { ...value.eventCursor, runtimeGeneration } };
}

function stoppedSnapshotAtGeneration(id: string, runtimeGeneration: number, hostEpoch = "subhost-epoch"): InstanceSnapshot {
  return {
    ...snapshotAtGeneration(id, runtimeGeneration, hostEpoch),
    lifecycle: "stopped",
    execution: "unavailable",
    ownerHostEpoch: undefined,
  };
}

class BarrierMainMachineState extends MainMachineState {
  private barrier: { started: () => void; wait: Promise<void> } | undefined;

  armUpdateBarrier(): { started: Promise<void>; release: () => void } {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.barrier = { started, wait };
    return { started: startedPromise, release };
  }

  override async updateMachine(...args: Parameters<MainMachineState["updateMachine"]>): Promise<Awaited<ReturnType<MainMachineState["updateMachine"]>>> {
    const barrier = this.barrier;
    if (barrier) {
      barrier.started();
      await barrier.wait;
      if (this.barrier === barrier) this.barrier = undefined;
    }
    return super.updateMachine(...args);
  }
}

async function joinedState(root: string, state = new MainMachineState(root)): Promise<{ state: MainMachineState; machineId: string }> {
  const joinFile = await state.createJoin();
  const sub = new SubHostMachineState(join(root, "sub"));
  const pending = await sub.prepare(joinFile, "Fixture SubHost");
  await state.acceptJoin({ token: joinFile.token, machineId: pending.machineId, machineName: pending.machineName, certificatePem: pending.identity.certificatePem });
  return { state, machineId: pending.machineId };
}

test("join enrollment is one-use and writing its private file preserves an existing parent mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-state-"));
  const parent = join(root, "shared");
  await (await import("node:fs/promises")).mkdir(parent, { mode: 0o755 });
  await chmod(parent, 0o755);
  const main = new MainMachineState(join(root, "main"));
  const joinFile = await main.createJoin();
  const path = join(parent, "subhost.join");
  await writeMachineJoinFile(path, joinFile);
  assert.equal((await stat(parent)).mode & 0o777, 0o755);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const sub = new SubHostMachineState(join(root, "sub"));
  const pending = await sub.prepare(joinFile, "Studio");
  await main.acceptJoin({ token: joinFile.token, machineId: pending.machineId, machineName: pending.machineName, certificatePem: pending.identity.certificatePem });
  await sub.markJoined();
  await assert.rejects(sub.prepare(joinFile, "Studio"), /already enrolled/u);
  await assert.rejects(main.acceptJoin({ token: joinFile.token, machineId: pending.machineId, machineName: pending.machineName, certificatePem: pending.identity.certificatePem }), /expired|already been used/u);
});

test("an inventory larger than the old machine line crosses real TLS in ordered chunks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-inventory-"));
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "::1", resolve); });
  const address = portServer.address();
  if (!address || typeof address === "string") throw new Error("test port is unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));

  const mainState = new MainMachineState(join(root, "main"));
  const joinFile = await mainState.createJoin();
  const subState = new SubHostMachineState(join(root, "sub"));
  await subState.prepare(joinFile, "Large Inventory SubHost");
  const snapshots = Array.from({ length: 180 }, (_, index): InstanceSnapshot => {
    const id = `native-${index}`;
    return {
      id,
      creationOperationId: `create-${index}`,
      displayName: `Work ${index}`,
      cwd: `/${"x".repeat(15_000)}-${index}`,
      lifecycle: "active",
      execution: "idle",
      compacting: false,
      lastRun: "never",
      reopenable: false,
      runtimeGeneration: 1,
      ownerHostEpoch: "large-subhost-epoch",
      pending: { steering: 0, followUp: 0, total: 0 },
      executor: { kind: "fixture", piSessionId: `pi-${index}` },
      extensionStatus: {},
      toolsExpanded: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      executionChangedAt: "2026-01-01T00:00:00.000Z",
      eventCursor: { hostEpoch: "large-subhost-epoch", instanceId: id, runtimeGeneration: 1, sequence: 0 },
    };
  });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshots), "utf8") > 2 * 1024 * 1024);

  const controller = new MainMachineController({ state: mainState, port, bindAddress: "::1", mainHostEpoch: "large-main-epoch", localSnapshots: () => [] });
  const upstream = new SubHostMachineConnection({
    state: subState,
    address: "::1",
    port,
    hostEpoch: "large-subhost-epoch",
    snapshots: () => snapshots,
    acceptProtocolSocket: (socket) => socket.destroy(),
  });
  context.after(async () => { await upstream.stop(); await controller.stop(); await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); });
  await controller.start();
  await upstream.start();
  for (let attempt = 0; attempt < 400 && !upstream.connected(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(upstream.connected(), true);
  const reconciled = controller.remoteSnapshotsCurrent();
  assert.equal(reconciled.length, snapshots.length);
  assert.equal(reconciled.at(-1)?.cwd, snapshots.at(-1)?.cwd);
});

test("completed inventory rejects duplicate native IDs before route reconciliation", () => {
  const duplicate = snapshot("native-duplicate");
  assert.throws(
    () => parseCompletedMachineInventory(JSON.stringify([duplicate, { ...duplicate, displayName: "duplicate copy" }])),
    /duplicate native instance IDs/u,
  );
});

test("persisted route files reject duplicate native and Main IDs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-route-validation-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { machineId } = await joinedState(root);
  const routePath = join(root, `${machineId}.routes.json`);
  const mainOne = randomUUID();
  const mainTwo = randomUUID();
  const writeRoutes = async (routes: unknown[], retiredRoutes: unknown[] = []): Promise<void> => writeFile(routePath, `${JSON.stringify({ schemaVersion: 1, machineId, routes, retiredRoutes })}\n`, { mode: 0o600 });

  await writeRoutes([
    { mainInstanceId: mainOne, nativeInstanceId: "native-same", snapshot: snapshot(mainOne, "main-epoch") },
    { mainInstanceId: mainTwo, nativeInstanceId: "native-same", snapshot: snapshot(mainTwo, "main-epoch") },
  ]);
  await assert.rejects(new MainMachineState(root).initialize(), /Native instance route IDs are duplicated/u);

  await writeRoutes([
    { mainInstanceId: mainOne, nativeInstanceId: "native-one", snapshot: snapshot(mainOne, "main-epoch") },
    { mainInstanceId: mainOne, nativeInstanceId: "native-two", snapshot: snapshot(mainOne, "main-epoch") },
  ]);
  await assert.rejects(new MainMachineState(root).initialize(), /Main instance route IDs are duplicated/u);

  await writeRoutes([], [
    { nativeInstanceId: "native-retired", runtimeGeneration: 2 },
    { nativeInstanceId: "native-retired", runtimeGeneration: 3 },
  ]);
  await assert.rejects(new MainMachineState(root).initialize(), /Retired native instance IDs are duplicated/u);
});

test("Main keeps the first global key owner while later SubHost duplicates remain addressable without that key", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-global-keys-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { state, machineId } = await joinedState(root);
  const machine = await state.get(machineId);
  assert.ok(machine);
  const localOwner = { ...snapshot("main-local", "main-epoch"), key: "main-owned" };
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [localOwner] });
  const fakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const connection = { machine, socket: fakeSocket as unknown as TLSSocket, hostEpoch: "subhost-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const internals = controller as unknown as {
    completeInitialInventory(candidate: unknown, epoch: string, values: InstanceSnapshot[]): Promise<void>;
    reconcileInventoryFromConnection(candidate: unknown, values: InstanceSnapshot[]): Promise<void>;
    mapRemoteStreamRecord(candidate: unknown, response: unknown): Promise<unknown[]>;
  };
  const localDuplicate = { ...snapshot("native-local-duplicate"), key: "main-owned" };
  const stableOwner = { ...snapshot("native-stable-owner"), key: "remote-owned" };
  await internals.completeInitialInventory(connection, "subhost-epoch", [localDuplicate, stableOwner]);
  const laterDuplicate = { ...snapshot("native-later-duplicate"), key: "remote-owned" };
  await internals.reconcileInventoryFromConnection(connection, [localDuplicate, stableOwner, laterDuplicate]);

  const stored = await state.get(machineId);
  const localDuplicateRoute = stored?.routes.find((route) => route.nativeInstanceId === localDuplicate.id);
  const stableRoute = stored?.routes.find((route) => route.nativeInstanceId === stableOwner.id);
  const laterRoute = stored?.routes.find((route) => route.nativeInstanceId === laterDuplicate.id);
  assert.equal(localDuplicateRoute?.snapshot.key, undefined);
  assert.equal(stableRoute?.snapshot.key, "remote-owned");
  assert.equal(laterRoute?.snapshot.key, undefined);
  assert.ok(localDuplicateRoute);

  const mapped = await internals.mapRemoteStreamRecord({
    streamId: "duplicate-status", machineId, connection, requestId: "duplicate-status", requestType: "instance.get",
    route: { mainInstanceId: localDuplicateRoute.mainInstanceId, nativeInstanceId: localDuplicate.id, mainHostEpoch: "main-epoch", nativeHostEpoch: "subhost-epoch" },
    emit: async () => {}, ended: () => {}, helloSeen: true, acceptingInput: true, inputTail: Promise.resolve(), queuedInputBytes: 0,
  }, { kind: "response", version: 2, requestId: "duplicate-status", hostEpoch: "subhost-epoch", ok: true, result: { instance: localDuplicate } });
  const mappedSnapshot = (mapped[0] as { result: { instance: InstanceSnapshot } }).result.instance;
  assert.equal(mappedSnapshot.key, undefined);

  const reloaded = new MainMachineState(root);
  await reloaded.initialize();
  const persisted = await reloaded.get(machineId);
  assert.equal(persisted?.routes.find((route) => route.nativeInstanceId === localDuplicate.id)?.snapshot.key, undefined);
  assert.equal(persisted?.routes.find((route) => route.nativeInstanceId === stableOwner.id)?.snapshot.key, "remote-owned");
  assert.equal(persisted?.routes.find((route) => route.nativeInstanceId === laterDuplicate.id)?.snapshot.key, undefined);
});

test("a global key reservation serializes concurrent ensure and inventory without creating a second owner", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-key-reservation-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { state, machineId } = await joinedState(root);
  const machine = await state.get(machineId);
  assert.ok(machine);
  let localOwner: InstanceSnapshot | undefined;
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => localOwner ? [localOwner] : [] });
  const fakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const connection = { machine, socket: fakeSocket as unknown as TLSSocket, hostEpoch: "subhost-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const internals = controller as unknown as {
    completeInitialInventory(candidate: unknown, epoch: string, values: InstanceSnapshot[]): Promise<void>;
    reconcileInventoryFromConnection(candidate: unknown, values: InstanceSnapshot[]): Promise<void>;
  };
  await internals.completeInitialInventory(connection, "subhost-epoch", []);

  let creationStarted!: () => void;
  let releaseCreation!: () => void;
  const started = new Promise<void>((resolve) => { creationStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCreation = resolve; });
  let creationCalls = 0;
  const ensureRequest = (operationId: string): Extract<ControlRequest, { type: "instance.ensure" }> => ({
    kind: "request", version: 2, requestId: `request-${operationId}`, type: "instance.ensure",
    params: { operationId, key: "reserved-key", cwd: "/tmp/reserved" },
  });
  const first = controller.ensureByKey(ensureRequest("ensure-first"), async () => {
    creationCalls += 1;
    creationStarted();
    await release;
    localOwner = { ...snapshot("main-reserved-owner", "main-epoch"), key: "reserved-key" };
    return { created: true, instance: localOwner };
  });
  await started;
  const second = controller.ensureByKey(ensureRequest("ensure-second"), async () => {
    creationCalls += 1;
    throw new Error("a same-key contender must not create another owner");
  });
  const remoteDuplicate = { ...snapshot("native-reservation-duplicate"), key: "reserved-key" };
  await internals.reconcileInventoryFromConnection(connection, [remoteDuplicate]);
  assert.equal((await state.get(machineId))?.routes[0]?.snapshot.key, undefined, "the in-flight Main placement owns the reservation");

  releaseCreation();
  const [created, existing] = await Promise.all([first, second]);
  assert.equal(creationCalls, 1);
  assert.equal(created.created, true);
  assert.equal(existing.created, false);
  assert.equal(existing.instance.id, created.instance.id);
  assert.equal((await controller.getByKey("reserved-key"))?.id, created.instance.id);
});

test("online-stop response generation tombstone survives reload, suppresses that generation, and releases for a newer reopen", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-retirement-generation-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { state, machineId } = await joinedState(root);
  const oldMainId = randomUUID();
  const nativeId = "native-retired-generation";
  const nativeGeneration = snapshotAtGeneration(nativeId, 3);
  const mappedGeneration = {
    ...nativeGeneration,
    id: oldMainId,
    ownerHostEpoch: "main-epoch",
    eventCursor: { ...nativeGeneration.eventCursor, hostEpoch: "main-epoch", instanceId: oldMainId },
  };
  await state.updateMachine(machineId, (machine) => {
    machine.routes = [{ mainInstanceId: oldMainId, nativeInstanceId: nativeId, snapshot: mappedGeneration }];
  });
  const machine = await state.get(machineId);
  assert.ok(machine);
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const fakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const connection = { machine, socket: fakeSocket as unknown as TLSSocket, hostEpoch: "subhost-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const stream = {
    streamId: "online-stop",
    machineId,
    connection,
    requestId: "online-stop",
    requestType: "instance.stop",
    route: { mainInstanceId: oldMainId, nativeInstanceId: nativeId, mainHostEpoch: "main-epoch", nativeHostEpoch: "subhost-epoch" },
    emit: async () => {}, ended: () => {}, helloSeen: true, acceptingInput: true,
    inputTail: Promise.resolve(), queuedInputBytes: 0,
  };
  const internals = controller as unknown as {
    connections: Map<string, unknown>;
    retireSuccessfulRouteMutation(candidate: unknown, response: unknown): Promise<void>;
  };
  internals.connections.set(machineId, connection);
  await internals.retireSuccessfulRouteMutation(stream, {
    kind: "response",
    ok: true,
    result: { instance: stoppedSnapshotAtGeneration(nativeId, 4) },
  });

  const reloaded = new MainMachineState(root);
  await reloaded.initialize();
  assert.deepEqual((await reloaded.get(machineId))?.retiredRoutes, [{ nativeInstanceId: nativeId, runtimeGeneration: 4 }]);
  const reloadedMachine = await reloaded.get(machineId);
  assert.ok(reloadedMachine);
  const reloadedController = new MainMachineController({ state: reloaded, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const reloadedConnection = { ...connection, machine: reloadedMachine, streams: new Map(), candidateOrdinal: 1, closed: false };
  const reloadedInternals = reloadedController as unknown as {
    completeInitialInventory(candidate: unknown, epoch: string, values: InstanceSnapshot[]): Promise<void>;
    reconcileInventoryFromConnection(candidate: unknown, values: InstanceSnapshot[]): Promise<void>;
  };

  await reloadedInternals.completeInitialInventory(reloadedConnection, "subhost-epoch", [snapshotAtGeneration(nativeId, 4)]);
  assert.equal((await reloaded.get(machineId))?.routes.length, 0);
  assert.deepEqual((await reloaded.get(machineId))?.retiredRoutes, [{ nativeInstanceId: nativeId, runtimeGeneration: 4 }]);

  await reloadedInternals.reconcileInventoryFromConnection(reloadedConnection, [snapshotAtGeneration(nativeId, 5)]);
  const reopened = await reloaded.get(machineId);
  assert.equal(reopened?.retiredRoutes.length, 0);
  assert.equal(reopened?.routes.length, 1);
  assert.notEqual(reopened?.routes[0]?.mainInstanceId, oldMainId);
  assert.equal(reopened?.routes[0]?.snapshot.runtimeGeneration, 5);
});

test("successful routed forget retires its Main route before success and stale inventory cannot restore it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-forget-retirement-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { state, machineId } = await joinedState(root);
  const machine = await state.get(machineId);
  assert.ok(machine);
  const mainInstanceId = randomUUID();
  const nativeInstanceId = "native-forgotten";
  const native = stoppedSnapshotAtGeneration(nativeInstanceId, 4);
  await state.updateMachine(machineId, (record) => {
    record.routes = [{
      mainInstanceId,
      nativeInstanceId,
      snapshot: { ...native, id: mainInstanceId, eventCursor: { ...native.eventCursor, hostEpoch: "main-epoch", instanceId: mainInstanceId } },
    }];
  });
  const currentMachine = await state.get(machineId);
  assert.ok(currentMachine);
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const socket = { destroyed: false, destroy(): void {} } as unknown as TLSSocket;
  const connection = { machine: currentMachine, socket, hostEpoch: "subhost-epoch", streams: new Map<string, unknown>(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  let emittedAfterRetirement = false;
  const stream = {
    streamId: "forget", machineId, connection, requestId: "forget", requestType: "instance.forget",
    route: { mainInstanceId, nativeInstanceId, mainHostEpoch: "main-epoch", nativeHostEpoch: "subhost-epoch" },
    emit: async () => { emittedAfterRetirement = (await state.get(machineId))?.routes.length === 0; },
    ended: () => {}, helloSeen: true, acceptingInput: true, inputTail: Promise.resolve(), queuedInputBytes: 0,
  };
  connection.streams.set(stream.streamId, stream);
  const internals = controller as unknown as {
    connections: Map<string, unknown>;
    mapRemoteStreamRecord(candidate: unknown, response: unknown): Promise<unknown[]>;
    emitMappedStreamRecords(candidate: unknown, records: readonly unknown[]): Promise<void>;
    reconcileInventoryFromConnection(candidate: unknown, values: InstanceSnapshot[]): Promise<void>;
  };
  internals.connections.set(machineId, connection);
  const records = await internals.mapRemoteStreamRecord(stream, {
    kind: "response", version: 2, requestId: "forget", hostEpoch: "subhost-epoch", ok: true,
    result: { receipt: { operationId: "forget-op", forgottenId: nativeInstanceId, previousLifecycle: "stopped", piSessionFilesDeleted: 0 } },
  });
  await internals.emitMappedStreamRecords(stream, records);
  assert.equal(emittedAfterRetirement, true);
  assert.equal((records[0] as { result: { receipt: { forgottenId: string } } }).result.receipt.forgottenId, mainInstanceId);
  assert.deepEqual((await state.get(machineId))?.retiredRoutes, [{ nativeInstanceId, runtimeGeneration: 4 }]);
  await internals.reconcileInventoryFromConnection(connection, [native]);
  assert.equal((await state.get(machineId))?.routes.length, 0);
});

test("malformed successful online-stop snapshots emit nothing and preserve routes without tombstones", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-malformed-online-stop-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { state, machineId } = await joinedState(root);
  const cases = [
    { name: "missing", instance: undefined },
    { name: "malformed", instance: { id: "native-malformed" } },
    { name: "wrong-native", instance: stoppedSnapshotAtGeneration("different-native", 4) },
    { name: "non-stopped", instance: snapshotAtGeneration("native-non-stopped", 4) },
  ] as const;
  const routes = cases.map((fixture) => {
    const nativeInstanceId = `native-${fixture.name}`;
    const mainInstanceId = randomUUID();
    const native = snapshotAtGeneration(nativeInstanceId, 3);
    return {
      mainInstanceId,
      nativeInstanceId,
      snapshot: {
        ...native,
        id: mainInstanceId,
        ownerHostEpoch: "main-epoch",
        eventCursor: { ...native.eventCursor, hostEpoch: "main-epoch", instanceId: mainInstanceId },
      },
    };
  });
  await state.updateMachine(machineId, (machine) => { machine.routes = routes; });
  const machine = await state.get(machineId);
  assert.ok(machine);
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const fakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const socket = fakeSocket as unknown as TLSSocket;
  const connection = { machine, socket, hostEpoch: "subhost-epoch", streams: new Map<string, unknown>(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const internals = controller as unknown as {
    connections: Map<string, unknown>;
    mapRemoteStreamRecord(candidate: unknown, response: unknown): Promise<unknown[]>;
    emitMappedStreamRecords(candidate: unknown, records: readonly unknown[]): Promise<void>;
  };
  internals.connections.set(machineId, connection);

  for (const [index, fixture] of cases.entries()) {
    let emitted = 0;
    const route = routes[index]!;
    const stream = {
      streamId: `malformed-stop-${fixture.name}`,
      machineId,
      connection,
      requestType: "instance.stop",
      route: { mainInstanceId: route.mainInstanceId, nativeInstanceId: route.nativeInstanceId, mainHostEpoch: "main-epoch", nativeHostEpoch: "subhost-epoch" },
      emit: async () => { emitted += 1; }, ended: () => {}, helloSeen: true, acceptingInput: true,
      inputTail: Promise.resolve(), queuedInputBytes: 0,
    };
    connection.streams.set(stream.streamId, stream);
    await assert.rejects(async () => {
      const mapped = await internals.mapRemoteStreamRecord(stream, {
        kind: "response",
        ok: true,
        result: fixture.instance === undefined ? {} : { instance: fixture.instance },
      });
      await internals.emitMappedStreamRecords(stream, mapped);
    });
    assert.equal(emitted, 0, fixture.name);
    const stored = await state.get(machineId);
    assert.equal(stored?.routes.some((item) => item.mainInstanceId === route.mainInstanceId), true, fixture.name);
    assert.equal(stored?.retiredRoutes.some((item) => item.nativeInstanceId === route.nativeInstanceId), false, fixture.name);
  }
});

test("concurrent response allocation, inventory reconcile, and disconnect preserve both stable routes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-route-race-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { state, machineId } = await joinedState(root);
  const machine = await state.get(machineId);
  assert.ok(machine);
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const fakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const connection = { machine, socket: fakeSocket as unknown as TLSSocket, hostEpoch: "subhost-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const internals = controller as unknown as {
    ensureRoute(candidate: unknown, value: InstanceSnapshot, epoch: string): Promise<{ mainInstanceId: string }>;
    reconcileInventoryFromConnection(candidate: unknown, values: InstanceSnapshot[]): Promise<void>;
    markOffline(id: string): Promise<void>;
    connections: Map<string, unknown>;
  };
  internals.connections.set(machineId, connection);
  const first = snapshot("native-first");
  const created = snapshot("native-created");
  const [route] = await Promise.all([
    internals.ensureRoute(connection, created, "subhost-epoch"),
    internals.reconcileInventoryFromConnection(connection, [first, created]),
    internals.markOffline(machineId),
  ]);
  const stored = await state.get(machineId);
  assert.deepEqual(new Set(stored?.routes.map((item) => item.nativeInstanceId)), new Set([first.id, created.id]));
  assert.equal(stored?.routes.find((item) => item.nativeInstanceId === created.id)?.mainInstanceId, route.mainInstanceId);
  assert.equal(stored?.routes.every((item) => item.snapshot.lifecycle === "host_lost"), true);
  assert.equal(controller.remoteSnapshotsCurrent().length, 2);
  assert.equal(controller.remoteSnapshotsCurrent().every((item) => item.lifecycle === "host_lost"), true);
});

test("replacement inventory installs before the old disconnect projection observes the machine", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-replacement-race-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const barrierState = new BarrierMainMachineState(root);
  const { state, machineId } = await joinedState(root, barrierState);
  const machine = await state.get(machineId);
  assert.ok(machine);
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const oldFakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const newFakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const oldSocket = oldFakeSocket as unknown as TLSSocket;
  const newSocket = newFakeSocket as unknown as TLSSocket;
  const oldConnection = { machine, socket: oldSocket, hostEpoch: "old-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const newConnection = { machine, socket: newSocket, hostEpoch: "new-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 2, closed: false };
  const internals = controller as unknown as {
    completeInitialInventory(candidate: unknown, epoch: string, values: InstanceSnapshot[]): Promise<void>;
    disconnect(candidate: unknown): void;
    reconcileInventoryFromConnection(candidate: unknown, values: InstanceSnapshot[]): Promise<void>;
    ensureRoute(candidate: unknown, value: InstanceSnapshot, epoch: string): Promise<{ mainInstanceId: string }>;
    connections: Map<string, unknown>;
    authorityTail: Promise<void>;
  };
  internals.connections.set(machineId, oldConnection);
  const gate = barrierState.armUpdateBarrier();
  const replacement = internals.completeInitialInventory(newConnection, "new-epoch", [snapshot("native-replacement", "new-epoch")]);
  await gate.started;
  const staleInventory = internals.reconcileInventoryFromConnection(oldConnection, [snapshot("native-stale-old", "old-epoch")]);
  const staleRoute = internals.ensureRoute(oldConnection, snapshot("native-stale-stream", "old-epoch"), "old-epoch").then(() => false, () => true);
  internals.disconnect(oldConnection);
  const disconnectProjection = internals.authorityTail;
  gate.release();
  await replacement;
  await Promise.all([staleInventory, disconnectProjection]);

  assert.equal(internals.connections.get(machineId), newConnection);
  assert.equal(await staleRoute, true);
  const stored = await state.get(machineId);
  assert.deepEqual(stored?.routes.map((item) => item.nativeInstanceId), ["native-replacement"]);
  assert.equal(stored?.routes[0]?.snapshot.lifecycle, "active");
  assert.equal(controller.remoteSnapshotsCurrent()[0]?.lifecycle, "active");
});

test("an older initial candidate cannot replace a newer installed generation before or after disconnect", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-candidate-order-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { state, machineId } = await joinedState(root);
  const machine = await state.get(machineId);
  assert.ok(machine);
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const oldFakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const newFakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const oldSocket = oldFakeSocket as unknown as TLSSocket;
  const newSocket = newFakeSocket as unknown as TLSSocket;
  const oldCandidate = { machine, socket: oldSocket, hostEpoch: "old-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const newerCandidate = { machine, socket: newSocket, hostEpoch: "new-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 2, closed: false };
  const internals = controller as unknown as {
    completeInitialInventory(candidate: unknown, epoch: string, values: InstanceSnapshot[]): Promise<void>;
    disconnect(candidate: unknown): void;
    authorityTail: Promise<void>;
    connections: Map<string, unknown>;
  };

  await internals.completeInitialInventory(newerCandidate, "new-epoch", [snapshot("native-newer", "new-epoch")]);
  const installed = await state.get(machineId);
  const installedMainId = installed?.routes[0]?.mainInstanceId;
  assert.ok(installedMainId);
  await assert.rejects(
    internals.completeInitialInventory(oldCandidate, "old-epoch", [snapshot("native-older", "old-epoch")]),
    /newer machine connection became ready/u,
  );
  assert.equal(internals.connections.get(machineId), newerCandidate);
  assert.equal(newFakeSocket.destroyed, false);
  assert.equal((await state.get(machineId))?.routes[0]?.nativeInstanceId, "native-newer");

  internals.disconnect(newerCandidate);
  const disconnected = internals.authorityTail;
  await disconnected;
  await assert.rejects(
    internals.completeInitialInventory(oldCandidate, "old-epoch", [snapshot("native-older", "old-epoch")]),
    /newer machine connection became ready/u,
  );
  assert.equal(internals.connections.has(machineId), false);
  const finalState = await state.get(machineId);
  assert.equal(finalState?.routes.length, 1);
  assert.equal(finalState?.routes[0]?.nativeInstanceId, "native-newer");
  assert.equal(finalState?.routes[0]?.mainInstanceId, installedMainId);
  assert.equal(finalState?.routes[0]?.snapshot.lifecycle, "host_lost");
});

test("routed response transfer enforces the canonical 512-frame and 512 KiB parser bounds", async () => {
  const controller = new MainMachineController({ state: new MainMachineState(join(tmpdir(), `alu-transfer-${randomUUID()}`)), port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const stream = {
    streamId: "transfer", machineId: "machine", connection: {}, requestId: "transfer-request", requestType: "session.tree",
    route: { mainInstanceId: "main", nativeInstanceId: "native", mainHostEpoch: "main-epoch", nativeHostEpoch: "native-epoch" },
    emit: async () => {}, ended: () => {}, helloSeen: true, acceptingInput: true, inputTail: Promise.resolve(), queuedInputBytes: 0,
  };
  const internals = controller as unknown as { mapRemoteStreamRecord(candidate: unknown, response: unknown): Promise<unknown[]> };
  const frame = (data: string, count = 1) => ({ kind: "response_transfer", version: 2, requestId: "transfer-request", hostEpoch: "native-epoch", index: 0, count, data });
  await assert.rejects(internals.mapRemoteStreamRecord(stream, frame("e30=", 513)), /outside its bound/u);
  await assert.rejects(internals.mapRemoteStreamRecord(stream, frame("YQ")), /canonical bounded base64/u);
  await assert.rejects(internals.mapRemoteStreamRecord(stream, frame("AAAA".repeat(174_763))), /canonical bounded base64/u);
});

test("a mapped response from a replaced connection ends without emitting success", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-stale-response-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { state, machineId } = await joinedState(root);
  const machine = await state.get(machineId);
  assert.ok(machine);
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const oldSocket = { destroyed: true } as unknown as TLSSocket;
  const newSocket = { destroyed: false } as unknown as TLSSocket;
  const oldConnection = { machine, socket: oldSocket, hostEpoch: "old-epoch", streams: new Map<string, unknown>(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const newConnection = { machine, socket: newSocket, hostEpoch: "new-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 2, closed: false };
  let emitted = 0;
  let ended = 0;
  const stream = {
    streamId: "stale-stream",
    machineId,
    connection: oldConnection,
    requestType: "instance.get",
    route: { mainInstanceId: "", nativeInstanceId: "", mainHostEpoch: "main-epoch", nativeHostEpoch: "old-epoch" },
    emit: async () => { emitted += 1; },
    ended: () => { ended += 1; },
    helloSeen: true,
    acceptingInput: true,
    inputTail: Promise.resolve(),
    queuedInputBytes: 0,
  };
  oldConnection.streams.set(stream.streamId, stream);
  const internals = controller as unknown as {
    connections: Map<string, unknown>;
    emitMappedStreamRecords(candidate: unknown, records: readonly unknown[]): Promise<void>;
  };
  internals.connections.set(machineId, newConnection);

  await assert.rejects(internals.emitMappedStreamRecords(stream, [{ kind: "response", ok: true }, { kind: "response_transfer" }]), /replaced before its routed response/u);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(emitted, 0);
  assert.equal(ended, 1);
  assert.equal(oldConnection.streams.has(stream.streamId), false);
});

test("closing during initial inventory cannot install a dead connection or leave active routes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-initial-close-race-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const barrierState = new BarrierMainMachineState(root);
  const { state, machineId } = await joinedState(root, barrierState);
  const machine = await state.get(machineId);
  assert.ok(machine);
  const controller = new MainMachineController({ state, port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const fakeSocket = { destroyed: false, destroy(): void { this.destroyed = true; } };
  const socket = fakeSocket as unknown as TLSSocket;
  const connection = { machine, socket, hostEpoch: "subhost-epoch", streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: 1, closed: false };
  const internals = controller as unknown as {
    completeInitialInventory(candidate: unknown, epoch: string, values: InstanceSnapshot[]): Promise<void>;
    disconnect(candidate: unknown): void;
    connections: Map<string, unknown>;
    authorityTail: Promise<void>;
  };
  const gate = barrierState.armUpdateBarrier();
  const completion = internals.completeInitialInventory(connection, "subhost-epoch", [snapshot("native-initial")]);
  await gate.started;
  internals.disconnect(connection);
  const disconnected = internals.authorityTail;
  gate.release();
  await assert.rejects(completion, /closed during initial inventory/u);
  await disconnected;

  assert.equal(internals.connections.has(machineId), false);
  const stored = await state.get(machineId);
  assert.equal(stored?.routes.length, 1);
  assert.equal(stored?.routes[0]?.snapshot.lifecycle, "host_lost");
  assert.equal(controller.remoteSnapshotsCurrent().length, 1);
  assert.equal(controller.remoteSnapshotsCurrent()[0]?.lifecycle, "host_lost");
});

test("raw handshake sockets stay bounded, admit the newest candidate, and cannot hold stop open", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-raw-admission-"));
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "::1", resolve); });
  const address = portServer.address();
  if (!address || typeof address === "string") throw new Error("test port is unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const controller = new MainMachineController({ state: new MainMachineState(join(root, "main")), port, bindAddress: "::1", mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  await controller.start();
  const clients: Socket[] = [];
  context.after(async () => { for (const client of clients) client.destroy(); await controller.stop(); await rm(root, { recursive: true, force: true }); });
  const openRaw = (): Promise<Socket> => new Promise((resolve, reject) => {
    const client = createConnection({ host: "::1", port });
    client.on("error", () => {});
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
  for (let index = 0; index < MAX_MACHINE_CONNECTIONS; index += 1) clients.push(await openRaw());
  const firstClosed = new Promise<void>((resolve) => clients[0]!.once("close", () => resolve()));
  const newest = await openRaw();
  clients.push(newest);
  await firstClosed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const internals = controller as unknown as { acceptedSockets: Map<string, { raw: Socket }> };
  assert.equal(internals.acceptedSockets.size, MAX_MACHINE_CONNECTIONS);
  assert.equal([...internals.acceptedSockets.values()].some((entry) => entry.raw.remotePort === newest.localPort), true);

  const accepted = [...internals.acceptedSockets.values()];
  const stopping = controller.stop();
  assert.equal(accepted.every((entry) => entry.raw.destroyed), true);
  await stopping;
  assert.equal(internals.acceptedSockets.size, 0);
});

test("stop destroys an accepted socket while its initial inventory is still pre-ready", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-stop-pre-ready-"));
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "::1", resolve); });
  const address = portServer.address();
  if (!address || typeof address === "string") throw new Error("test port is unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const barrierState = new BarrierMainMachineState(join(root, "main"));
  await joinedState(join(root, "main"), barrierState);
  const controller = new MainMachineController({ state: barrierState, port, bindAddress: "::1", mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  await controller.start();
  const gate = barrierState.armUpdateBarrier();
  const upstream = new SubHostMachineConnection({
    state: new SubHostMachineState(join(root, "main", "sub")),
    address: "::1",
    port,
    hostEpoch: "subhost-epoch",
    snapshots: () => [snapshot("native-pre-ready")],
    acceptProtocolSocket: (socket) => socket.destroy(),
  });
  context.after(async () => { gate.release(); await upstream.stop(); await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await upstream.start();
  await gate.started;
  const internals = controller as unknown as { acceptedSockets: Map<string, { raw: { destroyed: boolean } }> };
  const accepted = [...internals.acceptedSockets.values()];
  assert.equal(accepted.length, 1);

  const stopping = controller.stop();
  assert.equal(accepted.every((entry) => entry.raw.destroyed), true);
  gate.release();
  await stopping;
  assert.equal(internals.acceptedSockets.size, 0);
});

test("admission deadline closes a TLS connection stalled in initial inventory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-admission-deadline-"));
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "::1", resolve); });
  const address = portServer.address();
  if (!address || typeof address === "string") throw new Error("test port is unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const barrierState = new BarrierMainMachineState(join(root, "main"));
  await joinedState(join(root, "main"), barrierState);
  const controller = new MainMachineController({ state: barrierState, port, bindAddress: "::1", mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  await controller.start();
  const gate = barrierState.armUpdateBarrier();
  const upstream = new SubHostMachineConnection({
    state: new SubHostMachineState(join(root, "main", "sub")),
    address: "::1",
    port,
    hostEpoch: "subhost-epoch",
    snapshots: () => [snapshot("native-admission-timeout")],
    acceptProtocolSocket: (socket) => socket.destroy(),
  });
  context.after(async () => { gate.release(); await upstream.stop(); await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await upstream.start();
  await gate.started;
  const internals = controller as unknown as {
    acceptedSockets: Map<string, { phase: "handshake" | "admission" | "ready"; raw: Socket; tls?: TLSSocket }>;
    expireAcceptedSocket(candidate: unknown, phase: "handshake" | "admission" | "ready"): void;
  };
  const accepted = [...internals.acceptedSockets.values()];
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]?.phase, "admission");
  internals.expireAcceptedSocket(accepted[0], "admission");
  assert.equal(accepted[0]?.raw.destroyed, true);
  assert.equal(accepted[0]?.tls?.destroyed, true);
  assert.equal(internals.acceptedSockets.size, 0);
  gate.release();
  await controller.stop();
});

test("a stalled flooded stream resets alone while heartbeat and another stream retain protected progress", async () => {
  class StalledSocket extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    readonly writes: Buffer[] = [];
    write(bytes: Buffer): boolean { this.writes.push(Buffer.from(bytes)); return false; }
  }
  const socket = new StalledSocket();
  const tlsSocket = socket as unknown as TLSSocket;
  const settleTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  let rejected = 0;
  const flood = Array.from({ length: 6 }, () => writeMachine(tlsSocket, {
    kind: "machine_stream_data",
    streamId: "offender",
    data: "x".repeat(900_000),
  }).then(() => "sent", () => { rejected += 1; return "reset"; }));
  await settleTurn();
  assert.ok(rejected > 0, "the offending stream must hit its own output bound while TLS is stalled");

  const heartbeat = writeMachine(tlsSocket, { kind: "machine_ping" });
  const unrelated = writeMachine(tlsSocket, { kind: "machine_stream_data", streamId: "unrelated", data: "still-usable" });
  for (let index = 0; index < 4; index += 1) { socket.emit("drain"); await settleTurn(); }
  await Promise.all([heartbeat, unrelated, ...flood]);

  const records = socket.writes.map((bytes) => JSON.parse(bytes.toString("utf8")) as { kind: string; streamId?: string });
  assert.deepEqual(records.slice(1, 4).map((record) => [record.kind, record.streamId]), [
    ["machine_stream_reset", "offender"],
    ["machine_ping", undefined],
    ["machine_stream_data", "unrelated"],
  ]);
  assert.equal(records.filter((record) => record.kind === "machine_stream_reset" && record.streamId === "offender").length, 1);
  assert.equal(records.some((record) => record.kind === "machine_stream_reset" && record.streamId === "unrelated"), false);

  const gracefulSocket = new StalledSocket();
  const gracefulTls = gracefulSocket as unknown as TLSSocket;
  const gracefulWrites = [
    writeMachine(gracefulTls, { kind: "machine_stream_data", streamId: "graceful", data: "first" }),
    writeMachine(gracefulTls, { kind: "machine_stream_data", streamId: "graceful", data: "second" }),
    writeMachine(gracefulTls, { kind: "machine_stream_close", streamId: "graceful" }),
    writeMachine(gracefulTls, { kind: "machine_ping" }),
  ];
  for (let index = 0; index < 4; index += 1) { gracefulSocket.emit("drain"); await settleTurn(); }
  await Promise.all(gracefulWrites);
  assert.deepEqual(gracefulSocket.writes.map((bytes) => {
    const record = JSON.parse(bytes.toString("utf8")) as { kind: string; data?: string };
    return [record.kind, record.data];
  }), [
    ["machine_stream_data", "first"],
    ["machine_ping", undefined],
    ["machine_stream_data", "second"],
    ["machine_stream_close", undefined],
  ]);

  const resetSocket = new StalledSocket();
  const resetTls = resetSocket as unknown as TLSSocket;
  const active = writeMachine(resetTls, { kind: "machine_stream_data", streamId: "explicit-reset", data: "accepted" });
  let cancelled = false;
  const stale = writeMachine(resetTls, { kind: "machine_stream_data", streamId: "explicit-reset", data: "stale" }).catch(() => { cancelled = true; });
  const explicitReset = writeMachine(resetTls, { kind: "machine_stream_reset", streamId: "explicit-reset", reason: "cancelled" });
  const resetHeartbeat = writeMachine(resetTls, { kind: "machine_ping" });
  const resetUnrelated = writeMachine(resetTls, { kind: "machine_stream_data", streamId: "reset-unrelated", data: "usable" });
  await settleTurn();
  assert.equal(cancelled, true);
  for (let index = 0; index < 4; index += 1) { resetSocket.emit("drain"); await settleTurn(); }
  await Promise.all([active, stale, explicitReset, resetHeartbeat, resetUnrelated]);
  assert.deepEqual(resetSocket.writes.map((bytes) => {
    const record = JSON.parse(bytes.toString("utf8")) as { kind: string; streamId?: string; data?: string };
    return [record.kind, record.streamId, record.data];
  }), [
    ["machine_stream_data", "explicit-reset", "accepted"],
    ["machine_stream_reset", "explicit-reset", undefined],
    ["machine_ping", undefined, undefined],
    ["machine_stream_data", "reset-unrelated", "usable"],
  ]);
});

test("SubHost file delivery remains local while Main is offline", async () => {
  let delivered = false;
  const local = {
    dockToolsEnabled: () => true,
    configureDockTools: async () => ({ enabled: true }),
    invokeDockTool: async (_source: string, request: { type: string }) => { delivered = request.type === "deliver"; return { type: "deliver" as const, deliverable: { deliveryRef: "delivery", name: "file.txt", sizeBytes: 1 } }; },
    attachObservationSink: () => () => {},
  } as DockToolsHostPort;
  const upstream = { invokeDockTool: async () => { throw new Error("Main offline"); } } as unknown as SubHostMachineConnection;
  const port = new SubHostDockToolsPort({ upstream, local: () => local });
  const result = await port.invokeDockTool("native", { type: "deliver", path: "/tmp/file.txt" });
  assert.equal(result.type, "deliver");
  assert.equal(delivered, true);
});
