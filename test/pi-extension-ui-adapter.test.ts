import assert from "node:assert/strict";
import test from "node:test";

import { WorkerExtensionUiEndpoint, WorkerUiLifecycleCancelledError } from "../src/pi/worker-extension-ui.js";

test("stale Worker extension UI generations reject dialogs instead of fabricating answers", async () => {
  const endpoint = new WorkerExtensionUiEndpoint(async () => undefined);
  const stale = endpoint.createGenerationPort();
  endpoint.beginGenerationChange();

  await assert.rejects(stale.select("Choose", ["one"]), WorkerUiLifecycleCancelledError);
  await assert.rejects(stale.confirm("Confirm", "Proceed?"), WorkerUiLifecycleCancelledError);
  await assert.rejects(stale.input("Input"), WorkerUiLifecycleCancelledError);
  await assert.rejects(stale.editor("Editor"), WorkerUiLifecycleCancelledError);
});
