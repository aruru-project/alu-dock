import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderCliHelp } from "../src/cli-help.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const unavailableSocket = "/tmp/aludock-help-must-not-connect.sock";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

test("top-level help is human-only, bounded, and locally rendered", async () => {
  const [flag, command, short] = await Promise.all([
    runCli(["--help"]),
    runCli(["help"]),
    runCli(["-h"]),
  ]);
  for (const result of [flag, command, short]) assertHelpSuccess(result);
  assert.equal(flag.stdout, command.stdout);
  assert.equal(command.stdout, short.stdout);
  for (const publicCommand of ["continue", "open", "new", "attach", "list", "status", "stop", "forget", "prune", "service", "pi:install", "help"]) {
    assert.match(flag.stdout, new RegExp(`\\b${publicCommand}\\b`, "u"));
  }
  for (const internalSignature of ["aludock serve", "aludock ping", "aludock create", "aludock reopen", "aludock events", "aludock prompt", "--socket"]) {
    assert.doesNotMatch(flag.stdout, new RegExp(escapeRegExp(internalSignature), "u"));
  }
  assert.match(flag.stdout, /Open the Dock Hub/u);
  assert.match(flag.stdout, /aludock -c/u);
  assert.match(flag.stdout, /attach TARGET/u);
  assert.ok(Math.max(...flag.stdout.trimEnd().split("\n").map((line) => line.length)) <= 80);
});

test("every public human command supports equivalent local help forms", async () => {
  for (const command of ["continue", "open", "new", "attach", "list", "status", "stop", "forget", "prune", "pi:install"]) {
    const [flag, topic] = await Promise.all([
      runCli([command, "--help"]),
      runCli(["help", command]),
    ]);
    assertHelpSuccess(flag);
    assertHelpSuccess(topic);
    assert.equal(flag.stdout, topic.stdout, command);
    assert.match(flag.stdout, new RegExp(`aludock ${command}`, "u"));
  }

  const [continueShort, continueLong] = await Promise.all([
    runCli(["-c", "--help"]),
    runCli(["--continue", "--help"]),
  ]);
  assertHelpSuccess(continueShort);
  assertHelpSuccess(continueLong);
  assert.equal(continueShort.stdout, continueLong.stdout);
  assert.match(continueShort.stdout, /most recently updated/u);

  const positional = await runCli(["open", "--cwd", "/path/that/does/not/exist", "--name", "ignored", "--help"]);
  assertHelpSuccess(positional);
  assert.match(positional.stdout, /smart project entry/u);

  const missingBusinessArgument = await runCli(["status", "--help"]);
  assertHelpSuccess(missingBusinessArgument);
  assert.match(missingBusinessArgument.stdout, /TARGET/u);
});

test("interactive command grammar keeps bare Hub, continue, new, and attach intents distinct", async () => {
  const missingTarget = await runCli(["attach"]);
  assert.equal(missingTarget.code, 1);
  assert.match(missingTarget.stderr, /^Alu Dock: attach requires a work name/u);
  assert.doesNotMatch(missingTarget.stderr, /^\s*\{/u);

  for (const [command, target] of [["open", ""], ["attach", "   "]] as const) {
    const blankTarget = await runCli([command, target]);
    assert.equal(blankTarget.code, 1);
    assert.equal(blankTarget.stdout, "");
    assert.match(blankTarget.stderr, new RegExp(`^Alu Dock: ${command} needs a work name`, "u"));
  }

  const continueTarget = await runCli(["-c", "target"]);
  assert.equal(continueTarget.code, 1);
  assert.match(continueTarget.stderr, /continue does not accept TARGET/u);

  const continueCwd = await runCli(["--continue", "--cwd", "/tmp"]);
  assert.equal(continueCwd.code, 1);
  assert.match(continueCwd.stderr, /continue does not accept --cwd/u);

  const attachNew = await runCli(["attach", "target", "--new"]);
  assert.equal(attachNew.code, 1);
  assert.match(attachNew.stderr, /attach does not accept --new/u);

  const newTarget = await runCli(["new", "target"]);
  assert.equal(newTarget.code, 1);
  assert.match(newTarget.stderr, /new does not accept TARGET/u);
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

  const serviceHelp = renderCliHelp(["service"]);
  assert.match(serviceHelp, /npm run install:local/u);
  assert.match(serviceHelp, /Finish or stop active work before updating/u);

  const ignoredInvalidOption = await runCli(["service", "logs", "--lines", "not-a-number", "--help"]);
  assertHelpSuccess(ignoredInvalidOption);
  assert.match(ignoredInvalidOption.stdout, /--lines N/u);
});

test("explicit non-human command help points to the public workflow", async () => {
  const [flag, topic] = await Promise.all([
    runCli(["create", "--help"]),
    runCli(["help", "create"]),
  ]);
  assertHelpSuccess(flag);
  assertHelpSuccess(topic);
  assert.equal(flag.stdout, topic.stdout);
  assert.match(flag.stdout, /aludock new/u);
});

test("help text is terminal-safe static guidance", () => {
  for (const topics of [
    [], ["open"], ["new"], ["attach"], ["list"], ["status"], ["stop"], ["forget"], ["prune"], ["pi:install"], ["help"],
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
