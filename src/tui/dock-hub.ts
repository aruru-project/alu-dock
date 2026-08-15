import {
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { resolve } from "node:path";

import type { DockClient } from "../control/dock-client.js";
import type { InstanceSnapshot, SessionDto } from "../core/managed-instance.js";
import { AluHubBrand } from "./alu-mascot.js";
import { mouseTrackingSequences, parseTerminalMouseEvent } from "./mouse-input.js";
import { paint, selectListTheme } from "./theme.js";

const NEW_INSTANCE = "hub:new";
const CONTINUE = "hub:continue";
const HISTORY = "hub:history";
const SESSION_INVENTORY = "hub:sessions";
const EXIT_HUB = "hub:exit";
const MORE_INSTANCES = "hub:instances-more";
const MORE_SESSIONS = "hub:sessions-more";
const BACK = "hub:back";
const MAX_HUB_INSTANCES = 100;
const MAX_HUB_SESSIONS = 200;
const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";

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
  const terminal = new HubProcessTerminal();
  const contextCwd = resolve(cwd);
  let sessions: SessionDto[] = [];
  let sessionTotal = 0;
  let inventoryTruncated = false;
  let inventoryLoaded = false;
  let inventoryWarning: string | undefined;
  let signalRequested = false;
  const onPresentationSignal = (): void => {
    signalRequested = true;
    // A visible menu must stop its TUI before 1049l; between menus there is no
    // TUI owner, so restore the shell immediately even if a Host read is pending.
    if (!terminal.menuActive) terminal.leaveHubPresentation();
  };

  process.on("SIGINT", onPresentationSignal);
  process.on("SIGTERM", onPresentationSignal);
  try {
    terminal.enterHubPresentation();
    while (true) {
      const instances = await client.list("all");
      if (signalRequested) return { kind: "exit" };
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
        terminal,
        "Alu Dock Hub",
        `Project · ${terminalSafe(contextCwd)}`,
        entries,
        "↑↓ choose · Enter open · Esc leave Hub",
      );
      if (signalRequested || !selected || selected === EXIT_HUB) return { kind: "exit" };
      if (selected === NEW_INSTANCE) return { kind: "new" };
      if (selected === CONTINUE) {
        const action = await chooseContinueAction(terminal, client, instances, contextCwd);
        if (signalRequested) return { kind: "exit" };
        if (action) return action;
        continue;
      }
      if (selected === HISTORY) {
        const action = await chooseHistoryAction(terminal, client, instances, contextCwd);
        if (signalRequested) return { kind: "exit" };
        if (action) return action;
        continue;
      }
      if (selected === SESSION_INVENTORY) {
        if (!inventoryLoaded && inventoryWarning === undefined) {
          terminal.write("Loading Pi Sessions…\n");
          try {
            const inventory = await client.sessionInventory(contextCwd, "all");
            sessions = inventory.sessions;
            sessionTotal = inventory.total;
            inventoryTruncated = inventory.truncated;
            inventoryWarning = inventory.incomplete
              ? `Pi session inventory incomplete: ${inventory.diagnostics[0]?.message ?? "one or more saved sessions could not be inspected"}${inventory.diagnosticsTruncated ? " · more diagnostics omitted" : ""}`
              : undefined;
            inventoryLoaded = true;
          } catch (error) {
            inventoryWarning = `Pi session inventory unavailable: ${errorMessage(error)}`;
          }
        }
        if (signalRequested) return { kind: "exit" };
        const sessionAction = await chooseSessionAction(terminal, instances, sessions, contextCwd, sessionTotal, inventoryTruncated, inventoryWarning);
        if (signalRequested) return { kind: "exit" };
        if (sessionAction) return sessionAction;
      }
    }
  } finally {
    terminal.leaveHubPresentation();
    process.off("SIGINT", onPresentationSignal);
    process.off("SIGTERM", onPresentationSignal);
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
  const continuable = instances.filter(isContinuable).length;
  const history = instances.filter(isHistoryRecord).length;
  return [
    { value: NEW_INSTANCE, label: "New", description: `Create a Dock instance in ${terminalSafe(cwd)}` },
    {
      value: CONTINUE,
      label: `Continue · ${continuable}`,
      description: continuable > 0 ? "Open current Dock work" : "No current Dock work",
    },
    {
      value: HISTORY,
      label: `History · ${history}`,
      description: history > 0 ? "Open or forget past Dock records" : "No Dock history",
    },
    {
      value: SESSION_INVENTORY,
      label: inventoryLoaded
        ? `Pi Sessions · ${inventoryTruncated ? `${sessions.length} of ${sessionTotal}` : sessions.length}`
        : "Pi Sessions",
      description: inventoryWarning ?? `Browse all saved Pi sessions${inventoryTruncated ? " · more available" : ""}`,
    },
    { value: EXIT_HUB, label: "Leave Hub", description: "Return to the shell" },
  ];
}

export function instanceActionSummary(instance: InstanceSnapshot): string {
  if (instance.lifecycle === "active") return "Open or Stop";
  if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) return "Recover or Forget";
  if (instance.lifecycle === "stopping") return "stop in progress; Open unavailable";
  if (instance.lifecycle === "stopped") return "History record";
  return "runtime unavailable; Forget only";
}

async function chooseContinueAction(
  terminal: HubProcessTerminal,
  client: DockClient,
  instances: readonly InstanceSnapshot[],
  cwd: string,
): Promise<DockHubAction | undefined> {
  const ordered = instances.filter(isContinuable).sort((left, right) => compareHubInstances(left, right, cwd));
  const visible = ordered.slice(0, MAX_HUB_INSTANCES);
  const entries: DockHubEntry[] = visible.map((instance) => ({
    value: `instance:${instance.id}`,
    label: `${stateIcon(instance)} ${displayName(instance)}`,
    description: `${terminalSafe(instance.cwd)} · ${instance.lifecycle}/${instance.execution} · ${instanceActionSummary(instance)}`,
  }));
  if (ordered.length > visible.length) {
    entries.push({
      value: MORE_INSTANCES,
      label: `… ${ordered.length - visible.length} more current Dock instance(s)`,
      description: "Use aludock list to inspect the full catalog",
    });
  }
  entries.push({ value: BACK, label: "Back to Hub", description: "no change" });
  const selected = await selectMenu(
    terminal,
    "Continue",
    ordered.length > 0 ? "Current Dock work" : "No active or reopenable Dock instances",
    entries,
    "↑↓ choose · Enter actions · Esc back",
  );
  if (!selected || selected === BACK || selected === MORE_INSTANCES) return undefined;
  const instance = instances.find((candidate) => candidate.id === selected.slice("instance:".length));
  return instance ? chooseInstanceAction(terminal, client, instance) : undefined;
}

async function chooseHistoryAction(
  terminal: HubProcessTerminal,
  client: DockClient,
  instances: readonly InstanceSnapshot[],
  cwd: string,
): Promise<DockHubAction | undefined> {
  const ordered = instances
    .filter(isHistoryRecord)
    .sort((left, right) => compareHistory(left, right, cwd));
  const visible = ordered.slice(0, MAX_HUB_INSTANCES);
  const entries: DockHubEntry[] = visible.map((instance) => ({
    value: `history:${instance.id}`,
    label: displayName(instance),
    description: `${terminalSafe(instance.cwd)} · ${instance.lifecycle} · ${instance.executor.sessionFile ? "saved Pi session" : "no saved Pi session"} · ${instance.updatedAt}`,
  }));
  if (ordered.length > visible.length) {
    entries.push({
      value: MORE_INSTANCES,
      label: `… ${ordered.length - visible.length} more history record(s)`,
      description: "Use aludock list --all to inspect the full catalog",
    });
  }
  entries.push({ value: BACK, label: "Back to Hub", description: "no change" });
  const selected = await selectMenu(
    terminal,
    "History",
    ordered.length > 0 ? "Past Dock records" : "No Dock history",
    entries,
    "↑↓ choose · Enter open · Esc back",
  );
  if (!selected || selected === BACK || selected === MORE_INSTANCES) return undefined;
  const record = instances.find((candidate) => candidate.id === selected.slice("history:".length));
  return record ? chooseHistoryRecordAction(terminal, client, record, instances) : undefined;
}

async function chooseHistoryRecordAction(
  terminal: HubProcessTerminal,
  client: DockClient,
  record: InstanceSnapshot,
  instances: readonly InstanceSnapshot[],
): Promise<DockHubAction | undefined> {
  const sessionFile = record.lifecycle === "stopped" ? record.executor.sessionFile : undefined;
  const linked = sessionFile
    ? instances
      .filter((candidate) => candidate.id !== record.id && candidate.executor.sessionFile === sessionFile && isContinuable(candidate))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    : [];
  const current = linked[0];
  const entries: DockHubEntry[] = [];
  if (sessionFile) {
    entries.push({
      value: "continue",
      label: current ? "Continue current Dock instance" : "Continue saved session",
      description: current
        ? "This Pi session already has current Dock work"
        : "Open the saved Pi session in a new Dock instance",
    });
  }
  entries.push({
    value: "forget",
    label: "Forget history record",
    description: "Remove this Dock history entry; keep the Pi session file",
  });
  entries.push({ value: BACK, label: "Back to History", description: "no change" });
  const selected = await selectMenu(
    terminal,
    displayName(record),
    `${terminalSafe(record.cwd)} · ${record.lifecycle}`,
    entries,
    "↑↓ choose · Enter confirm · Esc back",
  );
  if (!selected || selected === BACK) return undefined;
  if (selected === "forget") {
    await client.forget(record.id);
    terminal.write(`Forgot History record ${displayName(record)}; Pi session files were not deleted.\n`);
    return undefined;
  }

  if (!sessionFile) return undefined;
  if (current?.lifecycle === "active") return { kind: "attach", instance: current };
  if (current) return { kind: "reopen", instance: current };
  return {
    kind: "adopt",
    session: {
      sessionId: record.executor.piSessionId,
      sessionFile,
      name: record.name,
      cwd: record.cwd,
      updatedAt: record.updatedAt,
    },
  };
}

async function chooseInstanceAction(
  terminal: HubProcessTerminal,
  client: DockClient,
  instance: InstanceSnapshot,
): Promise<DockHubAction | undefined> {
  const entries: DockHubEntry[] = [];
  if (instance.lifecycle === "active") {
    entries.push({ value: "attach", label: "Open Work", description: "view and continue this work here" });
    entries.push({ value: "stop", label: "Stop work", description: "stop the running work; closing this window does not stop it" });
  } else if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) {
    entries.push({ value: "reopen", label: "Recover saved work", description: "continue from its saved context without resending messages" });
    entries.push({ value: "forget", label: "Forget Dock record", description: "keep the Pi session file" });
  }
  entries.push({ value: BACK, label: "Back to Continue", description: "no change" });
  const selected = await selectMenu(
    terminal,
    displayName(instance),
    `${instance.lifecycle}/${instance.execution} · ${terminalSafe(instance.cwd)}`,
    entries,
    "↑↓ choose · Enter confirm · Esc back",
  );
  if (!selected || selected === BACK) return undefined;
  if (selected === "attach") return { kind: "attach", instance };
  if (selected === "reopen") return { kind: "reopen", instance };
  if (selected === "stop") {
    const stopped = await client.stop(instance.id);
    terminal.write(`Stopped ${displayName(stopped.instance)}.\n`);
    return undefined;
  }
  if (selected === "forget") {
    await client.forget(instance.id);
    terminal.write(`Forgot Dock record ${displayName(instance)}; Pi session files were not deleted.\n`);
  }
  return undefined;
}

async function chooseSessionAction(
  terminal: HubProcessTerminal,
  instances: readonly InstanceSnapshot[],
  sessions: readonly SessionDto[],
  cwd: string,
  total: number,
  truncated: boolean,
  warning?: string,
): Promise<DockHubAction | undefined> {
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
    entries.push({ value: MORE_SESSIONS, label: `… ${omitted} more persisted session(s)`, description: "older entries are not shown here" });
  }
  entries.push({ value: BACK, label: "Back to Hub", description: "no change" });
  const selected = await selectMenu(
    terminal,
    "Pi Sessions",
    warning ? terminalSafe(warning) : sessions.length > 0 ? "Choose a saved session" : "No persisted Pi sessions found",
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
      actionEntries.push({ value: `attach:${instance.id}`, label: `Open ${displayName(instance)}`, description: "this work is already running in Alu Dock" });
    } else if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) {
      actionEntries.push({ value: `resume:${instance.id}`, label: `Resume ${displayName(instance)}`, description: "recover this Dock work from its saved context" });
    }
  }
  const hasLiveReference = linked.some((instance) => instance.lifecycle === "active" || instance.lifecycle === "stopping");
  if (!hasLiveReference) {
    actionEntries.push({ value: "adopt", label: "Adopt as a new Dock instance", description: "create a Dock identity around this persisted Pi session" });
  }
  actionEntries.push({ value: BACK, label: "Back to Pi Sessions", description: "no change" });
  const action = await selectMenu(
    terminal,
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
  terminal: HubProcessTerminal,
  title: string,
  subtitle: string,
  entries: readonly DockHubEntry[],
  hint: string,
): Promise<string | undefined> {
  const tui = new TUI(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const items: SelectItem[] = entries.map((entry) => ({
    value: entry.value,
    label: terminalSafe(entry.label),
    description: terminalSafe(entry.description),
  }));
  const maxVisible = Math.min(Math.max(items.length, 1), 12);
  const list = new SelectList(items, maxVisible, selectListTheme);
  const heading = new Text(`${paint.bold(paint.accent(terminalSafe(title)))}\n${paint.muted(terminalSafe(subtitle))}`, 1, 0);
  const footer = new Text(paint.muted(`  ${terminalSafe(hint)}`), 0, 0);
  const brand = new AluHubBrand();
  const selectedIndex = (): number => {
    const selected = list.getSelectedItem();
    return selected ? items.findIndex((item) => item.value === selected.value) : 0;
  };
  const layout = new HubMenuLayout(
    brand,
    heading,
    list,
    footer,
    () => terminal.rows,
    () => visibleHubItemIndices(items.length, maxVisible, selectedIndex()),
  );
  let settled = false;
  let started = false;
  let signalReceived = false;
  let resolveSelection!: (selection: string | undefined) => void;
  const selection = new Promise<string | undefined>((resolveSelectionPromise) => { resolveSelection = resolveSelectionPromise; });
  const finish = (value: string | undefined): void => {
    if (settled) return;
    settled = true;
    resolveSelection(value);
  };
  const onSignal = (): void => {
    signalReceived = true;
    finish(undefined);
  };
  list.onSelect = (item) => finish(item.value);
  list.onCancel = () => finish(undefined);
  const removeMouseListener = tui.addInputListener((data) => {
    const event = parseTerminalMouseEvent(data);
    if (!event) return undefined;
    if (event.kind === "wheel") {
      list.handleInput(event.direction === "up" ? "\u001b[A" : "\u001b[B");
      tui.requestRender();
      return { consume: true };
    }
    const index = layout.hitTest(event.x, event.y);
    if (index !== undefined) {
      list.setSelectedIndex(index);
      list.handleInput("\r");
    }
    return { consume: true };
  });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  tui.addChild(layout);
  tui.setFocus(list);
  const blink = new HubBlinkController(brand, () => tui.requestRender());
  try {
    terminal.clearScreen();
    tui.start();
    started = true;
    blink.start();
    return await selection;
  } finally {
    blink.stop();
    removeMouseListener();
    if (started && !signalReceived) await terminal.drainInput(200, 30).catch(() => {});
    // Keep cursor/raw-mode cleanup inside the alternate screen. The outer Hub
    // owner emits 1049l only after this menu promise settles.
    tui.stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export class HubProcessTerminal extends ProcessTerminal {
  private presentationActive = false;
  private mouseActive = false;

  get menuActive(): boolean { return this.mouseActive; }

  enterHubPresentation(): void {
    if (this.presentationActive) return;
    this.presentationActive = true;
    this.write(ENTER_ALTERNATE_SCREEN);
  }

  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start(onInput, onResize);
    if (!this.mouseActive) {
      this.mouseActive = true;
      this.write(mouseTrackingSequences().enable);
    }
  }

  override stop(): void {
    if (this.mouseActive) {
      this.mouseActive = false;
      this.write(mouseTrackingSequences().disable);
    }
    super.stop();
  }

  leaveHubPresentation(): void {
    if (!this.presentationActive) return;
    this.presentationActive = false;
    this.mouseActive = false;
    this.write(`${mouseTrackingSequences().disable}${LEAVE_ALTERNATE_SCREEN}`);
  }
}

export function visibleHubItemIndices(itemCount: number, maxVisible: number, selectedIndex: number): number[] {
  if (itemCount <= 0 || maxVisible <= 0) return [];
  const boundedVisible = Math.min(itemCount, Math.max(1, Math.floor(maxVisible)));
  const boundedSelected = Math.max(0, Math.min(Math.floor(selectedIndex), itemCount - 1));
  const start = Math.max(0, Math.min(boundedSelected - Math.floor(boundedVisible / 2), itemCount - boundedVisible));
  return Array.from({ length: boundedVisible }, (_, offset) => start + offset);
}

interface HubHitbox {
  index: number;
  xMin: number;
  xMax: number;
  y: number;
}

export class HubMenuLayout implements Component {
  private hitboxes: HubHitbox[] = [];

  constructor(
    private readonly brand: AluHubBrand,
    private readonly heading: Component,
    private readonly list: Component,
    private readonly footer: Component,
    private readonly getRows: () => number = () => 1,
    private readonly getVisibleItemIndices: () => readonly number[] = () => [],
  ) {}

  hitTest(x: number, y: number): number | undefined {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined;
    return this.hitboxes.find((hitbox) => hitbox.y === y && x >= hitbox.xMin && x <= hitbox.xMax)?.index;
  }

  render(width: number): string[] {
    const boundedWidth = Math.max(1, Math.floor(width));
    const height = Math.max(1, Math.floor(this.getRows()));
    const compact = boundedWidth < 64;
    let content: string[];
    let listStart: number;
    let listXMin: number;

    if (compact) {
      const brand = this.brand.renderCompact(boundedWidth);
      const heading = this.heading.render(boundedWidth);
      const list = this.list.render(boundedWidth);
      content = [...brand, ...heading, ...list, ...this.footer.render(boundedWidth)];
      listStart = brand.length + heading.length;
      listXMin = 1;
    } else {
      const mascotWidth = 22;
      const gutter = 2;
      const panelWidth = Math.max(1, boundedWidth - mascotWidth - gutter);
      const mascot = this.brand.renderLarge(mascotWidth);
      const heading = this.heading.render(panelWidth);
      const list = this.list.render(panelWidth);
      const panel = [...heading, ...list, ...this.footer.render(panelWidth)];
      const contentRows = Math.max(mascot.length, panel.length);
      content = Array.from({ length: contentRows }, (_, index) => {
        const left = truncateToWidth(mascot[index] ?? "", mascotWidth);
        const padded = `${left}${" ".repeat(Math.max(0, mascotWidth - visibleWidth(left)))}`;
        return truncateToWidth(`${padded}${" ".repeat(gutter)}${panel[index] ?? ""}`, boundedWidth);
      });
      listStart = heading.length;
      listXMin = mascotWidth + gutter + 1;
    }

    const topPadding = Math.max(0, Math.floor((height - content.length) / 2));
    const visibleContent = content.slice(0, Math.max(0, height - topPadding));
    const lines = [
      ...Array.from({ length: topPadding }, () => ""),
      ...visibleContent,
    ];
    while (lines.length < height) lines.push("");

    this.hitboxes = this.getVisibleItemIndices().flatMap((index, offset) => {
      const row = topPadding + listStart + offset;
      return row >= 0 && row < visibleContent.length + topPadding
        ? [{ index, xMin: listXMin, xMax: boundedWidth, y: row + 1 }]
        : [];
    });
    return lines.map((line) => truncateToWidth(line, boundedWidth));
  }

  invalidate(): void {
    this.brand.invalidate();
    this.heading.invalidate();
    this.list.invalidate();
    this.footer.invalidate();
  }
}

interface HubBlinkScheduler {
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

/** Exactly one client-local timer, owned only while a Hub menu is visible. */
export class HubBlinkController {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private closed = false;

  constructor(
    private readonly brand: AluHubBrand,
    private readonly requestRender: () => void,
    private readonly scheduler: HubBlinkScheduler = {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  ) {}

  get active(): boolean { return this.timer !== undefined; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.closed = false;
    this.schedule(3_600);
  }

  stop(): void {
    this.running = false;
    this.closed = false;
    this.brand.setBlink(false);
    if (this.timer) this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;
      this.closed = !this.closed;
      this.brand.setBlink(this.closed);
      this.requestRender();
      this.schedule(this.closed ? 160 : 4_200);
    }, delayMs);
    this.timer.unref?.();
  }
}

function isContinuable(instance: InstanceSnapshot): boolean {
  return instance.lifecycle === "active"
    || ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable);
}

function isHistoryRecord(instance: InstanceSnapshot): boolean {
  return instance.lifecycle === "stopped"
    || ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && !instance.reopenable);
}

function compareHubInstances(left: InstanceSnapshot, right: InstanceSnapshot, cwd: string): number {
  const leftProject = resolve(left.cwd) === resolve(cwd) ? 0 : 1;
  const rightProject = resolve(right.cwd) === resolve(cwd) ? 0 : 1;
  return leftProject - rightProject
    || instancePriority(left) - instancePriority(right)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function compareHistory(left: InstanceSnapshot, right: InstanceSnapshot, cwd: string): number {
  const leftProject = resolve(left.cwd) === resolve(cwd) ? 0 : 1;
  const rightProject = resolve(right.cwd) === resolve(cwd) ? 0 : 1;
  return leftProject - rightProject
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function instancePriority(instance: InstanceSnapshot): number {
  if (instance.lifecycle === "active" && instance.execution === "running") return 0;
  if (instance.lifecycle === "active") return 1;
  return 2;
}

function compareSessions(left: SessionDto, right: SessionDto, cwd: string): number {
  const project = Number(resolve(right.cwd) === resolve(cwd)) - Number(resolve(left.cwd) === resolve(cwd));
  return project || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.sessionFile.localeCompare(right.sessionFile);
}

function stateIcon(instance: InstanceSnapshot): string {
  if (instance.lifecycle === "active" && instance.execution === "running") return "◆";
  if (instance.lifecycle === "active") return "●";
  return "↻";
}

function terminalSafe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim() || "—";
}

function displayName(instance: InstanceSnapshot): string {
  return instance.displayName;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
