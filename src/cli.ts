#!/usr/bin/env node

import type { DockEvent } from "./core/managed-instance.js";
import { DockClient, ControlClientError } from "./control/dock-client.js";
import { DockHost } from "./control/dock-host.js";
import { DockRegistry } from "./control/dock-registry.js";
import { defaultSocketPath } from "./control/socket-path.js";

interface ParsedArgs {
  socketPath: string;
  command: string;
  commandArgs: string[];
}

async function main(): Promise<void> {
  const parsed = parseGlobalArgs(process.argv.slice(2));
  if (parsed.command === "help") {
    process.stdout.write(usage());
    return;
  }

  if (parsed.command === "serve") {
    await serve(parsed.socketPath, parsed.commandArgs);
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
      const instance = await client.create(options.cwd, options.name);
      writeJson({ kind: "instance", instance });
      return;
    }

    case "list":
      requireNoArgs(parsed.commandArgs, "list");
      writeJson({ kind: "instances", instances: await client.list() });
      return;

    case "status": {
      const instanceId = requiredPositional(parsed.commandArgs, "status requires INSTANCE_ID");
      writeJson({ kind: "instance", instance: await client.status(instanceId) });
      return;
    }

    case "events":
      await showEvents(client, parsed.commandArgs);
      return;

    default:
      throw new Error(`Unknown command: ${parsed.command}\n\n${usage()}`);
  }
}

async function serve(socketPath: string, args: string[]): Promise<void> {
  requireNoArgs(args, "serve");
  // Keep client commands thin: only the long-lived host process loads Pi SDK.
  const { createPiInstance } = await import("./pi/create-pi-instance.js");
  const registry = new DockRegistry(({ id, cwd, name }) => createPiInstance({ id, cwd, name }));
  const host = new DockHost({ socketPath, registry });
  await host.start();
  writeJson({ kind: "host.ready", pid: process.pid, socketPath: host.socketPath });

  const signal = await waitForSignal();
  writeJson({ kind: "host.stopping", signal });
  await host.stop();
  writeJson({ kind: "host.stopped", signal });
}

async function showEvents(client: DockClient, args: string[]): Promise<void> {
  const mutable = [...args];
  const instanceId = mutable.shift();
  if (!instanceId || instanceId.startsWith("--")) throw new Error("events requires INSTANCE_ID");
  let since = 0;
  let follow = false;

  while (mutable.length > 0) {
    const arg = mutable.shift();
    if (arg === "--since") {
      const raw = mutable.shift();
      if (raw === undefined) throw new Error("--since requires a value");
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("--since must be a non-negative safe integer");
      }
      since = parsed;
    } else if (arg === "--follow") {
      follow = true;
    } else {
      throw new Error(`Unknown events argument: ${String(arg)}`);
    }
  }

  if (!follow) {
    const result = await client.events(instanceId, since);
    writeJson({ kind: "events", ...result, following: false });
    return;
  }

  let initialWritten = false;
  const pendingEvents: DockEvent[] = [];
  const subscription = await client.streamEvents(instanceId, {
    since,
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

function parseGlobalArgs(args: string[]): ParsedArgs {
  const remaining: string[] = [];
  let socketPath = defaultSocketPath();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--socket") {
      const value = args[++index];
      if (!value) throw new Error("--socket requires a path");
      socketPath = value;
    } else {
      remaining.push(arg as string);
    }
  }

  const command = remaining.shift();
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { socketPath, command: "help", commandArgs: [] };
  }
  return { socketPath, command, commandArgs: remaining };
}

function parseCreateArgs(args: string[]): { cwd: string; name?: string } {
  let cwd = process.cwd();
  let name: string | undefined;
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
    } else {
      throw new Error(`Unknown create argument: ${String(arg)}`);
    }
  }
  return { cwd, name };
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

function usage(): string {
  return `Alu Dock V0 local control client\n\nUsage:\n  alu-dock [--socket PATH] serve\n  alu-dock [--socket PATH] ping\n  alu-dock [--socket PATH] create [--cwd PATH] [--name NAME]\n  alu-dock [--socket PATH] list\n  alu-dock [--socket PATH] status INSTANCE_ID\n  alu-dock [--socket PATH] events INSTANCE_ID [--since SEQUENCE] [--follow]\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  const code = error instanceof ControlClientError ? error.code : "cli_error";
  process.stderr.write(`${JSON.stringify({ kind: "error", error: { code, message: errorMessage(error) } })}\n`);
  process.exitCode = 1;
});
