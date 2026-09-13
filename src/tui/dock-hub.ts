import { chooseSystem, type SystemChoice } from "./system-picker.js";
import {
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

import type { DockClient } from "../control/dock-client.js";
import type { AttachmentStorageSettings, AttachmentStorageState } from "../control/attachment-storage-state.js";
import type {
  PairingProgress,
  PairingWindow,
  PendingPairing,
  RemoteAccessSettings,
  RemoteAccessState,
  RemoteAccessStatus,
  TrustedClient,
} from "../control/remote-access-state.js";
import { MainMachineState, SubHostMachineState, readMachineJoinFile, writeMachineJoinFile } from "../control/machine-state.js";
import { MachineSettingsState, machineListenerConfiguration, sameMachineListenerConfiguration, type MachineListenerStatus, type MachineSettings, type SubHostConnectionSettings } from "../control/machine-settings-state.js";
import type { MachineDto } from "../control/protocol.js";
import type { InstanceSnapshot, SessionDto } from "../core/managed-instance.js";
import type { PiEnvironmentSnapshot, PiLoginInteraction } from "../pi/pi-environment.js";
import { humanInstanceStatus } from "../core/instance-display-name.js";
import { humanRelativeTime } from "../human-time.js";
import { sessionDisplayName } from "../session-display.js";
import { AluHubBrand } from "./alu-mascot.js";
import { ExtensionTextDialog } from "./extension-text-dialog.js";
import { mouseTrackingSequences, parseTerminalMouseEvent } from "./mouse-input.js";
import { paint, selectListTheme } from "./theme.js";
import {
  collectWorkspaceDirectory,
  workspaceBrowserErrorMessage,
  WorkspaceBrowserSurface,
} from "./workspace-browser.js";

const NEW_INSTANCE = "hub:new";
const CONTINUE = "hub:continue";
const HISTORY = "hub:history";
const SESSION_INVENTORY = "hub:sessions";
const SETTINGS = "hub:settings";
const DEVICES = "hub:devices";
const MACHINES = "hub:machines";
const EXIT_HUB = "hub:exit";
const MORE_INSTANCES = "hub:instances-more";
const MORE_SESSIONS = "hub:sessions-more";
const BACK = "hub:back";
const MAX_HUB_INSTANCES = 100;
const MAX_HUB_SESSIONS = 200;
const LISTENER_READY_TIMEOUT_MS = 8_000;
const LISTENER_STATUS_POLL_MS = 100;
const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";

export type DockHubAction =
  | { kind: "attach"; instance: InstanceSnapshot }
  | { kind: "reopen"; instance: InstanceSnapshot }
  | { kind: "new"; cwd: string; systemChoice: SystemChoice }
  | { kind: "adopt"; session: SessionDto }
  | { kind: "exit" };

export interface DockHubEntry {
  value: string;
  label: string;
  description: string;
}

/** Read-only construction: entering the Hub lists state but never creates a runtime. */
export async function runDockHub(
  client: DockClient,
  cwd: string,
  remoteAccessState: RemoteAccessState,
  attachmentStorageState: AttachmentStorageState,
  machineSettingsState: MachineSettingsState,
  mainMachineState: MainMachineState,
  subHostMachineState: SubHostMachineState,
): Promise<DockHubAction> {
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
      const [instances, machines] = await Promise.all([
        client.list("all"),
        client.machines().then((result) => result.machines).catch(() => [] as MachineDto[]),
      ]);
      if (signalRequested) return { kind: "exit" };
      const entries = buildDockHubEntries(
        instances,
        sessions,
        contextCwd,
        inventoryWarning,
        sessionTotal,
        inventoryTruncated,
        inventoryLoaded,
        machines,
      );
      const selected = await selectMenu(
        terminal,
        "Alu Dock Hub",
        `Project · ${terminalSafe(contextCwd)}`,
        entries,
        "↑↓ choose · Enter open · Esc leave Hub",
      );
      if (signalRequested || !selected || selected === EXIT_HUB) return { kind: "exit" };
      if (selected === NEW_INSTANCE) {
        const selectedCwd = await chooseWorkspaceDirectory(terminal, client, contextCwd);
        if (signalRequested) return { kind: "exit" };
        if (selectedCwd !== undefined) {
          const systemChoice = await chooseSystem(client, selectedCwd, terminal);
          if (signalRequested) return { kind: "exit" };
          if (systemChoice) return { kind: "new", cwd: systemChoice.cwd, systemChoice };
        }
        continue;
      }
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
              ? "Some saved Pi sessions could not be checked. The sessions shown here are ready to open; check service logs for details."
              : undefined;
            inventoryLoaded = true;
          } catch {
            inventoryWarning = "Saved Pi sessions could not be loaded. Leave the Hub and run `aludock` again; check service logs if the problem continues.";
          }
        }
        if (signalRequested) return { kind: "exit" };
        const sessionAction = await chooseSessionAction(terminal, instances, sessions, contextCwd, sessionTotal, inventoryTruncated, inventoryWarning);
        if (signalRequested) return { kind: "exit" };
        if (sessionAction) return sessionAction;
      }
      if (selected === SETTINGS) {
        await chooseHubSettings(terminal, attachmentStorageState, machineSettingsState, subHostMachineState);
        if (signalRequested) return { kind: "exit" };
      }
      if (selected === DEVICES) {
        await chooseDevicesAction(terminal, remoteAccessState);
        if (signalRequested) return { kind: "exit" };
      }
      if (selected === MACHINES) {
        await chooseMachinesAction(terminal, client, machineSettingsState, mainMachineState);
        if (signalRequested) return { kind: "exit" };
      }
    }
  } finally {
    terminal.leaveHubPresentation();
    process.off("SIGINT", onPresentationSignal);
    process.off("SIGTERM", onPresentationSignal);
  }
}

export async function runSubHostHub(
  machineSettingsState: MachineSettingsState,
  subHostMachineState: SubHostMachineState,
): Promise<void> {
  const terminal = new HubProcessTerminal();
  let signalRequested = false;
  let notice: string | undefined;
  const onSignal = (): void => {
    signalRequested = true;
    if (!terminal.menuActive) terminal.leaveHubPresentation();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    terminal.enterHubPresentation();
    while (!signalRequested) {
      const result = await selectLiveMenu(
        terminal,
        "Alu Dock SubHost",
        async () => {
          const [settings, status] = await Promise.all([
            machineSettingsState.read(),
            machineSettingsState.readSubHostStatus(),
          ]);
          return {
            data: { settings, status },
            subtitle: notice ?? (status.updatedAt
              ? `Last recorded observation (${humanRelativeTime(status.updatedAt)}): ${status.connected ? "connected to Main" : "Main connection unavailable"}`
              : "No Main connection observation has been recorded"),
            entries: [
              { value: "connection", label: "Main connection", description: settings.subhost ? `${terminalSafe(settings.subhost.mainAddress)} · Port ${settings.subhost.port}` : "Connection settings are missing" },
              { value: "pi", label: "Pi", description: "Models and provider access on this computer" },
              { value: "main", label: "Use as Main", description: "Switch roles after the next restart" },
              { value: EXIT_HUB, label: "Leave", description: "Return to the shell" },
            ],
          };
        },
        "↑↓ choose · Enter open · updates automatically",
      );
      if (signalRequested || !result.value || result.value === EXIT_HUB) return;
      notice = undefined;
      if (result.value === "connection") {
        notice = await configureSubHostRole(terminal, machineSettingsState, subHostMachineState, result.data.settings, "manage");
      } else if (result.value === "pi") {
        await choosePiEnvironment(terminal);
      } else if (result.value === "main") {
        const selected = await selectMenu(
          terminal,
          "Use this computer as Main?",
          "The current SubHost keeps running until Alu Dock restarts.",
          [
            { value: "confirm", label: "Use as Main", description: "Apply on the next startup" },
            { value: BACK, label: "Keep SubHost", description: "Leave the role unchanged" },
          ],
          "↑↓ choose · Enter confirm · Esc cancel",
        );
        if (selected === "confirm") {
          await machineSettingsState.switchToMain();
          notice = "This computer will start as Main next time.";
        }
      }
    }
  } finally {
    terminal.leaveHubPresentation();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
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
  machines: readonly MachineDto[] = [],
): DockHubEntry[] {
  const continuable = instances.filter(isContinuable).length;
  const history = instances.filter(isHistoryRecord).length;
  return [
    { value: NEW_INSTANCE, label: "New", description: `Choose a working directory · starts in ${terminalSafe(cwd)}` },
    {
      value: CONTINUE,
      label: `Continue · ${continuable}`,
      description: continuable > 0 ? "Open current Dock work" : "No current Dock work",
    },
    {
      value: HISTORY,
      label: `History · ${history}`,
      description: history > 0 ? "Open or remove past work" : "No past work",
    },
    {
      value: SESSION_INVENTORY,
      label: inventoryLoaded
        ? `Pi Sessions · ${inventoryTruncated ? `${sessions.length} of ${sessionTotal}` : sessions.length}`
        : "Pi Sessions",
      description: inventoryWarning ?? `Browse all saved Pi sessions${inventoryTruncated ? " · more available" : ""}`,
    },
    {
      value: MACHINES,
      label: `Machines · ${machines.filter((machine) => machine.kind === "subhost").length}`,
      description: "Connect and manage SubHosts",
    },
    { value: SETTINGS, label: "Settings", description: "Attachments and Dock role" },
    { value: DEVICES, label: "Devices", description: "Connect and manage remote devices" },
    { value: EXIT_HUB, label: "Leave Hub", description: "Return to the shell" },
  ];
}

export function instanceActionSummary(instance: InstanceSnapshot): string {
  if (instance.lifecycle === "active") return "Open or Stop";
  if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) return "Resume or Remove";
  if (instance.lifecycle === "stopping") return "Finishing · open after it completes";
  if (instance.lifecycle === "stopped") return "Past work";
  return "Unavailable · Remove";
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
    description: `${terminalSafe(instance.cwd)} · ${humanInstanceStatus(instance.lifecycle, instance.execution)} · ${humanRelativeTime(instance.updatedAt)} · ${instanceActionSummary(instance)}`,
  }));
  if (ordered.length > visible.length) {
    entries.push({
      value: MORE_INSTANCES,
      label: `… ${ordered.length - visible.length} more current work item(s)`,
      description: "Use `aludock list` to see all work",
    });
  }
  entries.push({ value: BACK, label: "Back to Hub", description: "Return to the Hub" });
  const selected = await selectMenu(
    terminal,
    "Continue",
    ordered.length > 0 ? "Current Dock work" : "No work is ready to continue",
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
    description: `${terminalSafe(instance.cwd)} · ${humanInstanceStatus(instance.lifecycle, instance.execution)} · ${instance.executor.sessionFile ? "saved Pi session available" : "past work only"} · ${humanRelativeTime(instance.updatedAt)}`,
  }));
  if (ordered.length > visible.length) {
    entries.push({
      value: MORE_INSTANCES,
      label: `… ${ordered.length - visible.length} more past work item(s)`,
      description: "Use `aludock list --all` to see all past work",
    });
  }
  entries.push({ value: BACK, label: "Back to Hub", description: "Return to the Hub" });
  const selected = await selectMenu(
    terminal,
    "History",
    ordered.length > 0 ? "Past work" : "No past work",
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
      label: current ? "Continue current work" : "Continue saved session",
      description: current
        ? "This saved Pi session already has current work"
        : "Open the saved Pi session as new work",
    });
  }
  entries.push({
    value: "forget",
    label: "Remove from History",
    description: "Any saved Pi session and project files stay in place",
  });
  entries.push({ value: BACK, label: "Back to History", description: "Return to past work" });
  const selected = await selectMenu(
    terminal,
    displayName(record),
    `${terminalSafe(record.cwd)} · ${humanInstanceStatus(record.lifecycle, record.execution)}`,
    entries,
    "↑↓ choose · Enter confirm · Esc back",
  );
  if (!selected || selected === BACK) return undefined;
  if (selected === "forget") {
    await client.forget(record.id);
    terminal.write(`Removed ${displayName(record)} from History. Any saved Pi session and project files remain in place.\n`);
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
    entries.push({ value: "stop", label: "Stop work", description: "end this work and remove it from the Dock" });
  } else if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) {
    entries.push({ value: "reopen", label: "Resume saved work", description: "continue from the saved conversation" });
    entries.push({ value: "forget", label: "Remove from Dock", description: "any saved Pi session and project files stay in place" });
  }
  entries.push({ value: BACK, label: "Back to Continue", description: "Return to current work" });
  const selected = await selectMenu(
    terminal,
    displayName(instance),
    `${humanInstanceStatus(instance.lifecycle, instance.execution)} · ${terminalSafe(instance.cwd)}`,
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
    terminal.write(`Removed ${displayName(instance)} from the Dock. Any saved Pi session and project files remain in place.\n`);
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
    label: terminalSafe(sessionDisplayName(session)),
    description: `${resolve(session.cwd) === resolve(cwd) ? "current project · " : ""}${terminalSafe(session.cwd)} · ${humanRelativeTime(session.updatedAt ?? "")}`,
  }));
  const omitted = Math.max(0, total - visible.length);
  if (omitted > 0 || truncated) {
    entries.push({ value: MORE_SESSIONS, label: `… ${omitted} more saved session(s)`, description: "Older sessions are outside this page" });
  }
  entries.push({ value: BACK, label: "Back to Hub", description: "Return to the Hub" });
  const selected = await selectMenu(
    terminal,
    "Pi Sessions",
    warning ? terminalSafe(warning) : sessions.length > 0 ? "Choose a saved session" : "No saved Pi sessions found",
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
      actionEntries.push({ value: `resume:${instance.id}`, label: `Resume ${displayName(instance)}`, description: "continue from the saved conversation" });
    }
  }
  const hasLiveReference = linked.some((instance) => instance.lifecycle === "active" || instance.lifecycle === "stopping");
  if (!hasLiveReference) {
    actionEntries.push({ value: "adopt", label: "Open as new work", description: "start new Dock work from this saved Pi session" });
  }
  actionEntries.push({ value: BACK, label: "Back to Pi Sessions", description: "Return to saved sessions" });
  const action = await selectMenu(
    terminal,
    terminalSafe(sessionDisplayName(session)),
    `${terminalSafe(session.cwd)} · ${humanRelativeTime(session.updatedAt ?? "")}`,
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

async function chooseHubSettings(
  terminal: HubProcessTerminal,
  attachmentState: AttachmentStorageState,
  machineSettingsState: MachineSettingsState,
  subHostMachineState: SubHostMachineState,
): Promise<void> {
  let notice: string | undefined;
  while (true) {
    let attachmentSettings: AttachmentStorageSettings;
    let machineSettings: MachineSettings;
    try {
      [attachmentSettings, machineSettings] = await Promise.all([
        attachmentState.readSettings(),
        machineSettingsState.read(),
      ]);
    } catch {
      await showLocalAdminUnavailable(terminal, "Settings");
      return;
    }
    const selected = await selectMenu(
      terminal,
      "Settings",
      notice ?? "Configure this Main.",
      [
        { value: "attachments", label: "Attachment directory", description: terminalSafe(attachmentSettings.directory) },
        { value: "pi", label: "Pi", description: "Models and provider access on this computer" },
        {
          value: "dock-role",
          label: machineSettings.role === "subhost" ? "Dock role · SubHost next start" : "Dock role · Main",
          description: machineSettings.role === "subhost"
            ? "This Main keeps running until Alu Dock restarts"
            : machineSettings.subhost
              ? `Use saved SubHost connection · ${terminalSafe(machineSettings.subhost.name)}`
              : "Set up this computer as a SubHost",
        },
        { value: BACK, label: "Back to Hub", description: "Return to the Hub" },
      ],
      "↑↓ choose · Enter change · Esc back",
    );
    if (!selected || selected === BACK) return;
    if (selected === "attachments") {
      const value = await promptHubText(
        terminal,
        "Attachment directory",
        `Current directory: ${terminalSafe(attachmentSettings.directory)} · enter an absolute permanent path`,
      );
      if (value === undefined) continue;
      try {
        const saved = await attachmentState.writeDirectory(value.trim());
        notice = `I’ll keep new attachments in ${terminalSafe(saved.directory)}.`;
      } catch {
        notice = "I couldn’t change the attachment directory. Check that Alu Dock can write there, then try again.";
      }
      continue;
    }
    if (selected === "pi") {
      await choosePiEnvironment(terminal);
      continue;
    }
    if (selected === "dock-role") {
      notice = await configureSubHostRole(terminal, machineSettingsState, subHostMachineState, machineSettings);
    }
  }
}

async function choosePiEnvironment(terminal: HubProcessTerminal): Promise<void> {
  let notice: string | undefined;
  while (true) {
    let snapshot: PiEnvironmentSnapshot;
    try {
      const { inspectPiEnvironment } = await import("../pi/pi-environment.js");
      snapshot = await inspectPiEnvironment();
    } catch {
      await selectMenu(
        terminal,
        "Pi",
        "Pi’s settings couldn’t be opened. Run Alu Dock as the same user who owns Pi’s configuration, then try again.",
        [{ value: BACK, label: "Back", description: "Return to Settings" }],
        "Enter or Esc · back",
      );
      return;
    }
    const configured = snapshot.providers.filter((provider) => provider.configured).length;
    const selected = await selectMenu(
      terminal,
      "Pi",
      notice ?? (snapshot.diagnostics.length > 0
        ? `${snapshot.diagnostics.length} Pi setup note${snapshot.diagnostics.length === 1 ? "" : "s"} · configuration stays in ${terminalSafe(snapshot.agentDir)}`
        : `Pi configuration · ${terminalSafe(snapshot.agentDir)}`),
      [
        {
          value: "models",
          label: `Models · ${snapshot.models.length}`,
          description: snapshot.defaultModel
            ? `Default · ${terminalSafe(snapshot.defaultModel.provider)}/${terminalSafe(snapshot.defaultModel.id)}`
            : `${snapshot.providers.length} providers recognized by Pi`,
        },
        {
          value: "access",
          label: `Provider access · ${configured} configured`,
          description: "Configure an API key, sign in, or remove saved access through Pi",
        },
        ...(snapshot.diagnostics.length === 0 ? [] : [{
          value: "diagnostics",
          label: `Setup notes · ${snapshot.diagnostics.length}`,
          description: "Review messages reported while Pi loaded its environment",
        }]),
        { value: "install", label: "Install a Pi package", description: "Use aludock pi:install <source> in a terminal" },
        { value: BACK, label: "Back", description: "Return to Settings" },
      ],
      "↑↓ choose · Enter open · Esc back",
    );
    if (!selected || selected === BACK) return;
    notice = undefined;
    if (selected === "models") await choosePiModels(terminal, snapshot);
    if (selected === "access") await choosePiProviderAccess(terminal);
    if (selected === "diagnostics") await showPiDiagnostics(terminal, snapshot);
    if (selected === "install") {
      await selectMenu(
        terminal,
        "Install a Pi package",
        "Run `aludock pi:install <source>` here or from a Pi Worker. The bundled Pi accepts its normal npm, git, and local package sources.",
        [{ value: BACK, label: "Back", description: "Existing Work can load changes with /reload" }],
        "Enter or Esc · back",
      );
    }
  }
}

async function choosePiModels(terminal: HubProcessTerminal, snapshot: PiEnvironmentSnapshot): Promise<void> {
  while (true) {
    const providers = snapshot.providers.filter((provider) => provider.modelCount > 0);
    const selected = await selectMenu(
      terminal,
      "Pi Models",
      snapshot.defaultModel
        ? `Default · ${terminalSafe(snapshot.defaultModel.provider)}/${terminalSafe(snapshot.defaultModel.id)}`
        : "No global default model is set.",
      [
        ...providers.map((provider) => ({
          value: `provider:${provider.id}`,
          label: `${terminalSafe(provider.name)} · ${provider.modelCount}`,
          description: provider.configured ? "Access configured" : "Access not configured",
        })),
        { value: BACK, label: "Back", description: "Return to Pi" },
      ],
      "↑↓ choose · Enter view · Esc back",
    );
    if (!selected || selected === BACK) return;
    const providerId = selected.slice("provider:".length);
    const provider = snapshot.providers.find((item) => item.id === providerId);
    if (!provider) continue;
    const models = snapshot.models.filter((model) => model.provider === providerId);
    await selectMenu(
      terminal,
      provider.name,
      `${models.length} model${models.length === 1 ? "" : "s"} recognized by Pi`,
      [
        ...models.map((model, index) => ({
          value: `model:${index}`,
          label: terminalSafe(model.name),
          description: `${terminalSafe(model.id)}${model.reasoning ? " · reasoning" : ""}`,
        })),
        { value: BACK, label: "Back", description: "Return to providers" },
      ],
      "↑↓ browse · Esc back",
    );
  }
}

async function choosePiProviderAccess(terminal: HubProcessTerminal): Promise<void> {
  let notice: string | undefined;
  while (true) {
    let snapshot: PiEnvironmentSnapshot;
    try {
      const { inspectPiEnvironment } = await import("../pi/pi-environment.js");
      snapshot = await inspectPiEnvironment();
    } catch {
      return;
    }
    const selected = await selectMenu(
      terminal,
      "Pi Provider Access",
      notice ?? "Credentials are saved and refreshed by Pi in its normal auth.json.",
      [
        ...snapshot.providers.map((provider) => ({
          value: `provider:${provider.id}`,
          label: `${provider.configured ? "●" : "○"} ${terminalSafe(provider.name)}`,
          description: piProviderAccessDescription(provider),
        })),
        { value: BACK, label: "Back", description: "Return to Pi" },
      ],
      "↑↓ choose · Enter manage · Esc back",
    );
    if (!selected || selected === BACK) return;
    const provider = snapshot.providers.find((item) => item.id === selected.slice("provider:".length));
    if (!provider) continue;
    const action = await selectMenu(
      terminal,
      provider.name,
      provider.configured ? `Pi access is configured${provider.accessLabel ? ` · ${terminalSafe(provider.accessLabel)}` : ""}.` : "Pi access is not configured.",
      [
        ...(provider.apiKey?.canLogin ? [{ value: "api_key", label: "Configure API key", description: terminalSafe(provider.apiKey.name) }] : []),
        ...(provider.oauth ? [{ value: "oauth", label: provider.oauth.loginLabel ? terminalSafe(provider.oauth.loginLabel) : "Sign in", description: terminalSafe(provider.oauth.name) }] : []),
        ...(provider.storedCredentialType ? [{ value: "logout", label: "Remove saved access", description: "Delete this provider’s credential from Pi" }] : []),
        { value: BACK, label: "Back", description: "Return to providers" },
      ],
      "↑↓ choose · Enter continue · Esc back",
    );
    if (!action || action === BACK) continue;
    if (action === "logout") {
      const confirmed = await selectMenu(
        terminal,
        `Remove ${provider.name} access?`,
        "This removes the credential saved by Pi on this computer.",
        [
          { value: "confirm", label: "Remove saved access", description: "Other Pi processes on this computer will also see the change" },
          { value: BACK, label: "Keep it", description: "Leave Pi unchanged" },
        ],
        "↑↓ choose · Enter confirm · Esc keep",
      );
      if (confirmed !== "confirm") continue;
      try {
        const { logoutPiProvider } = await import("../pi/pi-environment.js");
        await logoutPiProvider(provider.id);
        notice = `${provider.name} access was removed from Pi.`;
      } catch (error) {
        notice = `Pi couldn’t remove ${provider.name} access: ${humanPiFailure(error)}`;
      }
      continue;
    }
    if (action !== "api_key" && action !== "oauth") continue;
    try {
      const { loginPiProvider } = await import("../pi/pi-environment.js");
      await loginPiProvider(provider.id, action, createPiLoginInteraction(terminal));
      notice = action === "oauth"
        ? `${provider.name} sign-in finished in Pi.`
        : `${provider.name} API-key access was saved by Pi.`;
    } catch (error) {
      notice = error instanceof PiLoginCancelledError
        ? `${provider.name} setup was cancelled.`
        : `Pi couldn’t finish ${provider.name} setup: ${humanPiFailure(error)}`;
    }
  }
}

function createPiLoginInteraction(terminal: HubProcessTerminal): PiLoginInteraction {
  let promptContext: string | undefined;
  const remember = (...parts: Array<string | undefined>): void => {
    const value = parts.filter((part): part is string => Boolean(part)).map(terminalSafe).join(" ");
    promptContext = value.length > 8_000 ? `${value.slice(0, 7_997)}…` : value;
  };
  return {
    prompt: async (prompt) => {
      if (prompt.signal?.aborted) throw new PiLoginCancelledError();
      if (prompt.type === "select") {
        const selected = await selectMenu(
          terminal,
          prompt.message,
          promptContext ?? "Choose an option supplied by Pi.",
          prompt.options.map((option) => ({
            value: option.id,
            label: terminalSafe(option.label),
            description: terminalSafe(option.description ?? ""),
          })),
          "↑↓ choose · Enter continue · Esc cancel",
        );
        if (!selected || prompt.signal?.aborted) throw new PiLoginCancelledError();
        return selected;
      }
      const value = await promptHubText(
        terminal,
        prompt.message,
        prompt.placeholder ?? (prompt.type === "secret" ? "Enter the value; it stays hidden." : "Enter the value requested by Pi."),
        undefined,
        { secret: prompt.type === "secret", signal: prompt.signal, context: promptContext },
      );
      if (value === undefined || prompt.signal?.aborted) throw new PiLoginCancelledError();
      return value;
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        remember("Open this address to continue sign-in:", event.url, event.instructions);
        terminal.write(`${terminalSafe(event.instructions ?? "Open this address to continue sign-in:")}\n${terminalSafe(event.url)}\n`);
        return;
      }
      if (event.type === "device_code") {
        remember("Open", event.verificationUri, "and enter code", event.userCode);
        terminal.write(`Open ${terminalSafe(event.verificationUri)} and enter code ${terminalSafe(event.userCode)}.\n`);
        return;
      }
      terminal.write(`${terminalSafe(event.message)}\n`);
      if (event.type === "info") {
        const links = event.links ?? [];
        if (links.length > 0) remember(...links.flatMap((link) => [link.label ?? "Open", link.url]), event.message);
        for (const link of links) terminal.write(`${terminalSafe(link.label ?? "Open")}: ${terminalSafe(link.url)}\n`);
      }
    },
  };
}

async function showPiDiagnostics(terminal: HubProcessTerminal, snapshot: PiEnvironmentSnapshot): Promise<void> {
  await selectMenu(
    terminal,
    "Pi Setup Notes",
    "These messages came from Pi while it loaded global packages and model configuration.",
    [
      ...snapshot.diagnostics.slice(0, 100).map((message, index) => ({ value: `note:${index}`, label: terminalSafe(message), description: "" })),
      { value: BACK, label: "Back", description: "Return to Pi" },
    ],
    "↑↓ browse · Esc back",
  );
}

function piProviderAccessDescription(provider: PiEnvironmentSnapshot["providers"][number]): string {
  if (provider.configured) return provider.accessLabel ? `Configured · ${terminalSafe(provider.accessLabel)}` : "Configured";
  const methods = [provider.apiKey?.canLogin ? "API key" : undefined, provider.oauth ? "sign-in" : undefined].filter(Boolean);
  return methods.length > 0 ? `Not configured · ${methods.join(" or ")}` : "Uses ambient Pi access when available";
}

function humanPiFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
  return terminalSafe(message.length > 300 ? `${message.slice(0, 297)}…` : message || "try again");
}

class PiLoginCancelledError extends Error {}

async function chooseMachinesAction(
  terminal: HubProcessTerminal,
  client: DockClient,
  machineSettingsState: MachineSettingsState,
  mainMachineState: MainMachineState,
): Promise<void> {
  let notice: string | undefined;
  while (true) {
    let settings: MachineSettings;
    let status: MachineListenerStatus | undefined;
    let result: Awaited<ReturnType<DockClient["machines"]>>;
    try {
      [settings, status, result] = await Promise.all([
        machineSettingsState.read(),
        machineSettingsState.readMainListenerStatus(),
        client.machines(),
      ]);
    } catch {
      await showLocalAdminUnavailable(terminal, "Machines");
      return;
    }
    const subhosts = result.machines.filter((machine) => machine.kind === "subhost");
    const entries: DockHubEntry[] = [
      {
        value: "connect",
        label: settings.main.connectionsEnabled ? "Connect a SubHost" : "Turn On & Connect a SubHost",
        description: settings.main.connectionsEnabled
          ? "Create a private one-use join file"
          : `Open port ${settings.main.port}, then create a private one-use join file`,
      },
      ...subhosts.map((machine) => ({
        value: `machine:${machine.hostId}`,
        label: `${machine.available ? "●" : "○"} ${terminalSafe(machine.name)}`,
        description: machine.available ? "Connected" : "Unavailable",
      })),
      {
        value: "toggle",
        label: `SubHost Connections · ${settings.main.connectionsEnabled ? "On" : "Off"}`,
        description: settings.main.connectionsEnabled
          ? "Close all SubHost connections; paired machines stay in Machines"
          : `Listen on port ${settings.main.port}`,
      },
      { value: "port", label: `Port · ${settings.main.port}`, description: "Change the port SubHosts use" },
      {
        value: "address",
        label: `Address · ${terminalSafe(settings.main.advertisedAddress ?? "Not set")}`,
        description: "The address new SubHosts use to reach this Main",
      },
      { value: BACK, label: "Back to Hub", description: "Return to the Hub" },
    ];
    const selected = await selectMenu(
      terminal,
      "Machines",
      notice ?? machineConnectionsSubtitle(settings, status, subhosts.length),
      entries,
      "↑↓ choose · Enter open · Esc back",
    );
    if (!selected || selected === BACK) return;
    notice = undefined;
    if (selected === "connect") {
      let address = settings.main.advertisedAddress;
      if (address === undefined) {
        address = await promptMainAddress(terminal, undefined, "Enter the address another computer uses to reach this Main");
        if (address === undefined) continue;
      }
      const output = await promptHubText(
        terminal,
        "Save SubHost join file",
        "Move this private one-use file to the computer that will become a SubHost",
        join(homedir(), "alu-dock-subhost.join"),
      );
      if (output === undefined) continue;
      try {
        if (settings.main.advertisedAddress !== address) await machineSettingsState.writeMainAdvertisedAddress(address);
        const [latest, latestStatus] = await Promise.all([
          machineSettingsState.read(),
          machineSettingsState.readMainListenerStatus(),
        ]);
        const ready = await ensureMachineConnectionsReady(terminal, machineSettingsState, latest, latestStatus);
        if (!ready) {
          notice = machinePortUnavailableNotice(latest.main.port);
          continue;
        }
        const [current, currentStatus] = await Promise.all([
          machineSettingsState.read(),
          machineSettingsState.readMainListenerStatus(),
        ]);
        if (
          current.revision !== ready.revision
          || !current.main.connectionsEnabled
          || current.main.advertisedAddress !== address
          || !sameMachineListenerConfiguration(currentStatus, machineListenerConfiguration(current))
          || currentStatus?.state !== "listening"
        ) {
          notice = "The Machine port changed while the join file was being prepared. Check the current port, then try again.";
          continue;
        }
        const joinFile = await mainMachineState.createJoin({ mainAddress: address, port: current.main.port });
        await writeMachineJoinFile(output.trim(), joinFile);
        notice = `Join file saved at ${terminalSafe(resolve(output.trim()))}. Move it to the other computer, then choose Use as SubHost in Settings.`;
      } catch {
        notice = "The join file couldn’t be saved. Check the path, then try again.";
      }
      continue;
    }
    if (selected === "address") {
      const address = await promptMainAddress(
        terminal,
        settings.main.advertisedAddress,
        "Enter the address another computer uses to reach this Main",
      );
      if (address === undefined) continue;
      try {
        await machineSettingsState.writeMainAdvertisedAddress(address);
        notice = `New SubHosts will connect to ${terminalSafe(address)}.`;
      } catch {
        notice = "That address couldn’t be saved. Check it, then try again.";
      }
      continue;
    }
    if (selected === "toggle") {
      try {
        const saved = await machineSettingsState.writeMainConnections({ enabled: !settings.main.connectionsEnabled, port: settings.main.port });
        if (settings.main.connectionsEnabled) {
          const stopped = await ensureMachineConnectionsStopped(terminal, machineSettingsState, saved);
          notice = stopped
            ? "SubHost connections are off. Paired machines stay saved."
            : "SubHost connections are still closing. Wait a moment, then return to Machines.";
        } else {
          const ready = await ensureMachineConnectionsReady(terminal, machineSettingsState, saved, undefined);
          notice = ready !== undefined
            ? `SubHost connections are on at port ${saved.main.port}.`
            : machinePortUnavailableNotice(saved.main.port);
        }
      } catch {
        notice = "SubHost connections couldn’t be changed. Try again from this screen.";
      }
      continue;
    }
    if (selected === "port") {
      const port = await promptMachinePort(terminal, settings.main.port);
      if (port === undefined) continue;
      try {
        const saved = await machineSettingsState.writeMainConnections({ enabled: settings.main.connectionsEnabled, port });
        if (settings.main.connectionsEnabled) {
          const ready = await ensureMachineConnectionsReady(terminal, machineSettingsState, saved, undefined);
          notice = ready !== undefined
            ? `SubHost connections moved to port ${port}. SubHosts must use this port to reconnect.`
            : machinePortUnavailableNotice(port);
        } else {
          notice = `Port ${port} is ready for the next time SubHost connections turn on.`;
        }
      } catch {
        notice = "That Machine port couldn’t be saved. Try again from this screen.";
      }
      continue;
    }
    const machine = subhosts.find((candidate) => `machine:${candidate.hostId}` === selected);
    if (machine) {
      const action = await selectMenu(
        terminal,
        terminalSafe(machine.name),
        machine.available ? "Connected to this Main" : "This SubHost is currently unavailable",
        [
          { value: "remove", label: "Remove SubHost", description: "Revoke its trust and disconnect it from this Main" },
          { value: BACK, label: "Back to Machines", description: "Return to the machine list" },
        ],
        "↑↓ choose · Enter select · Esc back",
      );
      if (action !== "remove") continue;
      const confirmed = await selectMenu(
        terminal,
        `Remove ${terminalSafe(machine.name)}?`,
        "Its work keeps running there, but it disappears from this Main until joined again.",
        [
          { value: "confirm", label: "Remove SubHost", description: "Disconnect now and revoke its saved trust" },
          { value: BACK, label: "Keep SubHost", description: "Leave the connection unchanged" },
        ],
        "↑↓ choose · Enter confirm · Esc cancel",
      );
      if (confirmed !== "confirm") continue;
      try {
        await client.removeMachine(machine.hostId);
        notice = `${terminalSafe(machine.name)} was removed from this Main.`;
      } catch {
        notice = `I couldn’t remove ${terminalSafe(machine.name)}. Refresh Machines and try again.`;
      }
    }
  }
}

function machinePortUnavailableNotice(port: number): string {
  return `Port ${port} isn’t available for SubHost connections. Choose another port, then try again.`;
}

function machineConnectionsSubtitle(settings: MachineSettings, status: MachineListenerStatus | undefined, subhostCount: number): string {
  const count = `${subhostCount} SubHost${subhostCount === 1 ? "" : "s"}`;
  if (!settings.main.connectionsEnabled) return `${count} · Connections are off · Port ${settings.main.port}`;
  if (!sameMachineListenerConfiguration(status, machineListenerConfiguration(settings))) return `${count} · Getting port ${settings.main.port} ready…`;
  if (status?.state === "listening") return `${count} · Listening on port ${settings.main.port}`;
  if (status?.state === "error") return `${count} · Port ${settings.main.port} isn’t available; choose another port or try again`;
  return `${count} · Getting port ${settings.main.port} ready…`;
}

async function ensureMachineConnectionsReady(
  terminal: HubProcessTerminal,
  state: MachineSettingsState,
  settings: MachineSettings,
  status: MachineListenerStatus | undefined,
): Promise<MachineSettings | undefined> {
  let expected = settings;
  if (!expected.main.connectionsEnabled) expected = await state.writeMainConnections({ enabled: true, port: expected.main.port });
  if (
    status?.state === "listening"
    && sameMachineListenerConfiguration(status, machineListenerConfiguration(expected))
  ) return expected;
  terminal.clearScreen();
  terminal.write(`\n  Getting SubHost connections ready on port ${expected.main.port}…\n`);
  const deadline = Date.now() + LISTENER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await state.readMainListenerStatus();
    if (sameMachineListenerConfiguration(current, machineListenerConfiguration(expected))) {
      if (current?.state === "listening") return expected;
      if (current?.state === "error") return undefined;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, LISTENER_STATUS_POLL_MS));
  }
  return undefined;
}

async function ensureMachineConnectionsStopped(
  terminal: HubProcessTerminal,
  state: MachineSettingsState,
  expected: MachineSettings,
): Promise<boolean> {
  terminal.clearScreen();
  terminal.write("\n  Closing SubHost connections…\n");
  const deadline = Date.now() + LISTENER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await state.readMainListenerStatus();
    if (sameMachineListenerConfiguration(current, machineListenerConfiguration(expected))) {
      if (current?.state === "disabled") return true;
      if (current?.state === "error") return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, LISTENER_STATUS_POLL_MS));
  }
  return false;
}

type SubHostConnectionIntent = "choose-role" | "manage";

async function configureSubHostRole(
  terminal: HubProcessTerminal,
  machineSettingsState: MachineSettingsState,
  subHostMachineState: SubHostMachineState,
  current: MachineSettings,
  intent: SubHostConnectionIntent = "choose-role",
): Promise<string | undefined> {
  let existing: Awaited<ReturnType<SubHostMachineState["load"]>>;
  try {
    existing = await subHostMachineState.load();
  } catch {
    return "I couldn’t read this computer’s saved Main connection. Nothing was changed.";
  }

  if (existing?.joinToken !== undefined && enrollmentNeedsRenewal(existing.joinExpiresAt)) {
    const action = await selectMenu(
      terminal,
      "SubHost enrollment needs a fresh join file",
      current.subhost
        ? subHostConnectionSummary(current.subhost)
        : `${terminalSafe(existing.machineName)} has not finished connecting to Main`,
      [
        { value: "renew", label: "Use a Fresh Join File", description: "Keep this SubHost identity and finish with the same Main" },
        { value: "change", label: "Connect to a Different Main", description: "Replace the unfinished enrollment" },
        ...(current.role === "subhost"
          ? [{ value: "use-main", label: "Use as Main Instead", description: "Cancel the pending SubHost role" }]
          : []),
        { value: BACK, label: "Back", description: "Leave everything unchanged" },
      ],
      "↑↓ choose · Enter confirm · Esc cancel",
    );
    if (!action || action === BACK) return undefined;
    if (action === "use-main") {
      try {
        await machineSettingsState.switchToMain();
        return "This computer will keep using Main on the next start.";
      } catch {
        return "I couldn’t change the next startup role. Review Settings before restarting.";
      }
    }
    return enrollWithJoinFile(
      terminal,
      machineSettingsState,
      subHostMachineState,
      current,
      existing,
      action === "change" ? "replace" : "renew",
    );
  }

  if (existing && current.subhost) {
    const action = await selectMenu(
      terminal,
      intent === "choose-role"
        ? current.role === "subhost" ? "SubHost is selected for the next start" : "Use this computer as SubHost?"
        : "Main connection",
      subHostConnectionSummary(current.subhost),
      [
        ...(intent === "choose-role" && current.role === "main"
          ? [{ value: "use", label: "Use Saved Connection", description: "No address, port, name, or join file needed" }]
          : []),
        ...(intent === "choose-role" && current.role === "subhost"
          ? [
            { value: "keep-subhost", label: "Keep SubHost for Next Start", description: "Leave the saved role unchanged" },
            { value: "use-main", label: "Use as Main Instead", description: "Cancel the pending role change" },
          ]
          : []),
        { value: "edit", label: "Edit Connection", description: "Change the address, port, or name for this Main" },
        { value: "change", label: "Connect to a Different Main", description: "Requires a new private join file" },
        { value: BACK, label: intent === "choose-role" ? "Back to Settings" : "Keep Current Connection", description: "Leave everything unchanged" },
      ],
      "↑↓ choose · Enter confirm · Esc cancel",
    );
    if (!action || action === BACK || action === "keep-subhost") return undefined;
    if (action === "use-main") {
      try {
        await machineSettingsState.switchToMain();
        return "This computer will keep using Main on the next start.";
      } catch {
        return "I couldn’t change the next startup role. Review Settings before restarting.";
      }
    }
    if (action === "use") return saveSubHostConnection(machineSettingsState, subHostMachineState, current.subhost);
    if (action === "edit") return editSubHostConnection(terminal, machineSettingsState, subHostMachineState, current.subhost);
    return enrollWithJoinFile(terminal, machineSettingsState, subHostMachineState, current, existing, "replace");
  }

  if (existing) {
    const mainAddress = await promptMainAddress(
      terminal,
      undefined,
      `This computer is already enrolled as ${terminalSafe(existing.machineName)}. Enter the address it uses to reach Main`,
    );
    if (mainAddress === undefined) return undefined;
    const proposed = await confirmSubHostConnection(
      terminal,
      { mainAddress, port: current.main.port, name: existing.machineName },
      "Restore Saved Main Connection?",
      "Use Existing Enrollment",
    );
    if (proposed === undefined) return undefined;
    return saveSubHostConnection(machineSettingsState, subHostMachineState, proposed);
  }

  return enrollWithJoinFile(terminal, machineSettingsState, subHostMachineState, current, undefined, "new");
}

type SubHostEnrollmentMode = "new" | "renew" | "replace";

async function enrollWithJoinFile(
  terminal: HubProcessTerminal,
  machineSettingsState: MachineSettingsState,
  subHostMachineState: SubHostMachineState,
  current: MachineSettings,
  existing: Awaited<ReturnType<SubHostMachineState["load"]>>,
  mode: SubHostEnrollmentMode,
): Promise<string | undefined> {
  const joinPath = await promptHubText(
    terminal,
    mode === "replace" ? "New Main join file" : mode === "renew" ? "Fresh join file needed" : "SubHost join file",
    mode === "replace"
      ? "Choose the private join file created by the new Main"
      : mode === "renew"
        ? "The previous join expired before enrollment finished. Create a fresh file on the same Main"
        : "Choose the private join file created by Main",
    join(homedir(), "alu-dock-subhost.join"),
  );
  if (joinPath === undefined) return undefined;
  if (joinPath.trim().length === 0) return "Choose the private join file created by Main.";

  try {
    const joinFile = await readMachineJoinFile(joinPath.trim());
    if (mode === "replace" && existing?.mainFingerprint === joinFile.mainFingerprint) {
      return "That join file belongs to the current Main. Choose Edit Connection if its address or port changed.";
    }
    if (mode === "renew" && existing?.mainFingerprint !== joinFile.mainFingerprint) {
      return "That join file belongs to a different Main. Keep the current Main or choose Connect to a Different Main.";
    }
    let mainAddress = joinFile.connection?.mainAddress ?? current.subhost?.mainAddress;
    if (mainAddress === undefined) {
      mainAddress = await promptMainAddress(terminal, undefined, "Enter the address this computer uses to reach Main");
      if (mainAddress === undefined) return undefined;
    }
    const proposed = await confirmSubHostConnection(
      terminal,
      {
        mainAddress,
        port: joinFile.connection?.port ?? current.subhost?.port ?? current.main.port,
        name: current.subhost?.name ?? existing?.machineName ?? hostname(),
      },
      mode === "replace" ? "Connect to a Different Main?" : mode === "renew" ? "Finish SubHost Enrollment?" : "Use this computer as SubHost?",
      mode === "replace" ? "Change Main" : mode === "renew" ? "Use Fresh Join" : "Use as SubHost",
    );
    if (proposed === undefined) return undefined;
    const pending = mode === "replace"
      ? await subHostMachineState.replace(joinFile, proposed.name)
      : await subHostMachineState.prepare(joinFile, proposed.name);
    await machineSettingsState.switchToSubHost(proposed);
    return pendingEnrollmentNotice(pending.joinExpiresAt);
  } catch {
    return "I couldn’t finish that Main connection. Check that the join file came from the intended Main and hasn’t expired, then review the saved connection before trying again.";
  }
}

async function saveSubHostConnection(
  machineSettingsState: MachineSettingsState,
  subHostMachineState: SubHostMachineState,
  connection: SubHostConnectionSettings,
): Promise<string> {
  try {
    const enrollment = await subHostMachineState.updateMachineName(connection.name);
    await machineSettingsState.switchToSubHost(connection);
    return enrollment.joinToken === undefined
      ? "This computer will start as SubHost next time Alu Dock starts. Start it normally; no join file is needed."
      : pendingEnrollmentNotice(enrollment.joinExpiresAt);
  } catch {
    return "I couldn’t finish saving that Main connection. Review the connection before trying again.";
  }
}

async function editSubHostConnection(
  terminal: HubProcessTerminal,
  machineSettingsState: MachineSettingsState,
  subHostMachineState: SubHostMachineState,
  current: SubHostConnectionSettings,
): Promise<string | undefined> {
  const edited = await promptSubHostConnectionDetails(terminal, current);
  if (edited === undefined) return undefined;
  return saveSubHostConnection(machineSettingsState, subHostMachineState, edited);
}

async function confirmSubHostConnection(
  terminal: HubProcessTerminal,
  initial: SubHostConnectionSettings,
  title: string,
  confirmLabel: string,
): Promise<SubHostConnectionSettings | undefined> {
  let proposed = initial;
  while (true) {
    const selected = await selectMenu(
      terminal,
      title,
      subHostConnectionSummary(proposed),
      [
        { value: "confirm", label: confirmLabel, description: "Save this connection for future starts" },
        { value: "edit", label: "Edit Details", description: "Change the address, port, or name" },
        { value: BACK, label: "Cancel", description: "Leave everything unchanged" },
      ],
      "↑↓ choose · Enter confirm · Esc cancel",
    );
    if (selected === "confirm") return proposed;
    if (!selected || selected === BACK) return undefined;
    const edited = await promptSubHostConnectionDetails(terminal, proposed);
    if (edited !== undefined) proposed = edited;
  }
}

async function promptSubHostConnectionDetails(
  terminal: HubProcessTerminal,
  current: SubHostConnectionSettings,
): Promise<SubHostConnectionSettings | undefined> {
  const mainAddress = await promptMainAddress(terminal, current.mainAddress, "Enter the address this computer uses to reach Main");
  if (mainAddress === undefined) return undefined;
  const port = await promptMachinePort(terminal, current.port);
  if (port === undefined) return undefined;
  const name = await promptHubText(
    terminal,
    "SubHost name",
    "Choose the name Main will show for this computer",
    current.name,
  );
  if (name === undefined || name.trim().length === 0) return undefined;
  return { mainAddress, port, name: name.trim() };
}

async function promptMainAddress(
  terminal: HubProcessTerminal,
  current: string | undefined,
  description: string,
): Promise<string | undefined> {
  const value = await promptHubText(terminal, "Main address", description, current);
  const address = value?.trim();
  if (!address) return undefined;
  return address;
}

function subHostConnectionSummary(connection: SubHostConnectionSettings): string {
  return `${terminalSafe(connection.name)} will connect to ${terminalSafe(connection.mainAddress)} · Port ${connection.port}`;
}

function enrollmentNeedsRenewal(expiresAt: string | undefined): boolean {
  return expiresAt === undefined || Date.parse(expiresAt) <= Date.now();
}

function pendingEnrollmentNotice(expiresAt: string | undefined): string {
  const remainingMs = expiresAt === undefined ? 0 : Date.parse(expiresAt) - Date.now();
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `Restart Alu Dock normally within ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"} to finish enrollment. The join file is already imported.`;
}

async function promptMachinePort(terminal: HubProcessTerminal, current: number): Promise<number | undefined> {
  const value = await promptHubText(
    terminal,
    "SubHost port",
    "Enter a port from 1 to 65535",
    String(current),
  );
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const port = /^\d{1,5}$/u.test(trimmed) ? Number(trimmed) : 0;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    await selectMenu(
      terminal,
      "SubHost port",
      "The port needs to be a whole number from 1 to 65535.",
      [{ value: BACK, label: "Back", description: "Enter the port again" }],
      "Enter or Esc · back",
    );
    return undefined;
  }
  return port;
}

interface DevicesSnapshot {
  pending: PendingPairing[];
  trusted: TrustedClient[];
  pairingWindow?: PairingWindow;
  progress?: PairingProgress;
  settings: RemoteAccessSettings;
  status?: RemoteAccessStatus;
  windowOpen: boolean;
}

async function chooseDevicesAction(
  terminal: HubProcessTerminal,
  state: RemoteAccessState,
): Promise<void> {
  let notice: string | undefined;
  while (true) {
    let result: LiveMenuSelection<DevicesSnapshot>;
    try {
      result = await selectLiveMenu(
        terminal,
        "Devices",
        async (previous) => {
          const snapshot = await readDevicesSnapshot(state);
          const newlyWaiting = snapshot.pending.find((request) => !previous?.pending.some((item) => item.id === request.id));
          const progressChanged = snapshot.progress?.updatedAt !== previous?.progress?.updatedAt;
          return {
            data: snapshot,
            subtitle: snapshot.progress !== undefined
              ? devicesSubtitle(snapshot)
              : notice ?? devicesSubtitle(snapshot),
            entries: devicesEntries(snapshot),
            preferredValue: newlyWaiting
              ? `pending:${newlyWaiting.id}`
              : progressChanged && snapshot.progress?.status === "connected" ? "done"
                : progressChanged && snapshot.progress?.status === "failed" ? "try-again"
                  : previous === undefined && snapshot.windowOpen && snapshot.pending.length === 0 ? BACK : undefined,
          };
        },
        "↑↓ choose · Enter open · Esc back · updates automatically",
      );
    } catch {
      await showLocalAdminUnavailable(terminal, "Devices");
      return;
    }
    const selected = result.value;
    const snapshot = result.data;
    if (!selected || selected === BACK) return;
    notice = undefined;

    if (selected === "connect" || selected === "connect-another" || selected === "try-again") {
      if (!await confirmDeviceConnectionWindow(terminal)) continue;
      try {
        await state.clearPairingProgress();
        const ready = await ensureRemoteAccessReady(terminal, state, snapshot.settings, snapshot.status);
        if (!ready) {
          notice = `I couldn’t get remote access ready on port ${snapshot.settings.port}. Try another port, then connect again.`;
          continue;
        }
        await state.openPairingWindow();
        notice = undefined;
      } catch {
        notice = "I couldn’t start a new device connection. Check the Dock state directory and try again.";
      }
      continue;
    }
    if (selected === "done") {
      await state.clearPairingProgress().catch(() => {});
      continue;
    }
    if (selected === "stop-window") {
      try {
        await state.closePairingWindow(snapshot.pairingWindow?.id);
        await state.clearPairingProgress();
        notice = "I stopped waiting for a device.";
      } catch {
        notice = "I couldn’t stop waiting. Check the Dock state directory and try again.";
      }
      continue;
    }
    if (selected === "toggle") {
      try {
        if (snapshot.settings.enabled) {
          await state.closePairingWindow(snapshot.pairingWindow?.id).catch(() => false);
          await state.clearPairingProgress();
        }
        await state.writeSettings({ enabled: !snapshot.settings.enabled, port: snapshot.settings.port });
        notice = snapshot.settings.enabled
          ? "Remote access is turning off. I’ll remember your paired devices."
          : `Getting remote access ready on port ${snapshot.settings.port}…`;
      } catch {
        notice = "I couldn’t change remote access. Check the Dock state directory and try again.";
      }
      continue;
    }
    if (selected === "port") {
      notice = await changeRemoteAccessPort(terminal, state, snapshot.settings);
      continue;
    }
    if (selected.startsWith("pending:")) {
      const request = snapshot.pending.find((candidate) => candidate.id === selected.slice("pending:".length));
      if (request) notice = await approvePendingDevice(terminal, state, request);
      continue;
    }
    if (selected.startsWith("trusted:")) {
      const client = snapshot.trusted.find((candidate) => candidate.fingerprint === selected.slice("trusted:".length));
      if (client) notice = await removePairedDevice(terminal, state, client);
    }
  }
}

async function readDevicesSnapshot(state: RemoteAccessState): Promise<DevicesSnapshot> {
  const [allPending, trusted, pairingWindow, progress, settings, status] = await Promise.all([
    state.listPending(),
    state.listTrusted(),
    state.readPairingWindow(),
    state.readPairingProgress(),
    state.readSettings(),
    state.readStatus(),
  ]);
  const windowOpen = pairingWindow !== undefined && Date.parse(pairingWindow.expiresAt) > Date.now();
  const pending = windowOpen && pairingWindow
    ? allPending.filter((request) => request.windowId === pairingWindow.id && Date.parse(request.expiresAt) > Date.now())
    : [];
  pending.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt) || left.id.localeCompare(right.id));
  trusted.sort((left, right) => right.pairedAt.localeCompare(left.pairedAt) || left.fingerprint.localeCompare(right.fingerprint));
  return {
    pending,
    trusted,
    ...(pairingWindow === undefined ? {} : { pairingWindow }),
    ...(progress === undefined ? {} : { progress }),
    settings,
    ...(status === undefined ? {} : { status }),
    windowOpen,
  };
}

function devicesSubtitle(snapshot: DevicesSnapshot): string {
  if (snapshot.progress?.status === "checking") {
    return `Just a moment — checking the PIN with ${snapshot.progress.deviceName}… Keep the device open.`;
  }
  if (snapshot.progress?.status === "connected") {
    return `${snapshot.progress.deviceName} is all set. It can connect to Dock now.`;
  }
  if (snapshot.progress?.status === "failed") return snapshot.progress.message;
  if (snapshot.windowOpen && snapshot.pairingWindow) {
    if (snapshot.pending.length > 0) return `I found ${snapshot.pending.length === 1 ? "a device" : `${snapshot.pending.length} devices`} ready to connect · ${remainingTime(snapshot.pairingWindow.expiresAt)} left`;
    return `Waiting for your device… · ${remainingTime(snapshot.pairingWindow.expiresAt)} left · I’ll pick it up automatically.`;
  }
  if (!snapshot.settings.enabled) return `Remote access is off · Port ${snapshot.settings.port} · I’ll remember your paired devices.`;
  return remoteAccessStatusSummary(snapshot.settings, snapshot.status);
}

function devicesEntries(snapshot: DevicesSnapshot): DockHubEntry[] {
  if (snapshot.progress?.status === "connected") {
    return [
      { value: "done", label: "Done", description: "Back to your devices" },
      { value: "connect-another", label: "Connect Another Device", description: "Wait for another device for five minutes" },
      { value: BACK, label: "Back to Hub", description: "Leave Devices" },
    ];
  }
  if (snapshot.progress?.status === "failed") {
    return [
      { value: "try-again", label: "Try Again", description: "Start waiting for a new request" },
      { value: BACK, label: "Back to Hub", description: "Leave Devices" },
    ];
  }
  const entries: DockHubEntry[] = [];
  if (!snapshot.windowOpen && snapshot.progress?.status !== "checking") {
    entries.push({
      value: "connect",
      label: snapshot.settings.enabled ? "Connect a New Device" : "Turn On & Connect a Device",
      description: snapshot.settings.enabled
        ? "Wait for a device for five minutes"
        : `Start remote access on port ${snapshot.settings.port}, then wait for a device`,
    });
  }
  entries.push(...snapshot.pending.map((request) => ({
    value: `pending:${request.id}`,
    label: request.deviceName,
    description: "Ready to connect · choose it to enter the PIN",
  })));
  entries.push(...snapshot.trusted.map((client) => ({
    value: `trusted:${client.fingerprint}`,
    label: client.deviceName,
    description: snapshot.settings.enabled
      ? `Can connect remotely · Paired ${humanRelativeTime(client.pairedAt)}`
      : "Saved for later · Remote access is off",
  })));
  entries.push({
    value: "toggle",
    label: `Remote Access · ${snapshot.settings.enabled ? "On" : "Off"}`,
    description: snapshot.settings.enabled ? "Turn off remote connections; paired devices stay saved" : `Listen on port ${snapshot.settings.port}`,
  });
  entries.push({ value: "port", label: `Port · ${snapshot.settings.port}`, description: "Change the port remote devices use" });
  entries.push({ value: BACK, label: "Back to Hub", description: snapshot.windowOpen ? "Waiting continues until time runs out" : "Leave Devices" });
  if (snapshot.windowOpen) entries.push({ value: "stop-window", label: "Stop Waiting", description: "Discard devices that are still waiting" });
  return entries;
}

async function confirmDeviceConnectionWindow(terminal: HubProcessTerminal): Promise<boolean> {
  const selected = await selectMenu(
    terminal,
    "Connect a New Device?",
    "Only continue while you’re pairing a device in your possession. Dock will accept requests for five minutes or until one device connects.",
    [
      { value: "confirm", label: "Start Waiting", description: "Open the five-minute connection window" },
      { value: BACK, label: "Not Now", description: "Keep new device connections closed" },
    ],
    "↑↓ choose · Enter confirm · Esc cancel",
  );
  return selected === "confirm";
}

async function ensureRemoteAccessReady(
  terminal: HubProcessTerminal,
  state: RemoteAccessState,
  settings: RemoteAccessSettings,
  status: RemoteAccessStatus | undefined,
): Promise<boolean> {
  let expected = settings;
  if (!expected.enabled) expected = await state.writeSettings({ enabled: true, port: expected.port });
  if (status?.state === "listening" && status.configRevision === expected.revision) return true;
  terminal.clearScreen();
  terminal.write(`\n  Getting remote access ready on port ${expected.port}…\n`);
  const deadline = Date.now() + LISTENER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await state.readStatus();
    if (current?.configRevision === expected.revision) {
      if (current.state === "listening") return true;
      if (current.state === "error" || current.state === "stopped") return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, LISTENER_STATUS_POLL_MS));
  }
  return false;
}

async function changeRemoteAccessPort(
  terminal: HubProcessTerminal,
  state: RemoteAccessState,
  settings: RemoteAccessSettings,
): Promise<string | undefined> {
  const value = await promptHubText(
    terminal,
    "Remote access port",
    `Current port: ${settings.port} · enter a port from 1 to 65535`,
  );
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const port = /^\d{1,5}$/u.test(trimmed) ? Number(trimmed) : 0;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return "The port needs to be a whole number from 1 to 65535.";
  try {
    await state.writeSettings({ enabled: settings.enabled, port });
    return settings.enabled ? `Moving remote access to port ${port}…` : `Port ${port} is ready for the next time remote access turns on.`;
  } catch {
    return "I couldn’t save that port. Check the Dock state directory and try again.";
  }
}

async function approvePendingDevice(
  terminal: HubProcessTerminal,
  state: RemoteAccessState,
  request: PendingPairing,
): Promise<string | undefined> {
  let error: string | undefined;
  while (true) {
    const pin = await promptHubText(
      terminal,
      `Connect ${request.deviceName}`,
      `${error ? `${error} · ` : ""}Type the 4-digit PIN shown on the device`,
    );
    if (pin === undefined) return undefined;
    if (!/^\d{4}$/u.test(pin.trim())) {
      error = "The PIN needs exactly four digits";
      continue;
    }
    try {
      await state.approvePairing(request.id, pin.trim());
      return `Just a moment — checking the PIN with ${request.deviceName}…`;
    } catch {
      return `${request.deviceName} is no longer waiting. Start pairing again on the device.`;
    }
  }
}

async function removePairedDevice(
  terminal: HubProcessTerminal,
  state: RemoteAccessState,
  client: TrustedClient,
): Promise<string | undefined> {
  const confirmation = await selectMenu(
    terminal,
    `Remove ${client.deviceName}?`,
    "It will lose remote access right away. You can pair it again later.",
    [
      { value: "confirm", label: "Remove Device", description: "Disconnect it and remove access" },
      { value: BACK, label: "Keep It", description: "Leave this device as it is" },
    ],
    "↑↓ choose · Enter confirm · Esc keep",
  );
  if (confirmation !== "confirm") return undefined;
  try {
    const removed = await state.revokeClient(client.fingerprint);
    return removed ? `${client.deviceName} has been removed.` : `${client.deviceName} was already gone.`;
  } catch {
    return `I couldn’t remove ${client.deviceName}. Check the Dock state directory and try again.`;
  }
}

async function showLocalAdminUnavailable(terminal: HubProcessTerminal, title: string): Promise<void> {
  await selectMenu(
    terminal,
    title,
    "Alu Dock’s settings aren’t available. Open it as the same user who runs the Host, then try again.",
    [{ value: BACK, label: "Back to Hub", description: "Return to the Hub" }],
    "Enter or Esc · back",
  );
}

async function promptHubText(
  terminal: HubProcessTerminal,
  title: string,
  placeholder: string,
  prefill?: string,
  options: { secret?: boolean; signal?: AbortSignal; context?: string } = {},
): Promise<string | undefined> {
  const tui = new TuiMainScreen(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const dialog = new ExtensionTextDialog({
    mode: options.secret ? "secret" : "input",
    title,
    placeholder: options.context ? `${options.context} · ${placeholder}` : placeholder,
    maxPlaceholderRows: options.context ? 12 : 2,
    ...(prefill === undefined ? {} : { prefill }),
    requestRender: () => tui.requestRender(),
    tui,
    maxRows: () => Math.max(6, terminal.rows - 4),
  });
  const layout = new HubMenuLayout(
    new AluHubBrand(),
    new Text("", 0, 0),
    dialog,
    new Text("", 0, 0),
    () => terminal.rows,
  );
  let settled = false;
  let started = false;
  let signalReceived = false;
  let resolveValue!: (value: string | undefined) => void;
  const value = new Promise<string | undefined>((resolveValuePromise) => { resolveValue = resolveValuePromise; });
  const finish = (result: string | undefined): void => {
    if (settled) return;
    settled = true;
    resolveValue(result);
  };
  const onSignal = (): void => {
    signalReceived = true;
    finish(undefined);
  };
  const onAbort = (): void => finish(undefined);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) finish(undefined);
  dialog.onSubmit = finish;
  dialog.onCancel = () => finish(undefined);
  const removeMouseListener = tui.addInputListener((data) => (
    parseTerminalMouseEvent(data) ? { consume: true } : undefined
  ));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  tui.addChild(layout);
  tui.setFocus(dialog);
  try {
    terminal.clearScreen();
    tui.start();
    started = true;
    return await value;
  } finally {
    removeMouseListener();
    if (started && !signalReceived) await terminal.drainInput(200, 30).catch(() => {});
    tui.stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function remoteAccessStatusSummary(settings: RemoteAccessSettings, status: RemoteAccessStatus | undefined): string {
  if (!status) {
    return settings.enabled
      ? `Remote access is enabled on port ${settings.port}; waiting for Alu Dock`
      : `Remote access is off · saved port ${settings.port}`;
  }
  if (status.state === "stopped") return "The Alu Dock service is stopped. Start it to apply these settings.";
  if (status.configRevision !== settings.revision) {
    return `${settings.enabled ? "Enabled" : "Disabled"} on port ${settings.port} · Alu Dock is applying this change`;
  }
  if (status.state === "listening") return `Remote access is ready · Port ${status.activePort ?? settings.port}`;
  if (status.state === "disabled") return `Remote access is off · saved port ${settings.port}`;
  if (status.message?.includes("EADDRINUSE") || status.message?.includes("address already in use")) {
    return `Port ${settings.port} is already in use. Choose another port or free it; this page will update automatically.`;
  }
  return "Remote access could not start. Check the Alu Dock service log or choose another port.";
}

function remainingTime(value: string): string {
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1_000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function chooseWorkspaceDirectory(
  terminal: HubProcessTerminal,
  client: DockClient,
  initialPath: string,
): Promise<string | undefined> {
  const tui = new TuiMainScreen(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const surface = new WorkspaceBrowserSurface({
    initialPath,
    terminalRows: () => terminal.rows,
    requestRender: () => tui.requestRender(),
  });
  const layout = new HubMenuLayout(
    new AluHubBrand(),
    new Text("", 0, 0),
    surface,
    new Text("", 0, 0),
    () => terminal.rows,
  );
  let settled = false;
  let started = false;
  let signalReceived = false;
  let loadVersion = 0;
  let resolveSelection!: (selection: string | undefined) => void;
  const selection = new Promise<string | undefined>((resolveSelectionPromise) => { resolveSelection = resolveSelectionPromise; });
  const finish = (value: string | undefined): void => {
    if (settled) return;
    settled = true;
    loadVersion += 1;
    resolveSelection(value);
  };
  const loadPath = (path: string): void => {
    const version = ++loadVersion;
    surface.setLoading();
    void collectWorkspaceDirectory((cursor, limit) => client.workspaceList(path, cursor, limit))
      .then((listing) => {
        if (settled || version !== loadVersion) return;
        surface.replaceDirectory(listing);
      })
      .catch((error: unknown) => {
        if (settled || version !== loadVersion) return;
        surface.setError(workspaceBrowserErrorMessage(error));
      });
  };
  surface.onOpenPath = loadPath;
  surface.onConfirm = finish;
  surface.onCancel = () => finish(undefined);
  const onSignal = (): void => {
    signalReceived = true;
    finish(undefined);
  };
  const removeMouseListener = tui.addInputListener((data) => {
    const event = parseTerminalMouseEvent(data);
    if (!event) return undefined;
    if (event.kind === "wheel") {
      surface.handleInput(event.direction === "up" ? "\u001b[A" : "\u001b[B");
      tui.requestRender();
    }
    return { consume: true };
  });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  tui.addChild(layout);
  tui.setFocus(surface);
  try {
    terminal.clearScreen();
    tui.start();
    started = true;
    loadPath(initialPath);
    return await selection;
  } finally {
    removeMouseListener();
    if (started && !signalReceived) await terminal.drainInput(200, 30).catch(() => {});
    tui.stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

interface LiveMenuModel<T> {
  data: T;
  subtitle: string;
  entries: readonly DockHubEntry[];
  preferredValue?: string;
}

interface LiveMenuSelection<T> {
  value: string | undefined;
  data: T;
}

class LiveSelectList implements Component {
  private list: SelectList;
  private items: SelectItem[] = [];

  private selectHandler?: (item: SelectItem) => void;
  private cancelHandler?: () => void;

  set onSelect(handler: ((item: SelectItem) => void) | undefined) {
    this.selectHandler = handler;
    this.list.onSelect = handler;
  }

  set onCancel(handler: (() => void) | undefined) {
    this.cancelHandler = handler;
    this.list.onCancel = handler;
  }

  constructor(entries: readonly DockHubEntry[], preferredValue?: string) {
    this.list = new SelectList([], 1, selectListTheme);
    this.replace(entries, preferredValue);
  }

  get itemCount(): number { return this.items.length; }

  get selectedIndex(): number {
    const selected = this.list.getSelectedItem();
    return selected ? Math.max(0, this.items.findIndex((item) => item.value === selected.value)) : 0;
  }

  replace(entries: readonly DockHubEntry[], preferredValue?: string): void {
    const previousValue = preferredValue ?? this.list.getSelectedItem()?.value;
    this.items = entries.map((entry) => ({
      value: entry.value,
      label: terminalSafe(entry.label),
      description: terminalSafe(entry.description),
    }));
    this.list = new SelectList(this.items, Math.min(Math.max(this.items.length, 1), 12), selectListTheme);
    this.list.onSelect = this.selectHandler;
    this.list.onCancel = this.cancelHandler;
    const selectedIndex = previousValue === undefined ? -1 : this.items.findIndex((item) => item.value === previousValue);
    if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
  }

  setSelectedIndex(index: number): void { this.list.setSelectedIndex(index); }
  handleInput(data: string): void { this.list.handleInput(data); }
  invalidate(): void { this.list.invalidate(); }
  render(width: number): string[] { return this.list.render(width); }
}

async function selectLiveMenu<T>(
  terminal: HubProcessTerminal,
  title: string,
  load: (previous: T | undefined) => Promise<LiveMenuModel<T>>,
  hint: string,
): Promise<LiveMenuSelection<T>> {
  let current = await load(undefined);
  const tui = new TuiMainScreen(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const list = new LiveSelectList(current.entries, current.preferredValue);
  const heading = new Text(`${paint.bold(paint.accent(terminalSafe(title)))}\n${paint.muted(terminalSafe(current.subtitle))}`, 1, 0);
  const footer = new Text(paint.muted(`  ${terminalSafe(hint)}`), 0, 0);
  const brand = new AluHubBrand();
  const layout = new HubMenuLayout(
    brand,
    heading,
    list,
    footer,
    () => terminal.rows,
    () => visibleHubItemIndices(list.itemCount, Math.min(Math.max(list.itemCount, 1), 12), list.selectedIndex),
  );
  let settled = false;
  let started = false;
  let signalReceived = false;
  let refreshing = false;
  let refreshError: unknown;
  let resolveSelection!: (selection: string | undefined) => void;
  const selection = new Promise<string | undefined>((resolveSelectionPromise) => { resolveSelection = resolveSelectionPromise; });
  const finish = (value: string | undefined): void => {
    if (settled) return;
    settled = true;
    resolveSelection(value);
  };
  const refresh = async (): Promise<void> => {
    if (settled || refreshing) return;
    refreshing = true;
    try {
      const next = await load(current.data);
      if (settled) return;
      current = next;
      heading.setText(`${paint.bold(paint.accent(terminalSafe(title)))}\n${paint.muted(terminalSafe(current.subtitle))}`);
      list.replace(current.entries, current.preferredValue);
      tui.requestRender();
    } catch (error) {
      refreshError = error;
      finish(undefined);
    } finally {
      refreshing = false;
    }
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
  const poll = setInterval(() => { void refresh(); }, 200);
  poll.unref?.();
  try {
    terminal.clearScreen();
    tui.start();
    started = true;
    blink.start();
    const value = await selection;
    if (refreshError !== undefined) throw refreshError;
    return { value, data: current.data };
  } finally {
    clearInterval(poll);
    blink.stop();
    removeMouseListener();
    if (started && !signalReceived) await terminal.drainInput(200, 30).catch(() => {});
    tui.stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function selectMenu(
  terminal: HubProcessTerminal,
  title: string,
  subtitle: string,
  entries: readonly DockHubEntry[],
  hint: string,
): Promise<string | undefined> {
  const tui = new TuiMainScreen(terminal, process.env.PI_HARDWARE_CURSOR === "1");
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
