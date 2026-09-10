#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const IGNORED_RELEASE_PREFIXES = ["test/", "clients/official/tests/"];
const ROOT_RUNTIME_PREFIXES = ["src/", "docs/", "skills/"];
const ROOT_RUNTIME_FILES = new Set([
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "scripts/clean-dist.mjs",
]);
const WINDOWS_REUSE_FILES = new Set([
  "clients/official/scripts/windows-package.ps1",
]);
const WINDOWS_BUILD_FILES = new Set([
  "clients/official/scripts/package-windows.mjs",
  "clients/official/src-tauri/src/desktop_shell.rs",
  "clients/official/src-tauri/src/windows_launch.rs",
  "clients/official/src-tauri/src/main.rs",
  "clients/official/scripts/windows-installer.nsi",
]);
const ANDROID_PREFIXES = [
  "clients/official/src-tauri/gen/android/",
  "clients/official/src-tauri/src/android_",
];
const LINUX_FILES = new Set(["clients/official/scripts/package-linux.mjs"]);
const SHARED_CLIENT_PREFIXES = [
  "clients/official/src/",
  "clients/official/crates/",
];
const SHARED_CLIENT_FILES = new Set([
  "clients/official/package.json",
  "clients/official/pnpm-lock.yaml",
  "clients/official/Cargo.toml",
  "clients/official/Cargo.lock",
  "clients/official/vite.config.ts",
  "clients/official/src-tauri/Cargo.toml",
  "clients/official/src-tauri/Cargo.lock",
  "clients/official/src-tauri/tauri.conf.json",
  "clients/official/src-tauri/src/lib.rs",
]);

export function classifyReleaseArtifacts(paths, firstRelease = false) {
  const plan = { linux: false, windows: false, android: false, windowsMode: "none" };
  if (firstRelease || paths.length === 0) return selectAll(plan);

  for (const rawPath of paths) {
    const path = rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (!path || IGNORED_RELEASE_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    if (ROOT_RUNTIME_FILES.has(path) || ROOT_RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      selectWindows(plan, "reuse");
    } else if (WINDOWS_REUSE_FILES.has(path)) {
      selectWindows(plan, "reuse");
    } else if (WINDOWS_BUILD_FILES.has(path)) {
      selectWindows(plan, "full");
    } else if (LINUX_FILES.has(path)) {
      plan.linux = true;
    } else if (ANDROID_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      plan.android = true;
    } else if (SHARED_CLIENT_FILES.has(path) || SHARED_CLIENT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      selectAll(plan);
    } else {
      // Unknown release inputs fail closed so a new dependency cannot silently
      // omit an artifact that consumes it.
      selectAll(plan);
    }
  }
  return plan;
}

function selectWindows(plan, mode) {
  plan.windows = true;
  if (mode === "full" || plan.windowsMode === "none") plan.windowsMode = mode;
  return plan;
}

function selectAll(plan) {
  plan.linux = true;
  plan.android = true;
  return selectWindows(plan, "full");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const firstRelease = args.has("--first-release");
  const chunks = [];
  if (!firstRelease) {
    for await (const chunk of process.stdin) chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8");
  const paths = input.split(args.has("--null") ? "\0" : /\r?\n/u).filter(Boolean);
  const plan = classifyReleaseArtifacts(paths, firstRelease);
  if (args.has("--github-output")) {
    process.stdout.write(`linux=${plan.linux}\nwindows=${plan.windows}\nandroid=${plan.android}\nwindows_mode=${plan.windowsMode}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
