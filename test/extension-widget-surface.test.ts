import assert from "node:assert/strict";
import test from "node:test";

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
