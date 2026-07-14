import { resolve } from "node:path";

import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";

import { ManagedInstance } from "../core/managed-instance.js";
import { ProjectTrustCoordinator } from "../control/project-trust.js";
import { createPiRuntimeHost } from "./pi-runtime-host.js";

export interface CreatePiInstanceOptions {
  id?: string;
  creationOperationId?: string;
  hostEpoch?: string;
  name?: string;
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  eventCapacity?: number;
}

/** Create the single Host-owned Pi runtime facade after project trust has been resolved. */
export async function createPiInstance(options: CreatePiInstanceOptions): Promise<ManagedInstance> {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const runtime = await createPiRuntimeHost({
    cwd,
    agentDir,
    sessionDir: options.sessionDir ? resolve(options.sessionDir) : undefined,
    tools: options.tools,
    excludeTools: options.excludeTools,
    projectTrusted: options.projectTrusted,
  });
  try {
    const modelState = runtime.getModelState();
    const instance = new ManagedInstance({
      id: options.id,
      creationOperationId: options.creationOperationId,
      hostEpoch: options.hostEpoch,
      name: options.name,
      cwd,
      session: runtime,
      executor: {
        kind: "pi-sdk",
        version: VERSION,
        model: modelState.model,
        thinkingLevel: modelState.thinkingLevel,
      },
      eventCapacity: options.eventCapacity,
    });
    runtime.activateInitial();
    instance.synchronizeModelState();
    for (const diagnostic of runtime.diagnostics) {
      const value = diagnostic as { message?: unknown };
      instance.recordExtensionError(typeof value.message === "string" ? value.message : diagnostic);
    }
    if (runtime.modelFallbackMessage) instance.recordExtensionError(runtime.modelFallbackMessage);
    if (options.name) runtime.currentSession().setSessionName(options.name);
    return instance;
  } catch (error) {
    await runtime.dispose().catch(() => {});
    throw error;
  }
}

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
