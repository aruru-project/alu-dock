import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { ExtensionUiBroker } from "../core/extension-ui-broker.js";
import { ManagedInstance } from "../core/managed-instance.js";
import type { AgentHistoryEntry, AgentRequest } from "../core/agent-worker.js";
import type { DockToolsHostPort } from "../core/dock-tools.js";
import type { InstanceAttachmentHostPort } from "../core/instance-attachments.js";
import type { WorkerIncidentRecorder } from "../core/worker-incident.js";
import type { JsonObject } from "../core/json-value.js";
import { ProjectTrustCoordinator } from "../control/project-trust.js";
import { PI_SDK_VERSION } from "../version.js";
import { resolvePiReopenTarget } from "./pi-session-target.js";
import { AgentWorkerConnection } from "./agent-worker-connection.js";
import type { WorkerProcessTimeouts } from "./worker-process.js";

export interface CreatePiInstanceOptions {
  /** Owning top-level Work on this Host; native children are temporary. */
  parentId?: string;
  id?: string;
  creationOperationId?: string;
  hostEpoch?: string;
  key?: string;
  name?: string;
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  /** JSON-safe Pi creation options relayed without Host field semantics. */
  workerConfig?: JsonObject;
  eventCapacity?: number;
  sessionFile?: string;
  initialRuntimeGeneration?: number;
  createdAt?: string;
  reopenedFrom?: "host_lost" | "runtime_error";
  /** Test-only process seam; production always uses the default worker entry. */
  workerEntry?: string;
  workerTimeouts?: Partial<WorkerProcessTimeouts>;
  /** Test-only deterministic environment seam; production captures the workspace login shell. */
  workerEnvironment?: NodeJS.ProcessEnv;
  onWorkerSpawn?: (pid: number) => void;
  dockToolsHostPort?: DockToolsHostPort;
  attachmentHostPort?: InstanceAttachmentHostPort;
  dockToolsEnabled?: boolean;
  workerIncidentRecorder?: WorkerIncidentRecorder;
}

/** Construct the Host state machine around one independent Pi worker after trust. */
export async function createPiInstance(options: CreatePiInstanceOptions): Promise<ManagedInstance> {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const instanceId = options.id ?? randomUUID();
  const hostEpoch = options.hostEpoch ?? randomUUID();
  const extensionUiBroker = new ExtensionUiBroker();
  const dockToolsHostPort = options.dockToolsHostPort ?? unavailableDockToolsHostPort;
  const attachmentHostPort = options.attachmentHostPort ?? unavailableAttachmentHostPort;
  const dockToolsEnabled = options.dockToolsEnabled ?? options.dockToolsHostPort !== undefined;
  const created = await AgentWorkerConnection.create({
    identity: {
      hostEpoch,
      instanceId,
      runtimeGeneration: options.initialRuntimeGeneration ?? 1,
    },
    init: {
      cwd,
      agentDir,
      ...(options.sessionDir === undefined ? {} : { sessionDir: resolve(options.sessionDir) }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.excludeTools === undefined ? {} : { excludeTools: options.excludeTools }),
      ...(options.workerConfig === undefined ? {} : { workerConfig: options.workerConfig }),
      projectTrusted: options.projectTrusted,
      ...(options.sessionFile === undefined ? {} : { sessionFile: resolve(options.sessionFile) }),
      ...(options.name === undefined || options.sessionFile !== undefined ? {} : { initialName: options.name }),
    },
    extensionUiBroker,
    dockToolsHostPort,
    attachmentHostPort,
    initialDockToolsEnabled: dockToolsEnabled,
    ...(options.name === undefined ? {} : { workName: options.name }),
    ...(options.workerIncidentRecorder === undefined ? {} : { workerIncidentRecorder: options.workerIncidentRecorder }),
    ...(options.workerEntry === undefined ? {} : { workerEntry: options.workerEntry }),
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
      hostEpoch,
      key: options.key,
      name: initialName,
      cwd,
      session: runtime,
      executor: {
        kind: "pi-sdk",
        version: PI_SDK_VERSION,
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
  authorizeDockToolRequest: () => { throw new Error("Dock tools are not connected to a Host."); },
  dockToolsEnabled: () => false,
  configureDockTools: async () => { throw new Error("Dock tools require a managed Registry instance"); },
  invokeDockTool: async () => { throw new Error("Dock tools require a managed Registry instance"); },
  attachObservationSink: () => () => {},
};

export { resolvePiReopenTarget } from "./pi-session-target.js";

/** Production trust coordinator. Importing this module remains confined to the long-lived server path. */
export function createPiProjectTrustCoordinator(agentDir = resolve(getAgentDir())): ProjectTrustCoordinator {
  const trustStore = new ProjectTrustStore(agentDir);
  return new ProjectTrustCoordinator({
    requiresTrust: (cwd) => hasTrustRequiringProjectResources(cwd),
    savedDecision: (cwd) => trustStore.get(cwd),
    defaultDecision: (cwd) => SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust(),
    remember: (cwd, trusted) => trustStore.set(cwd, trusted),
  });
}
