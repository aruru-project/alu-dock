import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// #681: a saved conversation supplies the starting history, not a child to adopt or a grant of tools.
// Each provider below is a separate loopback server; we check the first model request the child actually sends.
test("a parent spawns a new child from another Work's saved conversation and independently overrides its model or thinking", { timeout: 60_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator", "archivist", "reviewer"], { prefix: "alu-spawn-file-", mainDockTools: true });
  const client = await team.startHost();
  const { coordinator, archivist } = team.providers;
  const parent = await trustOnce(trust => client.create(team.cwd, "Coordinator", "parent", trust));
  const source = await trustOnce(trust => client.create(team.cwd, "Original design", "source", trust, undefined,
    { model: { provider: "archivist", id: "fixture" }, thinkingLevel: "low" }));
  const idle = (id: string) => waitFor(async () => (await client.status(id)).execution === "idle", `Work ${id} did not settle`);

  const question = "Which guide did the first prototype use?", answer = "The first prototype used the 37 mm guide.";
  await client.prompt(source.id, question);
  const original = await archivist.request(0);
  assert.ok(original.toolNames.includes("write"));
  original.text(answer);
  await idle(source.id);
  const { sessionFile, piSessionId } = (await client.status(source.id)).executor;
  assert.ok(sessionFile);
  const before = await readFile(sessionFile);

  await client.prompt(parent.id, "Delegate the follow-up reviews using the original design.");
  let next = await coordinator.request(0);
  assert.equal((next.body as { reasoning_effort?: string }).reasoning_effort, "high");
  const choices = [
    { name: "Original settings", overrides: {}, provider: "archivist", effort: "low" },
    { name: "Other model", overrides: { model: { provider: "reviewer", id: "fixture" } }, provider: "reviewer", effort: "low" },
    { name: "More thinking", overrides: { thinkingLevel: "medium" }, provider: "archivist", effort: "medium" },
  ] as const;
  for (const [i, { name, overrides, provider, effort }] of choices.entries()) {
    const task = `Check the guide for design revision ${i + 1}.`;
    const recipient = team.providers[provider], childRequest = recipient.requests.length, spawnReply = coordinator.requests.length;
    next.tools({ id: `spawn-${i}`, name: "dock_spawn", arguments: { name, task, sessionFile, allowedTools: ["read"], ...overrides } });
    const spawned = await coordinator.request(spawnReply);
    const child = (await client.list()).find(work => work.parentId === parent.id && work.name === name);
    assert.ok(child, `The requested child was not created: ${JSON.stringify(spawned.body.messages?.at(-1)?.content)}`);
    assert.notEqual(child.id, source.id);
    assert.notEqual(child.executor.piSessionId, piSessionId);
    assert.ok(child.executor.sessionFile && child.executor.sessionFile !== sessionFile);

    const first = await recipient.request(childRequest);
    assert.equal((first.body as { reasoning_effort?: string }).reasoning_effort, effort, name);
    assert.deepEqual(first.toolNames.sort(), ["dock_send", "read"]);
    const messages = first.body.messages!;
    assert.ok(messages.some(m => m.role === "user" && JSON.stringify(m.content).includes(question)));
    assert.ok(messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes(answer)));
    assert.ok(messages.some(m => m.role === "user" && JSON.stringify(m.content).includes(task)));

    spawned.text("Waiting for this review.");
    await idle(parent.id);
    const result = `Design revision ${i + 1} is reviewed.`;
    first.tools({ id: `report-${i}`, name: "dock_send", arguments: { message: result, done: true } });
    next = await coordinator.request(spawnReply + 1);
    assert.ok(next.body.messages?.some(m => m.role === "user" && JSON.stringify(m.content).includes(result)),
      `The parent did not receive ${name}'s final result`);
  }
  next.text("Reviews received.");
  await idle(parent.id);
  const copies = (await client.list()).filter(work => work.parentId === parent.id);
  assert.equal(copies.length, choices.length);
  assert.equal(new Set(copies.map(work => work.executor.sessionFile)).size, choices.length);
  assert.equal(new Set(copies.map(work => work.executor.piSessionId)).size, choices.length);
  assert.ok(before.equals(await readFile(sessionFile)), "Spawning and running the children changed the source file");

  // The Work that owns the original file can still use it independently.
  const following = archivist.requests.length;
  await client.prompt(source.id, "Continue the original prototype.");
  const continued = await archivist.request(following);
  assert.ok(continued.body.messages?.some(m => m.role === "assistant" && JSON.stringify(m.content).includes(answer)));
  assert.ok(continued.toolNames.includes("write"));
  continued.text("Continuing the original design.");
  await idle(source.id);
});
