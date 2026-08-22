import { resolve } from "node:path";

const WINDOWS_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";
const SAFE_PIPE_NAME = /^[A-Za-z0-9._-]+$/u;

export function defaultLocalEndpoint(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === "win32" ? `${WINDOWS_NAMED_PIPE_PREFIX}alu-dock` : undefined;
}

export function normalizeLocalEndpoint(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return resolve(value);
  if (!value.startsWith(WINDOWS_NAMED_PIPE_PREFIX)) {
    throw new Error("Windows local endpoint must be a \\\\.\\pipe\\... Named Pipe");
  }
  const name = value.slice(WINDOWS_NAMED_PIPE_PREFIX.length);
  if (!SAFE_PIPE_NAME.test(name)) throw new Error("Windows Named Pipe name is invalid");
  return `${WINDOWS_NAMED_PIPE_PREFIX}${name}`;
}

export function isWindowsNamedPipeEndpoint(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && value.startsWith(WINDOWS_NAMED_PIPE_PREFIX);
}
