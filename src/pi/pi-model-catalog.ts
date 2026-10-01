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

// The whole answer (login shell plus Pi start) stays well inside a client's 30 s
// request limit, including a hop from Main to a SubHost, so a slow machine gets
// the Host's own explanation instead of a generic timeout.
const CATALOG_BUDGET_MS = 20_000;
const SHELL_CAPTURE_LIMIT_MS = 10_000;
const TERMINATE_MS = 2_000;

export interface PiModelCatalogOptions {
  /** The Pi configuration directory Workers on this Host use; defaults to Pi's own. */
  agentDir?: string;
  homeDir?: string;
  /** Deterministic process-boundary tests supply the environment a Worker would receive. */
  environment?: () => Promise<NodeJS.ProcessEnv>;
  entry?: string;
  budgetMs?: number;
}

/**
 * Lists the models a new Work on this computer could select. Pi loads in a short-lived
 * process with the same login-shell environment as a Worker, so provider sign-ins kept in
 * shell variables and extension-provided models match what a Work's picker shows.
 * Concurrent reads share one process.
 */
export function createPiModelCatalogReader(options: PiModelCatalogOptions): ModelCatalogReader {
  const homeDir = options.homeDir ?? homedir();
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const entry = options.entry ?? fileURLToPath(new URL("./pi-model-catalog-entry.js", import.meta.url));
  const budgetMs = options.budgetMs ?? CATALOG_BUDGET_MS;
  let pending: ReturnType<ModelCatalogReader["read"]> | undefined;

  async function readOnce() {
    const deadline = Date.now() + budgetMs;
    const environment = await (options.environment
      ?? (() => captureWorkspaceShellEnvironment(homeDir, { timeoutMs: Math.min(SHELL_CAPTURE_LIMIT_MS, budgetMs) })))();
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
      const remainingMs = Math.max(1, deadline - Date.now());
      const message = await new Promise<unknown>((resolveMessage, rejectMessage) => {
        const timer = setTimeout(() => rejectMessage(new Error(`Pi did not list its models within ${budgetMs}ms`)), remainingMs);
        child.once("message", (value) => { clearTimeout(timer); resolveMessage(value); });
        child.once("error", (error) => { clearTimeout(timer); rejectMessage(error); });
        // "close" follows the IPC channel, so an answer sent before exit has already arrived.
        child.once("close", (code, signal) => { clearTimeout(timer); rejectMessage(new Error(`Pi model listing ended without an answer (${signal ?? `exit ${code ?? "unknown"}`})`)); });
      });
      const record = message !== null && typeof message === "object" ? message as { ok?: unknown; body?: unknown; message?: unknown } : {};
      if (record.ok === true) return parseModelCatalogBody(record.body);
      throw new Error(typeof record.message === "string" ? `Pi could not list its models: ${record.message}` : "Pi model listing answered in an unknown shape");
    } finally {
      // Answer first; the process and anything an extension started are cleaned up afterwards.
      void terminateDetachedProcessTree(child, TERMINATE_MS).catch(() => {});
    }
  }

  return {
    read() {
      pending ??= readOnce().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
