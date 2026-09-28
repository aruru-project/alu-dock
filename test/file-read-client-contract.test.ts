import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { createHelloAck, defaultHostIdentity } from "../src/control/protocol.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/control/json-lines.js";

// The transfer's 3-byte SHA is correct in every case. These are the existing
// requested-file/fixed-delivery completeness contracts, not extra metadata policy.
test("whole-file APIs reject a different or short declared file and still accept workspace growth", async () => {
  const file = { presentation: "image", fileRef: "requested", name: "file.png", sizeBytes: 3 };
  const delivery = { deliveryRef: "requested", name: "file.txt", sizeBytes: 3 };
  const entry = { path: "file.txt", name: "file.txt", kind: "file", hidden: false, sizeBytes: 2 };
  const published = { file, runtimeGeneration: 1, instanceId: "work" };
  const cases = [
    { type: "file.read", ready: { ...published, file: { ...file, fileRef: "other" } }, result: published, early: true },
    { type: "file.read", ready: published, result: { ...published, instanceId: "other" } },
    { type: "file.read", ready: published, result: { ...published, file: { ...file, fileRef: "other" } } },
    { type: "file.read", ready: { ...published, file: { ...file, sizeBytes: 5 } }, result: { ...published, file: { ...file, sizeBytes: 5 } } },
    { type: "deliverable.download", ready: { deliverable: { ...delivery, deliveryRef: "other" } }, result: { deliverable: delivery }, early: true },
    { type: "deliverable.download", ready: { deliverable: delivery }, result: { deliverable: { ...delivery, name: "other.txt" } } },
    { type: "deliverable.download", ready: { deliverable: { ...delivery, sizeBytes: 5 } }, result: { deliverable: { ...delivery, sizeBytes: 5 } } },
    { type: "workspace.file.read", ready: { entry: { ...entry, path: "other.txt" } }, result: { entry }, early: true },
    { type: "workspace.file.read", ready: { entry: { path: "file.txt", name: "folder", kind: "directory", hidden: false } }, result: { entry }, early: true },
    { type: "workspace.file.read", ready: { entry }, result: { entry: { ...entry, path: "other.txt" } } },
    { type: "workspace.file.read", ready: { entry }, result: { entry }, success: true },
  ];
  const root = await mkdtemp(join(tmpdir(), "alu-file-contract-"));
  const socketPath = join(root, "dock.sock");
  let current = cases[0]!;
  const server = createServer(socket => {
    const scenario = current, decoder = new JsonLineDecoder();
    socket.on("error", () => {});
    socket.on("data", bytes => {
      for (const line of decoder.push(bytes)) {
        const value = JSON.parse(line);
        if (value.kind === "hello") {
          socket.write(encodeJsonLine(createHelloAck(value.requestId, defaultHostIdentity("epoch", "2026-09-28T00:00:00.000Z"), value.requiredCapabilities)));
        } else if (value.kind === "request") {
          assert.equal(value.type, scenario.type);
          const identity = { version: 2, requestId: value.requestId, hostEpoch: "epoch" };
          const summary = { chunks: 1, sizeBytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
          socket.end([
            { kind: "file_ready", ...identity, direction: "download", maxChunkBytes: 65536, windowBytes: 262144, metadata: scenario.ready },
            { kind: "file_chunk", ...identity, index: 0, data: "YWJj" },
            { kind: "file_complete", ...identity, ...summary },
            { kind: "response", ...identity, ok: true, result: { ...scenario.result, ...summary } },
          ].map(encodeJsonLine).join(""));
        }
      }
    });
  });
  server.listen(socketPath); await once(server, "listening");
  const client = new DockClient({ socketPath });
  try {
    for (const scenario of cases) {
      current = scenario;
      const bytes: Buffer[] = [];
      const sink = (chunk: Uint8Array) => { bytes.push(Buffer.from(chunk)); };
      const read = scenario.type === "file.read" ? client.downloadPublishedFile("work", "requested", sink)
        : scenario.type === "deliverable.download" ? client.downloadDeliverable("work", "requested", sink)
        : client.readWorkspaceFile("work", "./file.txt", sink);
      if (scenario.success) {
        const result = await read;
        assert.equal(result.sizeBytes, 3);
        assert.equal("entry" in result && result.entry.sizeBytes, 2);
        assert.equal(Buffer.concat(bytes).toString(), "abc");
      } else {
        await assert.rejects(read, (error: unknown) => error instanceof ControlClientError && error.code === "invalid_response");
        if (scenario.early) assert.equal(bytes.length, 0, "a different readiness must not write the sink");
      }
    }
  } finally { client.closeActiveConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
