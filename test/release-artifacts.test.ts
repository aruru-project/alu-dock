import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const planner = fileURLToPath(new URL("../../scripts/release-artifacts.mjs", import.meta.url));

test("a formal release builds only the artifacts that contain its changed product files", () => {
  assert.deepEqual(plan(["src/control/dock-host.ts", "test/dock-host.test.ts"]), {
    linux: false,
    windows: true,
    android: false,
    windowsMode: "reuse",
  });
  assert.deepEqual(plan(["clients/official/src/App.vue"]), {
    linux: true,
    windows: true,
    android: true,
    windowsMode: "full",
  });
  assert.deepEqual(plan(["clients/official/scripts/package-windows.mjs"]), {
    linux: false,
    windows: true,
    android: false,
    windowsMode: "full",
  });
  assert.deepEqual(plan(["clients/official/src-tauri/gen/android/app/build.gradle.kts"]), {
    linux: false,
    windows: false,
    android: true,
    windowsMode: "none",
  });
  assert.deepEqual(plan(["new-release-input.txt"]), {
    linux: true,
    windows: true,
    android: true,
    windowsMode: "full",
  });
});

function plan(paths: string[]): unknown {
  const result = spawnSync(process.execPath, [planner], {
    encoding: "utf8",
    input: `${paths.join("\n")}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as unknown;
}
