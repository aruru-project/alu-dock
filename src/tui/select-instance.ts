import {
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  type SelectItem,
} from "@earendil-works/pi-tui";

import { humanInstanceStatus } from "../core/instance-display-name.js";
import type { InstanceSnapshot } from "../core/managed-instance.js";
import { paint, selectListTheme } from "./theme.js";

const NEW_INSTANCE = "__new__";

export async function selectInstance(
  instances: InstanceSnapshot[],
): Promise<InstanceSnapshot | "new" | undefined> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  const items: SelectItem[] = [
    ...instances.map((instance) => ({
      value: instance.id,
      label: instance.displayName,
      description: `${humanInstanceStatus(instance.lifecycle, instance.execution)}${instance.reopenable && instance.lifecycle !== "active" ? " · saved session available" : ""} · ${instance.executor.model?.id ?? "no model selected"}`,
    })),
    { value: NEW_INSTANCE, label: "+ New work", description: "start in this directory" },
  ];
  const list = new SelectList(items, Math.min(items.length, 10), selectListTheme);
  const heading = new Text(
    `${paint.bold(paint.accent("Alu Dock"))}\n${paint.muted("Choose work to open, or start new work")}`,
    1,
    1,
  );
  const hint = new Text(paint.muted("  ↑↓ choose · Enter open · Esc cancel"), 0, 1);

  let resolveSelection!: (selection: InstanceSnapshot | "new" | undefined) => void;
  const selection = new Promise<InstanceSnapshot | "new" | undefined>((resolve) => {
    resolveSelection = resolve;
  });
  list.onSelect = (item) => resolveSelection(item.value === NEW_INSTANCE ? "new" : byId.get(item.value));
  list.onCancel = () => resolveSelection(undefined);

  tui.addChild(heading);
  tui.addChild(list);
  tui.addChild(hint);
  tui.setFocus(list);
  tui.start();
  const result = await selection;
  await terminal.drainInput(200, 30).catch(() => {});
  tui.stop();
  return result;
}
