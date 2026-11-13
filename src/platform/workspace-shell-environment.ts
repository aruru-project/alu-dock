import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import { isNativeAbsoluteLocalPath } from "../core/local-path.js";

const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;
const DEFAULT_EXECUTABLE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_DIAGNOSTIC_CHARS = 4_000;

const USER_SESSION_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "COLORTERM",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "GPG_AGENT_INFO",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "TZ",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export interface WorkspaceShellAccount {
  username: string;
  homedir: string;
  shell: string;
}

export interface CaptureWorkspaceShellEnvironmentOptions {
  /** Explicit seams are used by deterministic process-boundary tests. */
  account?: WorkspaceShellAccount;
  sourceEnvironment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Build only the user/session bootstrap needed to start the login shell.
 * Host runtime state, npm lifecycle state, language selections, and NODE_ENV
 * are deliberately absent; the shell must construct the Worker's environment.
 */
export function workspaceShellBootstrapEnvironment(
  account: WorkspaceShellAccount,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: account.homedir,
    USER: account.username,
    LOGNAME: account.username,
    SHELL: account.shell,
    PATH: DEFAULT_EXECUTABLE_PATH,
    TERM: sourceEnvironment.TERM || "dumb",
  };
  copyDefined(environment, sourceEnvironment, "LANG");
  copyDefined(environment, sourceEnvironment, "LANGUAGE");
  for (const key of USER_SESSION_ENVIRONMENT_KEYS) copyDefined(environment, sourceEnvironment, key);
  for (const key of Object.keys(sourceEnvironment)) {
    if (key.startsWith("LC_")) copyDefined(environment, sourceEnvironment, key);
  }
  return environment;
}

/** Capture the exported environment produced by entering one workspace from the user's interactive login shell. */
export async function captureWorkspaceShellEnvironment(
  cwd: string,
  options: CaptureWorkspaceShellEnvironmentOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const workspace = resolve(cwd);
  if (process.platform === "win32") return windowsWorkspaceEnvironment(workspace, options.sourceEnvironment);
  const account = options.account ?? currentAccount();
  assertAbsoluteSafePath(account.homedir, "User home");
  assertAbsoluteSafePath(account.shell, "User login shell");
  assertAbsoluteSafePath(workspace, "Worker workspace");
  const environment = workspaceShellBootstrapEnvironment(account, options.sourceEnvironment);
  const command = `cd -- ${shellSingleQuote(workspace)} && command env -0 >&3`;
  const timeoutMs = boundedTimeout(options.timeoutMs);

  return new Promise<NodeJS.ProcessEnv>((resolveEnvironment, rejectEnvironment) => {
    const child = spawn(account.shell, ["-l", "-i", "-c", command], {
      cwd: account.homedir,
      detached: true,
      env: environment,
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    const captured: Buffer[] = [];
    let settled = false;
    const captureStream = child.stdio[3] as Readable | null;
    const diagnosticStream = child.stderr;

    captureStream?.on("data", (chunk: Buffer | string) => captured.push(Buffer.from(chunk)));
    diagnosticStream?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateProcessGroup(child.pid);
      rejectEnvironment(new Error(`Workspace shell environment capture exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectEnvironment(new Error(`Unable to start user login shell ${account.shell}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = boundedDiagnostic(stderr);
        const status = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
        rejectEnvironment(new Error(`User login shell could not initialize workspace ${workspace} (${status})${detail ? `: ${detail}` : ""}`));
        return;
      }
      try {
        resolveEnvironment(parseNullDelimitedEnvironment(Buffer.concat(captured), workspace));
      } catch (error) {
        rejectEnvironment(error);
      }
    });
  });
}

function windowsWorkspaceEnvironment(workspace: string, sourceEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  assertAbsoluteSafePath(workspace, "Worker workspace");
  const account = userInfo();
  const environment: NodeJS.ProcessEnv = { ...sourceEnvironment, PWD: workspace };
  environment.HOME ??= account.homedir;
  environment.USER ??= account.username;
  environment.LOGNAME ??= account.username;
  return environment;
}

function currentAccount(): WorkspaceShellAccount {
  const account = userInfo();
  if (!account.shell) throw new Error("Current user account has no login shell");
  return { username: account.username, homedir: account.homedir, shell: account.shell };
}

function parseNullDelimitedEnvironment(buffer: Buffer, workspace: string): NodeJS.ProcessEnv {
  if (buffer.length === 0) throw new Error("User login shell produced no workspace environment");
  const environment: NodeJS.ProcessEnv = {};
  for (const item of buffer.toString("utf8").split("\0")) {
    if (!item) continue;
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("User login shell produced a malformed environment entry");
    const name = item.slice(0, separator);
    if (name.includes("\0") || name.includes("=")) throw new Error("User login shell produced an invalid environment name");
    environment[name] = item.slice(separator + 1);
  }
  if (Object.keys(environment).length === 0) throw new Error("User login shell produced an empty workspace environment");
  environment.PWD = workspace;
  delete environment.OLDPWD;
  delete environment.SHLVL;
  delete environment._;
  return environment;
}

function copyDefined(target: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv, key: string): void {
  const value = source[key];
  if (value !== undefined) target[key] = value;
}

function boundedTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 100 && value <= 60_000
    ? value
    : DEFAULT_CAPTURE_TIMEOUT_MS;
}

function boundedDiagnostic(chunks: Buffer[]): string {
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length <= MAX_DIAGNOSTIC_CHARS ? text : text.slice(-MAX_DIAGNOSTIC_CHARS);
}

function terminateProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); return; } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

function assertAbsoluteSafePath(path: string, label: string): void {
  if (!isNativeAbsoluteLocalPath(path) || /[\0\r\n]/u.test(path)) throw new Error(`${label} must be a safe absolute path`);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
