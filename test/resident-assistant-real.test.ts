import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { CatalogProjection } from "../src/core/catalog.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// #670, owner decision 2026-11-13: one Alu opens with Main, Stop restarts her, and an
// upgrade keeps the newest old assistant conversation instead of making another copy.
test("Main keeps one editable assistant: name and persona survive restart, and an upgrade keeps the newest old conversation", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["model"], { prefix: "alu-resident-", assistant: true });
  const { model } = team.providers;
  let client = await team.startHost();
  const alu = await team.assistantWork();
  assert.equal((await client.list()).filter((work) => work.assistant).length, 1);
  assert.equal(alu.name, "助手");
  await client.nameSession(alu.id, "小满");
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
  assert.equal(restarted.name, "小满");
  assert.equal(restarted.runtimeGeneration, alu.runtimeGeneration + 1);
  assert.ok(JSON.stringify(await client.history(alu.id)).includes("明天要去图书馆"));
  assert.equal((await client.list()).filter((work) => work.assistant).length, 1);

  await team.host!.stop();
  client.closeActiveConnections();
  client = await team.startHost();
  assert.equal((await team.assistantWork()).id, alu.id);
  assert.equal((await client.status(alu.id)).name, "小满");
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
  assert.equal((await client.status(alu.id)).assistant, undefined);
  assert.ok(JSON.stringify(await client.history(chosen.id)).includes("在白塔门口碰面"));
});
