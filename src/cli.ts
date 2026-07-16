#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { renderCliHelp, requestedCliHelp } from "./cli-help.js";
import { humanListWidth, renderHumanInstanceList } from "./cli-list.js";
import { ControlClientError, DockClient } from "./control/dock-client.js";
import { DockHost } from "./control/dock-host.js";
import { DockRegistry } from "./control/dock-registry.js";
import { FileCatalogStore, defaultCatalogPath } from "./control/durable-catalog-store.js";
import type { ProjectTrustChoice } from "./control/project-trust.js";
import { defaultSocketPath, managedSocketPath } from "./control/socket-path.js";
import type { DeliveryMode, DockEvent, EventCursor } from "./core/managed-instance.js";
import { UserServiceManager } from "./deployment/user-service.js";

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
    await serve(parsed.socketPath, parsed.socketExplicit, parsed.commandArgs);
    return;
  }

  if (parsed.command === "service") {
    await manageService(parsed.socketPath, parsed.socketExplicit, parsed.commandArgs);
    return;
  }

  if (parsed.command === "open" || parsed.command === "new" || parsed.command === "attach") {
    const options = parseOpenArgs(parsed.command, parsed.commandArgs);
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
      const mode = includeStopped ? "all" : "actionable";
      const result = await client.listPage(mode);
      process.stdout.write(renderHumanInstanceList(result.instances, humanListWidth(process.stdout.columns), {
        mode,
        hiddenStopped: result.page.hiddenStopped,
        totalInstances: result.page.total,
      }));
      return;
    }

    case "status": {
      const instanceId = requiredPositional(parsed.commandArgs, "status requires INSTANCE_ID");
      writeJson({ kind: "instance", instance: await client.status(instanceId) });
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
      const instanceId = requiredPositional(parsed.commandArgs, "stop requires INSTANCE_ID");
      const result = await client.stop(instanceId);
      writeJson({ kind: "receipt", action: "stop", ...result });
      return;
    }

    case "forget": {
      const instanceId = requiredPositional(parsed.commandArgs, "forget requires INSTANCE_ID");
      const result = await client.forget(instanceId);
      process.stdout.write(`Forgot Dock record ${result.receipt.forgottenId}. Pi session files were not deleted.\n`);
      return;
    }

    case "prune": {
      if (parsed.commandArgs.length !== 1 || parsed.commandArgs[0] !== "--stopped") {
        throw new Error("prune requires exactly --stopped");
      }
      const result = await client.pruneStopped();
      process.stdout.write(`Pruned ${result.receipt.forgottenCount} stopped Dock record${result.receipt.forgottenCount === 1 ? "" : "s"}. Pi session files were not deleted.\n`);
      if (result.receipt.hasMore) process.stdout.write("More stopped records remain; run alu-dock prune --stopped again.\n");
      return;
    }

    default:
      throw new Error(`Unknown command: ${parsed.command}\n\n${renderCliHelp([])}`);
  }
}

async function serve(socketPath: string, socketExplicit: boolean, args: string[]): Promise<void> {
  const mode = parseServeMode(args);
  let managedSocket: string | undefined;
  let catalogPath: string | undefined;
  if (mode === "managed") {
    if (socketExplicit) throw new Error("Managed Host rejects --socket overrides");
    if (process.env.ALU_DOCK_MANAGED !== "1") throw new Error("Managed Host requires ALU_DOCK_MANAGED=1 from the generated user unit");
    if (!process.env.STATE_DIRECTORY) throw new Error("Managed Host requires systemd STATE_DIRECTORY");
    managedSocket = managedSocketPath();
    if (socketPath !== managedSocket) throw new Error("Managed Host socket does not match systemd RUNTIME_DIRECTORY");
    catalogPath = defaultCatalogPath();
  } else if (!socketExplicit && !process.env.ALU_DOCK_SOCKET) {
    throw new Error("Development Host requires an explicit --socket PATH or ALU_DOCK_SOCKET");
  }

  // Keep client commands thin: only the validated long-lived Host mode loads Pi SDK.
  const {
    createPiInstance,
    createPiProjectTrustCoordinator,
    resolvePiReopenTarget,
  } = await import("./pi/create-pi-instance.js");
  const trustPreflight = createPiProjectTrustCoordinator();
  let registry: DockRegistry;
  let host: DockHost;
  if (mode === "managed") {
    const store = new FileCatalogStore(catalogPath as string);
    registry = new DockRegistry(
      (input) => createPiInstance(input),
      undefined,
      {
        trustPreflight,
        catalogStore: store,
        reopenTargetResolver: { resolve: resolvePiReopenTarget },
      },
    );
    host = new DockHost({
      socketPath: managedSocket as string,
      statePath: catalogPath as string,
      registry,
      initialize: () => registry.initializeCatalog(),
    });
  } else {
    registry = new DockRegistry(
      (input) => createPiInstance(input),
      undefined,
      { trustPreflight, reopenTargetResolver: { resolve: resolvePiReopenTarget } },
    );
    host = new DockHost({ socketPath, registry });
  }
  await host.start();
  writeJson({ kind: "host.ready", pid: process.pid, socketPath: host.socketPath });

  const outcome = await Promise.race([
    waitForSignal().then((signal) => ({ kind: "signal" as const, signal })),
    host.waitForFatalCompletion().then((fatal) => ({ kind: "fatal" as const, fatal })),
  ]);
  const signal = outcome.kind === "signal" ? outcome.signal : "catalog_fault";
  if (outcome.kind === "fatal") {
    process.stderr.write(`${JSON.stringify({ kind: "error", error: outcome.fatal })}\n`);
    process.exitCode = outcome.fatal.exitCode;
  }
  writeJson({ kind: "host.stopping", signal });
  const shutdownTimeoutMs = outcome.kind === "fatal" ? 5_000 : HOST_SHUTDOWN_TIMEOUT_MS;
  const shutdownTimer = setTimeout(() => {
    process.stderr.write(`${JSON.stringify({
      kind: "error",
      error: {
        code: "shutdown_timeout",
        message: `Host did not stop within ${shutdownTimeoutMs}ms`,
      },
    })}\n`);
    process.exit(1);
  }, shutdownTimeoutMs);
  try {
    await host.stop();
  } finally {
    clearTimeout(shutdownTimer);
  }
  const lateFatal = host.fatalCompletion();
  if (outcome.kind === "signal" && lateFatal) {
    process.stderr.write(`${JSON.stringify({ kind: "error", error: lateFatal })}\n`);
    process.exitCode = lateFatal.exitCode;
  }
  writeJson({ kind: "host.stopped", signal });
}

async function manageService(socketPath: string, socketExplicit: boolean, args: string[]): Promise<void> {
  if (socketExplicit || process.env.ALU_DOCK_SOCKET) throw new Error("service commands reject socket overrides");
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("Cannot locate the Alu Dock CLI entry point");
  const manager = new UserServiceManager({
    nodePath: process.execPath,
    cliPath: resolve(entryPath),
    socketPath,
  });
  const [action = "status", ...rest] = args;
  switch (action) {
    case "install": {
      let now = false;
      for (const argument of rest) {
        if (argument === "--now") now = true;
        else throw new Error(`Unknown service install argument: ${argument}`);
      }
      writeJson({ kind: "service", action, ...(await manager.install(now)) });
      return;
    }
    case "start":
      requireNoArgs(rest, "service start");
      writeJson({ kind: "service", action, ...(await manager.start()) });
      return;
    case "stop":
      requireNoArgs(rest, "service stop");
      writeJson({ kind: "service", action, ...(await manager.stop()) });
      return;
    case "restart":
      requireNoArgs(rest, "service restart");
      writeJson({ kind: "service", action, ...(await manager.restart()) });
      return;
    case "status":
      requireNoArgs(rest, "service status");
      writeJson({ kind: "service", action, ...(await manager.status()) });
      return;
    case "logs": {
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
      const result = manager.logs(lines, follow);
      if (result.status !== 0) process.exitCode = result.status;
      return;
    }
    case "uninstall":
      requireNoArgs(rest, "service uninstall");
      writeJson({ kind: "service", action, ...(await manager.uninstall()) });
      return;
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
    const result = await client.events(instanceId, cursor);
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
  if (!command) return { socketPath, socketExplicit, command: "open", commandArgs: [] };
  if (command === "--help" || command === "-h") {
    return { socketPath, socketExplicit, command: "help", commandArgs: [] };
  }
  if (command === "help") return { socketPath, socketExplicit, command, commandArgs: remaining };
  return { socketPath, socketExplicit, command, commandArgs: remaining };
}

function parseServeMode(args: string[]): "managed" | "dev" {
  if (args.length !== 1 || (args[0] !== "--managed" && args[0] !== "--dev")) {
    throw new Error("serve requires exactly one mode: --managed or --dev");
  }
  return args[0] === "--managed" ? "managed" : "dev";
}

function parseOpenArgs(
  command: "open" | "new" | "attach",
  args: string[],
): { cwd: string; name?: string; instanceId?: string; forceNew: boolean } {
  let cwd = process.cwd();
  let name: string | undefined;
  let instanceId: string | undefined;
  let forceNew = command === "new";
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
    } else if (arg === "--new") {
      forceNew = true;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown ${command} argument: ${arg}`);
    } else if (!instanceId) {
      instanceId = arg;
    } else {
      throw new Error(`${command} accepts at most one INSTANCE_ID`);
    }
  }
  if (forceNew && instanceId) throw new Error(`${command} cannot combine INSTANCE_ID with --new`);
  return { cwd, name, instanceId, forceNew };
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

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
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
