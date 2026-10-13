import type { ConversationReadContext, InstanceDeliveryContext } from "../control/dock-client.js";
import { DocumentReader } from "./document-reader.js";
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
import type { CommandDto, DiagnosticDto, SettingDto, SettingUpdate } from "../core/config-projection.js";
import type { DeliveryMode, DockEvent, EventCursor, HistoryEntryDto, InstanceSnapshot, PendingMessageDto, SessionDto, TreeNodeDto } from "../core/managed-instance.js";
import type { ConversationHistoryEntryDto } from "../core/instance-dto.js";
import { systemPromptBlockLabel, systemPromptChangeDetail, systemPromptChangeText } from "../core/runtime-record-text.js";
import {
  THINKING_LEVELS,
  type AgentModelInfo,
  type ThinkingLevel,
} from "../core/agent-worker.js";
import type { ProjectTrustChoice } from "../control/project-trust.js";
import { ABORT_RESTORE_QUEUE_CAPABILITY, MAX_CONVERSATION_HISTORY_ITEMS, type AbortRestoreQueueResult } from "../control/protocol.js";
import { humanControlErrorText, humanErrorText } from "../human-control-error.js";
import { humanRelativeTime } from "../human-time.js";
import { sessionDisplayName } from "../session-display.js";
import { ActivityPulseController } from "./activity-pulse.js";
import { contextEditTarget, DockActivityLine, DockConversation, DockStatusLine, DockWorkMetadata } from "./conversation.js";
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
  let pendingEditorDirective: { runtimeGeneration: number; text: string } | undefined;
  let pendingTitleDirective: { runtimeGeneration: number; title: string } | undefined;
  let activeExtensionDialog: { interactionId: string; closeFromHost: () => void; closed: Promise<void> } | undefined;
  // A question that arrives before the screen and editor exist waits here; shown earlier,
  // the editor would take its focus.
  let screenStarted = false;
  // Set while replaying what was missed during a disconnect: editor text and a title set
  // meanwhile are not applied late, the person may have typed since.
  let catchingUp = false;
  let deferredQuestion: Extract<DockEvent, { type: "interaction.requested" }> | undefined;
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
  const requireCoherentControl = (): boolean => {
    if (eventStreamConnected && instance.lifecycle === "active") return true;
    refreshEditorSubmit();
    conversation.addNotice("The connection is interrupted, so this action could not be completed. Press Ctrl+D to leave Work, then run `aludock` and try again.", true);
    tui.requestRender();
    return false;
  };

  const restoreTerminalTitle = (): void => {
    const directive = pendingTitleDirective;
    if (directive !== undefined && directive.runtimeGeneration === instance.runtimeGeneration) {
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

  // Shared questions also bring the extension's title and editor text to every open window;
  // the operator connection only to the window holding it.
  const directiveForThisWindow = (directiveControllerId: string | undefined): boolean => (
    sharedQuestions() || (controllerId !== undefined && directiveControllerId === controllerId)
  );
  const applyControllerDirective = (event: DockEvent): void => {
    if (catchingUp || event.runtimeGeneration !== instance.runtimeGeneration) return;
    if (event.type === "extension.title_set" && directiveForThisWindow(event.data.controllerId)) {
      pendingTitleDirective = { runtimeGeneration: event.runtimeGeneration, title: event.data.title };
      restoreTerminalTitle();
      return;
    }
    if (event.type === "extension.editor_text_set" && directiveForThisWindow(event.data.controllerId)) {
      if (!editor) {
        pendingEditorDirective = { runtimeGeneration: event.runtimeGeneration, text: event.data.text };
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
    if (event.type === "interaction.requested") showQuestion(event);
    if (event.type === "session.replaced") deferredQuestion = undefined;
    if ((event.type === "interaction.cancelled" || event.type === "interaction.resolved") && deferredQuestion?.data.interactionId === event.data.interactionId) {
      deferredQuestion = undefined;
    }
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

  // Ask for the Work's questions on the observation itself. A Host that predates this
  // (a SubHost not yet updated) turns it into "operator": the window then takes the
  // operator connection as before.
  const instanceDelivery: InstanceDeliveryContext = { interactions: "shared" };
  subscription = await client.streamEvents(instance.id, { deliveryContext: instanceDelivery, onEvent, requireTuiProjection: true, conversationBootstrap: true });
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
    presentOpenQuestion(reconciled, true);
    if (!initialHistory.ok) conversation.addNotice("Some earlier messages could not be loaded. You can keep working from the messages shown here, or run /reload to try again.", true);
    conversation.setToolsExpanded(instance.toolsExpanded);
    status.update(instance);
    runActivity = activityFromReplay(instance, reconciled);
    activity.setActivity(runActivity);
  }
  initialHistoryLoading = false;
  initialBufferedEvents = [];

  function sharedQuestions(): boolean { return instanceDelivery.interactions === "shared"; }

  /**
   * A question already open when this window read the Work: bootstrap events are not live
   * events. A fresh read is the whole current state, so a question still on screen that it
   * no longer has has ended meanwhile and is closed.
   */
  function presentOpenQuestion(events: readonly DockEvent[], fresh: boolean): void {
    if (!sharedQuestions()) return;
    let open: Extract<DockEvent, { type: "interaction.requested" }> | undefined;
    for (const event of events) {
      if (event.type === "interaction.requested") open = event;
      else if (event.type === "session.replaced") open = undefined;
      else if ((event.type === "interaction.resolved" || event.type === "interaction.cancelled") && event.data.interactionId === open?.data.interactionId) open = undefined;
    }
    if (open !== undefined) showQuestion(open);
    else if (fresh) {
      deferredQuestion = undefined;
      activeExtensionDialog?.closeFromHost();
    }
  }

  function showQuestion(event: Extract<DockEvent, { type: "interaction.requested" }>): void {
    if (screenStarted) void handleExtensionInteraction(event);
    else deferredQuestion = event;
  }

  function reportExtensionWidgetViewport(width: number): void {
    const leaseToken = controllerLeaseToken;
    if (exiting || (!sharedQuestions() && !leaseToken)) return;
    const height = Math.max(1, terminal.rows);
    const requestKey = `${leaseToken ?? "shared"}:${instance.runtimeGeneration}:${width}:${height}`;
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
    if (exiting || operationSubscription || sharedQuestions()) return Promise.resolve();
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
  else conversation.addNotice("Settings could not be loaded. Run /reload to try again.", true);
  if (commandsLoad.status === "fulfilled") {
    commands = commandsLoad.value.commands;
    if (commandsLoad.value.truncated) conversation.addNotice(`Showing ${commands.length} of ${commandsLoad.value.total} commands.`, true);
  } else conversation.addNotice("Commands could not be loaded. Run /reload to try again.", true);

  editor = new Editor(tui, editorTheme, {
    paddingX: numericSetting(settings, "editorPaddingX", 1),
    autocompleteMaxVisible: numericSetting(settings, "autocompleteMaxVisible", 10),
  });
  const editorDirective = pendingEditorDirective as { runtimeGeneration: number; text: string } | undefined;
  if (editorDirective !== undefined && editorDirective.runtimeGeneration === instance.runtimeGeneration) {
    editor.setText(editorDirective.text);
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
      conversation.addNotice("Live updates are interrupted, so this message is still in the editor. Wait for this window to reconnect, or press Ctrl+D and reopen the work from the Hub.", true);
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
    if (text.startsWith("/tree")) {
      conversation.addNotice("Run /tree, then search for and choose a conversation point.", true);
      tui.requestRender();
      return;
    }
    if (text === "/fork") {
      await chooseForkTarget();
      return;
    }
    if (text.startsWith("/fork")) {
      conversation.addNotice("Run /fork, then search for and choose an earlier prompt.", true);
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
    if (text === "/new") {
      await createNewSession();
      return;
    }
    if (text.startsWith("/new")) {
      conversation.addNotice("Usage: /new", true);
      tui.requestRender();
      return;
    }
    if (text === "/resume") {
      await chooseSession();
      return;
    }
    if (text.startsWith("/resume")) {
      conversation.addNotice("Run /resume, then search for and choose saved Pi work.", true);
      tui.requestRender();
      return;
    }
    if (text === "/name") {
      conversation.addNotice(instance.name
        ? `Current session name: ${terminalSafe(instance.name)}. Usage: /name NAME; use /name - to clear.`
        : "Name this session with /name NAME.");
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
    if (text === "/context-changes") {
      await showContextChanges();
      return;
    }
    if (["/install", "/config", "/login"].some((command) => text === command || text.startsWith(`${command} `))) {
      conversation.addNotice(`Open another shell and run \`pi ${text.slice(1)}\` there.`);
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
        conversation.addNotice("Attachments removed from the editor draft.");
      } else {
        conversation.addNotice(draftAttachmentIds.length === 0
          ? "The editor draft has no attachments."
          : `${draftAttachmentIds.length} attachment${draftAttachmentIds.length === 1 ? " is" : "s are"} ready to send with the editor draft.`);
      }
      tui.requestRender();
      return;
    }
    if (text === "/abort") {
      await abortRun();
      return;
    }
    if (text === "/abort-shell") {
      await abortShell();
      return;
    }
    const shell = shellCommandInput(text);
    if (shell !== undefined) {
      if (shell.command.length === 0) {
        conversation.addNotice("Usage: !COMMAND runs it here and shows the output to Pi; !!COMMAND keeps it out of Pi's context.", true);
        tui.requestRender();
        return;
      }
      await runShell(shell.command, shell.excludeFromContext);
      return;
    }
    if (text === "/stop") {
      blockEditorSubmit();
      runActivity = { phase: "aborting", label: "stopping" };
      activity.setActivity(runActivity);
      tui.requestRender();
      try {
        if (!requireCoherentControl()) { restoreEditorSubmit(); return; }
        const result = await client.stop(instance.id);
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
      if (!requireCoherentControl()) return;
      const attachments = draftAttachmentIds.length === 0 ? undefined : [...draftAttachmentIds];
      await client.prompt(instance.id, message, delivery, operationId, undefined, attachments);
      if (attachments !== undefined) draftAttachmentIds = [];
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

  /** Pi's `!` / `!!`: the command runs in the Work directory on the Work's machine; output streams into the conversation. */
  async function runShell(command: string, excludeFromContext: boolean): Promise<void> {
    blockEditorSubmit();
    try {
      if (!requireCoherentControl()) return;
      await client.runBash(instance.id, command, excludeFromContext, randomUUID());
    } catch (error) {
      editor.setText(`${excludeFromContext ? "!!" : "!"}${command}`);
      showError(error);
    } finally {
      restoreEditorSubmit();
      tui.requestRender();
    }
  }

  async function abortShell(): Promise<void> {
    blockEditorSubmit();
    try {
      if (!requireCoherentControl()) return;
      await client.abortBash(instance.id);
      showStatus("Told every running shell command to stop");
    } catch (error) {
      showError(error);
    } finally {
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
      conversation.addNotice(`${draftAttachmentIds.length} attachment${draftAttachmentIds.length === 1 ? " is" : "s are"} back with the editor draft and ready for its next submission. Use /attachments clear to remove them.`);
    }
  }

  async function restoreQueue(): Promise<void> {
    blockEditorSubmit();
    showStatus("returning waiting messages to the editor");
    try {
      if (!requireCoherentControl()) return;
      const result = await client.dequeue(instance.id);
      pendingQueue.remove([...result.receipt.restored, ...result.receipt.inFlight].map((message) => message.queueItemId));
      restoreMessagesToEditor(result.receipt.restored);
      if (result.receipt.inFlight.length > 0) {
        const count = result.receipt.inFlight.length;
        conversation.addNotice(`${count} waiting message${count === 1 ? " is" : "s are"} already moving into the conversation and could not be returned to the editor.`, true);
        return;
      }
      showStatus(result.receipt.restored.length > 0
        ? `Returned ${result.receipt.restored.length} waiting message${result.receipt.restored.length === 1 ? "" : "s"} to the editor`
        : "No waiting messages to return");
    } catch (error) {
      showError(error);
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
      if (!requireCoherentControl()) return;
      const result = await abortRestoringQueue(instance.id);
      pendingQueue.remove([...result.receipt.restored, ...result.receipt.inFlight].map((message) => message.queueItemId));
      restoreMessagesToEditor(result.receipt.restored);
      if (result.receipt.inFlight.length > 0) {
        const count = result.receipt.inFlight.length;
        conversation.addNotice(`${count} waiting message${count === 1 ? " had" : "s had"} already reached the Agent and could not be returned to the editor.`, true);
      } else if (result.receipt.restored.length > 0) {
        showStatus(`Returned ${result.receipt.restored.length} waiting message${result.receipt.restored.length === 1 ? "" : "s"} to the editor`);
      }
      runActivity = activityFromSnapshot(instance);
      activity.setActivity(runActivity);
    } catch (error) {
      showError(error);
    } finally {
      restoreEditorSubmit();
      tui.requestRender();
    }
  }

  /** One Host step; an older Host without it still gets its Queue back before the abort. */
  async function abortRestoringQueue(instanceId: string): Promise<AbortRestoreQueueResult> {
    try {
      return await client.abortRestoreQueue(instanceId);
    } catch (error) {
      if (!(error instanceof ControlClientError) || error.code !== "capability_missing"
        || !Array.isArray(error.details?.missing) || !error.details.missing.includes(ABORT_RESTORE_QUEUE_CAPABILITY)) throw error;
      const dequeued = await client.dequeue(instanceId);
      const aborted = await client.abort(instanceId);
      return { receipt: dequeued.receipt, instance: aborted.instance };
    }
  }

  async function chooseModel(): Promise<void> {
    blockEditorSubmit();
    showStatus("loading models");
    try {
      const catalog = await client.models(instance.id);
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
      conversation.addNotice("No models are available with the current sign-ins. Open another shell and run `pi /login`, then try again.", true);
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
    // The Host keeps one question open at a time, so a different question means the one on
    // screen has ended, even if word of that is still on its way (e.g. later in the same
    // catch-up). Close it and show the new one once it is gone.
    for (let shown = activeExtensionDialog; shown !== undefined; shown = activeExtensionDialog) {
      // The same question is published again when another window takes the operator connection.
      if (shown.interactionId === event.data.interactionId) return;
      shown.closeFromHost();
      await shown.closed;
    }
    const leaseToken = sharedQuestions() ? undefined : controllerLeaseToken;
    if (!sharedQuestions() && !leaseToken) {
      conversation.addNotice("This question is being handled in another open window.");
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
        if (authoritative.activeInteraction?.id === event.data.interactionId && controllerLeaseToken === leaseToken) {
          conversation.addNotice("Your answer could not be confirmed, so the question is still waiting. Answer it again when it reappears.", true);
          queueMicrotask(() => { void handleExtensionInteraction(event); });
        }
      } catch {
        conversation.addNotice("Your answer could not be confirmed, and the question is still waiting. Reopen this work from the Hub to continue.", true);
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

    let markClosed!: () => void;
    const shown = {
      interactionId: request.interactionId,
      closeFromHost: () => finish({ fromHost: true }),
      closed: new Promise<void>((resolve) => { markClosed = resolve; }),
    };
    activeExtensionDialog = shown;
    const frame = new WorkModalFrame(component);
    const overlay = tui.showOverlay(frame, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
    tui.setFocus(frame);
    try {
      return await result;
    } finally {
      overlay.hide();
      if (activeExtensionDialog === shown) activeExtensionDialog = undefined;
      tui.requestRender();
      markClosed();
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
          description: `${formatSettingValue(setting.value)} · ${setting.source}${setting.writable ? "" : " · read-only"}${setting.reloadRequired ? " · reload" : ""}${setting.hostRestartRequired ? " · restart Alu Dock" : ""}`,
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
      if (!requireCoherentControl()) return;
      const result = await client.updateSetting(instance.id, update);
      settings = settings.map((setting) => setting.key === result.setting.key ? result.setting : setting);
      applyLiveSetting(result.setting.key, result.setting.value);
      const boundary = result.hostRestartRequired ? " · restart Alu Dock from another shell" : result.reloadRequired ? " · run /reload" : "";
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
        if (!requireCoherentControl()) return;
        const result = await client.setActiveTools(instance.id, [...active].sort());
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
      if (!requireCoherentControl()) return;
      const result = await client.setActiveTools(instance.id, names);
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
      footer: "type text or label · ↑↓ move · ←→/PgUp/PgDn page · Enter select · Esc cancel",
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
          `Selected point · ${targetRole}`,
        ], [
          { value: "navigate", label: "Navigate directly", description: "Continue from this point now." },
          { value: "summary", label: "Navigate with summary", description: "Ask Pi to summarize the branch before continuing here." },
          { value: "custom", label: "Summary with additional instructions", description: "Add your own guidance to Pi's summary." },
          { value: "replace", label: "Summary with replacement instructions", description: "Use only your instructions for the summary." },
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
      if (!requireCoherentControl()) return;
      const result = await client.navigateSession(instance.id, targetId, options);
      if (result.editorText !== undefined && draftWasEmpty && editor.getText().length === 0) editor.setText(result.editorText);
      showStatus(result.cancelled ? result.aborted || treeNavigationAbortRequested ? "navigation stopped" : "navigation cancelled · current branch kept" : "branch selected");
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
      if (!requireCoherentControl()) return;
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
      const target = await chooseTreeListNode("Start from an earlier prompt", (node) => node.kind === "message" && node.role === "user");
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
      if (!requireCoherentControl()) return;
      const result = await client.forkSession(instance.id, entryId);
      if (result.selectedText !== undefined) editor.setText(result.selectedText);
      showStatus(result.cancelled ? "fork cancelled · current session kept" : "fork ready · edit and submit selected prompt");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  async function cloneSession(): Promise<void> {
    blockEditorSubmit();
    showStatus("finding the current conversation point");
    tui.requestRender();
    try {
      const tree = await client.tree(instance.id);
      if (!tree.leafId) {
        conversation.addNotice("This session has no current point to clone. Choose another session or start a new one.", true);
        showStatus("choose a session with messages to clone");
        return;
      }
      if (!requireCoherentControl()) return;
      const result = await client.cloneSession(instance.id, tree.leafId);
      if (!result.cancelled) editor.setText("");
      showStatus(result.cancelled ? "clone cancelled · current session kept" : "session cloned");
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
    showStatus("loading saved sessions");
    tui.requestRender();
    try {
      const target = await showSessionInventoryPicker();
      if (!target) { showStatus("current session kept"); return; }
      await resumeSession(target.sessionFile);
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  async function showSessionInventoryPicker(): Promise<SessionDto | undefined> {
    const sessionsByValue = new Map<string, SessionDto>();
    const picker = new SearchablePicker([], {
      title: "Resume Pi session",
      body: "Loading saved Pi sessions…",
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
          label: sessionDisplayName(session),
          description: `${session.cwd}${session.sessionFile === instance.executor.sessionFile ? " · current" : ""}${session.updatedAt ? ` · ${humanRelativeTime(session.updatedAt)}` : ""}`,
        };
      });
      picker.replaceItems(items);
      picker.setEmptyText(inventory.incomplete ? "No saved Pi sessions are ready to open" : "No saved Pi sessions found");
      const inventoryNotices = [
        ...(inventory.truncated ? [`Showing ${sessions.length.toLocaleString()} of ${inventory.total.toLocaleString()} saved sessions`] : []),
        ...(inventory.incomplete ? ["Some saved Pi sessions could not be checked. Check service logs for details."] : []),
      ];
      picker.setBody(inventoryNotices.length > 0 ? inventoryNotices.join(" · ") : undefined);
    }).catch(() => {
      if (!active) return;
      picker.setEmptyText("Saved Pi sessions could not be loaded");
      picker.setBody("Press Esc to return, then try again. Check service logs if the problem continues.");
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
        if (!requireCoherentControl()) return;
        result = await client.switchSession(instance.id, sessionFile, operationId);
      } catch (error) {
        const challenge = projectTrustChallenge(error, operationId);
        if (!challenge) throw error;
        const decision = await chooseProjectTrust(challenge.cwd);
        if (!decision) { showStatus("resume cancelled"); return; }
        if (!requireCoherentControl()) return;
        result = await client.switchSession(instance.id, sessionFile, operationId, { challengeId: challenge.challengeId, decision });
      }
      showStatus(result.cancelled ? "resume cancelled · current session kept" : "session resumed");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  async function chooseProjectTrust(cwd: string): Promise<ProjectTrustChoice | undefined> {
    const selected = await showFixedActions("Project-local Pi resources", [cwd], [
      { value: "trust_once", label: "Trust once", description: "Load project resources for this action." },
      { value: "trust_and_remember", label: "Trust and remember", description: "Load project resources and persist this decision." },
      { value: "deny_once", label: "Do not trust once", description: "Continue without project resources." },
      { value: "deny_and_remember", label: "Do not trust and remember", description: "Continue without project resources and remember this choice." }
    ]);
    return isProjectTrustChoice(selected) ? selected : undefined;
  }

  async function createNewSession(): Promise<void> {
    blockEditorSubmit();
    showStatus("creating session");
    tui.requestRender();
    try {
      if (!requireCoherentControl()) return;
      const result = await client.newSession(instance.id);
      showStatus(result.cancelled ? "new session cancelled · current session kept" : "new session ready");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.requestRender(); }
  }

  async function nameSession(name: string): Promise<void> {
    blockEditorSubmit();
    showStatus("naming session");
    tui.requestRender();
    try {
      if (!requireCoherentControl()) return;
      const named = (await client.nameSession(instance.id, name)).instance.name;
      pendingTitleDirective = undefined;
      restoreTerminalTitle();
      conversation.addNotice(named ? `Session name: ${terminalSafe(named)}.` : "Session name cleared.");
      showStatus(named ? `named ${terminalSafe(named)}` : "session name cleared");
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.requestRender(); }
  }

  async function compactSession(customInstructions?: string): Promise<void> {
    tui.requestRender();
    try {
      if (!requireCoherentControl()) return;
      const result = await client.compactSession(instance.id, customInstructions);
      conversation.addNotice(`Compacted ${result.result.tokensBefore.toLocaleString()} tokens. The conversation is ready to continue.`);
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

  function addResourceDiagnostics(diagnostics: DiagnosticDto[]): void {
    for (const diagnostic of diagnostics) {
      conversation.addNotice(humanResourceDiagnostic(diagnostic), diagnostic.severity === "error");
    }
    if (diagnostics.length > 0) conversation.addNotice("Check the details above, then run /reload.");
  }

  async function reloadSession(): Promise<void> {
    blockEditorSubmit();
    showStatus("reloading resources");
    tui.requestRender();
    try {
      if (!requireCoherentControl()) return;
      const result = await client.reloadSession(instance.id);
      addResourceDiagnostics(result.diagnostics);
      showStatus(`reloaded ${result.resources.length} resources${result.diagnostics.length === 0 ? "" : ` · ${result.diagnostics.length} problems`}`);
      if (result.resourcesTruncated || result.diagnosticsTruncated) {
        conversation.addNotice(`Showing ${result.resources.length} of ${result.resourceTotal} resources and ${result.diagnostics.length} of ${result.diagnosticTotal} problems.`, true);
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
      addResourceDiagnostics(result.diagnostics);
      const indexed = result.resources.map((resource, index) => ({ resource, value: String(index) }));
      let selected: string | undefined;
      while (true) {
        selected = await showChoicePicker("Pi resources", indexed.map(({ resource, value }) => ({ value, label: `${resource.kind}: ${resource.name}`, description: resource.path ?? resource.source?.package ?? resource.source?.kind })), selected);
        const resource = indexed.find((candidate) => candidate.value === selected)?.resource;
        if (!resource) break;
        if (!resource.contentRef) { conversation.addNotice(`${resource.kind} ${resource.name}${resource.path ? ` · ${resource.path}` : ""}`); break; }
        const ref = resource.contentRef;
        const reader = new DocumentReader(resource.name, resource.path?.endsWith(".json") === true, () => Math.max(4, Math.floor(terminal.rows * 0.9) - 2), () => tui.requestRender());
        let close!: () => void;
        const closed = new Promise<void>((resolve) => { close = resolve; });
        reader.onClose = close;
        const frame = new WorkModalFrame(reader);
        const overlay = tui.showOverlay(frame, { width: "96%", maxHeight: "94%", anchor: "center", margin: 0 });
        tui.setFocus(frame);
        void reader.load((signal) => client.resourceContentAll(instance.id, ref, signal));
        try { await closed; }
        finally { reader.dispose(); overlay.hide(); }
      }
      showStatus(`${result.resources.length} resources available${result.diagnostics.length === 0 ? "" : ` · ${result.diagnostics.length} problems`}`);
      if (result.resourcesTruncated || result.diagnosticsTruncated) {
        conversation.addNotice(`Showing ${result.resources.length} of ${result.resourceTotal} resources and ${result.diagnostics.length} of ${result.diagnosticTotal} problems.`, true);
      }
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  /** System prompt and model-context changes are recorded outside the chat; read one in full. */
  async function showContextChanges(): Promise<void> {
    blockEditorSubmit();
    showStatus("reading context changes");
    tui.requestRender();
    try {
      // One read view for the whole scan and the records opened from it.
      const view: ConversationReadContext = {};
      const changes: ConversationHistoryEntryDto[] = [];
      // Only what names an edited record is kept for the whole conversation, not its text.
      const records = new Map<string, HistoryEntryDto>();
      let cursor: string | undefined;
      let read = 0;
      do {
        const page = await client.conversationHistory(instance.id, cursor, MAX_CONVERSATION_HISTORY_ITEMS, view);
        for (const item of [...page.entries].reverse()) {
          records.set(item.entry.entryId, { ...item.entry, content: [] });
          if (item.entry.systemPrompt !== undefined || item.entry.contextEdit === "replace") changes.push(item);
        }
        read += page.entries.length;
        cursor = page.hasEarlier ? page.nextCursor : undefined;
        if (cursor !== undefined) { showStatus(`reading context changes · ${read.toLocaleString()} records read`); tui.requestRender(); }
      } while (cursor !== undefined);
      if (changes.length === 0) {
        conversation.addNotice("This conversation has no system prompt or model context changes yet.");
        showStatus("no context changes");
        return;
      }
      showStatus(`${changes.length} context ${changes.length === 1 ? "change" : "changes"}`);
      const items = changes.map((item, index) => ({
        value: String(index),
        label: item.entry.systemPrompt
          ? systemPromptChangeText(item.entry.systemPrompt)
          : `Model context: ${contextEditTarget(item.entry.targetEntryId === undefined ? undefined : records.get(item.entry.targetEntryId))} was replaced`,
        description: item.entry.timestamp ? humanRelativeTime(item.entry.timestamp) : undefined,
      }));
      let selected: string | undefined;
      while (true) {
        selected = await showChoicePicker("Context changes · newest first", items, selected);
        const change = selected === undefined ? undefined : changes[Number(selected)];
        if (!change) break;
        const reader = new DocumentReader(
          change.entry.systemPrompt ? "System prompt change" : "Model context replacement",
          true,
          () => Math.max(4, Math.floor(terminal.rows * 0.9) - 2),
          () => tui.requestRender(),
          { origin: "as recorded in this conversation", failure: "Couldn't read this change. The conversation may have moved on; run /context-changes again." },
        );
        let close!: () => void;
        const closed = new Promise<void>((resolve) => { close = resolve; });
        reader.onClose = close;
        const frame = new WorkModalFrame(reader);
        const overlay = tui.showOverlay(frame, { width: "96%", maxHeight: "94%", anchor: "center", margin: 0 });
        tui.setFocus(frame);
        void reader.load((signal) => readRecordText(change, view, signal));
        try { await closed; }
        finally { reader.dispose(); overlay.hide(); }
      }
    } catch (error) { showError(error); }
    finally { restoreEditorSubmit(); tui.setFocus(editor); tui.requestRender(); }
  }

  /**
   * A history preview can be shortened; the rest of the record is read through its content
   * reference. A system prompt change lists everything it changes first, then each recorded
   * text under what it is.
   */
  async function readRecordText(item: ConversationHistoryEntryDto, view: ConversationReadContext, signal: AbortSignal): Promise<{ text: string }> {
    const blocks = item.entry.content.map((block) => block.type === "text" || block.type === "thinking" ? block.text : "");
    if (!item.contentComplete) {
      blocks.length = 0;
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await client.conversationContent(instance.id, item.contentRef, cursor, view);
        for (const chunk of page.chunks) {
          if (chunk.type === "text" || chunk.type === "thinking") blocks[chunk.blockIndex] = `${blocks[chunk.blockIndex] ?? ""}${chunk.text}`;
        }
        cursor = page.complete ? undefined : page.nextCursor;
      } while (cursor !== undefined);
    }
    const change = item.entry.systemPrompt;
    if (change === undefined) return { text: blocks.filter((block) => block.length > 0).join("\n\n") };
    const texts = blocks.flatMap((block, index) => block.length > 0 ? [`${systemPromptBlockLabel(change.blocks[index])}\n${"─".repeat(24)}\n${block}`] : []);
    return { text: [systemPromptChangeDetail(change), ...texts].join("\n\n") };
  }

  async function switchModel(provider: string, modelId: string): Promise<void> {
    blockEditorSubmit();
    showStatus(`switching to ${provider}/${modelId}`);
    tui.requestRender();
    try {
      if (!requireCoherentControl()) return;
      await client.setModel(instance.id, provider, modelId);
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
      if (!requireCoherentControl()) return;
      const result = await client.setThinking(instance.id, level);
      showStatus(`thinking ${result.instance.executor.thinkingLevel ?? level}`);
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
      conversation.addNotice(formatWorkStatus(await client.status(instance.id)));
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
          deliveryContext: instanceDelivery,
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
      if (!full.ok) conversation.addNotice("Some earlier messages could not be reloaded. The messages shown here are ready to use; run /reload to try again.", true);
      conversation.setToolsExpanded(instance.toolsExpanded);
    } else {
      const buffered = replacementBufferedEvents;
      replacementBufferedEvents = [];
      replacementHistoryGeneration = undefined;
      reconciled = reconcileFlowingEvents([], buffered);
      conversation.addNotice("Conversation history could not be reloaded. Run /reload to try again.", true);
      conversation.applyReplay(reconciled, false);
      conversation.setToolsExpanded(instance.toolsExpanded);
    }

    if (settingsLoad.status === "fulfilled") {
      settings = settingsLoad.value.settings;
      for (const setting of settings) applyLiveSetting(setting.key, setting.value);
    } else {
      conversation.addNotice("Settings could not be reloaded. Run /reload to try again.", true);
    }
    if (commandsLoad.status === "fulfilled") {
      commands = commandsLoad.value.commands;
      if (commandsLoad.value.truncated) conversation.addNotice(`Showing ${commands.length} of ${commandsLoad.value.total} commands.`, true);
    } else conversation.addNotice("Commands could not be reloaded. Run /reload to try again.", true);
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
        deliveryContext: instanceDelivery,
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
      conversation.addNotice("The selected branch could not be loaded. Reopen the tree and choose it again.", true);
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
      : humanErrorText(error);
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
      if (!requireCoherentControl()) return;
      const result = await client.setToolsExpanded(instance.id, expectedRuntimeGeneration, expanded, randomUUID());
      if (result.instance.runtimeGeneration !== expectedRuntimeGeneration) return;
      showStatus(expanded ? "all tools expanded" : "tools collapsed");
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
      else showStatus("connection interrupted · Ctrl+D leaves Work");
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
        else showStatus("reconnect before cancelling navigation");
        return { consume: true };
      }
      if (instance.execution === "running") {
        if (eventStreamConnected) void abortRun();
        else showStatus("reconnect before stopping the run");
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
        else showStatus("reconnect before cancelling navigation");
      } else if (editor.getText().length > 0) {
        editor.setText("");
        showStatus("input cleared");
      } else if (instance.execution === "running") {
        if (eventStreamConnected) void abortRun();
        else showStatus("reconnect before stopping the run");
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
    runActivity = disconnectedActivity("checking connection · work status pending");
    activity.setActivity(runActivity);
    detachTruth = "status_unknown";
    conversation.addNotice("Live updates were interrupted. Checking whether the work is still running.", true);
    tui.requestRender();

    const recovery = (async () => {
      let authoritative: InstanceSnapshot;
      try {
        authoritative = await client.status(instance.id);
      } catch {
        if (exiting || subscription !== watched) return;
        status.setConnection("lost");
        runActivity = disconnectedActivity("reconnection failed · Ctrl+D leaves Work");
        activity.setActivity(runActivity);
        conversation.addNotice("The connection could not be restored. Press Ctrl+D to leave Work, then run `aludock` to reopen it.", true);
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
        conversation.addNotice(`This work is ${humanInstanceStatus(authoritative.lifecycle, authoritative.execution)}. Press Ctrl+D to leave Work, then run \`aludock\` to choose what to do next.`, true);
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
            deliveryContext: instanceDelivery,
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
            deliveryContext: instanceDelivery,
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
          catchingUp = true;
          try { for (const event of next.initial.page.events) onEvent(event); }
          finally { catchingUp = false; }
        } else {
          instance = next.initial.instance;
          pendingQueue.reset(next.initial.pendingMessages);
          conversation.applyHistory(rebuiltHistory, false);
          conversation.applyBootstrapReplay(next.initial.page.events);
          conversation.setToolsExpanded(instance.toolsExpanded);
          presentOpenQuestion(next.initial.page.events, true);
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
          ? "Live updates resumed. This work is ready to continue."
          : "Live updates resumed with a refreshed conversation. This work is ready to continue.");
        subscription = next;
        eventStreamConnected = true;
        candidateReady = true;
        for (const event of candidateBufferedEvents) onEvent(event);
        candidateBufferedEvents.length = 0;
        refreshEditorSubmit();
        watchEventSubscription(next);
        // The reconnected Host may predate shared questions; then take the operator connection.
        void acquireExtensionUiOperation();
        updateTerminalProgress();
        tui.requestRender();
      } catch {
        if (next) {
          next.close();
          await next.done.catch(() => {});
        }
        if (exiting || subscription !== watched) return;
        runActivity = disconnectedActivity("reconnection failed · Ctrl+D leaves Work");
        activity.setActivity(runActivity);
        conversation.addNotice("The connection could not be restored. Press Ctrl+D to leave Work, then run `aludock` to reopen it.", true);
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
  screenStarted = true;
  if (deferredQuestion !== undefined) {
    const question = deferredQuestion;
    deferredQuestion = undefined;
    void handleExtensionInteraction(question);
  }
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

export function humanResourceDiagnostic(diagnostic: DiagnosticDto): string {
  const subject = diagnostic.source ?? "a Pi resource";
  if (diagnostic.severity === "error") return `Could not load ${subject}: ${diagnostic.message}`;
  if (diagnostic.severity === "warning") return `${subject} needs attention: ${diagnostic.message}`;
  return `${subject}: ${diagnostic.message}`;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
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
    `Status: ${humanInstanceStatus(snapshot.lifecycle, snapshot.execution)}`,
    `Session: ${terminalSafe(snapshot.name || "(unnamed)")}${snapshot.key === undefined ? "" : ` [${terminalSafe(snapshot.key)}]`}`,
    `Work cwd: ${terminalSafe(snapshot.cwd)}${snapshot.gitBranch === undefined ? "" : ` (${terminalSafe(snapshot.gitBranch)})`}`,
    `Model: ${model} · thinking ${terminalSafe(snapshot.executor.thinkingLevel ?? "off")}`,
    `Saved session: ${snapshot.executor.sessionFile === undefined ? "available after the first message" : "available"}`,
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
    throw new Error("That project trust choice expired. Try the action again.");
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
    "CONVERSATION",
    "  /tree                    browse or navigate branches",
    "  /fork                    start again from an earlier prompt",
    "  /clone                   clone the current point",
    "  /new                     start a new Pi session",
    "  /resume                  choose a saved Pi session",
    "  /name NAME                set or clear the session name",
    "  /compact [INSTRUCTIONS]   shorten conversation context",
    "PI",
    "  /model [PROVIDER/MODEL]   choose a model",
    "  /thinking [LEVEL]         set reasoning effort",
    "  /tools [NAME…]            choose active tools",
    "  /settings [KEY VALUE]     inspect or update settings",
    "  /reload                   reload Pi files and commands",
    "  /resources                inspect loaded Pi files and warnings",
    "  /context-changes          read system prompt and model context changes",
    "WORK",
    "  /steer MESSAGE            redirect the current response",
    "  /follow MESSAGE           send after the current response",
    "  /abort                    stop the current response",
    "  !COMMAND                  run a shell command here; Pi sees the output",
    "  !!COMMAND                 run a shell command here; Pi does not see it",
    "  /abort-shell              stop every running shell command",
    "  /status                   refresh work status",
    "  /stop                     end this work and remove it from Dock",
    "  /detach                   leave Work; work keeps running",
    "  /config                   show the separate Pi CLI command",
    "  /install                  show the separate Pi CLI command",
    "  /login                    show the separate Pi CLI command",
    "DETAILS",
    "  Ctrl+O                    expand or collapse all tool details",
    "  Alt+O                     toggle the latest detail",
    "  Type / to discover extension, skill, and prompt commands.",
  ].join("\n");
}

/** Pi's editor prefixes: `!cmd` runs and shows Pi the output, `!!cmd` runs without adding it to context. */
export function shellCommandInput(text: string): { command: string; excludeFromContext: boolean } | undefined {
  if (!text.startsWith("!")) return undefined;
  const excludeFromContext = text.startsWith("!!");
  return { command: text.slice(excludeFromContext ? 2 : 1).trim(), excludeFromContext };
}

export function commandCatalog(commands: CommandDto[]): Array<{ name: string; description: string; argumentHint?: string }> {
  const catalog = new Map<string, { name: string; description: string; argumentHint?: string }>();
  for (const command of commands) {
    const name = terminalSafe(command.name);
    if (name.length === 0 || /\s|\//u.test(name)) continue;
    catalog.set(name, {
      name,
      description: terminalSafe(command.description ?? "Pi command"),
      ...(command.argumentCompletions ? { argumentHint: "arguments" } : {}),
    });
  }
  const dockCommands = [
    { name: "abort", description: "stop the current response; keep the work open" },
    { name: "clone", description: "clone the current conversation point into a new Pi session" },
    { name: "compact", description: "shorten conversation context", argumentHint: "INSTRUCTIONS" },
    { name: "config", description: "show the separate Pi CLI command" },
    { name: "context-changes", description: "read system prompt and model context changes" },
    { name: "detach", description: "leave Work while the work keeps running" },
    { name: "follow", description: "send a message after the current response", argumentHint: "MESSAGE" },
    { name: "fork", description: "choose an earlier prompt and return it to the editor" },
    { name: "help", description: "show Work commands" },
    { name: "install", description: "show the separate Pi CLI command" },
    { name: "login", description: "show the separate Pi CLI command" },
    { name: "model", description: "choose or set provider/model", argumentHint: "PROVIDER/MODEL" },
    { name: "name", description: "set or clear the Pi session name", argumentHint: "NAME" },
    { name: "new", description: "start a new Pi session" },
    { name: "reload", description: "reload Pi files and commands" },
    { name: "resources", description: "inspect loaded Pi files and warnings" },
    { name: "resume", description: "search for and choose a saved Pi session" },
    { name: "settings", description: "inspect or update Pi settings", argumentHint: "KEY VALUE" },
    { name: "status", description: "refresh work status" },
    { name: "steer", description: "redirect the current response", argumentHint: "MESSAGE" },
    { name: "stop", description: "end this work and remove it from Dock" },
    { name: "thinking", description: "choose or set thinking level", argumentHint: "LEVEL" },
    { name: "tools", description: "choose active tools", argumentHint: "NAME…" },
    { name: "tree", description: "browse and choose a point in the current Pi session tree" },
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
