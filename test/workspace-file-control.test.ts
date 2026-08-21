import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry, type InstanceFactoryInput } from "../src/control/dock-registry.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

function fixtureInstance(input: InstanceFactoryInput): ManagedInstance {
  return new ManagedInstance({
    id: input.id,
    creationOperationId: input.creationOperationId,
    hostEpoch: input.hostEpoch,
    cwd: input.cwd,
    session: new DelayedAgentWorkerConnection(`workspace-${input.id}`),
  });
}

test("an active work browses and reads its files while stopped work and paths outside it stay unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-workspace-files-"));
  const cwd = join(root, "work");
  const outside = join(root, "outside");
  const socketPath = join(root, "dock.sock");
  await Promise.all([mkdir(cwd), mkdir(outside)]);
  await Promise.all([
    writeFile(join(cwd, ".hidden.txt"), "hidden", "utf8"),
    writeFile(join(cwd, "back\\slash.txt"), "slash", "utf8"),
    writeFile(join(cwd, "note.txt"), "hello workspace", "utf8"),
    writeFile(join(outside, "secret.txt"), "outside", "utf8"),
    mkdir(join(cwd, "folder")),
  ]);
  await Promise.all([
    symlink(join(cwd, "note.txt"), join(cwd, "note-link")),
    symlink(join(cwd, "folder"), join(cwd, "folder-link")),
    symlink(outside, join(cwd, "outside-link")),
    symlink(join(cwd, "missing"), join(cwd, "broken-link")),
  ]);
  const exactLimit = join(cwd, "exact-limit.bin");
  const overLimit = join(cwd, "over-limit.bin");
  await Promise.all([writeFile(exactLimit, ""), writeFile(overLimit, "")]);
  await Promise.all([truncate(exactLimit, 104_857_600), truncate(overLimit, 104_857_601)]);

  const specialEntryServer = createServer();
  await new Promise<void>((resolve, reject) => { specialEntryServer.once("error", reject); specialEntryServer.listen(join(cwd, "agent.sock"), resolve); });
  const registry = new DockRegistry(async (input) => fixtureInstance(input), () => "workspace-instance", { hostEpoch: "workspace-host" });
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 5_000 });
  await host.start();
  try {
    const instance = await client.create(cwd, "Workspace", "create-workspace");
    const entries = [];
    let page = await client.listWorkspaceEntries(instance.id, ".", undefined, 2);
    entries.push(...page.entries);
    while (page.nextCursor) {
      page = await client.listWorkspaceEntries(instance.id, ".", page.nextCursor, 2);
      entries.push(...page.entries);
    }
    assert.equal(entries.find((entry) => entry.name === ".hidden.txt")?.hidden, true);
    assert.equal(entries.some((entry) => entry.name === "agent.sock"), false);
    assert.deepEqual(entries.find((entry) => entry.name === "note-link"), {
      path: "note-link", name: "note-link", kind: "symlink", targetKind: "file", hidden: false, sizeBytes: 15,
    });
    assert.equal(entries.find((entry) => entry.name === "folder-link")?.targetKind, "directory");
    assert.equal(entries.find((entry) => entry.name === "outside-link")?.targetKind, "unavailable");
    assert.equal(entries.find((entry) => entry.name === "broken-link")?.targetKind, "unavailable");

    assert.deepEqual(await client.getWorkspaceEntry(instance.id, "note.txt"), {
      path: "note.txt", name: "note.txt", kind: "file", hidden: false, sizeBytes: 15,
    });
    assert.deepEqual(await client.getWorkspaceEntry(instance.id, "back\\slash.txt"), {
      path: "back\\slash.txt", name: "back\\slash.txt", kind: "file", hidden: false, sizeBytes: 5,
    });
    const chunks: Buffer[] = [];
    const read = await client.readWorkspaceFile(instance.id, "note-link", (chunk) => { chunks.push(Buffer.from(chunk)); });
    assert.equal(Buffer.concat(chunks).toString("utf8"), "hello workspace");
    assert.equal(read.sizeBytes, 15);
    assert.match(read.sha256, /^[a-f0-9]{64}$/u);

    await assert.rejects(client.readWorkspaceFile(instance.id, "outside-link/secret.txt", () => {}), (error: unknown) => error instanceof ControlClientError && error.code === "workspace_entry_unavailable");
    await assert.rejects(client.getWorkspaceEntry(instance.id, "../outside/secret.txt"), (error: unknown) => error instanceof ControlClientError && error.code === "workspace_path_invalid");
    await assert.rejects(client.getWorkspaceEntry(instance.id, join(cwd, "note.txt")), (error: unknown) => error instanceof ControlClientError && error.code === "workspace_path_invalid");

    assert.equal((await client.getWorkspaceEntry(instance.id, "exact-limit.bin")).sizeBytes, 104_857_600);
    const controller = new AbortController();
    await assert.rejects(client.readWorkspaceFile(instance.id, "exact-limit.bin", () => controller.abort(), controller.signal), (error: unknown) => error instanceof ControlClientError && error.code === "aborted");
    await assert.rejects(client.readWorkspaceFile(instance.id, "over-limit.bin", () => {}), (error: unknown) => error instanceof ControlClientError && error.code === "workspace_file_too_large");

    await client.stop(instance.id, "stop-workspace");
    await assert.rejects(client.listWorkspaceEntries(instance.id, "."), ControlClientError);
  } finally {
    client.closeActiveConnections();
    await host.stop();
    await new Promise<void>((resolve) => specialEntryServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
