import { open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { isNativeAbsoluteLocalPath } from "../core/local-path.js";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;

/** Trust preflight probe: bounded plain JSONL header reading, no Pi construction. */
export async function resolvePiReopenTarget(sessionFile: string): Promise<{ cwd: string }> {
  if (!isNativeAbsoluteLocalPath(sessionFile)) throw new Error("Pi session file is not an absolute path on this Host");
  const path = resolve(sessionFile);
  const before = await validateOwnedSessionPath(path);
  const handle = await open(path, "r");
  let line: string;
  try {
    const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) throw new Error(`Pi session header exceeds ${MAX_SESSION_HEADER_BYTES} bytes: ${path}`);
    line = buffer.subarray(0, newline).toString("utf8");
  } finally { await handle.close(); }
  await assertSessionPathUnchanged(path, before);
  let header: unknown;
  try { header = JSON.parse(line); } catch { throw new Error(`Pi session header is invalid JSON: ${path}`); }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error(`Pi session header is invalid: ${path}`);
  const value = header as Record<string, unknown>;
  if (value.type !== "session" || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || value.cwd.length > 16_384) {
    throw new Error(`Pi session header has no bounded absolute working directory: ${path}`);
  }
  return { cwd: await realpath(resolve(value.cwd)) };
}

/** Child-side SessionManager construction, called only after Host trust. */
export async function openValidatedPiSession(
  path: string,
  sessionDir?: string,
  cwdOverride?: string,
): Promise<{ cwd: string; manager: SessionManager }> {
  const before = await validateOwnedSessionPath(path);
  const manager = SessionManager.open(path, sessionDir, cwdOverride);
  await assertSessionPathUnchanged(path, before);
  const cwd = manager.getHeader()?.cwd;
  if (!cwd || !isAbsolute(cwd)) throw new Error(`Pi session header has no absolute working directory: ${path}`);
  return { cwd: await realpath(resolve(cwd)), manager };
}

async function validateOwnedSessionPath(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const canonicalPath = await realpath(path).catch(() => undefined);
  if (canonicalPath === undefined || relative(canonicalPath, path) !== "") throw new Error(`Pi session file is not a real non-symlink path: ${path}`);
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Pi session file is not a regular file: ${path}`);
  const getuid = process.getuid;
  if (typeof getuid === "function" && info.uid !== getuid()) throw new Error(`Pi session file is not owned by the current user: ${path}`);
  if (typeof getuid !== "function" && process.platform !== "win32") throw new Error(`Pi session file ownership cannot be verified: ${path}`);
  return info;
}
async function assertSessionPathUnchanged(path: string, before: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  const after = await lstat(path).catch(() => undefined);
  if (!after?.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid) {
    throw new Error(`Pi session file changed while opening: ${path}`);
  }
}
