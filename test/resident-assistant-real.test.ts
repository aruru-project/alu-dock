import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { encodeJsonLine } from "../src/control/json-lines.js";
import { parseHelloReply } from "../src/control/protocol.js";
import type { DockEvent } from "../src/core/instance-dto.js";
import type { CatalogProjection } from "../src/core/catalog.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

test("a client connecting to Main sees the built Dock release in the handshake and in its assistant", async (context) => {
  const { resolveReleaseVersion } = await import(new URL("../../clients/official/scripts/release-version.mjs", import.meta.url).href);
  const expected = resolveReleaseVersion();
  const team = await startNativeTeam(context, ["model"], { prefix: "alu-version-", assistant: true });
  const client = await team.startHost();
  const assistant = await client.status((await team.assistantWork()).id);
  const socket = connect(join(team.root, "dock.sock"));
  try {
    const lines = createInterface({ input: socket });
    socket.write(encodeJsonLine({ kind: "hello", requestId: "release", versions: [2], client: { name: "test", version: "1", clientId: "release" }, requiredCapabilities: [] }));
    const { value } = await lines[Symbol.asyncIterator]().next();
    const hello = parseHelloReply(JSON.parse(value), "release");
    assert.deepEqual([hello.host.dockVersion, assistant.executor.version], [expected, expected]);
  } finally {
    socket.destroy();
  }
});

// #670, owner decision 2026-11-13: one Alu opens with Main, Stop restarts her, and an
// upgrade keeps the newest old assistant conversation instead of making another copy.
test("Main keeps one editable assistant: name and persona survive restart, and an upgrade keeps the newest old conversation", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["model"], { prefix: "alu-resident-", assistant: true });
  const { model } = team.providers;
  let client = await team.startHost();
  const alu = await team.assistantWork();
  assert.equal((await client.list()).filter((work) => work.assistant).length, 1);
  assert.equal(alu.displayName, "alu");
  assert.equal((await client.assistantSettings()).displayName, "alu");
  const other = new DockClient({ socketPath: join(team.root, "dock.sock") });
  context.after(() => other.closeActiveConnections());
  const events: DockEvent[] = [];
  const followed = await other.streamEvents(alu.id, { onEvent: event => events.push(event) });
  context.after(async () => { followed.close(); await followed.done.catch(() => {}); });
  await client.setAssistantSettings({ displayName: "小满 · 星" });
  await waitFor(() => events.some(event => event.type === "session.info_changed" && event.data.displayName === "小满 · 星"), "The other connected client did not receive the new name");
  assert.equal((await other.assistantSettings()).displayName, "小满 · 星");
  const renamed = (await other.list()).find(work => work.id === alu.id)!;
  assert.equal(renamed.displayName, "小满 · 星");
  assert.equal(renamed.executor.piSessionId, alu.executor.piSessionId);
  assert.equal(renamed.name, alu.name, "A global display name leaves the session title alone");
  await client.nameSession(alu.id, "早晨的对话");
  assert.equal((await client.status(alu.id)).displayName, "小满 · 星");
  const persona = await client.assistantDocument("persona");
  const customPrompt = "你叫小满，用平实的语气交谈，不称呼我为主人。";
  await client.setAssistantDocument("persona", customPrompt, persona.revision);
  // The explicit one-assistant product rule: clients cannot create a second or remove the resident.
  await assert.rejects(client.create(team.cwd, "Second", undefined, undefined, undefined, undefined, undefined, true), { code: "capability_missing" });
  await assert.rejects(client.forget(alu.id), { code: "invalid_request" });

  await client.prompt(alu.id, "我们刚才说到哪？");
  const first = await model.request(0);
  const opening = JSON.stringify(first.body.messages?.filter((message) => message.role === "system" || message.role === "developer"));
  assert.ok(opening.includes(customPrompt));
  // Owner's explicit requirement: no fixed character or hidden working prompt overrides an edit.
  assert.doesNotMatch(opening, /你是\*\*阿露\*\*|## 你在 Alu Dock 里/);
  first.text("说到明天要去图书馆。");
  await waitFor(async () => (await client.status(alu.id)).execution === "idle", "Alu did not finish");
  const stopped = await client.stop(alu.id);
  assert.equal(stopped.instance.lifecycle, "stopped", "The existing stop receipt describes the Worker that stopped");
  const restarted = await client.status(alu.id);
  assert.equal(restarted.lifecycle, "active");
  assert.equal(restarted.name, "早晨的对话");
  assert.equal(restarted.displayName, "小满 · 星");
  assert.equal(restarted.runtimeGeneration, alu.runtimeGeneration + 1);
  assert.ok(JSON.stringify(await client.history(alu.id)).includes("明天要去图书馆"));
  assert.equal((await client.list()).filter((work) => work.assistant).length, 1);

  followed.close();
  await followed.done.catch(() => {});
  await team.host!.stop();
  client.closeActiveConnections();
  client = await team.startHost();
  assert.equal((await team.assistantWork()).id, alu.id);
  assert.equal((await client.status(alu.id)).name, "早晨的对话");
  assert.equal((await client.assistantSettings()).displayName, "小满 · 星");
  assert.equal((await client.status(alu.id)).displayName, "小满 · 星");
  assert.equal((await client.assistantDocument("persona")).text, customPrompt);
  assert.ok(JSON.stringify(await client.history(alu.id)).includes("明天要去图书馆"));

  // Seed an older installation using real saved Pi conversation/catalog records, without copying
  // implementation-specific session projection fixtures. Both Works used to be assistants.
  const newer = await trustOnce((trust) => client.create(team.cwd, "后来那段对话", "newer", trust));
  await client.prompt(newer.id, "说个路标");
  (await model.request(1)).text("在白塔门口碰面。");
  await waitFor(async () => (await client.status(newer.id)).execution === "idle", "The Pi Work did not finish");
  await team.host!.stop();
  client.closeActiveConnections();
  const path = join(team.root, "catalog.json");
  const catalog = JSON.parse(await readFile(path, "utf8")) as CatalogProjection;
  for (const record of catalog.instances) {
    record.assistant = true;
    record.updatedAt = record.id === newer.id ? "2090-01-02T00:00:00.000Z" : "2090-01-01T00:00:00.000Z";
  }
  await writeFile(path, JSON.stringify(catalog));
  client = await team.startHost();
  const chosen = await team.assistantWork();
  assert.equal(chosen.id, newer.id);
  assert.equal(chosen.name, "后来那段对话");
  assert.equal(chosen.displayName, "小满 · 星");
  assert.equal((await client.status(alu.id)).assistant, undefined);
  assert.ok(JSON.stringify(await client.history(chosen.id)).includes("在白塔门口碰面"));
});
