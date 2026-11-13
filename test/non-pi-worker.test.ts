import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import { createWorkerInstance } from "../src/worker/create-worker-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

const PLAIN_WORKER = fileURLToPath(new URL("./fixtures/plain-worker.js", import.meta.url));

test("a Work whose Agent is not Pi answers a message, opens with nothing of Pi's, and has its conversation back after the Host restarts", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-plain-worker-"));
  const cwd = join(root, "workspace"), sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
  await chmod(root, 0o700);
  const store = new FileCatalogStore(join(root, "state/catalog.json"));
  let host: DockHost | undefined;
  let client: DockClient | undefined;
  const startHost = async (): Promise<void> => {
    const registry = new DockRegistry(({ child: _child, sessionFile, ...input }) => createWorkerInstance({
      ...input,
      executor: { kind: "plain", version: "1" },
      workerEnvironment: isolatedProcessEnvironment(root),
      launch: (environment) => ({
        entry: PLAIN_WORKER,
        cwd: input.cwd,
        init: { cwd: input.cwd, sessionDir, ...(sessionFile === undefined ? {} : { sessionFile }) },
        environment,
      }),
    }), undefined, { catalogStore: store, reopenTargetResolver: { resolve: async () => ({ cwd }) } });
    host = new DockHost({ socketPath: join(root, "dock.sock"), registry, initialize: () => registry.initializeCatalog() });
    await host.start();
    client = new DockClient({ socketPath: host.socketPath, timeoutMs: 5_000 });
  };
  const settled = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await client!.status(id);
      if (status.execution === "idle" && status.lastRun === "succeeded") return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    throw new Error("The Work did not finish its reply");
  };
  const replies = async (id: string): Promise<string[]> => (await client!.history(id)).entries
    .filter((entry) => entry.source === "assistant")
    .flatMap((entry) => entry.content.flatMap((block) => block.type === "text" ? [block.text] : []));

  try {
    await startHost();
    const work = await client!.create(cwd, "plain", "plain-create");
    assert.equal(work.executor.kind, "plain");

    const sent = await client!.prompt(work.id, "hello", "auto", "plain-first");
    assert.equal(sent.receipt.delivery, "prompt");
    await settled(work.id);
    assert.deepEqual(await replies(work.id), ["You said: hello"]);
    const page = await client!.conversationHistory(work.id);
    assert.deepEqual(page.entries.map((item) => item.entry.source), ["user", "assistant"]);

    // What a client asks for when it opens a Work: an Agent without settings, commands or a model list still opens.
    assert.deepEqual((await client!.settings(work.id)).settings, []);
    assert.deepEqual((await client!.commands(work.id)).commands, []);
    assert.deepEqual((await client!.models(work.id)).models, []);

    await host!.stop();
    client!.closeActiveConnections();
    await startHost();
    await host!.recoverInstancesOnce();
    const restored = await client!.status(work.id);
    assert.equal(restored.lifecycle, "active");
    assert.deepEqual(await replies(work.id), ["You said: hello"]);

    await client!.prompt(work.id, "again", "auto", "plain-second");
    await settled(work.id);
    assert.deepEqual(await replies(work.id), ["You said: hello", "You said: again"]);

    assert.equal((await client!.stop(work.id, "plain-stop")).instance.lifecycle, "stopped");
  } finally {
    client?.closeActiveConnections();
    await host?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
