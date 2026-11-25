import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CatalogInstanceRecord } from "../src/core/catalog.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import { startNativeTeam } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function saved(team: { cwd: string; sessionDir: string }, id: string) {
  const session = SessionManager.create(team.cwd, team.sessionDir);
  session.appendSessionInfo(id);
  session.appendMessage({ role: "user", content: "Check the work.", timestamp: 1 });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Checking." }],
    api: "openai-completions", provider: "coordinator", model: "fixture", stopReason: "stop", timestamp: 2, usage });
  const record: CatalogInstanceRecord = {
    id, creationOperationId: `create-${id}`, name: id, cwd: team.cwd, projectTrusted: false, lifecycle: "active", execution: "idle",
    lastRun: "succeeded", runtimeGeneration: 1, ownerHostEpoch: "previous", piSessionId: session.getSessionId(),
    sessionFile: session.getSessionFile(), admissionPending: false, pendingCount: 0, createdAt: "2026-11-11T01:00:00.000Z", updatedAt: "2026-11-11T01:00:00.000Z",
  };
  return { record, session };
}

// #681: a crash can leave a result in the parent's session but the child still owed in the catalog.
// Seed the two real files at that precise cut, rather than race the Host's fsync against SIGKILL.
test("a reopened parent waits only for newer work, and stopping a child whose result arrived does not report it missing", { timeout: 45_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-work-receipts-" });
  const { record: parent, session } = saved(team, "parent");
  const instances = [parent];
  for (const id of ["shown", "waited", "newer"]) {
    const { record } = saved(team, id);
    instances.push({ ...record, parentId: parent.id, childGrant: { role: "helper" },
      workProgress: { next: id === "newer" ? 2 : 1, handed: id === "newer" ? 1 : 0, answered: -1, closed: -1 } });
    const text = `original result from ${id}`;
    if (id === "waited") session.appendMessage({ role: "assistant",
      content: [{ type: "toolCall", id: "previous-wait", name: "dock_wait", arguments: {} }],
      api: "openai-completions", provider: "coordinator", model: "fixture", stopReason: "toolUse", timestamp: 3, usage });
    const receiptId = session.appendCustomEntry("dock-work-received", { workId: parent.id, message: {
      type: "message", from: { relation: "child", id, name: id }, text, done: true, settlesThrough: 0,
    } });
    if (id === "waited") {
      session.appendCustomEntry("dock-work-in-wait", { toolCallId: "previous-wait", ids: [receiptId] });
      session.appendMessage({ role: "toolResult", toolCallId: "previous-wait", toolName: "dock_wait", content: [{ type: "text", text }], isError: false, timestamp: 3 });
    } else {
      session.appendCustomMessageEntry("dock-work-message", text, true, { receiptId, from: "child", done: true });
    }
  }
  const store = new FileCatalogStore(join(team.root, "catalog.json"));
  await store.commit({ schemaVersion: 1, revision: 1, lastHostEpoch: "previous", instances }, { kind: "fixture", effect: "pre_effect" });

  const client = await team.startHost();
  await client.reopen(parent.id, "resume-parent");
  await client.prompt(parent.id, "Wait for any remaining work.", "auto", "check-remaining");
  const { coordinator } = team.providers;
  (await coordinator.request(0)).tools({ id: "remaining", name: "dock_wait", arguments: { timeoutSeconds: 1 } });
  const reply = await coordinator.request(1);
  const result = reply.body.messages?.at(-1)?.content;
  assert.equal(typeof result === "string" && result.split("Still working: ")[1], '"newer" id=newer');
  const history = (await client.history(parent.id)).entries;
  assert.deepEqual(history.filter(e => e.customType === "dock-work-message").flatMap(e => e.content.filter(block => block.type === "text").map(block => block.text)).sort(), ["original result from newer", "original result from shown"]);
  reply.text("Still waiting for newer.");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "Parent did not settle");

  // An owner may open a child for inspection, then stop it without handing it any more work.
  await client.reopen("shown", "inspect-shown");
  await client.stop("shown", "stop-shown");
  await client.reopen("newer", "inspect-newer");
  await client.stop("newer", "stop-newer"); // A real outstanding assignment: wait for its notice as an ordering barrier.
  const notice = await coordinator.request(2);
  assert.match(JSON.stringify(notice.body.messages?.at(-1)?.content), /newer/);
  assert.doesNotMatch(JSON.stringify(notice.body.messages?.at(-1)?.content), /shown/);
  notice.text("Saw the stop.");
  const remaining = (await store.load())!.instances.find(i => i.id === "waited")!;
  assert.equal(remaining.workProgress?.answered, 0, "Another Host restart must retain the result taken by dock_wait");
});

// #681: merely creating a child used to wake its parent with a missing-result notice when stopped.
test("an owner can talk to a newly created child and stop it without reporting an assignment to its parent", { timeout: 45_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-unassigned-" });
  const { record: parent } = saved(team, "parent");
  await new FileCatalogStore(join(team.root, "catalog.json")).commit({ schemaVersion: 1, revision: 1, lastHostEpoch: "previous", instances: [parent] }, { kind: "fixture", effect: "pre_effect" });
  const client = await team.startHost();
  await client.reopen(parent.id, "open-parent");
  const child = await client.create(team.cwd, "unassigned", "create-only", undefined, undefined, undefined, { parentId: parent.id });
  const { coordinator } = team.providers;
  await client.prompt(child.id, "A question from the owner, not an assignment.");
  (await coordinator.request(0)).text("Answer for the owner.");
  await waitFor(async () => (await client.status(child.id)).execution === "idle", "Child did not settle");
  await client.stop(child.id, "stop-unassigned");
  await client.prompt(parent.id, "A question for the parent.");
  const reply = await coordinator.request(1);
  assert.match(JSON.stringify(reply.body.messages?.at(-1)?.content), /A question for the parent/);
  assert.doesNotMatch(JSON.stringify(reply.body.messages), /异常停止/);
  reply.text("Answer for the owner.");
});

// #681: the child saved the new message just before the Host could record delivery. A reserved
// number alone looks identical on the parent, even for a message that never reached its child.
test("opening interrupted children distinguishes a received assignment from a number reserved before delivery", { timeout: 45_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-child-inbox-" });
  const { record: parent } = saved(team, "parent");
  const instances = [parent];
  for (const id of ["reviewer", "not-sent"]) {
    const { record, session } = saved(team, id);
    instances.push({ ...record, parentId: parent.id, childGrant: { role: "helper" },
      workProgress: { next: 2, handed: 0, answered: 0, closed: -1 } });
    if (id === "reviewer") session.appendCustomEntry("dock-work-received", { workId: id, message: {
      type: "message", from: { relation: "parent", id: parent.id, name: "parent" }, text: "Review the new change.", number: 1,
    } });
  }
  await new FileCatalogStore(join(team.root, "catalog.json")).commit({ schemaVersion: 1, revision: 1, lastHostEpoch: "previous", instances }, { kind: "fixture", effect: "pre_effect" });
  const client = await team.startHost();
  await client.reopen(parent.id, "open-parent");
  await client.prompt(parent.id, "Check the reviews.");
  const { coordinator } = team.providers;
  (await coordinator.request(0)).tools({ id: "before", name: "dock_wait", arguments: { all: true, timeoutSeconds: 1 } });
  const before = await coordinator.request(1);
  assert.match(String(before.body.messages?.at(-1)?.content), /delivery unconfirmed/i);
  assert.equal((await client.status("reviewer")).lifecycle, "host_lost");
  await client.reopen("reviewer", "inspect-reviewer");
  await client.reopen("not-sent", "inspect-not-sent");
  assert.ok(JSON.stringify((await client.history("reviewer")).entries).includes("Review the new change."));
  before.tools({ id: "after", name: "dock_wait", arguments: { all: true, timeoutSeconds: 1 } });
  const after = await coordinator.request(2);
  assert.equal(String(after.body.messages?.at(-1)?.content).split("Still working: ")[1], '"reviewer" id=reviewer');
  after.text("Waiting for the new review.");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "Parent did not settle");
  await client.stop("reviewer", "stop-interrupted-review");
  const notice = await coordinator.request(3);
  assert.match(JSON.stringify(notice.body.messages?.at(-1)?.content), /reviewer/);
  notice.text("Saw the stop.");
});

test("after Main restarts the assistant's status keeps the latest note and credits the result she received", { timeout: 45_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-receipts-", assistant: true });
  const { record: parent, session } = saved(team, "assistant"), { record: child } = saved(team, "reviewer");
  const receiptId = session.appendCustomEntry("dock-work-received", { workId: parent.id, message: {
    type: "message", from: { relation: "child", id: child.id, name: child.name }, text: "Review sent.", done: true, settlesThrough: 0,
  } });
  session.appendCustomMessageEntry("dock-work-message", "Review sent.", true, { from: "child", done: true, receiptId });
  // A later watch fired. Replaying her old arrival side effects would overwrite this note.
  session.appendCustomEntry("assistant-works", { works: { reviewer: { name: "reviewer", lastSaid: "Latest watch note." } }, followed: [] });
  await new FileCatalogStore(join(team.root, "catalog.json")).commit({ schemaVersion: 1, revision: 1, lastHostEpoch: "previous",
    instances: [{ ...parent, assistant: true }, { ...child, parentId: parent.id, childGrant: { role: "lead" },
      workProgress: { next: 1, handed: 0, answered: -1, closed: -1 } }] }, { kind: "fixture", effect: "pre_effect" });
  const client = await team.startHost();
  await client.reopen(child.id, "inspect-reviewer");
  await client.prompt(parent.id, "Where is the review?", "auto", "status");
  const reply = await team.providers.coordinator.request(0);
  const status = JSON.stringify(reply.body.messages).match(/子 Work「reviewer」[^"\\]*/u)?.[0];
  assert.match(status ?? "", /空闲[^；]*；最近说：Latest watch note\./u);
  reply.text("The review was received.");
});
