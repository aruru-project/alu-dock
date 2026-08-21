import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureHost } from "../src/control/ensure-host.js";

test("ordinary clients never fall back to an untracked detached Host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aludock-managed-host-"));
  try {
    const socketPath = join(directory, "dock.sock");
    await assert.rejects(
      ensureHost(socketPath, { managedWaitMs: 0 }),
      /aludock service start/,
    );
    await assert.rejects(stat(socketPath), { code: "ENOENT" });
    await assert.rejects(stat(join(directory, "host.log")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
