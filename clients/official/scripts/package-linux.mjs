#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReleaseVersion } from "./release-version.mjs";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(join(clientRoot, "package.json"), "utf8"),
);
const version = resolveReleaseVersion({
  cwd: clientRoot,
  explicitVersion: process.env.ALUDOCK_RELEASE_VERSION,
  fallbackVersion: packageJson.version,
});

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Linux 打包入口当前用于 x86_64 Linux。请在对应平台运行。");
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: clientRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} 被信号 ${result.signal} 中止`);
  if (result.status !== 0) {
    throw new Error(`${command} 退出状态为 ${result.status ?? "未知"}`);
  }
}

const packageManager = process.env.npm_execpath;
const tauriArguments = [
  "exec",
  "tauri",
  "build",
  "--no-bundle",
  "--ci",
  "--config",
  JSON.stringify({ version }),
];
if (packageManager) {
  run(process.execPath, [packageManager, ...tauriArguments]);
} else {
  run("pnpm", tauriArguments);
}

const executable = join(
  clientRoot,
  "src-tauri",
  "target",
  "release",
  "aludock-client-app",
);
if (!existsSync(executable)) {
  throw new Error(`Linux Client 构建完成，但没有找到 ${executable}`);
}

const outputDirectory = join(clientRoot, "dist");
const output = join(outputDirectory, `AluDock-${version}-linux-x86_64.zip`);
const stagingDirectory = mkdtempSync(join(tmpdir(), "aludock-linux-package-"));
try {
  const stagedExecutable = join(stagingDirectory, "AluDock");
  mkdirSync(outputDirectory, { recursive: true });
  copyFileSync(executable, stagedExecutable);
  chmodSync(stagedExecutable, 0o755);
  rmSync(output, { force: true });
  run("zip", ["-9", output, "AluDock"], { cwd: stagingDirectory });
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}

console.log(`Linux Client：${output}`);
