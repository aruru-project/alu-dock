import { fileURLToPath } from "node:url";

import type { WorkerLaunch } from "../worker/worker-process.js";
import type { AssistantWorkerInit } from "./assistant-agent.js";

/** Private process bootstrap marker; the entry does nothing when imported elsewhere. */
export const ASSISTANT_WORKER_MARKER = "ALU_DOCK_ASSISTANT_WORKER";

/** How the assistant's Worker process starts, in the workspace's environment. */
export function assistantWorkerLaunch(
  init: AssistantWorkerInit,
  environment: NodeJS.ProcessEnv,
  entry = fileURLToPath(new URL("./assistant-worker-entry.js", import.meta.url)),
): WorkerLaunch {
  return {
    entry,
    cwd: init.cwd,
    init,
    environment: {
      ...environment,
      [ASSISTANT_WORKER_MARKER]: "1",
      // Pi's session and model code read their directory from here when not told otherwise.
      PI_CODING_AGENT_DIR: init.agentDir,
    },
  };
}
