import { randomUUID } from "node:crypto";

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  TuiMainScreen,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import { ControlClientError, DockClient, type EventSubscription, type OperationSubscription } from "../control/dock-client.js";
import { humanInstanceStatus } from "../core/instance-display-name.js";
import type { InteractionResponse } from "../core/extension-ui-broker.js";
import type { CommandDto, SettingDto, SettingUpdate } from "../core/config-projection.js";
import type { DeliveryMode, DockEvent, EventCursor, HistoryEntryDto, InstanceSnapshot, PendingMessageDto, SessionDto, TreeNodeDto } from "../core/managed-instance.js";
import type {
  AgentModelInfo,
  ThinkingLevel,
} from "../core/agent-worker.js";
import type { ProjectTrustChoice } from "../control/project-trust.js";
import { ActivityPulseController } from "./activity-pulse.js";
import { DockActivityLine, DockConversation, DockStatusLine, DockWorkMetadata } from "./conversation.js";
import { ExtensionTextDialog } from "./extension-text-dialog.js";
import { ExtensionWidgetSurface } from "./extension-widget-surface.js";
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

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
const SUBMITTING_FEEDBACK_DELAY_MS = 200;

export function pickerContentRowBudget(terminalRows: number): number {
  const rows = Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows)) : 24;
  return Math.max(6, Math.floor(rows * 0.8) - 2); // 80% overlay minus WorkModalFrame borders
}

export type DockTuiExitReason = "detached" | "stopped" | "signal";

export interface DockTuiResult {
  reason: DockTuiExitReason;
  instance: InstanceSnapshot;
  detachTruth: "host_owned" | "status_unknown" | "not_active";
  cleanupErrors?: string[];
}

export async function runDockTui(
  client: DockClient,
  initialInstance: InstanceSnapshot,
): Promise<DockTuiResult> {
  assertInteractiveTerminal();

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, process.env.PI_HARDWARE_CURSOR === "1");
  const conversation = new DockConversation();
  const pendingQueue = new PendingQueueTray();
  const activity = new DockActivityLine();
  let instance = initialInstance;
  const metadata = new DockWorkMetadata(() => instance);
  const status = new DockStatusLine(instance);
  const widgetsAboveEditor = new ExtensionWidgetSurface("aboveEditor", reportExtensionWidgetViewport);
  const widgetsBelowEditor = new ExtensionWidgetSurface("belowEditor", reportExtensionWidgetViewport);
  let lastWidgetViewportRequest = "";
  let runActivity = activityFromSnapshot(instance);
  let submittingFeedbackVisible = false;
  activity.setActivity(runActivity);
  let subscription: EventSubscription | undefined;
  let operationSubscription: OperationSubscription | undefined;
  let controllerLeaseToken: string | undefined;
  let controllerId: string | undefined;
  let pendingEditorDirective: { controllerId: string; runtimeGeneration: number; text: string } | undefined;
  let pendingTitleDirective: { controllerId: string; runtimeGeneration: number; title: string } | undefined;
  let activeExtensionDialog: { interactionId: string; closeFromHost: () => void } | undefined;
  let lastEventGeneration = instance.runtimeGeneration;
  let lastEventSequence = instance.eventCursor.sequence;
  let operationAcquire: Promise<void> | undefined;
  let operationRetryTimer: NodeJS.Timeout | undefined;
  let operationRetryDelayMs = 250;
  let eventStreamRecovery: Promise<void> | undefined;
  let deferredEventStreamFailure: { watched: EventSubscription; error: unknown } | undefined;
  let eventStreamConnected = true;
  let submitBlockDepth = 0;
  let detachTruth: DockTuiResult["detachTruth"] = initialInstance.lifecycle === "active" ? "host_owned" : "not_active";
  let cleanupErrors: string[] | undefined;
  let draftAttachmentIds: string[] = [];
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

  const refreshEditorSubmit = (): void => {
    editor.disableSubmit = submitBlockDepth > 0 || !eventStreamConnected || instance.lifecycle !== "active";
  };
  const blockEditorSubmit = (): void => {
    submitBlockDepth += 1;
    editor.disableSubmit = true;
  };
  const restoreEditorSubmit = (): void => {
    submitBlockDepth = Math.max(0, submitBlockDepth - 1);
    refreshEditorSubmit();
  };
  const requireCoherentControl = (action: string): boolean => {
    if (eventStreamConnected && instance.lifecycle === "active") return true;
    refreshEditorSubmit();
    conversation.addNotice(`${action} was not sent because live updates are unavailable. Wait for reconnection, or press Ctrl+D and open this work again.`, true);
    tui.requestRender();
    return false;
  };

  const restoreTerminalTitle = (): void => {
    const directive = pendingTitleDirective;
    if (directive !== undefined
      && directive.controllerId === controllerId
      && directive.runtimeGeneration === instance.runtimeGeneration) {
      terminal.setTitle(terminalSafe(directive.title));
      return;
    }
    terminal.setTitle(`Alu Dock · ${instance.displayName}`);
  };

  const clearControllerRouting = (): void => {
    controllerLeaseToken = undefined;
    controllerId = undefined;
    pendingEditorDirective = undefined;
    pendingTitleDirective = undefined;
    restoreTerminalTitle();
  };

  const applyControllerDirective = (event: DockEvent): void => {
    if (event.runtimeGeneration !== instance.runtimeGeneration || controllerId === undefined) return;
    if (event.type === "extension.title_set" && event.data.controllerId === controllerId) {
      pendingTitleDirective = { controllerId, runtimeGeneration: event.runtimeGeneration, title: event.data.title };
      restoreTerminalTitle();
      return;
    }
    if (event.type === "extension.editor_text_set" && event.data.controllerId === controllerId) {
      if (!editor) {
        pendingEditorDirective = { controllerId, runtimeGeneration: event.runtimeGeneration, text: event.data.text };
        return;
      }
      editor.setText(event.data.text);
      tui.requestRender();
    }
  };

  const onEvent = (event: DockEvent): void => {
    if (event.runtimeGeneration < lastEventGeneration) return;
    if (event.runtimeGeneration === lastEventGeneration && event.sequence <= lastEventSequence) return;
    lastEventGeneration = event.runtimeGeneration;
    lastEventSequence = event.sequence;
    instance = projectSnapshot(instance, event);
    status.update(instance);
    pendingQueue.apply(event);
    if (event.type === "session.replaced") {
      widgetsAboveEditor.reset();
      widgetsBelowEditor.reset();
    } else {
      widgetsAboveEditor.apply(event);
      widgetsBelowEditor.apply(event);
    }
    runActivity = reduceRunActivity(runActivity, event, instance);
    if (runActivity.phase !== "submitting" || submittingFeedbackVisible) activity.setActivity(runActivity);
    if (event.type === "session.replaced") {
      activeExtensionDialog?.closeFromHost();
      operationSubscription?.close();
      operationSubscription = undefined;
      clearControllerRouting();
      status.setController("read-only");
      void acquireExtensionUiOperation();
      navigationHistoryToken = undefined;
      navigationBufferedEvents = [];
      initialHistoryLoading = false;
      initialBufferedEvents = [];
      replacementHistoryGeneration = event.runtimeGeneration;
      replacementBufferedEvents = [event];
      conversation.reset();
      conversation.addNotice("Loading replacement session history…");
      terminal.setTitle(`Alu Dock · ${instance.displayName}`);
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
    applyControllerDirective(event);
    if (event.type === "session.info_changed") {
      pendingTitleDirective = undefined;
      restoreTerminalTitle();
    }
    if (instance.lifecycle !== "active") {
      clearControllerRouting();
      detachTruth = "not_active";
      if (editor) refreshEditorSubmit();
    } else if (eventStreamConnected) {
      detachTruth = "host_owned";
    }
    if (!initialHistoryLoading) {
      updateTerminalProgress();
      tui.requestRender();
    }
  };

  subscription = await client.streamEvents(instance.id, { onEvent, requireTuiProjection: true, conversationBootstrap: true });
  const initialProjection = subscription.initial.instance;
  instance = initialProjection;
  status.setController("read-only");
  if (lastEventGeneration < subscription.initial.page.latest.runtimeGeneration
    || (lastEventGeneration === subscription.initial.page.latest.runtimeGeneration && lastEventSequence < subscription.initial.page.latest.sequence)) {
    lastEventGeneration = subscription.initial.page.latest.runtimeGeneration;
    lastEventSequence = subscription.initial.page.latest.sequence;
  }
  const initialGeneration = initialProjection.runtimeGeneration;
  const initialHistory = await drainFullHistory(
    initialProjection.id,
    initialGeneration,
    subscription.initial.historyRevision,
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
    const boundary = initialProjection;
    const buffered = initialBufferedEvents;
    const reconciled = reconcileFlowingEvents(subscription.initial.page.events, buffered);
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

  function reportExtensionWidgetViewport(width: number): void {
    const leaseToken = controllerLeaseToken;
    if (!leaseToken || exiting) return;
    const height = Math.max(1, terminal.rows);
    const requestKey = `${leaseToken}:${instance.runtimeGeneration}:${width}:${height}`;
    if (requestKey === lastWidgetViewportRequest) return;
    lastWidgetViewportRequest = requestKey;
    void client.setExtensionWidgetViewport(
      instance.id,
      leaseToken,
      instance.runtimeGeneration,
      width,
      height,
    ).catch(() => {
      if (lastWidgetViewportRequest === requestKey) lastWidgetViewportRequest = "";
    });
  }

  function scheduleExtensionUiOperationRetry(): void {
    if (exiting || operationSubscription || operationRetryTimer || instance.lifecycle !== "active") return;
    const delay = operationRetryDelayMs;
    operationRetryDelayMs = Math.min(5_000, operationRetryDelayMs * 2);
    operationRetryTimer = setTimeout(() => {
      operationRetryTimer = undefined;
      void acquireExtensionUiOperation();
    }, delay);
    operationRetryTimer.unref();
  }

  function acquireExtensionUiOperation(): Promise<void> {
    if (exiting || operationSubscription) return Promise.resolve();
    if (operationAcquire) return operationAcquire;
    if (operationRetryTimer) {
      clearTimeout(operationRetryTimer);
      operationRetryTimer = undefined;
    }
    const task = (async () => {
      try {
        const next = await client.controlExtensionUi(instance.id, (event) => {
          if (event.type === "interaction.requested") void handleExtensionInteraction(event);
          else applyControllerDirective(event);
        });
        if (exiting) {
          next.close();
          await next.done.catch(() => {});
          return;
        }
        operationSubscription = next;
        operationRetryDelayMs = 250;
        controllerLeaseToken = next.initial.leaseToken;
        controllerId = next.initial.controllerId;
        status.setController("operator");
        watchOperationSubscription(next);
        tui.requestRender();
      } catch (error) {
        if (exiting) return;
        activeExtensionDialog?.closeFromHost();
        clearControllerRouting();
        status.setController("read-only");
        tui.requestRender();
        if (!(error instanceof ControlClientError && ["instance_not_found", "instance_not_active", "protocol_incompatible"].includes(error.code))) {
          scheduleExtensionUiOperationRetry();
        }
      }
    })();
    const tracked = task.finally(() => {
      if (operationAcquire === tracked) operationAcquire = undefined;
    });
    operationAcquire = tracked;
    return tracked;
  }

  function watchOperationSubscription(watched: OperationSubscription): void {
    void watched.done.then(() => {
      if (exiting || operationSubscription !== watched) return;
      operationSubscription = undefined;
      activeExtensionDialog?.closeFromHost();
      clearControllerRouting();
      status.setController("read-only");
      tui.requestRender();
    }).catch(() => {
      if (exiting || operationSubscription !== watched) return;
      operationSubscription = undefined;
      activeExtensionDialog?.closeFromHost();
      clearControllerRouting();
      status.setController("read-only");
      tui.requestRender();
      scheduleExtensionUiOperationRetry();
    });
  }

  const [settingsLoad, commandsLoad] = await Promise.allSettled([
    client.settings(instance.id),
    client.commands(instance.id),
  ]);
  if (settingsLoad.status === "fulfilled") settings = settingsLoad.value.settings;
  else conversation.addNotice(`Settings unavailable: ${errorText(settingsLoad.reason)}`, true);
  if (commandsLoad.status === "fulfilled") {
    commands = commandsLoad.value.commands;
    if (commandsLoad.value.truncated) conversation.addNotice(`Showing ${commands.length} of ${commandsLoad.value.total} commands.`, true);
  } else conversation.addNotice(`Command catalog unavailable: ${errorText(commandsLoad.reason)}`, true);

  editor = new Editor(tui, editorTheme, {
    paddingX: numericSetting(settings, "editorPaddingX", 1),
    autocompleteMaxVisible: numericSetting(settings, "autocompleteMaxVisible", 10),
  });
  const editorDirective = pendingEditorDirective as { controllerId: string; runtimeGeneration: number; text: string } | undefined;
  if (editorDirective !== undefined) {
    if (editorDirective.controllerId === controllerId
      && editorDirective.runtimeGeneration === instance.runtimeGeneration) {
      editor.setText(editorDirective.text);
    }
  }
  pendingEditorDirective = undefined;
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
    if (!eventStreamConnected) {
      refreshEditorSubmit();
      conversation.addNotice("Input was not sent because live updates are unavailable. Wait for reconnection, or press Ctrl+D and open this work again.", true);
      tui.requestRender();
      return;
    }
    editor.addToHistory(text);
    void acquireExtensionUiOperation();
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
    if (text === "/attachments" || text === "/attachments clear") {
      if (text.endsWith(" clear")) {
        draftAttachmentIds = [];
        conversation.addNotice("Restored attachment references cleared.");
      } else {
        conversation.addNotice(draftAttachmentIds.length === 0
          ? "No attachment references are waiting with this editor draft."
          : `${draftAttachmentIds.length} restored attachment reference${draftAttachmentIds.length === 1 ? " is" : "s are"} waiting with the next submission.`);
      }
      tui.requestRender();
      return;
    }
    if (text === "/abort") {
      await abortRun();
      return;
    }
    if (text === "/stop") {
      blockEditorSubmit();
      runActivity = { phase: "aborting", label: "stopping" };
      activity.setActivity(runActivity);
      tui.requestRender();
      try {
        if (!requireCoherentControl("Stop")) { restoreEditorSubmit(); return; }
        const result = await client.stop(instance.id);
        instance = result.instance;
        status.update(instance);
        cleanupErrors = result.receipt.cleanupErrors;
        finish("stopped");
      } catch (error) {
        restoreEditorSubmit();
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
    blockEditorSubmit();
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
      if (!requireCoherentControl("Message submission")) return;
      const attachments = draftAttachmentIds.length === 0 ? undefined : [...draftAttachmentIds];
      const result = await client.prompt(instance.id, message, delivery, operationId, undefined, attachments);
      if (attachments !== undefined) draftAttachmentIds = [];
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
      restoreEditorSubmit();
      tui.requestRender();
    }
  }

  function restoreMessagesToEditor(messages: readonly PendingMessageDto[]): void {
    if (messages.length === 0) return;
    editor.setText(prependRestoredQueueText(editor.getText(), messages));
    const restoredAttachments = messages.flatMap((message) => message.attachments ?? []);
    draftAttachmentIds = [...new Set([...draftAttachmentIds, ...restoredAttachments.map((attachment) => attachment.fileId)])];
    if (restoredAttachments.length > 0) {
      conversation.addNotice(`${draftAttachmentIds.length} attachment reference${draftAttachmentIds.length === 1 ? " was" : "s were"} restored with the editor draft and will stay structured on its next submission. Use /attachments clear to remove them.`);
    }
  }

  async function restoreQueue(): Promise<boolean> {
    blockEditorSubmit();
    showStatus("restoring queued messages");
    try {
      if (!requireCoherentControl("Queue restoration")) return false;
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
      restoreEditorSubmit();
      tui.requestRender();
    }
  }

  async function abortRun(): Promise<void> {
    if (instance.execution !== "running") {
      showStatus("nothing to abort");
      return;
    }
    blockEditorSubmit();
    runActivity = abortingActivity();
    activity.setActivity(runActivity);
    tui.requestRender();
    try {
      if ((instance.pending.total > 0 || pendingQueue.count > 0) && !await restoreQueue()) return;
      if (!requireCoherentControl("Run abort")) return;
      const result = await client.abort(instance.id);
      instance = result.instance;
      status.update(instance);
      runActivity = activityFromSnapshot(instance);
      activity.setActivity(runActivity);
    } catch (error) {
      showError(error);
    } finally {
      restoreEditorSubmit();
      tui.requestRender();
    }
  }

  async function chooseModel(): Promise<void> {
    blockEditorSubmit();
    showStatus("loading models");
    try {
      const catalog = await client.models(instance.id);
      instance = catalog.instance;
      status.update(instance);
      if (catalog.truncated) conversation.addNotice(`Showing ${catalog.models.length} of ${catalog.total} models.`, true);
      const selected = await showModelPicker(catalog.models);
      if (selected) await switchModel(selected.provider, selected.id);
      else showStatus("model unchanged");
    } catch (error) {
      showError(error);
    } finally {
      restoreEditorSubmit();
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  async function showModelPicker(models: AgentModelInfo[]): Promise<AgentModelInfo | undefined> {
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
      conversation.addNotice("This question is being handled in another open window.");
      tui.requestRender();
      return;
    }
    if (activeExtensionDialog) {
      conversation.addNotice("Another extension question is waiting and will appear after this one.", true);
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
        clearControllerRouting();
        status.setController("read-only");
        conversation.addNotice("This question is now being handled in another open window.");
        tui.requestRender();
        return;
      }
      showError(error);
      // A failed response transport is not a user cancellation. Query the
      // authoritative interaction and re-present the same request when it is
      // still pending; otherwise the Host-resolved result wins.
      try {
        const authoritative = await client.status(instance.id);
        instance = authoritative;
        status.update(instance);
        if (authoritative.activeInteraction?.id === event.data.interactionId && controllerLeaseToken === leaseToken) {
          conversation.addNotice("The interaction response was not confirmed by the Host; the same question remains pending.", true);
          queueMicrotask(() => { void handleExtensionInteraction(event); });
        }
      } catch (statusError) {
        conversation.addNotice(`The answer could not be confirmed. The question is still waiting; open this work again to continue. ${errorText(statusError)}`, true);
      }
      tui.requestRender();
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
    blockEditorSubmit();
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
      restoreEditorSubmit();
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
    blockEditorSubmit();
    showStatus(`setting ${update.key}`);
    tui.requestRender();
    try {
      if (!requireCoherentControl("Setting update")) return;
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
      restoreEditorSubmit();
    }
  }

  async function chooseTools(): Promise<void> {
    blockEditorSubmit();
    showStatus("loading tools");
    tui.requestRender();
    try {
      const catalog = await client.tools(instance.id);
      let tools = catalog.tools;
      if (catalog.truncated) conversation.addNotice(`Showing ${tools.length} of ${catalog.total} tools.`, true);
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
        if (!requireCoherentControl("Tool update")) return;
        const result = await client.setActiveTools(instance.id, [...active].sort());
        instance = result.instance;
        status.update(instance);
        tools = result.tools;
        if (result.truncated) conversation.addNotice(`Showing ${tools.length} of ${result.total} tools.`, true);
        showStatus(`tool ${selected} toggled`);
      }
      showStatus("tools updated");
    } catch (error) {
      showError(error);
    } finally {
      restoreEditorSubmit();
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  async function setToolsFromCommand(target: string): Promise<void> {
    const names = target === "none" ? [] : [...new Set(target.split(/[\s,]+/u).filter(Boolean))].sort();
    blockEditorSubmit();
    showStatus("updating tools");
    tui.requestRender();
    try {
      if (!requireCoherentControl("Tool update")) return;
      const result = await client.setActiveTools(instance.id, names);
      instance = result.instance;
      status.update(instance);
      conversation.addNotice(`Active tools: ${result.tools.filter((tool) => tool.active).map((tool) => tool.name).join(", ") || "none"}.`);
      if (result.truncated) conversation.addNotice(`Showing ${result.tools.length} of ${result.total} tools.`, true);
      showStatus("tools updated");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.requestRender(); }
  }

  async function chooseThinking(): Promise<void> {
    blockEditorSubmit();
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
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  async function loadSessionTree(): Promise<{ nodes: TreeNodeDto[]; leafId?: string }> {
    return client.tree(instance.id);
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
      picker.setBody(undefined);
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
    blockEditorSubmit();
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
      restoreEditorSubmit();
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
    blockEditorSubmit();
    treeNavigationPending = true;
    treeNavigationAbortRequested = false;
    showStatus(options.summarize ? "summarizing branch · Esc/Ctrl+C abort" : "navigating tree");
    tui.requestRender();
    const draftWasEmpty = editor.getText().length === 0;
    try {
      if (!requireCoherentControl("Tree navigation")) return;
      const result = await client.navigateSession(instance.id, targetId, options);
      instance = result.instance;
      status.update(instance);
      if (result.editorText !== undefined && draftWasEmpty && editor.getText().length === 0) editor.setText(result.editorText);
      showStatus(result.cancelled ? result.aborted || treeNavigationAbortRequested ? "navigation aborted" : "navigation cancelled by extension" : "branch selected");
    } catch (error) { showError(error); }
    finally {
      treeNavigationPending = false;
      treeNavigationAbortRequested = false;
      restoreEditorSubmit();
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
    try {
      if (!requireCoherentControl("Tree navigation abort")) return;
      await client.abort(instance.id);
    }
    catch (error) { showError(error); }
    finally { treeNavigationAbortPending = false; }
  }

  async function chooseForkTarget(): Promise<void> {
    blockEditorSubmit();
    showStatus("loading fork targets");
    tui.requestRender();
    try {
      const target = await chooseTreeListNode("Fork before user message", (node) => node.kind === "message" && node.role === "user");
      if (target) await forkSession(target.entryId);
      else showStatus("fork cancelled");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  async function forkSession(entryId: string): Promise<void> {
    blockEditorSubmit();
    showStatus("forking session");
    tui.requestRender();
    try {
      if (!requireCoherentControl("Session fork")) return;
      const result = await client.forkSession(instance.id, entryId);
      instance = result.instance;
      status.update(instance);
      if (result.selectedText !== undefined) editor.setText(result.selectedText);
      showStatus(result.cancelled ? "fork cancelled by extension" : "fork ready · edit and submit selected prompt");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  async function cloneSession(): Promise<void> {
    blockEditorSubmit();
    showStatus("finding current leaf");
    tui.requestRender();
    try {
      const tree = await client.tree(instance.id);
      if (!tree.leafId) {
        conversation.addNotice("The current session has no leaf to clone.", true);
        showStatus("clone unavailable");
        return;
      }
      if (!requireCoherentControl("Session clone")) return;
      const result = await client.cloneSession(instance.id, tree.leafId);
      instance = result.instance;
      status.update(instance);
      if (!result.cancelled) editor.setText("");
      showStatus(result.cancelled ? "clone cancelled by extension" : "session cloned");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
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
    blockEditorSubmit();
    showStatus("loading sessions");
    tui.requestRender();
    try {
      const target = await showSessionInventoryPicker();
      if (!target) { showStatus("session unchanged"); return; }
      await resumeSession(target.sessionFile);
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
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
    blockEditorSubmit();
    showStatus("resuming session");
    tui.requestRender();
    const operationId = randomUUID();
    try {
      let result;
      try {
        if (!requireCoherentControl("Session resume")) return;
        result = await client.switchSession(instance.id, sessionFile, operationId);
      } catch (error) {
        const challenge = projectTrustChallenge(error, operationId);
        if (!challenge) throw error;
        const decision = await chooseProjectTrust(challenge.cwd);
        if (!decision) { showStatus("resume cancelled"); return; }
        if (!requireCoherentControl("Session resume")) return;
        result = await client.switchSession(instance.id, sessionFile, operationId, { challengeId: challenge.challengeId, decision });
      }
      instance = result.instance;
      status.update(instance);
      showStatus(result.cancelled ? "resume cancelled by extension" : "session resumed");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
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
    blockEditorSubmit();
    showStatus("creating session");
    tui.requestRender();
    try {
      if (!requireCoherentControl("New session")) return;
      const result = await client.newSession(instance.id, parentSession);
      instance = result.instance;
      status.update(instance);
      showStatus(result.cancelled ? "new session cancelled by extension" : "new session ready");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.requestRender(); }
  }

  async function nameSession(name: string): Promise<void> {
    blockEditorSubmit();
    showStatus("naming session");
    tui.requestRender();
    try {
      if (!requireCoherentControl("Session name update")) return;
      const result = await client.nameSession(instance.id, name);
      instance = result.instance;
      status.update(instance);
      pendingTitleDirective = undefined;
      restoreTerminalTitle();
      conversation.addNotice(instance.name ? `Session name: ${terminalSafe(instance.name)}.` : "Session name cleared.");
      showStatus(instance.name ? `named ${terminalSafe(instance.name)}` : "session name cleared");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.requestRender(); }
  }

  async function compactSession(customInstructions?: string): Promise<void> {
    tui.requestRender();
    try {
      if (!requireCoherentControl("Compaction")) return;
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
    blockEditorSubmit();
    showStatus("reloading resources");
    tui.requestRender();
    try {
      if (!requireCoherentControl("Session reload")) return;
      const result = await client.reloadSession(instance.id);
      instance = result.instance;
      status.update(instance);
      for (const diagnostic of result.diagnostics) conversation.addNotice(`${diagnostic.severity}: ${diagnostic.message}`, diagnostic.severity === "error");
      showStatus(`reloaded ${result.resources.length} resources`);
      if (result.resourcesTruncated || result.diagnosticsTruncated) {
        conversation.addNotice(`Showing ${result.resources.length} of ${result.resourceTotal} resources · ${result.diagnostics.length} of ${result.diagnosticTotal} diagnostics.`, true);
      }
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.requestRender(); }
  }

  async function showResources(): Promise<void> {
    blockEditorSubmit();
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
        conversation.addNotice(`Showing ${result.resources.length} of ${result.resourceTotal} resources · ${result.diagnostics.length} of ${result.diagnosticTotal} diagnostics.`, true);
      }
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  async function switchModel(provider: string, modelId: string): Promise<void> {
    blockEditorSubmit();
    showStatus(`switching to ${provider}/${modelId}`);
    tui.requestRender();
    try {
      if (!requireCoherentControl("Model update")) return;
      const result = await client.setModel(instance.id, provider, modelId);
      instance = result.instance;
      status.update(instance);
      showStatus(`model ${modelId}`);
    } catch (error) {
      showError(error);
    } finally {
      restoreEditorSubmit();
      tui.requestRender();
    }
  }

  async function switchThinking(level: ThinkingLevel): Promise<void> {
    blockEditorSubmit();
    showStatus(`thinking ${level}`);
    tui.requestRender();
    try {
      if (!requireCoherentControl("Thinking update")) return;
      const result = await client.setThinking(instance.id, level);
      instance = result.instance;
      status.update(instance);
      showStatus(`thinking ${instance.executor.thinkingLevel ?? level}`);
    } catch (error) {
      showError(error);
    } finally {
      restoreEditorSubmit();
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
        projection.historyRevision,
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
      const historyBoundary = projection.instance;
      reconciled = reconcileFlowingEvents(projection.page.events, buffered);
      instance = historyBoundary;
      pendingQueue.reset(projection.pendingMessages);
      for (const event of buffered) {
        if (event.runtimeGeneration !== generation || event.sequence <= historyBoundary.eventCursor.sequence) continue;
        instance = projectSnapshot(instance, event);
        pendingQueue.apply(event);
      }
      status.update(instance);
      restoreTerminalTitle();
      conversation.applyHistory(historyEntries, false);
      conversation.applyReplay(reconciled, false);
      if (!full.ok) conversation.addNotice(`History didn't reload: ${errorText(full.error)}. Run /reload to try again.`, true);
      conversation.setToolsExpanded(instance.toolsExpanded);
    } else {
      const buffered = replacementBufferedEvents;
      replacementBufferedEvents = [];
      replacementHistoryGeneration = undefined;
      reconciled = reconcileFlowingEvents([], buffered);
      conversation.addNotice(`History didn't reload: ${errorText(projectionLoad.reason)}. Run /reload to try again.`, true);
      conversation.applyReplay(reconciled, false);
      conversation.setToolsExpanded(instance.toolsExpanded);
    }

    if (settingsLoad.status === "fulfilled") {
      settings = settingsLoad.value.settings;
      for (const setting of settings) applyLiveSetting(setting.key, setting.value);
    } else {
      conversation.addNotice(`Settings didn't reload: ${errorText(settingsLoad.reason)}. Run /reload to try again.`, true);
    }
    if (commandsLoad.status === "fulfilled") {
      commands = commandsLoad.value.commands;
      if (commandsLoad.value.truncated) conversation.addNotice(`Showing ${commands.length} of ${commandsLoad.value.total} commands.`, true);
    } else conversation.addNotice(`Commands didn't reload: ${errorText(commandsLoad.reason)}. Run /reload to try again.`, true);
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
        projection.initial.historyRevision,
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
      conversation.applyReplay(reconcileFlowingEvents([], buffered), false);
      conversation.setToolsExpanded(instance.toolsExpanded);
      tui.requestRender();
      return;
    }
    const { projection, full } = loaded.value;
    const boundary = projection.instance;
    const reconciled = reconcileFlowingEvents(projection.page.events, buffered);
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
      ? humanControlErrorText(error)
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
      if (!requireCoherentControl("Tool detail update")) return;
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
  workFlow.addChild(widgetsAboveEditor);
  workFlow.addChild(activity);
  workFlow.addChild(pendingQueue);
  workFlow.addChild(editor);
  workFlow.addChild(widgetsBelowEditor);
  workFlow.addChild(metadata);
  workFlow.addChild(status);
  tui.addChild(workFlow);
  tui.setFocus(editor);
  restoreTerminalTitle();

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
      if (eventStreamConnected) void toggleAuthoritativeToolsExpanded();
      else showStatus("control unavailable · Ctrl+D detach");
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
        if (eventStreamConnected) void abortTreeNavigation();
        else showStatus("control unavailable · navigation was not aborted");
        return { consume: true };
      }
      if (instance.execution === "running") {
        if (eventStreamConnected) void abortRun();
        else showStatus("control unavailable · run was not aborted");
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
        if (eventStreamConnected) void abortTreeNavigation();
        else showStatus("control unavailable · navigation was not aborted");
      } else if (editor.getText().length > 0) {
        editor.setText("");
        showStatus("input cleared");
      } else if (instance.execution === "running") {
        if (eventStreamConnected) void abortRun();
        else showStatus("control unavailable · run was not aborted");
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
      recoverEventSubscription(watched, new ControlClientError("connection_closed", "Alu Dock stopped live updates"));
    }).catch((error: unknown) => {
      recoverEventSubscription(watched, error);
    });
  }

  function recoverEventSubscription(watched: EventSubscription, streamError: unknown): void {
    if (exiting || subscription !== watched) return;
    if (instance.lifecycle === "stopped") {
      eventStreamConnected = false;
      refreshEditorSubmit();
      terminal.setProgress(false);
      status.setConnection("disconnected");
      runActivity = activityFromSnapshot(instance);
      activity.setActivity(runActivity);
      detachTruth = "not_active";
      tui.requestRender();
      return;
    }
    if (eventStreamRecovery) {
      deferredEventStreamFailure = { watched, error: streamError };
      return;
    }
    const cursor: EventCursor = {
      hostEpoch: instance.eventCursor.hostEpoch,
      instanceId: instance.id,
      runtimeGeneration: lastEventGeneration,
      sequence: lastEventSequence,
    };
    eventStreamConnected = false;
    refreshEditorSubmit();
    terminal.setProgress(false);
    status.setConnection("disconnected");
    runActivity = disconnectedActivity("checking live updates · task status unknown");
    activity.setActivity(runActivity);
    detachTruth = "status_unknown";
    conversation.addNotice("Live updates were interrupted. Checking the current work state; no command was resent.", true);
    tui.requestRender();

    const recovery = (async () => {
      let authoritative: InstanceSnapshot;
      try {
        authoritative = await client.status(instance.id);
      } catch (statusError) {
        if (exiting || subscription !== watched) return;
        status.setConnection("lost");
        runActivity = disconnectedActivity("control unavailable · status unknown · Ctrl+D detach");
        activity.setActivity(runActivity);
        conversation.addNotice("Alu Dock is unavailable, so this work's current state is unknown. This window remains read-only; press Ctrl+D and open it again after Dock recovers.", true);
        conversation.addNotice(`Live updates: ${errorText(streamError)}`, true);
        conversation.addNotice(`Status check: ${errorText(statusError)}`, true);
        tui.requestRender();
        return;
      }
      if (exiting || subscription !== watched) return;

      detachTruth = authoritative.lifecycle === "active" ? "host_owned" : "not_active";
      const sameDomain = authoritative.id === cursor.instanceId
        && authoritative.runtimeGeneration === cursor.runtimeGeneration
        && authoritative.eventCursor.hostEpoch === cursor.hostEpoch;
      if (authoritative.lifecycle !== "active") {
        instance = authoritative;
        status.update(instance);
        refreshEditorSubmit();
        runActivity = activityFromSnapshot(instance);
        activity.setActivity(runActivity);
        conversation.addNotice(`The work is now ${authoritative.lifecycle}; this window remains read-only. No command was resent; press Ctrl+D and open the work again.`, true);
        tui.requestRender();
        return;
      }

      const forceFreshBootstrap = !sameDomain;
      let next: EventSubscription | undefined;
      let candidateReady = false;
      const candidateBufferedEvents: DockEvent[] = [];
      const onCandidateEvent = (event: DockEvent): void => {
        if (candidateReady) onEvent(event);
        else candidateBufferedEvents.push(event);
      };
      try {
        if (!forceFreshBootstrap) {
          next = await client.streamEvents(instance.id, {
            since: cursor,
            onEvent: onCandidateEvent,
            requireTuiProjection: true,
          });
        }
        const continuityLost = forceFreshBootstrap
          || next!.initial.page.epochChanged
          || next!.initial.page.generationChanged
          || next!.initial.page.truncated;
        let rebuiltHistory: HistoryEntryDto[] | undefined;
        if (continuityLost) {
          if (next) {
            next.close();
            await next.done.catch(() => {});
          }
          candidateBufferedEvents.length = 0;
          next = await client.streamEvents(instance.id, {
            onEvent: onCandidateEvent,
            requireTuiProjection: true,
            conversationBootstrap: true,
          });
          const rebuilt = await drainFullHistory(
            next.initial.instance.id,
            next.initial.instance.runtimeGeneration,
            next.initial.historyRevision,
            next.initial.recentHistory,
            next.initial.historyTruncated,
            (beforeEntryId) => client.history(next!.initial.instance.id, beforeEntryId, HISTORY_PAGE_SIZE),
          );
          rebuiltHistory = rebuilt.entries;
        }
        if (next === undefined) throw new ControlClientError("connection_closed", "Live-update recovery did not establish a stream");
        if (next.initial.instance.lifecycle !== "active") {
          instance = next.initial.instance;
          detachTruth = "not_active";
          refreshEditorSubmit();
          throw new ControlClientError("instance_not_active", `Authoritative instance state became ${instance.lifecycle} during event-stream recovery`);
        }
        if (exiting || subscription !== watched) {
          next.close();
          await next.done.catch(() => {});
          return;
        }
        if (rebuiltHistory === undefined) {
          for (const event of next.initial.page.events) onEvent(event);
        } else {
          instance = next.initial.instance;
          pendingQueue.reset(next.initial.pendingMessages);
          conversation.applyHistory(rebuiltHistory, false);
          conversation.applyBootstrapReplay(next.initial.page.events);
          conversation.setToolsExpanded(instance.toolsExpanded);
        }
        instance = next.initial.instance;
        lastEventGeneration = next.initial.page.latest.runtimeGeneration;
        lastEventSequence = next.initial.page.latest.sequence;
        pendingQueue.reset(next.initial.pendingMessages);
        status.update(instance);
        status.setConnection("connected");
        runActivity = activityFromReplay(instance, next.initial.page.events);
        activity.setActivity(runActivity);
        detachTruth = instance.lifecycle === "active" ? "host_owned" : "not_active";
        conversation.addNotice(rebuiltHistory === undefined
          ? `Live updates resumed; the work kept running (${instance.lifecycle}/${instance.execution}). No command was resent.`
          : `Live updates resumed from a fresh conversation view (${instance.lifecycle}/${instance.execution}). No command was resent.`);
        subscription = next;
        eventStreamConnected = true;
        candidateReady = true;
        for (const event of candidateBufferedEvents) onEvent(event);
        candidateBufferedEvents.length = 0;
        refreshEditorSubmit();
        watchEventSubscription(next);
        updateTerminalProgress();
        tui.requestRender();
      } catch (reconnectError) {
        if (next) {
          next.close();
          await next.done.catch(() => {});
        }
        if (exiting || subscription !== watched) return;
        runActivity = disconnectedActivity("live updates interrupted · task still running · Ctrl+D detach");
        activity.setActivity(runActivity);
        conversation.addNotice(`Live updates are still unavailable; the current work state is ${instance.lifecycle}/${instance.execution}. This window remains read-only; press Ctrl+D and open it again.`, true);
        conversation.addNotice(`Reconnect: ${errorText(reconnectError)}`, true);
        tui.requestRender();
      }
    })();
    const tracked = recovery.finally(() => {
      if (eventStreamRecovery !== tracked) return;
      eventStreamRecovery = undefined;
      const deferred = deferredEventStreamFailure;
      deferredEventStreamFailure = undefined;
      if (deferred && !exiting && subscription === deferred.watched) {
        recoverEventSubscription(deferred.watched, deferred.error);
      }
    });
    eventStreamRecovery = tracked;
  }
  watchEventSubscription(subscription);

  tui.start();
  void acquireExtensionUiOperation();
  activityPulse.setEnabled(true);
  updateTerminalProgress();
  const reason = await exit;

  activityPulse.stop();
  if (operationRetryTimer) clearTimeout(operationRetryTimer);
  activeExtensionDialog?.closeFromHost();
  clearControllerRouting();
  removeInputListener();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  // Detach is a local control action. Close every client transport immediately;
  // sent mutations remain Host-owned and may complete after this process exits.
  subscription.close();
  operationSubscription?.close();
  client.closeActiveConnections();
  await Promise.all([
    operationAcquire?.catch(() => {}),
    eventStreamRecovery?.catch(() => {}),
    subscription.done.catch(() => {}),
    operationSubscription?.done.catch(() => {}),
  ]);
  terminal.setProgress(false);
  await terminal.drainInput(200, 30).catch(() => {});
  tui.stop();

  return { reason, instance, detachTruth, cleanupErrors };
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

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Answer "what happened" and "what can I do now" for Dock errors; raw codes and Host messages may carry internal identifiers. */
function humanControlErrorText(error: ControlClientError): string {
  switch (error.code) {
    case "not_found":
    case "instance_not_found":
      return "This work no longer exists on the Dock. Head back to the Hub to pick another one.";
    case "instance_host_lost":
      return "The Dock lost contact with this work's agent. Reopen it from the Hub to continue from its saved session.";
    case "instance_runtime_error":
      return "This work's agent crashed. Reopen it from the Hub to continue from its saved session.";
    case "instance_not_active":
      return "This work is not running anymore. Reopen it from the Hub to continue.";
    case "instance_not_terminal":
      return "This work is still live, so its record can't be forgotten. Stop it first if you want it gone.";
    case "instance_not_reopenable":
      return "This work has no saved session to reopen. Start a new one from the Hub instead.";
    case "cursor_stale":
      return "The Dock's work list changed while reading it. Run the command again.";
    case "invalid_cursor":
      return "Couldn't pick up reading where this view left off. Close and reopen it to reload.";
    case "invalid_tree_target":
      return "That point is no longer available in this session. Reopen the tree and choose another point.";
    case "stale_runtime_generation":
      return "This work was reloaded since this window last looked. Try the command again.";
    case "admission_pending":
      return "The previous command is still being accepted. Give it a moment, then try again.";
    case "instance_busy":
      return "This work is busy with another request. Try again in a moment.";
    case "queue_capacity":
      return "The queue for this work is full. Let the current run finish before adding more.";
    case "effect_unknown":
      return "The Dock can't tell whether that command took effect. Check the conversation before sending it again.";
    case "mutation_faulted":
      return "That change failed partway through. Check the current state before retrying.";
    case "operation_conflict":
      return "That command was already submitted once. Check the conversation before sending it again.";
    case "operation_receipt_expired":
      return "The Dock can no longer confirm that earlier command. Check the conversation before retrying.";
    case "runtime_unavailable":
      return "The agent isn't running, so nothing was sent. Reopen this work from the Hub if it doesn't recover.";
    case "compaction_failed":
      return "Compaction failed. The conversation is unchanged; you can keep working or try again.";
    case "interaction_not_found":
    case "interaction_expired":
      return "That question already closed. The latest state is in the conversation.";
    case "interaction_wrong_lease":
      return "Another window answered this question first.";
    case "interaction_invalid_response":
      return "That answer wasn't accepted. Try answering again.";
    case "catalog_write_failed":
    case "catalog_corrupt":
      return "The Dock couldn't save its records — the Pi session file itself is safe. Check disk space and try again.";
    case "connection_closed":
      return "Lost the connection to the Dock. Press Ctrl+D to detach; the work keeps its state.";
    default:
      return error.message;
  }
}

export function formatWorkStatus(snapshot: InstanceSnapshot): string {
  const model = snapshot.executor.model
    ? `${terminalSafe(snapshot.executor.model.provider)}/${terminalSafe(snapshot.executor.model.id)}`
    : "none";
  return [
    `Status: ${humanInstanceStatus(snapshot.lifecycle, snapshot.execution)}`,
    `Session: ${terminalSafe(snapshot.name || "(unnamed)")}${snapshot.key === undefined ? "" : ` [${terminalSafe(snapshot.key)}]`}`,
    `Work cwd: ${terminalSafe(snapshot.cwd)}${snapshot.gitBranch === undefined ? "" : ` (${terminalSafe(snapshot.gitBranch)})`}`,
    `Model: ${model} · thinking ${terminalSafe(snapshot.executor.thinkingLevel ?? "off")}`,
    `Saved session: ${snapshot.executor.sessionFile === undefined ? "not saved yet" : terminalSafe(snapshot.executor.sessionFile)}`,
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
