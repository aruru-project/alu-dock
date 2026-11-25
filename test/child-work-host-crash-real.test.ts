import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

function launchHost(team: { root: string; cwd: string; environment: NodeJS.ProcessEnv }, signal: AbortSignal) {
  const child = fork(new URL("./fixtures/native-team-host.js", import.meta.url), [team.root], {
    cwd: team.cwd, env: team.environment, execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  return {
    ready: Promise.race([once(child, "message", { signal }), exit]).then(([message]) => assert.equal(message, "ready")),
    client: new DockClient({ socketPath: join(team.root, "dock.sock") }),
    async crash() {
      child.kill("SIGKILL");
      assert.equal((await exit)[1], "SIGKILL");
    },
    async stop() {
      if (child.connected) child.disconnect();
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 8_000);
      try { await exit; } finally { clearTimeout(watchdog); }
    },
  };
}

// Card #681: after systemd-oomd killed the Host, the coordinator lost all four children despite their intact sessions.
test("after a Host is killed the reopened parent finds its interrupted child and gets the result from its original conversation", { timeout: 90_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "reviewer"], { prefix: "alu-child-crash-" });
  const { coordinator, reviewer } = team.providers;
  const evidence = "READ_BEFORE_CRASH: the second bracket is missing";
  await writeFile(join(team.cwd, "finding.txt"), evidence);
  let host = launchHost(team, context.signal);
  try {
    await host.ready;
    const parent = await trustOnce(trust => host.client.create(team.cwd, "Coordinator", "create-parent", trust));
    await host.client.prompt(parent.id, "Commission a review.", "auto", "delegate");
    (await coordinator.request(0)).tools({ id: "spawn-review", name: "dock_spawn", arguments: {
      name: "Reviewer", task: "Review finding.txt and report to me.", model: { provider: "reviewer", id: "fixture" },
      thinkingLevel: "low", allowedTools: ["read"],
    } });
    (await reviewer.request(0)).tools({ id: "get-evidence", name: "read", arguments: { path: "finding.txt" } });
    const interrupted = await reviewer.request(1);
    const prefix = interrupted.body.messages!;
    assert.ok(prefix.some(message => message.role === "tool" && JSON.stringify(message.content).includes(evidence)));
    (await coordinator.request(1)).text("Waiting for the review.");
    await waitFor(async () => (await host.client.status(parent.id)).execution === "idle", "The coordinator did not settle");
    const child = (await host.client.list()).find(work => work.parentId === parent.id);
    assert.ok(child?.executor.sessionFile, "The review has its own saved conversation");
    const sessionFile = child.executor.sessionFile;

    // The reviewer is still waiting for a model reply. The Host has no chance to run its shutdown path.
    host.client.closeActiveConnections();
    await host.crash();
    await waitFor(() => interrupted.closed, "The interrupted reviewer's old request did not close");
    host = launchHost(team, context.signal);
    await host.ready;
    await host.client.reopen(parent.id, "reopen-parent");
    await host.client.prompt(parent.id, "Find your review and have it finish.", "auto", "find-review");
    (await coordinator.request(2)).tools({ id: "find", name: "dock_list", arguments: { scope: "all" } });
    const found = await coordinator.request(3);
    const listing = found.body.messages?.at(-1)?.content;
    assert.ok(typeof listing === "string");
    assert.ok(listing.includes(child.id), "The original child is missing from the reopened parent's dock_list");
    assert.ok(listing.includes(sessionFile), "The parent cannot see the interrupted child's session file");
    assert.match(listing, /interrupted/i);
    assert.match(listing, /continue/i);
    assert.equal((await host.client.status(child.id)).parentId, parent.id);

    found.tools({ id: "resume", name: "dock_send", arguments: { target: child.id, message: "Finish your original review." } });
    const resumed = await reviewer.request(2);
    const messages = resumed.body.messages!;
    // The provider gets the same prefix (including the role instructions, read call and evidence), not a summary of it.
    for (const [i, message] of prefix.entries()) {
      assert.ok(isDeepStrictEqual(messages[i], message), `The reviewer's original ${message.role} message at position ${i} changed`);
    }
    assert.ok(messages.slice(prefix.length).some(message => JSON.stringify(message.content).includes("[来自父 Work「Coordinator」]\\nFinish your original review.")));
    assert.deepEqual(resumed.toolNames.sort(), ["dock_send", "read"]);
    const awake = await host.client.status(child.id);
    assert.equal(awake.executor.sessionFile, sessionFile);
    assert.deepEqual(awake.executor.model, { provider: "reviewer", id: "fixture" });
    assert.equal(awake.executor.thinkingLevel, "low");

    (await coordinator.request(4)).text("I will wait for the result.");
    await waitFor(async () => (await host.client.status(parent.id)).execution === "idle", "The parent did not settle after its message");
    resumed.tools({ id: "report", name: "dock_send", arguments: { message: "REVIEW_COMPLETE: restore the bracket.", done: true } });
    const done = await coordinator.request(5);
    assert.ok(done.body.messages?.some(message => JSON.stringify(message.content).includes("[来自子 Work「Reviewer」· 已完成]\\nREVIEW_COMPLETE")),
      "The reopened coordinator did not receive the original reviewer's final result");
    done.text("Review received.");
  } finally {
    host.client.closeActiveConnections();
    await host.stop();
  }
});
