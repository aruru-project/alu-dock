import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { WorkerProcess } from "../src/worker/worker-process.js";

test("Worker error output remains available after its process exits", async () => {
  const worker = new WorkerProcess({
    identity: {
      hostEpoch: "incident-host",
      instanceId: "incident-work",
      runtimeGeneration: 1,
      workerIncarnation: "incident-worker",
    },
    launch: {
      entry: fileURLToPath(new URL("./support/stderr-crash-worker.js", import.meta.url)),
      cwd: process.cwd(),
      init: {},
      environment: process.env,
    },
  });
  await once(worker.child, "exit");
  const diagnostic = await worker.incidentStderr(1_000);
  assert.equal(worker.child.exitCode, 23);
  assert.match(diagnostic.stderrTail, /fixture Worker crash detail/u);
  assert.equal(diagnostic.stderrTruncated, false);
});
