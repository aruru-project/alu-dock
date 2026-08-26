import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { captureWorkspaceShellEnvironment } from "./workspace-shell-environment.js";

export interface ResolveManagedPiAgentDirOptions {
  sourceEnvironment?: NodeJS.ProcessEnv;
  homeDir?: string;
  captureEnvironment?: (cwd: string) => Promise<NodeJS.ProcessEnv>;
  fallbackAgentDir?: string;
}

/**
 * Managed services do not start inside the user's login shell. Resolve Pi's
 * one native agent directory from that shell without persisting a Dock copy.
 */
export async function resolveManagedPiAgentDir(
  options: ResolveManagedPiAgentDirOptions = {},
): Promise<string> {
  const sourceEnvironment = options.sourceEnvironment ?? process.env;
  const homeDir = resolve(options.homeDir ?? homedir());
  const direct = sourceEnvironment.PI_CODING_AGENT_DIR;
  if (direct) return resolvePiAgentDirValue(direct, homeDir);

  try {
    const captured = await (options.captureEnvironment ?? captureWorkspaceShellEnvironment)(homeDir);
    if (captured.PI_CODING_AGENT_DIR) return resolvePiAgentDirValue(captured.PI_CODING_AGENT_DIR, homeDir);
  } catch {
    // A shell startup problem must not make the managed Host unavailable;
    // Worker creation will still report its own shell-capture error later.
  }
  return resolve(options.fallbackAgentDir ?? getAgentDir());
}

function resolvePiAgentDirValue(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(join(homeDir, value.slice(2)));
  return resolve(homeDir, value);
}
