import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { defaultCatalogPath } from "../src/control/durable-catalog-store.js";
import { managedSocketPath } from "../src/control/socket-path.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function invoke(args: string[], overrides: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  const env = { ...process.env };
  delete env.ALU_DOCK_SOCKET;
  delete env.ALU_DOCK_MANAGED;
  delete env.RUNTIME_DIRECTORY;
  delete env.STATE_DIRECTORY;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [cliPath, ...args], { env, encoding: "utf8", timeout: 10_000 });
}

test("managed and development Host modes fail closed before loading a runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-managed-mode-"));
  const runtime = join(root, "runtime");
  const state = join(root, "state");

  const missingMode = invoke(["serve"]);
  assert.equal(missingMode.status, 1);
  assert.match(String(missingMode.stderr), /serve requires exactly one mode/);

  const managedOverride = invoke(["--socket", join(root, "other.sock"), "serve", "--managed"], {
    ALU_DOCK_MANAGED: "1",
    RUNTIME_DIRECTORY: runtime,
    STATE_DIRECTORY: state,
  });
  assert.equal(managedOverride.status, 1);
  assert.match(String(managedOverride.stderr), /rejects --socket overrides/);

  const missingMarker = invoke(["serve", "--managed"], {
    RUNTIME_DIRECTORY: runtime,
    STATE_DIRECTORY: state,
  });
  assert.equal(missingMarker.status, 1);
  assert.match(String(missingMarker.stderr), /requires ALU_DOCK_MANAGED=1/);

  const implicitDevelopmentSocket = invoke(["serve", "--dev"]);
  assert.equal(implicitDevelopmentSocket.status, 1);
  assert.match(String(implicitDevelopmentSocket.stderr), /Development Host requires an explicit --socket/);
});

test("systemd-owned runtime and state paths are single absolute paths", () => {
  assert.equal(managedSocketPath({ RUNTIME_DIRECTORY: "/run/user/1000/alu-dock" }), "/run/user/1000/alu-dock/dock.sock");
  assert.equal(defaultCatalogPath({ STATE_DIRECTORY: "/home/user/.local/state/alu-dock" }, "/home/user"), "/home/user/.local/state/alu-dock/catalog.json");
  assert.throws(() => managedSocketPath({ RUNTIME_DIRECTORY: "/run/one:/run/two" }), /exactly one path/);
  assert.throws(() => defaultCatalogPath({ STATE_DIRECTORY: "relative" }, "/home/user"), /safe absolute path/);
});
