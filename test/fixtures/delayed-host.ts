#!/usr/bin/env node

import { DockHost } from "../../src/control/dock-host.js";
import { DockRegistry } from "../../src/control/dock-registry.js";
import { ManagedInstance } from "../../src/core/managed-instance.js";
import { DelayedRuntimeSession } from "../support/delayed-runtime-session.js";

const [socketPath, allowedCwd, mode] = process.argv.slice(2);
if (!socketPath || !allowedCwd) throw new Error("delayed-host fixture requires SOCKET_PATH CWD [--idle]");
const startWithDelayedRun = mode !== "--idle";

const sessions = new Map<string, DelayedRuntimeSession>();
const instances = new Map<string, ManagedInstance>();
let sequence = 0;
const registry = new DockRegistry(async ({ id, cwd, name }) => {
  if (cwd !== allowedCwd) throw new Error(`unexpected fixture cwd: ${cwd}`);
  const session = new DelayedRuntimeSession(`fixture-pi-${id}`);
  const instance = new ManagedInstance({ id, cwd, name, session, eventCapacity: 100 });
  sessions.set(id, session);
  instances.set(id, instance);
  if (startWithDelayedRun) await instance.submit("deterministic delayed task");
  return instance;
}, () => `fixture-instance-${++sequence}`);
const host = new DockHost({ socketPath, registry });
let shutdownPromise: Promise<void> | undefined;

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = host.stop();
  await shutdownPromise;
}

async function main(): Promise<void> {
  await host.start();
  process.send?.({ type: "ready", socketPath: host.socketPath, pid: process.pid });

  process.on("message", (message: unknown) => {
    void handleMessage(message).catch((error: unknown) => {
      process.send?.({ type: "error", message: errorMessage(error) });
    });
  });
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("disconnect", () => void shutdown().then(() => process.exit(0)));
}

async function handleMessage(message: unknown): Promise<void> {
  const value = message !== null && typeof message === "object"
    ? message as Record<string, unknown>
    : {};
  if (value.type === "settle" && typeof value.instanceId === "string") {
    sessions.get(value.instanceId)?.settle("fake done");
    const instance = instances.get(value.instanceId);
    if (!instance) throw new Error(`unknown fixture instance: ${value.instanceId}`);
    await instance.waitForIdle();
    process.send?.({ type: "settled", instance: instance.snapshot() });
    return;
  }
  if (value.type === "shutdown") {
    await shutdown();
    if (process.send) {
      process.send({ type: "stopped" }, undefined, undefined, () => process.disconnect?.());
    } else {
      process.disconnect?.();
    }
    return;
  }
  throw new Error("unknown fixture message");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`delayed host fixture failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
