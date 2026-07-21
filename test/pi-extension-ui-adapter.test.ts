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
  let renderedWidth = 0;
  let requestComponentRender = (): void => {};
  ui.setWidget("component", (tui) => {
    requestComponentRender = () => tui.requestRender();
    return {
      render(width: number) {
        renderedWidth = width;
        return [`component at ${width}`];
      },
      invalidate() {},
    };
  });
  broker.setWidgetViewport(claim.leaseToken, { width: 72, height: 24 });
  assert.equal(renderedWidth, 72);
  assert.equal(events.some((event) => event.type === "extension.widget_changed"
    && (event.data as { key?: string; lines?: string[] }).key === "component"
    && (event.data as { lines?: string[] }).lines?.[0] === "component at 72"), true);
  requestComponentRender();
  await Promise.resolve();
  assert.deepEqual(broker.projection().extensionStatus, { adapter: "ready" });
  assert.equal(events.some((event) => event.type === "extension.notification"), true);
  assert.equal(events.some((event) => event.type === "extension.widget_changed"), true);

  assert.equal(ui.getToolsExpanded(), false);
  ui.setToolsExpanded(true);
  ui.setToolsExpanded(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ui.getToolsExpanded(), true);
  assert.equal(events.filter((event) => event.type === "extension.tools_expanded_changed").length, 2);
  assert.equal(events.some((event) => event.type === "extension.notification"
    && /tool expansion|tools expanded/u.test(String((event.data as { message?: string }).message))), false);
  broker.beginGenerationChange();
  generation = 2;
  await broker.completeGenerationChange();
  assert.equal(ui.getToolsExpanded(), false);

  let factoryCalled = false;
  const customResult = await ui.custom((_tui, _theme, _keybindings, done) => {
    factoryCalled = true;
    done("unsafe");
    return { render: () => [], invalidate: () => {} };
  });
  assert.equal(customResult, undefined);
  assert.equal(factoryCalled, false);
  const degradationWarnings = events.filter((event) => event.type === "extension.notification"
    && (event.data as { level?: string }).level === "warning"
    && /visual request was ignored/u.test(String((event.data as { message?: string }).message)));
  assert.equal(degradationWarnings.length, 1);
  assert.match(String((degradationWarnings[0]?.data as { message?: string }).message), /custom components/u);

  assert.equal(ui.getEditorText(), "");
  assert.equal(events.filter((event) => event.type === "extension.notification"
    && /visual request was ignored/u.test(String((event.data as { message?: string }).message))).length, 1);
  assert.deepEqual(ui.setTheme("dark"), { success: false, error: "Theme switching is unsupported by Alu Dock" });
});
