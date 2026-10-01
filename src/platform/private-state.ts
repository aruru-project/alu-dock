import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
let windowsUserSid: Promise<string> | undefined;

export function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

/**
 * Atomically replace `path` with `temporary`. On Windows a reader that briefly holds the
 * destination open makes the replace fail, so contention is retried a few times.
 */
export async function replaceStateFile(temporary: string, path: string, beforeAttempt?: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await beforeAttempt?.();
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const contention = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (process.platform !== "win32" || !contention || attempt >= WINDOWS_REPLACE_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, WINDOWS_REPLACE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function syncPrivateDirectory(path: string, beforeSync?: () => void | Promise<void>): Promise<void> {
  if (process.platform === "win32") {
    await beforeSync?.();
    return;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await beforeSync?.();
    await handle.sync();
  } finally { await handle.close(); }
}

/** Apply a private Windows DACL; POSIX callers retain their existing chmod policy. */
export async function hardenWindowsPrivatePath(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const sid = await currentWindowsUserSid();
  const inheritance = directory ? "(OI)(CI)" : "";
  try {
    await execFileAsync("icacls.exe", [
      path,
      "/inheritance:r",
      "/grant:r", `*${sid}:${inheritance}F`,
      "/grant:r", `*${WINDOWS_SYSTEM_SID}:${inheritance}F`,
    ], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    throw new Error(`Alu Dock could not protect its state at ${path}. Move the state under your Windows user profile and try again.`);
  }
}

async function currentWindowsUserSid(): Promise<string> {
  windowsUserSid ??= execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  }).then(({ stdout }) => {
    const match = stdout.match(/S-1-\d+(?:-\d+)+/u);
    if (!match) throw new Error("Windows could not identify the current user for Dock state protection");
    return match[0];
  });
  return windowsUserSid;
}
