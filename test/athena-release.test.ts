import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ATHENA_GENERATED_MARKER,
  assertAthenaHostReplacementAllowed,
  assertAthenaJournalClean,
  athenaHostAbsenceIsConfirmed,
  athenaReleaseLayout,
  isAthenaGeneratedContent,
  parseAthenaPendingRelease,
  parseAthenaSystemdUnitEvidence,
  planAthenaLegacyLauncherCleanup,
  planAthenaRollback,
  releaseId,
  renderAthenaLauncher,
  renderAthenaUnit,
  renderReleasedHostInspectionScript,
} from "../src/deployment/athena-release.js";

test("package exposes aludock as the operator CLI", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { bin?: unknown };
  assert.deepEqual(manifest.bin, { aludock: "dist/src/cli.js" });
});

test("every Athena publish path verifies service stop before changing release files", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "deploy-athena.ts"), "utf8");
  const direct = source.slice(source.indexOf("async function deployNow"), source.indexOf("async function stageRelease"));
  const staged = source.slice(source.indexOf("async function applyStagedRelease"), source.indexOf("async function rollbackStagedApply"));
  for (const [name, section] of [["direct", direct], ["staged", staged]] as const) {
    const stop = section.indexOf('restoreUnitActivity("leave_stopped")');
    const install = section.indexOf("await installGeneratedFiles(layout)");
    const switchRelease = section.indexOf("await switchCurrent(layout, finalRelease)");
    assert.ok(stop >= 0 && stop < install && install < switchRelease, `${name} publish order`);
  }
});

test("Athena release layout keeps immutable releases behind one stable launcher", () => {
  const layout = athenaReleaseLayout("/home/tester", "/srv/releases/alu-dock");
  assert.deepEqual(layout, {
    root: "/srv/releases/alu-dock",
    releases: "/srv/releases/alu-dock/releases",
    receipts: "/srv/releases/alu-dock/receipts",
    current: "/srv/releases/alu-dock/current",
    pending: "/srv/releases/alu-dock/pending.json",
    launcher: "/srv/releases/alu-dock/bin/aludock",
    userLauncher: "/home/tester/.local/bin/aludock",
    legacyLauncher: "/srv/releases/alu-dock/bin/alu-dock",
    legacyUserLauncher: "/home/tester/.local/bin/alu-dock",
    unitFile: "/home/tester/.config/systemd/user/alu-dock.service",
  });
  assert.equal(releaseId(new Date("2026-07-15T05:06:07.000Z"), "a".repeat(40)), "20260715T050607Z-aaaaaaaaaaaa");
  assert.throws(() => releaseId(new Date("invalid"), "a".repeat(40)), /timestamp/);
  assert.throws(() => releaseId(new Date(), "not-a-sha"), /Git SHA/);
});

test("Athena replacement admission, rollback state, journal, and legacy cleanup gates are fail-closed", () => {
  assert.deepEqual(planAthenaLegacyLauncherCleanup("generated", "legacy_target"), { removeLauncher: true, removeUserLauncher: true });
  assert.deepEqual(planAthenaLegacyLauncherCleanup("unowned", "legacy_target"), { removeLauncher: false, removeUserLauncher: false });
  assert.deepEqual(planAthenaLegacyLauncherCleanup("absent", "legacy_target"), { removeLauncher: false, removeUserLauncher: true });
  assert.deepEqual(planAthenaLegacyLauncherCleanup("generated", "other"), { removeLauncher: true, removeUserLauncher: false });
  assert.deepEqual(parseAthenaSystemdUnitEvidence("MainPID=42\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"), {
    active: true,
    enabled: true,
    mainPid: 42,
  });
  assert.deepEqual(parseAthenaSystemdUnitEvidence("MainPID=0\nLoadState=not-found\nActiveState=inactive\nUnitFileState=\n"), {
    active: false,
    enabled: false,
    mainPid: 0,
  });
  assert.throws(() => parseAthenaSystemdUnitEvidence(""), /incomplete Athena unit evidence/u);
  assert.throws(() => parseAthenaSystemdUnitEvidence("MainPID=0\nLoadState=loaded\nActiveState=activating\nUnitFileState=enabled\n"), /transitioning/u);
  assert.equal(athenaHostAbsenceIsConfirmed(false, 0, false), true);
  assert.equal(athenaHostAbsenceIsConfirmed(true, 0, false), false);
  assert.equal(athenaHostAbsenceIsConfirmed(false, 42, false), false);
  assert.equal(athenaHostAbsenceIsConfirmed(false, 0, true), false);
  assert.throws(() => athenaHostAbsenceIsConfirmed(false, -1, false), /MainPID evidence is invalid/u);
  assert.doesNotThrow(() => assertAthenaHostReplacementAllowed(0, false));
  assert.doesNotThrow(() => assertAthenaHostReplacementAllowed(2, true));
  assert.throws(() => assertAthenaHostReplacementAllowed(2, false), /2 active instance/u);
  assert.throws(() => assertAthenaHostReplacementAllowed(-1, false), /count is invalid/u);
  assert.deepEqual(planAthenaRollback(true, true, true), { current: "switch_previous", service: "start", enablement: "enable" });
  assert.deepEqual(planAthenaRollback(false, false, true), { current: "switch_previous", service: "leave_stopped", enablement: "disable" });
  assert.deepEqual(planAthenaRollback(true, false, false), { current: "remove_current", service: "start", enablement: "disable" });
  assert.deepEqual(planAthenaRollback(false, true, false), { current: "remove_current", service: "leave_stopped", enablement: "enable" });
  assert.doesNotThrow(() => assertAthenaJournalClean("\n"));
  assert.throws(() => assertAthenaJournalClean("host crashed while starting\n"), /journal gate/u);
});

test("pending Athena releases use a closed stage/apply receipt", () => {
  const pending = parseAthenaPendingRelease({
    schemaVersion: 1,
    releaseId: "20260719T120000Z-aaaaaaaaaaaa",
    commit: "a".repeat(40),
    stagedAt: "2026-07-19T12:00:00.000Z",
    projectCwd: "/srv/alu-dock",
    previousRelease: "/srv/releases/alu-dock/releases/previous",
  });
  assert.equal(pending.releaseId, "20260719T120000Z-aaaaaaaaaaaa");
  assert.throws(() => parseAthenaPendingRelease({ ...pending, extra: true }), /unknown fields/);
  assert.throws(() => parseAthenaPendingRelease({ ...pending, releaseId: "latest" }), /ID is invalid/);
});

test("generated launcher pins Node and marks interactive startup as managed", () => {
  const launcher = renderAthenaLauncher("/opt/node's/bin/node", "/srv/alu dock/current/dist/src/cli.js");
  assert.match(launcher, new RegExp(ATHENA_GENERATED_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.equal(isAthenaGeneratedContent(launcher), true);
  assert.equal(isAthenaGeneratedContent("# Generated by Alu Dock dogfood deploy; do not edit in place.\n[Unit]\n"), true,
    "Athena upgrades must recognize the previously generated unit marker");
  assert.equal(isAthenaGeneratedContent("# hand-written\n"), false);
  assert.match(launcher, /export ALU_DOCK_MANAGED=1/);
  assert.match(launcher, /exec '\/opt\/node'"'"'s\/bin\/node' '\/srv\/alu dock\/current\/dist\/src\/cli\.js' "\$@"/);
  assert.throws(() => renderAthenaLauncher("node", "/absolute/cli.js"), /safe absolute/);
});

test("deployment inspects an existing Host with that immutable release's own client contract", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-release-client-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const clientModule = join(directory, "dock-client.mjs");
  await writeFile(clientModule, `
    export class DockClient {
      constructor(options) { if (options.socketPath !== "/old.sock") throw new Error("socket"); }
      async ping() { return { pid: 42, hostEpoch: "old-epoch" }; }
      async list() { return [{ lifecycle: "active" }, { lifecycle: "stopping" }, { lifecycle: "stopped" }]; }
    }
  `);
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    renderReleasedHostInspectionScript(),
    clientModule,
    "/old.sock",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { pid: 42, hostEpoch: "old-epoch", activeInstances: 2 });
});

test("generated user unit owns private runtime paths and journal lifecycle", () => {
  const unit = renderAthenaUnit({ nodePath: "/opt/node/bin/node", cliPath: "/srv/alu dock/current/dist/src/cli.js", homePath: "/home/tester" });
  for (const expected of [
    ATHENA_GENERATED_MARKER,
    "Type=exec",
    'ExecStart="/opt/node/bin/node" "/srv/alu dock/current/dist/src/cli.js" serve --managed',
    "Restart=on-failure",
    "RestartSec=2s",
    "TimeoutStartSec=15s",
    "TimeoutStopSec=15s",
    "KillMode=mixed",
    "Environment=ALU_DOCK_SOCKET=",
    'Environment="PATH=/opt/node/bin:/home/tester/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    "RuntimeDirectory=alu-dock",
    "RuntimeDirectoryMode=0700",
    "StateDirectory=alu-dock",
    "StateDirectoryMode=0700",
    "WorkingDirectory=%h",
    "UMask=0077",
    "StandardOutput=journal",
  ]) assert.match(unit, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(unit, /NoNewPrivileges|PrivateTmp|host\.log/);
  assert.match(renderAthenaUnit({ nodePath: "/opt/node%pin/bin/node", cliPath: "/srv/alu%dock/cli.js", homePath: "/home/tester" }), /node%%pin.*alu%%dock/u);
  assert.throws(
    () => renderAthenaUnit({ nodePath: "/opt/node:evil/bin/node", cliPath: "/srv/alu/cli.js", homePath: "/home/tester" }),
    /cannot contain colons/u,
  );
});
