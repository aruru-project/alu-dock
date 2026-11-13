import { randomUUID } from "node:crypto";

import { ExtensionUiBroker } from "../core/extension-ui-broker.js";
import { ManagedInstance } from "../core/managed-instance.js";
import type { AgentHistoryEntry, AgentRequest } from "../core/agent-worker.js";
import type { AssistantHostPort } from "../core/assistant.js";
import type { DockToolsHostPort } from "../core/dock-tools.js";
import type { InstanceAttachmentHostPort } from "../core/instance-attachments.js";
import type { JsonObject } from "../core/json-value.js";
import type { WorkerIncidentRecorder } from "../core/worker-incident.js";
import type { ModelHostPort } from "../model-service/service-process.js";
import { AgentWorkerConnection } from "./agent-worker-connection.js";
import type { WorkerLaunch, WorkerProcessTimeouts } from "./worker-process.js";

/** What the Host gives every Work's Worker, whatever kind of Agent runs in it. */
export interface WorkerInstanceOptions {
  /** A child Work's parent. */
  parentId?: string;
  id?: string;
  creationOperationId?: string;
  hostEpoch?: string;
  key?: string;
  name?: string;
  projectTrusted: boolean;
  /** Adapter-owned creation input, relayed without Host field semantics. */
  workerConfig?: JsonObject;
  eventCapacity?: number;
  initialRuntimeGeneration?: number;
  createdAt?: string;
  reopenedFrom?: "host_lost" | "runtime_error";
  workerTimeouts?: Partial<WorkerProcessTimeouts>;
  /** Test-only deterministic environment seam; production captures the workspace login shell. */
  workerEnvironment?: NodeJS.ProcessEnv;
  onWorkerSpawn?: (pid: number) => void;
  dockToolsHostPort?: DockToolsHostPort;
  attachmentHostPort?: InstanceAttachmentHostPort;
  dockToolsEnabled?: boolean;
  workerIncidentRecorder?: WorkerIncidentRecorder;
  /** Main's model service. Without it the Worker uses this machine's own model configuration. */
  modelHostPort?: ModelHostPort;
  /** Opened as the personal assistant (card #295); needs `assistantHostPort`. */
  assistant?: true;
  /** How this Host reaches the assistant service on Main; only an assistant Work is given it. */
  assistantHostPort?: AssistantHostPort;
}

export interface CreateWorkerInstanceOptions extends WorkerInstanceOptions {
  /** The canonical working directory. */
  cwd: string;
  /** Which kind of Agent runs in the Worker, as clients see it. */
  executor: { kind: string; version: string };
  /** The kind's process, started in the workspace's environment. */
  launch: (workspaceEnvironment: NodeJS.ProcessEnv) => WorkerLaunch;
}

/** Start one Worker of any kind and construct the Host state machine around it. */
export async function createWorkerInstance(options: CreateWorkerInstanceOptions): Promise<ManagedInstance> {
  const instanceId = options.id ?? randomUUID();
  const hostEpoch = options.hostEpoch ?? randomUUID();
  const extensionUiBroker = new ExtensionUiBroker();
  const dockToolsHostPort = options.dockToolsHostPort ?? unavailableDockToolsHostPort;
  const attachmentHostPort = options.attachmentHostPort ?? unavailableAttachmentHostPort;
  const dockToolsEnabled = options.dockToolsEnabled ?? options.dockToolsHostPort !== undefined;
  if (options.assistant && !options.assistantHostPort) throw new Error("This Host cannot reach the assistant, so the Work cannot be opened as her");
  const created = await AgentWorkerConnection.create({
    identity: {
      hostEpoch,
      instanceId,
      runtimeGeneration: options.initialRuntimeGeneration ?? 1,
    },
    cwd: options.cwd,
    launch: options.launch,
    extensionUiBroker,
    dockToolsHostPort,
    attachmentHostPort,
    initialDockToolsEnabled: dockToolsEnabled,
    ...(options.modelHostPort === undefined ? {} : { modelHostPort: options.modelHostPort }),
    ...(options.assistant ? { assistantHostPort: options.assistantHostPort } : {}),
    ...(options.name === undefined ? {} : { workName: options.name }),
    ...(options.workerIncidentRecorder === undefined ? {} : { workerIncidentRecorder: options.workerIncidentRecorder }),
    ...(options.workerTimeouts === undefined ? {} : { workerTimeouts: options.workerTimeouts }),
    ...(options.workerEnvironment === undefined ? {} : { workerEnvironment: options.workerEnvironment }),
    ...(options.onWorkerSpawn === undefined ? {} : { onWorkerSpawn: options.onWorkerSpawn }),
  });
  const runtime = created.session;
  try {
    const modelState = runtime.state().modelState;
    const historyRequest = {
      kind: "request", version: 2, requestId: randomUUID(), type: "session.history",
      params: { instanceId, limit: 200 },
    } as AgentRequest;
    const initialHistory = await runtime.invoke(historyRequest) as AgentHistoryEntry[];
    const initialName = options.reopenedFrom ? created.persistedName : options.name ?? created.persistedName;
    const instance = new ManagedInstance({
      id: instanceId,
      creationOperationId: options.creationOperationId,
      parentId: options.parentId,
      projectTrusted: options.projectTrusted,
      hostEpoch,
      key: options.key,
      name: initialName,
      cwd: options.cwd,
      session: runtime,
      executor: {
        kind: options.executor.kind,
        version: options.executor.version,
        model: modelState.model,
        thinkingLevel: modelState.thinkingLevel,
      },
      eventCapacity: options.eventCapacity,
      initialRuntimeGeneration: options.initialRuntimeGeneration,
      createdAt: options.createdAt,
      reopenedFrom: options.reopenedFrom,
      extensionUiBroker,
      initialHistory,
      dockToolsEnabled,
      ...(options.workerConfig === undefined ? {} : { workerConfig: options.workerConfig }),
      ...(options.assistant ? { assistant: true as const } : {}),
    });
    await runtime.control({ type: "activate" });
    instance.synchronizeModelState();
    for (const diagnostic of created.diagnostics) instance.recordExtensionError(diagnostic);
    if (created.modelFallbackMessage) instance.recordExtensionError(created.modelFallbackMessage);
    return instance;
  } catch (error) {
    await runtime.dispose().catch(() => {});
    throw error;
  }
}

const unavailableAttachmentHostPort: InstanceAttachmentHostPort = {
  accessAttachments: async (_sourceInstanceId, request) => {
    if (request.type === "list") return { type: "list", attachments: [], total: 0, truncated: false };
    throw new Error("Dock attachments require a managed Registry instance");
  },
};

const unavailableDockToolsHostPort: DockToolsHostPort = {
  dockToolsEnabled: () => false,
  configureDockTools: async () => { throw new Error("Dock tools require a managed Registry instance"); },
  invokeDockTool: async () => { throw new Error("Dock tools require a managed Registry instance"); },
  attachObservationSink: () => () => {},
};
