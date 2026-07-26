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
import { ProjectTrustCoordinator } from "../control/project-trust.js";
import { PI_SDK_VERSION } from "../version.js";
import { resolvePiReopenTarget } from "./pi-session-target.js";
import { AgentWorkerConnection } from "./agent-worker-connection.js";
import type { WorkerProcessTimeouts } from "./worker-process.js";

export interface CreatePiInstanceOptions {
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
  eventCapacity?: number;
  sessionFile?: string;
  initialRuntimeGeneration?: number;
  createdAt?: string;
  reopenedFrom?: "host_lost" | "runtime_error";
  /** Test-only process seam; production always uses the default worker entry. */
  workerEntry?: string;
  workerTimeouts?: Partial<WorkerProcessTimeouts>;
  onWorkerSpawn?: (pid: number) => void;
}

/** Construct the Host state machine around one independent Pi worker after trust. */
export async function createPiInstance(options: CreatePiInstanceOptions): Promise<ManagedInstance> {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const instanceId = options.id ?? randomUUID();
  const hostEpoch = options.hostEpoch ?? randomUUID();
  const extensionUiBroker = new ExtensionUiBroker();
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
      projectTrusted: options.projectTrusted,
      ...(options.sessionFile === undefined ? {} : { sessionFile: resolve(options.sessionFile) }),
      ...(options.name === undefined || options.sessionFile !== undefined ? {} : { initialName: options.name }),
    },
    extensionUiBroker,
    ...(options.workerEntry === undefined ? {} : { workerEntry: options.workerEntry }),
    ...(options.workerTimeouts === undefined ? {} : { workerTimeouts: options.workerTimeouts }),
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
