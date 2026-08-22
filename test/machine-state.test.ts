import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TLSSocket } from "node:tls";

import type { DockToolsHostPort } from "../src/core/dock-tools.js";
import type { InstanceSnapshot } from "../src/core/managed-instance.js";
import { MainMachineState, SubHostMachineState, writeMachineJoinFile } from "../src/control/machine-state.js";
import { MachineMutationEffectUnknownError, MainMachineController, SubHostDockToolsPort, SubHostMachineConnection, writeMachine } from "../src/control/machine-transport.js";
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
  await assert.rejects(sub.prepare(joinFile, "Studio"));
  await assert.rejects(main.acceptJoin({ token: joinFile.token, machineId: pending.machineId, machineName: pending.machineName, certificatePem: pending.identity.certificatePem }));
});

test("Main creates a join file from the Hub while its running authority accepts the same enrollment", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-live-join-"));
  try {
    const runningAuthority = new MainMachineState(join(root, "main"));
    await runningAuthority.initialize();
    const hubState = new MainMachineState(join(root, "main"));
    const joinFile = await hubState.createJoin();
    const sub = new SubHostMachineState(join(root, "sub"));
    const pending = await sub.prepare(joinFile, "Studio");
    const accepted = await runningAuthority.acceptJoin({
      token: joinFile.token,
      machineId: pending.machineId,
      machineName: pending.machineName,
      certificatePem: pending.identity.certificatePem,
    });
    assert.equal(accepted.id, pending.machineId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removing a SubHost revokes trust and a later rejoin cannot restore its old routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-remove-"));
  try {
    const { state, machineId } = await joinedState(join(root, "main"));
    const trusted = await state.get(machineId);
    assert.ok(trusted);
    const mainInstanceId = randomUUID();
    await state.updateMachine(machineId, (machine) => {
      machine.routes.push({ mainInstanceId, nativeInstanceId: randomUUID(), snapshot: snapshot(mainInstanceId) });
    });

    assert.equal(await state.removeMachine(machineId), true);
    assert.equal(await state.removeMachine(machineId), false);
    assert.equal(await state.get(machineId), undefined);
    assert.deepEqual(await new MainMachineState(join(root, "main")).list(), []);

    const joinFile = await state.createJoin();
    const rejoined = await state.acceptJoin({
      token: joinFile.token,
      machineId,
      machineName: trusted.name,
      certificatePem: trusted.certificatePem,
    });
    assert.deepEqual(rejoined.routes, []);
    assert.deepEqual(rejoined.retiredRoutes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("a SubHost request ending before response leaves a mutation unconfirmed while a read remains retryable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-interrupted-request-"));
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "::1", resolve); });
  const address = portServer.address();
  if (!address || typeof address === "string") throw new Error("test port is unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));

  const mainState = new MainMachineState(join(root, "main"));
  const joinFile = await mainState.createJoin();
  const subState = new SubHostMachineState(join(root, "sub"));
  await subState.prepare(joinFile, "Interrupted Request SubHost");
  const remote = snapshot("native-interrupted");
  const controller = new MainMachineController({ state: mainState, port, bindAddress: "::1", mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const upstream = new SubHostMachineConnection({
    state: subState,
    address: "::1",
    port,
    hostEpoch: "subhost-epoch",
    snapshots: () => [remote],
    acceptProtocolSocket: (socket) => socket.destroy(),
  });
  context.after(async () => { await upstream.stop(); await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await controller.start();
  await upstream.start();
  for (let attempt = 0; attempt < 400 && controller.remoteSnapshotsCurrent().length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const mainInstanceId = controller.remoteSnapshotsCurrent()[0]?.id;
  assert.ok(mainInstanceId);

  await assert.rejects(
    controller.requestRemote({ kind: "request", version: 2, requestId: "stop-request", type: "instance.stop", params: { instanceId: mainInstanceId, operationId: "stop-operation" } }),
    (error: unknown) => error instanceof MachineMutationEffectUnknownError && error.operationId === "stop-operation",
  );
  await assert.rejects(
    controller.requestRemote({ kind: "request", version: 2, requestId: "read-request", type: "instance.get", params: { instanceId: mainInstanceId } }),
    (error: unknown) => error instanceof Error && !(error instanceof MachineMutationEffectUnknownError),
  );
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

test("routed response transfer applies the public frame-count safety boundary", async () => {
  const controller = new MainMachineController({ state: new MainMachineState(join(tmpdir(), `alu-transfer-${randomUUID()}`)), port: 0, mainHostEpoch: "main-epoch", localSnapshots: () => [] });
  const stream = {
    streamId: "transfer", machineId: "machine", connection: {}, requestId: "transfer-request", requestType: "session.tree",
    route: { mainInstanceId: "main", nativeInstanceId: "native", mainHostEpoch: "main-epoch", nativeHostEpoch: "native-epoch" },
    emit: async () => {}, ended: () => {}, helloSeen: true, acceptingInput: true, inputTail: Promise.resolve(), queuedInputBytes: 0,
  };
  const internals = controller as unknown as { mapRemoteStreamRecord(candidate: unknown, response: unknown): Promise<unknown[]> };
  const frame = (data: string, count = 1) => ({ kind: "response_transfer", version: 2, requestId: "transfer-request", hostEpoch: "native-epoch", index: 0, count, data });
  await assert.rejects(internals.mapRemoteStreamRecord(stream, frame("e30=", 513)));
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
  clients.push(await openRaw());
  const firstClosed = new Promise<void>((resolve) => clients[0]!.once("close", () => resolve()));
  for (let index = 1; index < 80; index += 1) clients.push(await openRaw());
  await firstClosed;
  const newest = clients.at(-1)!;
  assert.equal(newest.destroyed, false);

  const closed = clients.map((client) => client.destroyed
    ? Promise.resolve()
    : new Promise<void>((resolve) => client.once("close", () => resolve())));
  await controller.stop();
  await Promise.all(closed);
  assert.equal(clients.every((client) => client.destroyed), true);
});

test("an idle handshake expires while the machine listener stays available", { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-handshake-deadline-"));
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
    clients.push(client);
    client.on("error", () => {});
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });

  const idle = await openRaw();
  await new Promise<void>((resolve) => idle.once("close", () => resolve()));
  assert.equal(idle.destroyed, true);

  const next = await openRaw();
  assert.equal(next.destroyed, false);
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
  assert.ok(records.some((record) => record.kind === "machine_stream_reset" && record.streamId === "offender"));
  assert.ok(records.some((record) => record.kind === "machine_ping"));
  assert.ok(records.some((record) => record.kind === "machine_stream_data" && record.streamId === "unrelated"));
  assert.equal(records.some((record) => record.kind === "machine_stream_reset" && record.streamId === "unrelated"), false);
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
