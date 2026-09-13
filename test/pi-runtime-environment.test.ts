import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePiCliEntry } from "../src/pi/pi-runtime-environment.js";

test("Pi's declared bundled CLI is used when a release moves its entry point", async (context) => {
  // Pi 0.85.1 moved its declared bin to dist/bundle/cli.js; Dock must not guess the old path.
  const root = await mkdtemp(join(tmpdir(), "alu-pi-cli-layout-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/bundle"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" },
  }));
  const entry = join(root, "dist/bundle/cli.js");
  await writeFile(entry, "// CLI entry fixture\n");
  assert.equal(resolvePiCliEntry(root), await realpath(entry));
});
