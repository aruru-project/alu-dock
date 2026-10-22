#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { materializeDock } from "../src/deployment/materialize-dock.js";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { defaultSocketPath } from "../src/control/socket-path.js";
import {
  assertLocalInstallAllowed,
  assertSupportedNode,
  isAluDockGeneratedContent,
  localInstallInspectionMayAssumeHostAbsent,
  localInstallLayout,
  parseLocalInstallArguments,
} from "../src/deployment/local-install.js";

interface CommandResult { stdout: string; stderr: string }

async function main(): Promise<void> {
  if (process.env.ALU_DOCK_MANAGED === "1") {
    throw new Error("Leave Work with Ctrl+D, then run `npm run install:local` from the shell.");
  }
  const options = parseLocalInstallArguments(process.argv.slice(2));
  const projectRoot = resolve(process.cwd());
  const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { engines?: { node?: unknown } };
  assertSupportedNode(manifest.engines?.node);
  if (process.platform === "win32") {
    await installWindowsPackage(projectRoot, options.replaceActive);
    return;
  }
  await requireInstallAllowed(options.replaceActive);

  const home = resolve(homedir());
  const layout = localInstallLayout(home, undefined, {
    localAppData: process.env.LOCALAPPDATA,
  });
  const temporary = await mkdtemp(join(tmpdir(), "alu-dock-install-"));
  try {
    process.stdout.write("Preparing Alu Dock from the locked dependencies…\n");
    const stagedPackage = join(temporary, "dock");
    materializeDock(projectRoot, stagedPackage, runNpm);

    await requireInstallAllowed(options.replaceActive);
    process.stdout.write(`Installing to ${layout.root}…\n`);
    await mkdir(layout.root, { recursive: true, mode: 0o700 });
    await rm(layout.packageDirectory, { recursive: true, force: true });
    await copyStagedPackage(stagedPackage, layout.packageDirectory);
    await installUserExecutable(layout.userExecutable, layout.packageExecutable, home, layout.root);
    // Remove the former outer npm consumer, not user data beside the application.
    for (const name of ["node_modules", "package.json", "package-lock.json"]) {
      await rm(join(layout.root, name), { recursive: true, force: true });
    }

    await requireInstallAllowed(options.replaceActive);
    process.stdout.write("Starting the updated Alu Dock Host…\n");
    const service = run(process.execPath, [layout.cliPath, "service", "install", "--now", "--json"], projectRoot);
    parseServiceStatus(service.stdout);
    process.stdout.write("Alu Dock is installed and ready. Run `aludock` to open the Hub.\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function installWindowsPackage(projectRoot: string, replaceActive: boolean): Promise<void> {
  if (replaceActive) {
    throw new Error("Windows installation waits for active Work to finish. Stop or finish that work, then run `npm run install:local` again.");
  }
  const temporary = await mkdtemp(join(tmpdir(), "alu-dock-windows-install-"));
  try {
    const archive = join(temporary, "AluDock-windows-x86_64-Setup.exe");
    process.stdout.write("Building the Windows package…\n");
    runNpmInteractive(["run", "package:windows"], projectRoot, { ALUDOCK_WINDOWS_OUTPUT: archive });

    process.stdout.write("Installing the Windows package…\n");
    runInteractive(archive, [], projectRoot);
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

export async function installUserExecutable(userExecutable: string, packageExecutable: string, home: string, installRoot: string): Promise<void> {
  await mkdir(dirname(userExecutable), { recursive: true, mode: 0o755 });
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

function runNpmInteractive(args: string[], cwd: string, additions: NodeJS.ProcessEnv = {}): void {
  const npmCli = process.env.npm_execpath;
  const environment = { ...process.env, ...additions };
  if (npmCli && isAbsolute(npmCli)) runInteractive(process.execPath, [npmCli, ...args], cwd, environment);
  else runInteractive("npm", args, cwd, environment);
}

function runInteractive(executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} did not finish successfully (${result.status ?? 1}).`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

/** Keep npm's relative executable links valid after the staging tree is removed. */
export async function copyStagedPackage(stagedPackage: string, packageDirectory: string): Promise<void> {
  await cp(stagedPackage, packageDirectory, { recursive: true, verbatimSymlinks: true });
}
