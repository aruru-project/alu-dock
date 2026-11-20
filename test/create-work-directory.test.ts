import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createPiProjectTrustCoordinator } from "../src/pi/create-pi-instance.js";
import { createIsolatedPiInstance } from "./fixtures/isolated-pi-instance.js";

test("create and open a Work in a new directory only when requested", { timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-new-work-dir-"));
  const cwd = join(root, "projects", "new");
  const agentDir = join(root, "pi");
  const registry = new DockRegistry(input => createIsolatedPiInstance({ ...input, agentDir, sessionDir: join(root, "sessions") }), undefined,
    { trustPreflight: createPiProjectTrustCoordinator(agentDir) });
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
  const client = new DockClient({ socketPath: host.socketPath });
  const create = (path: string, flag: boolean) => client.create(path, undefined, undefined, undefined, undefined, undefined, undefined, undefined, flag);
  try {
    await host.start();
    await assert.rejects(client.create(cwd), { code: "request_failed" });
    await assert.rejects(create(cwd, false), { code: "request_failed" });
    await assert.rejects(stat(join(root, "projects")), { code: "ENOENT" });
    const file = join(root, "file");
    await writeFile(file, "keep");
    await assert.rejects(create(file, true), { code: "request_failed" });
    assert.equal(await readFile(file, "utf8"), "keep");
    const work = await create(cwd, true);
    assert.equal((await stat(cwd)).isDirectory(), true);
    assert.equal((await client.read(work.id)).instance.lifecycle, "active");
    const before = (await stat(cwd)).mode;
    assert.equal((await create(cwd, true)).cwd, cwd);
    assert.equal((await stat(cwd)).mode, before);
  } finally {
    client.closeActiveConnections();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
