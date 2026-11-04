import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ModelServiceProcess, ModelServiceUnavailableError } from "../src/model-service/service-process.js";
import { waitFor } from "./support/plan-goal-provider.js";

const stalled = fileURLToPath(new URL("./support/stalled-model-service.js", import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Cloud review of e7c5da2: a service whose start hung kept every waiting request, and its cancel, waiting.
test("a model service whose start hangs is restarted, and requests waiting for it end in time or on cancel", { timeout: 20_000 }, async (context) => {
  const service = new ModelServiceProcess({ agentDir: "/nonexistent", environment: { PATH: process.env.PATH }, entry: stalled, readyWaitMs: 300, startTimeoutMs: 500 });
  context.after(() => service.stop());
  void service.start().catch(() => {});
  await waitFor(() => service.pid !== undefined, "The service did not start");
  const first = service.pid!;

  await assert.rejects(service.configuration(new AbortController().signal), ModelServiceUnavailableError);
  const controller = new AbortController();
  const cancelled = service.auth({ target: "p" }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const startedAt = Date.now();
  await assert.rejects(cancelled);
  assert.ok(Date.now() - startedAt < 250, "A cancel ends the wait at once");

  await waitFor(() => !alive(first), "The service that never became ready kept running");
});
