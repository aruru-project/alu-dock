import assert from "node:assert/strict";
import test from "node:test";

import { createPiExtensionUiContext, type PiExtensionUiPort } from "../src/pi/pi-extension-ui-adapter.js";
import { WorkerExtensionUiEndpoint, WorkerUiLifecycleCancelledError } from "../src/pi/worker-extension-ui.js";

test("unsupported extension interactions fail instead of fabricating answers", async () => {
  const context = createPiExtensionUiContext({
    bindWidgetRenderer: () => {},
  } as unknown as PiExtensionUiPort);

  await assert.rejects((context.custom as unknown as () => Promise<unknown>)());
  assert.throws(() => context.getEditorText());
});

test("stale Worker extension UI generations reject dialogs instead of fabricating answers", async () => {
  const calls: string[] = [];
  const endpoint = new WorkerExtensionUiEndpoint(async (capability) => { calls.push(capability); });
  const stale = endpoint.createGenerationPort();
  await endpoint.beginGenerationChange();

  await assert.rejects(stale.select("Choose", ["one"]), WorkerUiLifecycleCancelledError);
  await assert.rejects(stale.confirm("Confirm", "Proceed?"), WorkerUiLifecycleCancelledError);
  await assert.rejects(stale.input("Input"), WorkerUiLifecycleCancelledError);
  await assert.rejects(stale.editor("Editor"), WorkerUiLifecycleCancelledError);
  assert.deepEqual(calls, []);

  const current = endpoint.createGenerationPort();
  current.setStatus("fixture", "ready");
  assert.deepEqual(calls, []);
  await endpoint.completeGenerationChange();
  assert.deepEqual(calls, ["ui.setStatus"]);

  await endpoint.beginGenerationChange("reload");
  assert.deepEqual(calls, ["ui.setStatus", "ui.runtimeReload"]);
});
