import {
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { resolve } from "node:path";

import type { DockClient } from "../control/dock-client.js";
import type { InstanceSnapshot, SessionDto } from "../core/managed-instance.js";
import { uniqueInstanceIdPrefix } from "../human-target.js";
import { paint, selectListTheme } from "./theme.js";

const NEW_INSTANCE = "hub:new";
const SESSION_INVENTORY = "hub:sessions";
const EXIT_HUB = "hub:exit";
const MORE_SESSIONS = "hub:sessions-more";
const BACK = "hub:back";
const MAX_HUB_INSTANCES = 100;
const MAX_HUB_SESSIONS = 200;

export type DockHubAction =
  | { kind: "attach"; instance: InstanceSnapshot }
  | { kind: "reopen"; instance: InstanceSnapshot }
  | { kind: "new" }
  | { kind: "adopt"; session: SessionDto }
  | { kind: "exit" };

export interface DockHubEntry {
  value: string;
  label: string;
  description: string;
}

/** Read-only construction: entering the Hub lists state but never creates a runtime. */
export async function runDockHub(client: DockClient, cwd: string): Promise<DockHubAction> {
  const contextCwd = resolve(cwd);
  let sessions: SessionDto[] = [];
  let sessionTotal = 0;
  let inventoryTruncated = false;
  let inventoryLoaded = false;
  let inventoryWarning: string | undefined;
  while (true) {
    const instances = await client.list("all");
    const entries = buildDockHubEntries(
      instances,
      sessions,
      contextCwd,
      inventoryWarning,
      sessionTotal,
      inventoryTruncated,
      inventoryLoaded,
    );
    const selected = await selectMenu(
      "Alu Dock Hub",
      `Project · ${terminalSafe(contextCwd)}`,
      entries,
      "↑↓ choose · Enter actions · Esc leave Hub",
    );
    if (!selected || selected === EXIT_HUB) return { kind: "exit" };
    if (selected === NEW_INSTANCE) return { kind: "new" };
    if (selected === SESSION_INVENTORY) {
      if (!inventoryLoaded && inventoryWarning === undefined) {
        process.stdout.write("Loading Pi Sessions…\n");
        try {
          const inventory = await client.sessionInventory(contextCwd, "all");
          sessions = inventory.sessions;
          sessionTotal = inventory.total;
          inventoryTruncated = inventory.truncated;
          inventoryLoaded = true;
        } catch (error) {
          inventoryWarning = `Pi session inventory unavailable: ${errorMessage(error)}`;
        }
      }
      const sessionAction = await chooseSessionAction(instances, sessions, contextCwd, sessionTotal, inventoryTruncated);
      if (sessionAction) return sessionAction;
      continue;
    }
    if (selected.startsWith("instance:")) {
      const instance = instances.find((candidate) => candidate.id === selected.slice("instance:".length));
      if (!instance) continue;
      const action = await chooseInstanceAction(client, instance, instances);
      if (action) return action;
    }
  }
}

export function buildDockHubEntries(
  instances: readonly InstanceSnapshot[],
  sessions: readonly SessionDto[],
  cwd: string,
  inventoryWarning?: string,
  sessionTotal = sessions.length,
  inventoryTruncated = false,
  inventoryLoaded = true,
): DockHubEntry[] {
  const ordered = [...instances].sort((left, right) => compareHubInstances(left, right, cwd));
  const visible = ordered.slice(0, MAX_HUB_INSTANCES);
  const entries: DockHubEntry[] = visible.map((instance) => ({
    value: `instance:${instance.id}`,
    label: `${stateIcon(instance)} ${terminalSafe(instance.name || "(unnamed)")} [${uniqueInstanceIdPrefix(instance, instances)}]`,
    description: `${terminalSafe(instance.cwd)} · ${instance.lifecycle}/${instance.execution} · ${instanceActionSummary(instance)}`,
  }));
  if (instances.length > visible.length) {
    entries.push({
      value: "hub:catalog-more",
      label: `… ${instances.length - visible.length} older Dock record(s)`,
      description: "Use alu-dock list --all to inspect the bounded human catalog",
    });
  }
  entries.push({ value: NEW_INSTANCE, label: "+ New Dock instance", description: `Create in ${terminalSafe(cwd)}` });
  entries.push({
    value: SESSION_INVENTORY,
    label: inventoryLoaded
      ? `Pi Sessions · ${inventoryTruncated ? `${sessions.length} of ${sessionTotal}` : sessions.length}`
      : "Pi Sessions",
    description: inventoryWarning ?? `Browse saved sessions · Resume or Adopt${inventoryTruncated ? " · more available" : ""}`,
  });
  entries.push({ value: EXIT_HUB, label: "Leave Hub", description: "Return to the shell" });
  return entries;
}

export function instanceActionSummary(instance: InstanceSnapshot): string {
  if (instance.lifecycle === "active") return "Attach or Stop";
  if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) return "Reopen or Forget";
  if (instance.lifecycle === "stopping") return "stop in progress; Attach unavailable";
  if (instance.lifecycle === "stopped") return "stopped history; Attach unavailable";
  return "runtime unavailable; Forget only";
}

async function chooseInstanceAction(
  client: DockClient,
  instance: InstanceSnapshot,
  universe: readonly InstanceSnapshot[],
): Promise<DockHubAction | undefined> {
  const shortId = uniqueInstanceIdPrefix(instance, universe);
  const entries: DockHubEntry[] = [];
  if (instance.lifecycle === "active") {
    entries.push({ value: "attach", label: "Attach Session Work", description: "connect this client; Host keeps runtime ownership" });
    entries.push({ value: "stop", label: "Stop instance", description: "dispose the live runtime; this is not detach" });
  } else if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) {
    entries.push({ value: "reopen", label: "Reopen persisted context", description: "start a fresh runtime generation with no prompt/effect replay" });
    entries.push({ value: "forget", label: "Forget Dock record", description: "keep the Pi session file" });
  } else if (instance.lifecycle !== "stopping") {
    entries.push({ value: "forget", label: "Forget Dock record", description: "remove only this terminal catalog record" });
  }
  entries.push({ value: BACK, label: "Back to Dock instances", description: "no change" });
  const selected = await selectMenu(
    `${terminalSafe(instance.name || "Dock instance")} [${shortId}]`,
    `${instance.lifecycle}/${instance.execution} · ${terminalSafe(instance.cwd)}`,
    entries,
    "↑↓ choose · Enter confirm · Esc back",
  );
  if (!selected || selected === BACK) return undefined;
  if (selected === "attach") return { kind: "attach", instance };
  if (selected === "reopen") return { kind: "reopen", instance };
  if (selected === "stop") {
    const stopped = await client.stop(instance.id);
    process.stdout.write(`Stopped ${displayName(stopped.instance)}.\n`);
    return undefined;
  }
  if (selected === "forget") {
    await client.forget(instance.id);
    process.stdout.write(`Forgot Dock record ${shortId}; Pi session files were not deleted.\n`);
  }
  return undefined;
}

async function chooseSessionAction(
  instances: readonly InstanceSnapshot[],
  sessions: readonly SessionDto[],
  cwd: string,
  total: number,
  truncated: boolean,
): Promise<DockHubAction | undefined> {
  if (sessions.length === 0) return undefined;
  const ordered = [...sessions].sort((left, right) => compareSessions(left, right, cwd));
  const byFile = new Map(ordered.map((session) => [session.sessionFile, session]));
  const visible = ordered.slice(0, MAX_HUB_SESSIONS);
  const entries: DockHubEntry[] = visible.map((session) => ({
    value: `session:${session.sessionFile}`,
    label: terminalSafe(session.name || session.sessionId),
    description: `${resolve(session.cwd) === resolve(cwd) ? "current project · " : ""}${terminalSafe(session.cwd)} · ${session.updatedAt ?? "unknown time"}`,
  }));
  const omitted = Math.max(0, total - visible.length);
  if (omitted > 0 || truncated) {
    entries.push({ value: MORE_SESSIONS, label: `… ${omitted} more persisted session(s)`, description: "older entries are omitted from this bounded Hub view" });
  }
  entries.push({ value: BACK, label: "Back to Dock instances", description: "no change" });
  const selected = await selectMenu(
    "Pi Sessions",
    "Choose a saved session",
    entries,
    "↑↓ choose · Enter Resume/Adopt · Esc back",
  );
  if (!selected || selected === BACK || selected === MORE_SESSIONS) return undefined;
  const session = byFile.get(selected.slice("session:".length));
  if (!session) return undefined;

  const linked = instances.filter((instance) => instance.executor.sessionFile === session.sessionFile);
  const actionEntries: DockHubEntry[] = [];
  for (const instance of linked) {
    if (instance.lifecycle === "active") {
      actionEntries.push({ value: `attach:${instance.id}`, label: `Attach ${displayName(instance)}`, description: "this Pi session already has a live Dock runtime" });
    } else if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) {
      actionEntries.push({ value: `resume:${instance.id}`, label: `Resume ${displayName(instance)}`, description: "reopen its Dock identity with a new runtime generation" });
    }
  }
  const hasLiveReference = linked.some((instance) => instance.lifecycle === "active" || instance.lifecycle === "stopping");
  if (!hasLiveReference) {
    actionEntries.push({ value: "adopt", label: "Adopt as a new Dock instance", description: "create a Dock identity around this persisted Pi session" });
  }
  actionEntries.push({ value: BACK, label: "Back to Pi Sessions", description: "no change" });
  const action = await selectMenu(
    terminalSafe(session.name || session.sessionId),
    terminalSafe(session.sessionFile),
    actionEntries,
    "↑↓ choose · Enter open · Esc back",
  );
  if (!action || action === BACK) return undefined;
  if (action === "adopt") return { kind: "adopt", session };
  const separator = action.indexOf(":");
  const instance = instances.find((candidate) => candidate.id === action.slice(separator + 1));
  if (!instance) return undefined;
  return action.startsWith("attach:") ? { kind: "attach", instance } : { kind: "reopen", instance };
}

async function selectMenu(
  title: string,
  subtitle: string,
  entries: readonly DockHubEntry[],
  hint: string,
): Promise<string | undefined> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const items: SelectItem[] = entries.map((entry) => ({
    value: entry.value,
    label: terminalSafe(entry.label),
    description: terminalSafe(entry.description),
  }));
  const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), selectListTheme);
  const heading = new Text(`${paint.bold(paint.accent(terminalSafe(title)))}\n${paint.muted(terminalSafe(subtitle))}`, 1, 1);
  const footer = new Text(paint.muted(`  ${terminalSafe(hint)}`), 0, 1);
  let settled = false;
  let resolveSelection!: (selection: string | undefined) => void;
  const selection = new Promise<string | undefined>((resolveSelectionPromise) => { resolveSelection = resolveSelectionPromise; });
  const finish = (value: string | undefined): void => {
    if (settled) return;
    settled = true;
    resolveSelection(value);
  };
  const onSignal = (): void => finish(undefined);
  list.onSelect = (item) => finish(item.value);
  list.onCancel = () => finish(undefined);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  tui.addChild(heading);
  tui.addChild(list);
  tui.addChild(footer);
  tui.setFocus(list);
  tui.start();
  try {
    return await selection;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await terminal.drainInput(200, 30).catch(() => {});
    tui.stop();
  }
}

function compareHubInstances(left: InstanceSnapshot, right: InstanceSnapshot, cwd: string): number {
  const leftProject = resolve(left.cwd) === resolve(cwd) ? 0 : 1;
  const rightProject = resolve(right.cwd) === resolve(cwd) ? 0 : 1;
  return leftProject - rightProject
    || instancePriority(left) - instancePriority(right)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function instancePriority(instance: InstanceSnapshot): number {
  if (instance.lifecycle === "active" && instance.execution === "running") return 0;
  if (instance.lifecycle === "active") return 1;
  if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) return 2;
  if (instance.lifecycle === "stopping") return 3;
  if (instance.lifecycle === "stopped") return 5;
  return 4;
}

function compareSessions(left: SessionDto, right: SessionDto, cwd: string): number {
  const project = Number(resolve(right.cwd) === resolve(cwd)) - Number(resolve(left.cwd) === resolve(cwd));
  return project || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.sessionFile.localeCompare(right.sessionFile);
}

function stateIcon(instance: InstanceSnapshot): string {
  if (instance.lifecycle === "active" && instance.execution === "running") return "◆";
  if (instance.lifecycle === "active") return "●";
  if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) return "↻";
  if (instance.lifecycle === "stopping") return "◇";
  if (instance.lifecycle === "stopped") return "○";
  return "!";
}

function terminalSafe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim() || "—";
}

function displayName(instance: InstanceSnapshot): string {
  return instance.name ? `${terminalSafe(instance.name)} (${instance.id.slice(0, 8)})` : instance.id.slice(0, 8);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
