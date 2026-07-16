import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderCliHelp, requestedCliHelp } from "../src/cli-help.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const unavailableSocket = "/tmp/alu-dock-help-must-not-connect.sock";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

test("help routing short-circuits public and nested command arguments", () => {
  assert.deepEqual(requestedCliHelp("help", []), []);
  assert.deepEqual(requestedCliHelp("help", ["open"]), ["open"]);
  assert.deepEqual(requestedCliHelp("open", ["--cwd", "/missing", "--help"]), ["open"]);
  assert.deepEqual(requestedCliHelp("status", ["--help"]), ["status"]);
  assert.deepEqual(requestedCliHelp("service", ["logs", "--lines", "invalid", "--help"]), ["service", "logs"]);
  assert.deepEqual(requestedCliHelp("service", ["help", "restart"]), ["service", "restart"]);
  assert.equal(requestedCliHelp("open", []), undefined);
});

test("top-level help is human-only, bounded, and locally rendered", async () => {
  const [flag, command, short] = await Promise.all([
    runCli(["--help"]),
    runCli(["help"]),
    runCli(["-h"]),
  ]);
  for (const result of [flag, command, short]) assertHelpSuccess(result);
  assert.equal(flag.stdout, command.stdout);
  assert.equal(command.stdout, short.stdout);
  for (const publicCommand of ["open", "new", "attach", "list", "status", "stop", "service", "help"]) {
    assert.match(flag.stdout, new RegExp(`\\b${publicCommand}\\b`, "u"));
  }
  for (const internalSignature of ["alu-dock serve", "alu-dock ping", "alu-dock create", "alu-dock reopen", "alu-dock events", "alu-dock prompt", "--socket"]) {
    assert.doesNotMatch(flag.stdout, new RegExp(escapeRegExp(internalSignature), "u"));
  }
  assert.ok(Math.max(...flag.stdout.trimEnd().split("\n").map((line) => line.length)) <= 80);
});

test("every public human command supports equivalent local help forms", async () => {
  for (const command of ["open", "new", "attach", "list", "status", "stop"]) {
    const [flag, topic] = await Promise.all([
      runCli([command, "--help"]),
      runCli(["help", command]),
    ]);
    assertHelpSuccess(flag);
    assertHelpSuccess(topic);
    assert.equal(flag.stdout, topic.stdout, command);
    assert.match(flag.stdout, new RegExp(`alu-dock ${command}`, "u"));
  }

  const positional = await runCli(["open", "--cwd", "/path/that/does/not/exist", "--name", "ignored", "--help"]);
  assertHelpSuccess(positional);
  assert.match(positional.stdout, /smart project entry/u);

  const missingBusinessArgument = await runCli(["status", "--help"]);
  assertHelpSuccess(missingBusinessArgument);
  assert.match(missingBusinessArgument.stdout, /INSTANCE_ID/u);
});

test("service help is explorable without constructing a service manager", async () => {
  const [serviceFlag, serviceTopic] = await Promise.all([
    runCli(["service", "--help"]),
    runCli(["help", "service"]),
  ]);
  assertHelpSuccess(serviceFlag);
  assertHelpSuccess(serviceTopic);
  assert.equal(serviceFlag.stdout, serviceTopic.stdout);

  for (const action of ["install", "start", "stop", "restart", "status", "logs", "uninstall"]) {
    const [flag, topic] = await Promise.all([
      runCli(["service", action, "--help"]),
      runCli(["help", "service", action]),
    ]);
    assertHelpSuccess(flag);
    assertHelpSuccess(topic);
    assert.equal(flag.stdout, topic.stdout, action);
    assert.match(flag.stdout, new RegExp(`service ${action}`, "u"));
  }

  const ignoredInvalidOption = await runCli(["service", "logs", "--lines", "not-a-number", "--help"]);
  assertHelpSuccess(ignoredInvalidOption);
  assert.match(ignoredInvalidOption.stdout, /--lines N/u);
});

test("explicit internal help redirects to typed control without polluting the overview", async () => {
  const [flag, topic] = await Promise.all([
    runCli(["create", "--help"]),
    runCli(["help", "create"]),
  ]);
  assertHelpSuccess(flag);
  assertHelpSuccess(topic);
  assert.equal(flag.stdout, topic.stdout);
  assert.match(flag.stdout, /internal control command/u);
  assert.match(flag.stdout, /DockClient\/Protocol V2/u);
  assert.match(flag.stdout, /alu-dock new/u);
});

test("help text is terminal-safe static guidance", () => {
  for (const topics of [
    [], ["open"], ["new"], ["attach"], ["list"], ["status"], ["stop"], ["help"],
    ["service"], ["service", "install"], ["service", "start"], ["service", "stop"],
    ["service", "restart"], ["service", "status"], ["service", "logs"], ["service", "uninstall"],
    ["create"],
  ]) {
    const output = renderCliHelp(topics);
    assert.equal(output.endsWith("\n"), true);
    assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    assert.ok(Math.max(...output.trimEnd().split("\n").map((line) => line.length)) <= 80);
  }
});

async function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ALU_DOCK_SOCKET: unavailableSocket },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`CLI help timed out: ${args.join(" ")}`));
    }, 3_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveRun({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function assertHelpSuccess(result: CliResult): void {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.length > 0);
  assert.doesNotMatch(result.stdout, /^\s*\{/u);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
