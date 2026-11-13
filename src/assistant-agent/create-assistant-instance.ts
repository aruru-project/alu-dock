import { resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ManagedInstance } from "../core/managed-instance.js";
import { DOCK_VERSION } from "../version.js";
import { createWorkerInstance, type WorkerInstanceOptions } from "../worker/create-worker-instance.js";
import type { AssistantWorkerInit } from "./assistant-agent.js";
import { ASSISTANT_EXECUTOR_KIND } from "../core/assistant.js";
import { assistantWorkerLaunch } from "./assistant-worker-launch.js";

export interface CreateAssistantInstanceOptions extends Omit<WorkerInstanceOptions, "parentId" | "assistant"> {
  cwd: string;
  agentDir?: string;
  sessionDir?: string;
  /** The conversation to open again. */
  sessionFile?: string;
  /** Test-only process seam; production always uses the default worker entry. */
  workerEntry?: string;
}

/** Construct the Host state machine around the personal assistant's own Worker (card #667). */
export async function createAssistantInstance(options: CreateAssistantInstanceOptions): Promise<ManagedInstance> {
  const { cwd: requestedCwd, agentDir, sessionDir, sessionFile, workerEntry, ...shared } = options;
  const cwd = resolve(requestedCwd);
  const init: AssistantWorkerInit = {
    cwd,
    agentDir: resolve(agentDir ?? getAgentDir()),
    ...(sessionDir === undefined ? {} : { sessionDir: resolve(sessionDir) }),
    ...(sessionFile === undefined ? {} : { sessionFile: resolve(sessionFile) }),
    // Main names its one resident assistant, including a migrated older conversation.
    ...(options.name === undefined ? {} : { initialName: options.name }),
    ...(options.workerConfig === undefined ? {} : { workerConfig: options.workerConfig }),
  };
  return createWorkerInstance({
    ...shared,
    assistant: true,
    cwd,
    executor: { kind: ASSISTANT_EXECUTOR_KIND, version: DOCK_VERSION },
    launch: (environment) => assistantWorkerLaunch(init, environment, workerEntry),
  });
}
