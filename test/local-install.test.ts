import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ALU_DOCK_GENERATED_MARKER,
  assertLocalInstallAllowed,
  isAluDockGeneratedContent,
  localInstallBlockingInstances,
  localInstallInspectionMayAssumeHostAbsent,
  localInstallLayout,
  parseLocalInstallArguments,
  renderAluDockUnit,
} from "../src/deployment/local-install.js";

test("package exposes the installed Alu Dock runtime and its operator/client documentation", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    bin?: unknown;
    files?: unknown;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(manifest.bin, { aludock: "dist/src/cli.js" });
  assert.deepEqual(manifest.files, ["dist/src", "docs", "README.md"]);
  assert.equal(manifest.scripts?.["install:local"], "npm run build && node dist/scripts/install-local.js");
  assert.doesNotMatch(manifest.scripts?.["install:local"] ?? "", /\btest\b/u);
});

test("npm package excludes tests, fixtures, and development scripts", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Array<{ files?: Array<{ path?: string }> }>;
  const paths = report[0]?.files?.map((file) => file.path).filter((path): path is string => typeof path === "string") ?? [];
  assert.ok(paths.includes("dist/src/cli.js"));
  assert.ok(paths.includes("package.json"));
  assert.ok(paths.every((path) => path === "package.json" || path === "README.md" || path.startsWith("dist/src/") || path.startsWith("docs/")), paths.join("\n"));
  assert.equal(paths.some((path) => path.startsWith("dist/test/") || path.startsWith("dist/scripts/") || path.startsWith("test/")), false);
});

test("local install uses one stable npm prefix and launcher", () => {
  assert.deepEqual(localInstallLayout("/home/tester"), {
    root: "/home/tester/.local/share/alu-dock",
    packageDirectory: "/home/tester/.local/share/alu-dock/node_modules/alu-dock",
    cliPath: "/home/tester/.local/share/alu-dock/node_modules/alu-dock/dist/src/cli.js",
    packageExecutable: "/home/tester/.local/share/alu-dock/node_modules/.bin/aludock",
    userExecutable: "/home/tester/.local/bin/aludock",
    unitFile: "/home/tester/.config/systemd/user/alu-dock.service",
  });
});

test("local install ignores quiescent instances and identifies only active work", () => {
  const instances = [
    { id: "idle", lifecycle: "active", execution: "idle" },
    { id: "settled-failure", lifecycle: "active", execution: "failed" },
    { id: "stopped", lifecycle: "stopped", execution: "unavailable" },
    { id: "running", lifecycle: "active", execution: "running" },
    { id: "interaction", lifecycle: "active", execution: "idle", activeInteraction: { id: "dialog" } },
    { id: "queued", lifecycle: "active", execution: "idle", pending: { total: 1 } },
    { id: "stopping", lifecycle: "stopping", execution: "running" },
  ] as const;
  assert.deepEqual(localInstallBlockingInstances(instances).map((instance) => instance.id), [
    "running", "interaction", "queued", "stopping",
  ]);
  assert.doesNotThrow(() => assertLocalInstallAllowed(instances.slice(0, 3)));
});

test("local install fails closed after reaching the Host during admission", () => {
  assert.equal(localInstallInspectionMayAssumeHostAbsent(false, "connection_error"), true);
  assert.equal(localInstallInspectionMayAssumeHostAbsent(true, "connection_error"), false);
  assert.equal(localInstallInspectionMayAssumeHostAbsent(false, "connection_closed"), false);
  assert.equal(localInstallInspectionMayAssumeHostAbsent(false, "timeout"), false);
});

test("local install explains the explicit active-work replacement override", () => {
  const instances = [
    { id: "active-id", name: "active-name", lifecycle: "active", execution: "running" },
    { id: "stopping-id", lifecycle: "stopping", execution: "running" },
  ] as const;
  assert.throws(
    () => assertLocalInstallAllowed(instances),
    /active-name \(active-id\).*stopping-id.*npm run install:local -- --replace-active.*interrupts active runs/su,
  );
  assert.doesNotThrow(() => assertLocalInstallAllowed(instances, true));
  assert.deepEqual(parseLocalInstallArguments([]), { replaceActive: false });
  assert.deepEqual(parseLocalInstallArguments(["--replace-active"]), { replaceActive: true });
  assert.throws(() => parseLocalInstallArguments(["--allow-active"]), /Unknown local install option.*--replace-active/u);
});

test("generated ownership distinguishes the managed unit from a user unit", () => {
  assert.equal(isAluDockGeneratedContent(`${ALU_DOCK_GENERATED_MARKER}\n[Unit]\n`), true);
  assert.equal(isAluDockGeneratedContent("# hand-written\n[Unit]\n"), false);
});

test("generated user unit runs the fixed installed CLI with private state", () => {
  const unit = renderAluDockUnit({
    nodePath: "/opt/node/bin/node",
    cliPath: "/home/tester/.local/share/alu-dock/node_modules/alu-dock/dist/src/cli.js",
    homePath: "/home/tester",
  });
  for (const expected of [
    ALU_DOCK_GENERATED_MARKER,
    "Type=exec",
    'ExecStart="/opt/node/bin/node" "/home/tester/.local/share/alu-dock/node_modules/alu-dock/dist/src/cli.js" serve --managed',
    "Environment=ALU_DOCK_MANAGED=1",
    "Restart=on-failure",
    "RuntimeDirectory=alu-dock",
    "RuntimeDirectoryMode=0700",
    "StateDirectory=alu-dock",
    "StateDirectoryMode=0700",
    "WorkingDirectory=%h",
    "UMask=0077",
    "StandardOutput=journal",
  ]) assert.match(unit, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(renderAluDockUnit({ nodePath: "/opt/node%pin/bin/node", cliPath: "/srv/alu%dock/cli.js", homePath: "/home/tester" }), /node%%pin.*alu%%dock/u);
  assert.throws(
    () => renderAluDockUnit({ nodePath: "/opt/node:evil/bin/node", cliPath: "/srv/alu/cli.js", homePath: "/home/tester" }),
    /cannot contain colons/u,
  );
});
