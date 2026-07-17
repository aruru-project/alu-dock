import { randomUUID } from "node:crypto";

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  matchesKey,
  Text,
  TUI,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import { ControlClientError, DockClient, type EventSubscription } from "../control/dock-client.js";
import type { InteractionResponse } from "../core/extension-ui-broker.js";
import type { CommandDto, SettingDto, SettingUpdate } from "../core/config-projection.js";
import type { DeliveryMode, DockEvent, EventCursor, InstanceSnapshot, PendingMessageDto, TreeNodeDto } from "../core/managed-instance.js";
import type {
  RuntimeModelInfo,
  RuntimeThinkingLevel,
} from "../core/runtime-session.js";
import type { ProjectTrustChoice } from "../control/project-trust.js";
import { ActivityPulseController } from "./activity-pulse.js";
import { DockActivityLine, DockConversation, DockStatusLine } from "./conversation.js";
import { ExtensionTextDialog } from "./extension-text-dialog.js";
import { PagedHistoryWindow, HISTORY_PAGE_SIZE } from "./history-pagination.js";
import { DockMouseTrackingMode, DockProcessTerminal, parseMouseWheel } from "./mouse-input.js";
import { PendingQueueTray } from "./pending-queue.js";
import { prependRestoredQueueText } from "./queue-restoration.js";
import { FixedDockScreen } from "./pi-tui-screen.js";
import {
  abortingActivity,
  activityFromReplay,
  activityFromSnapshot,
  disconnectedActivity,
  errorActivity,
  reduceRunActivity,
  submittingActivity,
} from "./run-activity.js";
import { SearchablePicker } from "./searchable-picker.js";
import { projectSnapshot } from "./snapshot-projection.js";
import {
  collectSessionTree,
  filterSessionTree,
  isTreeFilterMode,
  parseTreeNavigationCommand,
  treePickerItems,
  type TreeFilterMode,
} from "./session-tree.js";
import {
  formatSettingValue,
  parseSettingCommandValue,
  settingChoiceValue,
  settingCompletions,
  settingValueChoices,
} from "./settings-controls.js";
import { editorTheme, paint } from "./theme.js";

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

  const terminal = new DockProcessTerminal();
  const tui = new TUI(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const conversation = new DockConversation();
  const historyWindow = new PagedHistoryWindow();
  const pendingQueue = new PendingQueueTray();
  const dockMouseTracking = new DockMouseTrackingMode();
  const activity = new DockActivityLine();
  let instance = initialInstance;
  const status = new DockStatusLine(instance);
  let runActivity = activityFromSnapshot(instance);
  activity.setActivity(runActivity);
  let subscription: EventSubscription | undefined;
  let controllerLeaseToken: string | undefined;
  let activeExtensionDialog: { interactionId: string; closeFromHost: () => void } | undefined;
  let lastEventGeneration = instance.runtimeGeneration;
  let lastEventSequence = instance.eventCursor.sequence;
  let controllerReattach: Promise<void> | undefined;
  let cleanupErrors: string[] | undefined;
  let editor!: Editor;
  let screen: FixedDockScreen | undefined;
  let settings: SettingDto[] = [];
  let commands: CommandDto[] = [];
  let terminalProgressEnabled = false;
  let replacementHistoryGeneration: number | undefined;
  let replacementBufferedEvents: DockEvent[] = [];
  let navigationHistoryToken: string | undefined;
  let navigationBufferedEvents: DockEvent[] = [];
  let treeNavigationPending = false;
  let treeNavigationAbortPending = false;
  let treeNavigationAbortRequested = false;
  let earlierHistoryLoad: Promise<void> | undefined;
  let latestHistoryReload: Promise<void> | undefined;
  let resolveExit!: (reason: DockTuiExitReason) => void;
  let lastIdleEscapeAt = 0;
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
    if (event.runtimeGeneration < lastEventGeneration) return;
    if (event.runtimeGeneration === lastEventGeneration && event.sequence <= lastEventSequence) return;
    lastEventGeneration = event.runtimeGeneration;
    lastEventSequence = event.sequence;
    instance = projectSnapshot(instance, event);
    status.update(instance);
    pendingQueue.apply(event);
    runActivity = reduceRunActivity(runActivity, event, instance);
    activity.setActivity(runActivity);
    if (event.type === "session.replaced") {
      activeExtensionDialog?.closeFromHost();
      controllerLeaseToken = undefined;
      status.setController("unavailable");
      void reacquireController({ ...instance.eventCursor });
      navigationHistoryToken = undefined;
      navigationBufferedEvents = [];
      historyWindow.invalidate(event.runtimeGeneration);
      replacementHistoryGeneration = event.runtimeGeneration;
      replacementBufferedEvents = [event];
      conversation.reset();
      screen?.scrollToBottom();
      conversation.addNotice("Loading replacement session history…");
      terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);
      void refreshReplacementProjection(event.runtimeGeneration, { ...instance.eventCursor });
    } else if (replacementHistoryGeneration === event.runtimeGeneration) {
      replacementBufferedEvents.push(event);
    } else if (event.type === "session.navigated") {
      const token = `${event.runtimeGeneration}:${event.sequence}`;
      historyWindow.invalidate(event.runtimeGeneration);
      navigationHistoryToken = token;
      navigationBufferedEvents = [event];
      conversation.addNotice("Loading navigated branch history…");
      void refreshNavigationProjection(token, event.runtimeGeneration);
    } else if (navigationHistoryToken !== undefined && event.runtimeGeneration === instance.runtimeGeneration) {
      navigationBufferedEvents.push(event);
    } else {
      conversation.apply(event);
    }
    if (event.type === "interaction.requested") void handleExtensionInteraction(event);
    if ((event.type === "interaction.cancelled" || event.type === "interaction.resolved") && activeExtensionDialog?.interactionId === event.data.interactionId) {
      activeExtensionDialog.closeFromHost();
    }
    if (event.type === "settings.changed") applyLiveSetting(event.data.key, event.data.value);
    if (event.type === "session.info_changed") terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);
    if (event.type === "instance.stopped" && editor) editor.disableSubmit = true;
    updateTerminalProgress();
    tui.requestRender();
  };

  subscription = await client.streamEvents(instance.id, { onEvent, requireTuiProjection: true, claimController: true });
  instance = subscription.initial.instance;
  lastEventGeneration = subscription.initial.page.latest.runtimeGeneration;
  lastEventSequence = subscription.initial.page.latest.sequence;
  historyWindow.reset(
    subscription.initial.recentHistory,
    subscription.initial.historyTruncated,
    subscription.initial.instance.runtimeGeneration,
  );
  conversation.replacePagedHistory(historyWindow.snapshot());
  pendingQueue.reset(subscription.initial.pendingMessages);
  conversation.applyReplay(
    subscription.initial.page.events,
    subscription.initial.page.truncated,
  );
  status.update(instance);
  runActivity = activityFromReplay(instance, subscription.initial.page.events);
  activity.setActivity(runActivity);
  controllerLeaseToken = subscription.initial.controller.status === "acquired"
    ? subscription.initial.controller.leaseToken
    : undefined;
  status.setController(subscription.initial.controller.status);

  function reacquireController(since: EventCursor): Promise<void> {
    if (controllerReattach) return controllerReattach;
    const previous = subscription;
    if (!previous) return Promise.resolve();
    const task = (async () => {
      try {
        const next = await client.streamEvents(instance.id, {
          since,
          onEvent,
          requireTuiProjection: true,
          claimController: true,
        });
        if (exiting || subscription !== previous) {
          next.close();
          await next.done.catch(() => {});
          return;
        }
        subscription = next;
        controllerLeaseToken = next.initial.controller.status === "acquired"
          ? next.initial.controller.leaseToken
          : undefined;
        status.setController(next.initial.controller.status);
        watchEventSubscription(next);
        for (const event of next.initial.page.events) onEvent(event);
        pendingQueue.reset(next.initial.pendingMessages);
        previous.close();
        tui.requestRender();
      } catch (error) {
        if (exiting) return;
        controllerLeaseToken = undefined;
        status.setController("unavailable");
        conversation.addNotice(`Controller reattach failed: ${errorText(error)}`, true);
        tui.requestRender();
      }
    })();
    const tracked = task.finally(() => {
      if (controllerReattach === tracked) controllerReattach = undefined;
    });
    controllerReattach = tracked;
    return tracked;
  }

  const [settingsLoad, commandsLoad] = await Promise.allSettled([
    client.settings(instance.id),
    client.commands(instance.id),
  ]);
  if (settingsLoad.status === "fulfilled") settings = settingsLoad.value.settings;
  else conversation.addNotice(`Settings unavailable: ${errorText(settingsLoad.reason)}`, true);
  if (commandsLoad.status === "fulfilled") commands = commandsLoad.value.commands;
  else conversation.addNotice(`Command catalog unavailable: ${errorText(commandsLoad.reason)}`, true);

  const title = new Text(
    `${paint.bold(paint.accent("ALU DOCK"))} ${paint.faint("/ NIGHT CONSOLE")} ${paint.muted("· /help commands")}`,
    1,
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
  rebuildAutocomplete();
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
      conversation.addNotice(workHelpText());
      tui.requestRender();
      return;
    }
    if (text === "/mouse") {
      setDockMouseTracking(!dockMouseTracking.active);
      return;
    }
    if (text.startsWith("/mouse")) {
      conversation.addNotice("Usage: /mouse", true);
      tui.requestRender();
      return;
    }
    if (text === "/settings") {
      await chooseSetting();
      return;
    }
    const settingTarget = commandMessage(text, "/settings");
    if (settingTarget !== undefined) {
      await updateSettingFromCommand(settingTarget);
      return;
    }
    if (text.startsWith("/settings")) {
      conversation.addNotice("Usage: /settings KEY VALUE", true);
      tui.requestRender();
      return;
    }
    if (text === "/tools") {
      await chooseTools();
      return;
    }
    const toolsTarget = commandMessage(text, "/tools");
    if (toolsTarget !== undefined) {
      await setToolsFromCommand(toolsTarget);
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
      await chooseThinking();
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
    if (text === "/tree") {
      await chooseTreeNavigation();
      return;
    }
    const treeTarget = commandMessage(text, "/tree");
    if (treeTarget !== undefined) {
      await navigateTreeFromCommand(treeTarget);
      return;
    }
    if (text.startsWith("/tree")) {
      conversation.addNotice("Usage: /tree [ENTRY_ID [--summary [INSTRUCTIONS] | --replace INSTRUCTIONS]]", true);
      tui.requestRender();
      return;
    }
    if (text === "/fork") {
      await chooseForkTarget();
      return;
    }
    const forkTarget = commandMessage(text, "/fork");
    if (forkTarget !== undefined) {
      await forkSession(forkTarget);
      return;
    }
    if (text.startsWith("/fork")) {
      conversation.addNotice("Usage: /fork [USER_ENTRY_ID]", true);
      tui.requestRender();
      return;
    }
    if (text === "/clone") {
      await cloneSession();
      return;
    }
    if (text.startsWith("/clone")) {
      conversation.addNotice("Usage: /clone", true);
      tui.requestRender();
      return;
    }
    if (text === "/new" || text.startsWith("/new ")) {
      await createNewSession(commandMessage(text, "/new"));
      return;
    }
    if (text === "/resume") {
      await chooseSession();
      return;
    }
    const resumeTarget = commandMessage(text, "/resume");
    if (resumeTarget !== undefined) {
      await resumeSession(resumeTarget);
      return;
    }
    if (text === "/name") {
      conversation.addNotice(`Current session name: ${terminalSafe(instance.name ?? "(none)")}. Usage: /name NAME; use /name - to clear.`);
      tui.requestRender();
      return;
    }
    const nameTarget = commandMessage(text, "/name");
    if (nameTarget !== undefined) {
      await nameSession(nameTarget === "-" ? "" : nameTarget);
      return;
    }
    if (text === "/compact" || text.startsWith("/compact ")) {
      await compactSession(commandMessage(text, "/compact"));
      return;
    }
    if (text === "/reload") {
      await reloadSession();
      return;
    }
    if (text === "/resources") {
      await showResources();
      return;
    }
    if (["/install", "/config", "/login"].some((command) => text === command || text.startsWith(`${command} `))) {
      conversation.addNotice(`Run \`pi ${text.slice(1)}\` in a separate shell; package/config/login ownership remains with the Pi CLI.`);
      tui.requestRender();
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
      activity.setActivity("stopping");
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
    runActivity = submittingActivity();
    activity.setActivity(runActivity);
    tui.requestRender();
    try {
      const result = await client.prompt(instance.id, message, delivery);
      instance = result.instance;
      status.update(instance);
      if (runActivity.phase === "submitting") {
        runActivity = activityFromSnapshot(instance);
        activity.setActivity(runActivity);
      }
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  function restoreMessagesToEditor(messages: readonly PendingMessageDto[]): void {
    if (messages.length === 0) return;
    editor.setText(prependRestoredQueueText(editor.getText(), messages));
  }

  async function restoreQueue(): Promise<boolean> {
    editor.disableSubmit = true;
    activity.setActivity("restoring queued messages");
    tui.requestRender();
    try {
      const result = await client.dequeue(instance.id);
      instance = result.instance;
      status.update(instance);
      pendingQueue.remove(result.receipt.restored.map((message) => message.queueItemId));
      restoreMessagesToEditor(result.receipt.restored);
      if (result.receipt.inFlight.length > 0) {
        const count = result.receipt.inFlight.length;
        conversation.addNotice(`${count} queued message${count === 1 ? " is" : "s are"} already entering Pi consumption and cannot be restored safely; the run was not aborted.`, true);
        activity.setActivity(`${count} message${count === 1 ? " is" : "s are"} entering consumption · not restored`);
        return false;
      }
      activity.setActivity(result.receipt.restored.length > 0
        ? `Restored ${result.receipt.restored.length} queued message${result.receipt.restored.length === 1 ? "" : "s"} to editor`
        : "queue empty");
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function abortRun(): Promise<void> {
    if (instance.execution !== "running") {
      activity.setActivity("nothing to abort");
      tui.requestRender();
      return;
    }
    editor.disableSubmit = true;
    runActivity = abortingActivity();
    activity.setActivity(runActivity);
    tui.requestRender();
    try {
      if ((instance.pending.total > 0 || pendingQueue.count > 0) && !await restoreQueue()) return;
      editor.disableSubmit = true;
      const result = await client.abort(instance.id);
      instance = result.instance;
      status.update(instance);
      runActivity = activityFromSnapshot(instance);
      activity.setActivity(runActivity);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function chooseModel(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("loading models");
    tui.requestRender();
    try {
      const catalog = await client.models(instance.id);
      instance = catalog.instance;
      status.update(instance);
      const selected = await showModelPicker(catalog.models);
      if (selected) await switchModel(selected.provider, selected.id);
      else activity.setActivity("model unchanged");
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
    const currentKey = instance.executor.model
      ? `${instance.executor.model.provider}/${instance.executor.model.id}`
      : undefined;
    const selected = await showChoicePicker(
      "Select Pi model",
      models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: terminalSafe(model.name),
        description: `${terminalSafe(model.provider)}/${terminalSafe(model.id)}${model.reasoning ? " · reasoning" : ""}`,
      })),
      currentKey,
      "type name/provider/id · ↑↓ choose · Enter switch · Esc cancel",
    );
    return selected ? byKey.get(selected) : undefined;
  }

  async function showChoicePicker(
    titleText: string,
    items: Array<{ value: string; label: string; description?: string }>,
    currentValue?: string,
    footerText = "type to filter · ↑↓ choose · Enter select · Esc cancel",
  ): Promise<string | undefined> {
    if (items.length === 0) return undefined;
    const picker = new SearchablePicker(
      items.map((item) => ({
        value: item.value,
        label: terminalSafe(item.label),
        ...(item.description === undefined ? {} : { description: terminalSafe(item.description) }),
      })),
      {
        title: terminalSafe(titleText),
        footer: terminalSafe(footerText),
        maxVisible: Math.min(items.length, 14),
        ...(currentValue === undefined ? {} : { initialValue: currentValue }),
        requestRender: () => tui.requestRender(),
      },
    );
    let resolveChoice!: (value: string | undefined) => void;
    const selection = new Promise<string | undefined>((resolve) => { resolveChoice = resolve; });
    picker.onSelect = (item) => resolveChoice(item.value);
    picker.onCancel = () => resolveChoice(undefined);
    const overlay = tui.showOverlay(picker, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    try { return await selection; }
    finally { overlay.hide(); }
  }

  async function handleExtensionInteraction(event: Extract<DockEvent, { type: "interaction.requested" }>): Promise<void> {
    const leaseToken = controllerLeaseToken;
    if (!leaseToken) {
      conversation.addNotice("Extension interaction is awaiting its controller; this client is observing.");
      tui.requestRender();
      return;
    }
    if (activeExtensionDialog) {
      conversation.addNotice("A second extension interaction arrived while a dialog is active; it will remain Host-queued.", true);
      tui.requestRender();
      return;
    }

    const outcome = await presentExtensionDialog(event.data);
    if (outcome.fromHost || outcome.response === undefined) return;
    try {
      await client.respondInteraction(instance.id, leaseToken, event.data.interactionId, outcome.response);
    } catch (error) {
      if (error instanceof ControlClientError && (error.code === "interaction_expired" || error.code === "interaction_not_found")) return;
      if (error instanceof ControlClientError && error.code === "interaction_wrong_lease") {
        controllerLeaseToken = undefined;
        status.setController("unavailable");
      }
      showError(error);
    }
  }

  async function presentExtensionDialog(
    request: Extract<DockEvent, { type: "interaction.requested" }>["data"],
  ): Promise<{ response?: InteractionResponse; fromHost: boolean }> {
    let settled = false;
    let resolveDialog!: (outcome: { response?: InteractionResponse; fromHost: boolean }) => void;
    const result = new Promise<{ response?: InteractionResponse; fromHost: boolean }>((resolve) => { resolveDialog = resolve; });
    const finish = (outcome: { response?: InteractionResponse; fromHost: boolean }): void => {
      if (settled) return;
      settled = true;
      resolveDialog(outcome);
    };

    let component: SearchablePicker | ExtensionTextDialog;
    if (request.method === "select") {
      const picker = new SearchablePicker(
        request.options.map((option) => ({ value: option, label: option })),
        {
          title: request.title,
          footer: "type to filter · ↑↓ choose · Enter select · Esc cancel",
          maxVisible: Math.min(request.options.length, 14),
          requestRender: () => tui.requestRender(),
        },
      );
      picker.onSelect = (item) => finish({ response: { method: "select", value: item.value }, fromHost: false });
      picker.onCancel = () => finish({ response: { method: "select", cancelled: true }, fromHost: false });
      component = picker;
    } else if (request.method === "confirm") {
      const picker = new SearchablePicker([
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ], {
        title: request.title,
        body: request.message,
        footer: "↑↓ choose · Enter confirm · Esc cancel",
        maxVisible: 2,
        initialValue: "no",
        requestRender: () => tui.requestRender(),
      });
      picker.onSelect = (item) => finish({ response: { method: "confirm", confirmed: item.value === "yes" }, fromHost: false });
      picker.onCancel = () => finish({ response: { method: "confirm", cancelled: true }, fromHost: false });
      component = picker;
    } else {
      const dialog = new ExtensionTextDialog({
        mode: request.method,
        title: request.title,
        ...(request.method === "input" && request.placeholder !== undefined ? { placeholder: request.placeholder } : {}),
        ...(request.method === "editor" && request.prefill !== undefined ? { prefill: request.prefill } : {}),
        requestRender: () => tui.requestRender(),
        tui,
      });
      dialog.onSubmit = (value) => finish({ response: { method: request.method, value }, fromHost: false });
      dialog.onCancel = () => finish({ response: { method: request.method, cancelled: true }, fromHost: false });
      component = dialog;
    }

    activeExtensionDialog = {
      interactionId: request.interactionId,
      closeFromHost: () => finish({ fromHost: true }),
    };
    const overlay = tui.showOverlay(component, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    try {
      return await result;
    } finally {
      overlay.hide();
      if (activeExtensionDialog?.interactionId === request.interactionId) activeExtensionDialog = undefined;
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  async function chooseSetting(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("loading settings");
    tui.requestRender();
    try {
      settings = (await client.settings(instance.id)).settings;
      const key = await showChoicePicker(
        "Pi settings",
        settings.map((setting) => ({
          value: setting.key,
          label: setting.key,
          description: `${formatSettingValue(setting.value)} · ${setting.source}${setting.writable ? "" : " · read-only"}${setting.reloadRequired ? " · reload" : ""}${setting.hostRestartRequired ? " · host restart" : ""}`,
        })),
      );
      if (!key) { activity.setActivity("settings unchanged"); return; }
      const setting = settings.find((candidate) => candidate.key === key);
      if (!setting || !setting.writable) {
        conversation.addNotice(`${key} is read-only.`, true);
        return;
      }
      if (setting.valueType === "integer") {
        editor.setText(`/settings ${setting.key} ${String(setting.value)}`);
        conversation.addNotice(`Edit the integer value for ${setting.key}, then press Enter.`);
        activity.setActivity("setting ready to edit");
        return;
      }
      const choices = settingValueChoices(setting);
      const selected = await showChoicePicker(`Set ${setting.key}`, choices, settingChoiceValue(setting));
      if (selected === undefined) { activity.setActivity("setting unchanged"); return; }
      const update = parseSettingCommandValue(setting, selected);
      if (!update) {
        conversation.addNotice(`Invalid value for ${setting.key}.`, true);
        return;
      }
      await applySettingUpdate(update);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  async function updateSettingFromCommand(target: string): Promise<void> {
    const separator = target.indexOf(" ");
    if (separator < 1) {
      conversation.addNotice("Usage: /settings KEY VALUE", true);
      tui.requestRender();
      return;
    }
    const key = target.slice(0, separator);
    const rawValue = target.slice(separator + 1).trim();
    try {
      settings = (await client.settings(instance.id)).settings;
      const setting = settings.find((candidate) => candidate.key === key);
      const update = setting && setting.writable ? parseSettingCommandValue(setting, rawValue) : undefined;
      if (!setting) conversation.addNotice(`Unknown setting: ${key}`, true);
      else if (!setting.writable) conversation.addNotice(`${key} is read-only.`, true);
      else if (!update) conversation.addNotice(`Invalid value for ${key}.`, true);
      else await applySettingUpdate(update);
    } catch (error) {
      showError(error);
    }
    tui.requestRender();
  }

  async function applySettingUpdate(update: SettingUpdate): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity(`setting ${update.key}`);
    tui.requestRender();
    try {
      const result = await client.updateSetting(instance.id, update);
      instance = result.instance;
      status.update(instance);
      settings = settings.map((setting) => setting.key === result.setting.key ? result.setting : setting);
      applyLiveSetting(result.setting.key, result.setting.value);
      const boundary = result.hostRestartRequired ? " · Host restart required" : result.reloadRequired ? " · run /reload" : "";
      conversation.addNotice(`${result.setting.key} = ${formatSettingValue(result.setting.value)}${boundary}`);
      activity.setActivity(`setting ${result.setting.key} saved`);
      rebuildAutocomplete();
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
    }
  }

  async function chooseTools(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("loading tools");
    tui.requestRender();
    try {
      let tools = (await client.tools(instance.id)).tools;
      while (true) {
        const selected = await showChoicePicker(
          "Active tools",
          tools.map((tool) => ({ value: tool.name, label: `${tool.active ? "[x]" : "[ ]"} ${tool.name}`, description: tool.description })),
          undefined,
          "Enter toggles · Esc done",
        );
        if (selected === undefined) break;
        const active = new Set(tools.filter((tool) => tool.active).map((tool) => tool.name));
        if (active.has(selected)) active.delete(selected); else active.add(selected);
        const result = await client.setActiveTools(instance.id, [...active].sort());
        instance = result.instance;
        status.update(instance);
        tools = result.tools;
        activity.setActivity(`tool ${selected} toggled`);
      }
      activity.setActivity("tools updated");
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  async function setToolsFromCommand(target: string): Promise<void> {
    const names = target === "none" ? [] : [...new Set(target.split(/[\s,]+/u).filter(Boolean))].sort();
    editor.disableSubmit = true;
    activity.setActivity("updating tools");
    tui.requestRender();
    try {
      const result = await client.setActiveTools(instance.id, names);
      instance = result.instance;
      status.update(instance);
      conversation.addNotice(`Active tools: ${result.tools.filter((tool) => tool.active).map((tool) => tool.name).join(", ") || "none"}.`);
      activity.setActivity("tools updated");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function chooseThinking(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("loading thinking levels");
    tui.requestRender();
    try {
      const result = await client.models(instance.id);
      instance = result.instance;
      status.update(instance);
      const selected = await showChoicePicker(
        "Thinking level",
        result.availableThinkingLevels.map((level) => ({ value: level, label: level })),
        instance.executor.thinkingLevel,
      );
      if (selected && isThinkingLevel(selected)) await switchThinking(selected);
      else activity.setActivity("thinking unchanged");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function loadSessionTree(): Promise<{ nodes: TreeNodeDto[]; leafId?: string; total: number; revision: string }> {
    const tree = await collectSessionTree((revision, cursor, limit) => client.tree(instance.id, revision, cursor, limit));
    if (tree.capped) conversation.addNotice(`Tree selector is showing the first ${tree.nodes.length.toLocaleString()} of ${tree.total.toLocaleString()} entries.`, true);
    return tree;
  }

  async function chooseTreeNode(
    titleText: string,
    predicate: (node: TreeNodeDto) => boolean = () => true,
    filterMode?: TreeFilterMode,
  ): Promise<TreeNodeDto | undefined> {
    const tree = await loadSessionTree();
    const candidates = (filterMode === undefined ? tree.nodes : filterSessionTree(tree.nodes, filterMode)).filter(predicate);
    if (candidates.length === 0) {
      conversation.addNotice("The current Pi session tree has no matching entries.", true);
      return undefined;
    }
    const byId = new Map(candidates.map((node) => [node.entryId, node]));
    const selected = await showChoicePicker(
      titleText,
      treePickerItems(candidates, tree.leafId),
      tree.leafId,
      "type text/id/label · ↑↓ choose · Enter select · Esc cancel",
    );
    return selected === undefined ? undefined : byId.get(selected);
  }

  async function chooseTreeNavigation(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("loading session tree");
    tui.requestRender();
    try {
      const configuredFilter = settings.find((setting) => setting.key === "treeFilterMode")?.value;
      const target = await chooseTreeNode("Navigate session tree", () => true, isTreeFilterMode(configuredFilter) ? configuredFilter : "default");
      if (!target) { activity.setActivity("tree unchanged"); return; }
      const action = await showChoicePicker("Navigation mode", [
        { value: "navigate", label: "Navigate", description: "switch branch without model summarization" },
        { value: "summary", label: "Navigate with summary", description: "use Pi branch summarization" },
        { value: "custom", label: "Summary with additional instructions" },
        { value: "replace", label: "Summary with replacement instructions" },
      ], "navigate");
      if (!action) { activity.setActivity("tree unchanged"); return; }
      const options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {};
      if (action !== "navigate") options.summarize = true;
      if (action === "custom" || action === "replace") {
        const instructions = await showLocalTextDialog("Branch summary instructions", "editor", "Describe what the summary must preserve");
        if (instructions === undefined || instructions.trim().length === 0) { activity.setActivity("tree unchanged"); return; }
        options.customInstructions = instructions;
        if (action === "replace") options.replaceInstructions = true;
      }
      if (options.summarize) {
        const labelMode = await showChoicePicker("Optional branch label", [
          { value: "none", label: "No label" },
          { value: "label", label: "Add label" },
        ], "none");
        if (labelMode === undefined) { activity.setActivity("tree unchanged"); return; }
        if (labelMode === "label") {
          const label = await showLocalTextDialog("Branch label", "input", "Short label for the navigation target");
          if (label === undefined) { activity.setActivity("tree unchanged"); return; }
          if (label.trim()) options.label = label.trim();
        }
      }
      await navigateTree(target.entryId, options);
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function navigateTreeFromCommand(target: string): Promise<void> {
    const parsed = parseTreeNavigationCommand(target);
    if (!parsed) {
      conversation.addNotice("Usage: /tree ENTRY_ID [--summary [INSTRUCTIONS] | --replace INSTRUCTIONS]", true);
      tui.requestRender();
      return;
    }
    await navigateTree(parsed.entryId, parsed.options);
  }

  async function navigateTree(
    targetId: string,
    options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
  ): Promise<void> {
    editor.disableSubmit = true;
    treeNavigationPending = true;
    treeNavigationAbortRequested = false;
    activity.setActivity(options.summarize ? "summarizing branch · Esc/Ctrl+C abort" : "navigating tree");
    tui.requestRender();
    try {
      const result = await client.navigateSession(instance.id, targetId, options);
      instance = result.instance;
      status.update(instance);
      if (result.editorText !== undefined) editor.setText(result.editorText);
      activity.setActivity(result.cancelled ? result.aborted || treeNavigationAbortRequested ? "navigation aborted" : "navigation cancelled by extension" : "branch selected");
    } catch (error) { showError(error); }
    finally {
      treeNavigationPending = false;
      treeNavigationAbortRequested = false;
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  async function abortTreeNavigation(): Promise<void> {
    if (!treeNavigationPending || treeNavigationAbortPending) return;
    treeNavigationAbortPending = true;
    treeNavigationAbortRequested = true;
    activity.setActivity("aborting branch navigation");
    tui.requestRender();
    try { await client.abort(instance.id); }
    catch (error) { showError(error); }
    finally { treeNavigationAbortPending = false; }
  }

  async function chooseForkTarget(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("loading fork targets");
    tui.requestRender();
    try {
      const target = await chooseTreeNode("Fork before user message", (node) => node.kind === "message" && node.role === "user");
      if (target) await forkSession(target.entryId);
      else activity.setActivity("fork cancelled");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function forkSession(entryId: string): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("forking session");
    tui.requestRender();
    try {
      const result = await client.forkSession(instance.id, entryId);
      instance = result.instance;
      status.update(instance);
      if (result.selectedText !== undefined) editor.setText(result.selectedText);
      activity.setActivity(result.cancelled ? "fork cancelled by extension" : "fork ready · edit and submit selected prompt");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function cloneSession(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("finding current leaf");
    tui.requestRender();
    try {
      const tree = await client.tree(instance.id, undefined, undefined, 1);
      if (!tree.leafId) {
        conversation.addNotice("The current session has no leaf to clone.", true);
        activity.setActivity("clone unavailable");
        return;
      }
      const result = await client.cloneSession(instance.id, tree.leafId);
      instance = result.instance;
      status.update(instance);
      if (!result.cancelled) editor.setText("");
      activity.setActivity(result.cancelled ? "clone cancelled by extension" : "session cloned");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function showLocalTextDialog(
    titleText: string,
    mode: "input" | "editor",
    placeholder?: string,
  ): Promise<string | undefined> {
    const dialog = new ExtensionTextDialog({
      mode,
      title: titleText,
      ...(placeholder === undefined ? {} : { placeholder }),
      requestRender: () => tui.requestRender(),
      tui,
    });
    let resolveText!: (value: string | undefined) => void;
    const result = new Promise<string | undefined>((resolve) => { resolveText = resolve; });
    dialog.onSubmit = (value) => resolveText(value);
    dialog.onCancel = () => resolveText(undefined);
    const overlay = tui.showOverlay(dialog, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    tui.setFocus(dialog);
    try { return await result; }
    finally { overlay.hide(); tui.setFocus(editor); }
  }

  async function chooseSession(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("loading sessions");
    tui.requestRender();
    try {
      const sessions = (await client.sessions(instance.id, "all")).sessions
        .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
      const indexed = sessions.map((session, index) => ({ session, value: String(index) }));
      const selected = await showChoicePicker(
        "Resume Pi session",
        indexed.map(({ session, value }) => ({
          value,
          label: session.name ?? session.sessionId,
          description: `${session.cwd}${session.sessionFile === instance.executor.sessionFile ? " · current" : ""}${session.updatedAt ? ` · ${session.updatedAt}` : ""}`,
        })),
      );
      if (selected === undefined) { activity.setActivity("session unchanged"); return; }
      const target = indexed.find((candidate) => candidate.value === selected)?.session;
      if (target) await resumeSession(target.sessionFile);
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function resumeSession(sessionFile: string): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("resuming session");
    tui.requestRender();
    const operationId = randomUUID();
    try {
      let result;
      try {
        result = await client.switchSession(instance.id, sessionFile, operationId);
      } catch (error) {
        const challenge = projectTrustChallenge(error, operationId);
        if (!challenge) throw error;
        const decision = await chooseProjectTrust(challenge.cwd);
        if (!decision) { activity.setActivity("resume cancelled"); return; }
        result = await client.switchSession(instance.id, sessionFile, operationId, { challengeId: challenge.challengeId, decision });
      }
      instance = result.instance;
      status.update(instance);
      activity.setActivity(result.cancelled ? "resume cancelled by extension" : "session resumed");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function chooseProjectTrust(cwd: string): Promise<ProjectTrustChoice | undefined> {
    const selected = await showChoicePicker("Project-local Pi resources", [
      { value: "trust_once", label: "Trust once", description: cwd },
      { value: "trust_and_remember", label: "Trust and remember", description: cwd },
      { value: "deny_once", label: "Do not trust once", description: "continue without project resources" },
      { value: "deny_and_remember", label: "Do not trust and remember", description: "continue without project resources" },
    ]);
    return isProjectTrustChoice(selected) ? selected : undefined;
  }

  async function createNewSession(parentSession?: string): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("creating session");
    tui.requestRender();
    try {
      const result = await client.newSession(instance.id, parentSession);
      instance = result.instance;
      status.update(instance);
      activity.setActivity(result.cancelled ? "new session cancelled by extension" : "new session ready");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function nameSession(name: string): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("naming session");
    tui.requestRender();
    try {
      const result = await client.nameSession(instance.id, name);
      instance = result.instance;
      status.update(instance);
      terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);
      conversation.addNotice(instance.name ? `Session name: ${terminalSafe(instance.name)}.` : "Session name cleared.");
      activity.setActivity(instance.name ? `named ${terminalSafe(instance.name)}` : "session name cleared");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function compactSession(customInstructions?: string): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("compacting");
    tui.requestRender();
    try {
      const result = await client.compactSession(instance.id, customInstructions);
      instance = result.instance;
      status.update(instance);
      conversation.addNotice(`Compacted ${result.result.tokensBefore.toLocaleString()} tokens · kept from ${result.result.firstKeptEntryId}.`);
      activity.setActivity("compacted");
    } catch (error) {
      if (error instanceof ControlClientError && error.code === "compaction_not_needed") {
        activity.setActivity("nothing to compact");
      } else if (error instanceof ControlClientError && error.code === "compaction_cancelled") {
        activity.setActivity("compaction cancelled");
      } else {
        showError(error);
      }
    }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function reloadSession(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("reloading resources");
    tui.requestRender();
    try {
      const result = await client.reloadSession(instance.id);
      instance = result.instance;
      status.update(instance);
      for (const diagnostic of result.diagnostics) conversation.addNotice(`${diagnostic.severity}: ${diagnostic.message}`, diagnostic.severity === "error");
      activity.setActivity(`reloaded ${result.resources.length} resources`);
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function showResources(): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity("loading resources");
    tui.requestRender();
    try {
      const result = await client.resources(instance.id);
      for (const diagnostic of result.diagnostics) conversation.addNotice(`${diagnostic.severity}: ${diagnostic.message}${diagnostic.source ? ` · ${diagnostic.source}` : ""}`, diagnostic.severity === "error");
      const indexed = result.resources.map((resource, index) => ({ resource, value: String(index) }));
      const selected = await showChoicePicker("Pi resources", indexed.map(({ resource, value }) => ({ value, label: `${resource.kind}: ${resource.name}`, description: resource.path ?? resource.source?.package ?? resource.source?.kind })));
      const resource = indexed.find((candidate) => candidate.value === selected)?.resource;
      if (resource) conversation.addNotice(`${resource.kind} ${resource.name}${resource.path ? ` · ${resource.path}` : ""}`);
      activity.setActivity(`${result.resources.length} resources · ${result.diagnostics.length} diagnostics`);
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function switchModel(provider: string, modelId: string): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity(`switching to ${provider}/${modelId}`);
    tui.requestRender();
    try {
      const result = await client.setModel(instance.id, provider, modelId);
      instance = result.instance;
      status.update(instance);
      activity.setActivity(`model ${modelId}`);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function switchThinking(level: RuntimeThinkingLevel): Promise<void> {
    editor.disableSubmit = true;
    activity.setActivity(`thinking ${level}`);
    tui.requestRender();
    try {
      const result = await client.setThinking(instance.id, level);
      instance = result.instance;
      status.update(instance);
      activity.setActivity(`thinking ${instance.executor.thinkingLevel ?? level}`);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function refreshStatus(): Promise<void> {
    activity.setActivity("refreshing");
    tui.requestRender();
    try {
      instance = await client.status(instance.id);
      status.update(instance);
      activity.setActivity("status refreshed");
    } catch (error) {
      showError(error);
    }
    tui.requestRender();
  }

  async function refreshReplacementProjection(generation: number, cursor: InstanceSnapshot["eventCursor"]): Promise<void> {
    const [projectionLoad, settingsLoad, commandsLoad] = await Promise.allSettled([
      (async () => {
        const projection = await client.streamEvents(instance.id, { since: cursor, onEvent: () => {}, requireTuiProjection: true });
        projection.close();
        await projection.done.catch(() => {});
        return projection.initial;
      })(),
      client.settings(instance.id),
      client.commands(instance.id),
    ]);
    if (replacementHistoryGeneration !== generation) return;

    const buffered = replacementBufferedEvents;
    replacementBufferedEvents = [];
    replacementHistoryGeneration = undefined;
    conversation.reset();
    screen?.scrollToBottom();
    if (projectionLoad.status === "fulfilled") {
      instance = projectionLoad.value.instance;
      for (const event of buffered) {
        if (event.runtimeGeneration === generation && event.sequence > instance.eventCursor.sequence) {
          instance = projectSnapshot(instance, event);
        }
      }
      status.update(instance);
      terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);
      historyWindow.reset(
        projectionLoad.value.recentHistory,
        projectionLoad.value.historyTruncated,
        projectionLoad.value.instance.runtimeGeneration,
      );
      conversation.replacePagedHistory(historyWindow.snapshot());
      const replacement = buffered.find((event) => event.type === "session.replaced");
      if (replacement) conversation.apply(replacement);
      conversation.applyReplay(projectionLoad.value.page.events, projectionLoad.value.page.truncated);
      for (const event of buffered) {
        if (event.type !== "session.replaced" && event.sequence > projectionLoad.value.page.latest.sequence) conversation.apply(event);
      }
    } else {
      conversation.addNotice(`Replacement history unavailable: ${errorText(projectionLoad.reason)}`, true);
      conversation.applyReplay(buffered, false);
    }

    if (settingsLoad.status === "fulfilled") {
      settings = settingsLoad.value.settings;
      for (const setting of settings) applyLiveSetting(setting.key, setting.value);
    } else {
      conversation.addNotice(`Replacement settings unavailable: ${errorText(settingsLoad.reason)}`, true);
    }
    if (commandsLoad.status === "fulfilled") commands = commandsLoad.value.commands;
    else conversation.addNotice(`Replacement command catalog unavailable: ${errorText(commandsLoad.reason)}`, true);
    rebuildAutocomplete();
    activity.setActivity("session history loaded");
    tui.requestRender();
  }

  async function refreshNavigationProjection(token: string, generation: number): Promise<void> {
    const loaded = await client.history(instance.id, undefined, 200).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (navigationHistoryToken !== token || instance.runtimeGeneration !== generation) return;
    const buffered = navigationBufferedEvents;
    navigationBufferedEvents = [];
    navigationHistoryToken = undefined;
    conversation.reset();
    screen?.scrollToBottom();
    if (!loaded.ok) {
      conversation.addNotice(`Navigated branch history unavailable: ${errorText(loaded.error)}`, true);
      conversation.applyReplay(buffered, false);
      tui.requestRender();
      return;
    }
    instance = loaded.value.instance;
    status.update(instance);
    historyWindow.reset(loaded.value.entries, loaded.value.hasEarlier, loaded.value.instance.runtimeGeneration);
    conversation.replacePagedHistory(historyWindow.snapshot());
    const navigated = buffered.find((event) => event.type === "session.navigated");
    if (navigated) conversation.apply(navigated);
    for (const event of buffered) {
      if (event.type !== "session.navigated" && event.sequence > loaded.value.instance.eventCursor.sequence) {
        instance = projectSnapshot(instance, event);
        conversation.apply(event);
      }
    }
    status.update(instance);
    activity.setActivity("branch history loaded");
    tui.requestRender();
  }

  function loadEarlierHistory(): Promise<void> {
    if (earlierHistoryLoad) return earlierHistoryLoad;
    const task = loadEarlierHistoryOnce();
    const tracked = task.finally(() => {
      if (earlierHistoryLoad === tracked) earlierHistoryLoad = undefined;
    });
    earlierHistoryLoad = tracked;
    return tracked;
  }

  async function loadEarlierHistoryOnce(): Promise<void> {
    const request = historyWindow.beginEarlier();
    if (!request) {
      const history = historyWindow.snapshot();
      if (!history.hasEarlier && history.loadState !== "loading") {
        activity.setActivity("start of session history");
        tui.requestRender();
      }
      return;
    }

    const loadingAnchor = screen?.captureHistoryAnchor();
    conversation.replacePagedHistory(historyWindow.snapshot());
    screen?.restoreHistoryAnchor(loadingAnchor);
    activity.setActivity("loading earlier history");
    tui.requestRender();

    const loaded = await client.history(instance.id, request.beforeEntryId, HISTORY_PAGE_SIZE).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (exiting || historyWindow.snapshot().generation !== request.generation) return;

    const anchor = screen?.captureHistoryAnchor();
    if (!loaded.ok) {
      historyWindow.failEarlier(request, errorText(loaded.error));
      conversation.replacePagedHistory(historyWindow.snapshot());
      screen?.restoreHistoryAnchor(anchor);
      activity.setActivity("earlier history unavailable");
      tui.requestRender();
      return;
    }
    if (loaded.value.instance.id !== instance.id || loaded.value.instance.runtimeGeneration !== request.generation) {
      historyWindow.failEarlier(request, "Session changed while earlier history was loading");
      conversation.replacePagedHistory(historyWindow.snapshot());
      screen?.restoreHistoryAnchor(anchor);
      activity.setActivity("history changed");
      tui.requestRender();
      return;
    }

    historyWindow.completeEarlier(request, {
      entries: loaded.value.entries,
      hasEarlier: loaded.value.hasEarlier,
      ...(loaded.value.nextBeforeEntryId === undefined ? {} : { nextBeforeEntryId: loaded.value.nextBeforeEntryId }),
    });
    conversation.replacePagedHistory(historyWindow.snapshot());
    screen?.restoreHistoryAnchor(anchor);
    const history = historyWindow.snapshot();
    activity.setActivity(history.loadState === "error"
      ? "earlier history cursor stalled"
      : history.hasEarlier
        ? `history loaded · ${history.entries.length} retained`
        : "start of session history");
    tui.requestRender();
  }

  function reloadLatestHistoryAfterCursorError(): Promise<void> {
    if (latestHistoryReload) return latestHistoryReload;
    const generation = instance.runtimeGeneration;
    const task = (async () => {
      activity.setActivity("reloading latest history");
      tui.requestRender();
      const loaded = await client.history(instance.id, undefined, HISTORY_PAGE_SIZE);
      if (exiting || instance.runtimeGeneration !== generation) return;
      if (loaded.instance.id !== instance.id || loaded.instance.runtimeGeneration !== generation) {
        throw new Error("Session changed while latest history was reloading");
      }
      historyWindow.reset(loaded.entries, loaded.hasEarlier, generation);
      conversation.replacePagedHistory(historyWindow.snapshot());
      screen?.scrollToBottom();
      activity.setActivity("latest history reloaded");
      tui.requestRender();
    })().catch((error: unknown) => {
      if (exiting) return;
      conversation.addNotice(`Latest history reload failed: ${errorText(error)}`, true);
      activity.setActivity("latest history unavailable");
      tui.requestRender();
    });
    const tracked = task.finally(() => {
      if (latestHistoryReload === tracked) latestHistoryReload = undefined;
    });
    latestHistoryReload = tracked;
    return tracked;
  }

  function rebuildAutocomplete(): void {
    if (!editor) return;
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
      if (command.name === "settings") {
        return {
          ...command,
          getArgumentCompletions: (prefix: string) => settingCompletions(settings, prefix),
        };
      }
      if (command.name === "tools") {
        return {
          ...command,
          getArgumentCompletions: async (prefix: string) => {
            try {
              return (await client.tools(instance.id)).tools
                .filter((tool) => tool.name.toLowerCase().includes(prefix.toLowerCase()))
                .map((tool) => ({ value: terminalSafe(tool.name), label: terminalSafe(tool.name), description: tool.active ? "active" : "inactive" }));
            } catch { return null; }
          },
        };
      }
      return command;
    });
    editor.setAutocompleteProvider(new TerminalSafeAutocompleteProvider(new CombinedAutocompleteProvider(autocompleteCommands, instance.cwd)));
  }

  function showError(error: unknown): void {
    const message = error instanceof ControlClientError
      ? `${error.code}: ${error.message}`
      : errorText(error);
    conversation.addNotice(message, true);
    runActivity = errorActivity();
    activity.setActivity(runActivity);
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

  function setDockMouseTracking(active: boolean): void {
    const modeChanged = dockMouseTracking.setActive(active);
    const trackingChanged = terminal.setMouseTracking(active);
    if (modeChanged || trackingChanged) tui.requestRender();
  }

  const activityPulse = new ActivityPulseController(activity, terminal, {
    canWrite: () => !exiting && !tui.hasOverlay(),
  });
  activity.setAnimationListener(() => activityPulse.sync());

  const composerDock = new Container();
  composerDock.addChild(activity);
  composerDock.addChild(dockMouseTracking);
  composerDock.addChild(pendingQueue);
  composerDock.addChild(editor);
  screen = new FixedDockScreen(terminal, {
    header: title,
    history: conversation,
    status,
    editor: composerDock,
    historyVersion: () => ({ revision: conversation.revision, outputRevision: conversation.outputRevision }),
    activityPlacement: { editorRow: 0, update: (placement) => activityPulse.setPlacement(placement) },
  });
  tui.addChild(screen);
  tui.setFocus(editor);
  terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);

  const removeInputListener = tui.addInputListener((data) => {
    if (tui.hasOverlay()) return undefined;
    if (matchesKey(data, Key.alt("m"))) {
      setDockMouseTracking(!dockMouseTracking.active);
      return { consume: true };
    }
    if (dockMouseTracking.active && matchesKey(data, "escape") && !editor.isShowingAutocomplete()) {
      setDockMouseTracking(false);
      return { consume: true };
    }
    const wheel = dockMouseTracking.active ? parseMouseWheel(data) : undefined;
    if (wheel) {
      const reachedBoundary = wheel === "up" ? screen?.scrollUp(3) : screen?.scrollDown(3);
      if (wheel === "up" && reachedBoundary) void loadEarlierHistory();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.pageUp) && !editor.isShowingAutocomplete()) {
      if (screen?.pageUp()) void loadEarlierHistory();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.pageDown) && !editor.isShowingAutocomplete()) {
      screen?.pageDown();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("end"))) {
      const reloadStaleHistory = historyWindow.snapshot().loadState === "error";
      if (!reloadStaleHistory && historyWindow.returnToLatest()) {
        conversation.replacePagedHistory(historyWindow.snapshot());
      }
      screen?.scrollToBottom();
      if (reloadStaleHistory) void reloadLatestHistoryAfterCursorError();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
      finish("detached");
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("o"))) {
      const toggled = conversation.toggleLatestToolExpanded();
      if (toggled) {
        if (toggled.expanded) screen?.revealOffsetFromBottom((width) => conversation.latestToolOffsetFromBottom(width));
        else screen?.scrollToBottom();
        if (instance.execution !== "running") activity.setActivity(`${toggled.name} ${toggled.expanded ? "expanded" : "collapsed"}`);
      }
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      const expanded = conversation.toggleToolsExpanded();
      if (expanded) screen?.revealOffsetFromBottom((width) => conversation.latestToolOffsetFromBottom(width));
      else screen?.scrollToBottom();
      if (instance.execution !== "running") activity.setActivity(expanded ? "all tools expanded" : "tools collapsed");
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("up"))) {
      if (!editor.disableSubmit) void restoreQueue();
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
      if (treeNavigationPending) {
        void abortTreeNavigation();
        return { consume: true };
      }
      if (instance.execution === "running") {
        void abortRun();
        return { consume: true };
      }
      if (editor.getText().length === 0 && !editor.disableSubmit) {
        const action = settings.find((setting) => setting.key === "doubleEscapeAction")?.value;
        const now = Date.now();
        if (action !== "none" && now - lastIdleEscapeAt <= 600) {
          lastIdleEscapeAt = 0;
          if (action === "fork") void chooseForkTarget();
          else void chooseTreeNavigation();
        } else {
          lastIdleEscapeAt = now;
          if (action !== "none") activity.setActivity(`Esc again to open ${action === "fork" ? "fork" : "tree"}`);
        }
        tui.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (treeNavigationPending) {
        void abortTreeNavigation();
      } else if (editor.getText().length > 0) {
        editor.setText("");
        activity.setActivity("input cleared");
      } else if (instance.execution === "running") {
        void abortRun();
      } else {
        activity.setActivity("Ctrl+D detaches");
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

  function watchEventSubscription(watched: EventSubscription): void {
    void watched.done.then(() => {
      if (exiting || subscription !== watched) return;
      activeExtensionDialog?.closeFromHost();
      editor.disableSubmit = true;
      terminal.setProgress(false);
      status.setConnection("disconnected");
      runActivity = disconnectedActivity("host stream closed · Ctrl+D detach");
      activity.setActivity(runActivity);
      conversation.addNotice("Host event stream closed. No command was replayed; this TUI is now read-only.", true);
      tui.requestRender();
    }).catch((error: unknown) => {
      if (exiting || subscription !== watched) return;
      activeExtensionDialog?.closeFromHost();
      editor.disableSubmit = true;
      terminal.setProgress(false);
      status.setConnection("lost");
      runActivity = disconnectedActivity("connection lost · Ctrl+D detach");
      activity.setActivity(runActivity);
      conversation.addNotice("Host connection lost. No command was replayed; this TUI is now read-only.", true);
      conversation.addNotice(errorText(error), true);
      tui.requestRender();
    });
  }
  watchEventSubscription(subscription);

  tui.start();
  activityPulse.setEnabled(true);
  updateTerminalProgress();
  const reason = await exit;

  activityPulse.stop();
  activeExtensionDialog?.closeFromHost();
  removeInputListener();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  await Promise.all([
    controllerReattach?.catch(() => {}),
    earlierHistoryLoad?.catch(() => {}),
    latestHistoryReload?.catch(() => {}),
  ]);
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

function parseModelTarget(value: string): { provider: string; id: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

function isThinkingLevel(value: string): value is RuntimeThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
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

function projectTrustChallenge(error: unknown, operationId: string): { challengeId: string; cwd: string } | undefined {
  if (!(error instanceof ControlClientError) || error.code !== "project_trust_required") return undefined;
  const challengeId = error.details?.challengeId;
  const challengeOperationId = error.details?.operationId;
  const cwd = error.details?.cwd;
  if (typeof challengeId !== "string" || challengeOperationId !== operationId || typeof cwd !== "string") {
    throw new Error("Host returned an invalid project trust challenge");
  }
  return { challengeId, cwd };
}

function isProjectTrustChoice(value: string | undefined): value is ProjectTrustChoice {
  return value === "trust_once" || value === "trust_and_remember" || value === "deny_once" || value === "deny_and_remember";
}

function booleanSetting(settings: SettingDto[], key: SettingDto["key"], fallback: boolean): boolean {
  const value = settings.find((setting) => setting.key === key)?.value;
  return typeof value === "boolean" ? value : fallback;
}

function numericSetting(settings: SettingDto[], key: SettingDto["key"], fallback: number): number {
  const value = settings.find((setting) => setting.key === key)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function workHelpText(): string {
  return [
    "SESSION",
    "  /tree [ENTRY]             browse or navigate branches",
    "  /fork [USER_ENTRY]        fork before a user prompt",
    "  /clone                    clone the current leaf",
    "  /new [PARENT]             start a new Pi session",
    "  /resume [SESSION_FILE]    resume a saved Pi session",
    "  /name NAME                set or clear the session name",
    "  /compact [INSTRUCTIONS]   compact context",
    "RUNTIME",
    "  /model [PROVIDER/MODEL]   choose a model",
    "  /thinking [LEVEL]         set reasoning effort",
    "  /tools [NAME…]            choose active tools",
    "  /settings [KEY VALUE]     inspect or update settings",
    "  /reload                   reload resources",
    "  /resources                inspect resources/diagnostics",
    "CLIENT",
    "  /steer MESSAGE            steer the current run",
    "  /follow MESSAGE           queue a follow-up",
    "  /abort                    abort; keep the instance",
    "  /status                   refresh status",
    "  /stop                     stop and dispose",
    "  /detach                   leave Work; keep runtime",
    "EXTENSION",
    "  Type / to discover extension, skill, and prompt commands.",
    "  /mouse toggles the optional Dock-owned history wheel.",
  ].join("\n");
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
    { name: "clone", description: "clone the current session leaf into a new Pi session" },
    { name: "compact", description: "manually compact session context", argumentHint: "INSTRUCTIONS" },
    { name: "config", description: "show Pi CLI config ownership guidance" },
    { name: "detach", description: "leave the TUI without stopping the instance" },
    { name: "follow", description: "queue a follow-up message", argumentHint: "MESSAGE" },
    { name: "fork", description: "fork before a user message and return it to the editor", argumentHint: "USER_ENTRY_ID" },
    { name: "help", description: "show Dock commands" },
    { name: "install", description: "show Pi CLI package ownership guidance" },
    { name: "login", description: "show Pi CLI login ownership guidance" },
    { name: "model", description: "choose or set provider/model", argumentHint: "PROVIDER/MODEL" },
    { name: "mouse", description: "toggle Dock mouse tracking and app-owned history wheel" },
    { name: "name", description: "set or clear the Pi session name", argumentHint: "NAME" },
    { name: "new", description: "create a new Pi session", argumentHint: "PARENT_SESSION" },
    { name: "reload", description: "coherently reload Pi resources" },
    { name: "resources", description: "inspect loaded resources and diagnostics" },
    { name: "resume", description: "select or open a Pi session", argumentHint: "SESSION_FILE" },
    { name: "settings", description: "inspect or update Pi settings", argumentHint: "KEY VALUE" },
    { name: "status", description: "refresh instance status" },
    { name: "steer", description: "steer the current run", argumentHint: "MESSAGE" },
    { name: "stop", description: "stop and dispose the instance" },
    { name: "thinking", description: "choose or set thinking level", argumentHint: "LEVEL" },
    { name: "tools", description: "toggle or set active tools", argumentHint: "NAME…" },
    { name: "tree", description: "browse and navigate the current Pi session tree", argumentHint: "ENTRY_ID" },
  ];
  for (const command of dockCommands) catalog.set(command.name, command);
  return [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function errorText(error: unknown): string {
  return error instanceof Error ? terminalSafe(error.message) : terminalSafe(String(error));
}
