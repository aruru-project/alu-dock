import { resolve } from "node:path";

import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { ManagedInstance } from "../core/managed-instance.js";
import type { DockChildStart } from "../core/dock-tools.js";
import { ProjectTrustCoordinator } from "../control/project-trust.js";
import { PI_SDK_VERSION } from "../version.js";
import { createWorkerInstance, type WorkerInstanceOptions } from "../worker/create-worker-instance.js";
import { piWorkerLaunch, type PiWorkerInitOptions } from "./pi-worker-launch.js";

/** A Work opened as the personal assistant runs her own Agent (`src/assistant-agent/`), never Pi. */
export interface CreatePiInstanceOptions extends Omit<WorkerInstanceOptions, "parentId" | "assistant" | "assistantHostPort"> {
  child?: DockChildStart;
  cwd: string;
  agentDir?: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  sessionFile?: string;
  /** Test-only process seam; production always uses the default worker entry. */
  workerEntry?: string;
}

/** Construct the Host state machine around one independent Pi worker after trust. */
export async function createPiInstance(options: CreatePiInstanceOptions): Promise<ManagedInstance> {
  const { child, cwd: requestedCwd, agentDir: requestedAgentDir, sessionDir, tools, excludeTools, sessionFile, workerEntry, ...shared } = options;
  const cwd = resolve(requestedCwd);
  const init: PiWorkerInitOptions = {
    cwd,
    agentDir: resolve(requestedAgentDir ?? getAgentDir()),
    ...(sessionDir === undefined ? {} : { sessionDir: resolve(sessionDir) }),
    ...(tools === undefined ? {} : { tools }),
    ...(excludeTools === undefined ? {} : { excludeTools }),
    ...(options.workerConfig === undefined ? {} : { workerConfig: options.workerConfig }),
    ...(child === undefined ? {} : { child: true }),
    ...(child?.allowedTools === undefined ? {} : { allowedTools: child.allowedTools }),
    projectTrusted: options.projectTrusted,
    ...(sessionFile === undefined ? {} : { sessionFile: resolve(sessionFile) }),
    // A reopened session keeps its own name. A child's session file is a copy of its
    // parent's conversation, which carries the parent's name, so the child names it.
    ...(options.name === undefined || (sessionFile !== undefined && child === undefined) ? {} : { initialName: options.name }),
  };
  return createWorkerInstance({
    ...shared,
    ...(child === undefined ? {} : { parentId: child.parentId }),
    cwd,
    executor: { kind: "pi-sdk", version: PI_SDK_VERSION },
    launch: (environment) => piWorkerLaunch(init, environment, workerEntry),
  });
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
