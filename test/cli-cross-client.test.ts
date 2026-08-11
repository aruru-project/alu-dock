import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";

interface ChildMessage {
  type?: string;
  [key: string]: unknown;
}

const compiledTestDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(compiledTestDirectory, "fixtures", "delayed-host.js");
const cliPath = join(compiledTestDirectory, "..", "src", "cli.js");

test("independent CLI processes reconnect to one delayed host-owned instance", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aludock-cli-"));
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

    const emptyList = await runCliText(socketPath, ["list"]);
    assert.match(emptyList, /No actionable Alu Dock instances/u);
    assert.match(emptyList, /aludock new/u);

    // Client A creates the instance and exits immediately after the response.
    const createdOutput = await runCli(socketPath, ["create", "--cwd", directory, "--name", "cross-client"]);
    const created = objectValue(createdOutput.instance);
    const instanceId = stringValue(created.id);
    assert.equal(instanceId, "fixture-instance-1");
    assert.equal(created.execution, "running");

    // Machine assertions use the typed port; the public list remains a human projection.
    const instances = await new DockClient({ socketPath }).list();
    assert.equal(instances.length, 1);
    assert.equal(instances[0]?.id, instanceId);
    const humanList = await runCliText(socketPath, ["list"]);
    assert.match(humanList, new RegExp(instanceId.slice(0, 8), "u"));
    assert.match(humanList, /cross-client/u);
    assert.match(humanList, /active\/running/u);
    assert.match(humanList, /g1/u);
    assert.match(humanList, /no model/u);
    assert.match(humanList, new RegExp(escapeRegExp(directory), "u"));
    assert.doesNotMatch(humanList, /creationOperationId|eventCursor|sessionFile|metrics/u);

    // Each command below is a fresh process, proving no client process owns it.
    const statusOutput = await runCliText(socketPath, ["status", "cross-client"]);
    assert.match(statusOutput, /cross-client/u);
    assert.match(statusOutput, /active\/running/u);
    assert.doesNotMatch(statusOutput, /^\s*\{/u);
    assert.equal((await new DockClient({ socketPath }).status(instanceId)).executor.piSessionId, `fixture-pi-${instanceId}`);

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

    const settledStatus = await runCliText(socketPath, ["status", instanceId.slice(0, 8)]);
    assert.match(settledStatus, /active\/idle/u);
    assert.equal((await new DockClient({ socketPath }).status(instanceId)).lastRun, "succeeded");
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

    const firstStop = await runCliText(socketPath, ["stop", "cross-client"]);
    assert.match(firstStop, /^Stopped /u);
    await assert.rejects(
      new DockClient({ socketPath }).status(instanceId),
      (error: unknown) => error instanceof ControlClientError && error.code === "not_found",
    );
    assert.match(await runCliFailure(socketPath, ["stop", instanceId]), /No Dock instance matches/u);

    const actionableAfterStop = await runCliText(socketPath, ["list"]);
    assert.match(actionableAfterStop, /No actionable Alu Dock instances/u);
    assert.doesNotMatch(actionableAfterStop, /stopped hidden/u);
    assert.doesNotMatch(actionableAfterStop, new RegExp(instanceId.slice(0, 8), "u"));
    const fullAfterStop = await runCliText(socketPath, ["list", "--all"]);
    assert.match(fullAfterStop, /No Alu Dock instances/u);
    assert.doesNotMatch(fullAfterStop, new RegExp(instanceId.slice(0, 8), "u"));
    assert.match(await runCliFailure(socketPath, ["list", "--stopped"]), /list accepts only --all/u);

    await runCli(socketPath, ["create", "--cwd", directory, "--name", "duplicate"]);
    await runCli(socketPath, ["create", "--cwd", directory, "--name", "duplicate"]);
    const ambiguousName = await runCliFailure(socketPath, ["status", "duplicate"]);
    assert.match(ambiguousName, /^Alu Dock: TARGET .* is ambiguous/u);
    assert.doesNotMatch(ambiguousName, /^\s*\{/u);
    const ambiguousPrefix = await runCliFailure(socketPath, ["status", "fixture-instance-"]);
    assert.match(ambiguousPrefix, /longer ID prefix or the full ID/u);

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

async function runCliText(socketPath: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [cliPath, "--socket", socketPath, ...args],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(`CLI failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
        else resolveRun({ stdout, stderr });
      },
    );
  });
  assert.equal(stderr, "");
  return stdout;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
