import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionUiBroker, type ExtensionUiEventSink } from "../src/core/extension-ui-broker.js";
import type { EventDataMap } from "../src/core/instance-dto.js";
import { createPiExtensionUiContext } from "../src/pi/pi-extension-ui-adapter.js";

test("Pi extension UI adapter exposes bounded dialogs and fail-closed unsupported surfaces", async () => {
  let generation = 1;
  let id = 0;
  const events: Array<{ type: string; data: unknown }> = [];
  const broker = new ExtensionUiBroker(() => new Date("2026-07-15T00:00:00.000Z"), () => `adapter-${++id}`);
  const sink: ExtensionUiEventSink = {
    generation: () => generation,
    emit: (type, data) => { events.push({ type, data }); },
    projectionChanged: () => {},
  };
  broker.bind(sink);
  const ui = createPiExtensionUiContext(broker);
  const claim = await broker.claimController();
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;

  const selection = ui.select("Choose", ["one", "two"]);
  await Promise.resolve();
  const request = events.find((event) => event.type === "interaction.requested")?.data as EventDataMap["interaction.requested"];
  assert.equal(request.method, "select");
  await broker.respond(claim.leaseToken, request.interactionId, { method: "select", value: "two" });
  assert.equal(await selection, "two");

  ui.notify("visible", "info");
  ui.setStatus("adapter", ui.theme.fg("accent", "ready"));
  ui.setWidget("lines", ["one", "two"], { placement: "belowEditor" });
  assert.deepEqual(broker.projection().extensionStatus, { adapter: "ready" });
  assert.equal(events.some((event) => event.type === "extension.notification"), true);
  assert.equal(events.some((event) => event.type === "extension.widget_changed"), true);

  let factoryCalled = false;
  const customResult = await ui.custom((_tui, _theme, _keybindings, done) => {
    factoryCalled = true;
    done("unsafe");
    return { render: () => [], invalidate: () => {} };
  });
  assert.equal(customResult, undefined);
  assert.equal(factoryCalled, false);
  assert.equal(events.some((event) => event.type === "extension.error" && /custom components/.test(String((event.data as { error?: string }).error))), true);

  generation = 2;
  assert.equal(ui.getEditorText(), "");
  assert.deepEqual(ui.setTheme("dark"), { success: false, error: "Theme switching is unsupported by Alu Dock" });
});
