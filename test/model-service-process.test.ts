import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ModelServiceProcess, ModelServiceUnavailableError } from "../src/model-service/service-process.js";
import { waitFor } from "./support/plan-goal-provider.js";

const stalled = fileURLToPath(new URL("./support/stalled-model-service.js", import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Cloud review of e7c5da2: a service whose start hung kept every waiting question, and its cancel,
// waiting. Review of 6799d48: a new Work's start must learn why before its own deadline.
test("a model service whose start hangs is restarted, and questions waiting for it end on cancel or in time", { timeout: 20_000 }, async (context) => {
  const service = new ModelServiceProcess({ agentDir: "/nonexistent", environment: { PATH: process.env.PATH }, entry: stalled, readyWaitMs: 1_000, startTimeoutMs: 2_000 });
  context.after(() => service.stop());
  void service.start().catch(() => {});
  await waitFor(() => service.pid !== undefined, "The service did not start");
  const first = service.pid!;

  // A cancel ends the wait at once, long before its deadline.
  const controller = new AbortController();
  const cancelledAt = Date.now();
  const cancelled = service.auth({ target: "p" }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(cancelled);
  assert.ok(Date.now() - cancelledAt < 500, "A cancel ends the wait at once");

  // Without a cancel the wait ends at its deadline with the reason, and later questions fail at once.
  const waitedAt = Date.now();
  await assert.rejects(service.configuration(new AbortController().signal), ModelServiceUnavailableError);
  assert.ok(Date.now() - waitedAt >= 900, "The question waited for the service");
  const nextAt = Date.now();
  await assert.rejects(service.configuration(new AbortController().signal), ModelServiceUnavailableError);
  assert.ok(Date.now() - nextAt < 200, "After one wait ran out, questions fail at once");

  await waitFor(() => !alive(first), "The service that never became ready kept running");
});
