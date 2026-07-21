import { randomUUID } from "node:crypto";

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import { ControlClientError, DockClient, type EventSubscription } from "../control/dock-client.js";
import type { InteractionResponse } from "../core/extension-ui-broker.js";
import type { CommandDto, SettingDto, SettingUpdate } from "../core/config-projection.js";
import type { DeliveryMode, DockEvent, EventCursor, InstanceSnapshot, PendingMessageDto, SessionDto, TreeNodeDto } from "../core/managed-instance.js";
import type {
  RuntimeModelInfo,
  RuntimeThinkingLevel,
} from "../core/runtime-session.js";
import type { ProjectTrustChoice } from "../control/project-trust.js";
import { ActivityPulseController } from "./activity-pulse.js";
import { DockActivityLine, DockConversation, DockStatusLine, DockWorkMetadata } from "./conversation.js";
import { ExtensionTextDialog } from "./extension-text-dialog.js";
import { drainFullHistory, HISTORY_PAGE_SIZE, reconcileFlowingEvents } from "./history-pagination.js";
import { PendingQueueTray } from "./pending-queue.js";
import { prependRestoredQueueText, submissionRecovery } from "./queue-restoration.js";
import {
  abortingActivity,
  activityFromReplay,
  activityFromSnapshot,
  disconnectedActivity,
  reduceRunActivity,
  submittingActivity,
} from "./run-activity.js";
import { SearchablePicker } from "./searchable-picker.js";
import { projectSnapshot } from "./snapshot-projection.js";
import {
  collectSessionTree,
  isTreeFilterMode,
  parseTreeNavigationCommand,
  treePickerItems,
} from "./session-tree.js";
import { SessionTreeSurface } from "./session-tree-surface.js";
import {
  formatSettingValue,
  parseSettingCommandValue,
  settingChoiceValue,
  settingCompletions,
  settingValueChoices,
} from "./settings-controls.js";
import { editorTheme, paint } from "./theme.js";
import { FixedActionDialog, WorkModalFrame } from "./work-modal.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly RuntimeThinkingLevel[];
const SUBMITTING_FEEDBACK_DELAY_MS = 200;

export function pickerContentRowBudget(terminalRows: number): number {
  const rows = Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows)) : 24;
  return Math.max(6, Math.floor(rows * 0.8) - 2); // 80% overlay minus WorkModalFrame borders
}

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
  const pendingQueue = new PendingQueueTray();
  const activity = new DockActivityLine();
  let instance = initialInstance;
  const metadata = new DockWorkMetadata(() => instance);
  const status = new DockStatusLine(instance);
  let runActivity = activityFromSnapshot(instance);
  let submittingFeedbackVisible = false;
  activity.setActivity(runActivity);
  let subscription: EventSubscription | undefined;
  let controllerLeaseToken: string | undefined;
  let activeExtensionDialog: { interactionId: string; closeFromHost: () => void } | undefined;
  let lastEventGeneration = instance.runtimeGeneration;
  let lastEventSequence = instance.eventCursor.sequence;
  let controllerReattach: Promise<void> | undefined;
  let cleanupErrors: string[] | undefined;
  let editor!: Editor;
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
  let initialHistoryLoading = true;
  let initialBufferedEvents: DockEvent[] = [];
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
    if (runActivity.phase !== "submitting" || submittingFeedbackVisible) activity.setActivity(runActivity);
    if (event.type === "session.replaced") {
      activeExtensionDialog?.closeFromHost();
      controllerLeaseToken = undefined;
      status.setController("unavailable");
      void reacquireController({ ...instance.eventCursor });
      navigationHistoryToken = undefined;
      navigationBufferedEvents = [];
      initialHistoryLoading = false;
      initialBufferedEvents = [];
      replacementHistoryGeneration = event.runtimeGeneration;
      replacementBufferedEvents = [event];
      conversation.reset();
      conversation.addNotice("Loading replacement session history…");
      terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);
      void refreshReplacementProjection(event.runtimeGeneration);
    } else if (event.type === "session.navigated") {
      const token = `${event.runtimeGeneration}:${event.sequence}`;
      replacementHistoryGeneration = undefined;
      replacementBufferedEvents = [];
      initialHistoryLoading = false;
      initialBufferedEvents = [];
      navigationHistoryToken = token;
      navigationBufferedEvents = [event];
      conversation.reset();
      conversation.addNotice("Loading navigated branch history…");
      void refreshNavigationProjection(token, event.runtimeGeneration);
    } else if (initialHistoryLoading) {
      initialBufferedEvents.push(event);
    } else if (replacementHistoryGeneration === event.runtimeGeneration) {
      replacementBufferedEvents.push(event);
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
    if (event.type === "extension.tools_expanded_changed") conversation.setToolsExpanded(event.data.expanded);
    if (event.type === "session.info_changed") terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);
    if (event.type === "instance.stopped" && editor) editor.disableSubmit = true;
    updateTerminalProgress();
    tui.requestRender();
  };

  subscription = await client.streamEvents(instance.id, { onEvent, requireTuiProjection: true, claimController: true, conversationBootstrap: true });
  const initialProjection = subscription.initial.instance;
  instance = initialProjection;
  controllerLeaseToken = subscription.initial.controller.status === "acquired"
    ? subscription.initial.controller.leaseToken
    : undefined;
  status.setController(subscription.initial.controller.status);
  if (lastEventGeneration < subscription.initial.page.latest.runtimeGeneration
    || (lastEventGeneration === subscription.initial.page.latest.runtimeGeneration && lastEventSequence < subscription.initial.page.latest.sequence)) {
    lastEventGeneration = subscription.initial.page.latest.runtimeGeneration;
    lastEventSequence = subscription.initial.page.latest.sequence;
  }
  const initialGeneration = initialProjection.runtimeGeneration;
  const initialHistory = await drainFullHistory(
    initialProjection.id,
    initialGeneration,
    subscription.initial.recentHistory,
    subscription.initial.historyTruncated,
    (beforeEntryId) => client.history(initialProjection.id, beforeEntryId, HISTORY_PAGE_SIZE),
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (shouldApplyInitialHistory(
    initialHistoryLoading,
    replacementHistoryGeneration,
    navigationHistoryToken,
    instance.runtimeGeneration,
    initialGeneration,
  )) {
    const historyEntries = initialHistory.ok ? initialHistory.value.entries : subscription.initial.recentHistory;
    const boundary = initialHistory.ok
      ? (initialHistory.value.bootstrapBoundary ?? initialProjection)
      : initialProjection;
    const buffered = initialBufferedEvents;
    const reconciled = reconcileFlowingEvents(historyEntries, subscription.initial.page.events, buffered);
    instance = boundary;
    pendingQueue.reset(subscription.initial.pendingMessages);
    for (const event of buffered) {
      if (event.runtimeGeneration !== initialGeneration || event.sequence <= boundary.eventCursor.sequence) continue;
      instance = projectSnapshot(instance, event);
    }
    for (const event of reconciled) pendingQueue.apply(event);
    conversation.applyHistory(historyEntries, false);
    conversation.applyReplay(reconciled, false);
    if (!initialHistory.ok) conversation.addNotice(`Earlier session history unavailable: ${errorText(initialHistory.error)}`, true);
    conversation.setToolsExpanded(instance.toolsExpanded);
    status.update(instance);
    runActivity = activityFromReplay(instance, reconciled);
    activity.setActivity(runActivity);
  }
  initialHistoryLoading = false;
  initialBufferedEvents = [];

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
  if (commandsLoad.status === "fulfilled") {
    commands = commandsLoad.value.commands;
    if (commandsLoad.value.truncated) conversation.addNotice(`Command catalog is bounded: showing ${commands.length} of ${commandsLoad.value.total}.`, true);
  } else conversation.addNotice(`Command catalog unavailable: ${errorText(commandsLoad.reason)}`, true);

  editor = new Editor(tui, editorTheme, {
    paddingX: numericSetting(settings, "editorPaddingX", 1),
    autocompleteMaxVisible: numericSetting(settings, "autocompleteMaxVisible", 10),
  });
  tui.setShowHardwareCursor(booleanSetting(settings, "showHardwareCursor", process.env.PI_HARDWARE_CURSOR === "1"));
  // Work owns native main-buffer scrollback. Stock pi-tui's clear-on-shrink
  // path emits ESC[3J, so this client deliberately never enables it.
  tui.setClearOnShrink(false);
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
      runActivity = { phase: "aborting", label: "stopping" };
      activity.setActivity(runActivity);
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
    const operationId = randomUUID();
    const submitting = submittingActivity();
    const projectSubmitting = runActivity.phase === "idle" && instance.execution !== "running";
    if (projectSubmitting) runActivity = submitting;
    submittingFeedbackVisible = false;
    const feedbackTimer = setTimeout(() => {
      if (exiting || !projectSubmitting || runActivity !== submitting) return;
      submittingFeedbackVisible = true;
      activity.setActivity(submitting);
      tui.requestRender();
    }, SUBMITTING_FEEDBACK_DELAY_MS);
    feedbackTimer.unref?.();
    try {
      const result = await client.prompt(instance.id, message, delivery, operationId);
      instance = result.instance;
      status.update(instance);
      // A successful admission receipt is not a model run. The stream's
      // run.started or command.handled event alone closes submitting.
    } catch (error) {
      // Submission consumed the editor's only copy before transport/admission
      // completed. Restore it locally, but never retry automatically.
      const effectUnknown = error instanceof ControlClientError && error.code === "effect_unknown";
      const recovery = submissionRecovery(
        editor.getText(),
        message,
        delivery,
        effectUnknown,
        effectUnknown ? error.operationId ?? operationId : operationId,
      );
      editor.setText(recovery.draft);
      showError(error);
      conversation.addNotice(recovery.notice, true);
      if (runActivity === submitting) {
        runActivity = activityFromSnapshot(instance);
        activity.setActivity(runActivity);
      }
    } finally {
      clearTimeout(feedbackTimer);
      submittingFeedbackVisible = false;
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
    showStatus("restoring queued messages");
    try {
      const result = await client.dequeue(instance.id);
      instance = result.instance;
      status.update(instance);
      pendingQueue.remove([...result.receipt.restored, ...result.receipt.inFlight].map((message) => message.queueItemId));
      restoreMessagesToEditor(result.receipt.restored);
      if (result.receipt.inFlight.length > 0) {
        const count = result.receipt.inFlight.length;
        conversation.addNotice(`${count} queued message${count === 1 ? " is" : "s are"} already entering Pi consumption and cannot be restored safely; the run was not aborted.`, true);
        return false;
      }
      showStatus(result.receipt.restored.length > 0
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
      showStatus("nothing to abort");
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
    showStatus("loading models");
    try {
      const catalog = await client.models(instance.id);
      instance = catalog.instance;
      status.update(instance);
      if (catalog.truncated) conversation.addNotice(`Model catalog is bounded: showing ${catalog.models.length} of ${catalog.total}.`, true);
      const selected = await showModelPicker(catalog.models);
      if (selected) await switchModel(selected.provider, selected.id);
      else showStatus("model unchanged");
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
    options: { pageNavigation?: boolean } = {},
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
        maxRows: () => pickerContentRowBudget(terminal.rows),
        ...(currentValue === undefined ? {} : { initialValue: currentValue }),
        ...(options.pageNavigation === undefined ? {} : { pageNavigation: options.pageNavigation }),
        requestRender: () => tui.requestRender(),
      },
    );
    let resolveChoice!: (value: string | undefined) => void;
    const selection = new Promise<string | undefined>((resolve) => { resolveChoice = resolve; });
    picker.onSelect = (item) => resolveChoice(item.value);
    picker.onCancel = () => resolveChoice(undefined);
    const frame = new WorkModalFrame(picker);
    const overlay = tui.showOverlay(frame, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    tui.setFocus(frame);
    try { return await selection; }
    finally { overlay.hide(); }
  }

  async function showFixedActions<T extends string>(
    titleText: string,
    body: readonly string[],
    items: Array<{ value: T; label: string; description?: string }>,
    initialValue?: T,
  ): Promise<T | undefined> {
    if (items.length === 0) return undefined;
    const dialog = new FixedActionDialog(
      terminalSafe(titleText),
      body.map(terminalSafe),
      items.map((item) => ({
        value: item.value,
        label: terminalSafe(item.label),
        ...(item.description === undefined ? {} : { description: terminalSafe(item.description) }),
      })),
      initialValue,
    );
    let resolveChoice!: (value: T | undefined) => void;
    const selection = new Promise<T | undefined>((resolve) => { resolveChoice = resolve; });
    dialog.onSelect = resolveChoice;
    dialog.onCancel = () => resolveChoice(undefined);
    const frame = new WorkModalFrame(dialog);
    const overlay = tui.showOverlay(frame, { width: "90%", minWidth: 44, maxHeight: "88%", anchor: "center", margin: 0 });
    tui.setFocus(frame);
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

    let component: SearchablePicker | FixedActionDialog<"yes" | "no"> | ExtensionTextDialog;
    if (request.method === "select") {
      const picker = new SearchablePicker(
        request.options.map((option) => ({ value: option, label: option })),
        {
          title: request.title,
          footer: "type to filter · ↑↓ choose · Enter select · Esc cancel",
          maxVisible: Math.min(request.options.length, 14),
          maxRows: () => pickerContentRowBudget(terminal.rows),
          requestRender: () => tui.requestRender(),
        },
      );
      picker.onSelect = (item) => finish({ response: { method: "select", value: item.value }, fromHost: false });
      picker.onCancel = () => finish({ response: { method: "select", cancelled: true }, fromHost: false });
      component = picker;
    } else if (request.method === "confirm") {
      const dialog = new FixedActionDialog(
        request.title,
        [request.message],
        [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
        "no",
      );
      dialog.onSelect = (value) => finish({ response: { method: "confirm", confirmed: value === "yes" }, fromHost: false });
      dialog.onCancel = () => finish({ response: { method: "confirm", cancelled: true }, fromHost: false });
      component = dialog;
    } else {
      const dialog = new ExtensionTextDialog({
        mode: request.method,
        title: request.title,
        ...(request.method === "input" && request.placeholder !== undefined ? { placeholder: request.placeholder } : {}),
        ...(request.method === "editor" && request.prefill !== undefined ? { prefill: request.prefill } : {}),
        requestRender: () => tui.requestRender(),
        tui,
        maxRows: () => pickerContentRowBudget(terminal.rows),
      });
      dialog.onSubmit = (value) => finish({ response: { method: request.method, value }, fromHost: false });
      dialog.onCancel = () => finish({ response: { method: request.method, cancelled: true }, fromHost: false });
      component = dialog;
    }

    activeExtensionDialog = {
      interactionId: request.interactionId,
      closeFromHost: () => finish({ fromHost: true }),
    };
    const frame = new WorkModalFrame(component);
    const overlay = tui.showOverlay(frame, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    tui.setFocus(frame);
    try {
      return await result;
    } finally {
      overlay.hide();
      if (activeExtensionDialog?.interactionId === request.interactionId) activeExtensionDialog = undefined;
      tui.requestRender();
    }
  }

  async function chooseSetting(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("loading settings");
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
      if (!key) { showStatus("settings unchanged"); return; }
      const setting = settings.find((candidate) => candidate.key === key);
      if (!setting || !setting.writable) {
        conversation.addNotice(`${key} is read-only.`, true);
        return;
      }
      if (setting.valueType === "integer") {
        editor.setText(`/settings ${setting.key} ${String(setting.value)}`);
        conversation.addNotice(`Edit the integer value for ${setting.key}, then press Enter.`);
        showStatus("setting ready to edit");
        return;
      }
      const choices = settingValueChoices(setting);
      const selected = await showFixedActions(
        `Set ${setting.key}`,
        [`Current: ${formatSettingValue(setting.value)} · ${setting.source}`],
        choices,
        settingChoiceValue(setting),
      );
      if (selected === undefined) { showStatus("setting unchanged"); return; }
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
    showStatus(`setting ${update.key}`);
    tui.requestRender();
    try {
      const result = await client.updateSetting(instance.id, update);
      instance = result.instance;
      status.update(instance);
      settings = settings.map((setting) => setting.key === result.setting.key ? result.setting : setting);
      applyLiveSetting(result.setting.key, result.setting.value);
      const boundary = result.hostRestartRequired ? " · Host restart required" : result.reloadRequired ? " · run /reload" : "";
      conversation.addNotice(`${result.setting.key} = ${formatSettingValue(result.setting.value)}${boundary}`);
      showStatus(`setting ${result.setting.key} saved`);
      rebuildAutocomplete();
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
    }
  }

  async function chooseTools(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("loading tools");
    tui.requestRender();
    try {
      const catalog = await client.tools(instance.id);
      let tools = catalog.tools;
      if (catalog.truncated) conversation.addNotice(`Tool catalog is bounded: showing ${tools.length} of ${catalog.total}.`, true);
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
        if (result.truncated) conversation.addNotice(`Tool catalog is bounded: showing ${tools.length} of ${result.total}.`, true);
        showStatus(`tool ${selected} toggled`);
      }
      showStatus("tools updated");
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
    showStatus("updating tools");
    tui.requestRender();
    try {
      const result = await client.setActiveTools(instance.id, names);
      instance = result.instance;
      status.update(instance);
      conversation.addNotice(`Active tools: ${result.tools.filter((tool) => tool.active).map((tool) => tool.name).join(", ") || "none"}.`);
      if (result.truncated) conversation.addNotice(`Tool catalog is bounded: showing ${result.tools.length} of ${result.total}.`, true);
      showStatus("tools updated");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function chooseThinking(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("loading thinking levels");
    tui.requestRender();
    try {
      const result = await client.models(instance.id);
      instance = result.instance;
      status.update(instance);
      const selected = await showFixedActions(
        "Thinking level",
        [`Current: ${instance.executor.thinkingLevel ?? "off"}`],
        result.availableThinkingLevels.map((level) => ({ value: level, label: level })),
        instance.executor.thinkingLevel,
      );
      if (selected && isThinkingLevel(selected)) await switchThinking(selected);
      else showStatus("thinking unchanged");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function loadSessionTree(): Promise<{ nodes: TreeNodeDto[]; leafId?: string; total: number; revision: string; capped: boolean }> {
    return collectSessionTree((revision, cursor, limit) => client.tree(instance.id, revision, cursor, limit));
  }

  async function chooseTreeListNode(
    titleText: string,
    predicate: (node: TreeNodeDto) => boolean,
  ): Promise<TreeNodeDto | undefined> {
    const byId = new Map<string, TreeNodeDto>();
    const picker = new SearchablePicker([], {
      title: terminalSafe(titleText),
      body: "Loading the complete session tree…",
      footer: "type text/id/label · ↑↓ move · ←→/PgUp/PgDn page · Enter select · Esc cancel",
      maxVisible: 14,
      maxRows: () => pickerContentRowBudget(terminal.rows),
      pageNavigation: true,
      requestRender: () => tui.requestRender(),
    });
    picker.setEmptyText("Loading…");
    let active = true;
    let resolveChoice!: (value: string | undefined) => void;
    const selection = new Promise<string | undefined>((resolve) => { resolveChoice = resolve; });
    picker.onSelect = (item) => resolveChoice(item.value);
    picker.onCancel = () => resolveChoice(undefined);
    const frame = new WorkModalFrame(picker);
    const overlay = tui.showOverlay(frame, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    tui.setFocus(frame);

    void loadSessionTree().then((tree) => {
      if (!active) return;
      const candidates = tree.nodes.filter(predicate);
      for (const node of candidates) byId.set(node.entryId, node);
      picker.replaceItems(treePickerItems(candidates, tree.leafId, tree.nodes));
      picker.setSelectedValue(tree.leafId);
      picker.setEmptyText("The current Pi session tree has no matching entries");
      picker.setBody(tree.capped
        ? `Loaded ${tree.nodes.length.toLocaleString()} of ${tree.total.toLocaleString()} bounded entries`
        : undefined);
    }).catch(() => {
      if (!active) return;
      picker.setEmptyText("Session tree unavailable");
      picker.setBody("Could not load the session tree. Press Esc to return.");
    });

    try {
      const selected = await selection;
      return selected === undefined ? undefined : byId.get(selected);
    } finally {
      active = false;
      overlay.hide();
    }
  }

  async function chooseTreeNavigation(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("loading session tree");
    tui.requestRender();
    const configuredFilter = settings.find((setting) => setting.key === "treeFilterMode")?.value;
    const surface = new SessionTreeSurface({
      title: "Navigate session tree",
      initialFilter: isTreeFilterMode(configuredFilter) ? configuredFilter : "default",
      terminalRows: () => terminal.rows,
      requestRender: () => tui.requestRender(),
    });
    const frame = new WorkModalFrame(surface);
    const treeOverlay = tui.showOverlay(frame, { width: "98%", minWidth: 36, maxHeight: "96%", anchor: "center", margin: 0 });
    let active = true;
    let leafId: string | undefined;
    const nextSelection = (): Promise<TreeNodeDto | undefined> => new Promise((resolve) => {
      let settled = false;
      const finish = (node: TreeNodeDto | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(node);
      };
      surface.onSelect = finish;
      surface.onCancel = () => finish(undefined);
    });
    void loadSessionTree().then((tree) => {
      if (!active) return;
      leafId = tree.leafId;
      surface.replaceTree(tree.nodes, tree.leafId);
    }).catch(() => {
      if (active) surface.setLoadFailure("Session tree unavailable · press Esc to return");
    });
    try {
      while (true) {
        treeOverlay.focus();
        const target = await nextSelection();
        if (!target) { showStatus("tree unchanged"); return; }
        if (target.entryId === leafId) {
          showStatus("already at this point");
          continue;
        }
        const targetRole = target.role ?? target.kind;
        const action = await showFixedActions("Branch action", [
          `Target: ${target.label ? `[${target.label}] ` : ""}${target.summary}`,
          `${targetRole} · ${target.entryId}${leafId ? ` · current leaf ${leafId}` : ""}`,
        ], [
          { value: "navigate", label: "Navigate directly", description: "Switch to this branch point without model summarization." },
          { value: "summary", label: "Navigate with summary", description: "Ask Pi to summarize the abandoned branch before switching." },
          { value: "custom", label: "Summary with additional instructions", description: "Add guidance while keeping Pi's branch-summary behavior." },
          { value: "replace", label: "Summary with replacement instructions", description: "Replace Pi's default branch-summary instructions." },
        ], "navigate");
        if (!action) continue;
        const options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {};
        if (action !== "navigate") options.summarize = true;
        if (action === "custom" || action === "replace") {
          const instructions = await showLocalTextDialog("Branch summary instructions", "editor", "Describe what the summary must preserve");
          if (instructions === undefined || instructions.trim().length === 0) continue;
          options.customInstructions = instructions;
          if (action === "replace") options.replaceInstructions = true;
        }
        if (options.summarize) {
          const labelMode = await showFixedActions("Optional branch label", [
            `Target: ${target.summary}`,
          ], [
            { value: "none", label: "No label", description: "Navigate without changing the target label." },
            { value: "label", label: "Add label", description: "Name this branch point before navigation completes." },
          ], "none");
          if (labelMode === undefined) continue;
          if (labelMode === "label") {
            const label = await showLocalTextDialog("Branch label", "input", "Short label for the navigation target");
            if (label === undefined) continue;
            if (label.trim()) options.label = label.trim();
          }
        }
        active = false;
        treeOverlay.hide();
        await navigateTree(target.entryId, options);
        return;
      }
    } catch (error) { showError(error); }
    finally {
      active = false;
      treeOverlay.hide();
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
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
    showStatus(options.summarize ? "summarizing branch · Esc/Ctrl+C abort" : "navigating tree");
    tui.requestRender();
    const draftWasEmpty = editor.getText().length === 0;
    try {
      const result = await client.navigateSession(instance.id, targetId, options);
      instance = result.instance;
      status.update(instance);
      if (result.editorText !== undefined && draftWasEmpty && editor.getText().length === 0) editor.setText(result.editorText);
      showStatus(result.cancelled ? result.aborted || treeNavigationAbortRequested ? "navigation aborted" : "navigation cancelled by extension" : "branch selected");
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
    showStatus("aborting branch navigation");
    tui.requestRender();
    try { await client.abort(instance.id); }
    catch (error) { showError(error); }
    finally { treeNavigationAbortPending = false; }
  }

  async function chooseForkTarget(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("loading fork targets");
    tui.requestRender();
    try {
      const target = await chooseTreeListNode("Fork before user message", (node) => node.kind === "message" && node.role === "user");
      if (target) await forkSession(target.entryId);
      else showStatus("fork cancelled");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function forkSession(entryId: string): Promise<void> {
    editor.disableSubmit = true;
    showStatus("forking session");
    tui.requestRender();
    try {
      const result = await client.forkSession(instance.id, entryId);
      instance = result.instance;
      status.update(instance);
      if (result.selectedText !== undefined) editor.setText(result.selectedText);
      showStatus(result.cancelled ? "fork cancelled by extension" : "fork ready · edit and submit selected prompt");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function cloneSession(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("finding current leaf");
    tui.requestRender();
    try {
      const tree = await client.tree(instance.id, undefined, undefined, 1);
      if (!tree.leafId) {
        conversation.addNotice("The current session has no leaf to clone.", true);
        showStatus("clone unavailable");
        return;
      }
      const result = await client.cloneSession(instance.id, tree.leafId);
      instance = result.instance;
      status.update(instance);
      if (!result.cancelled) editor.setText("");
      showStatus(result.cancelled ? "clone cancelled by extension" : "session cloned");
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
      maxRows: () => pickerContentRowBudget(terminal.rows),
    });
    let resolveText!: (value: string | undefined) => void;
    const result = new Promise<string | undefined>((resolve) => { resolveText = resolve; });
    dialog.onSubmit = (value) => resolveText(value);
    dialog.onCancel = () => resolveText(undefined);
    const frame = new WorkModalFrame(dialog);
    const overlay = tui.showOverlay(frame, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    tui.setFocus(frame);
    try { return await result; }
    finally { overlay.hide(); }
  }

  async function chooseSession(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("loading sessions");
    tui.requestRender();
    try {
      const target = await showSessionInventoryPicker();
      if (!target) { showStatus("session unchanged"); return; }
      await resumeSession(target.sessionFile);
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function showSessionInventoryPicker(): Promise<SessionDto | undefined> {
    const sessionsByValue = new Map<string, SessionDto>();
    const picker = new SearchablePicker([], {
      title: "Resume Pi session",
      body: "Loading persisted Pi sessions…",
      maxVisible: 14,
      maxRows: () => pickerContentRowBudget(terminal.rows),
      requestRender: () => tui.requestRender(),
    });
    picker.setEmptyText("Loading…");
    let active = true;
    let resolveChoice!: (value: string | undefined) => void;
    const selection = new Promise<string | undefined>((resolve) => { resolveChoice = resolve; });
    picker.onSelect = (item) => resolveChoice(item.value);
    picker.onCancel = () => resolveChoice(undefined);
    const frame = new WorkModalFrame(picker);
    const overlay = tui.showOverlay(frame, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    tui.setFocus(frame);

    void client.sessionInventory(instance.cwd, "cwd").then((inventory) => {
      if (!active) return;
      const sessions = [...inventory.sessions]
        .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
      const items = sessions.map((session, index) => {
        const value = String(index);
        sessionsByValue.set(value, session);
        return {
          value,
          label: session.name ?? session.sessionId,
          description: `${session.cwd}${session.sessionFile === instance.executor.sessionFile ? " · current" : ""}${session.updatedAt ? ` · ${session.updatedAt}` : ""}`,
        };
      });
      picker.replaceItems(items);
      picker.setEmptyText(inventory.incomplete ? "No readable persisted Pi sessions found" : "No persisted Pi sessions found");
      const inventoryNotices = [
        ...(inventory.truncated ? [`Showing ${sessions.length.toLocaleString()} of ${inventory.total.toLocaleString()} persisted sessions`] : []),
        ...(inventory.incomplete ? [`Inventory incomplete: ${inventory.diagnostics[0]?.message ?? "one or more saved sessions could not be inspected"}${inventory.diagnosticsTruncated ? " · more diagnostics omitted" : ""}`] : []),
      ];
      picker.setBody(inventoryNotices.length > 0 ? inventoryNotices.join(" · ") : undefined);
    }).catch(() => {
      if (!active) return;
      picker.setEmptyText("Session inventory unavailable");
      picker.setBody("Could not load persisted Pi sessions. Press Esc to return.");
    });

    try {
      const selected = await selection;
      return selected === undefined ? undefined : sessionsByValue.get(selected);
    } finally {
      active = false;
      overlay.hide();
    }
  }

  async function resumeSession(sessionFile: string): Promise<void> {
    editor.disableSubmit = true;
    showStatus("resuming session");
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
        if (!decision) { showStatus("resume cancelled"); return; }
        result = await client.switchSession(instance.id, sessionFile, operationId, { challengeId: challenge.challengeId, decision });
      }
      instance = result.instance;
      status.update(instance);
      showStatus(result.cancelled ? "resume cancelled by extension" : "session resumed");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function chooseProjectTrust(cwd: string): Promise<ProjectTrustChoice | undefined> {
    const selected = await showFixedActions("Project-local Pi resources", [cwd], [
      { value: "trust_once", label: "Trust once", description: "Load project resources for this operation." },
      { value: "trust_and_remember", label: "Trust and remember", description: "Load project resources and persist this decision." },
      { value: "deny_once", label: "Do not trust once", description: "Continue without project resources." },
      { value: "deny_and_remember", label: "Do not trust and remember", description: "Continue without project resources and persist this decision." },
    ]);
    return isProjectTrustChoice(selected) ? selected : undefined;
  }

  async function createNewSession(parentSession?: string): Promise<void> {
    editor.disableSubmit = true;
    showStatus("creating session");
    tui.requestRender();
    try {
      const result = await client.newSession(instance.id, parentSession);
      instance = result.instance;
      status.update(instance);
      showStatus(result.cancelled ? "new session cancelled by extension" : "new session ready");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function nameSession(name: string): Promise<void> {
    editor.disableSubmit = true;
    showStatus("naming session");
    tui.requestRender();
    try {
      const result = await client.nameSession(instance.id, name);
      instance = result.instance;
      status.update(instance);
      terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);
      conversation.addNotice(instance.name ? `Session name: ${terminalSafe(instance.name)}.` : "Session name cleared.");
      showStatus(instance.name ? `named ${terminalSafe(instance.name)}` : "session name cleared");
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function compactSession(customInstructions?: string): Promise<void> {
    tui.requestRender();
    try {
      const result = await client.compactSession(instance.id, customInstructions);
      instance = result.instance;
      status.update(instance);
      conversation.addNotice(`Compacted ${result.result.tokensBefore.toLocaleString()} tokens · kept from ${result.result.firstKeptEntryId}.`);
      runActivity = activityFromSnapshot(instance);
      activity.setActivity(runActivity);
    } catch (error) {
      if (error instanceof ControlClientError && error.code === "compaction_not_needed") {
        showStatus("nothing to compact");
        runActivity = activityFromSnapshot(instance);
        activity.setActivity(runActivity);
      } else if (error instanceof ControlClientError && error.code === "compaction_cancelled") {
        showStatus("compaction cancelled");
        runActivity = activityFromSnapshot(instance);
        activity.setActivity(runActivity);
      } else {
        showError(error);
      }
    }
    finally { tui.requestRender(); }
  }

  async function reloadSession(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("reloading resources");
    tui.requestRender();
    try {
      const result = await client.reloadSession(instance.id);
      instance = result.instance;
      status.update(instance);
      for (const diagnostic of result.diagnostics) conversation.addNotice(`${diagnostic.severity}: ${diagnostic.message}`, diagnostic.severity === "error");
      showStatus(`reloaded ${result.resources.length} resources`);
      if (result.resourcesTruncated || result.diagnosticsTruncated) {
        conversation.addNotice(`Reload projection is bounded: ${result.resources.length}/${result.resourceTotal} resources · ${result.diagnostics.length}/${result.diagnosticTotal} diagnostics.`, true);
      }
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.requestRender(); }
  }

  async function showResources(): Promise<void> {
    editor.disableSubmit = true;
    showStatus("loading resources");
    tui.requestRender();
    try {
      const result = await client.resources(instance.id);
      for (const diagnostic of result.diagnostics) conversation.addNotice(`${diagnostic.severity}: ${diagnostic.message}${diagnostic.source ? ` · ${diagnostic.source}` : ""}`, diagnostic.severity === "error");
      const indexed = result.resources.map((resource, index) => ({ resource, value: String(index) }));
      const selected = await showChoicePicker("Pi resources", indexed.map(({ resource, value }) => ({ value, label: `${resource.kind}: ${resource.name}`, description: resource.path ?? resource.source?.package ?? resource.source?.kind })));
      const resource = indexed.find((candidate) => candidate.value === selected)?.resource;
      if (resource) conversation.addNotice(`${resource.kind} ${resource.name}${resource.path ? ` · ${resource.path}` : ""}`);
      showStatus(`${result.resources.length} resources · ${result.diagnostics.length} diagnostics`);
      if (result.resourcesTruncated || result.diagnosticsTruncated) {
        conversation.addNotice(`Resource projection is bounded: ${result.resources.length}/${result.resourceTotal} resources · ${result.diagnostics.length}/${result.diagnosticTotal} diagnostics.`, true);
      }
    } catch (error) { showError(error); }
    finally { if (instance.lifecycle === "active") editor.disableSubmit = false; tui.setFocus(editor); tui.requestRender(); }
  }

  async function switchModel(provider: string, modelId: string): Promise<void> {
    editor.disableSubmit = true;
    showStatus(`switching to ${provider}/${modelId}`);
    tui.requestRender();
    try {
      const result = await client.setModel(instance.id, provider, modelId);
      instance = result.instance;
      status.update(instance);
      showStatus(`model ${modelId}`);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function switchThinking(level: RuntimeThinkingLevel): Promise<void> {
    editor.disableSubmit = true;
    showStatus(`thinking ${level}`);
    tui.requestRender();
    try {
      const result = await client.setThinking(instance.id, level);
      instance = result.instance;
      status.update(instance);
      showStatus(`thinking ${instance.executor.thinkingLevel ?? level}`);
    } catch (error) {
      showError(error);
    } finally {
      if (instance.lifecycle === "active") editor.disableSubmit = false;
      tui.requestRender();
    }
  }

  async function refreshStatus(): Promise<void> {
    showStatus("refreshing");
    tui.requestRender();
    try {
      instance = await client.status(instance.id);
      status.update(instance);
      conversation.addNotice(formatWorkStatus(instance));
      showStatus("status refreshed");
    } catch (error) {
      showError(error);
    }
    tui.requestRender();
  }

  async function refreshReplacementProjection(generation: number): Promise<void> {
    const [projectionLoad, settingsLoad, commandsLoad] = await Promise.allSettled([
      (async () => {
        const projection = await client.streamEvents(instance.id, {
          onEvent: () => {},
          requireTuiProjection: true,
          conversationBootstrap: true,
        });
        projection.close();
        await projection.done.catch(() => {});
        return projection.initial;
      })(),
      client.settings(instance.id),
      client.commands(instance.id),
    ]);
    if (replacementHistoryGeneration !== generation) return;

    conversation.reset();
    let reconciled: DockEvent[] = [];
    if (projectionLoad.status === "fulfilled") {
      const projection = projectionLoad.value;
      const full = await drainFullHistory(
        instance.id,
        generation,
        projection.recentHistory,
        projection.historyTruncated,
        (beforeEntryId) => client.history(instance.id, beforeEntryId, HISTORY_PAGE_SIZE),
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (replacementHistoryGeneration !== generation || instance.runtimeGeneration !== generation) return;
      const buffered = replacementBufferedEvents;
      replacementBufferedEvents = [];
      replacementHistoryGeneration = undefined;
      const historyEntries = full.ok ? full.value.entries : projection.recentHistory;
      const historyBoundary = full.ok
        ? (full.value.bootstrapBoundary ?? projection.instance)
        : projection.instance;
      reconciled = reconcileFlowingEvents(historyEntries, projection.page.events, buffered);
      instance = historyBoundary;
      pendingQueue.reset(projection.pendingMessages);
      for (const event of buffered) {
        if (event.runtimeGeneration !== generation || event.sequence <= historyBoundary.eventCursor.sequence) continue;
        instance = projectSnapshot(instance, event);
        pendingQueue.apply(event);
      }
      status.update(instance);
      terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);
      conversation.applyHistory(historyEntries, false);
      conversation.applyReplay(reconciled, false);
      if (!full.ok) conversation.addNotice(`Replacement history unavailable: ${errorText(full.error)}`, true);
      conversation.setToolsExpanded(instance.toolsExpanded);
    } else {
      const buffered = replacementBufferedEvents;
      replacementBufferedEvents = [];
      replacementHistoryGeneration = undefined;
      reconciled = reconcileFlowingEvents([], [], buffered);
      conversation.addNotice(`Replacement history unavailable: ${errorText(projectionLoad.reason)}`, true);
      conversation.applyReplay(reconciled, false);
      conversation.setToolsExpanded(instance.toolsExpanded);
    }

    if (settingsLoad.status === "fulfilled") {
      settings = settingsLoad.value.settings;
      for (const setting of settings) applyLiveSetting(setting.key, setting.value);
    } else {
      conversation.addNotice(`Replacement settings unavailable: ${errorText(settingsLoad.reason)}`, true);
    }
    if (commandsLoad.status === "fulfilled") {
      commands = commandsLoad.value.commands;
      if (commandsLoad.value.truncated) conversation.addNotice(`Replacement command catalog is bounded: showing ${commands.length} of ${commandsLoad.value.total}.`, true);
    } else conversation.addNotice(`Replacement command catalog unavailable: ${errorText(commandsLoad.reason)}`, true);
    rebuildAutocomplete();
    if (instance.execution === "running" || instance.compacting) {
      runActivity = activityFromReplay(instance, reconciled);
      activity.setActivity(runActivity);
    } else {
      runActivity = activityFromSnapshot(instance);
      activity.setActivity(runActivity);
    }
    tui.requestRender();
  }

  async function refreshNavigationProjection(token: string, generation: number): Promise<void> {
    const loaded = await (async () => {
      const projection = await client.streamEvents(instance.id, {
        onEvent: () => {},
        requireTuiProjection: true,
        conversationBootstrap: true,
      });
      projection.close();
      await projection.done.catch(() => {});
      const full = await drainFullHistory(
        instance.id,
        generation,
        projection.initial.recentHistory,
        projection.initial.historyTruncated,
        (beforeEntryId) => client.history(instance.id, beforeEntryId, HISTORY_PAGE_SIZE),
      );
      return { projection: projection.initial, full };
    })().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (navigationHistoryToken !== token || instance.runtimeGeneration !== generation) return;
    const buffered = navigationBufferedEvents;
    navigationBufferedEvents = [];
    navigationHistoryToken = undefined;
    conversation.reset();
    if (!loaded.ok) {
      conversation.addNotice(`Navigated branch history unavailable: ${errorText(loaded.error)}`, true);
      conversation.applyReplay(reconcileFlowingEvents([], [], buffered), false);
      conversation.setToolsExpanded(instance.toolsExpanded);
      tui.requestRender();
      return;
    }
    const { projection, full } = loaded.value;
    const boundary = full.bootstrapBoundary ?? projection.instance;
    const reconciled = reconcileFlowingEvents(full.entries, projection.page.events, buffered);
    instance = boundary;
    for (const event of buffered) {
      if (event.runtimeGeneration !== generation || event.sequence <= boundary.eventCursor.sequence) continue;
      instance = projectSnapshot(instance, event);
    }
    status.update(instance);
    conversation.applyHistory(full.entries, false);
    conversation.applyReplay(reconciled, false);
    conversation.setToolsExpanded(instance.toolsExpanded);
    status.update(instance);
    if (instance.execution === "running" || instance.compacting) {
      runActivity = activityFromReplay(instance, reconciled);
      activity.setActivity(runActivity);
    } else {
      runActivity = activityFromSnapshot(instance);
      activity.setActivity(runActivity);
    }
    tui.requestRender();
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

  function showStatus(message: string): void {
    if (exiting) return;
    conversation.addStatus(message);
    tui.requestRender();
  }

  function showError(error: unknown): void {
    if (exiting) return;
    const message = error instanceof ControlClientError
      ? `${error.code}: ${error.message}`
      : errorText(error);
    conversation.addNotice(message, true);
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
    // clearOnShrink remains a shared Pi setting, but Work keeps it disabled to
    // preserve terminal-native scrollback and avoid normal-update ESC[3J.
    if (key === "showTerminalProgress" && typeof value === "boolean") {
      terminalProgressEnabled = value;
      updateTerminalProgress();
    }
    if (key === "autoCompaction" && typeof value === "boolean") status.setAutoCompaction(value);
  }

  function updateTerminalProgress(): void {
    terminal.setProgress(terminalProgressEnabled && instance.lifecycle === "active" && instance.execution === "running");
  }

  async function toggleAuthoritativeToolsExpanded(): Promise<void> {
    const expectedRuntimeGeneration = instance.runtimeGeneration;
    const expanded = !instance.toolsExpanded;
    try {
      const result = await client.setToolsExpanded(instance.id, expectedRuntimeGeneration, expanded, randomUUID());
      if (result.instance.runtimeGeneration !== expectedRuntimeGeneration) return;
      if (snapshotIsNotOlder(result.instance, instance)) {
        instance = result.instance;
        status.update(instance);
        conversation.setToolsExpanded(instance.toolsExpanded);
        showStatus(expanded ? "all tools expanded" : "tools collapsed");
      }
    } catch (error) {
      showError(error);
    }
    tui.requestRender();
  }

  const activityPulse = new ActivityPulseController(activity, {
    requestRender: () => tui.requestRender(),
  }, {
    canWrite: () => !exiting && !tui.hasOverlay(),
  });
  activity.setAnimationListener(() => activityPulse.sync());

  const workFlow = new Container();
  workFlow.addChild(conversation);
  workFlow.addChild(activity);
  workFlow.addChild(pendingQueue);
  workFlow.addChild(editor);
  workFlow.addChild(metadata);
  workFlow.addChild(status);
  tui.addChild(workFlow);
  tui.setFocus(editor);
  terminal.setTitle(`Alu Dock · ${terminalSafe(instance.name || instance.id.slice(0, 8))}`);

  const removeInputListener = tui.addInputListener((data) => {
    if (tui.hasOverlay()) return undefined;
    if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
      finish("detached");
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("o"))) {
      const toggled = conversation.toggleLatestDetailExpanded();
      if (toggled) showStatus(`${toggled.name} ${toggled.expanded ? "expanded" : "collapsed"}`);
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      void toggleAuthoritativeToolsExpanded();
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
          if (action !== "none") showStatus(`Esc again to open ${action === "fork" ? "fork" : "tree"}`);
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
        showStatus("input cleared");
      } else if (instance.execution === "running") {
        void abortRun();
      } else {
        showStatus("Ctrl+D detaches");
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
  // Detach is a local control action. Close every client transport immediately;
  // sent mutations remain Host-owned and may complete after this process exits.
  subscription.close();
  client.closeActiveConnections();
  await Promise.all([
    controllerReattach?.catch(() => {}),
    subscription.done.catch(() => {}),
  ]);
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

export function formatWorkStatus(snapshot: InstanceSnapshot): string {
  const model = snapshot.executor.model
    ? `${terminalSafe(snapshot.executor.model.provider)}/${terminalSafe(snapshot.executor.model.id)}`
    : "none";
  return [
    `Status: ${snapshot.lifecycle === "active" ? snapshot.execution : snapshot.lifecycle}`,
    `Session: ${terminalSafe(snapshot.name || "(unnamed)")}`,
    `Work cwd: ${terminalSafe(snapshot.cwd)}${snapshot.gitBranch === undefined ? "" : ` (${terminalSafe(snapshot.gitBranch)})`}`,
    `Model: ${model} · thinking ${terminalSafe(snapshot.executor.thinkingLevel ?? "off")}`,
    `Dock ID: ${terminalSafe(snapshot.id)}`,
    `Pi session ID: ${terminalSafe(snapshot.executor.piSessionId)}`,
    `Runtime generation: ${snapshot.runtimeGeneration}`,
  ].join("\n");
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
    "  /config                   show Pi CLI config ownership",
    "  /install                  show Pi CLI package ownership",
    "  /login                    show Pi CLI login ownership",
    "EXTENSION",
    "  Ctrl+O                    set all tool details for this runtime",
    "  Alt+O                     toggle the latest detail locally",
    "  Type / to discover extension, skill, and prompt commands.",
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

export function shouldApplyInitialHistory(
  loading: boolean,
  replacementGeneration: number | undefined,
  navigationToken: string | undefined,
  currentGeneration: number,
  initialGeneration: number,
): boolean {
  return loading
    && replacementGeneration === undefined
    && navigationToken === undefined
    && currentGeneration === initialGeneration;
}

export function snapshotIsNotOlder(candidate: InstanceSnapshot, current: InstanceSnapshot): boolean {
  return candidate.eventCursor.hostEpoch === current.eventCursor.hostEpoch
    && candidate.eventCursor.instanceId === current.eventCursor.instanceId
    && candidate.eventCursor.runtimeGeneration === current.eventCursor.runtimeGeneration
    && candidate.eventCursor.sequence >= current.eventCursor.sequence;
}

function errorText(error: unknown): string {
  return error instanceof Error ? terminalSafe(error.message) : terminalSafe(String(error));
}
