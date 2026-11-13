import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// 2026-11-13: the owner's other top-level Work sent a finding, but it waited until this
// Work's whole turn ended. Default send must reach the next step; explicit followUp still waits.
test("dock_send reaches a busy top-level Work at its next step unless the sender explicitly asks for followUp", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["sender", "receiver"], { prefix: "alu-next-step-" });
  const { sender, receiver } = team.providers;
  const file = join(team.cwd, "note.txt");
  await writeFile(file, "keep working");
  const client = await team.startHost();
  const from = await trustOnce((trust) => client.create(team.cwd, "Sender", "from", trust));
  const to = await trustOnce((trust) => client.create(team.cwd, "Receiver", "to", trust));
  await client.setModel(to.id, "receiver", "fixture");
  await client.prompt(to.id, "Read the note and keep working.");
  const underway = await receiver.request(0);
  await client.prompt(from.id, "Tell Receiver the new finding.");
  (await sender.request(0)).tools({ id: "send-now", name: "dock_send", arguments: { target: to.id, message: "NEXT_STEP_FINDING" } });
  const delivered = await sender.request(1);
  underway.tools({ id: "read-one", name: "read", arguments: { path: file } });
  const nextStep = await receiver.request(1);
  assert.ok(JSON.stringify(nextStep.body.messages).includes("NEXT_STEP_FINDING"), "The finding reaches the tool continuation, before the receiver ends its turn");

  delivered.tools({ id: "send-later", name: "dock_send", arguments: { target: to.id, message: "AFTER_THIS_TURN", delivery: "followUp" } });
  (await sender.request(2)).text("Sent both messages.");
  nextStep.tools({ id: "read-two", name: "read", arguments: { path: file } });
  const stillWorking = await receiver.request(2);
  assert.ok(!JSON.stringify(stillWorking.body.messages).includes("AFTER_THIS_TURN"), "An explicitly deferred message is not a mid-turn interruption");
  stillWorking.text("This turn is complete.");
  const following = await receiver.request(3);
  assert.ok(JSON.stringify(following.body.messages).includes("AFTER_THIS_TURN"));
  following.text("Read the deferred message.");
  await waitFor(async () => (await client.status(to.id)).execution === "idle" && (await client.status(from.id)).execution === "idle", "Both Works should finish");
});
