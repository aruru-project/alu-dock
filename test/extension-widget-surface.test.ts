import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import type { DockEvent } from "../src/core/instance-dto.js";
import { ExtensionWidgetSurface } from "../src/tui/extension-widget-surface.js";

function widgetEvent(
  sequence: number,
  key: string,
  lines?: string[],
  placement?: "aboveEditor" | "belowEditor",
): DockEvent {
  return {
    scope: "instance",
    sequence,
    instanceId: "instance-1",
    runtimeGeneration: 1,
    occurredAt: "2026-07-21T00:00:00.000Z",
    type: "extension.widget_changed",
    data: { key, lines, placement },
  };
}

test("extension widget surface mounts keyed widgets at the requested placement", () => {
  let width = 0;
  const above = new ExtensionWidgetSurface("aboveEditor", (value) => { width = value; });
  const below = new ExtensionWidgetSurface("belowEditor", () => {});

  const event = widgetEvent(1, "jobs", ["Async agents", "└─ worker"], "aboveEditor");
  above.apply(event);
  below.apply(event);
  assert.deepEqual(above.render(80), ["Async agents", "└─ worker"]);
  assert.deepEqual(below.render(80), []);
  assert.equal(width, 80);

  const moved = widgetEvent(2, "jobs", ["moved"], "belowEditor");
  above.apply(moved);
  below.apply(moved);
  assert.deepEqual(above.render(80), []);
  assert.deepEqual(below.render(80), ["moved"]);

  const cleared = widgetEvent(3, "jobs");
  above.apply(cleared);
  below.apply(cleared);
  assert.deepEqual(below.render(80), []);
});

test("extension widget surface clamps stale Worker lines after a live terminal shrink", () => {
  let reportedWidth = 0;
  const surface = new ExtensionWidgetSurface("aboveEditor", (width) => { reportedWidth = width; });
  surface.apply(widgetEvent(1, "async-jobs", [
    ` async subagent parallel · background${" ".repeat(283)}`,
    ` ◦ parallel · 0/1 done · 0ms${" ".repeat(292)}`,
  ], "aboveEditor"));

  const narrowed = surface.render(252);
  assert.equal(reportedWidth, 252);
  assert.deepEqual(narrowed.map(visibleWidth), [252, 252]);
});
