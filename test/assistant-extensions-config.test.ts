import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateAssistantExtensions, readAssistantExtensions } from "../src/assistant/extensions-config.js";
import { AssistantStore } from "../src/assistant/store.js";

// RC6/7's SQLite settings were the only copy. Moving to Main's hand-edited file must keep both the
// owner's newer file and the old private values; backups are retained data, never configuration.
test("upgrading keeps an existing extension file and privately backs up the old SQLite settings", async context => {
  const root = await mkdtemp(join(tmpdir(), "alu-extension-migration-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const legacy = JSON.stringify(["web", "private-kanban", "private-qq", "browser", "time", "weather"].map(id => ({
    id, module: id === "web" ? "builtin:web" : join(root, `${id}.mjs`), enabled: true, config: { token: `LEGACY_SECRET_${id}` },
  })));
  store.connection.prepare("INSERT INTO meta(key, value) VALUES ('tool_extensions', ?)").run(legacy);
  const file = join(root, "extensions.json");
  const edited = "[  ]\n";
  await writeFile(file, edited);

  const backup = await migrateAssistantExtensions(root, store.connection);
  assert.ok(backup);
  assert.equal(await readFile(file, "utf8"), edited);
  assert.equal(await readFile(backup!, "utf8"), legacy);
  if (process.platform !== "win32") assert.equal((await stat(backup!)).mode & 0o777, 0o600);
  assert.equal(store.connection.prepare("SELECT value FROM meta WHERE key = 'tool_extensions'").get(), undefined);
  assert.deepEqual(await readAssistantExtensions(root), []);
  await migrateAssistantExtensions(root, store.connection);
  assert.equal(await readFile(file, "utf8"), edited);
  await rm(file);
  assert.deepEqual(await readAssistantExtensions(root), [{ id: "web", module: "builtin:web", enabled: true, config: {} }], "A backup must not silently become a second configuration source");
});

test("a failed migration retains the old settings for retry, then publishes their exact bytes privately", async context => {
  const root = await mkdtemp(join(tmpdir(), "alu-extension-migration-failure-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const legacy = '[ {"id":"web","module":"builtin:web","enabled":true,"config":{"token":"PRIVATE_MIGRATION_TOKEN"}} ]';
  store.connection.prepare("INSERT INTO meta(key, value) VALUES ('tool_extensions', ?)").run(legacy);
  const workspace = join(root, "workspace");
  await writeFile(workspace, "This file blocks directory creation");
  await assert.rejects(migrateAssistantExtensions(workspace, store.connection), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("PRIVATE_MIGRATION_TOKEN"));
    return true;
  });
  assert.equal((store.connection.prepare("SELECT value FROM meta WHERE key = 'tool_extensions'").get() as { value: string }).value, legacy);
  await rm(workspace);
  await migrateAssistantExtensions(workspace, store.connection);
  assert.equal(await readFile(join(workspace, "extensions.json"), "utf8"), legacy);
  if (process.platform !== "win32") assert.equal((await stat(join(workspace, "extensions.json"))).mode & 0o777, 0o600);
  assert.equal(store.connection.prepare("SELECT value FROM meta WHERE key = 'tool_extensions'").get(), undefined);
  assert.deepEqual(await readdir(workspace), ["extensions.json"]);
});

// Credential boundary: syntax errors and errors inside opaque config may include private values
// or keys. Neither may reach the UI. Invalid files are errors, not a request for default web tools.
test("malformed extension files report a repair location without quoting their private contents", async context => {
  const root = await mkdtemp(join(tmpdir(), "alu-extension-config-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const file = join(root, "extensions.json");
  const item = { id: "local", module: join(root, "local.mjs"), enabled: true, config: {} };
  const secret = "PRIVATE_CONFIG_KEY";
  for (const text of [
    `{ "${secret}" invalid`,
    JSON.stringify({ [secret]: "not an array" }),
    JSON.stringify([{ ...item, id: "../outside" }]),
    JSON.stringify([{ ...item, config: { [secret]: "x".repeat(8_001) } }]),
    JSON.stringify([item, item]),
  ]) {
    await writeFile(file, text);
    await assert.rejects(readAssistantExtensions(root), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(file));
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});
