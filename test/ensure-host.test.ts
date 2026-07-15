import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureHost } from "../src/control/ensure-host.js";

test("managed launcher never falls back to an untracked detached Host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-managed-host-"));
  try {
    const socketPath = join(directory, "dock.sock");
    await assert.rejects(
      ensureHost(socketPath, { managed: true, managedWaitMs: 0 }),
      /systemctl --user status alu-dock\.service/,
    );
    await assert.rejects(stat(socketPath), { code: "ENOENT" });
    await assert.rejects(stat(join(directory, "host.log")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
