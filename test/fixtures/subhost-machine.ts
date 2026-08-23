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
import { createPiInstance } from "../../src/pi/create-pi-instance.js";
import { DelayedAgentWorkerConnection } from "../support/delayed-agent-worker.js";

const [statePath, workspace, address, portText, joinPath, mode, agentDir, sessionDir, homeDir] = process.argv.slice(2);
if (!statePath || !workspace || !address || !portText || !joinPath) throw new Error("subhost fixture arguments are incomplete");
const realPiDockTools = mode === "real-pi-dock-tools";
if (realPiDockTools && (!agentDir || !sessionDir || !homeDir)) throw new Error("real Pi SubHost fixture arguments are incomplete");
const port = Number(portText);
const machineState = new SubHostMachineState(machineStateRoot(statePath));
await machineState.prepare(await readMachineJoinFile(joinPath), "Fixture SubHost");
const attachmentService = new AttachmentService(new AttachmentStorageState(join(dirname(statePath), "attachments-state"), join(dirname(statePath), "attachments")));
let registry!: DockRegistry;
let host!: DockHost;
const delayedWorkers = new Map<string, DelayedAgentWorkerConnection>();
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
let realWorkerPid: number | undefined;
registry = new DockRegistry(async (input) => realPiDockTools
  ? createPiInstance({
      ...input,
      agentDir: agentDir!,
      sessionDir: sessionDir!,
      workerEnvironment: sanitizedWorkerEnvironment(homeDir!),
      workerTimeouts: { mutationMs: 10_000 },
      onWorkerSpawn: (pid) => { realWorkerPid = pid; },
    })
  : (() => {
      const session = new DelayedAgentWorkerConnection(`worker-${input.id}`);
      delayedWorkers.set(input.id, session);
      return new ManagedInstance({
        id: input.id,
        creationOperationId: input.creationOperationId,
        hostEpoch: input.hostEpoch,
        cwd: input.cwd,
        name: input.name,
        key: input.key,
        session,
      });
    })(), () => nativeIds.shift() ?? `native-extra-${Date.now()}`, {
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
const routedImage = Buffer.alloc(100_000, 0x5a);
const routedImageData = routedImage.toString("base64");
const routedImageSha = createHash("sha256").update(routedImage).digest("hex");
const routedImageRef = "fixture-routed-image";
const sourceWorker = delayedWorkers.get(sourceNativeId);
if (sourceWorker) sourceWorker.conversationImages.set(routedImageRef, {
  contentRef: routedImageRef,
  mimeType: "image/png",
  data: routedImageData,
  sizeBytes: routedImage.byteLength,
  sha256: routedImageSha,
});
const createdByTool = realPiDockTools
  ? undefined
  : await upstream.invokeDockTool(sourceNativeId, { type: "create", operationId: "dock-tool-create", cwd: workspace, name: "Created from remote tool", machine: "Fixture SubHost" });
process.stdout.write(`${JSON.stringify({ kind: "ready", nativeInstanceId: sourceNativeId, createdByTool: createdByTool?.type === "create" ? createdByTool.instance.id : undefined, workerPid: realWorkerPid, digest: createHash("sha256").update("specialized-stream").digest("hex") })}\n`);

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

function sanitizedWorkerEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PI_OFFLINE: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}
