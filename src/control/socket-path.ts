import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ALU_DOCK_SOCKET) return resolve(env.ALU_DOCK_SOCKET);
  if (env.XDG_RUNTIME_DIR) return join(resolve(env.XDG_RUNTIME_DIR), "alu-dock", "dock.sock");
  return join(homedir(), ".alu-dock", "run", "dock.sock");
}
