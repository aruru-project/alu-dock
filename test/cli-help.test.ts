import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { renderCliHelp } from "../src/cli-help.js";
import { ptyUserEnvironment } from "./support/pty-user-environment.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const unavailableSocket = "/tmp/aludock-help-must-not-connect.sock";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

test("Windows Host bootstrap can load its entry before starting the service", async () => {
  // Preserve the bootstrap import contract while fixing the 2026-09-12 CLI launch regression.
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-cli-import-"));
  try {
    const entry = join(directory, "bootstrap.mjs");
    await writeFile(entry, `const { runWindowsHost } = await import(${JSON.stringify(pathToFileURL(cliPath).href)});
if (typeof runWindowsHost !== "function") throw new Error("Host entry unavailable");
console.log("Host entry loaded");
`);
    const environment = await ptyUserEnvironment(directory, {
      PI_CODING_AGENT_DIR: join(directory, "pi"),
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_RUNTIME_DIR: join(directory, "run"),
    });
    const result = await runCli(["--help"], entry, environment);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Host entry loaded\n");
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  for (const publicCommand of ["continue", "open", "new", "attach", "list", "status", "stop", "forget", "prune", "service", "pi:install", "update", "help"]) {
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
  for (const command of ["continue", "open", "new", "attach", "list", "status", "stop", "forget", "prune", "pi:install", "update"]) {
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

  const updateModel = await runCli(["update", "model", "--help"]);
  assertHelpSuccess(updateModel);
  assert.match(updateModel.stdout, /aludock update model/u);
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
    [], ["open"], ["new"], ["attach"], ["list"], ["status"], ["stop"], ["forget"], ["prune"], ["pi:install"], ["update"], ["update", "model"], ["help"],
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

async function runCli(args: string[], entry = cliPath, environment = process.env): Promise<CliResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: process.cwd(),
      env: { ...environment, ALU_DOCK_SOCKET: unavailableSocket },
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
