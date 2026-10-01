import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ModelCatalogReader } from "../control/model-visibility.js";
import { parseModelCatalogBody } from "../control/protocol.js";
import { piWorkerRuntimeEnvironment } from "./pi-runtime-environment.js";
import { definedEnvironment, terminateDetachedProcessTree } from "./worker-process.js";
import { captureWorkspaceShellEnvironment } from "./workspace-shell-environment.js";

const CATALOG_TIMEOUT_MS = 30_000;
const TERMINATE_MS = 2_000;

export interface PiModelCatalogOptions {
  /** The Pi configuration directory Workers on this Host use; defaults to Pi's own. */
  agentDir?: string;
  homeDir?: string;
  /** Deterministic process-boundary tests supply the environment a Worker would receive. */
  environment?: () => Promise<NodeJS.ProcessEnv>;
  entry?: string;
  timeoutMs?: number;
}

/**
 * Lists the models a new Work on this computer could select. Pi loads in a short-lived
 * process with the same login-shell environment as a Worker, so provider sign-ins kept in
 * shell variables and extension-provided models match what a Work's picker shows.
 */
export function createPiModelCatalogReader(options: PiModelCatalogOptions): ModelCatalogReader {
  const homeDir = options.homeDir ?? homedir();
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const entry = options.entry ?? fileURLToPath(new URL("./pi-model-catalog-entry.js", import.meta.url));
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  return {
    async read() {
      const environment = await (options.environment ?? (() => captureWorkspaceShellEnvironment(homeDir)))();
      const child = spawn(process.execPath, [entry], {
        cwd: homeDir,
        detached: true,
        windowsHide: true,
        env: {
          ...definedEnvironment(piWorkerRuntimeEnvironment(environment)),
          PI_CODING_AGENT_DIR: agentDir,
        },
        // Pi and extension diagnostics go to the Host log, like a Worker's.
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "json",
      });
      try {
        const message = await new Promise<unknown>((resolveMessage, rejectMessage) => {
          const timer = setTimeout(() => rejectMessage(new Error(`Pi did not list its models within ${timeoutMs}ms`)), timeoutMs);
          child.once("message", (value) => { clearTimeout(timer); resolveMessage(value); });
          child.once("error", (error) => { clearTimeout(timer); rejectMessage(error); });
          // "close" follows the IPC channel, so an answer sent before exit has already arrived.
          child.once("close", (code, signal) => { clearTimeout(timer); rejectMessage(new Error(`Pi model listing ended without an answer (${signal ?? `exit ${code ?? "unknown"}`})`)); });
        });
        const record = message !== null && typeof message === "object" ? message as { ok?: unknown; body?: unknown; message?: unknown } : {};
        if (record.ok === true) return parseModelCatalogBody(record.body);
        throw new Error(typeof record.message === "string" ? `Pi could not list its models: ${record.message}` : "Pi model listing answered in an unknown shape");
      } finally {
        await terminateDetachedProcessTree(child, TERMINATE_MS).catch(() => {});
      }
    },
  };
}
