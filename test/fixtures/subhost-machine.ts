import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AttachmentService } from "../../src/control/attachment-service.js";
import { AttachmentStorageState } from "../../src/control/attachment-storage-state.js";
import { DockHost } from "../../src/control/dock-host.js";
import { DockRegistry } from "../../src/control/dock-registry.js";
import { FileCatalogStore } from "../../src/control/durable-catalog-store.js";
import { machineStateRoot, readMachineJoinFile, SubHostMachineState } from "../../src/control/machine-state.js";
import { SubHostDockToolsPort, SubHostMachineConnection } from "../../src/control/machine-transport.js";
import { ManagedInstance } from "../../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "../support/delayed-agent-worker.js";

const [statePath, workspace, address, portText, joinPath] = process.argv.slice(2);
if (!statePath || !workspace || !address || !portText || !joinPath) throw new Error("subhost fixture arguments are incomplete");
const port = Number(portText);
const machineState = new SubHostMachineState(machineStateRoot(statePath));
await machineState.prepare(await readMachineJoinFile(joinPath), "Fixture SubHost");
const attachmentService = new AttachmentService(new AttachmentStorageState(join(dirname(statePath), "attachments-state"), join(dirname(statePath), "attachments")));
let registry!: DockRegistry;
let host!: DockHost;
const upstream = new SubHostMachineConnection({
  state: machineState,
  address,
  port,
  hostEpoch: "subhost-epoch",
  snapshots: () => registry.list(),
  acceptProtocolSocket: (socket) => host.acceptProtocolSocket(socket),
});
const dockTools = new SubHostDockToolsPort({ upstream, local: () => registry });
const nativeIds = ["native-subhost-instance", "native-tool-created"];
registry = new DockRegistry(async (input) => new ManagedInstance({
  id: input.id,
  creationOperationId: input.creationOperationId,
  hostEpoch: input.hostEpoch,
  cwd: input.cwd,
  name: input.name,
  session: new DelayedAgentWorkerConnection(`worker-${input.id}`),
}), () => nativeIds.shift() ?? `native-extra-${Date.now()}`, {
  hostEpoch: "subhost-epoch",
  catalogStore: new FileCatalogStore(statePath),
  attachmentHostPort: attachmentService,
  dockToolsHostPort: dockTools,
});
await registry.initializeCatalog();
if (registry.list().length === 0) await registry.create({ operationId: "native-create", cwd: workspace, name: "Remote work" });
host = new DockHost({ socketPath: join(statePath, "unused.sock"), statePath, registry, attachmentService, listen: false });
await host.start();
await upstream.start();
for (let attempt = 0; attempt < 200 && !upstream.connected(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
if (!upstream.connected()) throw new Error("fixture SubHost did not connect to Main");
const sourceNativeId = registry.list().find((item) => item.creationOperationId === "native-create")?.id;
if (!sourceNativeId) throw new Error("fixture source instance is missing");
const createdByTool = await upstream.invokeDockTool(sourceNativeId, { type: "create", operationId: "dock-tool-create", cwd: workspace, name: "Created from remote tool" });
process.stdout.write(`${JSON.stringify({ kind: "ready", nativeInstanceId: sourceNativeId, createdByTool: createdByTool.type === "create" ? createdByTool.instance.id : undefined, digest: createHash("sha256").update("specialized-stream").digest("hex") })}\n`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await upstream.stop().catch(() => {});
  await host.stop().catch(() => {});
  await rm(join(statePath, "unused.sock"), { force: true }).catch(() => {});
  process.exit(0);
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
