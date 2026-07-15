import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ALU_DOCK_SOCKET) return resolve(env.ALU_DOCK_SOCKET);
  if (env.ALU_DOCK_MANAGED === "1" && env.RUNTIME_DIRECTORY) return join(singleSystemdDirectory(env.RUNTIME_DIRECTORY, "RUNTIME_DIRECTORY") as string, "dock.sock");
  if (env.XDG_RUNTIME_DIR) return join(resolve(env.XDG_RUNTIME_DIR), "alu-dock", "dock.sock");
  return join(homedir(), ".alu-dock", "run", "dock.sock");
}

export function managedSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ALU_DOCK_SOCKET) throw new Error("Managed Host rejects ALU_DOCK_SOCKET overrides");
  const runtimeDirectory = singleSystemdDirectory(env.RUNTIME_DIRECTORY, "RUNTIME_DIRECTORY");
  if (!runtimeDirectory) throw new Error("Managed Host requires systemd RUNTIME_DIRECTORY");
  return join(runtimeDirectory, "dock.sock");
}

function singleSystemdDirectory(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  if (value.includes(":")) throw new Error(`${name} must contain exactly one path`);
  if (!isAbsolute(value) || /[\u0000\r\n]/u.test(value)) throw new Error(`${name} must be a safe absolute path`);
  return resolve(value);
}
