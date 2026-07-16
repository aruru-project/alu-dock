import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DOGFOOD_GENERATED_MARKER,
  dogfoodReleaseLayout,
  releaseId,
  renderDogfoodLauncher,
  renderDogfoodUnit,
  renderReleasedHostInspectionScript,
} from "../src/deployment/dogfood-release.js";

test("dogfood release layout keeps immutable releases behind one stable launcher", () => {
  const layout = dogfoodReleaseLayout("/home/tester", "/srv/releases/alu-dock");
  assert.deepEqual(layout, {
    root: "/srv/releases/alu-dock",
    releases: "/srv/releases/alu-dock/releases",
    receipts: "/srv/releases/alu-dock/receipts",
    current: "/srv/releases/alu-dock/current",
    launcher: "/srv/releases/alu-dock/bin/alu-dock",
    userLauncher: "/home/tester/.local/bin/alu-dock",
    unitFile: "/home/tester/.config/systemd/user/alu-dock.service",
  });
  assert.equal(releaseId(new Date("2026-07-15T05:06:07.000Z"), "a".repeat(40)), "20260715T050607Z-aaaaaaaaaaaa");
  assert.throws(() => releaseId(new Date("invalid"), "a".repeat(40)), /timestamp/);
  assert.throws(() => releaseId(new Date(), "not-a-sha"), /Git SHA/);
});

test("generated launcher pins Node and marks interactive startup as managed", () => {
  const launcher = renderDogfoodLauncher("/opt/node's/bin/node", "/srv/alu dock/current/dist/src/cli.js");
  assert.match(launcher, new RegExp(DOGFOOD_GENERATED_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(launcher, /export ALU_DOCK_MANAGED=1/);
  assert.match(launcher, /exec '\/opt\/node'"'"'s\/bin\/node' '\/srv\/alu dock\/current\/dist\/src\/cli\.js' "\$@"/);
  assert.throws(() => renderDogfoodLauncher("node", "/absolute/cli.js"), /safe absolute/);
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
  const unit = renderDogfoodUnit({ nodePath: "/opt/node/bin/node", cliPath: "/srv/alu dock/current/dist/src/cli.js", homePath: "/home/tester" });
  for (const expected of [
    DOGFOOD_GENERATED_MARKER,
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
  assert.match(renderDogfoodUnit({ nodePath: "/opt/node%pin/bin/node", cliPath: "/srv/alu%dock/cli.js", homePath: "/home/tester" }), /node%%pin.*alu%%dock/u);
  assert.throws(
    () => renderDogfoodUnit({ nodePath: "/opt/node:evil/bin/node", cliPath: "/srv/alu/cli.js", homePath: "/home/tester" }),
    /cannot contain colons/u,
  );
});
