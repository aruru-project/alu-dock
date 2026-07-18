#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { defaultSocketPath } from "../src/control/socket-path.js";
import {
  DOGFOOD_GENERATED_MARKER,
  DOGFOOD_UNIT_NAME,
  dogfoodReleaseLayout,
  releaseId,
  parseDogfoodPendingRelease,
  renderDogfoodLauncher,
  renderDogfoodUnit,
  renderReleasedHostInspectionScript,
  type DogfoodPendingRelease,
  type DogfoodReleaseLayout,
} from "../src/deployment/dogfood-release.js";
import { DOCK_VERSION, PI_SDK_VERSION } from "../src/version.js";

interface DeployOptions {
  mode: "deploy" | "stage" | "apply";
  expectedReleaseId?: string;
  releaseRoot: string;
  projectCwd: string;
  replaceUnmanaged: boolean;
  allowActive: boolean;
}

interface HostBeforeDeploy {
  pid: number;
  hostEpoch: string;
  activeInstances: number;
  managed: boolean;
}

interface ReadyHost { pid: number; hostEpoch: string }
interface GeneratedFileSnapshot { path: string; content?: string; mode?: number }
interface CommandOptions { cwd?: string; capture?: boolean; allowFailure?: boolean }
interface CommandResult { status: number; stdout: string; stderr: string }

const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 12_000;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "stage") {
    await stageRelease(options);
    return;
  }
  if (options.mode === "apply") {
    await applyStagedRelease(options);
    return;
  }
  await deployNow(options);
}

async function deployNow(options: DeployOptions): Promise<void> {
  const repository = resolve(process.cwd());
  assertRepository(repository);
  const layout = dogfoodReleaseLayout(homedir(), options.releaseRoot);
  const socketPath = defaultSocketPath();

  const commit = command("git", ["rev-parse", "HEAD"], { cwd: repository, capture: true }).stdout.trim();
  assertCleanRepository(repository);
  const before = await inspectCurrentHost(socketPath, layout);
  if (before?.activeInstances && !options.allowActive) {
    throw new Error(`Deployment refused: current Host has ${before.activeInstances} active instance(s); stop them first or pass --allow-active explicitly`);
  }
  if (before && !before.managed && !options.replaceUnmanaged) {
    throw new Error(`Deployment refused: PID ${before.pid} owns the socket outside ${DOGFOOD_UNIT_NAME}; rerun with --replace-unmanaged after confirming no active work`);
  }

  runReleaseGate(repository);
  assertCleanRepository(repository);

  const id = releaseId(new Date(), commit);
  await prepareLayout(layout);
  const staging = join(layout.root, `.staging-${id}-${process.pid}`);
  const finalRelease = join(layout.releases, id);
  await rm(staging, { recursive: true, force: true });
  if (await pathExists(finalRelease)) throw new Error(`Release already exists: ${finalRelease}`);

  let previousRelease: string | undefined;
  let switched = false;
  let generatedFilesTouched = false;
  let previousGeneratedFiles: GeneratedFileSnapshot[] = [];
  let ready: ReadyHost | undefined;
  try {
    await buildRelease({ repository, staging, id, commit });
    await rename(staging, finalRelease);
    previousRelease = await currentRelease(layout);
    previousGeneratedFiles = await Promise.all([
      captureGeneratedFile(layout.launcher),
      captureGeneratedFile(layout.unitFile),
    ]);
    generatedFilesTouched = true;
    await installGeneratedFiles(layout);
    await switchCurrent(layout, finalRelease);
    switched = true;

    command("systemctl", ["--user", "daemon-reload"]);
    if (before && !before.managed) await stopUnmanagedHost(before.pid, socketPath);
    command("systemctl", ["--user", "enable", DOGFOOD_UNIT_NAME]);
    if (isUnitActive()) command("systemctl", ["--user", "restart", DOGFOOD_UNIT_NAME]);
    else command("systemctl", ["--user", "start", DOGFOOD_UNIT_NAME]);

    ready = await waitForReadyHost(socketPath, before?.hostEpoch);
    const smoke = runReleasedSmoke(finalRelease, socketPath, options.projectCwd, id);
    const receipt = {
      schemaVersion: 1,
      status: "deployed",
      releaseId: id,
      commit,
      deployedAt: new Date().toISOString(),
      releasePath: finalRelease,
      previousRelease,
      nodePath: process.execPath,
      nodeVersion: process.version,
      dockVersion: DOCK_VERSION,
      piSdkVersion: PI_SDK_VERSION,
      unit: DOGFOOD_UNIT_NAME,
      mainPid: ready.pid,
      hostEpoch: ready.hostEpoch,
      previousHostEpoch: before?.hostEpoch,
      gate: { typescript: "pass", tests: "pass", audit: "pass", imports: "pass", cleanTree: "pass" },
      smoke,
    };
    await writeReceipt(layout, `${id}.json`, receipt);
    process.stdout.write(`${JSON.stringify({ kind: "dogfood.deployed", ...receipt })}\n`);
  } catch (error) {
    const message = boundedMessage(error);
    await writeReceipt(layout, `${id}.failed.json`, {
      schemaVersion: 1,
      status: "failed",
      releaseId: id,
      commit,
      failedAt: new Date().toISOString(),
      previousRelease,
      attemptedRelease: finalRelease,
      message,
    }).catch(() => {});
    if (switched || generatedFilesTouched) await rollback(layout, previousRelease, previousGeneratedFiles, switched).catch((rollbackError: unknown) => {
      process.stderr.write(`${JSON.stringify({ kind: "dogfood.rollback_failed", message: boundedMessage(rollbackError) })}\n`);
    });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function stageRelease(options: DeployOptions): Promise<void> {
  const repository = resolve(process.cwd());
  assertRepository(repository);
  const commit = command("git", ["rev-parse", "HEAD"], { cwd: repository, capture: true }).stdout.trim();
  assertCleanRepository(repository);
  runReleaseGate(repository);
  assertCleanRepository(repository);

  const layout = dogfoodReleaseLayout(homedir(), options.releaseRoot);
  const id = releaseId(new Date(), commit);
  await prepareLayout(layout);
  const staging = join(layout.root, `.staging-${id}-${process.pid}`);
  const finalRelease = join(layout.releases, id);
  await rm(staging, { recursive: true, force: true });
  if (await pathExists(finalRelease)) throw new Error(`Release already exists: ${finalRelease}`);

  try {
    await buildRelease({ repository, staging, id, commit });
    await rename(staging, finalRelease);
    const previousRelease = await currentRelease(layout);
    const pending: DogfoodPendingRelease = {
      schemaVersion: 1,
      releaseId: id,
      commit,
      stagedAt: new Date().toISOString(),
      projectCwd: options.projectCwd,
      ...(previousRelease === undefined ? {} : { previousRelease }),
    };
    await writeReceipt(layout, `${id}.staged.json`, { ...pending, status: "staged", releasePath: finalRelease });
    await writeFileAtomically(layout.pending, `${JSON.stringify(pending, null, 2)}\n`, 0o600);
    const applyArgv = [process.execPath, join(finalRelease, "dist", "scripts", "deploy-dogfood.js"), "--apply", id, "--release-root", options.releaseRoot];
    process.stdout.write(`${JSON.stringify({
      kind: "dogfood.staged",
      ...pending,
      releasePath: finalRelease,
      applyArgv,
      applyCommand: applyArgv.map(shellCommandQuote).join(" "),
    })}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function applyStagedRelease(options: DeployOptions): Promise<void> {
  const layout = dogfoodReleaseLayout(homedir(), options.releaseRoot);
  const pending = parseDogfoodPendingRelease(JSON.parse(await readFile(layout.pending, "utf8")));
  if (options.expectedReleaseId !== undefined && options.expectedReleaseId !== pending.releaseId) {
    throw new Error(`Pending release is ${pending.releaseId}, not ${options.expectedReleaseId}`);
  }
  const finalRelease = join(layout.releases, pending.releaseId);
  const metadata = JSON.parse(await readFile(join(finalRelease, "RELEASE.json"), "utf8")) as Record<string, unknown>;
  if (metadata.releaseId !== pending.releaseId || metadata.commit !== pending.commit) throw new Error("Pending release metadata does not match its staged receipt");

  const previousRelease = await currentRelease(layout);
  if (previousRelease !== pending.previousRelease) throw new Error("Pending release is stale because current changed after it was staged");

  const socketPath = defaultSocketPath();
  const before = await inspectCurrentHost(socketPath, layout);
  const mainPid = unitMainPid();
  if (mainPid > 0 && await hasProcessAncestor(mainPid)) {
    throw new Error("Update apply cannot run inside the managed Host; finish the turn, press Ctrl+D, then run the staged apply command from your shell");
  }
  if (before && !before.managed && !options.replaceUnmanaged) {
    throw new Error(`Update apply refused: PID ${before.pid} owns the socket outside ${DOGFOOD_UNIT_NAME}; use --replace-unmanaged only after confirming interruption is intended`);
  }

  const serviceWasActive = isUnitActive();
  const generatedFiles = await Promise.all([
    captureGeneratedFile(layout.launcher),
    captureGeneratedFile(layout.unitFile),
  ]);
  let switched = false;
  let generatedFilesTouched = false;
  let ready: ReadyHost | undefined;
  try {
    if (before && !before.managed) await stopUnmanagedHost(before.pid, socketPath);
    else if (serviceWasActive) command("systemctl", ["--user", "stop", DOGFOOD_UNIT_NAME]);

    generatedFilesTouched = true;
    await installGeneratedFiles(layout);
    await switchCurrent(layout, finalRelease);
    switched = true;
    command("systemctl", ["--user", "daemon-reload"]);
    command("systemctl", ["--user", "enable", DOGFOOD_UNIT_NAME]);
    command("systemctl", ["--user", "start", DOGFOOD_UNIT_NAME]);

    ready = await waitForReadyHost(socketPath, before?.hostEpoch);
    const smoke = runReleasedSmoke(finalRelease, socketPath, pending.projectCwd, pending.releaseId);
    const receipt = {
      schemaVersion: 1,
      status: "deployed",
      releaseId: pending.releaseId,
      commit: pending.commit,
      stagedAt: pending.stagedAt,
      deployedAt: new Date().toISOString(),
      releasePath: finalRelease,
      previousRelease,
      nodePath: process.execPath,
      nodeVersion: process.version,
      dockVersion: DOCK_VERSION,
      piSdkVersion: PI_SDK_VERSION,
      unit: DOGFOOD_UNIT_NAME,
      mainPid: ready.pid,
      hostEpoch: ready.hostEpoch,
      previousHostEpoch: before?.hostEpoch,
      gate: { typescript: "pass", tests: "pass", audit: "pass", imports: "pass", cleanTree: "pass" },
      smoke,
    };
    await writeReceipt(layout, `${pending.releaseId}.json`, receipt);
    const pendingCleanup = await rm(layout.pending, { force: true }).then(() => "removed", (cleanupError: unknown) => `failed: ${boundedMessage(cleanupError)}`);
    process.stdout.write(`${JSON.stringify({ kind: "dogfood.deployed", ...receipt, pendingCleanup })}\n`);
  } catch (error) {
    const rollbackAttempted = switched || generatedFilesTouched || serviceWasActive;
    let rollback = "not_needed";
    if (rollbackAttempted) {
      try {
        await rollbackStagedApply(layout, previousRelease, generatedFiles, switched, serviceWasActive);
        rollback = "passed";
      } catch (rollbackError) {
        rollback = `failed: ${boundedMessage(rollbackError)}`;
      }
    }
    await writeReceipt(layout, `${pending.releaseId}.apply-failed-${Date.now()}.json`, {
      schemaVersion: 1,
      status: "failed",
      releaseId: pending.releaseId,
      commit: pending.commit,
      failedAt: new Date().toISOString(),
      message: boundedMessage(error),
      rollback,
    }).catch(() => {});
    throw error;
  }
}

async function rollbackStagedApply(
  layout: DogfoodReleaseLayout,
  previousRelease: string | undefined,
  generatedFiles: GeneratedFileSnapshot[],
  switched: boolean,
  serviceWasActive: boolean,
): Promise<void> {
  command("systemctl", ["--user", "stop", DOGFOOD_UNIT_NAME], { allowFailure: true });
  if (switched && previousRelease) await switchCurrent(layout, previousRelease);
  if (switched && !previousRelease) await rm(layout.current, { force: true });
  await restoreGeneratedFiles(generatedFiles);
  command("systemctl", ["--user", "daemon-reload"]);
  if (serviceWasActive && previousRelease) command("systemctl", ["--user", "start", DOGFOOD_UNIT_NAME]);
}

async function hasProcessAncestor(targetPid: number): Promise<boolean> {
  let candidate = process.pid;
  const visited = new Set<number>();
  while (candidate > 1 && !visited.has(candidate)) {
    if (candidate === targetPid) return true;
    visited.add(candidate);
    let stat: string;
    try { stat = await readFile(`/proc/${candidate}/stat`, "utf8"); }
    catch { return false; }
    const close = stat.lastIndexOf(")");
    const parent = close < 0 ? 0 : Number(stat.slice(close + 2).split(" ")[1]);
    if (!Number.isSafeInteger(parent) || parent < 1) return false;
    candidate = parent;
  }
  return candidate === targetPid;
}

function runReleaseGate(repository: string): void {
  command("npm", ["run", "check", "--", "--pretty", "false"], { cwd: repository });
  command("npm", ["test"], { cwd: repository });
  command("npm", ["audit", "--audit-level=high"], { cwd: repository });
  command("git", ["diff", "--check"], { cwd: repository });
  assertNoMatches("@earendil-works/pi-coding-agent" + "/", ["src", "test", "scripts"], repository);
  assertNoMatches("Agent" + "Session|createAgent" + "Session", ["src/tui", "src/interactive.ts"], repository);
  command(process.execPath, ["--input-type=module", "-e", "const p=await import('@earendil-works/pi-coding-agent');const t=await import('@earendil-works/pi-tui');for(const n of ['createAgentSessionRuntime','SettingsManager'])if(!(n in p))throw new Error(n);for(const n of ['TUI','Editor'])if(!(n in t))throw new Error(n);"], { cwd: repository });
}

async function buildRelease(input: { repository: string; staging: string; id: string; commit: string }): Promise<void> {
  await mkdir(join(input.staging, "dist"), { recursive: true, mode: 0o755 });
  await Promise.all([
    cp(join(input.repository, "dist", "src"), join(input.staging, "dist", "src"), { recursive: true }),
    cp(join(input.repository, "dist", "scripts"), join(input.staging, "dist", "scripts"), { recursive: true }),
    cp(join(input.repository, "package.json"), join(input.staging, "package.json")),
    cp(join(input.repository, "package-lock.json"), join(input.staging, "package-lock.json")),
  ]);
  command("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: input.staging });
  command(process.execPath, [join(input.staging, "dist", "src", "cli.js"), "help"], { cwd: input.staging, capture: true });
  command(process.execPath, ["--input-type=module", "-e", "await import('@earendil-works/pi-coding-agent');await import('@earendil-works/pi-tui');"], { cwd: input.staging, capture: true });
  await writeFile(join(input.staging, "RELEASE.json"), `${JSON.stringify({
    schemaVersion: 1,
    releaseId: input.id,
    commit: input.commit,
    builtAt: new Date().toISOString(),
    nodePath: process.execPath,
    nodeVersion: process.version,
    dockVersion: DOCK_VERSION,
    piSdkVersion: PI_SDK_VERSION,
  }, null, 2)}\n`, { mode: 0o644, flag: "wx" });
}

async function installGeneratedFiles(layout: DogfoodReleaseLayout): Promise<void> {
  await Promise.all([
    mkdir(dirname(layout.launcher), { recursive: true, mode: 0o755 }),
    mkdir(dirname(layout.userLauncher), { recursive: true, mode: 0o755 }),
    mkdir(dirname(layout.unitFile), { recursive: true, mode: 0o755 }),
  ]);
  const cliPath = join(layout.current, "dist", "src", "cli.js");
  await writeGeneratedFile(layout.launcher, renderDogfoodLauncher(process.execPath, cliPath), 0o755);
  await writeGeneratedFile(layout.unitFile, renderDogfoodUnit({ nodePath: process.execPath, cliPath, homePath: homedir() }), 0o644);
  await ensureLauncherSymlink(layout.userLauncher, layout.launcher);
}

async function writeGeneratedFile(path: string, content: string, mode: number): Promise<void> {
  if (await pathExists(path, false)) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to overwrite non-regular generated file: ${path}`);
    const existing = await readFile(path, "utf8").catch(() => "");
    if (!isGeneratedFileContent(existing)) throw new Error(`Refusing to overwrite non-generated file: ${path}`);
  }
  await writeFileAtomically(path, content, mode);
}

async function captureGeneratedFile(path: string): Promise<GeneratedFileSnapshot> {
  if (!await pathExists(path, false)) return { path };
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to snapshot non-regular generated file: ${path}`);
  const content = await readFile(path, "utf8");
  if (!isGeneratedFileContent(content)) throw new Error(`Refusing to snapshot non-generated file: ${path}`);
  return { path, content, mode: info.mode & 0o777 };
}

function isGeneratedFileContent(content: string): boolean {
  return content.startsWith(`${DOGFOOD_GENERATED_MARKER}\n`)
    || content.startsWith(`#!/bin/sh\n${DOGFOOD_GENERATED_MARKER}\n`);
}

async function restoreGeneratedFiles(snapshots: GeneratedFileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.content === undefined) await rm(snapshot.path, { force: true });
    else await writeFileAtomically(snapshot.path, snapshot.content, snapshot.mode ?? 0o600);
  }
}

async function writeFileAtomically(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function ensureLauncherSymlink(path: string, target: string): Promise<void> {
  if (await pathExists(path, false)) {
    const info = await lstat(path);
    if (!info.isSymbolicLink() || resolve(dirname(path), await readlink(path)) !== resolve(target)) throw new Error(`Refusing to replace existing launcher: ${path}`);
    return;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(target, temporary);
  await rename(temporary, path);
}

async function prepareLayout(layout: DogfoodReleaseLayout): Promise<void> {
  await Promise.all([
    mkdir(layout.releases, { recursive: true, mode: 0o755 }),
    mkdir(layout.receipts, { recursive: true, mode: 0o700 }),
  ]);
}

async function currentRelease(layout: DogfoodReleaseLayout): Promise<string | undefined> {
  if (!await pathExists(layout.current, false)) return undefined;
  const info = await lstat(layout.current);
  if (!info.isSymbolicLink()) throw new Error(`Current release pointer is not a symlink: ${layout.current}`);
  const target = resolve(dirname(layout.current), await readlink(layout.current));
  const releasePrefix = `${resolve(layout.releases)}${sep}`;
  if (!target.startsWith(releasePrefix)) throw new Error(`Current release points outside releases directory: ${target}`);
  return target;
}

async function switchCurrent(layout: DogfoodReleaseLayout, target: string): Promise<void> {
  const temporary = `${layout.current}.tmp-${process.pid}-${randomUUID()}`;
  await symlink(relative(dirname(layout.current), target), temporary);
  await rename(temporary, layout.current);
}

async function inspectCurrentHost(socketPath: string, layout: DogfoodReleaseLayout): Promise<HostBeforeDeploy | undefined> {
  const released = await currentRelease(layout);
  if (released) {
    const projection = inspectWithReleasedClient(released, socketPath);
    if (projection) {
      const mainPid = unitMainPid();
      return { ...projection, managed: isUnitActive() && mainPid === projection.pid };
    }
  }

  const client = new DockClient({ socketPath, timeoutMs: 500 });
  try {
    const ping = await client.ping();
    const instances = await client.list();
    const mainPid = unitMainPid();
    return {
      pid: ping.pid,
      hostEpoch: ping.hostEpoch,
      activeInstances: instances.filter((instance) => instance.lifecycle === "active" || instance.lifecycle === "stopping").length,
      managed: isUnitActive() && mainPid === ping.pid,
    };
  } catch (error) {
    if (error instanceof ControlClientError && ["connection_error", "connection_closed", "timeout"].includes(error.code)) return undefined;
    throw error;
  }
}

function inspectWithReleasedClient(release: string, socketPath: string): Omit<HostBeforeDeploy, "managed"> | undefined {
  const clientModule = join(release, "dist", "src", "control", "dock-client.js");
  const result = command(process.execPath, ["--input-type=module", "-e", renderReleasedHostInspectionScript(), clientModule, socketPath], {
    cwd: release,
    capture: true,
    allowFailure: true,
  });
  if (result.status !== 0) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Current release client returned invalid Host inspection JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Current release client returned an invalid Host inspection");
  const value = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 1 || typeof value.hostEpoch !== "string" || !Number.isSafeInteger(value.activeInstances) || (value.activeInstances as number) < 0) {
    throw new Error("Current release client returned an invalid Host inspection");
  }
  return { pid: value.pid as number, hostEpoch: value.hostEpoch, activeInstances: value.activeInstances as number };
}

async function stopUnmanagedHost(pid: number, socketPath: string): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Unmanaged Host PID is unsafe");
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidExists(pid) && !await socketResponds(socketPath)) return;
    await delay(100);
  }
  throw new Error(`Unmanaged Host PID ${pid} did not stop within ${STOP_TIMEOUT_MS}ms`);
}

async function waitForReadyHost(socketPath: string, previousEpoch?: string): Promise<ReadyHost> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "service did not answer";
  while (Date.now() < deadline) {
    try {
      const ping = await new DockClient({ socketPath, timeoutMs: 500 }).ping();
      const mainPid = unitMainPid();
      const capabilities = new Set(ping.capabilities);
      const missing = ["catalog.maintenance.v1", "catalog.v1", "service.managed.v1", "session.reopen", "session.tree.v1"].filter((capability) => !capabilities.has(capability));
      if (mainPid !== ping.pid) lastError = `hello PID ${ping.pid} does not match MainPID ${mainPid}`;
      else if (missing.length > 0) lastError = `Host lacks managed capabilities: ${missing.join(", ")}`;
      else if (previousEpoch !== undefined && ping.hostEpoch === previousEpoch) lastError = "hostEpoch did not change";
      else return { pid: ping.pid, hostEpoch: ping.hostEpoch };
    } catch (error) { lastError = boundedMessage(error); }
    await delay(100);
  }
  const journal = command("journalctl", ["--user", "-u", DOGFOOD_UNIT_NAME, "-n", "80", "--no-pager"], { capture: true, allowFailure: true });
  throw new Error(`Managed Host did not become ready within ${READY_TIMEOUT_MS}ms: ${lastError}; journal: ${(journal.stdout || journal.stderr).slice(-4_000)}`);
}

function runReleasedSmoke(release: string, socketPath: string, cwd: string, id: string): Record<string, unknown> {
  const result = command(process.execPath, [join(release, "dist", "scripts", "dogfood-smoke.js"), "--socket", socketPath, "--cwd", cwd, "--release", id], { cwd: release, capture: true });
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("Released smoke returned no receipt");
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { passed?: unknown }).passed !== true) throw new Error("Released smoke returned an invalid receipt");
  return parsed as Record<string, unknown>;
}

async function rollback(
  layout: DogfoodReleaseLayout,
  previousRelease: string | undefined,
  generatedFiles: GeneratedFileSnapshot[],
  currentWasSwitched: boolean,
): Promise<void> {
  if (currentWasSwitched && previousRelease) await switchCurrent(layout, previousRelease);
  if (currentWasSwitched && !previousRelease) {
    command("systemctl", ["--user", "stop", DOGFOOD_UNIT_NAME], { allowFailure: true });
    await rm(layout.current, { force: true });
  }
  await restoreGeneratedFiles(generatedFiles);
  command("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  if (currentWasSwitched && previousRelease) command("systemctl", ["--user", "restart", DOGFOOD_UNIT_NAME], { allowFailure: true });
}

async function writeReceipt(layout: DogfoodReleaseLayout, name: string, value: unknown): Promise<void> {
  await mkdir(layout.receipts, { recursive: true, mode: 0o700 });
  const destination = join(layout.receipts, name);
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

function assertRepository(repository: string): void {
  const top = command("git", ["rev-parse", "--show-toplevel"], { cwd: repository, capture: true }).stdout.trim();
  if (resolve(top) !== repository) throw new Error("Dogfood deploy must run from the Alu Dock repository root");
  const packageName = command(process.execPath, ["-e", "process.stdout.write(require('./package.json').name)"], { cwd: repository, capture: true }).stdout;
  if (packageName !== "alu-dock") throw new Error("Current repository is not alu-dock");
}

function assertCleanRepository(repository: string): void {
  const status = command("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repository, capture: true }).stdout.trim();
  if (status) throw new Error(`Dogfood deploy requires a clean committed HEAD:\n${status}`);
}

function isUnitActive(): boolean {
  return command("systemctl", ["--user", "is-active", "--quiet", DOGFOOD_UNIT_NAME], { capture: true, allowFailure: true }).status === 0;
}

function unitMainPid(): number {
  const result = command("systemctl", ["--user", "show", DOGFOOD_UNIT_NAME, "--property", "MainPID", "--value"], { capture: true, allowFailure: true });
  const pid = Number(result.stdout.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function assertNoMatches(pattern: string, paths: string[], cwd: string): void {
  const result = command("rg", ["-n", pattern, ...paths], { cwd, capture: true, allowFailure: true });
  if (result.status === 0) throw new Error(`Release import boundary failed:\n${result.stdout.slice(0, 4_000)}`);
  if (result.status !== 1) throw new Error(`rg import boundary check failed (${result.status}): ${result.stderr.slice(-4_000)}`);
}

function command(executable: string, args: string[], options: CommandOptions = {}): CommandResult {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture || options.allowFailure ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (status !== 0 && !options.allowFailure) throw new Error(`${executable} ${args.join(" ")} failed (${status}): ${(stderr || stdout).slice(-4_000)}`);
  return { status, stdout, stderr };
}

function parseArgs(args: string[]): DeployOptions {
  let mode: DeployOptions["mode"] = "deploy";
  let expectedReleaseId: string | undefined;
  let releaseRoot = join(homedir(), "release", "alu-dock");
  let projectCwd = resolve(process.cwd());
  let replaceUnmanaged = false;
  let allowActive = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--stage") mode = "stage";
    else if (value === "--apply") {
      mode = "apply";
      const candidate = args[index + 1];
      if (candidate && !candidate.startsWith("--")) {
        expectedReleaseId = candidate;
        index += 1;
      }
    } else if (value === "--release-root") releaseRoot = requiredValue(args, ++index, value);
    else if (value === "--project-cwd") projectCwd = requiredValue(args, ++index, value);
    else if (value === "--replace-unmanaged") replaceUnmanaged = true;
    else if (value === "--allow-active") allowActive = true;
    else if (value === "--help") {
      process.stdout.write("Usage: deploy-dogfood [--stage | --apply [RELEASE_ID]] [--replace-unmanaged] [--allow-active] [--release-root PATH] [--project-cwd PATH]\n");
      process.exit(0);
    } else throw new Error(`Unknown deploy argument: ${String(value)}`);
  }
  if (mode !== "deploy" && allowActive) throw new Error("--allow-active is only supported by the one-step deploy path");
  releaseRoot = resolve(releaseRoot);
  projectCwd = resolve(projectCwd);
  if (!isAbsolute(releaseRoot) || !isAbsolute(projectCwd)) throw new Error("Deployment paths must be absolute");
  return {
    mode,
    ...(expectedReleaseId === undefined ? {} : { expectedReleaseId }),
    releaseRoot,
    projectCwd,
    replaceUnmanaged,
    allowActive,
  };
}

function shellCommandQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

async function pathExists(path: string, follow = true): Promise<boolean> {
  try { follow ? await readFile(path) : await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; if ((error as NodeJS.ErrnoException).code === "EISDIR") return true; throw error; }
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function socketResponds(socketPath: string): Promise<boolean> {
  try { await new DockClient({ socketPath, timeoutMs: 250 }).ping(); return true; }
  catch { return false; }
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 4_000 ? message : `${message.slice(0, 3_999)}…`;
}

function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ kind: "dogfood.deploy_failed", message: boundedMessage(error) })}\n`);
  process.exitCode = 1;
});
