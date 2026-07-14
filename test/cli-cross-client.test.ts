import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface ChildMessage {
  type?: string;
  [key: string]: unknown;
}

const compiledTestDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(compiledTestDirectory, "fixtures", "delayed-host.js");
const cliPath = join(compiledTestDirectory, "..", "src", "cli.js");

test("independent CLI processes reconnect to one delayed host-owned instance", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-cli-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const child = fork(fixturePath, [socketPath, directory], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let fixtureStderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { fixtureStderr += chunk.toString("utf8"); });

  try {
    const ready = await waitForMessage(child, (message) => message.type === "ready");
    assert.equal(ready.socketPath, socketPath);
    assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);

    // Client A creates the instance and exits immediately after the response.
    const createdOutput = await runCli(socketPath, ["create", "--cwd", directory, "--name", "cross-client"]);
    const created = objectValue(createdOutput.instance);
    const instanceId = stringValue(created.id);
    assert.equal(instanceId, "fixture-instance-1");
    assert.equal(created.execution, "running");

    // Each command below is a fresh process, proving no client process owns it.
    const listOutput = await runCli(socketPath, ["list"]);
    const instances = listOutput.instances as unknown[];
    assert.equal(instances.length, 1);
    assert.equal(objectValue(instances[0]).id, instanceId);

    const statusOutput = await runCli(socketPath, ["status", instanceId]);
    assert.equal(objectValue(statusOutput.instance).execution, "running");
    assert.equal(
      objectValue(objectValue(statusOutput.instance).executor).piSessionId,
      `fixture-pi-${instanceId}`,
    );

    const legacyCursorError = await runCliFailure(socketPath, ["events", instanceId, "--since", "1"]);
    assert.match(legacyCursorError, /Unknown events argument: --since/);
    const malformedCursorError = await runCliFailure(socketPath, ["events", instanceId, "--cursor", "1"]);
    assert.match(malformedCursorError, /HOST_EPOCH:RUNTIME_GENERATION:SEQUENCE/);

    const initialEvents = await runCli(socketPath, ["events", instanceId]);
    const initialPage = objectValue(initialEvents.page);
    const latest = objectValue(initialPage.latest);
    const cursor = `${stringValue(latest.hostEpoch)}:${numberValue(latest.runtimeGeneration)}:${numberValue(latest.sequence)}`;
    assert.ok((initialPage.events as unknown[]).some((event) => objectValue(event).type === "command.accepted"));

    const settledMessage = waitForMessage(child, (message) => message.type === "settled");
    child.send({ type: "settle", instanceId });
    await settledMessage;

    const settledStatus = await runCli(socketPath, ["status", instanceId]);
    assert.equal(objectValue(settledStatus.instance).lastRun, "succeeded");
    const replay = await runCli(socketPath, ["events", instanceId, "--cursor", cursor]);
    assert.ok(
      (objectValue(replay.page).events as unknown[])
        .some((event) => objectValue(event).type === "run.settled"),
    );

    const freshPrompt = await runCli(socketPath, ["prompt", instanceId, "start", "again"]);
    assert.equal(objectValue(freshPrompt.receipt).delivery, "prompt");
    assert.equal(objectValue(freshPrompt.receipt).queued, false);
    assert.equal(objectValue(freshPrompt.instance).execution, "running");

    const steer = await runCli(socketPath, [
      "prompt",
      instanceId,
      "--delivery",
      "steer",
      "change direction",
    ]);
    assert.equal(objectValue(steer.receipt).delivery, "steer");
    assert.equal(objectValue(steer.receipt).queued, true);

    const firstStop = await runCli(socketPath, ["stop", instanceId]);
    assert.equal(objectValue(firstStop.receipt).alreadyStopped, false);
    assert.equal(objectValue(firstStop.instance).lastRun, "aborted");
    const secondStop = await runCli(socketPath, ["stop", instanceId]);
    assert.equal(objectValue(secondStop.receipt).alreadyStopped, true);

    const stoppedMessage = waitForMessage(child, (message) => message.type === "stopped");
    const exited = waitForExit(child);
    child.send({ type: "shutdown" });
    await stoppedMessage;
    assert.equal(await exited, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForExit(child);
      child.kill("SIGKILL");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }

  assert.equal(fixtureStderr, "");
});

async function runCli(socketPath: string, args: string[]): Promise<Record<string, unknown>> {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [cliPath, "--socket", socketPath, ...args],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error) {
          rejectRun(new Error(`CLI failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
        } else {
          resolveRun({ stdout, stderr });
        }
      },
    );
  });
  assert.equal(stderr, "");
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `unexpected CLI output: ${stdout}`);
  return objectValue(JSON.parse(lines[0] as string) as unknown);
}

async function runCliFailure(socketPath: string, args: string[]): Promise<string> {
  return new Promise<string>((resolveRun, rejectRun) => {
    execFile(process.execPath, [cliPath, "--socket", socketPath, ...args], { encoding: "utf8", timeout: 5_000 }, (error, _stdout, stderr) => {
      if (!error) rejectRun(new Error("CLI unexpectedly succeeded"));
      else resolveRun(stderr);
    });
  });
}

function waitForMessage(
  child: ChildProcess,
  predicate: (message: ChildMessage) => boolean,
): Promise<ChildMessage> {
  return new Promise<ChildMessage>((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => finish(new Error("timed out waiting for fixture message")), 5_000);
    const onMessage = (message: unknown): void => {
      const value = objectValue(message) as ChildMessage;
      if (value.type === "error") {
        finish(new Error(`fixture error: ${String(value.message)}`));
      } else if (predicate(value)) {
        finish(undefined, value);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`fixture exited before message: code=${String(code)} signal=${String(signal)}`));
    };
    const finish = (error?: Error, message?: ChildMessage): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) rejectMessage(error);
      else resolveMessage(message as ChildMessage);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

function objectValue(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function numberValue(value: unknown): number {
  assert.equal(typeof value, "number");
  return value as number;
}
