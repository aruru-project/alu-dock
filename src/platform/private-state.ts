import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_SYSTEM_SID = "S-1-5-18";
let windowsUserSid: Promise<string> | undefined;

export function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
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
