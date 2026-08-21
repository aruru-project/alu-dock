import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { createHelloAck, defaultHostIdentity, implementedCapabilities } from "../src/control/protocol.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/control/json-lines.js";

const HOST_EPOCH = "workspace-framing-host";
const INSTANCE_ID = "workspace-instance";

test("workspace file reading accepts a changed observed size and returns the received bytes and hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-workspace-framing-"));
  const socketPath = join(root, "dock.sock");
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    let helloSeen = false;
    socket.on("data", (data) => {
      for (const line of decoder.push(data)) {
        const value = JSON.parse(line) as { requestId: string; params?: { path?: string } };
        if (!helloSeen) {
          helloSeen = true;
          socket.write(encodeJsonLine(createHelloAck(value.requestId, defaultHostIdentity(HOST_EPOCH, "2026-08-18T00:00:00.000Z"), implementedCapabilities())));
          continue;
        }
        const common = { version: 2, requestId: value.requestId, hostEpoch: HOST_EPOCH, instanceId: INSTANCE_ID, path: "changing.txt" };
        socket.write(encodeJsonLine({ kind: "workspace_file_read_ready", ...common, entry: { path: "changing.txt", name: "changing.txt", kind: "file", hidden: false, sizeBytes: 2 } }));
        socket.write(encodeJsonLine({ kind: "workspace_file_read_chunk", ...common, index: 0, data: "YWJj" }));
        socket.end(encodeJsonLine({ kind: "workspace_file_read_complete", ...common, chunks: 1, sizeBytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const client = new DockClient({ socketPath, timeoutMs: 2_000 });
  try {
    const chunks: Buffer[] = [];
    const result = await client.readWorkspaceFile(INSTANCE_ID, "changing.txt", (chunk) => { chunks.push(Buffer.from(chunk)); });
    assert.equal(Buffer.concat(chunks).toString("utf8"), "abc");
    assert.equal(result.entry.sizeBytes, 2);
    assert.equal(result.sizeBytes, 3);
    assert.equal(result.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    client.closeActiveConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
