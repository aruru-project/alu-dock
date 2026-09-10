#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

import { renderCliHelp, requestedCliHelp } from "./cli-help.js";
import { humanListWidth, renderHumanInstanceList, selectHumanInstanceList } from "./cli-list.js";
import { ControlClientError, DockClient } from "./control/dock-client.js";
import { DockHost } from "./control/dock-host.js";
import { DockRegistry } from "./control/dock-registry.js";
import { AttachmentService } from "./control/attachment-service.js";
import { AttachmentStorageState, attachmentStorageStateRoot } from "./control/attachment-storage-state.js";
import { FileCatalogStore, defaultCatalogPath } from "./control/durable-catalog-store.js";
import type { ProjectTrustChoice } from "./control/project-trust.js";
import { defaultLocalEndpoint } from "./control/local-endpoint.js";
import { defaultSocketPath, managedSocketPath } from "./control/socket-path.js";
import { RemoteAccessState, remoteAccessStateRoot } from "./control/remote-access-state.js";
import { WorkerIncidentStore, workerIncidentStoreRoot } from "./control/worker-incident-store.js";
import { MainMachineState, SubHostMachineState, machineStateRoot, readMachineJoinFile, writeMachineJoinFile } from "./control/machine-state.js";
import { MachineSettingsState, SubHostStatusReporter, machineSettingsStateRoot, machineStatePersistenceDiagnostic } from "./control/machine-settings-state.js";
import { MainMachineController, SubHostDockToolsPort, SubHostMachineConnection } from "./control/machine-transport.js";
import { MainMachineDockToolsAuthority, MainMachineDockToolsPort } from "./control/main-machine-dock-tools.js";
import type { DeliveryMode, DockEvent, EventCursor, InstanceSnapshot } from "./core/managed-instance.js";
import { humanControlErrorText } from "./human-control-error.js";
import { requireHumanTarget } from "./human-target.js";
import { localInstallBlockingInstances, localInstallLayout } from "./deployment/local-install.js";
import { UserServiceManager, type UserServiceStatus } from "./deployment/user-service.js";
import { WindowsHostLifecycleServer } from "./deployment/windows-host-lifecycle.js";
import { WindowsUserHostManager } from "./deployment/windows-user-host.js";
import {
  renderHumanServiceStatus,
  renderHumanServiceUninstall,
  type HumanServiceAction,
} from "./service-output.js";

const HOST_SHUTDOWN_TIMEOUT_MS = 12_000;

interface ParsedArgs {
  socketPath: string;
  socketExplicit: boolean;
  command: string;
  commandArgs: string[];
}

async function main(): Promise<void> {
  const parsed = parseGlobalArgs(process.argv.slice(2));
  const helpTopics = requestedCliHelp(parsed.command, parsed.commandArgs);
  if (helpTopics) {
    process.stdout.write(renderCliHelp(helpTopics));
    return;
  }

  if (parsed.command === "serve") {
    if (process.platform === "win32") await import("./deployment/windows-host-bootstrap.js");
    else await serve(parsed.socketPath, parsed.socketExplicit, parsed.commandArgs);
    return;
  }

  if (parsed.command === "host") {
    requireNoArgs(parsed.commandArgs, "host");
    if (process.platform !== "win32") throw new Error("`aludock host` is the foreground Windows Host entry. On this platform, use `aludock service start`.");
    await import("./deployment/windows-host-bootstrap.js");
    return;
  }

  if (parsed.command === "machine") {
    await manageMachine(parsed.commandArgs);
    return;
  }

  if (parsed.command === "service") {
    await manageService(parsed.socketPath, parsed.socketExplicit, parsed.commandArgs);
    return;
  }

  if (parsed.command === "diagnostics") {
    await showWorkerDiagnostics(parsed.commandArgs);
    return;
  }

  if (parsed.command === "pi:install") {
    await installPiExtension(parsed.commandArgs);
    return;
  }

  if (parsed.command === "update") {
    await updatePiModels(parsed.commandArgs);
    return;
  }

  if (parsed.command === "hub" || parsed.command === "continue" || parsed.command === "open" || parsed.command === "new" || parsed.command === "attach") {
    const options = parseInteractiveArgs(parsed.command, parsed.commandArgs);
    const { openDock } = await import("./interactive.js");
    await openDock({ socketPath: parsed.socketPath, ...options });
    return;
  }

  const client = new DockClient({ socketPath: parsed.socketPath });
  switch (parsed.command) {
    case "ping":
      requireNoArgs(parsed.commandArgs, "ping");
      writeJson({ kind: "pong", ...(await client.ping()) });
      return;

    case "create": {
      const options = parseCreateArgs(parsed.commandArgs);
      const operationId = options.operationId ?? randomUUID();
      const instance = await client.create(options.cwd, options.name, operationId, options.trust);
      writeJson({ kind: "instance", instance });
      return;
    }

    case "list": {
      const includeStopped = parseListArgs(parsed.commandArgs);
      const all = await client.list("all");
      const selection = selectHumanInstanceList(all, includeStopped);
      process.stdout.write(renderHumanInstanceList(selection.instances, humanListWidth(process.stdout.columns), {
        mode: includeStopped ? "all" : "actionable",
        hiddenStopped: selection.hiddenStopped,
        totalInstances: selection.instances.length,
      }));
      return;
    }

    case "status": {
      const target = requiredPositional(parsed.commandArgs, "status requires TARGET");
      const all = await client.list("all");
      const instance = requireHumanTarget(all, target);
      process.stdout.write(renderHumanInstanceList([instance], humanListWidth(process.stdout.columns), {
        mode: "all",
        totalInstances: 1,
      }));
      return;
    }

    case "events":
      await showEvents(client, parsed.commandArgs);
      return;

    case "prompt": {
      const options = parsePromptArgs(parsed.commandArgs);
      const result = await client.prompt(options.instanceId, options.message, options.delivery);
      writeJson({ kind: "receipt", action: "prompt", ...result });
      return;
    }

    case "reopen": {
      const options = parseReopenArgs(parsed.commandArgs);
      const operationId = options.operationId ?? randomUUID();
      const result = await client.reopen(options.instanceId, operationId, options.sessionFile, options.trust);
      writeJson({ kind: "receipt", action: "reopen", ...result });
      return;
    }

    case "stop": {
      const target = requiredPositional(parsed.commandArgs, "stop requires TARGET");
      const instance = requireHumanTarget(await client.list("all"), target);
      const result = await client.stop(instance.id);
      process.stdout.write(`${result.receipt.alreadyStopped ? "Already stopped" : "Stopped"} ${displayInstance(result.instance)}.\n`);
      return;
    }

    case "forget": {
      const target = requiredPositional(parsed.commandArgs, "forget requires TARGET");
      const instance = requireHumanTarget(await client.list("all"), target);
      await client.forget(instance.id);
      process.stdout.write(`Removed ${displayInstance(instance)} from Dock history. Any saved Pi session and project files remain in place.\n`);
      return;
    }

    case "prune": {
      if (parsed.commandArgs.length !== 1 || parsed.commandArgs[0] !== "--stopped") {
        throw new Error("prune requires exactly --stopped");
      }
      const result = await client.pruneStopped();
      const count = result.receipt.forgottenCount;
      process.stdout.write(count === 0
        ? "Dock history is already clear of ended work.\n"
        : `Removed ${count} ended work item${count === 1 ? "" : "s"} from Dock history. Any saved Pi sessions and project files remain in place.\n`);
      if (result.receipt.hasMore) process.stdout.write("More ended work is still in History; run `aludock prune --stopped` again.\n");
      return;
    }

    default:
      throw new Error(`Unknown command: ${parsed.command}\n\n${renderCliHelp([])}`);
  }
}

export async function runWindowsHost(windowsLifecycle: WindowsHostLifecycleServer): Promise<void> {
  const parsed = parseGlobalArgs(process.argv.slice(2));
  if (parsed.command === "serve") {
    await serve(parsed.socketPath, parsed.socketExplicit, parsed.commandArgs, windowsLifecycle);
  } else {
    await serve(defaultLocalEndpoint("win32") as string, true, ["--dev", "--state", defaultCatalogPath()], windowsLifecycle);
  }
}

async function serve(socketPath: string, socketExplicit: boolean, args: string[], windowsLifecycle?: WindowsHostLifecycleServer): Promise<void> {
  let registry!: DockRegistry;
  let host!: DockHost;
  let upstream: SubHostMachineConnection | undefined;
  let subHostStatus: { state: MachineSettingsState; hostEpoch: string; reporter: SubHostStatusReporter } | undefined;
  try {
  let options = parseServeOptions(args);
  let catalogPath = options.statePath;
  let machineSettingsState: MachineSettingsState | undefined;
  if (options.mode === "managed") {
    if (socketExplicit) throw new Error("Managed Host rejects --socket overrides");
    if (process.env.ALU_DOCK_MANAGED !== "1") throw new Error("Managed Host requires ALU_DOCK_MANAGED=1 from the generated user unit");
    if (!process.env.STATE_DIRECTORY) throw new Error("Managed Host requires systemd STATE_DIRECTORY");
    socketPath = managedSocketPath();
    catalogPath = defaultCatalogPath();
  }
  if (catalogPath) {
    machineSettingsState = new MachineSettingsState(machineSettingsStateRoot(catalogPath));
    const configured = await machineSettingsState.read();
    if (windowsLifecycle?.stopRequested) return;
    if (configured.role === "subhost" && options.machinePort !== undefined) throw new Error("SubHost connection settings are changed in Settings, then applied on the next startup");
    options = configured.role === "subhost"
      ? {
        ...options,
        role: "subhost",
        machineName: configured.subhost?.name ?? "SubHost",
        mainAddress: configured.subhost?.mainAddress,
        machinePort: configured.subhost?.port,
      }
      : {
        ...options,
        role: "main",
        machineName: configured.main.name,
      };
  }
  if (options.mode === "dev" && options.role === "main" && !socketExplicit && !process.env.ALU_DOCK_SOCKET) {
    throw new Error("Development Main requires an explicit --socket PATH or ALU_DOCK_SOCKET");
  }
  if (options.role === "subhost" && (!catalogPath || !options.mainAddress || options.machinePort === undefined || !options.machineName)) {
    throw new Error("SubHost startup requires connection settings saved from the human interface");
  }
  if (options.role === "main" && options.machinePort !== undefined && !catalogPath) throw new Error("SubHost connections require --state PATH so trust and routes survive restart");
  if (options.role === "main" && (options.mainAddress || options.joinFile)) throw new Error("Main startup does not accept SubHost connection options");
  if (options.role === "main" && options.machinePort !== undefined) {
    const state = machineSettingsState as MachineSettingsState;
    const configured = await state.read();
    if (windowsLifecycle?.stopRequested) return;
    if (!configured.main.connectionsEnabled || configured.main.port !== options.machinePort || configured.main.name !== options.machineName) {
      await state.writeMainConnections({ enabled: true, port: options.machinePort, name: options.machineName });
    }
  }

  const { createPiInstance, createPiProjectTrustCoordinator, resolvePiReopenTarget } = await import("./pi/create-pi-instance.js");
  const { createPiSessionInventory } = await import("./pi/session-inventory.js");
  const managedPiAgentDir = options.mode === "managed"
    ? await (await import("./pi/pi-agent-directory.js")).resolveManagedPiAgentDir()
    : undefined;
  const trustPreflight = createPiProjectTrustCoordinator(managedPiAgentDir);
  const sessionInventory = createPiSessionInventory({
    ...(managedPiAgentDir === undefined ? {} : { sessionsRoot: join(managedPiAgentDir, "sessions") }),
    ...(catalogPath ? { cachePath: join(dirname(catalogPath), "session-inventory-v1.json") } : {}),
  });
  const attachmentService = catalogPath
    ? new AttachmentService(new AttachmentStorageState(attachmentStorageStateRoot(catalogPath)))
    : undefined;
  const incidentRecorder = catalogPath
    ? new WorkerIncidentStore(workerIncidentStoreRoot(catalogPath)).recorder(options.machineName ?? "This computer")
    : undefined;
  const createManagedPiInstance = (input: Parameters<typeof createPiInstance>[0]) => createPiInstance({
    ...input,
    ...(managedPiAgentDir === undefined ? {} : { agentDir: managedPiAgentDir }),
    ...(incidentRecorder === undefined ? {} : { workerIncidentRecorder: incidentRecorder }),
  });
  if (windowsLifecycle?.stopRequested) return;

  if (options.role === "subhost") {
    const subHostEpoch = randomUUID();
    const mainAddress = options.mainAddress as string;
    const machinePort = options.machinePort as number;
    const machineName = options.machineName as string;
    const settingsState = machineSettingsState as MachineSettingsState;
    const subState = new SubHostMachineState(machineStateRoot(catalogPath as string));
    if (options.joinFile) await subState.prepare(await readMachineJoinFile(options.joinFile), machineName);
    const enrolled = await subState.load();
    if (windowsLifecycle?.stopRequested) return;
    if (!enrolled) throw new Error("This computer is not enrolled with a Main. Start it as Main, then choose Use as SubHost in Settings.");
    if (enrolled.machineName !== machineName) await subState.updateMachineName(machineName);
    const statusReporter = new SubHostStatusReporter({
      state: settingsState,
      hostEpoch: subHostEpoch,
      onError: (error) => {
        process.stderr.write(`Alu Dock: SubHost connection status could not be saved. Work will keep running and the status will be retried automatically. ${machineStatePersistenceDiagnostic(error)}\n`);
      },
    });
    subHostStatus = { state: settingsState, hostEpoch: subHostEpoch, reporter: statusReporter };
    statusReporter.update(false);
    const upstreamConnection = new SubHostMachineConnection({
      state: subState,
      address: mainAddress,
      port: machinePort,
      hostEpoch: subHostEpoch,
      snapshots: () => registry.list(),
      acceptProtocolSocket: (socket) => host.acceptProtocolSocket(socket),
      onConnectionChanged: (connected) => statusReporter.update(connected),
    });
    upstream = upstreamConnection;
    const dockToolsPort = new SubHostDockToolsPort({ upstream: upstreamConnection, local: () => registry });
    registry = new DockRegistry(createManagedPiInstance, undefined, {
      hostEpoch: subHostEpoch,
      trustPreflight,
      catalogStore: new FileCatalogStore(catalogPath as string),
      reopenTargetResolver: { resolve: resolvePiReopenTarget },
      attachmentHostPort: attachmentService,
      dockToolsHostPort: dockToolsPort,
    });
    host = new DockHost({
      socketPath: join(dirname(catalogPath as string), "subhost-private.sock"),
      statePath: catalogPath as string,
      registry,
      initialize: () => registry.initializeCatalog(),
      sessionInventory,
      attachmentService,
      listen: false,
    });
  } else {
    const durable = catalogPath !== undefined;
    let remoteInstances: MainMachineController | undefined;
    let dockToolsAuthority: MainMachineDockToolsAuthority | undefined;
    const mainDockToolsPort = options.role === "main" && durable ? new MainMachineDockToolsPort({
      local: () => registry,
      authority: () => dockToolsAuthority as MainMachineDockToolsAuthority,
      mainHostId: async () => (await (remoteInstances as MainMachineController).machines()).find((machine) => machine.kind === "main")!.hostId,
    }) : undefined;
    registry = new DockRegistry(createManagedPiInstance, undefined, {
      trustPreflight,
      ...(durable ? { catalogStore: new FileCatalogStore(catalogPath as string), attachmentHostPort: attachmentService } : {}),
      ...(mainDockToolsPort ? { dockToolsHostPort: mainDockToolsPort } : {}),
      reopenTargetResolver: { resolve: resolvePiReopenTarget },
    });
    if (options.role === "main" && durable) {
      remoteInstances = new MainMachineController({
        state: new MainMachineState(machineStateRoot(catalogPath as string), options.machineName ?? "Main"),
        settingsState: machineSettingsState as MachineSettingsState,
        ...(options.machinePort === undefined ? {} : { requiredInitialPort: options.machinePort }),
        mainHostEpoch: registry.hostEpoch,
        invokeDockTool: (sourceMainId, sourceMachineId, request) => (dockToolsAuthority as MainMachineDockToolsAuthority).invoke(sourceMainId, sourceMachineId, request),
        dockToolsSourceOff: (sourceMainId) => (dockToolsAuthority as MainMachineDockToolsAuthority).cancelSource(sourceMainId),
        localSnapshots: () => registry.list(),
      });
      dockToolsAuthority = new MainMachineDockToolsAuthority({
        controller: () => remoteInstances as MainMachineController,
        instances: () => host.instanceDirectory(),
        localClient: new DockClient({ socketPath }),
        deliverLocalNotification: (sourceMainId, notification) => registry.get(sourceMainId).deliverObservation(notification),
      });
    }
    host = new DockHost({
      socketPath,
      ...(catalogPath ? { statePath: catalogPath, initialize: () => registry.initializeCatalog(), remoteAccessState: new RemoteAccessState(remoteAccessStateRoot(catalogPath)) } : {}),
      registry,
      sessionInventory,
      attachmentService,
      remoteInstances,
    });
  }

  // While initialization is in flight, latch stop and let finally dispose it
  // sequentially. DockHost.start/stop must not run against each other.
  windowsLifecycle?.onStartingStop(
    () => {},
    () => localInstallBlockingInstances(registry.list()).length,
  );
    if (windowsLifecycle?.stopRequested) return;
    await host.start();
    if (windowsLifecycle?.stopRequested) return;
    windowsLifecycle?.onStartingStop(
      () => { void host.stop().catch(() => {}); },
      () => localInstallBlockingInstances(registry.list()).length,
    );
    const initialRecovery = host.recoverInstancesOnce();
    let restoringWorks = true;
    void initialRecovery.then(() => { restoringWorks = false; }, () => { restoringWorks = false; });
    if (upstream) await upstream.start(initialRecovery);
    if (windowsLifecycle?.stopRequested) return;
    windowsLifecycle?.markReady(
      host.hostEpoch,
      options.role,
      () => localInstallBlockingInstances(registry.list()).length,
      () => { void host.stop().catch(() => {}); },
      () => ({
        ...(upstream === undefined ? {} : { mainConnected: upstream.connected() }),
        restoringWorks,
        unavailableWorks: restoringWorks ? 0 : registry.list().filter((work) => work.lifecycle === "runtime_error" || work.lifecycle === "host_lost").length,
      }),
    );
  writeJson({ kind: "host.ready", role: options.role, pid: process.pid, ...(options.role === "subhost" ? {} : { socketPath: host.socketPath }) });
  const outcome = await Promise.race([
    waitForSignal().then((signal) => ({ kind: "signal" as const, signal })),
    windowsLifecycle?.waitForStop().then(() => ({ kind: "signal" as const, signal: "SIGTERM" as NodeJS.Signals })),
    host.waitForFatalCompletion().then((fatal) => ({ kind: "fatal" as const, fatal })),
  ].filter((pending): pending is Exclude<typeof pending, undefined> => pending !== undefined));
  const signal = outcome.kind === "signal" ? outcome.signal : "catalog_fault";
  if (outcome.kind === "fatal") { process.stderr.write(`${JSON.stringify({ kind: "error", error: outcome.fatal })}\n`); process.exitCode = outcome.fatal.exitCode; }
  windowsLifecycle?.beginStop();
  writeJson({ kind: "host.stopping", signal });
  const shutdownTimeoutMs = outcome.kind === "fatal" ? 5_000 : HOST_SHUTDOWN_TIMEOUT_MS;
  const shutdownTimer = setTimeout(() => { process.stderr.write(`${JSON.stringify({ kind: "error", error: { code: "shutdown_timeout", message: `Host did not stop within ${shutdownTimeoutMs}ms` } })}\n`); process.exit(1); }, shutdownTimeoutMs);
  try { await upstream?.stop(); await host.stop(); } finally {
    clearTimeout(shutdownTimer);
  }
  const lateFatal = host.fatalCompletion();
  if (outcome.kind === "signal" && lateFatal) { process.stderr.write(`${JSON.stringify({ kind: "error", error: lateFatal })}\n`); process.exitCode = lateFatal.exitCode; }
  writeJson({ kind: "host.stopped", signal });
  } finally {
    await upstream?.stop();
    await host?.stop();
    if (subHostStatus) {
      await subHostStatus.reporter.stop();
      await subHostStatus.state.clearSubHostStatus(subHostStatus.hostEpoch).catch(() => {});
    }
  }
}

async function manageService(socketPath: string, socketExplicit: boolean, args: string[]): Promise<void> {
  if (socketExplicit || process.env.ALU_DOCK_SOCKET) throw new Error("service commands reject socket overrides");
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("Cannot locate the Alu Dock CLI entry point");
  const layout = localInstallLayout(process.env.HOME ?? process.env.USERPROFILE ?? "", undefined, {
    localAppData: process.env.LOCALAPPDATA,
  });
  const windowsHostLogPath = layout.windowsHostLogPath;
  if (process.platform === "win32" && !windowsHostLogPath) throw new Error("Alu Dock could not determine where to store Windows Host logs.");
  const serviceMachineSettings = new MachineSettingsState(machineSettingsStateRoot(defaultCatalogPath()));
  const manager = process.platform === "win32"
    ? new WindowsUserHostManager({
      nodePath: process.execPath,
      cliPath: resolve(entryPath),
      logPath: windowsHostLogPath as string,
    })
    : new UserServiceManager({
      nodePath: process.execPath,
      cliPath: resolve(entryPath),
      socketPath,
      subHostProbe: async () => {
        const status = await serviceMachineSettings.readSubHostStatus();
        if (status.processId !== undefined) {
          return { role: "subhost", processId: status.processId, ...(status.hostEpoch === undefined ? {} : { hostEpoch: status.hostEpoch }) };
        }
        return { role: (await serviceMachineSettings.read()).role };
      },
    });
  const { json, rest: serviceArgs } = parseServiceOutputOption(args);
  const [action = "status", ...rest] = serviceArgs;
  const writeStatus = (statusAction: HumanServiceAction, status: UserServiceStatus): void => {
    if (json) writeJson({ kind: "service", action: statusAction, ...status });
    else process.stdout.write(renderHumanServiceStatus(statusAction, status));
  };
  switch (action) {
    case "install": {
      let now = false;
      for (const argument of rest) {
        if (argument === "--now") now = true;
        else throw new Error(`Unknown service install argument: ${argument}`);
      }
      writeStatus(action, await manager.install(now));
      return;
    }
    case "start":
      requireNoArgs(rest, "service start");
      writeStatus(action, await manager.start());
      return;
    case "stop":
      requireNoArgs(rest, "service stop");
      writeStatus(action, await manager.stop());
      return;
    case "restart":
      requireNoArgs(rest, "service restart");
      writeStatus(action, await manager.restart());
      return;
    case "status":
      requireNoArgs(rest, "service status");
      writeStatus(action, await manager.status());
      return;
    case "logs": {
      if (json) throw new Error("service logs does not support --json");
      let lines = 200;
      let follow = false;
      for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index];
        if (argument === "--follow" || argument === "-f") follow = true;
        else if (argument === "--lines" || argument === "-n") {
          const value = Number(rest[++index]);
          if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error("service logs --lines must be between 1 and 10000");
          lines = value;
        } else throw new Error(`Unknown service logs argument: ${String(argument)}`);
      }
      const result = await manager.logs(lines, follow);
      if (result.status !== 0) process.exitCode = result.status;
      return;
    }
    case "uninstall": {
      requireNoArgs(rest, "service uninstall");
      const result = await manager.uninstall();
      if (json) writeJson({ kind: "service", action, ...result });
      else process.stdout.write(renderHumanServiceUninstall(result.removed));
      return;
    }
    default:
      throw new Error("service requires install, start, stop, restart, status, logs, or uninstall");
  }
}

async function showEvents(client: DockClient, args: string[]): Promise<void> {
  const mutable = [...args];
  const instanceId = mutable.shift();
  if (!instanceId || instanceId.startsWith("--")) throw new Error("events requires INSTANCE_ID");
  let cursor: EventCursor | undefined;
  let follow = false;

  while (mutable.length > 0) {
    const arg = mutable.shift();
    if (arg === "--cursor") {
      const raw = mutable.shift();
      if (raw === undefined) throw new Error("--cursor requires HOST_EPOCH:RUNTIME_GENERATION:SEQUENCE");
      cursor = parseEventCursor(raw, instanceId);
    } else if (arg === "--follow") {
      follow = true;
    } else {
      throw new Error(`Unknown events argument: ${String(arg)}`);
    }
  }

  if (!follow) {
    const result = await client.read(instanceId, cursor);
    writeJson({ kind: "events", ...result, following: false });
    return;
  }

  let initialWritten = false;
  const pendingEvents: DockEvent[] = [];
  const subscription = await client.streamEvents(instanceId, {
    since: cursor,
    onEvent: (event) => {
      if (initialWritten) writeJson({ kind: "event", event });
      else pendingEvents.push(event);
    },
  });
  writeJson({ kind: "events", ...subscription.initial });
  initialWritten = true;
  for (const event of pendingEvents) writeJson({ kind: "event", event });

  const close = (): void => subscription.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await subscription.done;
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  }
}

function parseEventCursor(value: string, instanceId: string): EventCursor {
  const parts = value.split(":");
  if (parts.length !== 3 || !parts[0]) {
    throw new Error("--cursor must use HOST_EPOCH:RUNTIME_GENERATION:SEQUENCE");
  }
  const runtimeGeneration = Number(parts[1]);
  const sequence = Number(parts[2]);
  if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1 || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("--cursor must use HOST_EPOCH:RUNTIME_GENERATION:SEQUENCE with positive generation and non-negative sequence");
  }
  return { hostEpoch: parts[0], instanceId, runtimeGeneration, sequence };
}

function parseGlobalArgs(args: string[]): ParsedArgs {
  const remaining: string[] = [];
  let socketPath = defaultSocketPath();
  let socketExplicit = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--socket") {
      const value = args[++index];
      if (!value) throw new Error("--socket requires a path");
      socketPath = value;
      socketExplicit = true;
    } else {
      remaining.push(arg as string);
    }
  }

  const command = remaining.shift();
  if (!command) return { socketPath, socketExplicit, command: "hub", commandArgs: [] };
  if (command === "--help" || command === "-h") {
    return { socketPath, socketExplicit, command: "help", commandArgs: [] };
  }
  if (command === "-c" || command === "--continue") {
    return { socketPath, socketExplicit, command: "continue", commandArgs: remaining };
  }
  if (command === "help") return { socketPath, socketExplicit, command, commandArgs: remaining };
  return { socketPath, socketExplicit, command, commandArgs: remaining };
}

interface ServeOptions {
  mode: "managed" | "dev";
  role: "main" | "subhost";
  machinePort?: number;
  machineName?: string;
  mainAddress?: string;
  statePath?: string;
  joinFile?: string;
}

function parseServeOptions(args: string[]): ServeOptions {
  let mode: ServeOptions["mode"] | undefined;
  const role: ServeOptions["role"] = "main";
  let machinePort: number | undefined;
  let statePath: string | undefined;
  let joinFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = (): string => { const next = args[++index]; if (!next) throw new Error(`${arg} requires a value`); return next; };
    if (arg === "--managed" || arg === "--dev") {
      if (mode) throw new Error("serve accepts one mode");
      mode = arg === "--managed" ? "managed" : "dev";
    } else if (arg === "--machine-port") machinePort = Number(value());
    else if (arg === "--state") statePath = resolve(value());
    else if (arg === "--join-file") joinFile = resolve(value());
    else throw new Error(`Unknown serve argument: ${String(arg)}`);
  }
  if (!mode) throw new Error("serve requires --managed or --dev");
  if (machinePort !== undefined && (!Number.isSafeInteger(machinePort) || machinePort < 1 || machinePort > 65_535)) throw new Error("Machine port must be between 1 and 65535");
  return {
    mode,
    role,
    ...(machinePort === undefined ? {} : { machinePort }),
    ...(statePath ? { statePath } : {}),
    ...(joinFile ? { joinFile } : {}),
  };
}

async function showWorkerDiagnostics(args: string[]): Promise<void> {
  let limit = 10;
  let verbose = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--verbose") verbose = true;
    else if (arg === "--limit") {
      const value = args[++index];
      if (!value || !/^\d+$/u.test(value)) throw new Error("diagnostics --limit requires a positive integer");
      limit = Number(value);
    } else throw new Error(`Unknown diagnostics argument: ${String(arg)}`);
  }
  const incidents = await new WorkerIncidentStore(workerIncidentStoreRoot(defaultCatalogPath())).list(limit);
  if (incidents.length === 0) {
    process.stdout.write("No Agent runtime failures have been recorded on this computer.\n");
    return;
  }
  for (const incident of incidents) {
    const work = diagnosticLiteral(incident.workName ?? "Unnamed work");
    const machine = diagnosticLiteral(incident.machineName);
    const exit = incident.signal ?? (incident.exitCode === undefined ? "unknown exit" : `exit ${incident.exitCode}`);
    process.stdout.write(`${incident.occurredAt} · ${work} on ${machine} · ${exit}\n`);
    process.stdout.write(`  ${diagnosticLiteral(incident.cause)}\n`);
    if (verbose && incident.stderrTail.length > 0) {
      process.stdout.write(`  Saved error output${incident.stderrTruncated ? " (tail only)" : ""}: ${diagnosticLiteral(incident.stderrTail)}\n`);
    }
  }
  if (!verbose) process.stdout.write("Run `aludock diagnostics --limit 1 --verbose` to include the latest saved error output.\n");
}

function diagnosticLiteral(value: string): string {
  return JSON.stringify(value).replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

async function manageMachine(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "join-file") throw new Error("machine requires join-file");
  let output: string | undefined;
  let statePath = defaultCatalogPath();
  let name = "Main";
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[++index];
    if (!value) throw new Error(`${String(arg)} requires a value`);
    if (arg === "--out") output = resolve(value);
    else if (arg === "--state") statePath = resolve(value);
    else if (arg === "--machine-name") name = value;
    else throw new Error(`Unknown machine join-file argument: ${String(arg)}`);
  }
  if (!output) throw new Error("machine join-file requires --out PATH");
  const state = new MainMachineState(machineStateRoot(statePath), name);
  await state.initialize();
  const joinFile = await state.createJoin();
  await writeMachineJoinFile(output, joinFile);
  process.stdout.write(`Created a one-use SubHost join file at ${output}. Enter the Main address and machine port separately on the SubHost.\n`);
}

function parseInteractiveArgs(
  command: "hub" | "continue" | "open" | "new" | "attach",
  args: string[],
): { mode: "hub" | "continue" | "open" | "new" | "attach"; cwd: string; name?: string; target?: string; forceNew?: boolean } {
  let cwd = process.cwd();
  let name: string | undefined;
  let target: string | undefined;
  let forceNew = command === "new";
  const mutable = [...args];
  while (mutable.length > 0) {
    const arg = mutable.shift();
    if (arg === "--cwd") {
      if (command === "attach" || command === "hub" || command === "continue") throw new Error(`${command} does not accept --cwd`);
      const value = mutable.shift();
      if (!value) throw new Error("--cwd requires a path");
      cwd = value;
    } else if (arg === "--name") {
      if (command === "attach" || command === "hub" || command === "continue") throw new Error(`${command} does not accept --name`);
      const value = mutable.shift();
      if (!value) throw new Error("--name requires a non-empty value");
      name = value;
    } else if (arg === "--new") {
      if (command !== "open") throw new Error(`${command} does not accept --new`);
      forceNew = true;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown ${command} argument: ${arg}`);
    } else if (command === "open" || command === "attach") {
      if (target !== undefined) throw new Error(`${command} accepts exactly one TARGET`);
      if (arg === undefined || arg.trim().length === 0) throw new Error(`${command} needs a work name; run \`aludock\` to choose work in the Hub`);
      target = arg;
    } else {
      throw new Error(`${command} does not accept TARGET`);
    }
  }
  if (command === "hub" && args.length > 0) throw new Error("The bare Dock Hub does not accept arguments");
  if (command === "continue" && args.length > 0) throw new Error("continue does not accept arguments; it uses the current directory");
  if (command === "attach" && target === undefined) throw new Error("attach requires a work name; run `aludock` to choose unnamed or duplicate work in the Hub");
  if (forceNew && target !== undefined) throw new Error(`${command} cannot combine TARGET with --new`);
  return { mode: command, cwd, name, target, forceNew };
}

function parseCreateArgs(args: string[]): {
  cwd: string;
  name?: string;
  operationId?: string;
  trust?: { challengeId: string; decision: ProjectTrustChoice };
} {
  let cwd = process.cwd();
  let name: string | undefined;
  let operationId: string | undefined;
  let challengeId: string | undefined;
  let decision: ProjectTrustChoice | undefined;
  const mutable = [...args];
  while (mutable.length > 0) {
    const arg = mutable.shift();
    if (arg === "--cwd") {
      const value = mutable.shift();
      if (!value) throw new Error("--cwd requires a path");
      cwd = value;
    } else if (arg === "--name") {
      const value = mutable.shift();
      if (!value) throw new Error("--name requires a non-empty value");
      name = value;
    } else if (arg === "--operation-id") {
      const value = mutable.shift();
      if (!value) throw new Error("--operation-id requires a non-empty value");
      operationId = value;
    } else if (arg === "--trust-challenge") {
      const value = mutable.shift();
      if (!value) throw new Error("--trust-challenge requires a non-empty value");
      challengeId = value;
    } else if (arg === "--project-trust") {
      const value = mutable.shift();
      if (!isProjectTrustChoice(value)) {
        throw new Error("--project-trust must be trust_once, trust_and_remember, deny_once, or deny_and_remember");
      }
      decision = value;
    } else {
      throw new Error(`Unknown create argument: ${String(arg)}`);
    }
  }
  if ((challengeId === undefined) !== (decision === undefined)) {
    throw new Error("--trust-challenge and --project-trust must be supplied together");
  }
  if (challengeId !== undefined && operationId === undefined) {
    throw new Error("A trust challenge retry must include the original --operation-id");
  }
  return {
    cwd,
    name,
    operationId,
    ...(challengeId === undefined || decision === undefined ? {} : { trust: { challengeId, decision } }),
  };
}

function parseReopenArgs(args: string[]): {
  instanceId: string;
  sessionFile?: string;
  operationId?: string;
  trust?: { challengeId: string; decision: ProjectTrustChoice };
} {
  const mutable = [...args];
  const instanceId = mutable.shift();
  if (!instanceId || instanceId.startsWith("--")) throw new Error("reopen requires INSTANCE_ID");
  let sessionFile: string | undefined;
  let operationId: string | undefined;
  let challengeId: string | undefined;
  let decision: ProjectTrustChoice | undefined;
  while (mutable.length > 0) {
    const arg = mutable.shift();
    if (arg === "--session-file") {
      const value = mutable.shift();
      if (!value) throw new Error("--session-file requires a path");
      sessionFile = resolve(value);
    } else if (arg === "--operation-id") {
      const value = mutable.shift();
      if (!value) throw new Error("--operation-id requires a non-empty value");
      operationId = value;
    } else if (arg === "--trust-challenge") {
      const value = mutable.shift();
      if (!value) throw new Error("--trust-challenge requires a non-empty value");
      challengeId = value;
    } else if (arg === "--project-trust") {
      const value = mutable.shift();
      if (!isProjectTrustChoice(value)) throw new Error("--project-trust must be trust_once, trust_and_remember, deny_once, or deny_and_remember");
      decision = value;
    } else {
      throw new Error(`Unknown reopen argument: ${String(arg)}`);
    }
  }
  if ((challengeId === undefined) !== (decision === undefined)) throw new Error("--trust-challenge and --project-trust must be supplied together");
  if (challengeId !== undefined && operationId === undefined) throw new Error("A trust challenge retry must include the original --operation-id");
  return {
    instanceId,
    sessionFile,
    operationId,
    ...(challengeId === undefined || decision === undefined ? {} : { trust: { challengeId, decision } }),
  };
}

function parsePromptArgs(args: string[]): {
  instanceId: string;
  message: string;
  delivery: DeliveryMode;
} {
  const [instanceId, ...mutable] = args;
  if (!instanceId || instanceId.startsWith("--")) throw new Error("prompt requires INSTANCE_ID and MESSAGE");
  let delivery: DeliveryMode = "auto";
  let deliverySeen = false;
  const messageParts: string[] = [];

  while (mutable.length > 0) {
    const arg = mutable.shift();
    if (arg === "--delivery") {
      if (deliverySeen) throw new Error("--delivery may only be specified once");
      const value = mutable.shift();
      if (!isDeliveryMode(value)) {
        throw new Error("--delivery must be auto, prompt, steer, or followUp");
      }
      delivery = value;
      deliverySeen = true;
    } else {
      messageParts.push(arg as string);
    }
  }

  const message = messageParts.join(" ");
  if (message.trim().length === 0) throw new Error("prompt requires a non-empty MESSAGE");
  return { instanceId, message, delivery };
}

function isDeliveryMode(value: unknown): value is DeliveryMode {
  return value === "auto" || value === "prompt" || value === "steer" || value === "followUp";
}

function isProjectTrustChoice(value: unknown): value is ProjectTrustChoice {
  return value === "trust_once"
    || value === "trust_and_remember"
    || value === "deny_once"
    || value === "deny_and_remember";
}

function parseListArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--all") return true;
  throw new Error("list accepts only --all");
}

function requiredPositional(args: string[], message: string): string {
  const [value, ...extra] = args;
  if (!value || extra.length > 0) throw new Error(message);
  return value;
}

function requireNoArgs(args: string[], command: string): void {
  if (args.length > 0) throw new Error(`${command} does not accept arguments`);
}

function parseServiceOutputOption(args: readonly string[]): { json: boolean; rest: string[] } {
  let json = false;
  const rest: string[] = [];
  for (const argument of args) {
    if (argument !== "--json") {
      rest.push(argument);
      continue;
    }
    if (json) throw new Error("service accepts --json only once");
    json = true;
  }
  return { json, rest };
}

function waitForSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolveSignal) => {
    let settled = false;
    const finish = (signal: NodeJS.Signals): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolveSignal(signal);
    };
    const onSigint = (): void => finish("SIGINT");
    const onSigterm = (): void => finish("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

async function updatePiModels(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "model") {
    throw new Error("update requires `model`; run `aludock help update`");
  }
  process.stdout.write("Updating Pi’s model list…\n");
  const { updatePiModelCatalog } = await import("./pi/pi-environment.js");
  try {
    await updatePiModelCatalog();
    process.stdout.write("Pi’s model list is up to date. Existing Work can load it with /reload.\n");
  } catch (error) {
    throw new Error(`Pi’s model list could not be updated: ${safeInstallOutput(errorMessage(error), 1_000)}. Check the network connection and try again.`, { cause: error });
  }
}

async function installPiExtension(args: string[]): Promise<void> {
  if (args.length !== 1 || !args[0] || args[0].startsWith("--")) {
    throw new Error("pi:install requires exactly one Pi package source; run `aludock help pi:install`");
  }
  const source = args[0];
  const { installPiPackage } = await import("./pi/pi-environment.js");
  let lastMessage: string | undefined;
  try {
    const result = await installPiPackage(source, {
      onProgress: (event) => {
        const message = event.message === undefined ? undefined : safeInstallOutput(event.message, 1_000);
        if (!message || message === lastMessage) return;
        lastMessage = message;
        process.stdout.write(`${message}\n`);
      },
    });
    process.stdout.write(`Installed ${safeInstallOutput(result.source, 500)} for Pi. Existing Work can load it with /reload.\n`);
  } catch (error) {
    throw new Error(`Pi couldn’t install ${safeInstallOutput(source, 500)}: ${safeInstallOutput(errorMessage(error), 1_000)}. Check the package source and try again.`, { cause: error });
  }
}

function safeInstallOutput(value: string, maxChars: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
  return safe.length <= maxChars ? safe : `${safe.slice(0, Math.max(0, maxChars - 1))}…`;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function displayInstance(instance: InstanceSnapshot): string {
  return instance.displayName;
}

function isMachineInvocation(args: readonly string[]): boolean {
  let command: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--socket") {
      index += 1;
      continue;
    }
    command = args[index];
    break;
  }
  return (command === "service" && args.includes("--json"))
    || command === "serve"
    || command === "ping"
    || command === "create"
    || command === "reopen"
    || command === "events"
    || command === "prompt";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => {
  if (!isMachineInvocation(process.argv.slice(2))) {
    const message = error instanceof ControlClientError ? humanControlErrorText(error) : errorMessage(error);
    process.stderr.write(`Alu Dock: ${message}\n`);
    process.exitCode = 1;
    return;
  }
  const code = error instanceof ControlClientError
    ? error.code
    : typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "cli_error";
  const details = error instanceof ControlClientError ? error.details : undefined;
  const operationId = error instanceof ControlClientError ? error.operationId : undefined;
  process.stderr.write(`${JSON.stringify({
    kind: "error",
    error: {
      code,
      message: errorMessage(error),
      ...(operationId === undefined ? {} : { operationId }),
      ...(details === undefined ? {} : { details }),
    },
  })}\n`);
  process.exitCode = 1;
});
