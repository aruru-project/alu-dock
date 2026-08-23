#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { defaultSocketPath } from "../src/control/socket-path.js";
import {
  assertLocalInstallAllowed,
  isAluDockGeneratedContent,
  localInstallInspectionMayAssumeHostAbsent,
  localInstallLayout,
  parseLocalInstallArguments,
  renderWindowsAluDockLauncher,
} from "../src/deployment/local-install.js";
import { MachineSettingsState, machineSettingsStateRoot } from "../src/control/machine-settings-state.js";
import { defaultCatalogPath } from "../src/control/durable-catalog-store.js";
import { readWindowsHostLifecycleStatus, requestWindowsHostStop } from "../src/deployment/windows-host-lifecycle.js";

interface CommandResult { stdout: string; stderr: string }

async function main(): Promise<void> {
  if (process.env.ALU_DOCK_MANAGED === "1") {
    throw new Error("Leave Work with Ctrl+D, then run `npm run install:local` from the shell.");
  }

  const options = parseLocalInstallArguments(process.argv.slice(2));
  const projectRoot = resolve(process.cwd());
  await requireInstallAllowed(options.replaceActive);

  const home = resolve(homedir());
  const layout = localInstallLayout(home, undefined, {
    localAppData: process.env.LOCALAPPDATA,
    appData: process.env.APPDATA,
  });
  if (process.platform === "win32") await stopWindowsHostForInstall(options.replaceActive);
  const temporary = await mkdtemp(join(tmpdir(), "alu-dock-install-"));
  try {
    process.stdout.write("Packing Alu Dock…\n");
    const packed = runNpm(["pack", "--ignore-scripts", "--silent", "--pack-destination", temporary], projectRoot);
    const tarballName = packed.stdout.trim().split("\n").at(-1);
    if (!tarballName || tarballName.includes("/") || tarballName.includes("\\") || !tarballName.endsWith(".tgz")) {
      throw new Error(`npm pack returned an invalid tarball name: ${String(tarballName)}`);
    }
    const tarball = join(temporary, tarballName);

    process.stdout.write(`Installing to ${layout.root}…\n`);
    await mkdir(layout.root, { recursive: true, mode: 0o700 });
    runNpm([
      "install", "--prefix", layout.root, "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts", "--force", tarball,
    ], projectRoot);
    await installUserExecutable(layout.userExecutable, layout.packageExecutable, home, layout.root, layout.cliPath);

    await requireInstallAllowed(options.replaceActive);
    process.stdout.write("Starting the updated Alu Dock Host…\n");
    const service = run(process.execPath, [layout.cliPath, "service", "install", "--now", "--json"], projectRoot);
    parseServiceStatus(service.stdout);
    process.stdout.write("Alu Dock is installed and ready. Run `aludock` to open the Hub.\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function requireInstallAllowed(replaceActive: boolean): Promise<void> {
  if (replaceActive) return;
  const client = new DockClient({ socketPath: defaultSocketPath(), timeoutMs: 1_000 });
  let hostReached = false;
  try {
    await client.ping();
    hostReached = true;
    assertLocalInstallAllowed(await client.list("all"));
  } catch (error) {
    if (error instanceof ControlClientError && localInstallInspectionMayAssumeHostAbsent(hostReached, error.code)) return;
    if (error instanceof ControlClientError) {
      throw new Error(
        "The update could not check whether work is still active. Wait for Alu Dock to reconnect and try again, or replace it explicitly:\n"
        + "  npm run install:local -- --replace-active",
      );
    }
    throw error;
  }
}

async function installUserExecutable(userExecutable: string, packageExecutable: string, home: string, installRoot: string, cliPath: string): Promise<void> {
  await mkdir(dirname(userExecutable), { recursive: true, mode: 0o755 });
  if (process.platform === "win32") {
    const existing = await lstatIfPresent(userExecutable);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || !isAluDockGeneratedContent(await readFile(userExecutable, "utf8"))) {
        throw new Error(`Refusing to replace user-owned launcher: ${userExecutable}`);
      }
    }
    const temporary = `${userExecutable}.tmp-${process.pid}.cmd`;
    await rm(temporary, { force: true });
    try {
      await writeFile(temporary, renderWindowsAluDockLauncher({ nodePath: process.execPath, cliPath }), { encoding: "utf8", flag: "wx" });
      await rm(userExecutable, { force: true });
      await rename(temporary, userExecutable);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return;
  }
  const existing = await lstatIfPresent(userExecutable);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const target = await readlink(userExecutable);
      const absoluteTarget = resolve(dirname(userExecutable), target);
      const oldReleaseRoot = join(home, "release", "alu-dock");
      if (!isWithin(absoluteTarget, installRoot) && !isWithin(absoluteTarget, oldReleaseRoot)) {
        throw new Error(`Refusing to replace user-owned launcher: ${userExecutable}`);
      }
    } else if (existing.isFile()) {
      const content = await readFile(userExecutable, "utf8");
      if (!isAluDockGeneratedContent(content)) throw new Error(`Refusing to replace user-owned launcher: ${userExecutable}`);
    } else {
      throw new Error(`Refusing to replace non-file launcher: ${userExecutable}`);
    }
  }

  const temporary = `${userExecutable}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  try {
    await symlink(packageExecutable, temporary);
    await rename(temporary, userExecutable);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function stopWindowsHostForInstall(replaceActive: boolean): Promise<void> {
  const lifecycle = await readWindowsHostLifecycleStatus();
  if (lifecycle) {
    if (!replaceActive && lifecycle.blockingWork > 0) {
      throw new Error(
        `Update paused because ${lifecycle.blockingWork} local work item${lifecycle.blockingWork === 1 ? " still needs" : "s still need"} Alu Dock.\n`
        + "Finish or stop that work before updating. To replace Alu Dock anyway, run:\n"
        + "  npm run install:local -- --replace-active\n"
        + "Replacing Alu Dock interrupts current responses, waiting messages, and tool actions in progress.",
      );
    }
    await requestWindowsHostStop();
    await waitForWindowsProcessExit(lifecycle.pid);
    return;
  }

  let pid: number | undefined;
  try {
    pid = (await new DockClient({ socketPath: defaultSocketPath(), timeoutMs: 1_000 }).ping()).pid;
    await requireInstallAllowed(replaceActive);
  }
  catch (error) {
    if (!(error instanceof ControlClientError) || error.code !== "connection_error") throw error;
  }
  if (pid === undefined) {
    const status = await new MachineSettingsState(machineSettingsStateRoot(defaultCatalogPath())).readSubHostStatus();
    pid = status.processId;
    if (pid !== undefined && !replaceActive) {
      throw new Error(
        "The update found an older SubHost but cannot confirm whether its local work is finished. Finish or stop important work, then replace it explicitly:\n"
        + "  npm run install:local -- --replace-active",
      );
    }
  }
  if (pid === undefined) return;
  sendWindowsConsoleCtrlC(pid);
  await waitForWindowsProcessExit(pid);
}

function sendWindowsConsoleCtrlC(pid: number): void {
  const source = [
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class AluDockConsoleControl {",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AttachConsole(uint pid);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool FreeConsole();",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint evt, uint group);",
    "  [DllImport(\"kernel32.dll\")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);",
    "}",
  ].join("\n");
  const encodedSource = Buffer.from(source, "utf8").toString("base64");
  const script = [
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSource}'))`,
    "Add-Type -TypeDefinition $source",
    "[AluDockConsoleControl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null",
    "[AluDockConsoleControl]::FreeConsole() | Out-Null",
    `if (-not [AluDockConsoleControl]::AttachConsole(${pid})) { exit 2 }`,
    "try { if (-not [AluDockConsoleControl]::GenerateConsoleCtrlEvent(0, 0)) { exit 3 }; Start-Sleep -Milliseconds 300 } finally { [AluDockConsoleControl]::FreeConsole() | Out-Null }",
  ].join("\r\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], process.cwd());
}

async function waitForWindowsProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Alu Dock did not stop. Return to the Windows Host window, press Ctrl+C, then run the installer again.");
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function parseServiceStatus(output: string): void {
  const line = output.trim().split("\n").at(-1);
  let parsed: { ready?: unknown; mainPid?: unknown } | undefined;
  try {
    parsed = line ? JSON.parse(line) as { ready?: unknown; mainPid?: unknown } : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || parsed.ready !== true || !Number.isSafeInteger(parsed.mainPid) || Number(parsed.mainPid) <= 1) {
    throw new Error("The update finished, but Alu Dock readiness could not be confirmed. Run `aludock service status`, then check service logs if needed.");
  }
}

function runNpm(args: string[], cwd: string): CommandResult {
  const npmCli = process.env.npm_execpath;
  return npmCli && isAbsolute(npmCli)
    ? run(process.execPath, [npmCli, ...args], cwd)
    : run("npm", args, cwd);
}

function run(executable: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed (${result.status ?? 1}): ${(stderr || stdout).slice(-4_000)}`);
  return { stdout, stderr };
}

function isWithin(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
