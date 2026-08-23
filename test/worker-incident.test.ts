import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PiWorkerProcess } from "../src/pi/worker-process.js";

test("Worker error output remains available after its process exits", async () => {
  const worker = new PiWorkerProcess({
    identity: {
      hostEpoch: "incident-host",
      instanceId: "incident-work",
      runtimeGeneration: 1,
      workerIncarnation: "incident-worker",
    },
    init: {
      cwd: process.cwd(),
      agentDir: process.cwd(),
      projectTrusted: false,
    },
    environment: process.env,
    entry: fileURLToPath(new URL("./support/stderr-crash-worker.js", import.meta.url)),
  });
  await once(worker.child, "exit");
  const diagnostic = await worker.incidentStderr(1_000);
  assert.equal(worker.child.exitCode, 23);
  assert.match(diagnostic.stderrTail, /fixture Worker crash detail/u);
  assert.equal(diagnostic.stderrTruncated, false);
});
