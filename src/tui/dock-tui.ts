import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
} from "@earendil-works/pi-tui";

import { ControlClientError, DockClient, type EventSubscription } from "../control/dock-client.js";
import type { CommandDto, SettingDto } from "../core/config-projection.js";
import type { DeliveryMode, DockEvent, InstanceSnapshot } from "../core/managed-instance.js";
import type {
  RuntimeModelInfo,
  RuntimeThinkingLevel,
} from "../core/runtime-session.js";
import { DockConversation, DockStatusLine } from "./conversation.js";
import { editorTheme, paint, selectListTheme } from "./theme.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly RuntimeThinkingLevel[];

export type DockTuiExitReason = "detached" | "stopped" | "signal";

export interface DockTuiResult {
  reason: DockTuiExitReason;
  instance: InstanceSnapshot;
  cleanupErrors?: string[];
}

export async function runDockTui(
  client: DockClient,
  initialInstance: InstanceSnapshot,
): Promise<DockTuiResult> {
  assertInteractiveTerminal();

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const conversation = new DockConversation();
  let instance = initialInstance;
  const status = new DockStatusLine(instance);
  let subscription: EventSubscription | undefined;
  let cleanupErrors: string[] | undefined;
  let editor!: Editor;
  let settings: SettingDto[] = [];
  let commands: CommandDto[] = [];
  let terminalProgressEnabled = false;
  let resolveExit!: (reason: DockTuiExitReason) => void;
  let exiting = false;
  const exit = new Promise<DockTuiExitReason>((resolve) => {
    resolveExit = resolve;
  });

  const finish = (reason: DockTuiExitReason): void => {
    if (exiting) return;
    exiting = true;
    resolveExit(reason);
  };

  const onEvent = (event: DockEvent): void => {
    conversation.apply(event);
    instance = projectSnapshot(instance, event);
    status.update(instance);
    const activity = activityForEvent(event);
    if (activity) status.setActivity(activity);
    if (event.type === "settings.changed") applyLiveSetting(event.data.key, event.data.value);
    if (event.type === "instance.stopped" && editor) editor.disableSubmit = true;
    updateTerminalProgress();
    tui.requestRender();
  };

  subscription = await client.streamEvents(instance.id, { onEvent, requireTuiProjection: true });
  instance = subscription.initial.instance;
  conversation.applyHistory(subscription.initial.recentHistory, subscription.initial.historyTruncated);
  conversation.applyReplay(
    subscription.initial.page.events,
    subscription.initial.page.truncated,
  );
  status.update(instance);
  status.setController(subscription.initial.controller.status);

  const [settingsLoad, commandsLoad] = await Promise.allSettled([
    client.settings(instance.id),
    client.commands(instance.id),
  ]);
  if (settingsLoad.status === "fulfilled") settings = settingsLoad.value.settings;
  else conversation.addNotice(`Settings unavailable: ${errorText(settingsLoad.reason)}`, true);
  if (commandsLoad.status === "fulfilled") commands = commandsLoad.value.commands;
  else conversation.addNotice(`Command catalog unavailable: ${errorText(commandsLoad.reason)}`, true);

  const title = new Text(
    `${paint.bold(paint.accent("Alu Dock"))} ${paint.muted("— Host-owned Pi over SSH")}`,
    1,
    1,
  );
  const help = new Text(
    paint.muted("  Enter send/steer · Alt+Enter follow-up · Esc abort · Ctrl+O tools · Ctrl+D detach"),
    0,
    0,
  );
  editor = new Editor(tui, editorTheme, {
    paddingX: numericSetting(settings, "editorPaddingX", 1),
    autocompleteMaxVisible: numericSetting(settings, "autocompleteMaxVisible", 10),
  });
  tui.setShowHardwareCursor(booleanSetting(settings, "showHardwareCursor", process.env.PI_HARDWARE_CURSOR === "1"));
  tui.setClearOnShrink(booleanSetting(settings, "clearOnShrink", true));
  terminalProgressEnabled = booleanSetting(settings, "showTerminalProgress", true);
  conversation.setHideThinking(booleanSetting(settings, "hideThinking", false));
  conversation.setOutputPadding(numericSetting(settings, "outputPad", 1));
  status.setAutoCompaction(booleanSetting(settings, "autoCompaction", true));
  const autocompleteCommands = commandCatalog(commands).map((command) => {
    if (command.name === "thinking") {
      return {
        ...command,
        getArgumentCompletions: (prefix: string) => THINKING_LEVELS
          .filter((level) => level.startsWith(prefix))
          .map((level) => ({ value: level, label: level })),
      };
    }
    if (command.name === "model") {
      return {
        ...command,
        getArgumentCompletions: async (prefix: string) => {
          try {
            const result = await client.models(instance.id);
            return result.models
              .map((model) => ({
                value: `${terminalSafe(model.provider)}/${terminalSafe(model.id)}`,
                label: terminalSafe(model.name),
                description: `${terminalSafe(model.provider)}/${terminalSafe(model.id)}`,
              }))
              .filter((model) => model.value.toLowerCase().includes(prefix.toLowerCase()));
          } catch {
            return null;
          }
        },
      };
    }
    return command;
  });
  editor.setAutocompleteProvider(new TerminalSafeAutocompleteProvider(new CombinedAutocompleteProvider(autocompleteCommands, instance.cwd)));
  editor.onSubmit = (text) => {
    if (!text) return;
    editor.addToHistory(text);
    void handleInput(text);
  };

  async function handleInput(text: string): Promise<void> {
    if (text === "/detach" || text === "/quit" || text === "/exit") {
      finish("detached");
      return;
    }
    if (text === "/help") {
      conversation.addNotice(
        "Commands: /model [PROVIDER/MODEL], /thinking [LEVEL], /follow MESSAGE, /steer MESSAGE, /abort, /status, /stop, /detach",
      );
      tui.requestRender();
      return;
    }
    if (text === "/model") {
      await chooseModel();
      return;
    }
    const modelTarget = commandMessage(text, "/model");
    if (modelTarget !== undefined) {
      const parsed = parseModelTarget(modelTarget);
      if (!parsed) {
        conversation.addNotice("Usage: /model PROVIDER/MODEL", true);
        tui.requestRender();
        return;
      }
      await switchModel(parsed.provider, parsed.id);
      return;
    }
    if (text === "/thinking") {
      await showThinkingLevels();
      return;
    }
    const thinkingTarget = commandMessage(text, "/thinking");
    if (thinkingTarget !== undefined) {
      if (!isThinkingLevel(thinkingTarget)) {
        conversation.addNotice("Thinking level must be off, minimal, low, medium, high, xhigh, or max", true);
        tui.requestRender();
        return;
      }
      await switchThinking(thinkingTarget);
      return;
    }
    if (text === "/status") {
      await refreshStatus();
      return;
    }
    if (text === "/abort") {
      await abortRun();
      return;
    }
    if (text === "/stop") {
      editor.disableSubmit = true;
      status.setActivity("stopping");
      tui.requestRender();
      try {
        const result = await client.stop(instance.id);
        instance = result.instance;
        status.update(instance);
        cleanupErrors = result.receipt.cleanupErrors;
        finish("stopped");
      } catch (error) {
        editor.disableSubmit = false;
        showError(error);
      }
      return;
    }

    const follow = commandMessage(text, "/follow");
    const steer = commandMessage(text, "/steer");
    if (text.startsWith("/follow") && follow === undefined) {
      conversation.addNotice("Usage: /follow MESSAGE", true);
      tui.requestRender();
      return;
    }
    if (text.startsWith("/steer") && steer === undefined) {
      conversation.addNotice("Usage: /steer MESSAGE", true);
      tui.requestRender();
      return;
    }
    await sendPrompt(follow ?? steer ?? text, follow !== undefined ? "followUp" : steer !== undefined ? "steer" : "auto");
  }

  async function sendPrompt(message: string, delivery: DeliveryMode): Promise<void> {
    editor.disableSubmit = true;
    status.setActivity("sending");
    tui.requestRender();
    try {
      const result = await client.prompt(instance.id, message, delivery);
      instance = result.instance;
      status.update(instance);
      status.setActivity(`${result.receipt.delivery}${result.receipt.queued ? " queued" : " accepted"}`);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function abortRun(): Promise<void> {
    if (instance.execution !== "running") {
      status.setActivity("nothing to abort");
      tui.requestRender();
      return;
    }
    editor.disableSubmit = true;
    status.setActivity("aborting");
    tui.requestRender();
    try {
      const result = await client.abort(instance.id);
      instance = result.instance;
      status.update(instance);
      status.setActivity("operation cancelled · instance reusable");
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function chooseModel(): Promise<void> {
    editor.disableSubmit = true;
    status.setActivity("loading models");
    tui.requestRender();
    try {
      const catalog = await client.models(instance.id);
      instance = catalog.instance;
      status.update(instance);
      const selected = await showModelPicker(catalog.models);
      if (selected) await switchModel(selected.provider, selected.id);
      else status.setActivity("model unchanged");
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  async function showModelPicker(models: RuntimeModelInfo[]): Promise<RuntimeModelInfo | undefined> {
    if (models.length === 0) {
      conversation.addNotice("Pi reported no models with configured authentication.", true);
      return undefined;
    }
    const byKey = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
    const list = new SelectList(
      models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: terminalSafe(model.name),
        description: `${terminalSafe(model.provider)}/${terminalSafe(model.id)}${model.reasoning ? " · reasoning" : ""}`,
      })),
      Math.min(models.length, 12),
      selectListTheme,
    );
    const currentKey = instance.executor.model
      ? `${instance.executor.model.provider}/${instance.executor.model.id}`
      : undefined;
    const currentIndex = currentKey ? models.findIndex((model) => `${model.provider}/${model.id}` === currentKey) : -1;
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex);

    const panel = new Container();
    panel.addChild(new Text(paint.bold(paint.accent("Select Pi model")), 1, 1));
    panel.addChild(list);
    panel.addChild(new Text(paint.muted("↑↓ choose · Enter switch · Esc cancel"), 1, 1));
    const component: Component = {
      render: (width) => panel.render(width),
      invalidate: () => panel.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };

    let resolveModel!: (model: RuntimeModelInfo | undefined) => void;
    const selection = new Promise<RuntimeModelInfo | undefined>((resolve) => {
      resolveModel = resolve;
    });
    list.onSelect = (item) => resolveModel(byKey.get(item.value));
    list.onCancel = () => resolveModel(undefined);
    const overlay = tui.showOverlay(component, {
      width: "80%",
      minWidth: 40,
      maxHeight: "80%",
      anchor: "center",
      margin: 1,
    });
    try {
      return await selection;
    } finally {
      overlay.hide();
    }
  }

  async function switchModel(provider: string, modelId: string): Promise<void> {
    editor.disableSubmit = true;
    status.setActivity(`switching to ${provider}/${modelId}`);
    tui.requestRender();
    try {
      const result = await client.setModel(instance.id, provider, modelId);
      instance = result.instance;
      status.update(instance);
      status.setActivity(`model ${modelId}`);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function showThinkingLevels(): Promise<void> {
    status.setActivity("loading thinking levels");
    tui.requestRender();
    try {
      const result = await client.models(instance.id);
      instance = result.instance;
      status.update(instance);
      conversation.addNotice(
        `Thinking: ${instance.executor.thinkingLevel ?? "unknown"}. Available: ${result.availableThinkingLevels.join(", ")}`,
      );
      status.setActivity("thinking shown");
    } catch (error) {
      showError(error);
    }
    tui.requestRender();
  }

  async function switchThinking(level: RuntimeThinkingLevel): Promise<void> {
    editor.disableSubmit = true;
    status.setActivity(`thinking ${level}`);
    tui.requestRender();
    try {
      const result = await client.setThinking(instance.id, level);
      instance = result.instance;
      status.update(instance);
      status.setActivity(`thinking ${instance.executor.thinkingLevel ?? level}`);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function refreshStatus(): Promise<void> {
    status.setActivity("refreshing");
    tui.requestRender();
    try {
      instance = await client.status(instance.id);
      status.update(instance);
      status.setActivity("status refreshed");
    } catch (error) {
      showError(error);
    }
    tui.requestRender();
  }

  function showError(error: unknown): void {
    const message = error instanceof ControlClientError
      ? `${error.code}: ${error.message}`
      : errorText(error);
    conversation.addNotice(message, true);
    status.setActivity("error");
    tui.requestRender();
  }

  function applyLiveSetting(key: string, value: unknown): void {
    const previous = settings.find((setting) => setting.key === key);
    if (previous) settings = settings.map((setting) => setting === previous ? { ...setting, value } as SettingDto : setting);
    if (key === "hideThinking" && typeof value === "boolean") conversation.setHideThinking(value);
    if (key === "outputPad" && typeof value === "number") conversation.setOutputPadding(value);
    if (key === "editorPaddingX" && typeof value === "number" && editor) editor.setPaddingX(value);
    if (key === "autocompleteMaxVisible" && typeof value === "number" && editor) editor.setAutocompleteMaxVisible(value);
    if (key === "showHardwareCursor" && typeof value === "boolean") tui.setShowHardwareCursor(value);
    if (key === "clearOnShrink" && typeof value === "boolean") tui.setClearOnShrink(value);
    if (key === "showTerminalProgress" && typeof value === "boolean") {
      terminalProgressEnabled = value;
      updateTerminalProgress();
    }
    if (key === "autoCompaction" && typeof value === "boolean") status.setAutoCompaction(value);
  }

  function updateTerminalProgress(): void {
    terminal.setProgress(terminalProgressEnabled && instance.lifecycle === "active" && instance.execution === "running");
  }

  tui.addChild(title);
  tui.addChild(conversation);
  tui.addChild(status);
  tui.addChild(help);
  tui.addChild(editor);
  tui.setFocus(editor);
  terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);

  const removeInputListener = tui.addInputListener((data) => {
    if (tui.hasOverlay()) return undefined;
    if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
      finish("detached");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      const expanded = conversation.toggleToolsExpanded();
      status.setActivity(expanded ? "tool output expanded" : "tool output collapsed");
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "alt+enter")) {
      if (!editor.disableSubmit && editor.getText().trim().length > 0) {
        const message = editor.getExpandedText().trim();
        editor.setText("");
        editor.addToHistory(message);
        void sendPrompt(message, "followUp");
      }
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (editor.isShowingAutocomplete()) return undefined;
      if (instance.execution === "running") {
        void abortRun();
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (editor.getText().length > 0) {
        editor.setText("");
        status.setActivity("input cleared");
      } else if (instance.execution === "running") {
        void abortRun();
      } else {
        status.setActivity("Ctrl+D detaches");
      }
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  const onSigint = (): void => finish("signal");
  const onSigterm = (): void => finish("signal");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  void subscription.done.then(() => {
    if (exiting) return;
    editor.disableSubmit = true;
    terminal.setProgress(false);
    status.setConnection("disconnected");
    status.setActivity("host stream closed · Ctrl+D detach");
    conversation.addNotice("Host event stream closed. No command was replayed; this TUI is now read-only.", true);
    tui.requestRender();
  }).catch((error: unknown) => {
    if (exiting) return;
    editor.disableSubmit = true;
    terminal.setProgress(false);
    status.setConnection("lost");
    conversation.addNotice("Host connection lost. No command was replayed; this TUI is now read-only.", true);
    showError(error);
  });

  tui.start();
  updateTerminalProgress();
  const reason = await exit;

  removeInputListener();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  subscription.close();
  await subscription.done.catch(() => {});
  terminal.setProgress(false);
  await terminal.drainInput(200, 30).catch(() => {});
  tui.stop();

  return { reason, instance, cleanupErrors };
}

function assertInteractiveTerminal(): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("The Alu Dock interactive client requires a TTY; use list/status/events for JSON output");
  }
}

function commandMessage(input: string, command: string): string | undefined {
  if (!input.startsWith(`${command} `)) return undefined;
  const message = input.slice(command.length + 1).trim();
  return message.length > 0 ? message : undefined;
}

function activityForEvent(event: DockEvent): string | undefined {
  switch (event.type) {
    case "run.started": return "running";
    case "message.delta": return "streaming";
    case "tool.started": return `tool ${stringData(event, "toolName") ?? "running"}`;
    case "run.retry_started": return "retrying";
    case "run.settled": return stringData(event, "result") ?? "settled";
    case "model.changed": return `model ${stringData(event, "id") ?? "changed"}`;
    case "thinking.changed": return `thinking ${stringData(event, "thinkingLevel") ?? "changed"}`;
    case "queue.changed": return "queue updated";
    case "compaction.started": return "compacting";
    case "compaction.completed": return event.data.error ? "compaction failed" : "compacted";
    case "session.replaced": return `session ${event.data.reason}`;
    case "instance.stopped": return "stopped";
    case "instance.runtime_error":
    case "instance.error": return "error";
    default: return undefined;
  }
}

export function projectSnapshot(snapshot: InstanceSnapshot, event: DockEvent): InstanceSnapshot {
  if (event.type === "session.metrics_changed") {
    return {
      ...snapshot,
      metrics: structuredClone(event.data.metrics),
      updatedAt: event.occurredAt,
      eventCursor: { ...snapshot.eventCursor, sequence: Math.max(snapshot.eventCursor.sequence, event.sequence) },
    };
  }
  if (event.type === "extension.status_changed") {
    const extensionStatus = { ...snapshot.extensionStatus };
    if (event.data.text === undefined) delete extensionStatus[event.data.key];
    else extensionStatus[event.data.key] = event.data.text;
    return {
      ...snapshot,
      extensionStatus,
      updatedAt: event.occurredAt,
      eventCursor: { ...snapshot.eventCursor, sequence: Math.max(snapshot.eventCursor.sequence, event.sequence) },
    };
  }
  if (event.type === "session.info_changed") {
    return {
      ...snapshot,
      name: event.data.name,
      updatedAt: event.occurredAt,
      eventCursor: { ...snapshot.eventCursor, sequence: Math.max(snapshot.eventCursor.sequence, event.sequence) },
    };
  }
  if (event.type === "session.replaced") {
    return {
      ...snapshot,
      cwd: event.data.cwd,
      runtimeGeneration: event.data.runtimeGeneration,
      executor: { ...snapshot.executor, piSessionId: event.data.piSessionId, sessionFile: event.data.sessionFile },
      updatedAt: event.occurredAt,
      eventCursor: {
        ...snapshot.eventCursor,
        runtimeGeneration: event.data.runtimeGeneration,
        sequence: event.sequence,
      },
    };
  }
  if (event.type === "model.changed") {
    const provider = stringData(event, "provider");
    const id = stringData(event, "id");
    const thinkingLevel = thinkingData(event, "thinkingLevel") ?? snapshot.executor.thinkingLevel;
    return {
      ...snapshot,
      executor: {
        ...snapshot.executor,
        model: provider && id ? { provider, id } : snapshot.executor.model,
        thinkingLevel,
      },
      updatedAt: event.occurredAt,
      eventCursor: { ...snapshot.eventCursor, sequence: Math.max(snapshot.eventCursor.sequence, event.sequence) },
    };
  }
  if (event.type === "thinking.changed") {
    return {
      ...snapshot,
      executor: {
        ...snapshot.executor,
        thinkingLevel: thinkingData(event, "thinkingLevel") ?? snapshot.executor.thinkingLevel,
      },
      updatedAt: event.occurredAt,
      eventCursor: { ...snapshot.eventCursor, sequence: Math.max(snapshot.eventCursor.sequence, event.sequence) },
    };
  }
  if (event.type !== "instance.state_changed") {
    if (event.type === "instance.stopped") {
      return { ...snapshot, lifecycle: "stopped", execution: "unavailable", ownerHostEpoch: undefined, updatedAt: event.occurredAt };
    }
    return { ...snapshot, eventCursor: { ...snapshot.eventCursor, sequence: Math.max(snapshot.eventCursor.sequence, event.sequence) } };
  }

  const lifecycle = enumData(event, "lifecycle", ["active", "stopping", "stopped"] as const)
    ?? snapshot.lifecycle;
  const execution = enumData(event, "execution", ["idle", "running", "failed", "unavailable"] as const)
    ?? snapshot.execution;
  const lastRun = enumData(event, "lastRun", ["never", "succeeded", "failed", "aborted", "interrupted"] as const)
    ?? snapshot.lastRun;
  const pending = pendingData(event) ?? snapshot.pending;
  const lastError = stringData(event, "lastError");
  const activeCommandId = stringData(event, "activeCommandId");
  return {
    ...snapshot,
    lifecycle,
    execution,
    lastRun,
    pending,
    activeCommandId,
    lastError,
    updatedAt: event.occurredAt,
    eventCursor: { ...snapshot.eventCursor, sequence: Math.max(snapshot.eventCursor.sequence, event.sequence) },
  };
}

function enumData<const T extends readonly string[]>(
  event: DockEvent,
  key: string,
  values: T,
): T[number] | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && values.includes(value) ? value as T[number] : undefined;
}

function stringData(event: DockEvent, key: string): string | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function pendingData(event: DockEvent): InstanceSnapshot["pending"] | undefined {
  const value = (event.data as unknown as Record<string, unknown>).pending;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pending = value as Record<string, unknown>;
  return typeof pending.steering === "number" && typeof pending.followUp === "number" && typeof pending.total === "number"
    ? { steering: pending.steering, followUp: pending.followUp, total: pending.total }
    : undefined;
}

function numberData(event: DockEvent, key: string): number | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function parseModelTarget(value: string): { provider: string; id: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

function isThinkingLevel(value: string): value is RuntimeThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

function thinkingData(event: DockEvent, key: string): RuntimeThinkingLevel | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && isThinkingLevel(value) ? value : undefined;
}

function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

class TerminalSafeAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters: string[] | undefined;

  constructor(private readonly inner: AutocompleteProvider) {
    this.triggerCharacters = inner.triggerCharacters;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const suggestions = await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    if (!suggestions) return null;
    const items = suggestions.items
      .filter((item) => terminalSafe(item.value) === item.value)
      .map((item) => ({
        ...item,
        label: terminalSafe(item.label),
        ...(item.description === undefined ? {} : { description: terminalSafe(item.description) }),
      }));
    return items.length === 0 ? null : { ...suggestions, items };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
  }
}

function booleanSetting(settings: SettingDto[], key: SettingDto["key"], fallback: boolean): boolean {
  const value = settings.find((setting) => setting.key === key)?.value;
  return typeof value === "boolean" ? value : fallback;
}

function numericSetting(settings: SettingDto[], key: SettingDto["key"], fallback: number): number {
  const value = settings.find((setting) => setting.key === key)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function commandCatalog(commands: CommandDto[]): Array<{ name: string; description: string; argumentHint?: string }> {
  const catalog = new Map<string, { name: string; description: string; argumentHint?: string }>();
  for (const command of commands) {
    const name = terminalSafe(command.name);
    if (name.length === 0 || /\s|\//u.test(name)) continue;
    catalog.set(name, {
      name,
      description: terminalSafe(command.description ?? `${command.source.kind} command`),
      ...(command.argumentCompletions ? { argumentHint: "arguments" } : {}),
    });
  }
  const dockCommands = [
    { name: "abort", description: "abort the current run; keep the instance reusable" },
    { name: "detach", description: "leave the TUI without stopping the instance" },
    { name: "follow", description: "queue a follow-up message", argumentHint: "MESSAGE" },
    { name: "help", description: "show Dock commands" },
    { name: "model", description: "choose or set provider/model", argumentHint: "PROVIDER/MODEL" },
    { name: "status", description: "refresh instance status" },
    { name: "steer", description: "steer the current run", argumentHint: "MESSAGE" },
    { name: "stop", description: "stop and dispose the instance" },
    { name: "thinking", description: "show or set thinking level", argumentHint: "LEVEL" },
  ];
  for (const command of dockCommands) catalog.set(command.name, command);
  return [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function errorText(error: unknown): string {
  return error instanceof Error ? terminalSafe(error.message) : terminalSafe(String(error));
}
