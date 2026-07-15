import { randomUUID } from "node:crypto";

import { DockHost } from "../../src/control/dock-host.js";
import { FileCatalogStore } from "../../src/control/durable-catalog-store.js";
import { DockRegistry } from "../../src/control/dock-registry.js";
import { ManagedInstance } from "../../src/core/managed-instance.js";
import { DelayedRuntimeSession } from "../support/delayed-runtime-session.js";

const [socketPath, catalogPath, cwd, hostEpoch = randomUUID()] = process.argv.slice(2);
if (!socketPath || !catalogPath || !cwd) throw new Error("durable-host fixture requires socket, catalog, and cwd");

let runtimeCount = 0;
const createDelayMs = Number(process.env.ALU_DOCK_FIXTURE_CREATE_DELAY_MS ?? "0");
const registry = new DockRegistry(async (input) => {
  if (Number.isFinite(createDelayMs) && createDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, createDelayMs));
  runtimeCount += 1;
  const runtime = new DelayedRuntimeSession(`fixture-${hostEpoch}-${runtimeCount}`);
  if (input.sessionFile) runtime.sessionFile = input.sessionFile;
  return new ManagedInstance({
    id: input.id,
    creationOperationId: input.creationOperationId,
    hostEpoch: input.hostEpoch,
    cwd: input.cwd,
    name: input.name,
    session: runtime,
    initialRuntimeGeneration: input.initialRuntimeGeneration,
    createdAt: input.createdAt,
    reopenedFrom: input.reopenedFrom,
  });
}, undefined, {
  hostEpoch,
  catalogStore: new FileCatalogStore(catalogPath),
  reopenTargetResolver: { resolve: async () => ({ cwd }) },
});
const host = new DockHost({
  socketPath,
  statePath: catalogPath,
  registry,
  initialize: () => registry.initializeCatalog(),
});
await host.start();
process.stdout.write(`${JSON.stringify({ kind: "ready", pid: process.pid, hostEpoch })}\n`);

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  try {
    await host.stop();
    process.stdout.write(`${JSON.stringify({ kind: "stopped", signal })}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
};
process.once("SIGTERM", () => { void stop("SIGTERM"); });
process.once("SIGINT", () => { void stop("SIGINT"); });
