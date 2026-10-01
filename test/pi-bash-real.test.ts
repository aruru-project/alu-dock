import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import type { DockEvent } from "../src/core/instance-dto.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { createIsolatedPiInstance } from "./fixtures/isolated-pi-instance.js";

// Card #336: a client runs `!` / `!!` shell commands in the Work directory through the
// real Host and Pi Worker, watches output, stops them, and finds the run record afterwards.
test("user runs shell commands from a client: output streams, abort stops them, and the session keeps the record (card #336)", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-bash-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const socketPath = join(root, "dock.sock");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  await chmod(root, 0o700);

  const registry = new DockRegistry(
    (input) => createIsolatedPiInstance({ ...input, agentDir, sessionDir, tools: [] }),
    () => "bash-real-instance",
  );
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 5_000, longMutationTimeoutMs: 10_000 });
  const events: DockEvent[] = [];
  const waiters: Array<{ match: (event: DockEvent) => boolean; resolve: (event: DockEvent) => void }> = [];
  const waitFor = (match: (event: DockEvent) => boolean): Promise<DockEvent> => {
    const seen = events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  let subscription: Awaited<ReturnType<DockClient["streamEvents"]>> | undefined;

  try {
    await host.start();
    const created = await client.create(cwd, "bash real", "bash-real-create");
    subscription = await client.streamEvents(created.id, {
      since: created.eventCursor,
      onEvent: (event) => {
        events.push(event);
        for (const waiter of waiters.splice(0)) {
          if (waiter.match(event)) waiter.resolve(event); else waiters.push(waiter);
        }
      },
    });

    // `!!`: record only. The receipt comes back before the command finishes.
    const quiet = await client.runBash(created.id, "pwd && printf 'first line\\nsecond line\\n'", true, "bash-quiet");
    assert.equal(quiet.receipt.operationId, "bash-quiet");
    assert.equal(quiet.receipt.instanceId, created.id);
    assert.equal(quiet.instance.execution, "idle", "a user shell command is not an Agent run");

    const started = await waitFor((event) => event.type === "bash.started" && event.data.operationId === "bash-quiet");
    assert.equal(started.type, "bash.started");
    if (started.type === "bash.started") {
      assert.equal(started.data.command, "pwd && printf 'first line\\nsecond line\\n'");
      assert.equal(started.data.excludeFromContext, true);
    }
    const completed = await waitFor((event) => event.type === "bash.completed" && event.data.operationId === "bash-quiet");
    if (completed.type === "bash.completed") {
      assert.equal(completed.data.exitCode, 0);
      assert.equal(completed.data.cancelled, false);
      assert.equal(completed.data.truncated, false);
    }
    const output = events
      .filter((event): event is Extract<DockEvent, { type: "bash.output" }> => event.type === "bash.output" && event.data.operationId === "bash-quiet")
      .map((event) => event.data.delta).join("");
    assert.ok(output.includes("first line\nsecond line"), `output was: ${JSON.stringify(output)}`);
    assert.ok(output.split("\n")[0]?.endsWith("cwd"), `command must run in the Work directory, saw ${JSON.stringify(output)}`);

    // Completion and the Host's updated history arrive separately (#336/#339).
    // Wait for this command's record, not an unrelated earlier shell command.
    const isQuietRecord = (entry: { kind: string; command?: string }) => entry.kind === "bash_execution" && entry.command === "pwd && printf 'first line\\nsecond line\\n'";
    await waitForAsync(async () => (await client.history(created.id)).entries.some(isQuietRecord), "Host history must receive this command's record");
    const quietRecord = (await client.history(created.id)).entries.find((entry) => entry.kind === "bash_execution");
    assert.ok(quietRecord, "session history must show the run record");
    assert.equal(quietRecord.command, "pwd && printf 'first line\\nsecond line\\n'");
    assert.equal(quietRecord.excludeFromContext, true);
    assert.equal(quietRecord.exitCode, 0);

    // `!`: same path, recorded for the model; a client opening the Work mid-command sees it running.
    const long = await client.runBash(created.id, "echo waiting && sleep 20", false, "bash-long");
    assert.equal(long.receipt.operationId, "bash-long");
    await waitFor((event) => event.type === "bash.output" && event.data.operationId === "bash-long");
    const midway = await client.read(created.id, undefined, "conversation_bootstrap");
    const midwayStarted = midway.page.events.filter((event) => event.type === "bash.started").map((event) => event.data.operationId);
    assert.deepEqual(midwayStarted, ["bash-long"], "a running command is visible to a client that opens the Work now");
    assert.equal(midway.page.events.some((event) => event.type === "bash.output"), false, "output is not replayed for late readers");

    // Review follow-up: a Reload keeps the session and the running command, but opens a new
    // generation; the command must stay visible there and its output must keep arriving.
    const reloaded = await client.reloadSession(created.id, "bash-reload");
    assert.equal(reloaded.instance.runtimeGeneration, 2);
    const afterReload = await client.read(created.id, undefined, "conversation_bootstrap");
    assert.deepEqual(afterReload.page.events.filter((event) => event.type === "bash.started").map((event) => event.data.operationId), ["bash-long"], "the running command is announced again in the new generation");
    subscription.close();
    events.length = 0;
    subscription = await client.streamEvents(created.id, { since: afterReload.page.latest, onEvent: (event) => {
      events.push(event);
      for (const waiter of waiters.splice(0)) { if (waiter.match(event)) waiter.resolve(event); else waiters.push(waiter); }
    } });

    const aborted = await client.abortBash(created.id, "bash-abort");
    assert.equal(aborted.instance.id, created.id);
    const cancelled = await waitFor((event) => event.type === "bash.completed" && event.data.operationId === "bash-long");
    if (cancelled.type === "bash.completed") {
      assert.equal(cancelled.data.cancelled, true);
      assert.equal(cancelled.data.exitCode, undefined);
    }
    await waitForAsync(async () => (await client.history(created.id)).entries.some((entry) => entry.kind === "bash_execution" && entry.command === "echo waiting && sleep 20"),
      "Host history must receive the cancelled command's record");
    const afterAbort = await client.read(created.id, undefined, "conversation_bootstrap");
    assert.equal(afterAbort.page.events.some((event) => event.type === "bash.started" && event.data.operationId === "bash-long"), false,
      "the cancelled command leaves the live rows after Host receives its history");
    const records = (await client.history(created.id)).entries.filter((entry) => entry.kind === "bash_execution");
    assert.deepEqual(records.map((entry) => [entry.command, entry.excludeFromContext, entry.cancelled]), [
      ["pwd && printf 'first line\\nsecond line\\n'", true, false],
      ["echo waiting && sleep 20", false, true],
    ]);
  } finally {
    subscription?.close();
    client.closeActiveConnections();
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

// While the Agent is replying, Pi holds the run record until the reply ends so tool
// call/result ordering stays intact. A client opening the Work in between still sees
// the finished command; after the reply the record is in history and the live rows go.
test("user runs a shell command while the Agent is replying: it finishes now and is recorded after the reply (card #336)", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-bash-running-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const pendingResponses: ServerResponse[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the real provider request. */ }
    pendingResponses.push(response);
  });
  let host: DockHost | undefined;
  let client: DockClient | undefined;
  let follower: Awaited<ReturnType<DockClient["streamEvents"]>> | undefined;
  const events: DockEvent[] = [];
  try {
    await Promise.all([cwd, agentDir, sessionDir, home].map((path) => mkdir(path)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "bash-loopback": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-key",
      models: [{ id: "fixture", name: "Bash fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "bash-loopback", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false },
    }));
    await writeFile(join(cwd, "note.txt"), "a note\n");
    const registry = new DockRegistry((input) => createPiInstance({
      ...input, agentDir, sessionDir, tools: ["read"],
      workerEnvironment: {
        HOME: home, USERPROFILE: home, PATH: process.env.PATH, LANG: process.env.LANG,
        XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
        PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
        TMPDIR: root, TEMP: root, TMP: root,
      },
    }));
    const socketPath = join(root, "dock.sock");
    host = new DockHost({ socketPath, registry }); await host.start();
    client = new DockClient({ socketPath, timeoutMs: 5_000 });
    const work = await client.create(cwd, "Bash while running", "running-create");
    follower = await client.streamEvents(work.id, { onEvent: (event) => events.push(event) });

    const historyKinds = async (): Promise<string[]> => (await client!.history(work.id)).entries.map((entry) => entry.kind === "message" ? `${entry.kind}:${entry.source}` : entry.kind);
    const liveBashRows = async (): Promise<string[]> => (await client!.read(work.id, undefined, "conversation_bootstrap")).page.events
      .filter((event) => event.type === "bash.started" || event.type === "bash.completed").map((event) => event.type);

    await client.prompt(work.id, "Read note.txt.", "prompt", "run-1");
    await waitFor(() => pendingResponses.length > 0, "model request did not arrive");
    const receipt = await client.runBash(work.id, "echo during-reply", true, "bash-during");
    assert.equal(receipt.instance.execution, "running");
    await waitFor(() => events.some((event) => event.type === "bash.completed" && event.data.operationId === "bash-during"), "command did not finish during the reply");
    assert.equal(events.some((event) => event.type === "run.settled"), false, "the reply must still be in progress");

    // The reply's first turn ends with a tool result: history advances, but the command's record still waits.
    const first = pendingResponses[0]!;
    first.writeHead(200, { "content-type": "text/event-stream" });
    sendChunk(first, { role: "assistant", tool_calls: [{ index: 0, id: "read-note", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) } }] }, null);
    sendChunk(first, {}, "tool_calls");
    first.end("data: [DONE]\n\n");
    await waitFor(() => pendingResponses.length > 1, "second model request did not arrive");
    await waitForAsync(async () => (await historyKinds()).includes("message:tool"), "the tool result did not reach history");
    assert.equal((await historyKinds()).includes("bash_execution"), false, "Pi holds the record until the reply ends");
    assert.deepEqual(await liveBashRows(), ["bash.started", "bash.completed"], "a client opening now still sees the finished command");

    const second = pendingResponses[1]!;
    second.writeHead(200, { "content-type": "text/event-stream" });
    sendChunk(second, { role: "assistant", content: "Done." }, null);
    sendChunk(second, {}, "stop");
    second.end("data: [DONE]\n\n");
    await waitFor(() => events.some((event) => event.type === "run.settled" && event.data.operationId === "run-1"), "reply did not finish");
    await waitForAsync(async () => (await historyKinds()).includes("bash_execution"), "the record did not land after the reply");
    assert.deepEqual(await liveBashRows(), [], "the live rows leave once the record is written");
    assert.deepEqual((await historyKinds()).slice(-4), ["message:assistant", "message:tool", "message:assistant", "bash_execution"], "the record follows the reply it ran under");

    // Review follow-up: stopping the Work while a command runs still leaves its cancellation in the saved session.
    // (Pi only writes the session file once a reply exists, which this test has.)
    await client.runBash(work.id, "sleep 25", true, "bash-stopped");
    await waitFor(() => events.some((event) => event.type === "bash.started" && event.data.operationId === "bash-stopped"), "stopped command did not start");
    const sessionFile = (await client.status(work.id)).executor.sessionFile;
    assert.ok(sessionFile);
    await client.stop(work.id, "bash-stop");
    const saved = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; command?: string; cancelled?: boolean } });
    const stoppedRecord = saved.find((entry) => entry.type === "message" && entry.message?.role === "bashExecution" && entry.message.command === "sleep 25");
    assert.ok(stoppedRecord, "the stopped command is recorded in the saved session");
    assert.equal(stoppedRecord.message?.cancelled, true);
  } finally {
    follower?.close(); await follower?.done.catch(() => {});
    client?.closeActiveConnections();
    await host?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function sendChunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null): void {
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-bash", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  return waitForAsync(async () => predicate(), message);
}

async function waitForAsync(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
