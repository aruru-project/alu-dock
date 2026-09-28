import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { JsonLineDecoder, encodeJsonLine } from "../src/control/json-lines.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// #325 review reproduced a blank internal FileCapabilityMissingError against
// fc88645. This explicit public read must preserve the V2 failure information.
test("the explicit body reader explains an older Host's missing support", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-conversation-missing-"));
  const socketPath = join(root, "dock.sock");
  const server = createServer(socket => {
    const decoder = new JsonLineDecoder();
    socket.on("data", bytes => {
      for (const line of decoder.push(bytes)) {
        const hello = JSON.parse(line);
        socket.end(encodeJsonLine({ kind: "hello_error", requestId: hello.requestId,
          error: { code: "capability_missing", message: "Continuous body reading is unavailable", missing: ["conversation.content.stream.v1", "file-transfer.v1"] } }));
      }
    });
  });
  const client = new DockClient({ socketPath });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await assert.rejects(client.conversationContentStream("work", "body", () => assert.fail("No body was accepted")), error => {
      assert.ok(error instanceof ControlClientError);
      assert.equal(error.code, "capability_missing");
      assert.ok(error.message.length > 0);
      assert.deepEqual(error.details?.missing, ["conversation.content.stream.v1", "file-transfer.v1"]);
      return true;
    });
  } finally {
    client.closeActiveConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

// Transfer-wide source identity is a whole-read contract. Page reads alone fence
// only their own short query; a replaced source must not publish mixed success.
test("a held conversation body fails on source replacement, while other work remains usable", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-conversation-stream-"));
  const worker = new DelayedAgentWorkerConnection("conversation");
  worker.conversationContent.set("body", Array.from({ length: 96 }, (_, index) => ({
    type: "text", blockIndex: 0, text: "x".repeat(8000), offset: index * 8000, blockComplete: index === 95,
  })));
  const registry = new DockRegistry(async input => new ManagedInstance({ ...input, session: worker }));
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
  const client = new DockClient({ socketPath: host.socketPath });
  try {
    await host.start();
    const instance = await registry.create({ operationId: "create", cwd: root });
    // Advertising stream support never changes an explicit old page request.
    for (const view of [undefined, "references"] as const) {
      const expected = await client.conversationContent(instance.id, "body", undefined, view ? { view } : undefined);
      const records = await new Promise<Array<Record<string, any>>>((resolve, reject) => {
        const socket = createConnection(host.socketPath), decoder = new JsonLineDecoder(), frames: Array<Record<string, any>> = [];
        socket.once("error", reject);
        socket.once("connect", () => socket.write([
          { kind: "hello", requestId: "hello", versions: [2], client: { name: "old-pages", version: "1", clientId: "test" }, requiredCapabilities: ["core.v2", "conversation.content.v1", "conversation.references.v1", "conversation.content.stream.v1", "file-transfer.v1"] },
          { kind: "request", version: 2, requestId: "page", type: "conversation.content", params: { instanceId: instance.id, contentRef: "body", ...(view ? { view } : {}) } },
        ].map(encodeJsonLine).join("")));
        socket.on("data", bytes => { for (const line of decoder.push(bytes)) frames.push(JSON.parse(line)); });
        socket.once("end", () => { decoder.finish(); resolve(frames); });
      });
      assert.deepEqual(records.map(record => record.kind), ["hello_ack", "response"]);
      assert.deepEqual(records[1]!.result, expected);
    }
    for (const change of ["revision", "generation", "disconnect"] as const) {
      const entered = deferred(), release = deferred(), abort = new AbortController();
      let first = true;
      const reading = client.conversationContentStream(instance.id, "body", async () => {
        if (first) { first = false; entered.resolve(); await release.promise; }
      }, abort.signal);
      const failed = assert.rejects(reading);
      await entered.promise;
      assert.equal((await client.status(instance.id)).id, instance.id);
      if (change === "revision") worker.conversationRevision = "replacement";
      else if (change === "generation") await client.reloadSession(instance.id);
      else abort.abort();
      release.resolve();
      await failed;
      assert.equal((await client.status(instance.id)).lifecycle, "active");
    }
  } finally {
    client.closeActiveConnections(); await host.stop(); await rm(root, { recursive: true, force: true });
  }
});
