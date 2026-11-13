import { cloneWorkerConfig } from "../core/worker-config.js";
import { runAgentWorker } from "../worker/worker-shell.js";
import { createAssistantAgent, type AssistantWorkerInit } from "./assistant-agent.js";
import { ASSISTANT_WORKER_MARKER } from "./assistant-worker-launch.js";

if (process.env[ASSISTANT_WORKER_MARKER] === "1" && typeof process.send === "function") {
  void runAgentWorker({ parseInit, create: createAssistantAgent }).catch((error) => {
    try { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); } catch {}
    process.exit(1);
  });
}

function parseInit(raw: unknown): AssistantWorkerInit {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Worker init is invalid");
  const value = raw as Record<string, unknown>;
  const allowed = new Set(["cwd", "agentDir", "sessionDir", "sessionFile", "initialName", "workerConfig"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Worker init contains unknown field ${key}`);
  const text = (input: unknown, limit: number, label: string): string => {
    if (typeof input !== "string" || input.length < 1 || input.length > limit) throw new Error(`${label} is invalid`);
    return input;
  };
  return {
    cwd: text(value.cwd, 16_384, "Worker cwd"),
    agentDir: text(value.agentDir, 16_384, "Worker agent directory"),
    ...(value.sessionDir === undefined ? {} : { sessionDir: text(value.sessionDir, 16_384, "Worker session directory") }),
    ...(value.sessionFile === undefined ? {} : { sessionFile: text(value.sessionFile, 16_384, "Worker session file") }),
    ...(value.initialName === undefined ? {} : { initialName: text(value.initialName, 256, "Worker initial name") }),
    ...(value.workerConfig === undefined ? {} : { workerConfig: cloneWorkerConfig(value.workerConfig, "Worker configuration") }),
  };
}
