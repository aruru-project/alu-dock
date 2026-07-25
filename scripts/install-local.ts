#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
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
} from "../src/deployment/local-install.js";

interface CommandResult { stdout: string; stderr: string }

async function main(): Promise<void> {
  if (process.env.ALU_DOCK_MANAGED === "1") {
    throw new Error("Detach first, then run npm run install:local from the outer shell.");
  }

  const options = parseLocalInstallArguments(process.argv.slice(2));
  const projectRoot = resolve(process.cwd());
  await requireCleanCheckout(projectRoot);
  await requireInstallAllowed(options.replaceActive);

  const home = resolve(homedir());
  const layout = localInstallLayout(home);
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
    await installUserExecutable(layout.userExecutable, layout.packageExecutable, home, layout.root);

    await requireInstallAllowed(options.replaceActive);
    process.stdout.write("Restarting alu-dock.service…\n");
    const service = run(process.execPath, [layout.cliPath, "service", "install", "--now"], projectRoot);
    const status = parseServiceStatus(service.stdout);
    const commit = run("git", ["rev-parse", "--short=12", "HEAD"], projectRoot).stdout.trim();
    process.stdout.write(`Ready · PID ${status.mainPid} · commit ${commit}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function requireCleanCheckout(projectRoot: string): Promise<void> {
  const status = run("git", ["status", "--porcelain", "--untracked-files=normal"], projectRoot).stdout.trim();
  if (status.length > 0) throw new Error("Local install requires a clean committed checkout.");
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
        `Local install could not verify that the Dock has no active work: ${error.message}\n`
        + "Retry when the Host is responsive, or explicitly replace it:\n"
        + "  npm run install:local -- --replace-active",
      );
    }
    throw error;
  }
}

async function installUserExecutable(userExecutable: string, packageExecutable: string, home: string, installRoot: string): Promise<void> {
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

function parseServiceStatus(output: string): { mainPid: number } {
  const line = output.trim().split("\n").at(-1);
  if (!line) throw new Error("Service install returned no status");
  const parsed = JSON.parse(line) as { ready?: unknown; mainPid?: unknown };
  if (parsed.ready !== true || !Number.isSafeInteger(parsed.mainPid) || Number(parsed.mainPid) <= 1) {
    throw new Error("Service install did not report a ready managed Host");
  }
  return { mainPid: Number(parsed.mainPid) };
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
