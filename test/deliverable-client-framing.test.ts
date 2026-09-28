import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { createHelloAck, defaultHostIdentity, implementedCapabilities } from "../src/control/protocol.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/control/json-lines.js";

const HOST_EPOCH = "framing-host";
const INSTANCE_ID = "instance-one";
const DELIVERY_REF = "delivery-one";

test("temporary file download rejects out-of-order chunks, wrong hashes, and data after completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-deliverable-framing-"));
  const socketPath = join(root, "dock.sock");
  let connection = 0;
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    let helloSeen = false;
    socket.on("data", (data) => {
      for (const line of decoder.push(data)) {
        const value = JSON.parse(line) as { requestId: string };
        if (!helloSeen) {
          helloSeen = true;
          if ((value as { requiredCapabilities?: string[] }).requiredCapabilities?.includes("file-transfer.v1")) {
            socket.end(encodeJsonLine({ kind: "hello_error", requestId: value.requestId, error: { code: "capability_missing", message: "Older Host", missing: ["file-transfer.v1"] } }));
            continue;
          }
          socket.write(encodeJsonLine(createHelloAck(value.requestId, defaultHostIdentity(HOST_EPOCH, "2026-08-18T00:00:00.000Z"), implementedCapabilities().filter((capability) => capability !== "file-transfer.v1"))));
          continue;
        }
        connection += 1;
        const common = { version: 2, requestId: value.requestId, hostEpoch: HOST_EPOCH, instanceId: INSTANCE_ID, deliveryRef: DELIVERY_REF };
        socket.write(encodeJsonLine({ kind: "deliverable_download_ready", ...common, deliverable: { deliveryRef: DELIVERY_REF, name: "result.bin", sizeBytes: 3, futureHint: "ignored" } }));
        socket.write(encodeJsonLine({ kind: "deliverable_download_chunk", ...common, index: connection === 1 ? 1 : 0, data: "YWJj" }));
        const complete = { kind: "deliverable_download_complete", ...common, chunks: 1, sizeBytes: 3, sha256: connection === 3 ? "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" : "0".repeat(64) };
        if (connection === 3) {
          socket.write(encodeJsonLine(complete));
          socket.end(encodeJsonLine({ kind: "deliverable_download_chunk", ...common, index: 1, data: "ZA==" }));
        } else socket.end(encodeJsonLine(complete));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const client = new DockClient({ socketPath, timeoutMs: 2_000 });
  try {
    const invalidResponse = (error: unknown): boolean => error instanceof ControlClientError && error.code === "invalid_response";
    await assert.rejects(client.downloadDeliverable(INSTANCE_ID, DELIVERY_REF, () => {}), invalidResponse);
    const received: Buffer[] = [];
    await assert.rejects(client.downloadDeliverable(INSTANCE_ID, DELIVERY_REF, (chunk) => { received.push(Buffer.from(chunk)); }), invalidResponse);
    assert.deepEqual(Buffer.concat(received), Buffer.from("abc"));
    await assert.rejects(client.downloadDeliverable(INSTANCE_ID, DELIVERY_REF, () => {}), invalidResponse);
  } finally {
    client.closeActiveConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
