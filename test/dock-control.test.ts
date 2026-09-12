import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/control/json-lines.js";
import { ProjectTrustCoordinator } from "../src/control/project-trust.js";
import { ExtensionUiBroker, InteractionLifecycleCancelledError } from "../src/core/extension-ui-broker.js";
import { ManagedInstance, type DockEvent, type SessionDto } from "../src/core/managed-instance.js";
import type { SettingUpdate } from "../src/core/config-projection.js";
import { MAX_STOP_CLEANUP_ERROR_CHARS } from "../src/core/instance-dto.js";
import { AgentInvalidSettingValueError, type AgentHistoryEntry, type AgentPromptOptions } from "../src/core/agent-worker.js";
import { TransientFileRegistry } from "../src/pi/transient-file-registry.js";
import { mouseTrackingSequences } from "../src/tui/mouse-input.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";
import { ScriptedCatalogCommitPort } from "./support/scripted-catalog-port.js";
import { ptyUserEnvironment } from "./support/pty-user-environment.js";

interface Harness {
  directory: string;
  socketPath: string;
  host: DockHost;
  registry: DockRegistry;
  sessions: Map<string, DelayedAgentWorkerConnection>;
}

function agentRecord(
  entryId: string,
  source: AgentHistoryEntry["source"],
  content: AgentHistoryEntry["content"],
  overrides: Partial<AgentHistoryEntry> = {},
): AgentHistoryEntry {
  return {
    recordId: entryId,
    entryId,
    kind: "message",
    source,
    visibility: "conversation",
    content,
    ...overrides,
  };
}

class NoRunAgentWorkerConnection extends DelayedAgentWorkerConnection {
  override prompt(text: string, options?: AgentPromptOptions): Promise<void> {
    this.promptCalls += 1;
    this.promptMessages.push(text);
    options?.preflightResult?.(true);
    return Promise.resolve();
  }
}

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-control-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessions = new Map<string, DelayedAgentWorkerConnection>();
  let sequence = 0;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, key, name }) => {
    const session = new DelayedAgentWorkerConnection(`pi-${id}`);
    sessions.set(id, session);
    const modelState = session.getModelState();
    const instance = new ManagedInstance({
      id, creationOperationId, hostEpoch, cwd, key, name, session, eventCapacity: 500,
      executor: { kind: "fixture", model: modelState.model, thinkingLevel: modelState.thinkingLevel },
    });
    await instance.submit("deterministic delayed task");
    return instance;
  }, () => `instance-${++sequence}`);
  const host = new DockHost({ socketPath, registry });
  return { directory, socketPath, host, registry, sessions };
}

async function cleanupHarness(harness: Harness): Promise<void> {
  await harness.host.stop().catch(() => {});
  await rm(harness.directory, { recursive: true, force: true });
}

test("workspace.list browses the Host filesystem without creating a Dock instance", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-workspace-list-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const target = join(directory, "target");
  await Promise.all([
    mkdir(join(directory, ".hidden")),
    mkdir(join(directory, "regular")),
    mkdir(target),
    writeFile(join(directory, "plain.txt"), "not a folder\n", "utf8"),
  ]);
  await Promise.all([
    symlink(target, join(directory, "linked"), "dir"),
    symlink(join(directory, "missing"), join(directory, "broken"), "dir"),
  ]);
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedAgentWorkerConnection(`pi-${id}`) })
  ));
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });

  const entries = [];
  let page = await client.workspaceList(directory, undefined, 2);
  const canonicalRoot = await realpath(directory);
  assert.equal(page.path, canonicalRoot);
  assert.equal(page.parent, join(canonicalRoot, ".."));
  entries.push(...page.entries);
  while (page.nextCursor) {
    page = await client.workspaceList(directory, page.nextCursor, 2);
    entries.push(...page.entries);
  }
  assert.deepEqual(entries.map((entry) => entry.name), [".hidden", "broken", "linked", "regular", "target"]);
  assert.equal(entries.find((entry) => entry.name === ".hidden")?.hidden, true);
  assert.equal(entries.find((entry) => entry.name === "linked")?.kind, "symlink");
  assert.equal(entries.some((entry) => entry.name === "plain.txt"), false);

  assert.equal((await client.workspaceList(join(directory, "linked"))).path, await realpath(target));
  assert.equal((await client.workspaceList(join(directory, ".hidden"))).path, await realpath(join(directory, ".hidden")));
  await assert.rejects(
    client.workspaceList(join(directory, "missing")),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "workspace_not_found"
      && /no longer exists/u.test(error.message),
  );
  assert.deepEqual(registry.list(), []);
});

async function createTransactionHarness(port: ScriptedCatalogCommitPort, faultDrainTimeoutMs = 2_000): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-transaction-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessions = new Map<string, DelayedAgentWorkerConnection>();
  let sequence = 0;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, key, name }) => {
    const session = new DelayedAgentWorkerConnection(`pi-${id}`);
    sessions.set(id, session);
    const modelState = session.getModelState();
    return new ManagedInstance({
      id, creationOperationId, hostEpoch, cwd, key, name, session, eventCapacity: 500,
      executor: { kind: "fixture", model: modelState.model, thinkingLevel: modelState.thinkingLevel },
    });
  }, () => `transaction-${++sequence}`, { catalogCommitPort: port });
  const host = new DockHost({ socketPath, registry, faultDrainTimeoutMs });
  await host.start();
  return { directory, socketPath, host, registry, sessions };
}



test("project trust challenge precedes factory effects and denial continues untrusted", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-trust-host-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const trustedValues: boolean[] = [];
  let factoryCalls = 0;
  const trust = new ProjectTrustCoordinator({
    requiresTrust: () => true,
    savedDecision: () => null,
    defaultDecision: () => "ask",
    remember: () => assert.fail("deny_once must not write trust store"),
  }, { createId: () => "challenge-1", now: () => 1_000 });
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, projectTrusted }) => {
    factoryCalls += 1;
    trustedValues.push(projectTrusted);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedAgentWorkerConnection(`pi-${id}`) });
  }, () => "trusted-instance", { trustPreflight: trust });
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });

  let challenge: ControlClientError | undefined;
  try {
    await client.create(directory, "project", "trust-operation");
  } catch (error) {
    assert.ok(error instanceof ControlClientError);
    challenge = error;
  }
  assert.equal(challenge?.code, "project_trust_required");
  assert.equal(challenge?.operationId, "trust-operation");
  assert.equal(challenge?.details?.challengeId, "challenge-1");
  assert.equal(challenge?.details?.operationId, "trust-operation");
  assert.equal(factoryCalls, 0);
  assert.deepEqual(registry.list(), []);

  await assert.rejects(
    client.create(directory, "changed-target", "trust-operation", {
      challengeId: "challenge-1",
      decision: "deny_once",
    }),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_project_trust_challenge",
  );
  assert.equal(factoryCalls, 0);

  const created = await client.create(directory, "project", "trust-operation", {
    challengeId: "challenge-1",
    decision: "deny_once",
  });
  assert.equal(created.id, "trusted-instance");
  assert.deepEqual(trustedValues, [false]);
  assert.equal(factoryCalls, 1);

  const duplicate = await client.create(directory, "project", "trust-operation", {
    challengeId: "challenge-1",
    decision: "deny_once",
  });
  assert.equal(duplicate.id, created.id);
  assert.equal(factoryCalls, 1);
});



test("Extension UI operation uses live latest takeover without closing observation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-extension-ui-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const broker = new ExtensionUiBroker();
  let widgetViewport: { width: number; height: number } | undefined;
  broker.bindWidgetRenderer({
    render: (viewport) => { widgetViewport = viewport; },
    reset: () => { widgetViewport = undefined; },
  });
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session, extensionUiBroker: broker });
  }, () => "extension-ui-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const clientA = new DockClient({ socketPath });
  const clientB = new DockClient({ socketPath });
  const instance = await clientA.create(directory, "extension-ui");

  const observedA: DockEvent[] = [];
  const followerA = await clientA.streamEvents(instance.id, {
    onEvent: (event) => { observedA.push(event); },
    requireTuiProjection: true,
  });
  const managed = registry.get(instance.id);
  const isInteractionControllerCurrent = managed.isInteractionControllerCurrent.bind(managed);
  let invalidateFirstClaim = true;
  managed.isInteractionControllerCurrent = (leaseToken, runtimeGeneration) => {
    if (invalidateFirstClaim) {
      invalidateFirstClaim = false;
      return false;
    }
    return isInteractionControllerCurrent(leaseToken, runtimeGeneration);
  };
  await assert.rejects(
    clientA.controlExtensionUi(instance.id, () => {}),
    (error: unknown) => error instanceof ControlClientError && error.code === "interaction_unavailable",
  );
  const operationEventsA: DockEvent[] = [];
  const operationA = await clientA.controlExtensionUi(instance.id, (event) => { operationEventsA.push(event); });
  assert.notEqual(operationA.initial.leaseToken, operationA.initial.controllerId);
  await clientA.setExtensionWidgetViewport(instance.id, operationA.initial.leaseToken, instance.runtimeGeneration, 96, 32);
  assert.deepEqual(widgetViewport, { width: 96, height: 32 });

  broker.setTitle("Operator A title");
  broker.setEditorText("Operator A draft");
  const directiveDeadline = Date.now() + 2_000;
  while (operationEventsA.filter((event) => event.type === "extension.title_set" || event.type === "extension.editor_text_set").length < 2
    && Date.now() < directiveDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(operationEventsA.some((event) => event.type === "extension.title_set" && event.data.controllerId === operationA.initial.controllerId), true);
  assert.equal(observedA.some((event) => event.type === "extension.title_set" || event.type === "extension.editor_text_set"), false);
  assert.equal((await clientA.read(instance.id)).page.events.some((event) => event.type === "extension.title_set" || event.type === "extension.editor_text_set"), false);

  const pending = broker.confirm("Delete?", "This cannot be undone");
  const requestDeadline = Date.now() + 2_000;
  while (!operationEventsA.some((event) => event.type === "interaction.requested") && Date.now() < requestDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const requestA = operationEventsA.find((event): event is Extract<DockEvent, { type: "interaction.requested" }> => event.type === "interaction.requested");
  assert.ok(requestA);
  assert.equal(requestA.data.controllerId, operationA.initial.controllerId);
  assert.equal(observedA.some((event) => event.type === "interaction.requested"), false);

  const operationEventsB: DockEvent[] = [];
  const operationB = await clientB.controlExtensionUi(instance.id, (event) => { operationEventsB.push(event); });
  await operationA.done;
  assert.notEqual(operationB.initial.leaseToken, operationA.initial.leaseToken);
  assert.notEqual(operationB.initial.controllerId, operationA.initial.controllerId);
  const takeoverDeadline = Date.now() + 2_000;
  while (!operationEventsB.some((event) => event.type === "interaction.requested") && Date.now() < takeoverDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const requestB = operationEventsB.find((event): event is Extract<DockEvent, { type: "interaction.requested" }> => event.type === "interaction.requested");
  assert.ok(requestB);
  assert.equal(requestB.data.interactionId, requestA.data.interactionId, "the same pending interaction survives takeover");
  assert.equal(requestB.data.controllerId, operationB.initial.controllerId);
  await assert.rejects(
    clientA.respondInteraction(instance.id, operationA.initial.leaseToken, requestA.data.interactionId, { method: "confirm", confirmed: true }),
    (error: unknown) => error instanceof ControlClientError && error.code === "interaction_wrong_lease",
  );
  assert.deepEqual(
    await clientB.respondInteraction(instance.id, operationB.initial.leaseToken, requestB.data.interactionId, { method: "confirm", confirmed: true }, "respond-after-takeover"),
    { interactionId: requestB.data.interactionId, state: "resolved" },
  );
  assert.equal(await pending, true);

  broker.notify("observation remains live");
  const observationDeadline = Date.now() + 2_000;
  while (!observedA.some((event) => event.type === "extension.notification" && event.data.message === "observation remains live")
    && Date.now() < observationDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(observedA.some((event) => event.type === "interaction.resolved" && event.data.interactionId === requestA.data.interactionId), true);
  assert.equal(observedA.some((event) => event.type === "extension.notification" && event.data.message === "observation remains live"), true, "A's follower remains open after B takes operation authority");

  await assert.rejects(
    clientB.respondInteraction(instance.id, operationB.initial.leaseToken, "not-sent", { method: "editor", value: "x".repeat(256_001) }, "oversized-response"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_request",
  );
  operationB.close();
  followerA.close();
  await Promise.all([operationB.done, followerA.done]);

  const hostDrainInteraction = broker.confirm("Host drain", "Do not synthesize a denial.")
    .then((value) => ({ status: "resolved" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await host.stop();
  const hostDrainOutcome = await hostDrainInteraction;
  assert.equal(hostDrainOutcome.status, "rejected");
  if (hostDrainOutcome.status === "rejected") {
    assert.equal(hostDrainOutcome.error instanceof InteractionLifecycleCancelledError
      && hostDrainOutcome.error.reason === "host_draining", true);
  }
});

test("SSH TUI controller completes select confirm input and editor extension dialogs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-extension-pty-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const readyFile = join(directory, "dialog.ready");
  const broker = new ExtensionUiBroker();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session, extensionUiBroker: broker });
  }, () => "extension-pty-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, "extension-pty");
  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", instance.id,
  ], "extension-dialogs", readyFile);
  await waitForPath(readyFile);

  broker.setTitle("PTY extension title");
  broker.setEditorText("PTY injected draft");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await broker.select("Pick fixture", ["Alpha", "Beta"]), "Beta");
  assert.equal(await broker.confirm("Confirm fixture", "Proceed?"), true);
  assert.equal(await broker.input("Input fixture", "value"), "typed value");
  assert.equal(await broker.editor("Edit fixture", "prefilled editor value"), "prefilled editor value");

  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  for (const marker of ["PTY extension title", "PTY injected draft", "Pick fixture", "Confirm fixture", "Input fixture", "Edit fixture"]) assert.match(output, new RegExp(marker));
});

test("SSH TUI restores a pending extension interaction from a fresh attach bootstrap", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-extension-fresh-attach-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const readyFile = join(directory, "fresh-attach.ready");
  const broker = new ExtensionUiBroker();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session, extensionUiBroker: broker });
  }, () => "extension-fresh-attach-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, "extension-fresh-attach");
  const managed = registry.get(instance.id);
  const claimInteractionController = managed.claimInteractionController.bind(managed);
  let rejectFirstClaim = true;
  managed.claimInteractionController = () => {
    if (rejectFirstClaim) {
      rejectFirstClaim = false;
      return Promise.reject(new Error("fixture operation path interruption"));
    }
    return claimInteractionController();
  };
  const confirmation = broker.confirm("Fresh attach confirm", "Restore this pending question.");
  await new Promise<void>((resolve) => setImmediate(resolve));

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", instance.id,
  ], "extension-pending-attach", readyFile);
  assert.equal(await confirmation, true);
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  assert.match(output, /Fresh attach confirm/);
});

test("SSH TUI re-presents an interaction when the Host rejects its first response", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-extension-response-retry-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const readyFile = join(directory, "response-retry.ready");
  const broker = new ExtensionUiBroker();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session, extensionUiBroker: broker });
  }, () => "extension-response-retry-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, "extension-response-retry");
  const managed = registry.get(instance.id);
  const respondInteraction = managed.respondInteraction.bind(managed);
  let rejectFirstResponse = true;
  managed.respondInteraction = (leaseToken, interactionId, response) => {
    if (rejectFirstResponse) {
      rejectFirstResponse = false;
      return Promise.reject(new Error("fixture response delivery failure"));
    }
    return respondInteraction(leaseToken, interactionId, response);
  };
  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", instance.id,
  ], "extension-response-retry", readyFile);
  await waitForPath(readyFile);

  const confirmation = broker.confirm("Retry response confirm", "The first delivery will fail.");
  assert.equal(await confirmation, true);
  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  assert.match(output, /Retry response confirm/);
  assert.match(output, /question is still waiting/);
});

test("SSH TUI reacquires its controller after runtime replacement", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-extension-replacement-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const readyFile = join(directory, "replacement.ready");
  const broker = new ExtensionUiBroker();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session, extensionUiBroker: broker });
  }, () => "extension-replacement-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, "extension-replacement");
  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", instance.id,
  ], "extension-replacement", readyFile);
  await waitForPath(readyFile);

  const replacement = await client.newSession(instance.id);
  assert.equal(replacement.instance.runtimeGeneration, 2);
  let confirmationTimeout: NodeJS.Timeout | undefined;
  const confirmed = await Promise.race([
    broker.confirm("Post replacement confirm", "Controller lease was reacquired."),
    new Promise<undefined>((resolveDelay) => { confirmationTimeout = setTimeout(() => resolveDelay(undefined), 5_000); }),
  ]).finally(() => { if (confirmationTimeout) clearTimeout(confirmationTimeout); });
  if (confirmed === undefined) {
    const failedPty = await ptyRun;
    const failedOutput = Buffer.from(failedPty.output, "base64").toString("utf8");
    assert.fail(`replacement interaction remained pending: ${JSON.stringify(broker.projection())}\n${failedOutput.slice(-8_000)}`);
  }
  assert.equal(confirmed, true);
  broker.setTitle("Post replacement extension title");
  broker.setEditorText("post replacement injected draft");

  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  assert.match(output, /Post replacement confirm/);
  assert.match(output, /Post replacement extension title/);
  assert.match(output, /post replacement injected draft/);
});

test("keyed ensure returns one Host-owned instance to simultaneous clients", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();

  const firstClient = new DockClient({ socketPath: harness.socketPath });
  const secondClient = new DockClient({ socketPath: harness.socketPath });
  const [first, second] = await Promise.all([
    firstClient.ensure("alu", harness.directory, "Alu Workstation", "ensure-alu-first"),
    secondClient.ensure("alu", harness.directory, "Ignored second name", "ensure-alu-second"),
  ]);

  assert.equal(first.created || second.created, true);
  assert.equal(first.created && second.created, false);
  assert.equal(first.instance.id, second.instance.id);
  assert.equal(first.instance.key, "alu");
  assert.equal(second.instance.key, "alu");
  assert.equal(harness.registry.list().length, 1);
  assert.equal((await firstClient.list())[0]?.key, "alu");
  assert.equal((await firstClient.getByKey("alu"))?.id, first.instance.id);
  assert.equal(await firstClient.getByKey("missing"), undefined);

  harness.sessions.get(first.instance.id)?.settle("ready for replacement");
  await harness.registry.get(first.instance.id).waitForIdle();
  const replacement = await firstClient.newSession(first.instance.id, undefined, "keyed-session-new");
  assert.equal(replacement.instance.key, "alu");
});



test("two clients observe and replay one host-owned running instance", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));

  const firstStart = harness.host.start();
  const concurrentStart = harness.host.start();
  assert.equal(firstStart, concurrentStart);
  await Promise.all([firstStart, concurrentStart]);

  const mode = (await lstat(harness.socketPath)).mode & 0o777;
  assert.equal(mode, 0o600);

  const clientA = new DockClient({ socketPath: harness.socketPath });
  const created = await clientA.create(harness.directory, "delayed");
  assert.equal(created.id, "instance-1");
  assert.equal(created.execution, "running");
  assert.equal(created.executor.piSessionId, "pi-instance-1");

  // create() has already closed client A's socket. The host-owned run remains.
  assert.equal(harness.registry.get(created.id).snapshot().execution, "running");

  const clientB = new DockClient({ socketPath: harness.socketPath });
  const listed = await clientB.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);
  assert.equal((await clientB.status(created.id)).execution, "running");

  const initial = await clientB.read(created.id);
  assert.ok(initial.page.events.some((event) => event.type === "command.accepted"));
  const cursor = initial.page.latest;

  const oldEpoch = await clientB.read(created.id, { ...initial.page.latest, hostEpoch: "previous-host" });
  assert.equal(oldEpoch.page.epochChanged, true);
  assert.equal(oldEpoch.page.generationChanged, false);
  assert.ok(oldEpoch.page.events.some((event) => event.type === "instance.created"));

  const oldGeneration = await clientB.read(created.id, { ...initial.page.latest, runtimeGeneration: 99 });
  assert.equal(oldGeneration.page.epochChanged, false);
  assert.equal(oldGeneration.page.generationChanged, true);
  await assert.rejects(
    clientB.read(created.id, { ...initial.page.latest, instanceId: "another-instance" }),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );

  harness.sessions.get(created.id)?.settle("fake done");
  await harness.registry.get(created.id).waitForIdle();
  const replay = await clientB.read(created.id, cursor);
  assert.ok(replay.page.events.some((event) => event.type === "run.settled"));
  assert.equal(replay.instance.lastRun, "succeeded");

  let resolveLiveEvent!: (type: string) => void;
  const liveEvent = new Promise<string>((resolveEvent) => { resolveLiveEvent = resolveEvent; });
  const live = await clientB.streamEvents(created.id, {
    since: replay.page.latest,
    onEvent: (event) => {
      if (event.type === "extension.error") resolveLiveEvent(event.type);
    },
  });
  harness.registry.get(created.id).recordExtensionError("live");
  let liveTimeout: NodeJS.Timeout | undefined;
  try {
    assert.equal(
      await Promise.race([
        liveEvent,
        new Promise<never>((_resolve, reject) => {
          liveTimeout = setTimeout(() => reject(new Error("timed out waiting for live event")), 2_000);
        }),
      ]),
      "extension.error",
    );
  } finally {
    if (liveTimeout) clearTimeout(liveTimeout);
  }
  live.close();
  await live.done;

  const futureEvents: string[] = [];
  const future = await clientB.streamEvents(created.id, {
    since: { ...replay.page.latest, sequence: 10_000 },
    onEvent: (event) => futureEvents.push(event.type),
  });
  harness.registry.get(created.id).recordExtensionError("below future cursor");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  future.close();
  await future.done;
  assert.deepEqual(futureEvents, []);

  for (let index = 0; index < 600; index += 1) {
    harness.registry.get(created.id).recordExtensionError("x".repeat(8_000));
  }
  const boundedReplay = await clientB.read(created.id);
  assert.equal(boundedReplay.page.truncated, true);
  assert.ok(boundedReplay.page.events.length <= 500);
  assert.equal(boundedReplay.page.latest.sequence, harness.registry.get(created.id).snapshot().eventCursor.sequence);

  const beforeHostDrain = harness.registry.get(created.id).snapshot();
  assert.equal(beforeHostDrain.execution, "idle");
  await harness.host.stop();
  assert.equal(harness.sessions.get(created.id)?.disposeCalls, 1);
  const afterHostDrain = harness.registry.get(created.id).snapshot();
  assert.equal(afterHostDrain.lifecycle, "active");
  assert.equal(afterHostDrain.execution, beforeHostDrain.execution);
  assert.equal(afterHostDrain.lastRun, beforeHostDrain.lastRun);
  assert.equal(afterHostDrain.activeCommandId, beforeHostDrain.activeCommandId);
  assert.deepEqual(afterHostDrain.eventCursor, beforeHostDrain.eventCursor);
  await assert.rejects(lstat(harness.socketPath), { code: "ENOENT" });
  await assert.rejects(harness.host.start(), /Cannot start a host that is stopped/);
});



test("installed aludock link opens the SSH Hub and returns to the shell", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-hub-pty-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let factoryCalls = 0;
  let inventoryCalls = 0;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    factoryCalls += 1;
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedAgentWorkerConnection(`pi-${id}`) });
  });
  const host = new DockHost({
    socketPath,
    registry,
    sessionInventory: { list: async () => { inventoryCalls += 1; return { sessions: [], incomplete: false, diagnostics: [] }; } },
  });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const revision = registry.catalogRevision();

  // 2026-09-12: the installed symlink silently exited while direct CLI tests passed.
  const launcher = join(directory, "aludock");
  const cliPath = join(process.cwd(), "dist/src/cli.js");
  const cliMode = (await lstat(cliPath)).mode & 0o7777;
  await symlink(cliPath, launcher);
  context.after(() => chmod(cliPath, cliMode));
  await chmod(launcher, 0o755); // npm gives the packaged bin its executable permission.
  const pty = await runPtyTui([
    launcher,
    "--socket", socketPath,
  ], "hub-exit");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.ok(pty.resizedBytes > 0, "120x40 Hub resize must redraw");
  assert.match(output, /Alu Dock Hub/u);
  assert.match(output, /◆   ◆/u, "standard Hub shows the large Alu mascot");
  assert.match(output, /Project ·/u);
  assert.match(output, /Left Alu Dock Hub/u);
  assertHubPresentation(output, "Left Alu Dock Hub");

  const clicked = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
  ], "hub-click-leave");
  const clickedOutput = Buffer.from(clicked.output, "base64").toString("utf8");
  assert.equal(clicked.timedOut, false, clickedOutput.slice(-2_000));
  assert.equal(clicked.status, 0, clickedOutput.slice(-2_000));
  assertHubPresentation(clickedOutput, "Left Alu Dock Hub");

  const narrow = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
  ], "hub-narrow");
  const narrowOutput = Buffer.from(narrow.output, "base64").toString("utf8");
  assert.equal(narrow.timedOut, false, narrowOutput.slice(-2_000));
  assert.equal(narrow.status, 0, narrowOutput.slice(-2_000));
  assert.match(narrowOutput, /✿\(◆ᴗ◆\) ALU/u);
  assertHubPresentation(narrowOutput, "Left Alu Dock Hub");

  const signalled = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
  ], "hub-signal");
  const signalOutput = Buffer.from(signalled.output, "base64").toString("utf8");
  assert.equal(signalled.timedOut, false, signalOutput.slice(-2_000));
  assert.equal(signalled.status, 0, signalOutput.slice(-2_000));
  assert.match(signalOutput, /Left Alu Dock Hub/u);
  assertHubPresentation(signalOutput, "Left Alu Dock Hub");
  const signalLeave = signalOutput.indexOf("\u001b[?1049l");
  const signalMarker = signalOutput.indexOf("Left Alu Dock Hub", signalLeave);
  assert.ok(signalOutput.lastIndexOf("\u001b[?2004l", signalLeave) >= 0, "TUI input mode must stop before screen restore");
  assert.ok(signalOutput.lastIndexOf("\u001b[?25h", signalLeave) >= 0, "TUI cursor cleanup must precede screen restore");
  assert.doesNotMatch(
    signalOutput.slice(signalLeave + "\u001b[?1049l".length, signalMarker),
    /\u001b\[[0-?]*[ -/]*[@-~]/u,
    "active-menu TUI cleanup must not spill onto the restored shell screen",
  );
  assert.equal(factoryCalls, 0);
  assert.equal(inventoryCalls, 0, "Hub first paint must not scan persisted Pi sessions");
  assert.equal(registry.catalogRevision(), revision);
  assert.deepEqual(registry.list(), []);
});

test("Hub signal restores the shell immediately while Pi session inventory is still pending", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-hub-signal-inventory-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedAgentWorkerConnection(`pi-${id}`) })
  ));
  const host = new DockHost({
    socketPath,
    registry,
    sessionInventory: {
      list: async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
        return { sessions: [], incomplete: false, diagnostics: [] };
      },
    },
  });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
  ], "hub-signal-inventory");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.match(output, /Loading Pi Sessions/u);
  assert.ok(pty.signalRestoreMs >= 0 && pty.signalRestoreMs < 500, `shell restore took ${pty.signalRestoreMs}ms`);
  assertHubPresentation(output, "Left Alu Dock Hub");
  const leave = output.indexOf("\u001b[?1049l");
  const marker = output.indexOf("Left Alu Dock Hub", leave);
  assert.doesNotMatch(output.slice(leave + "\u001b[?1049l".length, marker), /\u001b\[[0-?]*[ -/]*[@-~]/u);
});

test("Hub New browses and confirms a cwd before entering Session Work, while persisted-session Adopt remains available", async (context) => {
  const newHarness = await createHarness();
  context.after(() => cleanupHarness(newHarness));
  const selectedCwd = join(newHarness.directory, "selected-workspace");
  await mkdir(selectedCwd);
  await newHarness.host.start();
  const newPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", newHarness.socketPath,
  ], "hub-new", undefined, newHarness.directory);
  const newOutput = Buffer.from(newPty.output, "base64").toString("utf8");
  assert.equal(newPty.timedOut, false, newOutput.slice(-2_000));
  assert.equal(newPty.status, 0, newOutput.slice(-2_000));
  assert.match(newOutput, /Choose a working directory/u);
  assert.match(newOutput, /selected-workspace/u);
  assert.match(newOutput, /Creating a Pi session/u);
  assert.match(newOutput, /cache /u);
  assert.match(newOutput, /✿\([•◆]_?[ᴗ_]?[•◆]\)/u, "Work keeps the current-session Alu in its fixed activity surface");
  assertHubPresentation(newOutput, "Creating a Pi session");
  const restoredNew = newOutput.indexOf("\u001b[?1049l");
  assert.doesNotMatch(newOutput.slice(restoredNew + 1), /\u001b\[\?1049h|\u001b\[\?1000h|\u001b\[\?1006h/u, "Work must remain on the main buffer with native mouse");
  assert.equal(newHarness.registry.list().length, 1);
  assert.equal(newHarness.registry.list()[0]?.cwd, await realpath(selectedCwd));

  const directory = await mkdtemp(join(tmpdir(), "alu-dock-hub-adopt-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessionFile = "/sessions/hub-adopt.jsonl";
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, name, sessionFile: adoptedFile }) => {
    const runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    if (adoptedFile) runtime.sessionFile = adoptedFile;
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, name, session: runtime });
  }, () => "hub-adopted", { reopenTargetResolver: { resolve: async () => ({ cwd: directory }) } });
  const host = new DockHost({
    socketPath,
    registry,
    sessionInventory: { list: async () => ({
      sessions: [{ sessionId: "hub-session", sessionFile, name: "Hub session", cwd: directory }],
      incomplete: true,
      diagnostics: [{ message: "One saved session could not be inspected", path: "/sessions/broken.jsonl" }],
    }) },
  });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const adoptPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
  ], "hub-adopt");
  const adoptOutput = Buffer.from(adoptPty.output, "base64").toString("utf8");
  assert.equal(adoptPty.timedOut, false, adoptOutput.slice(-2_000));
  assert.equal(adoptPty.status, 0, adoptOutput.slice(-2_000));
  assert.match(adoptOutput, /Some saved Pi sessions could not be checked/u);
  assert.match(adoptOutput, /Opening saved Pi work for Hub session/u);
  assert.match(adoptOutput, /cache /u);
  assert.equal(registry.list()[0]?.executor.sessionFile, sessionFile);
});

test("-c continues the newest current-directory instance and creates one when none exists", async (context) => {
  const existingHarness = await createHarness();
  context.after(() => cleanupHarness(existingHarness));
  await existingHarness.host.start();
  const existingClient = new DockClient({ socketPath: existingHarness.socketPath });
  const older = await existingClient.create(process.cwd(), "older");
  const newer = await existingClient.create(process.cwd(), "newer");
  const continued = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", existingHarness.socketPath,
    "-c",
  ]);
  const continuedOutput = Buffer.from(continued.output, "base64").toString("utf8");
  assert.equal(continued.timedOut, false, continuedOutput.slice(-2_000));
  assert.equal(continued.status, 0, continuedOutput.slice(-2_000));
  assert.match(continuedOutput, /newer/u);
  assert.doesNotMatch(continuedOutput, /Creating a Pi session/u);
  assert.deepEqual((await existingClient.list("all")).map((instance) => instance.id).sort(), [newer.id, older.id].sort());

  const emptyHarness = await createHarness();
  context.after(() => cleanupHarness(emptyHarness));
  await emptyHarness.host.start();
  const created = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", emptyHarness.socketPath,
    "--continue",
  ]);
  const createdOutput = Buffer.from(created.output, "base64").toString("utf8");
  assert.equal(created.timedOut, false, createdOutput.slice(-2_000));
  assert.equal(created.status, 0, createdOutput.slice(-2_000));
  assert.match(createdOutput, /Creating a Pi session/u);
  assert.equal(emptyHarness.registry.list().length, 1);
});

test("Hub Continue opens current work", async (context) => {
  const continueHarness = await createHarness();
  context.after(() => cleanupHarness(continueHarness));
  await continueHarness.host.start();
  const continueClient = new DockClient({ socketPath: continueHarness.socketPath });
  const displayCwd = join(continueHarness.directory, "display.project");
  await mkdir(displayCwd);
  const current = await continueClient.create(displayCwd);
  assert.equal(current.displayName, "display project");
  const continuePty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", continueHarness.socketPath,
  ], "hub-continue");
  const continueOutput = Buffer.from(continuePty.output, "base64").toString("utf8");
  assert.equal(continuePty.timedOut, false, continueOutput.slice(-2_000));
  assert.equal(continuePty.status, 0, continueOutput.slice(-2_000));
  assert.match(continueOutput, /Current Dock work/u);
  assert.match(continueOutput, /Open Work/u);
  assert.match(continueOutput, /display project/u);
  assert.equal(continueOutput.includes(current.id), false);
  assert.match(continueOutput, /cache /u);
  assert.equal((await continueClient.status(current.id)).lifecycle, "active");
  assertHubPresentation(continueOutput, "cache ");

  const mouseContinuePty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", continueHarness.socketPath,
  ], "hub-mouse-continue");
  const mouseContinueOutput = Buffer.from(mouseContinuePty.output, "base64").toString("utf8");
  assert.equal(mouseContinuePty.timedOut, false, mouseContinueOutput.slice(-2_000));
  assert.equal(mouseContinuePty.status, 0, mouseContinueOutput.slice(-2_000));
  assert.match(mouseContinueOutput, /Current Dock work/u);
  assert.match(mouseContinueOutput, /Open Work/u);
  assert.match(mouseContinueOutput, /cache /u);
  assertHubPresentation(mouseContinueOutput, "cache ");
});

test("SSH TUI replays, resizes, handles input, and detaches without stopping", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-demo");

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "work-responsive");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.ok(pty.resizedBytes > 0, "SIGWINCH must produce a resized TUI frame");
  assert.match(output, /Alu Dock/);
  assert.match(output, /deterministic delayed task/);
  assert.match(output, /waiting for model/);
  const redrawFrames = fullRedrawFrames(output);
  const narrowFrame = redrawFrames.find((frame) => (
    frame.length <= 18
    && frame.every((line) => visibleWidth(line) <= 43)
    && frame.some((line) => /pty-demo.*default.*off/u.test(line))
  ));
  assert.ok(narrowFrame, "43-column flowing Work chrome must produce a bounded redraw");
  const initial80 = plainTerminalOutput(output.slice(0, output.indexOf("\u001b[2J\u001b[H\u001b[3J")));
  assert.match(initial80, /pty-demo.*fixture\/default.*think off/u);
  const resizedFrame = lastFullRedrawFrame(output);
  assert.ok(resizedFrame.length > 0 && resizedFrame.length <= 18, `expected bounded flowing chrome:\n${resizedFrame.join("\n")}`);
  assert.ok(resizedFrame.every((line) => visibleWidth(line) <= 120));
  const activityRow = resizedFrame.findIndex((line) => /waiting for model/u.test(line));
  assert.ok(activityRow >= 0 && activityRow < resizedFrame.length - 4, "live activity must sit above the composer and three-row footer");
  assert.match(resizedFrame.at(-4) ?? "", /^─+$/u, "the editor bottom border must remain above footer metadata");
  assert.match(resizedFrame.at(-3) ?? "", /pty-demo.*default.*off/u);
  assert.match(resizedFrame.at(-2) ?? "", /cache .*ctx .*↑.*↓.*\$/u);
  assert.equal(resizedFrame.at(-1), "", "the reserved extension row stays blank when no extension owns it");
  assert.match(output, /Left pty-demo\. The work is still running/u);
  assert.doesNotMatch(output, /data:image|;base64,/i);
  const { enable: mouseEnable, disable: mouseDisable } = mouseTrackingSequences();
  assert.doesNotMatch(output, /\u001b\[\?1049[hl]/u, "Work stays on the flowing main buffer (no alternate screen)");
  assert.equal(output.includes(mouseEnable), false, "Work leaves terminal-native mouse selection to the terminal");
  assert.equal(output.includes(mouseDisable), false, "Work has no synthetic mouse mode to clean up");

  const afterDetach = await client.status(created.id);
  assert.equal(afterDetach.lifecycle, "active");
  assert.equal(afterDetach.execution, "running");
});

test("SSH TUI animates through its frame cache while a typed composer stays unchanged", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-stable-composer");

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "activity-stability");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.equal(pty.draftVisible, true, output.slice(-2_000));
  assert.ok(pty.stableRenderBatches >= 1, "a silent running Host must retain visible liveness");
  assert.equal(pty.localizedActivityBatches, 0, "activity must never bypass pi-tui's frame cache");
  assert.equal(pty.stableDraftRewrites, 0, "activity ticks must not rewrite the composer draft");
  assert.ok(pty.stableOutputBytes > 0 && pty.stableOutputBytes < 2_000, "cached pulse output must remain bounded");
});

test("SSH TUI preserves concurrent composer input while transcript deltas remain event-driven", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-streaming-composer");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  const readyFile = join(harness.directory, "streaming-composer.ready");

  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "activity-streaming", readyFile);
  await waitForPath(readyFile);
  for (let index = 0; index < 50; index += 1) {
    runtime.emit({
      type: "dock_conversation_frame",
      frame: {
        type: "message.delta",
        data: { messageId: "fixture-assistant-1", block: "text", delta: String(index % 10) },
      },
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }

  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.equal(pty.draftVisible, true, "the forced final frame must retain every typed character");
  assert.match(output, /responding/u);
  const streamingFrame = lastFullRedrawFrame(output);
  const activityRow = streamingFrame.findIndex((line) => /responding/u.test(line));
  assert.ok(activityRow >= 0 && activityRow < streamingFrame.length - 4);
  assert.match(streamingFrame.at(-4) ?? "", /^─+$/u);
  assert.match(streamingFrame.at(-3) ?? "", /pty-st.*default.*off/u);
  assert.match(streamingFrame.at(-2) ?? "", /cache .*ctx .*↑.*↓.*\$/u);
  assert.equal(streamingFrame.at(-1), "");
});

test("SSH TUI keeps repeated no-run completion facts out of live and replayed conversation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-no-run-pty-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: NoRunAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, name }) => {
    runtime = new NoRunAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, name, session: runtime, eventCapacity: 500 });
  }, () => "no-run-pty-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, "no-run-pty");

  const livePty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "command-handled");
  const liveOutput = Buffer.from(livePty.output, "base64").toString("utf8");
  assert.equal(livePty.timedOut, false, liveOutput.slice(-2_000));
  assert.equal(livePty.status, 0, liveOutput.slice(-2_000));
  assert.doesNotMatch(liveOutput, /Command handled without starting a model run/u);

  const replayPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ]);
  const replayOutput = Buffer.from(replayPty.output, "base64").toString("utf8");
  assert.equal(replayPty.timedOut, false, replayOutput.slice(-2_000));
  assert.equal(replayPty.status, 0, replayOutput.slice(-2_000));
  assert.doesNotMatch(replayOutput, /Command handled without starting a model run/u);

  assert.ok(runtime);
  assert.deepEqual(runtime.promptMessages, ["fixture no-run one", "fixture no-run two"]);
  const status = await client.status(created.id);
  assert.equal(status.execution, "idle");
  assert.equal(status.lastRun, "never");
  const events = (await client.read(created.id)).page.events;
  assert.equal(events.filter((event) => event.type === "command.handled").length, 2);
  assert.equal(events.some((event) => event.type === "run.started"), false);
});

test("SSH TUI editor preserves multiline paste and submitted history", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-editor");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "editor");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.deepEqual(runtime.promptMessages, [
    "deterministic delayed task",
    "first line\nsecond line",
    "first line\nsecond line",
  ]);
});

test("SSH TUI Alt+Up restores all pending text while Escape restores then aborts", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-queue");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;

  await client.prompt(created.id, "later follow-up", "followUp", "pty-follow-1");
  await client.prompt(created.id, "urgent steer", "steer", "pty-steer-1");
  const restoredPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "queue-restore");
  const restoredOutput = Buffer.from(restoredPty.output, "base64").toString("utf8");
  assert.equal(restoredPty.timedOut, false, restoredOutput.slice(-4_000));
  assert.equal(restoredPty.status, 0, restoredOutput.slice(-4_000));
  assert.match(restoredOutput, /1\. steer next · urgent steer/);
  assert.match(restoredOutput, /2\. follow-up · later follow-up/);
  assert.match(restoredOutput, /Returned 2 waiting messages to the editor/);
  const restoredStatus = await client.status(created.id);
  assert.equal(restoredStatus.execution, "running");
  assert.equal(restoredStatus.pending.total, 0);

  await client.prompt(created.id, "in-flight follow-up", "followUp", "pty-follow-inflight");
  await client.prompt(created.id, "in-flight steer", "steer", "pty-steer-inflight");
  const drained = runtime.drainNextQueuedWithoutMessageStart();
  assert.equal(drained, "in-flight steer");
  const inFlightPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "queue-inflight");
  const inFlightOutput = Buffer.from(inFlightPty.output, "base64").toString("utf8");
  assert.equal(inFlightPty.timedOut, false, inFlightOutput.slice(-4_000));
  assert.equal(inFlightPty.status, 0, inFlightOutput.slice(-4_000));
  assert.match(inFlightOutput, /already moving into[\s\S]*the conversation[\s\S]*finish before[\s\S]*stopping the run/u);
  assert.equal(inFlightPty.draftVisible, true, "restoration must preserve the draft typed before the receipt arrives");
  assert.doesNotMatch(inFlightOutput, /Run aborted/u);
  runtime.finishDrainedQueued(drained!);

  await client.prompt(created.id, "second follow-up", "followUp", "pty-follow-2");
  await client.prompt(created.id, "second steer", "steer", "pty-steer-2");
  const abortedPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "queue-abort");
  const abortedOutput = Buffer.from(abortedPty.output, "base64").toString("utf8");
  assert.equal(abortedPty.timedOut, false, abortedOutput.slice(-4_000));
  assert.equal(abortedPty.status, 0, abortedOutput.slice(-4_000));
  assert.match(abortedOutput, /Run aborted/);
  const final = await client.status(created.id);
  assert.equal(final.execution, "idle");
  assert.equal(final.lastRun, "aborted");
  assert.equal(final.pending.total, 0);
});

test("SSH TUI model picker filters input while complete history flows into native scrollback", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-pty-ux-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    runtime.history = Array.from({ length: 450 }, (_, index) => agentRecord(
      `history-${index}`,
      index % 2 === 0 ? "user" : "assistant",
      [{ type: "text", text: `historical line ${index}` }],
    ));
    runtime.history.push(
      agentRecord("history-tool-call", "assistant", [{ type: "tool_call", toolCallId: "history-tool", toolName: "read", args: { path: "/tmp/demo" } }]),
      agentRecord("history-tool-result", "tool", [{ type: "tool_result", toolCallId: "history-tool", toolName: "read", isError: false, text: "expanded tool detail\nsecond detail line" }], {
        toolCallId: "history-tool",
        toolName: "read",
        isError: false,
      }),
    );
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime, initialHistory: runtime.getHistory() });
  }, () => "pty-ux-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, "pty-ux");

  const modelPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "model-search");
  const modelOutput = Buffer.from(modelPty.output, "base64").toString("utf8");
  assert.equal(modelPty.timedOut, false, modelOutput.slice(-4_000));
  assert.equal(modelPty.status, 0, modelOutput.slice(-4_000));
  assert.match(modelOutput, /Search:/);
  assert.deepEqual((await client.status(created.id)).executor.model, { provider: "fixture", id: "local" });

  const historyPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "history-flow");
  const historyOutput = Buffer.from(historyPty.output, "base64").toString("utf8");
  assert.equal(historyPty.timedOut, false, historyOutput.slice(-4_000));
  assert.equal(historyPty.status, 0, historyOutput.slice(-4_000));
  assert.match(historyOutput, /historical line 0/, "internal reverse paging must eagerly reach the oldest branch entry");
  assert.match(historyOutput, /historical line 449/);
  assert.doesNotMatch(historyOutput, /\u001b\[\?1000h|\u001b\[\?1006h/u, "Work leaves scrolling and selection to the terminal");

  const liveReady = join(directory, "live-flow.ready");
  const liveRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "history-live-flow", liveReady);
  await waitForPath(liveReady);
  await client.prompt(created.id, "new output in the flowing transcript");
  const livePty = await liveRun;
  const liveOutput = Buffer.from(livePty.output, "base64").toString("utf8");
  assert.equal(livePty.timedOut, false, liveOutput.slice(-4_000));
  assert.equal(livePty.status, 0, liveOutput.slice(-4_000));
  assert.match(liveOutput, /new output in the flowing transcript/u);
  await client.abort(created.id);

  const framePty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "flow-frame-stability");
  const frameOutput = Buffer.from(framePty.output, "base64").toString("utf8");
  assert.equal(framePty.timedOut, false, frameOutput.slice(-4_000));
  assert.equal(framePty.status, 0, frameOutput.slice(-4_000));
  assert.equal(framePty.navigationScrollbackClearCount, 0, "ordinary Work updates must not erase native terminal scrollback");
  assert.ok(framePty.navigationRenderBatches >= 1, "Ctrl+O must render through pi-tui's frame cache");
  assert.equal(framePty.draftVisible, true, "the real editor draft must survive an authoritative tool-fold update");
  assert.doesNotMatch(frameOutput, /\u001b\[s/u, "activity animation must not write outside the frame cache");
  const resizedFrame = lastFullRedrawFrame(frameOutput);
  assert.ok(resizedFrame.length > 58, "the complete transcript must flow beyond the terminal viewport into native scrollback");
  assert.match(resizedFrame.at(-4) ?? "", /^─+$/u, "the composer bottom border must remain above footer metadata");
  assert.match(resizedFrame.at(-2) ?? "", /cache .*ctx .*↑.*↓.*\$/u, "the cache footer must survive the initial resize");
  assert.ok(resizedFrame.every((line) => visibleWidth(line) <= 252));

  const toolPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "tool-fold");
  const toolOutput = Buffer.from(toolPty.output, "base64").toString("utf8");
  assert.equal(toolPty.timedOut, false, toolOutput.slice(-4_000));
  assert.equal(toolPty.status, 0, toolOutput.slice(-4_000));
  assert.match(toolOutput, /✓ read/u);
  assert.match(toolOutput, /expanded tool detail/);
});

test("SSH TUI Stage 3 commands mutate Host-owned settings tools and sessions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-pty-stage3-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const savedSession: SessionDto = {
    sessionId: "pty-resume",
    sessionFile: "/tmp/pty-resume.jsonl",
    name: "PTY resumed",
    cwd: directory,
  };
  let runtime: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    runtime.sessionCatalog = [savedSession];
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "pty-stage3-instance");
  const host = new DockHost({
    socketPath,
    registry,
    sessionInventory: { list: async () => ({ sessions: [savedSession], incomplete: false, diagnostics: [] }) },
  });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, "pty-stage3");

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "stage3");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  for (const marker of ["autoRetry = false", "Active tools: read, write", "Session name: PTY Stage 3", "Compacted 123 tokens", "Resources reloaded", "New session ready", "Saved session opened"]) assert.match(output, new RegExp(marker));
  assert.equal((await client.status(created.id)).name, "PTY resumed");
});

test("SSH TUI tree identifies sibling branches and round-trips from B to A without a model run", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-pty-tree-branches-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    runtime.treeNodes = [
      { entryId: "branch-root", depth: 0, kind: "message", role: "user", displayClass: "content", summary: "initial task", hasChildren: true },
      { entryId: "branch-point", parentId: "branch-root", depth: 1, kind: "message", role: "assistant", displayClass: "content", summary: "shared answer", hasChildren: true },
      { entryId: "branch-a-user", parentId: "branch-point", depth: 2, kind: "message", role: "user", displayClass: "content", summary: "original branch prompt", hasChildren: true },
      { entryId: "branch-a-leaf", parentId: "branch-a-user", depth: 3, kind: "message", role: "assistant", displayClass: "content", summary: "original branch answer", hasChildren: false },
      { entryId: "branch-b-user", parentId: "branch-point", depth: 2, kind: "message", role: "user", displayClass: "content", summary: "new branch prompt", hasChildren: true },
      { entryId: "branch-b-leaf", parentId: "branch-b-user", depth: 3, kind: "message", role: "assistant", displayClass: "content", summary: "new branch answer", hasChildren: false },
    ];
    runtime.treeLeafId = "branch-b-leaf";
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "pty-tree-branches-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, "pty-tree-branches");

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "tree-branch-roundtrip");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  for (const marker of ["shared answer", "original branch answer", "new branch answer", "Session branch selected"]) {
    assert.ok(output.includes(marker), `${marker}\n${output.slice(-4_000)}`);
  }
  assert.equal((await client.tree(created.id)).leafId, "branch-a-leaf");
  assert.equal(runtime?.promptCalls, 0, "browsing the tree must not start a model run");
});

test("SSH TUI Stage 6 navigates, returns fork text to the editor, and clones the current leaf", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-pty-stage6-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    runtime.treeNodes = [
      { entryId: "tree-u1", depth: 0, kind: "message", role: "user", displayClass: "content", summary: "first prompt", hasChildren: true },
      { entryId: "tree-a1", parentId: "tree-u1", depth: 1, kind: "message", role: "assistant", displayClass: "content", summary: "first answer", hasChildren: true },
      { entryId: "tree-u2", parentId: "tree-a1", depth: 2, kind: "message", role: "user", displayClass: "content", summary: "second prompt", hasChildren: true },
      { entryId: "tree-a2", parentId: "tree-u2", depth: 3, kind: "message", role: "assistant", displayClass: "content", summary: "second answer", hasChildren: false },
    ];
    runtime.treeLeafId = "tree-a2";
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "pty-stage6-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, "pty-stage6");

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "stage6");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  for (const marker of ["Session branch selected", "Session branch created", "Session cloned"]) {
    assert.match(output, new RegExp(marker, "u"));
  }
  assert.equal((await client.status(created.id)).lastRun, "never");
});

test("SSH TUI Ctrl+C aborts a run while preserving the reusable instance", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-abort");

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "abort");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.match(output, /Run aborted/);

  const afterDetach = await client.status(created.id);
  assert.equal(afterDetach.lifecycle, "active");
  assert.equal(afterDetach.execution, "idle");
  assert.equal(afterDetach.lastRun, "aborted");
});

test("SSH TUI recovers a dropped event stream from its accepted cursor without replaying a command", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-stream-recovery");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  const readyFile = join(harness.directory, "pty-recovery.ready");

  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "stream-recover", readyFile);
  await waitForPath(readyFile);
  const promptCallsBeforeDrop = runtime.promptCalls;
  (harness.host as unknown as { closeStaleAttachStreams(instanceId: string): void }).closeStaleAttachStreams(created.id);
  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-3_000));
  assert.equal(pty.status, 0, output.slice(-3_000));
  assert.match(output, /Live updates were interrupted/u);
  assert.match(output, /whether the work is still running/u);
  assert.match(output, /Live updates resumed/u);
  assert.match(output, /This work is ready/u);
  assert.match(output, /Status: running/);
  assert.equal(runtime.promptCalls, promptCallsBeforeDrop, "reconnecting must not resend the command");
  assert.equal((await client.status(created.id)).lifecycle, "active");
});

test("SSH TUI resets from authoritative bootstrap and restores control when stream recovery has a replay gap", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-model-gap");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  const readyFile = join(harness.directory, "pty-model-gap.ready");

  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "model-disconnect", readyFile);
  await waitForPath(`${readyFile}.picker`);
  const modelMutationsBeforeDrop = runtime.modelMutationCalls;
  (harness.host as unknown as { closeStaleAttachStreams(instanceId: string): void }).closeStaleAttachStreams(created.id);
  for (let index = 0; index < 1_100; index += 1) runtime.emit({ type: "dock_extension_error", error: `recovery-gap-${index}` });

  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  assert.match(output, /Model changed to fixture\/local/);
  assert.equal(runtime.modelMutationCalls, modelMutationsBeforeDrop + 1, "recovery must not repeat the model change");
  assert.equal((await client.status(created.id)).lifecycle, "active");
});

test("SSH TUI detach reports an externally stopped instance instead of claiming Host ownership", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-external-stop");
  const readyFile = join(harness.directory, "pty-external-stop.ready");

  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "external-stop", readyFile);
  await waitForPath(readyFile);
  const stopped = await client.stop(created.id, "external-stop-operation");
  assert.equal(stopped.instance.lifecycle, "stopped");
  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-3_000));
  assert.equal(pty.status, 0, output.slice(-3_000));
  const detachNotice = output.slice(output.lastIndexOf("Left pty-external-stop"));
  assert.match(detachNotice, /Left pty-external-stop/);
  assert.match(detachNotice, /It is stopped/u);
});

test("SSH TUI reports true Host loss as unknown and detaches cleanly", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-host-loss");
  const readyFile = join(harness.directory, "pty.ready");

  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "transport-close", readyFile);
  await waitForPath(readyFile);
  await harness.host.stop();
  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.match(output, /The connection could not be restored/u);
  assert.match(output, /Left pty-host-loss, but its current status could not be checked/u);

  const conservative = harness.registry.get(created.id).snapshot();
  assert.equal(conservative.lifecycle, "active");
  assert.equal(conservative.execution, "running");
});

test("a second client can steer, queue follow-up, and stop idempotently", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const creator = new DockClient({ socketPath: harness.socketPath });
  const created = await creator.create(harness.directory);
  const controller = new DockClient({ socketPath: harness.socketPath });

  const steer = await controller.prompt(created.id, "change direction", "auto", "steer-op");
  assert.equal(steer.receipt.delivery, "steer");
  assert.equal(steer.receipt.queued, true);
  assert.equal(steer.instance.pending.steering, 1);

  const followUp = await controller.prompt(created.id, "then summarize", "followUp", "follow-op");
  assert.equal(followUp.receipt.delivery, "followUp");
  assert.equal(followUp.receipt.queued, true);
  assert.equal(followUp.instance.pending.followUp, 1);

  await assert.rejects(
    controller.prompt(created.id, "parallel", "prompt"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_delivery",
  );

  const pendingAttach = await controller.streamEvents(created.id, { onEvent: () => {} });
  assert.deepEqual(pendingAttach.initial.pendingMessages.map((item) => ({ operationId: item.operationId, delivery: item.delivery, text: item.text })), [
    { operationId: "steer-op", delivery: "steer", text: "change direction" },
    { operationId: "follow-op", delivery: "followUp", text: "then summarize" },
  ]);
  pendingAttach.close();
  await pendingAttach.done;

  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  assert.equal(runtime.consumeNextQueued(), "change direction");
  const afterConsume = await controller.streamEvents(created.id, { onEvent: () => {} });
  assert.deepEqual(afterConsume.initial.pendingMessages.map((item) => item.operationId), ["follow-op"]);
  assert.ok(afterConsume.initial.page.events.some((event) => event.type === "message.submitted" && event.data.operationId === "steer-op"));
  afterConsume.close();
  await afterConsume.done;

  const dequeued = await controller.dequeue(created.id, "dequeue-op");
  const duplicateDequeue = await controller.dequeue(created.id, "dequeue-op");
  assert.deepEqual(duplicateDequeue, dequeued);
  assert.deepEqual(dequeued.receipt.restored.map((item) => ({ operationId: item.operationId, delivery: item.delivery, text: item.text })), [
    { operationId: "follow-op", delivery: "followUp", text: "then summarize" },
  ]);
  assert.equal(dequeued.instance.execution, "running");

  const firstStop = await controller.stop(created.id, "retire-stopped-work");
  assert.equal(firstStop.receipt.alreadyStopped, false);
  assert.equal(firstStop.instance.lifecycle, "stopped");
  assert.equal(firstStop.instance.lastRun, "aborted");
  assert.equal(firstStop.instance.pending.total, 0);

  assert.deepEqual(await controller.stop(created.id, "retire-stopped-work"), firstStop);
  await assert.rejects(
    controller.status(created.id),
    (error: unknown) => error instanceof ControlClientError && error.code === "not_found",
  );
  assert.equal((await controller.list("all")).some((instance) => instance.id === created.id), false);
  await assert.rejects(
    controller.prompt(created.id, "too late"),
    (error: unknown) => error instanceof ControlClientError && error.code === "not_found",
  );
});

test("typed clients accept an immediate extension command while preserving the running parent", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "extension-running");
  const parentOperationId = created.activeCommandId;
  assert.ok(parentOperationId);
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  runtime.extensionCommands.add("fixture-command");

  const handled = await client.prompt(created.id, "/fixture-command now", "auto", "extension-running-op");

  assert.deepEqual(
    { kind: handled.receipt.kind, delivery: handled.receipt.delivery, queued: handled.receipt.queued },
    { kind: "extension_command", delivery: "prompt", queued: false },
  );
  assert.equal(handled.instance.activeCommandId, parentOperationId);
  assert.equal(handled.instance.execution, "running");
  assert.equal(handled.instance.pending.total, 0);
});

test("manual compaction aborts a running model command without stealing its run operation ID", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "compact-running");
  const originalCommandId = created.activeCommandId;
  assert.ok(originalCommandId);

  const compacted = await client.compactSession(created.id, undefined, "manual-compact-op");
  assert.equal(compacted.instance.execution, "idle");
  assert.equal(compacted.instance.lastRun, "aborted");
  const events = (await client.read(created.id)).page.events;
  const settled = events.find((event) => event.type === "run.settled");
  assert.equal(settled?.type === "run.settled" ? settled.data.operationId : undefined, originalCommandId);
  assert.ok(events.some((event) => event.type === "compaction.completed" && event.data.operationId === "manual-compact-op"));
});

test("committed reads and follow stay available while Worker projection waits for manual compaction", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const controller = new DockClient({ socketPath: harness.socketPath });
  const created = await controller.create(harness.directory, "manual-compaction-observer", "create-manual-compaction-observer");
  const managed = harness.registry.get(created.id);
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  const block = runtime.blockNextCompaction();
  let blockFinished = false;
  let subscription: Awaited<ReturnType<DockClient["streamEvents"]>> | undefined;
  const compacting = controller.compactSession(created.id, undefined, "manual-compaction-observer-op");

  try {
    await block.entered;
    const compactionStartDeadline = Date.now() + 2_000;
    let compactingSnapshot = await controller.status(created.id);
    while (!compactingSnapshot.compacting && Date.now() < compactionStartDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      compactingSnapshot = await controller.status(created.id);
    }
    assert.equal(compactingSnapshot.compacting, true);

    const liveEvents: DockEvent[] = [];
    const observer = new DockClient({ socketPath: harness.socketPath, timeoutMs: 2_000 });
    let treeSettled = false;
    const treeDuringCompaction = managed.getTree().finally(() => { treeSettled = true; });
    const [projection, attached, history] = await Promise.all([
      observer.read(created.id, undefined, "conversation_bootstrap"),
      observer.streamEvents(created.id, {
        onEvent: (event) => liveEvents.push(event),
        requireTuiProjection: true,
        conversationBootstrap: true,
      }),
      managed.getHistoryPage(undefined, 20),
    ]);
    subscription = attached;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(runtime.isCompacting, true);
    assert.equal(projection.instance.compacting, true);
    assert.equal(projection.instance.execution, "running");
    assert.equal(attached.initial.instance.compacting, true);
    assert.equal(attached.initial.instance.runtimeGeneration, created.runtimeGeneration);
    assert.equal(history.instance.compacting, true);
    assert.equal(treeSettled, false);

    const queued = await observer.prompt(created.id, "queued during observed manual compaction", "auto", "manual-compaction-observer-queue");
    assert.equal(queued.receipt.queued, true);
    assert.deepEqual(
      (await observer.read(created.id, undefined, "conversation_bootstrap")).pendingMessages.map((item) => item.operationId),
      ["manual-compaction-observer-queue"],
    );

    block.finish();
    blockFinished = true;
    const [result, tree] = await Promise.all([compacting, treeDuringCompaction]);
    assert.equal(result.result.summary, "fixture summary");
    assert.equal(Array.isArray(tree.nodes), true);
    const deadline = Date.now() + 2_000;
    while (!liveEvents.some((event) => event.type === "compaction.completed") && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(liveEvents.some((event) => event.type === "compaction.completed" && event.data.operationId === "manual-compaction-observer-op"));
    assert.equal((await observer.status(created.id)).lifecycle, "active");
    assert.equal(runtime.sessionMutationCalls.compact, 1);
  } finally {
    subscription?.close();
    if (subscription) await subscription.done;
    if (!blockFinished) block.finish();
    await compacting.catch(() => {});
  }
});

test("SSH TUI Ctrl+D detaches promptly while Host-owned compaction remains blocked", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-compact-detach", "create-pty-compact-detach");
  const runtime = harness.sessions.get(created.id)!;
  const block = runtime.blockNextCompaction();
  const startedAt = Date.now();
  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "compact-detach");
  const elapsed = Date.now() - startedAt;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  assert.ok(elapsed < 6_000, `detach took ${elapsed}ms`);
  assert.equal(runtime.sessionMutationCalls.compact, 1);

  block.finish();
  assert.equal((await client.status(created.id)).lifecycle, "active");
  assert.equal(runtime.sessionMutationCalls.compact, 1);
});

test("the same Work can queue input during manual compaction and detach without losing Host custody", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-manual-compaction-queue", "create-pty-manual-compaction-queue");
  const runtime = harness.sessions.get(created.id)!;
  const block = runtime.blockNextCompaction();
  const promptCallsBeforeCompaction = runtime.promptCalls;

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "compact-queue");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  assert.match(output, /steer next/u, "manual compaction must leave the Work editor able to submit into Queue");
  assert.equal(runtime.promptCalls, promptCallsBeforeCompaction);
  assert.equal((await client.status(created.id)).pending.total, 1, "queued text remains Host-owned after TUI detach");
  block.finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.promptCalls, promptCallsBeforeCompaction + 1);
  assert.equal(runtime.promptMessages.at(-1), "manual queue survives");
  const consumedProjection = await client.read(created.id, undefined, "conversation_bootstrap");
  assert.equal(consumedProjection.pendingMessages.length, 0);
  const submitted = consumedProjection.page.events.find((event) => (
    event.type === "message.submitted" && event.data.text === "manual queue survives"
  ));
  assert.equal(submitted?.type === "message.submitted" ? submitted.data.delivery : undefined, "prompt");
  assert.ok(submitted?.type === "message.submitted" && submitted.data.queueItemId);
});

test("Sol-style compaction keeps a concurrent cross-client prompt visible and hands it to the hidden continuation once", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const first = new DockClient({ socketPath: harness.socketPath });
  const created = await first.create(harness.directory, "compaction-queue-integration");
  const runtime = harness.sessions.get(created.id)!;

  const guard = runtime.armPostSettlementContinuation({ toolCallId: "guard-continuation-tool" });
  runtime.settle("settled into guard compaction");
  await guard.compactionStarted;
  assert.equal(runtime.promptCalls, 1);
  assert.equal(runtime.isCompacting, true);
  assert.equal((await first.status(created.id)).compacting, true);

  const second = new DockClient({ socketPath: harness.socketPath });
  const queued = await second.prompt(created.id, "must survive compaction", "auto", "compaction-queued-operation");
  assert.equal(queued.receipt.queued, true);
  assert.equal(queued.receipt.delivery, "steer");
  assert.equal(runtime.promptCalls, 1, "Host must retain compaction-time text before calling Pi again");
  const attached = await second.streamEvents(created.id, { onEvent: () => {}, requireTuiProjection: true, conversationBootstrap: true });
  assert.deepEqual(attached.initial.pendingMessages.map((item) => item.operationId), ["compaction-queued-operation"]);
  attached.close();
  await attached.done;
  assert.ok((await second.list()).some((item) => item.id === created.id), "a valid compaction queue must keep Hub/list usable");

  guard.finishCompaction();
  await guard.continuationStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.promptCalls, 2);
  assert.equal(runtime.promptMessages.at(-1), "must survive compaction");
  const whileQueued = await first.status(created.id);
  assert.equal(whileQueued.compacting, false);
  assert.equal(whileQueued.execution, "running");
  assert.equal(whileQueued.pending.total, 1);

  assert.equal(runtime.consumeNextQueued(), "must survive compaction");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const afterConsume = await second.status(created.id);
  assert.equal(afterConsume.pending.total, 0);
  const submitted = harness.registry.get(created.id).eventsSince().events.filter((event) => event.type === "message.submitted");
  assert.equal(submitted.at(-1)?.data.operationId, "compaction-queued-operation");
});

test("two live Host instances keep identical compaction and Pi queue items isolated", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const createdA = await client.create(harness.directory, "queue-isolation-a");
  const createdB = await client.create(harness.directory, "queue-isolation-b");
  const runtimeA = harness.sessions.get(createdA.id)!;

  runtimeA.isCompacting = true;
  runtimeA.emit({ type: "compaction_start", reason: "threshold" });
  await client.prompt(createdA.id, "identical cross-instance text", "auto", "isolation-operation-a");
  await client.prompt(createdB.id, "identical cross-instance text", "auto", "isolation-operation-b");

  const attachA = await client.streamEvents(createdA.id, { onEvent: () => {}, requireTuiProjection: true, conversationBootstrap: true });
  const attachB = await client.streamEvents(createdB.id, { onEvent: () => {}, requireTuiProjection: true, conversationBootstrap: true });
  assert.deepEqual(attachA.initial.pendingMessages.map((item) => item.operationId), ["isolation-operation-a"]);
  assert.deepEqual(attachB.initial.pendingMessages.map((item) => item.operationId), ["isolation-operation-b"]);
  attachA.close();
  attachB.close();
  await Promise.all([attachA.done, attachB.done]);

  const restoredB = await client.dequeue(createdB.id, "dequeue-isolation-b");
  assert.deepEqual(restoredB.receipt.restored.map((item) => item.operationId), ["isolation-operation-b"]);
  assert.deepEqual((await client.dequeue(createdA.id, "dequeue-isolation-a")).receipt.restored.map((item) => item.operationId), ["isolation-operation-a"]);
  assert.equal((await client.status(createdA.id)).pending.total, 0);
  assert.equal((await client.status(createdB.id)).pending.total, 0);
});

test("a runtime-driven post-compaction continuation starts while every client is detached", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "offline-continuation");
  const runtime = harness.sessions.get(created.id)!;
  const attached = await client.streamEvents(created.id, {
    onEvent: () => {},
    requireTuiProjection: true,
    conversationBootstrap: true,
  });
  attached.close();
  await attached.done;

  const guard = runtime.armPostSettlementContinuation({ toolCallId: "offline-tool" });
  runtime.settle("guard stopped after a tool boundary");
  await guard.compactionStarted;
  const compactionObserver = new DockClient({ socketPath: harness.socketPath });
  const compactingReplay = await compactionObserver.streamEvents(created.id, {
    onEvent: () => {},
    requireTuiProjection: true,
    conversationBootstrap: true,
  });
  assert.equal(compactingReplay.initial.instance.execution, "running");
  assert.equal(compactingReplay.initial.instance.compacting, true);
  assert.equal(compactingReplay.initial.instance.lastRun, "succeeded");
  assert.deepEqual(compactingReplay.initial.page.events, [], "compaction without an active agent run has no conversation tail");
  const projected = harness.registry.get(created.id).eventsSince().events;
  const compactionStarted = projected.findIndex((event) => event.type === "compaction.started");
  const runSettled = projected.findIndex((event) => event.type === "run.settled");
  assert.ok(compactionStarted >= 0 && runSettled > compactionStarted, "Pi can publish compaction_start before its externally visible agent_settled");
  compactingReplay.close();
  await compactingReplay.done;

  guard.finishCompaction();
  await guard.continuationStarted;

  // The observer is created only after the continuation has started; no attach
  // or read can be the trigger for this Host-owned work.
  const observer = new DockClient({ socketPath: harness.socketPath });
  const status = await observer.status(created.id);
  assert.equal(status.execution, "running");
  assert.equal(status.compacting, false);
  assert.equal(status.activeCommandId, undefined);
  const replay = await observer.streamEvents(created.id, {
    onEvent: () => {},
    requireTuiProjection: true,
    conversationBootstrap: true,
  });
  assert.equal(replay.initial.page.events.some((event) => event.type === "run.started"), false, "snapshot state owns run lifecycle during a fresh bootstrap");
  assert.ok(replay.initial.page.events.some((event) => event.type === "tool.started" && event.data.toolCallId === "offline-tool"));
  replay.close();
  await replay.done;
});

test("stop preempts a manual compaction even before its start event is projected", async (context) => {
  const catalog = new ScriptedCatalogCommitPort();
  const stopIntentGate = catalog.gateAt(2);
  const harness = await createTransactionHarness(catalog);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "blocked-compaction", "create-blocked-compaction");
  const managed = harness.registry.get(created.id);
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  const startBlock = runtime.blockNextCompactionStart();
  runtime.blockNextCompaction();
  const compacting = client.compactSession(created.id, undefined, "blocked-compact-op");
  const compactFailure = assert.rejects(
    compacting,
    (error: unknown) => error instanceof ControlClientError
      && error.code === "effect_unknown"
      && error.operationId === "blocked-compact-op",
  );
  await startBlock.entered;

  const stopping = client.stop(created.id, "stop-during-compaction");
  await stopIntentGate.entered;
  assert.equal(catalog.calls[1]?.context.kind, "instance.stop.intent");
  stopIntentGate.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.registry.get(created.id).snapshot().lifecycle, "stopping");
  startBlock.release();
  const stopped = await stopping;
  await compactFailure;

  assert.equal(stopped.instance.lifecycle, "stopped");
  assert.equal(stopped.instance.runtimeGeneration, created.runtimeGeneration);
  assert.equal(stopped.instance.executor.sessionFile, created.executor.sessionFile);
  assert.equal(runtime.abortCalls, 1);
  assert.equal(runtime.disposeCalls, 1);
  const events = managed.eventsSince().events;
  const stopRequested = events.find((event) => event.type === "instance.state_changed" && event.data.reason === "stop_requested");
  const compactionCompleted = events.find((event) => event.type === "compaction.completed");
  assert.equal(compactionCompleted?.type === "compaction.completed" ? compactionCompleted.data.operationId : undefined, "blocked-compact-op");
  assert.equal(compactionCompleted?.type === "compaction.completed" ? compactionCompleted.data.aborted : undefined, true);
  assert.ok(stopRequested && compactionCompleted && stopRequested.sequence < compactionCompleted.sequence);
});

test("reload and reads both succeed in either arrival order", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "replacement-read-fence");
  const managed = harness.registry.get(created.id);
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  runtime.settle();
  await managed.waitForIdle();

  const originalReload = runtime.reload.bind(runtime);
  let markReloadEntered!: () => void;
  let releaseReload!: () => void;
  const reloadEntered = new Promise<void>((resolve) => { markReloadEntered = resolve; });
  const reloadRelease = new Promise<void>((resolve) => { releaseReload = resolve; });
  runtime.reload = async (operationId: string) => {
    markReloadEntered();
    await reloadRelease;
    return originalReload(operationId);
  };

  const reloadFirst = managed.reloadSession("reload-first");
  await reloadEntered;
  let treeSettled = false;
  let historySettled = false;
  const treeAfterReload = managed.getTree().finally(() => { treeSettled = true; });
  const historyAfterReload = managed.getHistoryPage(undefined, 20).finally(() => { historySettled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.treeReadCalls, 0);
  assert.equal(treeSettled, false);
  assert.equal(historySettled, false);

  releaseReload();
  const [, , historyResult] = await Promise.all([reloadFirst, treeAfterReload, historyAfterReload]);
  assert.equal(runtime.treeReadCalls, 1);
  assert.equal(historyResult.instance.runtimeGeneration, created.runtimeGeneration + 1);

  runtime.reload = originalReload;
  const treeBlock = runtime.blockNextTreeRead();
  const treeFirst = managed.getTree();
  await treeBlock.entered;
  let reloadSettledBeforeRead = false;
  const reloadAfterTree = managed.reloadSession("reload-after-tree").finally(() => { reloadSettledBeforeRead = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const escapedReadReservation = reloadSettledBeforeRead;
  treeBlock.release();
  const [treeOutcome, reloadOutcome] = await Promise.allSettled([treeFirst, reloadAfterTree]);

  assert.equal(escapedReadReservation, false);
  assert.equal(treeOutcome.status, "fulfilled");
  assert.equal(reloadOutcome.status, "fulfilled");
  assert.equal(managed.snapshot().runtimeGeneration, created.runtimeGeneration + 2);
});

test("Worker projection reads preserve their arrival order", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "ordered-projection-reads");
  const managed = harness.registry.get(created.id);
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  runtime.settle();
  await managed.waitForIdle();

  const firstBlock = runtime.blockNextTreeRead();
  const first = managed.getTree();
  await firstBlock.entered;
  let secondSettled = false;
  const second = managed.getTree().finally(() => { secondSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const secondEscaped = secondSettled;
  firstBlock.release();
  const outcomes = await Promise.allSettled([first, second]);

  assert.equal(secondEscaped, false);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
});

test("stop rejects a pending input before starting Worker cleanup", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "stop-input-preflight");
  const managed = harness.registry.get(created.id);
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  const preflight = runtime.blockNextPromptBeforePreflight();
  const disposal = runtime.blockDispose();

  const submitting = client.prompt(created.id, "rejected after stop", "auto", "pre-stop-input");
  await preflight.entered;
  const stopping = managed.stop("stop-after-input-reservation");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(managed.snapshot().lifecycle, "stopping");
  assert.equal(runtime.disposeCalls, 0);
  await assert.rejects(
    client.prompt(created.id, "too late", "auto", "post-stop-input"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_not_active",
  );

  preflight.release();
  await assert.rejects(
    submitting,
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_not_active",
  );
  await disposal.entered;
  assert.equal(runtime.disposeCalls, 1);
  disposal.release();
  const stopped = await stopping;

  assert.equal(stopped.stopped, true);
  assert.equal(managed.snapshot().lifecycle, "stopped");
  assert.equal(runtime.disposeCalls, 1);
});

test("Stop publishes non-terminal Worker cleanup failures", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "stop-cleanup-errors");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  await client.prompt(created.id, "queued before cleanup", "steer", "queue-before-cleanup");
  runtime.clearQueueError = new Error(`fixture queue cleanup failed ${"q".repeat(1_500)}`);
  runtime.abortError = new Error(`fixture abort cleanup failed ${"a".repeat(1_500)}`);

  const stopped = await client.stop(created.id, "stop-with-cleanup-errors");

  assert.equal(stopped.instance.lifecycle, "stopped");
  assert.equal(stopped.receipt.cleanupErrors?.length, 2);
  assert.match(stopped.receipt.cleanupErrors?.[0] ?? "", /^clearQueue: fixture queue cleanup failed/u);
  assert.match(stopped.receipt.cleanupErrors?.[1] ?? "", /^abort: fixture abort cleanup failed/u);
  assert.match(stopped.instance.lastError ?? "", /^clearQueue: fixture queue cleanup failed/u);
  assert.ok((stopped.instance.lastError?.length ?? 0) <= MAX_STOP_CLEANUP_ERROR_CHARS);
  assert.equal(runtime.disposeCalls, 1);
});

test("abort runtime ambiguity stays operation-scoped without faulting the catalog", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "abort-error");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  runtime.abortError = new Error("AUTH_TOKEN_very_secret");

  await assert.rejects(
    client.abort(created.id, "abort-runtime-unknown"),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "effect_unknown"
      && error.operationId === "abort-runtime-unknown"
      && !error.message.includes("AUTH_TOKEN"),
  );
  assert.equal((await client.hostInfo()).state, "ready");
});

test("fresh conversation bootstrap switches atomically from active frames to persisted records at a Worker checkpoint", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "conversation-checkpoint");
  const runtime = harness.sessions.get(created.id)!;

  runtime.emit({
    type: "dock_conversation_frame",
    frame: {
      type: "message.delta",
      data: { messageId: "fixture-assistant-1", block: "text", delta: "same visible text" },
    },
  });
  const active = await client.streamEvents(created.id, {
    onEvent: () => {},
    requireTuiProjection: true,
    conversationBootstrap: true,
  });
  assert.deepEqual(active.initial.recentHistory, [], "Host history remains at the last Worker persistence boundary during a turn");
  assert.ok(active.initial.page.events.some((event) => event.type === "message.submitted" && event.data.text === "deterministic delayed task"));
  assert.ok(active.initial.page.events.some((event) => event.type === "message.delta" && event.data.delta === "same visible text"));
  active.close();
  await active.done;

  runtime.settle("same visible text");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const persisted = await client.streamEvents(created.id, {
    onEvent: () => {},
    requireTuiProjection: true,
    conversationBootstrap: true,
  });
  assert.deepEqual(persisted.initial.recentHistory.map((entry) => entry.source), ["user", "assistant"]);
  assert.deepEqual(persisted.initial.page.events, [], "checkpoint release is producer-driven and does not wait for a client ACK");
  persisted.close();
  await persisted.done;
});

test("a message submitted as abort settles stays visible and is not mistaken for Queue work", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "abort-boundary-message");
  const runtime = harness.sessions.get(created.id)!;

  // The submission reaches Pi while its old run still appears active. During
  // asynchronous input handling, Esc finishes that run before Pi's final
  // delivery check. The old implementation labeled this as queued and then
  // dropped the accepted user frame because Host had no matching Queue item.
  const preflight = runtime.blockNextPromptBeforePreflight();
  const acceptedPromise = client.prompt(created.id, "message after Esc", "auto", "after-esc-operation");
  await preflight.entered;
  runtime.becomeIdleBeforeHostSettlement();
  preflight.release();
  const accepted = await acceptedPromise;
  assert.equal(accepted.receipt.delivery, "prompt");
  assert.equal(accepted.receipt.queued, false);

  const projection = await client.read(created.id, undefined, "conversation_bootstrap");
  const submitted = projection.page.events.filter((event) => (
    event.type === "message.submitted" && event.data.operationId === "after-esc-operation"
  ));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.type === "message.submitted" ? submitted[0].data.text : undefined, "message after Esc");
  assert.equal(submitted[0]?.type === "message.submitted" ? submitted[0].data.delivery : undefined, "prompt");
  assert.equal(submitted[0]?.type === "message.submitted" ? submitted[0].data.queueItemId : undefined, undefined);
  assert.equal(projection.pendingMessages.length, 0);
  assert.equal(projection.page.events.some((event) => event.type === "instance.error"), false);

  runtime.settle("received safely");
  await harness.registry.get(created.id).waitForIdle();
});

test("a reconnected client can start a fresh prompt on an idle instance", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-idle-prompt-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessions = new Map<string, DelayedAgentWorkerConnection>();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedAgentWorkerConnection(`pi-${id}`);
    sessions.set(id, session);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session });
  }, () => "idle-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => {
    await host.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await host.start();

  const created = await new DockClient({ socketPath }).create(directory);
  assert.equal(created.execution, "idle");
  const accepted = await new DockClient({ socketPath }).prompt(created.id, "start now");
  assert.equal(accepted.receipt.kind, "prompt");
  assert.equal(accepted.receipt.delivery, "prompt");
  assert.equal(accepted.receipt.queued, false);
  assert.equal(accepted.instance.execution, "running");
  assert.equal((await new DockClient({ socketPath }).status(created.id)).execution, "running");

  const cursor = accepted.instance.eventCursor;
  sessions.get(created.id)?.settle("finished");
  await registry.get(created.id).waitForIdle();
  const replay = await new DockClient({ socketPath }).read(created.id, cursor);
  assert.ok(replay.page.events.some((event) => event.type === "run.settled"));
  assert.equal(replay.instance.lastRun, "succeeded");
});

test("a running instance applies live metadata and next-step configuration without disturbing the run or queue", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-model-control-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "model-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => {
    await host.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await host.start();

  const client = new DockClient({ socketPath });
  const created = await client.create(directory);
  const catalog = await client.models(created.id);
  assert.deepEqual(catalog.models.map((model) => `${model.provider}/${model.id}`), [
    "fixture/default",
    "fixture/local",
  ]);
  assert.deepEqual(catalog.availableThinkingLevels, ["off", "low", "high"]);

  const thinking = await client.setThinking(created.id, "high");
  assert.equal(thinking.instance.executor.thinkingLevel, "high");
  const selected = await client.setModel(created.id, "fixture", "local");
  assert.deepEqual(selected.instance.executor.model, { provider: "fixture", id: "local" });
  assert.equal(selected.instance.executor.thinkingLevel, "high");

  const accepted = await client.prompt(created.id, "start");
  assert.equal(accepted.instance.execution, "running");
  assert.equal(accepted.instance.displayName, created.displayName);
  const activeCommandId = accepted.instance.activeCommandId;
  assert.ok(activeCommandId);
  const queued = await client.prompt(created.id, "use this next", "steer");
  assert.equal(queued.instance.pending.total, 1);

  const liveModel = await client.setModel(created.id, "fixture", "default");
  const liveThinking = await client.setThinking(created.id, "low");
  const liveTools = await client.setActiveTools(created.id, ["read", "write"]);
  const liveName = await client.nameSession(created.id, "Still running");
  for (const snapshot of [liveModel.instance, liveThinking.instance, liveTools.instance, liveName.instance]) {
    assert.equal(snapshot.execution, "running");
    assert.equal(snapshot.activeCommandId, activeCommandId);
    assert.equal(snapshot.pending.total, 1);
  }
  assert.equal(liveName.instance.name, "Still running");
  assert.equal(liveName.instance.displayName, "Still running");
  assert.deepEqual(liveTools.tools.filter((tool) => tool.active).map((tool) => tool.name), ["read", "write"]);

  const liveSetting: SettingUpdate = { key: "showHardwareCursor", value: true };
  const settingResult = await client.updateSetting(created.id, liveSetting, "live-setting");
  assert.deepEqual(settingResult.setting.value, liveSetting.value);
  assert.equal(settingResult.instance.execution, "running");
  assert.equal(settingResult.instance.activeCommandId, activeCommandId);
  assert.equal(settingResult.instance.pending.total, 1);

  await assert.rejects(
    client.updateSetting(created.id, { key: "autoCompaction", value: false }, "busy-setting"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_busy",
  );
  await assert.rejects(
    client.newSession(created.id, undefined, "busy-new"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_busy",
  );

  const events = await client.read(created.id);
  assert.ok(events.page.events.some((event) => event.type === "model.changed"));
  assert.ok(events.page.events.some((event) => event.type === "thinking.changed"));
  assert.ok(events.page.events.some((event) => event.type === "session.info_changed" && event.data.displayName === "Still running"));
});




test("models settings failures are typed, evented, and leave the in-memory state honest", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-settings-failure-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let session: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    session = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session });
  }, () => "settings-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory);
  (session as DelayedAgentWorkerConnection).settingsFailure = new Error("disk write failed");

  await assert.rejects(
    client.setModel(created.id, "fixture", "local", "failed-model-write"),
    (error: unknown) => error instanceof ControlClientError && error.code === "settings_write_failed" && /disk write failed/.test(error.message),
  );
  assert.deepEqual((await client.status(created.id)).executor.model, { provider: "fixture", id: "local" });
  const events = await client.read(created.id);
  assert.ok(events.page.events.some((event) => event.type === "settings.write_failed" && event.data.key === "model"));

  (session as DelayedAgentWorkerConnection).settingsFailure = undefined;
  const high = await client.setThinking(created.id, "high", "thinking-high");
  assert.equal(high.actualLevel, "high");
  assert.equal(high.settingsWrite.persisted, true);
});

test("tui projection exposes stable paged history and attach history while preserving semantic text", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "history");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  runtime.history = [
    agentRecord("h1", "user", [{ type: "text", text: "older question" }], { timestamp: "2020-01-01T00:00:00.000Z" }),
    agentRecord("h2", "assistant", [
      { type: "thinking", text: "plan" },
      { type: "tool_call", toolCallId: "tool-h3", toolName: "show_image", args: { path: "/tmp/demo.png" } },
      { type: "text", text: "older answer" },
    ], { parentId: "h1", timestamp: "2020-01-01T00:00:01.000Z", stopReason: "stop" }),
    agentRecord("h3", "tool", [{ type: "tool_result", toolCallId: "tool-h3", toolName: "show_image", isError: false, text: "data:image/png;base64,AAAA" }], {
      parentId: "h2", timestamp: "2020-01-01T00:00:02.000Z", toolCallId: "tool-h3", toolName: "show_image", isError: false,
    }),
  ];
  runtime.emit({ type: "conversation_checkpoint" });

  const latest = await client.history(created.id, undefined, 1);
  assert.deepEqual(latest.entries.map((entry) => entry.entryId), ["h2", "h3"], "a requested record limit cannot split one tool exchange");
  assert.equal(latest.hasEarlier, true);
  assert.equal(latest.nextBeforeEntryId, "h2");
  assert.equal(JSON.stringify(latest).includes("data:image"), true);
  // Worker-side semantic pagination is proven by history-pagination.test.ts and the real Pi gates;
  // here the fake worker windows naively, so this only checks the Protocol carries the worker page.
  const conversationLatest = await client.conversationHistory(created.id, undefined, 1);
  assert.deepEqual(conversationLatest.entries.map((item) => item.entry.entryId), ["h3"]);
  assert.equal(conversationLatest.hasEarlier, true);

  const earlier = await client.history(created.id, latest.nextBeforeEntryId, 2);
  assert.deepEqual(earlier.entries.map((entry) => entry.entryId), ["h1"]);
  assert.equal(earlier.hasEarlier, false);
  assert.equal(earlier.historyRevision, latest.historyRevision);
  await assert.rejects(
    client.history(created.id, "not-on-branch", 2),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );

  const attached = await client.read(created.id);
  assert.ok(attached.page.events.length > 0);
  const attachResult = await client.streamEvents(created.id, { onEvent: () => {}, requireTuiProjection: true });
  assert.deepEqual(attachResult.initial.recentHistory.map((entry) => entry.entryId), ["h1", "h2", "h3"]);
  attachResult.close();
  await attachResult.done;

  runtime.history = [
    agentRecord("other-1", "user", [{ type: "text", text: "different branch" }]),
    agentRecord("h2", "assistant", [
      { type: "text", text: "different continuation" },
      { type: "tool_call", toolCallId: "tool-h3", toolName: "show_image", args: { path: "/tmp/other.png" } },
    ]),
    agentRecord("h3", "tool", [{ type: "tool_result", toolCallId: "tool-h3", toolName: "show_image", isError: false, text: "different result" }]),
  ];
  runtime.emit({ type: "conversation_checkpoint" });
  const changedDuringScan = await client.history(created.id, latest.nextBeforeEntryId, 2);
  assert.notEqual(changedDuringScan.historyRevision, latest.historyRevision);

  const largeDisplayDiff = "+changed\n".repeat(28_440);
  const largeToolPresentation = { kind: "edit" as const, preview: "head-tail" as const, notices: [], displayDiff: largeDisplayDiff };
  runtime.history = [
    ...Array.from({ length: 198 }, (_, index) => agentRecord(
      `large-${index}`,
      "user",
      [{ type: "text", text: "x".repeat(8_000) }],
      { timestamp: `2020-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z` },
    )),
    agentRecord("large-tool-call", "assistant", [
      { type: "tool_call", toolCallId: "large-tool-1", toolName: "edit", args: { path: "/tmp/large-1" } },
      { type: "tool_call", toolCallId: "large-tool-2", toolName: "edit", args: { path: "/tmp/large-2" } },
    ]),
    agentRecord("large-tool-result-1", "tool", [
      { type: "tool_result", toolCallId: "large-tool-1", toolName: "edit", isError: false, text: "large result".repeat(20_000), presentation: largeToolPresentation },
    ], { toolCallId: "large-tool-1", toolName: "edit", isError: false }),
    agentRecord("large-tool-result-2", "tool", [
      { type: "tool_result", toolCallId: "large-tool-2", toolName: "edit", isError: false, text: "large result".repeat(20_000), presentation: largeToolPresentation },
    ], { toolCallId: "large-tool-2", toolName: "edit", isError: false }),
  ];
  runtime.emit({ type: "conversation_checkpoint" });
  const bounded = await client.streamEvents(created.id, { onEvent: () => {}, requireTuiProjection: true });
  assert.equal(bounded.initial.historyTruncated, true);
  assert.ok(bounded.initial.recentHistory.length > 0 && bounded.initial.recentHistory.length < 200);
  assert.deepEqual(bounded.initial.recentHistory.slice(-3).map((entry) => entry.entryId), ["large-tool-call", "large-tool-result-1", "large-tool-result-2"]);
  assert.ok(bounded.initial.recentHistory.slice(-2).every((entry) => entry.content[0]?.type === "tool_result" && entry.content[0].presentation === undefined));
  assert.ok(bounded.initial.page.events.length > 0, "paged history must be trimmed before recent events");
  bounded.close();
  await bounded.done;
});

test("conversation content survives fresh clients through revision-bound Protocol V2 pages", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "conversation-content");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  runtime.history = [
    agentRecord("h1", "user", [{ type: "text", text: "one" }]),
    agentRecord("h2", "assistant", [{ type: "text", text: "legacy preview" }], { parentId: "h1" }),
    agentRecord("h3", "assistant", [{ type: "text", text: "legacy preview" }], { parentId: "h2" }),
  ];
  const fullText = `${"long".repeat(10_000)}😀done`;
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  runtime.conversationContent.set("fixture-h3", [
    { blockIndex: 0, type: "text", text: fullText.slice(0, 32_000), offset: 0, blockComplete: false },
    { blockIndex: 0, type: "text", text: fullText.slice(32_000), offset: 32_000, blockComplete: true },
    { blockIndex: 1, type: "tool_call", toolCallId: "call-1", toolName: "search", argumentsJson: "{\"query\":\"complete\"}", offset: 0, blockComplete: true },
    { blockIndex: 2, type: "image", mimeType: "image/png", data: imageData, offset: 0, blockComplete: true },
  ]);
  runtime.emit({ type: "conversation_checkpoint" });

  const latest = await client.conversationHistory(created.id, undefined, 2);
  assert.equal(latest.instance.runtimeGeneration, created.runtimeGeneration);
  assert.equal(latest.revision, runtime.conversationRevision);
  assert.deepEqual(latest.entries.map((item) => item.entry.entryId), ["h2", "h3"]);
  assert.ok(latest.entries.every((item) => item.contentComplete === false));
  assert.equal(latest.hasEarlier, true);

  const earlier = await client.conversationHistory(created.id, latest.nextCursor, 2);
  assert.deepEqual(earlier.entries.map((item) => item.entry.entryId), ["h1"]);
  assert.equal(earlier.revision, latest.revision);

  const freshClient = new DockClient({ socketPath: harness.socketPath });
  const contentRef = latest.entries[1]!.contentRef;
  const content = await freshClient.conversationContent(created.id, contentRef);
  assert.equal(content.runtimeGeneration, created.runtimeGeneration);
  assert.equal(content.revision, latest.revision);
  assert.equal(content.complete, true);
  assert.equal(content.chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.type === "text" ? chunk.text : "").join(""), fullText);
  assert.equal(content.chunks.find((chunk) => chunk.type === "tool_call")?.type, "tool_call");
  const image = content.chunks.find((chunk) => chunk.type === "image");
  assert.deepEqual(image, { blockIndex: 2, type: "image", mimeType: "image/png", data: imageData, offset: 0, blockComplete: true });

  runtime.conversationContent.delete(contentRef);
  await assert.rejects(
    freshClient.conversationContent(created.id, contentRef),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );
});

test("a Protocol V2 client displays path-free published metadata and reads the file until it disappears", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "published-file");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  const sourcePath = join(harness.directory, "display.png");
  const bytes = Buffer.alloc(300_000, 0x5a);
  await writeFile(sourcePath, bytes);
  const registry = new TransientFileRegistry();
  const published = await registry.publish(sourcePath);
  runtime.publishedFileRead = (fileRef, offset) => registry.read(fileRef, offset);
  runtime.history = [agentRecord("published-result", "tool", [{
    type: "tool_result", toolCallId: "show-1", toolName: "show_image", text: "Published display.png for display.", isError: false, publishedFile: published,
  }], { toolCallId: "show-1", toolName: "show_image", isError: false })];
  runtime.emit({ type: "conversation_checkpoint" });

  const read = await client.read(created.id);
  const wireMetadata = JSON.stringify(read.recentHistory[0]);
  assert.equal(wireMetadata.includes(harness.directory), false);
  assert.equal(wireMetadata.includes("base64"), false);
  assert.deepEqual((read.recentHistory[0]!.content[0] as { publishedFile?: unknown }).publishedFile, published);

  const first = await client.readFile(created.id, published.fileRef);
  assert.equal(first.complete, false);
  assert.equal(Buffer.from(first.data, "base64").length, 262_144);
  const second = await client.readFile(created.id, published.fileRef, first.nextOffset);
  assert.equal(second.complete, true);
  assert.deepEqual(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")]), bytes);

  await unlink(sourcePath);
  await assert.rejects(client.readFile(created.id, published.fileRef), (error: unknown) =>
    error instanceof ControlClientError && error.code === "file_unavailable" && /publish it again/iu.test(error.message));
});

test("Hub session inventory is runtime-free and adoption publishes one managed instance", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-session-inventory-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessionFile = "/sessions/orphan.jsonl";
  let factoryCalls = 0;
  let inventoryCalls = 0;
  let inventoryIncomplete = false;
  let inventorySessions: SessionDto[] = [{ sessionId: "orphan", sessionFile, name: "Orphan", firstUserMessage: "Plan release", cwd: directory, updatedAt: "2026-07-14T01:02:03.000Z" }];
  const trust = new ProjectTrustCoordinator({
    requiresTrust: () => true,
    savedDecision: () => null,
    defaultDecision: () => "ask",
    remember: () => {},
  });
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, name, sessionFile: adoptedFile }) => {
    factoryCalls += 1;
    const runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    if (adoptedFile) runtime.sessionFile = adoptedFile;
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, name, session: runtime });
  }, () => "adopted-instance", {
    trustPreflight: trust,
    reopenTargetResolver: { resolve: async (target) => {
      assert.equal(target, sessionFile);
      return { cwd: directory };
    } },
  });
  const host = new DockHost({
    socketPath,
    registry,
    sessionInventory: {
      list: async (cwd, scope) => {
        inventoryCalls += 1;
        assert.equal(cwd, directory);
        assert.equal(scope, "all");
        return {
          sessions: inventorySessions,
          incomplete: inventoryIncomplete,
          diagnostics: inventoryIncomplete ? [{ message: "One saved session could not be read", path: "/sessions/broken.jsonl" }] : [],
        };
      },
    },
  });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });

  assert.deepEqual((await client.sessionInventory(directory, "all")).sessions, [{
    sessionId: "orphan", sessionFile, name: "Orphan", firstUserMessage: "Plan release", cwd: directory, updatedAt: "2026-07-14T01:02:03.000Z",
  }]);
  assert.equal(inventoryCalls, 1);
  assert.equal(factoryCalls, 0, "inventory must not construct a runtime");
  assert.deepEqual(await client.list("all"), []);

  let challengeId = "";
  await assert.rejects(client.adopt(sessionFile, "Orphan", "adopt-op"), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, "project_trust_required");
    challengeId = String(error.details?.challengeId ?? "");
    return challengeId.length > 0;
  });
  assert.equal(factoryCalls, 0, "project trust must precede adopted runtime construction");
  const adopted = await client.adopt(sessionFile, "Orphan", "adopt-op", { challengeId, decision: "deny_once" });
  assert.equal(factoryCalls, 1);
  assert.equal(adopted.instance.id, "adopted-instance");
  assert.equal(adopted.instance.creationOperationId, "adopt-op");
  assert.equal(adopted.instance.executor.sessionFile, sessionFile);
  assert.equal((await client.status(adopted.instance.id)).runtimeGeneration, 1);
  const duplicate = await client.adopt(sessionFile, "Orphan", "adopt-op", { challengeId, decision: "deny_once" });
  assert.equal(duplicate.instance.id, adopted.instance.id);
  assert.equal(factoryCalls, 1, "same-host adoption retry must use the operation ledger receipt");
  await assert.rejects(
    client.adopt(sessionFile, "Different", "adopt-op", { challengeId, decision: "deny_once" }),
    (error: unknown) => error instanceof ControlClientError && error.code === "operation_conflict",
  );
  await assert.rejects(
    client.adopt(sessionFile, "Sibling", "adopt-sibling"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_busy",
  );
  assert.equal(factoryCalls, 1, "one persisted session file cannot back two live Dock runtimes");

  inventoryIncomplete = true;
  inventorySessions = Array.from({ length: 100 }, (_, index) => ({
    sessionId: `bounded-${index}`,
    sessionFile: `/sessions/${index}-${"x".repeat(16_000)}.jsonl`,
    cwd: `${directory}/${"y".repeat(16_000)}`,
  }));
  const bounded = await client.sessionInventory(directory, "all");
  assert.equal(bounded.total, 100);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.sessions.length > 0 && bounded.sessions.length < bounded.total);
  assert.equal(bounded.incomplete, true);
  assert.deepEqual(bounded.diagnostics, [{ message: "One saved session could not be read", path: "/sessions/broken.jsonl" }]);
  assert.deepEqual(bounded.query, { cwd: directory, scope: "all" });
});

test("concurrent adoption of one persisted session file admits only one runtime", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-adopt-race-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessionFile = "/sessions/race.jsonl";
  let factoryCalls = 0;
  let releaseResolver!: () => void;
  let markResolverEntered!: () => void;
  const resolverEntered = new Promise<void>((resolveEntered) => { markResolverEntered = resolveEntered; });
  const resolverGate = new Promise<void>((resolveGate) => { releaseResolver = resolveGate; });
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, sessionFile: target }) => {
    factoryCalls += 1;
    const runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    if (target) runtime.sessionFile = target;
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, undefined, {
    reopenTargetResolver: { resolve: async () => {
      markResolverEntered();
      await resolverGate;
      return { cwd: directory };
    } },
  });
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const first = client.adopt(sessionFile, undefined, "race-one");
  await resolverEntered;
  await assert.rejects(
    client.adopt(sessionFile, undefined, "race-two"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_busy",
  );
  releaseResolver();
  await first;
  assert.equal(factoryCalls, 1);
  assert.equal(registry.list().length, 1);
  const other = await client.create(directory, "other", "race-create-other");
  await assert.rejects(
    client.switchSession(other.id, sessionFile, "race-switch-other"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_busy",
  );
  assert.equal(factoryCalls, 2);
  assert.equal(registry.list().length, 2);
});



test("session.core lists bounded safe cwd and all-session metadata", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-session-list-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let session: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    session = new DelayedAgentWorkerConnection(`pi-${id}`);
    session.sessionCatalog = [
      { sessionId: "cwd-session", sessionFile: "/sessions/cwd.jsonl", name: "Current", cwd: "/fixture/cwd", updatedAt: "2026-07-14T01:02:03.000Z" },
      { sessionId: "other-session", sessionFile: "/sessions/other.jsonl", cwd: "/other" },
    ];
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session });
  }, () => "session-list-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory);

  assert.deepEqual((await client.sessions(created.id, "cwd")).sessions, [{
    sessionId: "cwd-session", sessionFile: "/sessions/cwd.jsonl", name: "Current", cwd: "/fixture/cwd", updatedAt: "2026-07-14T01:02:03.000Z",
  }]);
  assert.deepEqual((await client.sessions(created.id, "all")).sessions, [
    { sessionId: "cwd-session", sessionFile: "/sessions/cwd.jsonl", name: "Current", cwd: "/fixture/cwd", updatedAt: "2026-07-14T01:02:03.000Z" },
    { sessionId: "other-session", sessionFile: "/sessions/other.jsonl", name: undefined, cwd: "/other", updatedAt: undefined },
  ]);
});

test("one public tree call returns a complete Pi snapshot larger than one control frame", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "tree-create");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  runtime.treeNodes = Array.from({ length: 800 }, (_, index) => ({
    entryId: `tree-${index}`,
    ...(index === 0 ? {} : { parentId: `tree-${index - 1}` }),
    depth: index,
    kind: "message" as const,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    displayClass: "content" as const,
    summary: `${index}: ${"complete compact tree ".repeat(75)}`,
    hasChildren: index < 799,
  }));
  runtime.treeLeafId = "tree-799";

  const tree = await client.tree(created.id);
  assert.equal(tree.nodes.length, 800);
  assert.equal(tree.nodes[0]?.entryId, "tree-0");
  assert.equal(tree.nodes.at(-1)?.entryId, "tree-799");
  assert.equal(tree.leafId, "tree-799");
  assert.equal(runtime.treeReadCalls, 1);
});

test("a Tree point that disappeared is rejected without changing the session", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "tree-target-create");
  const runtime = harness.sessions.get(created.id) as DelayedAgentWorkerConnection;
  runtime.treeNodes = [
    { entryId: "tree-root", depth: 0, kind: "message", role: "user", displayClass: "content", summary: "root", hasChildren: true },
    { entryId: "tree-leaf", parentId: "tree-root", depth: 1, kind: "message", role: "assistant", displayClass: "content", summary: "leaf", hasChildren: false },
  ];
  runtime.treeLeafId = "tree-leaf";
  runtime.settle("ready");
  await harness.registry.get(created.id).waitForIdle();

  await assert.rejects(
    client.navigateSession(created.id, "point-that-disappeared", {}, "tree-target-operation"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_tree_target",
  );
  assert.equal((await client.tree(created.id)).leafId, "tree-leaf");
  assert.equal((await client.status(created.id)).runtimeGeneration, created.runtimeGeneration);
});


test("unexpected host closure rejects a live follow subscription", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory);
  const subscription = await client.streamEvents(created.id, { onEvent: () => {} });

  await harness.host.stop();
  await assert.rejects(
    subscription.done,
    (error: unknown) => error instanceof ControlClientError && error.code === "connection_closed",
  );
});



test("a second host cannot unlink a live host socket", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();

  const contender = new DockHost({ socketPath: harness.socketPath, registry: harness.registry });
  await assert.rejects(contender.start(), /already listening/);

  const ping = await new DockClient({ socketPath: harness.socketPath }).ping();
  assert.equal(ping.protocolVersion, 2);
  await contender.stop();
  assert.equal((await new DockClient({ socketPath: harness.socketPath }).ping()).protocolVersion, 2);
});

test("concurrent host objects do not unlink the winning listener", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-host-race-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "dock.sock");
  const createRegistry = (): DockRegistry => new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedAgentWorkerConnection(`pi-${id}`) })
  ));
  const first = new DockHost({ socketPath, registry: createRegistry() });
  const second = new DockHost({ socketPath, registry: createRegistry() });

  const starts = await Promise.allSettled([first.start(), second.start()]);
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(starts.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await new DockClient({ socketPath }).ping()).protocolVersion, 2);

  await Promise.all([first.stop(), second.stop()]);
});

test("host rejects a socket directory accessible by other users", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-insecure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedAgentWorkerConnection(`pi-${id}`) })
  ));
  const host = new DockHost({ socketPath: join(directory, "dock.sock"), registry });

  await assert.rejects(host.start(), /must not grant group\/other access/);
});









test("an LF-truncated control response is reported as recoverable connection loss", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-partial-frame-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const capabilities = ["command.images.path.v1", "core.v2", "events.follow.v2", "extension_ui.persistent-interactions.v1", "extension_ui.tools-expanded.v1", "extension_ui.widgets.v1", "git.branch-footer.v1", "instance.catalog", "instance.display-name.v1", "instance.keys.v1", "instance.read.v1", "queue.control.v1", "run.abort.v1", "tool-result-presentation.v1", "tui.projection.v1"];
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = objectValue(JSON.parse(line) as unknown);
        if (frame.kind === "hello") {
          socket.write(encodeJsonLine({ kind: "hello_ack", requestId: frame.requestId, version: 2, host: { pid: 8, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "partial-epoch", startedAt: "2026-07-14T00:00:00.000Z" }, catalogSchemaVersion: 1, capabilities, limits: { maxLineBytes: 1048576, maxPromptChars: 256000, maxReplayEvents: 1000, maxHistoryItems: 200, maxInstanceListItems: 100, maxInstanceListBytes: 786432 } }));
        } else socket.end('{"kind":"response"');
      }
    });
  });
  await listen(server, socketPath);
  context.after(async () => { await close(server); await rm(directory, { recursive: true, force: true }); });

  const client = new DockClient({ socketPath });
  await assert.rejects(
    client.streamEvents("partial-instance", { onEvent: () => {}, requireTuiProjection: true }),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "connection_closed"
      && /reconnect to recover current state/u.test(error.message)
      && !/LF terminator/u.test(error.message),
  );
  await assert.rejects(
    client.create(directory, undefined, "partial-mutation"),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "effect_unknown"
      && error.operationId === "partial-mutation",
  );
});





test("slow attach readers drain bounded live-event backpressure without losing the stream", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "slow reader", "slow-reader-create");
  harness.sessions.get(created.id)!.settle("ready");
  await new Promise<void>((resolve) => setImmediate(resolve));

  const socket = createConnection(harness.socketPath);
  const decoder = new JsonLineDecoder();
  const frames: string[] = [];
  let finishError: unknown;
  let streamFinished = false;
  const finished = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (streamFinished) return;
      streamFinished = true;
      try { decoder.finish(); } catch (error) { finishError = error; }
      resolve();
    };
    socket.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
    socket.once("end", finish);
    socket.once("close", finish);
  });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(encodeJsonLine({
    kind: "hello", requestId: "slow-hello", versions: [2],
    client: { name: "slow-reader-test", version: "0.1.0", clientId: "slow-reader-client" },
    requiredCapabilities: ["core.v2", "events.follow.v2"],
  }));
  const waitForFrames = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (frames.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(frames.length >= count, `expected ${count} frames, received ${frames.length}`);
  };
  await waitForFrames(1);
  socket.write(encodeJsonLine({ kind: "request", version: 2, requestId: "slow-follow", type: "instance.follow", params: { instanceId: created.id, since: created.eventCursor } }));
  await waitForFrames(2);
  socket.pause();

  const runtime = harness.sessions.get(created.id)!;
  for (let index = 0; index < 180; index += 1) {
    runtime.emit({
      type: "dock_conversation_frame",
      frame: {
        type: "message.delta",
        data: { messageId: "fixture-assistant-1", block: "text", delta: `${String(index).padStart(3, "0")}:${"q".repeat(7_900)}` },
      },
    });
  }
  const hostProbe = harness.host as unknown as { attachBackpressureStats: { blocked: number; drained: number; overflow: number; timeout: number } };
  const backpressureDeadline = Date.now() + 5_000;
  while (hostProbe.attachBackpressureStats.blocked === 0 && Date.now() < backpressureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(hostProbe.attachBackpressureStats.blocked > 0, "the fixture must actually cross the server socket high-water mark");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(streamFinished, false, "temporary backpressure must not close the follow stream");
  socket.resume();
  runtime.emit({ type: "dock_extension_error", error: "post-drain sentinel" });
  const sentinelDeadline = Date.now() + 10_000;
  while (!frames.some((frame) => frame.includes("post-drain sentinel")) && Date.now() < sentinelDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(frames.some((frame) => frame.includes("post-drain sentinel")), "events queued across drain must remain observable");
  assert.equal(streamFinished, false, "the stream must remain usable after drain");

  const eventCursors = frames.map((frame) => JSON.parse(frame) as { kind?: string; event?: { sequence?: number } })
    .filter((frame) => frame.kind === "event")
    .map((frame) => frame.event?.sequence)
    .filter((sequence): sequence is number => typeof sequence === "number");
  assert.ok(eventCursors.length >= 181);
  for (let index = 1; index < eventCursors.length; index += 1) assert.ok(eventCursors[index]! > eventCursors[index - 1]!);

  socket.end();
  await Promise.race([finished, new Promise<void>((_, reject) => {
    const timeout = setTimeout(() => reject(new Error("slow stream did not finish after client close")), 10_000);
    timeout.unref();
  })]);
  assert.equal(finishError, undefined);
  for (const frame of frames) assert.doesNotThrow(() => JSON.parse(frame));
});

test("permanently stalled followers are bounded without affecting Extension UI operation", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "stalled reader", "stalled-reader-create");
  harness.sessions.get(created.id)!.settle("ready");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const operation = await client.controlExtensionUi(created.id, () => {});

  const socket = createConnection(harness.socketPath);
  const decoder = new JsonLineDecoder();
  const frames: string[] = [];
  socket.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(encodeJsonLine({
    kind: "hello", requestId: "stalled-hello", versions: [2],
    client: { name: "stalled-reader-test", version: "0.1.0", clientId: "stalled-reader-client" },
    requiredCapabilities: ["core.v2", "events.follow.v2", "extension_ui.v1", "extension_ui.persistent-interactions.v1"],
  }));
  const frameDeadline = Date.now() + 5_000;
  while (frames.length < 1 && Date.now() < frameDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  socket.write(encodeJsonLine({ kind: "request", version: 2, requestId: "stalled-follow", type: "instance.follow", params: { instanceId: created.id, since: created.eventCursor } }));
  while (frames.length < 2 && Date.now() < frameDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(frames.length >= 2);
  assert.doesNotMatch(frames[1]!, /controller|leaseToken/u);
  socket.pause();

  const serverSocket = [...((harness.host as unknown as { attachConnections: Map<string, Set<{ destroyed: boolean }>> }).attachConnections.get(created.id) ?? [])][0];
  assert.ok(serverSocket);
  const runtime = harness.sessions.get(created.id)!;
  for (let index = 0; index < 800; index += 1) {
    runtime.emit({
      type: "dock_conversation_frame",
      frame: {
        type: "message.delta",
        data: { messageId: "fixture-assistant-1", block: "text", delta: `${String(index).padStart(3, "0")}:${"z".repeat(7_900)}` },
      },
    });
  }
  const hostProbe = harness.host as unknown as { attachBackpressureStats: { blocked: number; drained: number; overflow: number; timeout: number } };
  const overflowDeadline = Date.now() + 5_000;
  while (hostProbe.attachBackpressureStats.overflow === 0 && Date.now() < overflowDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(hostProbe.attachBackpressureStats.overflow > 0, "the fixture must fill the bounded application queue");
  assert.equal(serverSocket.destroyed, true, "the bounded application queue must abort a permanently stalled stream");
  assert.equal((await client.status(created.id)).lifecycle, "active");
  assert.equal((await client.setExtensionWidgetViewport(created.id, operation.initial.leaseToken, created.runtimeGeneration, 90, 30)).accepted, true);

  const recovered = await client.streamEvents(created.id, { onEvent: () => {}, requireTuiProjection: true });
  assert.equal(recovered.initial.instance.lifecycle, "active");
  recovered.close();
  await recovered.done;
  operation.close();
  await operation.done;
  socket.destroy();
});



test("post-send mutation transport loss is effect_unknown with caller operation ID, while reads stay transport errors", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-effect-unknown-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = objectValue(JSON.parse(line) as unknown);
        if (frame.kind === "hello") {
          socket.write(encodeJsonLine({ kind: "hello_ack", requestId: frame.requestId, version: 2, host: { pid: 8, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "effect-epoch", startedAt: "2026-07-14T00:00:00.000Z" }, catalogSchemaVersion: 1, capabilities: ["core.v2", "extension_ui.tools-expanded.v1", "git.branch-footer.v1", "instance.catalog", "instance.display-name.v1", "instance.keys.v1"], limits: { maxLineBytes: 1048576, maxPromptChars: 256000, maxReplayEvents: 1000, maxHistoryItems: 200, maxInstanceListItems: 100, maxInstanceListBytes: 786432 } }));
        } else socket.destroy();
      }
    });
  });
  await listen(server, socketPath);
  context.after(async () => { await close(server); await rm(directory, { recursive: true, force: true }); });
  const client = new DockClient({ socketPath });

  await assert.rejects(client.create(directory, undefined, "caller-operation-1"), (error: unknown) => (
    error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "caller-operation-1"
  ));
  await assert.rejects(client.list(), (error: unknown) => error instanceof ControlClientError && error.code !== "effect_unknown");
});

test("post-send mutation timeout is effect_unknown and is not retried", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-effect-timeout-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let requests = 0;
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = objectValue(JSON.parse(line) as unknown);
        if (frame.kind === "hello") {
          socket.write(encodeJsonLine({ kind: "hello_ack", requestId: frame.requestId, version: 2, host: { pid: 9, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "timeout-epoch", startedAt: "2026-07-14T00:00:00.000Z" }, catalogSchemaVersion: 1, capabilities: ["core.v2", "extension_ui.tools-expanded.v1", "git.branch-footer.v1", "instance.catalog", "instance.display-name.v1", "instance.keys.v1"], limits: { maxLineBytes: 1048576, maxPromptChars: 256000, maxReplayEvents: 1000, maxHistoryItems: 200, maxInstanceListItems: 100, maxInstanceListBytes: 786432 } }));
        } else requests += 1;
      }
    });
  });
  await listen(server, socketPath);
  context.after(async () => { await close(server); await rm(directory, { recursive: true, force: true }); });
  const client = new DockClient({ socketPath, timeoutMs: 25 });

  await assert.rejects(client.create(directory, undefined, "timeout-operation"), (error: unknown) => (
    error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "timeout-operation"
  ));
  assert.equal(requests, 1);
  await assert.rejects(client.list(), (error: unknown) => error instanceof ControlClientError && error.code === "timeout");
  assert.equal(requests, 2);
});

test("Host correlates malformed post-hello requests with their supplied request ID", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const socket = createConnection(harness.socketPath);
  const decoder = new JsonLineDecoder();
  const frames: Array<Record<string, unknown>> = [];
  socket.on("data", (chunk: Buffer) => {
    for (const line of decoder.push(chunk)) frames.push(JSON.parse(line) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(encodeJsonLine({
    kind: "hello", requestId: "correlation-hello", versions: [2],
    client: { name: "correlation-test", version: "0.1.0", clientId: "correlation-client" },
    requiredCapabilities: ["core.v2"],
  }));
  const deadline = Date.now() + 5_000;
  while (frames.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(frames[0]?.kind, "hello_ack");
  socket.write(encodeJsonLine({ kind: "request", version: 2, requestId: "malformed-correlated", type: "instance.get", params: {} }));
  while (frames.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(frames[1]?.kind, "response");
  assert.equal(frames[1]?.requestId, "malformed-correlated");
  assert.equal((frames[1]?.error as { code?: unknown } | undefined)?.code, "invalid_request");
  socket.destroy();
});

test("client rejects a non-handshake frame before operations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-malformed-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end('{"kind":"response","version":999,"requestId":"fixed","ok":false}\n');
    });
  });
  await listen(server, socketPath);
  context.after(async () => {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  });

  const client = new DockClient({ socketPath, requestId: () => "fixed" });
  await assert.rejects(
    client.ping(),
    (error: unknown) => error instanceof ControlClientError && error.code === "protocol_incompatible",
  );
});

test("Host serves tools, settings, resources, and commands over Protocol V2", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-projections-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedAgentWorkerConnection | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedAgentWorkerConnection(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "projection-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, undefined, "projection-create");

  assert.deepEqual((await client.tools(instance.id)).tools.filter((tool) => tool.active).map((tool) => tool.name), ["read"]);
  const changedTools = await client.setActiveTools(instance.id, ["write"], "tools-op");
  assert.deepEqual(changedTools.tools.filter((tool) => tool.active).map((tool) => tool.name), ["write"]);

  const settings = await client.settings(instance.id);
  // Assert settings a user actually relies on, not a count derived from the same constant the fixture uses.
  const autoCompaction = settings.settings.find((setting) => setting.key === "autoCompaction");
  assert.equal(autoCompaction?.writable, true);
  assert.equal(typeof settings.settings.find((setting) => setting.key === "hideThinking")?.value, "boolean");
  if (!runtime) throw new Error("fixture runtime was not created");
  runtime.settingsReadFailure = new AgentInvalidSettingValueError("editorPaddingX");
  await assert.rejects(
    client.settings(instance.id),
    (error: unknown) => error instanceof ControlClientError && error.code === "settings_invalid" && !error.message.includes("99"),
  );
  runtime.settingsReadFailure = undefined;
  const updated = await client.updateSetting(instance.id, { key: "enableSkillCommands", value: false }, "setting-op");
  assert.equal(updated.setting.value, false);
  assert.equal(updated.reloadRequired, true);

  assert.equal((await client.resources(instance.id)).resources[0]?.name, "AGENTS.md");
  assert.deepEqual((await client.commands(instance.id, "fixture-prefix")).commands.map((command) => command.name), ["fixture-prefix", "fixture-prefix-long"]);
  assert.deepEqual((await client.commands(instance.id, "missing")).commands, []);
});

test("a failed catalog write rejects create without a ghost instance and the next create works", async (context) => {
  const failedPort = new ScriptedCatalogCommitPort();
  failedPort.failAt(1, "AUTH_TOKEN_very_secret data:image/png;base64,AAAA");
  const failed = await createTransactionHarness(failedPort);
  context.after(() => cleanupHarness(failed));
  const failedClient = new DockClient({ socketPath: failed.socketPath });
  await assert.rejects(
    failedClient.create(failed.directory, undefined, "create-failed"),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "catalog_write_failed"
      && error.message.includes("candidate was not published")
      && !error.message.includes("AUTH_TOKEN")
      && !error.message.includes("base64"),
  );
  assert.deepEqual(failed.registry.list(), [], "a rejected create must not leave a ghost instance");
  const recovered = await failedClient.create(failed.directory, undefined, "create-recovered");
  assert.equal((await failedClient.status(recovered.id)).lifecycle, "active");
});



test("one Work's Agent error remains local while sibling Work continues", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const failed = await client.create(harness.directory, "failed-work", "create-failed-work");
  const sibling = await client.create(harness.directory, "sibling-work", "create-sibling-work");

  await client.prompt(failed.id, "run until the provider stops", "prompt", "failed-run");
  harness.sessions.get(failed.id)!.settle("", "error", "provider request failed\nretry next cycle");
  await harness.registry.get(failed.id).waitForIdle();

  const observed = await client.read(failed.id);
  assert.equal(observed.instance.lifecycle, "active");
  assert.equal(observed.instance.execution, "failed");
  assert.equal(observed.instance.lastRun, "failed");
  assert.equal(observed.instance.lastError, "provider request failed\nretry next cycle");
  const settled = observed.page.events.find((event) => event.type === "run.settled");
  assert.equal(settled?.type === "run.settled" ? settled.data.error : undefined, "provider request failed\nretry next cycle");
  assert.equal((await client.hostInfo()).state, "ready");

  const continued = await client.prompt(sibling.id, "continue independently", "prompt", "sibling-run");
  assert.equal(continued.receipt.accepted, true);
  assert.equal(continued.instance.execution, "running");
});

test("mutation fault admission keeps extension widget viewport control available", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "fault-viewport");
  const operation = await client.controlExtensionUi(created.id, () => {});
  const hostState = harness.host as unknown as { state: "running" | "mutation_faulted" };
  hostState.state = "mutation_faulted";
  try {
    const viewport = await client.setExtensionWidgetViewport(
      created.id,
      operation.initial.leaseToken,
      created.runtimeGeneration,
      90,
      30,
    );
    assert.equal(viewport.accepted, true);
    await assert.rejects(
      client.setActiveTools(created.id, ["write"], "blocked-catalog-mutation"),
      (error: unknown) => error instanceof ControlClientError && error.code === "mutation_faulted",
    );
  } finally {
    hostState.state = "running";
    operation.close();
    await operation.done;
  }
});

test("a catalog failure before a command takes effect rejects it cleanly and the Host stays usable", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  port.failAt(2);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-pre-failure");
  await assert.rejects(
    client.prompt(created.id, "blocked", "prompt", "prompt-pre-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "catalog_write_failed",
  );
  assert.equal((await client.status(created.id)).execution, "idle", "a rejected command must not start a run");
  const recovered = await client.prompt(created.id, "allowed", "prompt", "prompt-after-pre-failure");
  assert.equal(recovered.receipt.accepted, true);
  assert.equal((await client.status(created.id)).execution, "running");
});

test("a catalog failure after a command took effect reports effect_unknown, then reads work and writes are refused", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  port.failAt(3);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-post-failure");
  const runtime = harness.sessions.get(created.id)!;
  // Hold the drain open so the reads below observe the draining Host instead of racing its shutdown.
  const disposeBlock = runtime.blockDispose();

  await assert.rejects(
    client.prompt(created.id, "ambiguous", "prompt", "prompt-post-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "prompt-post-failed",
  );
  await disposeBlock.entered;
  assert.equal((await client.hostInfo()).state, "draining");
  assert.equal((await client.status(created.id)).execution, "idle", "reads must keep answering while the Host drains");
  await assert.rejects(
    client.setActiveTools(created.id, ["write"], "mutation-after-fault"),
    (error: unknown) => error instanceof ControlClientError && error.code === "mutation_faulted",
  );
  disposeBlock.release();
  const fatal = await harness.host.waitForFatalCompletion();
  assert.equal(fatal.exitCode, 1, "the Host must shut down instead of continuing with unsaveable state");
});















interface PtyTuiResult {
  status: number;
  timedOut: boolean;
  resizedBytes: number;
  stableRenderBatches: number;
  stableOutputBytes: number;
  stableDraftRewrites: number;
  localizedActivityBatches: number;
  startupMouseEnableCount: number;
  navigationScrollbackClearCount: number;
  navigationRenderBatches: number;
  draftVisible: boolean;
  signalRestoreMs: number;
  output: string;
}

async function runPtyTui(
  command: string[],
  action: "detach" | "work-responsive" | "hub-exit" | "hub-click-leave" | "hub-narrow" | "hub-signal" | "hub-signal-inventory" | "hub-new" | "hub-continue" | "hub-mouse-continue" | "hub-history" | "hub-history-forget" | "hub-adopt" | "editor" | "abort" | "queue-restore" | "queue-inflight" | "queue-abort" | "transport-close" | "stream-recover" | "external-stop" | "compact-detach" | "compact-queue" | "stage3" | "stage6" | "tree-branch-roundtrip" | "model-search" | "model-disconnect" | "history-flow" | "history-live-flow" | "flow-frame-stability" | "tool-fold" | "activity-stability" | "activity-streaming" | "command-handled" | "work-native-mouse" | "extension-dialogs" | "extension-replacement" | "extension-pending-attach" | "extension-response-retry" = "detach",
  readyFile?: string,
  workingDirectory = process.cwd(),
): Promise<PtyTuiResult> {
  const environmentRoot = await mkdtemp(join(tmpdir(), "alu-dock-pty-user-"));
  try {
    const environment = await ptyUserEnvironment(environmentRoot, {
      ALU_DOCK_PTY_ACTION: action,
      ...(readyFile ? { ALU_DOCK_PTY_READY_FILE: readyFile } : {}),
    });
    return await new Promise((resolveRun, rejectRun) => {
      const driver = join(process.cwd(), "test/fixtures/pty-tui-driver.py");
      const child = spawn("python3", [driver, ...command], {
        cwd: workingDirectory,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", rejectRun);
      child.once("close", (code) => {
        if (code !== 0) {
          rejectRun(new Error(`PTY driver failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8")}`));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Partial<PtyTuiResult>;
          assert.equal(typeof parsed.status, "number");
          assert.equal(typeof parsed.timedOut, "boolean");
          assert.equal(typeof parsed.resizedBytes, "number");
          assert.equal(typeof parsed.stableRenderBatches, "number");
          assert.equal(typeof parsed.stableOutputBytes, "number");
          assert.equal(typeof parsed.stableDraftRewrites, "number");
          assert.equal(typeof parsed.localizedActivityBatches, "number");
          assert.equal(typeof parsed.startupMouseEnableCount, "number");
          assert.equal(typeof parsed.signalRestoreMs, "number");
          assert.equal(typeof parsed.navigationScrollbackClearCount, "number");
          assert.equal(typeof parsed.navigationRenderBatches, "number");
          assert.equal(typeof parsed.draftVisible, "boolean");
          assert.equal(typeof parsed.output, "string");
          resolveRun(parsed as PtyTuiResult);
        } catch (error) {
          rejectRun(new Error(`Invalid PTY driver result: ${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`, { cause: error }));
        }
      });
    });
  } finally {
    await rm(environmentRoot, { recursive: true, force: true });
  }
}

function assertHubPresentation(output: string, mainScreenMarker: string): void {
  const { enable, disable } = mouseTrackingSequences();
  assert.equal(output.split("\u001b[?1049h").length - 1, 1, "runDockHub must enter alternate screen once");
  assert.equal(output.split("\u001b[?1049l").length - 1, 1, "runDockHub must restore alternate screen once");
  assert.ok(output.includes(enable), "visible Hub menu must enable paired 1000/1006 tracking");
  const leave = output.indexOf("\u001b[?1049l");
  const cleanup = output.lastIndexOf(disable, leave);
  const marker = output.indexOf(mainScreenMarker, leave);
  assert.ok(cleanup >= 0 && cleanup < leave, "Hub mouse cleanup must precede alternate-screen restore");
  assert.ok(marker > leave, `${mainScreenMarker} must be emitted on the restored main screen`);
  assert.doesNotMatch(output.slice(leave + "\u001b[?1049l".length), /\u001b\[\?1049h|\u001b\[\?1000h|\u001b\[\?1006h/u);
}

function lastFullRedrawFrame(output: string): string[] {
  const frames = fullRedrawFrames(output);
  const frame = frames.at(-1);
  assert.ok(frame, "expected a full redraw after PTY resize");
  return frame;
}

function fullRedrawFrames(output: string): string[][] {
  const marker = "\u001b[2J\u001b[H\u001b[3J";
  const frames: string[][] = [];
  let start = output.indexOf(marker);
  while (start >= 0) {
    const bodyStart = start + marker.length;
    const syncEnd = output.indexOf("\u001b[?2026l", bodyStart);
    if (syncEnd < 0) break;
    const lines = plainTerminalOutput(output.slice(bodyStart, syncEnd)).split("\n");
    frames.push(lines);
    start = output.indexOf(marker, syncEnd);
  }
  return frames;
}

function plainTerminalOutput(output: string): string {
  return output
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "");
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await lstat(path); return; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 20)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function objectValue(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

test("prompt images reach the agent once, and reusing the operation ID with different content is rejected", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const instance = await client.create(harness.directory, undefined, "create-image-contract");
  const images = [{ path: join(harness.directory, "input.custom"), mimeType: "image/x-custom" }];
  const receipt = await client.prompt(instance.id, "same", "auto", "image-wire-op", images);
  assert.equal(receipt.receipt.operationId, "image-wire-op");
  const runtime = harness.sessions.get(instance.id)!;
  assert.deepEqual(runtime.promptOptions.at(-1)?.images, images);
  await assert.rejects(
    client.prompt(instance.id, "same", "auto", "image-wire-op", [{ path: join(harness.directory, "changed.custom"), mimeType: "image/x-custom" }]),
    (error: unknown) => error instanceof ControlClientError && error.code === "operation_conflict",
  );
});
