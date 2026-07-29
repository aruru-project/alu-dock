import { writeFileSync } from "node:fs";
import { join } from "node:path";

const init = JSON.parse(process.env.ALU_DOCK_WORKER_INIT ?? "null") as { agentDir?: unknown } | null;
if (!init || typeof init.agentDir !== "string") throw new Error("Worker environment probe requires agentDir");
writeFileSync(join(init.agentDir, "worker-environment.json"), JSON.stringify({
  cwd: process.cwd(),
  nodeEnv: process.env.NODE_ENV ?? null,
  hostOnly: process.env.ALU_DOCK_HOST_ONLY ?? null,
  workspaceValue: process.env.WORKSPACE_VALUE ?? null,
  workerMarker: process.env.ALU_DOCK_PI_WORKER ?? null,
  hasIdentity: typeof process.env.ALU_DOCK_WORKER_IDENTITY === "string",
  hasInit: typeof process.env.ALU_DOCK_WORKER_INIT === "string",
}));
