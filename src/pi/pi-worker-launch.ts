import { fileURLToPath } from "node:url";

import type { JsonObject } from "../core/json-value.js";
import type { WorkerLaunch } from "../worker/worker-process.js";
import { piWorkerRuntimeEnvironment } from "./pi-runtime-environment.js";

export interface PiWorkerInitOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  workerConfig?: JsonObject;
  /** A child Work reports only to its parent. */
  child?: true;
  /** A child's exact tool ceiling, chosen by its parent. */
  allowedTools?: string[];
  projectTrusted: boolean;
  sessionFile?: string;
  initialName?: string;
}

/** How a Pi Worker process starts: Pi's entry and runtime environment around the workspace's environment. */
export function piWorkerLaunch(
  init: PiWorkerInitOptions,
  environment: NodeJS.ProcessEnv,
  entry = fileURLToPath(new URL("./pi-worker-entry.js", import.meta.url)),
): WorkerLaunch {
  return {
    entry,
    cwd: init.cwd,
    init,
    environment: {
      ...piWorkerRuntimeEnvironment(environment),
      ALU_DOCK_PI_WORKER: "1",
      // Keep Pi's own config/session contract coherent even though the login-shell
      // capture intentionally drops Host process overrides.
      PI_CODING_AGENT_DIR: init.agentDir,
    },
  };
}
