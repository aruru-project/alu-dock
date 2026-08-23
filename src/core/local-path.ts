import { posix, win32 } from "node:path";

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_DRIVE_ROOT_PATH = /^[A-Za-z]:[\\/]$/u;

/** Protocol-level absolute path grammar. The receiving Host remains the filesystem authority. */
export function isPortableAbsoluteLocalPath(value: string): boolean {
  return posix.isAbsolute(value) || WINDOWS_DRIVE_ABSOLUTE_PATH.test(value);
}

/** Destination-Host validation. Windows drive paths are supported; UNC/device paths are not. */
export function isNativeAbsoluteLocalPath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? WINDOWS_DRIVE_ABSOLUTE_PATH.test(value) : posix.isAbsolute(value);
}

/** Machine-advertised native filesystem roots. Virtual client locations never use this path shape. */
export function isPortableLocalRootPath(value: string, platform: "linux" | "windows"): boolean {
  return platform === "windows" ? WINDOWS_DRIVE_ROOT_PATH.test(value) : value === "/";
}

/** Resolve a protocol path according to its own dialect, not the caller's operating system. */
export function resolvePortableAbsoluteLocalPath(value: string): string {
  return WINDOWS_DRIVE_ABSOLUTE_PATH.test(value) ? win32.resolve(value) : posix.resolve(value);
}
