import { piSystemPromptResolver } from "./system-template-provider.js";
import { resolvePiStartingModel } from "./pi-starting-model.js";
import { workerToolSelection } from "./worker-tool-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionCommandContextActions,
  type ExtensionUIContext,
  type PromptOptions,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getCompactionPromptTemplates,
  type ModelRuntime,
  SettingsManager,
  type ResourceDiagnostic,
  type SessionEntry,
  type SessionTreeNode,
  type SourceInfo,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

import { ResourceContentError } from "../core/resource-content.js";
import { MAX_SOURCE_FILE_PATH_CHARS } from "../core/source-file.js";
import { CHILD_DOCK_TOOL_NAMES, dockToolsExtension, type DockToolsBridge } from "./dock-tools-extension.js";
import { dockAttachmentsExtension } from "./dock-attachments-extension.js";
import type { DockAttachmentCallPort } from "./dock-attachment-access.js";
import { appendDockAttachmentContext, extractDockAttachmentContext } from "./dock-attachment-context.js";
import { assistantExtension, assistantSystemPrompt, type AssistantCallPort } from "./assistant-extension.js";

import {
  MAX_STOP_CLEANUP_ERROR_CHARS,
  MAX_TEXT_CHARS,
  type ConversationFrame,
  type ConversationImageBody,
  type ImagePathDto,
  type TreeNodeDto,
} from "../core/instance-dto.js";
import { projectJsonObject, type JsonObject } from "../core/json-value.js";
import { systemPromptChangeText, usageRecordText } from "../core/runtime-record-text.js";
import type { PiExtensionUiPort } from "./pi-extension-ui-adapter.js";
import {
  AgentCompactionKnownFailureError,
  AgentConversationCursorError,
  AgentInvalidDeliveryModeError,
  AgentInvalidTreeTargetError,
  AgentQueueEffectUnknownError,
  AgentQueueRejectedBeforeEffectError,
} from "../core/agent-worker.js";
import type {
  ClearedAgentQueue,
  AgentCleanupResult,
  AgentCommandPreflightResult,
  AgentCompactionResult,
  AgentConversationContentPage,
  AgentConversationHistoryPage,
  AgentEvent,
  AgentForkResult,
  AgentHistoryEntry,
  AgentCommandCatalogBody,
  AgentCommandCompletionsBody,
  AgentCommandContentBody,
  AgentInputKind,
  AgentInvokeContext,
  AgentModelListBody,
  AgentModelState,
  AgentResourceProjectionBody,
  AgentSessionListBody,
  AgentNavigateOptions,
  AgentNavigateResult,
  AgentPromptOptions,
  AgentRequest,
  AgentWorkerControl,
  AgentSessionMetrics,
  AgentSessionTarget,
  ThinkingLevel,
  AgentToolProjection,
} from "../core/agent-worker.js";
import type {
  CommandArgumentCompletionDto,
  CommandDto,
  CommandReferenceDto,
  DiagnosticDto,
  ResourceDto,
  SettingDto,
  SettingKey,
  SettingUpdate,
  SourceDto,
  ToolDto,
} from "../core/config-projection.js";
import {
  MAX_COMMAND_ARGUMENT_COMPLETIONS,
  MAX_COMMAND_ARGUMENT_HINT_CHARS,
  MAX_COMMAND_ARGUMENT_PREFIX_CHARS,
  MAX_COMMAND_COMPLETION_TEXT_CHARS,
  MAX_COMMAND_CONTENT_PAGE_CHARS,
  compareCommandDtos,
  compareDiagnosticDtos,
  compareResourceDtos,
  compareSourceDtos,
  compareToolDtos,
} from "../core/config-projection.js";
import { parseSessionTreeResult, type SessionTreeResult } from "../control/protocol.js";
import { AgentModelNotFoundError, AgentSettingsWriteError, AgentUnknownToolError } from "../core/agent-worker.js";
import { configurePiNetwork } from "./configure-pi-network.js";
import { projectPiModelList } from "./pi-model-list.js";
import { GitBranchObserver, type GitBranchObserverPort } from "./git-branch-observer.js";
import { createPiExtensionUiContext } from "./pi-extension-ui-adapter.js";
import { piToolResultNormalizerExtension } from "./pi-tool-result-normalizer.js";
import { retryExtension } from "./retry-extension.js";
import { planGoalExtension, type PlanGoalPort } from "./plan-goal-extension.js";
import { TransientFileRegistry } from "./transient-file-registry.js";
import { piBuiltinExtensions } from "./pi-builtin-extensions.js";
import {
  boundedString,
  isRecord,
  loadAttachmentContextKey,
  loadPiImages,
  PiConversationProjector,
  PiSessionConversation,
  projectAgentSessionEvents,
  projectRecordUsage,
  projectSystemPromptChange,
  resolveAttachmentImages,
  safeOptionalText,
  safeRequiredText,
  trimTokenMap,
  unicodeSafeEnd,
  type PiConversationSource,
  type PiImageContent,
} from "./pi-conversation.js";
import { ownCanonicalShowImage, showImageExtension } from "./show-image-extension.js";
import {
  applyPiSetting,
  assertPiSettingUpdate,
  projectPiSetting,
  projectPiSettings,
  projectSettingsErrors,
  validatedPiSettingValue,
} from "./pi-settings-adapter.js";

export interface PiSessionCatalogInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  modified: Date;
}

export interface PiSessionCatalog {
  list(cwd: string, sessionDir?: string): Promise<PiSessionCatalogInfo[]>;
  listAll(sessionDir?: string): Promise<PiSessionCatalogInfo[]>;
}

const DEFAULT_SESSION_CATALOG: PiSessionCatalog = {
  list: (cwd, sessionDir) => SessionManager.list(cwd, sessionDir),
  listAll: (sessionDir) => sessionDir === undefined ? SessionManager.listAll() : SessionManager.listAll(sessionDir),
};

export const ALU_DOCK_PI_WORKER_GUIDANCE = `You are running as a Pi Worker managed by Alu Dock. Your work can continue after a terminal disconnects, and Alu Dock clients may observe or control this Work through Dock protocols. Pi remains authoritative for its settings, credentials, extensions, project resources, and Session history. Use \`aludock pi:install <source>\` when the user asks you to install a Pi package through the bundled Pi runtime; do not require a separate system Pi installation.`;

export const ALU_DOCK_CHILD_GUIDANCE = "You are a child Work that another Dock Work, your parent, created for its task. You and your parent work at the same time, and it sees only what you send it with dock_send. While you work, send with done: false what it should know or answer now, such as a finding that affects its work, a question or a point to agree on, then keep working; never send acknowledgments or empty progress. When you finish the work it handed you, send your result with done: true, which ends your turn. Your parent's messages to you begin with [来自父 Work「its name」]. When the user talks to you directly, answer the user. You cannot reach any other Work.";

type RuntimeOwner = Pick<AgentSessionRuntime,
  "session" | "services" | "cwd" | "diagnostics" | "modelFallbackMessage" |
  "setBeforeSessionInvalidate" | "setRebindSession" | "newSession" | "switchSession" | "fork" | "dispose"
>;

type ReplacementKind = "new" | "switch" | "fork" | "clone" | "reload";

export interface PiExtensionUiLifecyclePort extends PiExtensionUiPort {
  beginGenerationChange(kind?: "binding" | "reload"): Promise<void>;
  completeGenerationChange(): Promise<void>;
  failGenerationChange(): Promise<void>;
}

export interface PiAgentAdapterOptions {
  planGoalPort?: PlanGoalPort;
  runtime: RuntimeOwner;
  sessionCatalog?: PiSessionCatalog;
  setProjectTrust?: (cwd: string, trusted: boolean) => void;
  commitReplacement?: (change: { operationId: string; kind: ReplacementKind; previousSessionFile?: string; sessionFile?: string }) => Promise<void>;
  commitRuntimeError?: (failure: { operationId: string; kind: ReplacementKind; error: unknown; recoverySessionFile?: string }) => Promise<void>;
  isSessionFileDurable?: (path: string) => boolean;
  extensionUiBroker?: PiExtensionUiLifecyclePort;
  uiContext?: ExtensionUIContext;
  uiContextFactory?: () => ExtensionUIContext;
  initialProcessCwd?: string;
  setProcessCwd?: (cwd: string) => void;
  gitBranchObserverFactory?: (
    cwd: string,
    onChange: (branch: string | undefined) => void,
  ) => Promise<GitBranchObserverPort>;
  configureNetwork?: (settingsManager: AgentSessionServices["settingsManager"]) => void;
  attachmentContextKey: Uint8Array;
  publishedFiles: TransientFileRegistry;
  dockAttachmentPort?: DockAttachmentCallPort;
  /** Explicit Pi session directory; otherwise Pi's default for each cwd. */
  sessionDir?: string;
}

export interface CreatePiAgentAdapterOptions {
  /** Creates each session's models when another process owns their configuration and credentials; by default Pi reads this machine's. */
  createModelRuntime?: () => Promise<ModelRuntime>;
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  /** Pi owns the meaning of these JSON-safe createAgentSession fields. */
  workerConfig?: JsonObject;
  /** A child Work that reports only to the Work that created it. */
  child?: boolean;
  /** Exact tools this Work may ever use, enforced in Pi's tool registry. */
  allowedTools?: string[];
  projectTrusted: boolean;
  extensionUiBroker?: PiExtensionUiLifecyclePort;
  extensionUiContextPortFactory?: () => PiExtensionUiPort;
  setProcessCwd?: (cwd: string) => void;
  sessionManager?: SessionManager;
  dockToolsBridge?: DockToolsBridge;
  dockAttachmentPort?: DockAttachmentCallPort;
  /** Given only to a Work opened as the personal assistant (card #295). */
  assistantPort?: AssistantCallPort;
}

interface BindingToken { active: boolean }
interface Binding {
  token: BindingToken;
  session: AgentSession;
  services: AgentSessionServices;
  cwd: string;
  unsubscribe: () => void;
  gitBranchObserver?: GitBranchObserverPort;
  buffered: AgentEvent[];
  bufferEvents: boolean;
  conversation: PiConversationProjector;
  runOperationId?: string;
  /** Pi published agent_start and has not yet published the matching agent_settled. */
  awaitingSettled: boolean;
  /** A run was stopped while extensions still prepared it; Pi publishes agent_settled once they return. */
  stoppedBeforeStart: boolean;
  settledWaiters: Array<() => void>;
  /** User shell commands (bash.run) still executing against this session, with what bash.started announced. */
  runningBash: Map<string, { command: string; excludeFromContext: boolean }>;
  /** Their executions, so a Worker shutdown can let Pi record the cancellations first. */
  bashTasks: Set<Promise<void>>;
  /** Finished commands whose record Pi is still holding until the current agent run ends. */
  deferredBash: Set<string>;
}

/** Pi's abortBash kills the process tree; its record is appended once the process is gone. */
const BASH_RECORD_SETTLE_MS = 1_500;

/** How Pi dispatched accepted input. Pi does not report rejected input; prompt() throws instead. */
type PiPromptDisposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];
interface PiPromptOptions extends Omit<AgentPromptOptions, "preflightResult"> {
  preflightResult?: (disposition: PiPromptDisposition) => void;
}

type PiBashResult = Awaited<ReturnType<AgentSession["executeBash"]>>;

/** In-Worker Pi adapter around the SDK's mutable AgentSessionRuntime. */
export class PiAgentAdapter {
  private readonly subscribers = new Set<(event: AgentEvent) => void>();
  private active: Binding | undefined;
  private staged: Binding | undefined;
  private disposed = false;
  private runtimeDisposed = false;
  private unavailable = false;
  private disposePromise: Promise<AgentCleanupResult> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private rebindEntered = false;
  private replacementInvalidated = false;
  private replacementRunning = false;
  private treeNavigation: Promise<AgentNavigateResult> | undefined;
  private initialActivated = false;
  private queueUpdateSequence = 0;
  private processCwdValue: string | undefined;
  private sessionNameOperationId: string | undefined;
  private manualCompactionOperationId: string | undefined;
  private extensionCommandOperationId: string | undefined;
  private readonly conversationReader: PiSessionConversation;
  private readonly commandContentCursors = new Map<string, { commandKey: string; revision: string; offset: number }>();

  private constructor(private readonly options: PiAgentAdapterOptions) {
    this.conversationReader = new PiSessionConversation({ attachmentContextKey: options.attachmentContextKey, publishedFiles: options.publishedFiles });
    if (options.planGoalPort) options.planGoalPort.prompt = async (text, mayStart, stopped) => {
      let started = false;
      const binding = this.requireActive();
      // Pi defers a prompt made while extensions handle agent_settled and reports
      // nothing about it then; a Goal started from that handler waits for it here.
      await this.waitForSettledBoundary(binding);
      const { session } = binding;
      await session.prompt(text, {
        source: "extension", expandPromptTemplates: false,
        preflightResult: (disposition: PiPromptDisposition) => {
          if (disposition !== "started") return;
          if (mayStart()) {
            started = true;
            return;
          }
          // Stopped or superseded while Pi prepared it. Pi stops a run whose abort
          // arrives before its first request, so this prompt never reaches the model;
          // Pi still records it, and the extension that asked keeps it out of later
          // requests. The session may have been replaced meanwhile; only the
          // extension instance and session of this request are told.
          stopped();
          const binding = this.active;
          if (binding?.session === session && binding.token.active) binding.stoppedBeforeStart = true;
          void session.abort().catch(() => {});
        },
      } as PromptOptions);
      return started;
    };
    this.processCwdValue = options.initialProcessCwd;
    options.runtime.setBeforeSessionInvalidate(() => {
      if (this.replacementRunning) this.replacementInvalidated = true;
      void options.extensionUiBroker?.beginGenerationChange("binding");
      this.invalidateBindingsSynchronously();
    });
    options.runtime.setRebindSession(async (session) => {
      this.rebindEntered = true;
      await this.stageCandidate(session);
    });
  }

  static async create(options: PiAgentAdapterOptions): Promise<PiAgentAdapter> {
    const host = new PiAgentAdapter(options);
    try {
      await host.stageCandidate(options.runtime.session);
      host.promoteInitial();
      return host;
    } catch (error) {
      await host.disposeRuntimeOnce().catch(() => {});
      host.disposed = true;
      throw error;
    }
  }

  get sessionId(): string { return this.requireActive().session.sessionId; }
  get sessionFile(): string | undefined { return this.requireActive().session.sessionFile; }
  get isStreaming(): boolean { return this.active?.session.isStreaming ?? false; }
  get isPreparing(): boolean { return this.active !== undefined && piIsPreparing(this.active); }
  get isCompacting(): boolean { return this.active?.session.isCompacting ?? false; }
  getDurableSessionFile(): string | undefined {
    const path = this.active?.session.sessionFile;
    if (path === undefined) return undefined;
    try {
      if (this.options.isSessionFileDurable) return this.options.isSessionFileDurable(path) ? path : undefined;
      const info = lstatSync(path);
      const getuid = process.getuid;
      const owned = typeof getuid === "function" ? info.uid === getuid() : process.platform === "win32";
      return info.isFile()
        && !info.isSymbolicLink()
        && relative(realpathSync(path), resolve(path)) === ""
        && owned
        ? path
        : undefined;
    } catch {
      return undefined;
    }
  }
  get diagnostics(): readonly unknown[] { return this.options.runtime.diagnostics; }
  get modelFallbackMessage(): string | undefined { return this.options.runtime.modelFallbackMessage; }
  getGitBranch(): string | undefined { return this.requireActive().gitBranchObserver?.branch; }
  currentSession(): AgentSession { return this.requireActive().session; }
  getExtensionCommandNames(): string[] {
    return this.requireActive().session.extensionRunner.getRegisteredCommands()
      .map((command) => command.invocationName)
      .filter((name) => typeof name === "string" && name.length > 0 && name.length <= 256)
      .sort();
  }

  /** Flush startup events only after ManagedInstance has attached its stable subscriber. */
  activateInitial(): void {
    if (this.initialActivated) return;
    const binding = this.requireActive();
    this.initialActivated = true;
    const events = binding.buffered;
    binding.buffered = [];
    binding.bufferEvents = false;
    for (const event of events) this.publish(event);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async dispatch(request: AgentRequest, context?: AgentInvokeContext, preflightResult?: (result: AgentCommandPreflightResult) => void): Promise<unknown> {
    switch (request.type) {
      case "command.submit": {
        const { operationId, delivery: requestedDelivery, message, images } = request.params;
        const binding = this.requireActive();
        const attachments = context !== undefined && context.type !== "session_switch" ? context.attachments : undefined;
        const inputKind = this.classifyInput(message);
        if (inputKind === "extension_command" && ((images?.length ?? 0) > 0 || (attachments?.length ?? 0) > 0)) {
          preflightResult?.({ success: false });
          throw new Error("Registered extension commands do not accept attachments");
        }
        if (inputKind === "extension_command") {
          // Report custody before the registered handler can suspend on a
          // long-lived Promise. Pi 0.99 would only queue a command sent while an
          // extension still handles agent_settled and return before it ran, so the
          // command starts after that boundary; the Host is not held meanwhile.
          preflightResult?.({ success: true, inputKind, delivery: "prompt", custody: "runtime" });
          await this.waitForSettledBoundary(binding);
          this.extensionCommandOperationId = operationId;
          try {
            await binding.session.prompt(message, { source: "rpc" } as PromptOptions);
            return null;
          } finally {
            if (this.extensionCommandOperationId === operationId) this.extensionCommandOperationId = undefined;
          }
        }
        // While Pi finishes a reply the Host still shows the Work as running, so
        // input is admitted as during the reply.
        const admissionRunning = context?.type === "defer_to_host" || this.isStreaming || piIsSettling(binding);
        const delivery = requestedDelivery === "auto" ? (admissionRunning ? "steer" : "prompt")
          : requestedDelivery === "followUp" && !admissionRunning ? "prompt" : requestedDelivery;
        const validatesRequestedDelivery = context?.type !== "force_queue" && context?.type !== "host_queue";
        const invalidDelivery = validatesRequestedDelivery && (
          (admissionRunning && delivery === "prompt")
          || (!admissionRunning && delivery !== "prompt")
        );
        if (invalidDelivery) {
          preflightResult?.({ success: false });
          throw new AgentInvalidDeliveryModeError(delivery, admissionRunning);
        }
        const queueAvailable = context?.type === "command" || context?.type === "defer_to_host"
          ? context.queueAvailable
          : true;
        if (validatesRequestedDelivery && delivery !== "prompt" && !queueAvailable) {
          preflightResult?.({ success: false });
          throw new AgentQueueRejectedBeforeEffectError();
        }
        if (context?.type === "defer_to_host") {
          if (delivery === "prompt") throw new Error("Host-deferred input requires queued delivery");
          preflightResult?.({ success: true, inputKind, delivery, custody: "host" });
          return null;
        }
        const hostQueued = context?.type === "force_queue" || context?.type === "host_queue";
        const attachmentImages = await resolveAttachmentImages(attachments, this.options.dockAttachmentPort);
        const runtimeImages = attachmentImages === undefined ? images : [...(images ?? []), ...attachmentImages];
        const visualContent = context?.type === "force_queue" ? undefined : await loadPiImages(runtimeImages);
        // Pi 0.99 holds input that arrives while an extension still handles
        // agent_settled and reports nothing about it until much later. Decide only
        // now, after every read above, and hand the input to Pi without waiting
        // in between: a reply can finish while attachments are being read.
        if ((context?.type === "command" || context?.type === "host_queue") && (piIsSettling(binding) || piIsFinishingStoppedStart(binding))) {
          // Like input during compaction, the Host keeps it in its Queue, where it
          // can be taken back, and hands it over once Pi publishes agent_settled.
          // A Host Queue hand-off goes back the same way: waiting here would make
          // Escape wait for the extension too.
          if (!queueAvailable) {
            preflightResult?.({ success: false });
            throw new AgentQueueRejectedBeforeEffectError();
          }
          preflightResult?.({ success: true, inputKind, delivery: delivery === "prompt" ? "steer" : delivery, custody: "host" });
          return null;
        }
        const runtimeMessage = attachments === undefined ? message : appendDockAttachmentContext(message, attachments, this.options.attachmentContextKey);
        const input = binding.conversation.trackInput({
          operationId,
          text: message,
          runtimeText: runtimeMessage,
          delivery,
          fromQueue: hostQueued || delivery !== "prompt",
          images,
          attachments,
        });
        const reportPreflight = (disposition: PiPromptDisposition): void => {
          // Pi 1.2+ counts the session as busy from the start of a run's preparation,
          // so a prompt that started its own run reports "started" while isStreaming is true.
          const actualDelivery = disposition === "started" ? "prompt" : binding.session.isStreaming ? delivery : "prompt";
          if (disposition === "handled") {
            // An extension input hook took the input over. It never becomes a Pi
            // message or queue item, so it must not claim the next run either.
            binding.conversation.cancelInput(input);
            preflightResult?.({ success: true, inputKind, delivery: actualDelivery, custody: "runtime", handled: true });
            return;
          }
          input.delivery = actualDelivery;
          input.fromQueue = hostQueued || actualDelivery !== "prompt";
          preflightResult?.({ success: true, inputKind, delivery: actualDelivery, custody: "runtime" });
        };
        try {
          if (context?.type === "force_queue") {
            if (delivery === "prompt") throw new Error("Forced Agent queue delivery requires steer or followUp");
            // Pi 0.99 runs input hooks before queueing, so an extension may take it over here too.
            const handled = await this.queueMessage(runtimeMessage, delivery, runtimeImages) === "handled";
            if (handled) binding.conversation.cancelInput(input);
            preflightResult?.({ success: true, inputKind, delivery, custody: "runtime", ...(handled ? { handled: true as const } : {}) });
            return null;
          }
          await binding.session.prompt(runtimeMessage, {
            source: "rpc",
            ...(delivery === "prompt" ? {} : { streamingBehavior: delivery }),
            ...(visualContent === undefined ? {} : { images: visualContent }),
            preflightResult: reportPreflight,
          } as PromptOptions);
          return null;
        } catch (error) {
          binding.conversation.cancelInput(input);
          throw error;
        }
      }
      case "command.abort": await this.abort(); return null;
      case "command.abort_restore_queue": return this.abortRestoringQueue();
      case "bash.run": return this.runBash(request.params.operationId, request.params.command, request.params.excludeFromContext);
      case "bash.abort": this.requireActive().session.abortBash(); return null;
      case "queue.dequeue": return this.clearQueue();
      case "model.list": return this.listModels();
      case "model.set": return this.selectModel(request.params.provider, request.params.modelId);
      case "thinking.set": return this.setThinkingLevel(request.params.level);
      case "tool.list": return this.listTools();
      case "tool.set_active": return this.setActiveTools(request.params.names);
      case "settings.get": return this.getSettings();
      case "settings.update": return this.updateSetting(request.params.update);
      case "resource.get": return this.getResources();
      case "command.catalog": return this.getCommands(request.params.prefix);
      case "command.content": return this.getCommandContent(request.params.command, request.params.cursor);
      case "command.complete": return this.getCommandCompletions(request.params.command, request.params.argumentPrefix);
      case "session.history": return this.getHistory();
      case "conversation.history": return this.getConversationHistory(request.params.cursor, request.params.limit, request.params.view);
      case "conversation.content": return this.getConversationContent(request.params.contentRef, request.params.cursor, request.params.view);
      case "conversation.image": return this.getConversationImage(request.params.contentRef);
      case "session.list": return this.listSessions(request.params.scope);
      case "session.switch": {
        if (context?.type !== "session_switch") throw new Error("Session switch requires resolved Host trust context");
        return this.switchSession(request.params.operationId, request.params.sessionFile, context);
      }
      case "session.new": return this.newSession(request.params.operationId, request.params.parentSession);
      case "session.name": return this.setSessionName(request.params.operationId, request.params.name);
      case "session.compact": return this.compact(request.params.operationId, request.params.customInstructions);
      case "session.compaction.prompts": return getCompactionPromptTemplates();
      case "session.reload": return this.reload(request.params.operationId);
      case "session.tree": return this.getTree();
      case "session.navigate": return this.navigateTree(request.params.targetId, {
        ...(request.params.summarize === undefined ? {} : { summarize: request.params.summarize }),
        ...(request.params.customInstructions === undefined ? {} : { customInstructions: request.params.customInstructions }),
        ...(request.params.replaceInstructions === undefined ? {} : { replaceInstructions: request.params.replaceInstructions }),
        ...(request.params.label === undefined ? {} : { label: request.params.label }),
      });
      case "session.fork": return this.fork(request.params.operationId, request.params.entryId, "before", "fork");
      case "session.clone": return this.fork(request.params.operationId, request.params.entryId, "at", "clone");
    }
  }

  /** A copy of this conversation so far, saved as a new session for a child working in `cwd`. */
  private branchForChild(cwd: string): { sessionFile: string } {
    const manager = this.requireActive().session.sessionManager;
    const file = manager.getSessionFile();
    if (!file || !existsSync(file)) throw new Error("This Work's conversation is not saved yet, so a child Work cannot start from it.");
    const forkPoint = childForkPoint(manager.getBranch());
    if (forkPoint === undefined) throw new Error("This Work has no conversation to give a child Work yet.");
    const sessionDir = this.options.sessionDir ?? SessionManager.create(cwd).getSessionDir();
    const sessionFile = SessionManager.open(file, sessionDir, cwd).createBranchedSession(forkPoint);
    if (!sessionFile || !existsSync(sessionFile)) throw new Error("The copy of this conversation for the child Work was not saved.");
    return { sessionFile };
  }

  async control(request: AgentWorkerControl): Promise<unknown> {
    switch (request.type) {
      case "activate": this.activateInitial(); return null;
      case "resolve_session_target": return this.resolveSessionTarget(request.sessionFile);
      case "resolve_file_source": {
        if (request.kind === "published") {
          const { dto: file, source } = this.options.publishedFiles.resolve(request.ref);
          return { kind: "published", file, source };
        }
        const resource = this.getDocumentResources().find((item) => item.contentRef === request.ref);
        if (!resource?.path) throw new ResourceContentError("这份资源已不在当前列表中。请返回项目状态重新选择。");
        return { kind: "resource", path: resource.path };
      }
      case "wait_for_idle": await this.waitForIdle(); return null;
      case "observation_delivery": throw new Error("Observation delivery must be handled by the Worker bridge");
      case "work_message": throw new Error("Work messages must be handled by the Worker bridge");
      case "branch_for_child": return this.branchForChild(request.cwd);
      case "dispose": return this.dispose();
    }
  }

  classifyInput(text: string): AgentInputKind {
    const commandName = extensionCommandName(text);
    if (commandName === undefined) return "prompt";
    return this.requireActive().session.extensionRunner.getCommand(commandName) === undefined
      ? "prompt"
      : "extension_command";
  }

  async prompt(text: string, options?: PiPromptOptions): Promise<void> {
    const { images, ...promptOptions } = options ?? {};
    const visualContent = await loadPiImages(images);
    await this.requireActive().session.prompt(text, {
      ...promptOptions,
      ...(visualContent === undefined ? {} : { images: visualContent }),
    });
  }

  /**
   * Pi 0.99 defers input that arrives while extensions still handle agent_settled:
   * prompt() then returns before reporting a disposition and runs the input later.
   * Only a registered extension command, whose custody is already reported, waits
   * here for Pi to publish agent_settled.
   */
  private async waitForSettledBoundary(binding: Binding): Promise<void> {
    while (piIsSettling(binding)) {
      await new Promise<void>((resolve) => binding.settledWaiters.push(resolve));
    }
    if (!binding.token.active) throw new Error("Pi session changed before this input could start");
  }

  /** Queue input in Pi; resolves with "handled" when an extension input hook took it over instead. */
  async queueMessage(text: string, delivery: "steer" | "followUp", images?: ImagePathDto[]): Promise<"handled" | "queued"> {
    let visualContent: PiImageContent[] | undefined;
    try { visualContent = await loadPiImages(images); }
    catch (error) { throw new AgentQueueRejectedBeforeEffectError(error); }
    const session = this.requireActive().session;
    const updateSequenceBefore = this.queueUpdateSequence;
    const queued = (): number => delivery === "steer" ? session.getSteeringMessages().length : session.getFollowUpMessages().length;
    const before = queued();
    try {
      return await (delivery === "steer" ? session.steer(text, visualContent) : session.followUp(text, visualContent));
    } catch (error) {
      // Pi 0.99 runs input hooks before it queues, so only a visible queue change
      // shows that the input may already be in Pi's custody.
      if (this.queueUpdateSequence === updateSequenceBefore && queued() <= before) throw new AgentQueueRejectedBeforeEffectError(error);
      throw new AgentQueueEffectUnknownError(error);
    }
  }

  async listModels(): Promise<AgentModelListBody> {
    const binding = this.requireActive();
    return {
      ...projectPiModelList(await binding.services.modelRuntime.getAvailable()),
      availableThinkingLevels: [...binding.session.getAvailableThinkingLevels()],
    };
  }

  async listTools(): Promise<AgentToolProjection> {
    const session = this.requireActive().session;
    return projectVisibleTools(session);
  }

  async setActiveTools(names: string[]): Promise<AgentToolProjection> {
    const session = this.requireActive().session;
    if (!Array.isArray(names) || names.length > MAX_PROJECTION_ITEMS) throw new Error("Active tool names must be a bounded array");
    const remaining = new Set<string>();
    for (const name of names) {
      if (typeof name !== "string" || name.length < 1 || name.length > 256) throw new Error("Active tool names must be bounded non-empty strings");
      if (remaining.has(name)) throw new Error(`Duplicate tool name: ${name}`);
      remaining.add(name);
    }
    for (const tool of session.getAllTools()) {
      const name = validCatalogName(tool.name);
      if (name !== undefined) remaining.delete(name);
      if (remaining.size === 0) break;
    }
    const unknown = remaining.values().next().value;
    if (unknown !== undefined) throw new AgentUnknownToolError(unknown);
    session.setActiveToolsByName([...names]);
    this.options.planGoalPort?.toolsChosen?.();
    return this.listTools();
  }

  async getSettings(): Promise<SettingDto[]> {
    const settings = this.requireActive().services.settingsManager;
    return projectPiSettings(settings);
  }

  async updateSetting(update: SettingUpdate): Promise<SettingDto> {
    assertPiSettingUpdate(update);
    const binding = this.requireActive();
    const key = update.key;
    this.assertCleanSettingsBaseline(binding, key);
    validatedPiSettingValue(binding.services.settingsManager, key);
    applyPiSetting(binding.session, binding.services.settingsManager, update);
    await this.persistSettings(binding, key);
    if (key === "transport") binding.session.agent.transport = update.value;
    if (key === "httpIdleTimeoutMs") this.options.configureNetwork?.(binding.services.settingsManager);
    return projectPiSetting(binding.services.settingsManager, key);
  }

  async getResources(): Promise<AgentResourceProjectionBody> {
    const binding = this.requireActive();
    const loader = binding.services.resourceLoader;
    const extensions = loader.getExtensions();
    const skills = loader.getSkills();
    const prompts = loader.getPrompts();
    const resources: ResourceDto[] = this.getDocumentResources();
    for (const extension of extensions.extensions) {
      const path = boundedString(extension.resolvedPath || extension.path, 16_384, "");
      resources.push({
        kind: "extension", name: boundedString(basename(extension.path || extension.resolvedPath), 256, "extension"),
        ...(path ? { path } : {}), source: projectSource(extension.sourceInfo, "extension"),
      });
    }
    const modelError = binding.services.modelRuntime.getError();
    const diagnostics: DiagnosticDto[] = [
      ...extensions.errors.map((failure) => ({ severity: "error" as const, message: safeRequiredText(failure.error, 2_048, "Extension load failure omitted"), source: boundedString(failure.path, 256, "extension") })),
      ...skills.diagnostics.map(projectDiagnostic),
      ...prompts.diagnostics.map(projectDiagnostic),
      ...(modelError ? [{ severity: "error" as const, message: safeRequiredText(modelError, 2_048, "Model configuration error omitted"), source: "models.json" }] : []),
    ];
    const sortedResources = resources.sort(compareResourceDtos);
    const sortedDiagnostics = diagnostics.sort(compareDiagnosticDtos);
    const projectedResources = capJsonItems(sortedResources, 350_000);
    const projectedDiagnostics = capJsonItems(sortedDiagnostics, 250_000);
    return {
      resources: projectedResources,
      diagnostics: projectedDiagnostics,
      resourceTotal: sortedResources.length,
      resourcesTruncated: projectedResources.length < sortedResources.length,
      diagnosticTotal: sortedDiagnostics.length,
      diagnosticsTruncated: projectedDiagnostics.length < sortedDiagnostics.length,
    };
  }

  private getDocumentResources(): ResourceDto[] {
    const loader = this.requireActive().services.resourceLoader;
    const resources: ResourceDto[] = [];
    const add = (kind: ResourceDto["kind"], name: string, filePath: string | undefined, source?: SourceDto) => {
      const path = exactOptionalText(filePath, MAX_SOURCE_FILE_PATH_CHARS);
      resources.push({
        kind, name: boundedString(name, 256, kind), ...(source ? { source } : {}),
        ...(path ? { path, contentRef: createHash("sha256").update(`${kind}\u0000${path}`).digest("hex") } : {}),
      });
    };
    for (const skill of loader.getSkills().skills) add("skill", skill.name, skill.filePath, projectSource(skill.sourceInfo, "skill"));
    for (const prompt of loader.getPrompts().prompts) add("prompt", prompt.name, prompt.filePath, projectSource(prompt.sourceInfo, "prompt"));
    const contextPaths = new Set(loader.getAgentsFiles().agentsFiles.map((context) => context.path));
    const system = loader.getSystemPromptSource();
    if (system) contextPaths.add(system.path);
    for (const append of loader.getAppendSystemPromptSources()) contextPaths.add(append.path);
    for (const path of contextPaths) add("context", basename(path), path);
    return resources;
  }

  async getCommands(prefix?: string): Promise<AgentCommandCatalogBody> {
    const binding = this.requireActive();
    const loader = binding.services.resourceLoader;
    const commands: CommandDto[] = [];
    const extensionCommands = binding.session.extensionRunner.getRegisteredCommands();
    for (const command of extensionCommands) {
      const name = validCatalogName(command.invocationName);
      if (name === undefined) continue;
      const description = safeOptionalText(command.description, 2_048);
      commands.push({
        name,
        ...(description === undefined ? {} : { description }),
        source: projectSource(command.sourceInfo, "extension"),
        argumentCompletions: typeof command.getArgumentCompletions === "function",
      });
    }
    for (const prompt of loader.getPrompts().prompts) {
      const name = validCatalogName(prompt.name);
      if (name === undefined) continue;
      const description = safeOptionalText(prompt.description, 2_048);
      const argumentHint = exactOptionalText(prompt.argumentHint, MAX_COMMAND_ARGUMENT_HINT_CHARS);
      commands.push({
        name,
        ...(description === undefined ? {} : { description }),
        ...(argumentHint === undefined ? {} : { argumentHint }),
        source: projectSource(prompt.sourceInfo, "prompt"),
        argumentCompletions: false,
        contentAvailable: true,
      });
    }
    if (validatedPiSettingValue(binding.services.settingsManager, "enableSkillCommands")) {
      for (const skill of loader.getSkills().skills) {
        const name = validCatalogName(`skill:${skill.name}`);
        if (name === undefined) continue;
        const description = safeOptionalText(skill.description, 2_048);
        commands.push({
          name,
          ...(description === undefined ? {} : { description }),
          source: projectSource(skill.sourceInfo, "skill"),
          argumentCompletions: false,
        });
      }
    }
    const filtered = commands.sort(compareCommandDtos)
      .filter((command) => prefix === undefined || command.name.startsWith(prefix));
    const projected = capJsonItems(filtered, 600_000);
    return { commands: projected, total: filtered.length, truncated: projected.length < filtered.length };
  }

  async getCommandContent(command: CommandReferenceDto, cursor?: string): Promise<AgentCommandContentBody> {
    const prompt = this.requireActive().services.resourceLoader.getPrompts().prompts.find((candidate) => {
      const name = validCatalogName(candidate.name);
      return name === command.name && compareSourceDtos(projectSource(candidate.sourceInfo, "prompt"), command.source) === 0;
    });
    if (prompt === undefined) return { command, available: false };
    const commandKey = JSON.stringify(command);
    const revision = createHash("sha256").update(commandKey).update("\u0000").update(prompt.content).digest("hex");
    let offset = 0;
    if (cursor !== undefined) {
      const continuation = this.commandContentCursors.get(cursor);
      if (!continuation || continuation.commandKey !== commandKey || continuation.revision !== revision) {
        throw new AgentConversationCursorError("This command content changed. Reopen it and try again.");
      }
      offset = continuation.offset;
    }
    const end = unicodeSafeEnd(prompt.content, Math.min(prompt.content.length, offset + MAX_COMMAND_CONTENT_PAGE_CHARS));
    const text = prompt.content.slice(offset, end);
    if (end >= prompt.content.length) {
      return { command, available: true, format: "markdown", revision, text, complete: true };
    }
    const nextCursor = randomUUID();
    this.commandContentCursors.set(nextCursor, { commandKey, revision, offset: end });
    trimTokenMap(this.commandContentCursors);
    return { command, available: true, format: "markdown", revision, text, complete: false, nextCursor };
  }

  async getCommandCompletions(command: CommandReferenceDto, argumentPrefix: string): Promise<AgentCommandCompletionsBody> {
    const registered = this.requireActive().session.extensionRunner.getRegisteredCommands().find((candidate) => {
      const name = validCatalogName(candidate.invocationName);
      return name === command.name && compareSourceDtos(projectSource(candidate.sourceInfo, "extension"), command.source) === 0;
    });
    if (registered?.getArgumentCompletions === undefined) return { command, items: null, total: 0, truncated: false };
    const raw = await registered.getArgumentCompletions(argumentPrefix);
    if (raw === null) return { command, items: null, total: 0, truncated: false };
    const items: CommandArgumentCompletionDto[] = raw.slice(0, MAX_COMMAND_ARGUMENT_COMPLETIONS).flatMap((candidate) => {
      const value = exactOptionalText(candidate.value, MAX_COMMAND_ARGUMENT_PREFIX_CHARS);
      if (value === undefined) return [];
      const label = safeRequiredText(candidate.label, MAX_COMMAND_COMPLETION_TEXT_CHARS, value);
      const description = safeOptionalText(candidate.description, MAX_COMMAND_COMPLETION_TEXT_CHARS);
      return [{ value, label, ...(description === undefined ? {} : { description }) }];
    });
    const projected = capJsonItems(items, 250_000);
    return { command, items: projected, total: raw.length, truncated: projected.length < raw.length };
  }

  async listSessions(scope: "cwd" | "all"): Promise<AgentSessionListBody> {
    const binding = this.requireActive();
    const manager = binding.session.sessionManager;
    const catalog = this.options.sessionCatalog ?? DEFAULT_SESSION_CATALOG;
    const source = scope === "cwd"
      ? await catalog.list(manager.getCwd(), manager.getSessionDir())
      : manager.usesDefaultSessionDir() ? await catalog.listAll() : await catalog.listAll(manager.getSessionDir());
    const sessions = source.map((info) => ({
      sessionId: boundedString(info.id, 128, "unknown"),
      sessionFile: boundedString(info.path, 16_384, ""),
      ...(info.name === undefined ? {} : { name: boundedString(info.name, 256, "") }),
      cwd: boundedString(info.cwd, 16_384, ""),
      ...(validDate(info.modified) ? { updatedAt: info.modified.toISOString() } : {}),
    }));
    const projected = capJsonItems(sessions, 600_000);
    return { sessions: projected, total: sessions.length, truncated: projected.length < sessions.length };
  }

  getHistory(): AgentHistoryEntry[] {
    return this.conversationReader.entries(this.requireActive().session.sessionManager);
  }

  async getConversationHistory(cursor?: string, limit?: number, view?: "references"): Promise<AgentConversationHistoryPage> {
    return this.conversationReader.history(this.requireActive().session.sessionManager, cursor, limit, view);
  }

  getConversationImage(contentRef: string): ConversationImageBody {
    return this.conversationReader.image(this.conversationSource(), contentRef);
  }

  async getConversationContent(contentRef: string, cursor?: string, view?: "references"): Promise<AgentConversationContentPage> {
    return this.conversationReader.content(this.conversationSource(), contentRef, cursor, view);
  }

  /**
   * The active session, for a read that may not need it: an image the registry still holds is
   * returned without one, so the lack of a session fails the read only when it asks for the session.
   */
  private conversationSource(): PiConversationSource {
    try {
      return this.requireActive().session.sessionManager;
    } catch (error) {
      const unavailable = (): never => { throw error; };
      return { getSessionId: unavailable, getLeafId: unavailable, getLeafEntry: unavailable, getBranch: unavailable };
    }
  }

  getTree(): SessionTreeResult {
    const manager = this.requireActive().session.sessionManager;
    const nodes: TreeNodeDto[] = [];
    const roots = manager.getTree();
    const toolCalls = collectTreeToolCalls(roots);
    const stack: Array<{ node: SessionTreeNode; parentId?: string; depth: number }> = [];
    for (let index = roots.length - 1; index >= 0; index -= 1) stack.push({ node: roots[index] as SessionTreeNode, depth: 0 });
    while (stack.length > 0) {
      const current = stack.pop() as { node: SessionTreeNode; parentId?: string; depth: number };
      projectTreeNode(current.node, current.parentId, current.depth, nodes, toolCalls, this.options.attachmentContextKey, (id) => manager.getEntry(id));
      for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: current.node.children[index] as SessionTreeNode, parentId: current.node.entry.id, depth: current.depth + 1 });
      }
    }
    const leafId = manager.getLeafId() ?? undefined;
    return parseSessionTreeResult({ nodes, ...(leafId === undefined ? {} : { leafId }) });
  }

  navigateTree(targetId: string, options: AgentNavigateOptions = {}): Promise<AgentNavigateResult> {
    if (this.treeNavigation) return Promise.reject(new Error("A session tree navigation is already active"));
    const navigation = this.serialize(async () => {
      const session = this.requireActive().session;
      if (!session.sessionManager.getEntry(targetId)) throw new AgentInvalidTreeTargetError("Navigation target does not belong to the current session tree");
      const result = await session.navigateTree(targetId, options);
      const leafId = session.sessionManager.getLeafId() ?? undefined;
      return {
        cancelled: result.cancelled,
        ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
        ...(result.editorText === undefined ? {} : { editorText: safeSelectedText(result.editorText) }),
        ...(result.cancelled || leafId === undefined ? {} : { leafId }),
        summaryCreated: result.summaryEntry !== undefined,
      };
    });
    const tracked = navigation.finally(() => {
      if (this.treeNavigation === tracked) this.treeNavigation = undefined;
    });
    this.treeNavigation = tracked;
    return tracked;
  }

  async selectModel(provider: string, modelId: string): Promise<AgentModelState> {
    const binding = this.requireActive();
    const model = binding.services.modelRuntime.getModel(provider, modelId);
    if (!model || !(await binding.services.modelRuntime.checkAuth(provider))) throw new AgentModelNotFoundError(provider, modelId);
    this.assertCleanSettingsBaseline(binding, "model");
    const previousThinking = binding.session.thinkingLevel;
    await binding.session.setModel(model, { preserveThinkingLevel: true });
    binding.services.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    this.saveChangedThinkingPreference(binding, previousThinking);
    await this.persistSettings(binding, "model");
    return this.getModelState();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<AgentModelState> {
    const binding = this.requireActive();
    this.assertCleanSettingsBaseline(binding, "thinking");
    const previousThinking = binding.session.thinkingLevel;
    binding.session.setThinkingLevel(level);
    this.saveChangedThinkingPreference(binding, previousThinking);
    await this.persistSettings(binding, "thinking");
    return this.getModelState();
  }

  getModelState(): AgentModelState {
    const session = this.requireActive().session;
    return {
      model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: [...session.getAvailableThinkingLevels()],
    };
  }

  getMetrics(): AgentSessionMetrics {
    const stats = this.requireActive().session.getSessionStats();
    return {
      messages: {
        user: stats.userMessages,
        assistant: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        total: stats.totalMessages,
      },
      tokens: { ...stats.tokens },
      cost: stats.cost,
      ...(stats.contextUsage === undefined ? {} : { context: { ...stats.contextUsage } }),
    };
  }

  clearQueue(): ClearedAgentQueue {
    const binding = this.requireActive();
    const cleared = binding.session.clearQueue();
    binding.conversation.clearQueuedInputs(cleared);
    return cleared;
  }
  /** Pi TUI's Escape: take the waiting Queue, then abort with no turn in between. */
  async abortRestoringQueue(): Promise<ClearedAgentQueue> {
    const cleared = this.clearQueue();
    await this.abort();
    return cleared;
  }
  async abort(): Promise<void> {
    this.options.planGoalPort?.cancelPending?.();
    const binding = this.active;
    if (!binding) return;
    const { session } = binding;
    const navigation = this.treeNavigation;
    if (navigation) {
      session.abortBranchSummary();
      await navigation.then(() => {}, (error) => { throw error; });
      return;
    }
    // Pi 0.99 runs automatic compaction inside the run. Its abort cancels the
    // compaction and also ends the run, so a queued message or an extension's
    // agent_before_settle continuation cannot call the model after this abort.
    // Cancelling only the compaction would let the run continue.
    const stopping = session.abort();
    if (piIsPreparing(binding)) {
      binding.stoppedBeforeStart = true;
      // Since Pi 1.2 a run is busy while extensions prepare it (before_agent_start),
      // and Pi's abort waits for them. The stop is already recorded: Pi stops the run
      // before its first request. Like Pi's own Esc, do not wait for the extensions.
      void stopping.catch(() => {});
      return;
    }
    await stopping;
  }
  waitForIdle(): Promise<void> { return this.active?.session.waitForIdle() ?? Promise.resolve(); }

  /**
   * Pi's `!` / `!!`: run one user shell command in the session cwd and record it as a
   * bash_execution entry. Same path as Pi's own TUI/RPC modes: extensions may intercept
   * through user_bash, execution streams through the session, and Pi decides whether
   * the record is appended now or held until the running agent turn ends.
   */
  async runBash(operationId: string, command: string, excludeFromContext: boolean): Promise<{ operationId: string; startedAt: string }> {
    const binding = this.requireActive();
    const { session } = binding;
    if (binding.runningBash.has(operationId) || binding.deferredBash.has(operationId)) {
      throw new Error("A shell command with this operation ID was already started");
    }
    let intercepted: UserBashEventResult | undefined;
    try {
      intercepted = await session.extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext, cwd: session.sessionManager.getCwd() });
    } catch (error) {
      throw new Error(`An extension rejected this shell command: ${boundedErrorMessage(error)}`);
    }
    if (this.active !== binding || !binding.token.active) throw new Error("Pi runtime is unavailable");
    const startedAt = new Date().toISOString();
    binding.runningBash.set(operationId, { command, excludeFromContext });
    this.publishFromBinding(binding, bashFrame({ type: "bash.started", data: { operationId, command, excludeFromContext } }));
    const task = this.completeBash(binding, operationId, command, excludeFromContext, intercepted);
    binding.bashTasks.add(task);
    void task.finally(() => binding.bashTasks.delete(task));
    return { operationId, startedAt };
  }

  /** A reload keeps the session, and with it any running command, but the Host starts a
   * new generation whose live view knows nothing about them: announce them again. */
  private announceRunningBash(binding: Binding): void {
    for (const [operationId, { command, excludeFromContext }] of binding.runningBash) {
      this.publishFromBinding(binding, bashFrame({ type: "bash.started", data: { operationId, command, excludeFromContext } }));
    }
  }

  /** Give Pi the moment it needs to record cancelled commands before the Worker exits. */
  private async settleRunningBash(tasks: readonly Promise<void>[]): Promise<void> {
    if (tasks.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, BASH_RECORD_SETTLE_MS); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async completeBash(binding: Binding, operationId: string, command: string, excludeFromContext: boolean, intercepted: UserBashEventResult | undefined): Promise<void> {
    const { session } = binding;
    let completion: AgentEvent;
    try {
      let result: PiBashResult;
      if (intercepted?.result) {
        result = intercepted.result;
        for (const frame of bashOutputFrames(operationId, result.output)) this.publishFromBinding(binding, frame);
        session.recordBashResult(command, result, { excludeFromContext });
      } else {
        result = await session.executeBash(command, undefined, {
          excludeFromContext,
          id: operationId,
          ...(intercepted?.operations === undefined ? {} : { operations: intercepted.operations }),
        });
      }
      completion = bashFrame({ type: "bash.completed", data: {
        operationId,
        ...(typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
        cancelled: result.cancelled === true,
        truncated: result.truncated === true,
        ...(typeof result.fullOutputPath === "string" && result.fullOutputPath.length > 0 ? { fullOutputPath: boundedString(result.fullOutputPath, 16_384, "") } : {}),
      } });
    } catch (error) {
      completion = bashFrame({ type: "bash.completed", data: { operationId, cancelled: false, truncated: false, error: boundedErrorMessage(error) } });
    }
    binding.runningBash.delete(operationId);
    if (!binding.token.active) return; // Pi already cancelled it while replacing the session; the old session keeps the record.
    // Pi records immediately when idle, otherwise it holds the entry until the run ends.
    if (session.hasPendingBashMessages) binding.deferredBash.add(operationId);
    this.publishFromBinding(binding, completion);
    // An idle session appends the record without any event of its own, so publish the boundary here.
    if (!session.isStreaming) this.publishFromBinding(binding, this.checkpoint(binding));
  }

  private checkpoint(binding: Binding): AgentEvent {
    if (!binding.session.hasPendingBashMessages) binding.deferredBash.clear();
    const unpersistedBash = [...binding.runningBash.keys(), ...binding.deferredBash];
    return {
      type: "conversation_checkpoint",
      history: this.conversationReader.entries(binding.session.sessionManager),
      ...(unpersistedBash.length === 0 ? {} : { unpersistedBash }),
    };
  }

  private publishFromBinding(binding: Binding, event: AgentEvent): void {
    if (this.active === binding && !binding.bufferEvents) this.publish(event);
    else binding.buffered.push(event);
  }

  async resolveSessionTarget(path: string): Promise<AgentSessionTarget> {
    const manager = SessionManager.open(path);
    return { canonicalCwd: await realpath(resolve(manager.getCwd())) };
  }

  newSession(operationId: string, parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.serialize(() => this.replace(
      operationId,
      "new",
      () => this.options.runtime.newSession(parentSession === undefined ? undefined : { parentSession }),
    ));
  }

  switchSession(
    operationId: string,
    path: string,
    trust: { canonicalCwd: string; projectTrusted: boolean },
  ): Promise<{ cancelled: boolean }> {
    return this.serialize(() => {
      this.options.setProjectTrust?.(trust.canonicalCwd, trust.projectTrusted);
      return this.replace(
        operationId,
        "switch",
        () => this.options.runtime.switchSession(path),
        trust.canonicalCwd,
      );
    });
  }

  fork(
    operationId: string,
    entryId: string,
    position: "before" | "at",
    kind: "fork" | "clone",
  ): Promise<AgentForkResult> {
    return this.serialize(() => {
      const binding = this.requireActive();
      if (position === "before") {
        const selected = binding.session.getUserMessagesForForking().find((entry) => entry.entryId === entryId);
        if (!selected) throw new AgentInvalidTreeTargetError("Fork target must be a user message in the current session tree");
        safeSelectedText(selected.text);
      } else if (!binding.session.sessionManager.getEntry(entryId)) {
        throw new AgentInvalidTreeTargetError("Clone entry does not belong to the current session tree");
      }
      return this.replace(operationId, kind, async () => {
        const result = await this.options.runtime.fork(entryId, { position });
        if (result.cancelled) return { cancelled: true };
        const selectedText = result.selectedText === undefined ? undefined : safeSelectedText(result.selectedText);
        if (kind === "fork" && selectedText === undefined) throw new Error("Pi completed fork-before without selected editor text");
        return { cancelled: false, ...(selectedText === undefined ? {} : { selectedText }) };
      });
    });
  }

  setSessionName(operationId: string, name: string): string | undefined {
    const session = this.requireActive().session;
    this.sessionNameOperationId = operationId;
    try {
      session.setSessionName(name);
      return session.sessionManager.getSessionName();
    } finally {
      if (this.sessionNameOperationId === operationId) this.sessionNameOperationId = undefined;
    }
  }

  compact(operationId: string, customInstructions?: string): Promise<AgentCompactionResult> {
    return this.serialize(async () => {
      const session = this.requireActive().session;
      const previousCompactionIds = new Set(
        session.sessionManager.getEntries()
          .filter((entry) => entry.type === "compaction")
          .map((entry) => entry.id),
      );
      this.manualCompactionOperationId = operationId;
      try {
        const result = await session.compact(customInstructions);
        return {
          summary: boundedString(result.summary, MAX_TEXT_CHARS, ""),
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
        };
      } catch (error) {
        const appended = session.sessionManager.getEntries()
          .some((entry) => entry.type === "compaction" && !previousCompactionIds.has(entry.id));
        if (appended) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const reason = error instanceof Error && error.name === "AbortError" ? "cancelled" : compactionFailureReason(message);
        throw new AgentCompactionKnownFailureError(reason, message);
      } finally {
        if (this.manualCompactionOperationId === operationId) this.manualCompactionOperationId = undefined;
      }
    });
  }

  reload(operationId: string): Promise<{ cancelled: false }> {
    return this.serialize(async () => {
      const previousSessionFile = this.sessionFile;
      const binding = this.requireActive();
      const buffered: AgentEvent[] = [];
      const originalBuffer = binding.buffered;
      binding.buffered = buffered;
      binding.bufferEvents = true;
      await this.options.extensionUiBroker?.beginGenerationChange("reload");
      try {
        let seamCalls = 0;
        await binding.session.reload({
          beforeSessionStart: async () => {
            seamCalls += 1;
            // Extension providers have been re-registered by this point, so
            // refresh models only now rather than against the old runner.
            await refreshSessionModels(binding.session, binding.services);
            syncAgentRuntimeSettings(binding.session, binding.services.settingsManager);
            this.options.configureNetwork?.(binding.services.settingsManager);
          },
        });
        if (seamCalls !== 1) throw new Error(`Reload rebind seam ran ${seamCalls} times`);
        await this.options.commitReplacement?.({ operationId, kind: "reload", previousSessionFile, sessionFile: binding.session.sessionFile });
        binding.bufferEvents = false;
        this.publishReplacement(operationId, "reload", previousSessionFile, binding.session.sessionFile);
        this.announceRunningBash(binding);
        await this.options.extensionUiBroker?.completeGenerationChange();
        this.publishReplacementBuffer(buffered);
        return { cancelled: false };
      } catch (error) {
        binding.token.active = false;
        releaseSettledWaiters(binding);
        binding.unsubscribe();
        binding.gitBranchObserver?.dispose();
        this.active = undefined;
        await this.disposeRuntimeOnce().catch(() => {});
        this.unavailable = true;
        await this.options.extensionUiBroker?.failGenerationChange();
        await this.commitRuntimeError(operationId, "reload", error, previousSessionFile);
        throw error;
      } finally {
        binding.bufferEvents = false;
        binding.buffered = originalBuffer;
      }
    });
  }

  dispose(): Promise<AgentCleanupResult> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      if (this.disposed) return { cleanupErrors: [] };
      const cleanupErrors: string[] = [];
      const captureCleanupError = (stage: string, error: unknown): void => {
        cleanupErrors.push(safeRequiredText(`${stage}: ${boundedErrorMessage(error)}`, MAX_STOP_CLEANUP_ERROR_CHARS, `${stage} cleanup failed`));
      };
      try { this.clearQueue(); } catch (error) { captureCleanupError("clearQueue", error); }
      this.disposed = true;
      try {
        await this.abort().catch((error: unknown) => { captureCleanupError("abort", error); });
        await this.mutationTail.catch(() => {});
        const runningBash = [...(this.active?.bashTasks ?? [])];
        await this.disposeRuntimeOnce();
        await this.settleRunningBash(runningBash);
        return { cleanupErrors };
      } finally {
        this.invalidateBindingsSynchronously();
        this.subscribers.clear();
      }
    })();
    return this.disposePromise;
  }

  private async replace<T extends { cancelled: boolean }>(
    operationId: string,
    kind: "new" | "switch" | "fork" | "clone",
    operation: () => Promise<T>,
    constructionCwd?: string,
  ): Promise<T> {
    const previousSessionFile = this.sessionFile;
    const previousProcessCwd = this.processCwdValue;
    this.rebindEntered = false;
    this.replacementInvalidated = false;
    this.replacementRunning = true;
    try {
      if (constructionCwd !== undefined) {
        this.options.setProcessCwd?.(constructionCwd);
        this.processCwdValue = constructionCwd;
      }
      const result = await operation();
      if (result.cancelled) {
        if (this.rebindEntered || this.replacementInvalidated || !this.active) {
          throw new Error("Cancelled replacement changed the active runtime binding");
        }
        this.restoreProcessCwd(previousProcessCwd);
        return result;
      }
      if (!this.rebindEntered || !this.staged) throw new Error("Runtime replacement completed without exactly one rebind");
      await this.options.commitReplacement?.({ operationId, kind, previousSessionFile, sessionFile: this.staged.session.sessionFile });
      await this.promoteStaged(operationId, kind, previousSessionFile);
      return result;
    } catch (error) {
      if (!this.replacementInvalidated) {
        this.restoreProcessCwd(previousProcessCwd);
        throw error;
      }
      if (this.rebindEntered) await this.disposeRuntimeOnce().catch(() => {});
      else this.runtimeDisposed = true; // SDK already disposed the old session before factory failure.
      this.invalidateBindingsSynchronously();
      this.unavailable = true;
      await this.options.extensionUiBroker?.failGenerationChange();
      await this.commitRuntimeError(operationId, kind, error, previousSessionFile);
      throw error;
    } finally {
      this.replacementRunning = false;
    }
  }

  private restoreProcessCwd(previousProcessCwd: string | undefined): void {
    if (previousProcessCwd === undefined || previousProcessCwd === this.processCwdValue) return;
    this.options.setProcessCwd?.(previousProcessCwd);
    this.processCwdValue = previousProcessCwd;
  }

  private async commitRuntimeError(operationId: string, kind: ReplacementKind, error: unknown, recoverySessionFile?: string): Promise<void> {
    await this.options.commitRuntimeError?.({ operationId, kind, error, recoverySessionFile });
    this.publish({ type: "dock_runtime_error", operationId, kind, error: boundedErrorMessage(error), recoverySessionFile });
  }

  private async disposeRuntimeOnce(): Promise<void> {
    if (this.runtimeDisposed) return;
    this.runtimeDisposed = true;
    await this.options.runtime.dispose();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(() => {
      if (this.disposed || this.unavailable) throw new Error("Pi runtime is unavailable");
      return operation();
    });
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }

  private async stageCandidate(session: AgentSession): Promise<void> {
    if (this.staged) throw new Error("Runtime attempted more than one candidate rebind");
    const token = { active: true };
    const binding: Binding = {
      token,
      session,
      services: this.options.runtime.services,
      cwd: this.options.runtime.services.cwd,
      unsubscribe: () => {},
      buffered: [],
      bufferEvents: true,
      conversation: new PiConversationProjector(this.options.attachmentContextKey),
      awaitingSettled: false,
      stoppedBeforeStart: false,
      settledWaiters: [],
      runningBash: new Map(),
      bashTasks: new Set(),
      deferredBash: new Set(),
    };
    binding.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (!token.active) return;
      if (event.type === "agent_start") binding.awaitingSettled = true;
      if (event.type === "bash_execution_update") {
        // Only commands started through bash.run carry an id; output arrives as conversation frames.
        if (typeof event.id === "string" && binding.runningBash.has(event.id) && typeof event.delta === "string") {
          for (const frame of bashOutputFrames(event.id, event.delta)) this.publishFromBinding(binding, frame);
        }
        return;
      }
      if (event.type === "queue_update") binding.conversation.observeQueueUpdate(event.steering, event.followUp);
      const projectedEvents = projectAgentSessionEvents(event, this.options.publishedFiles)
        .map((projected) => this.attributeLifecycleEvent(binding, projected));
      const source = event as unknown as Record<string, unknown>;
      const message = isRecord(source.message) ? source.message : undefined;
      if (source.type === "message_end" && message?.role === "custom" && !session.isStreaming) {
        projectedEvents.push({ type: "conversation_checkpoint" });
      }
      for (const projected of projectedEvents.flatMap((item) => binding.conversation.project(item))) {
        const outbound = projected.type === "conversation_checkpoint" ? this.checkpoint(binding) : projected;
        this.publishFromBinding(binding, outbound);
      }
      if (event.type === "agent_settled") {
        binding.runOperationId = undefined;
        binding.awaitingSettled = false;
        binding.stoppedBeforeStart = false;
        releaseSettledWaiters(binding);
      }
    });
    this.staged = binding;
    const previousProcessCwd = this.processCwdValue;
    try {
      this.options.setProcessCwd?.(binding.cwd);
      this.processCwdValue = binding.cwd;
      const uiContext = this.options.uiContextFactory?.() ?? this.options.uiContext;
      await session.bindExtensions({
        uiContext: uiContext && {
          ...uiContext,
          // Pi's tracked editor wrapper accepts only two arguments. Attach the
          // current run's public signal here, after that wrapper, for Dock UI.
          editor: (title, prefill) => (uiContext.editor as PiExtensionUiPort["editor"])(title, prefill, { signal: session.agent.signal }),
        },
        mode: uiContext ? "rpc" : "print",
        commandContextActions: this.extensionCommandContextActions(session, binding.services),
        onError: (error) => {
          if (!token.active) return;
          const event = { type: "dock_extension_error", error: boundedErrorMessage(error) };
          if (this.active === binding && !binding.bufferEvents) this.publish(event); else binding.buffered.push(event);
        },
      });
      const publishBranch = (branch: string | undefined): void => {
        if (!token.active) return;
        const event: AgentEvent = { type: "dock_git_branch_changed", branch };
        if (this.active === binding && !binding.bufferEvents) this.publish(event); else binding.buffered.push(event);
      };
      binding.gitBranchObserver = await (this.options.gitBranchObserverFactory
        ? this.options.gitBranchObserverFactory(binding.cwd, publishBranch)
        : GitBranchObserver.create(binding.cwd, publishBranch));
    } catch (error) {
      token.active = false;
      releaseSettledWaiters(binding);
      binding.unsubscribe();
      binding.gitBranchObserver?.dispose();
      if (this.staged === binding) this.staged = undefined;
      if (previousProcessCwd !== undefined) {
        try { this.options.setProcessCwd?.(previousProcessCwd); this.processCwdValue = previousProcessCwd; }
        catch { /* Runtime replacement will fail closed and dispose this Worker. */ }
      }
      throw error;
    }
  }

  private extensionCommandContextActions(session: AgentSession, services: AgentSessionServices): ExtensionCommandContextActions {
    const unavailable = async (): Promise<never> => {
      throw new Error("This extension session-management action is unavailable through Dock");
    };
    return {
      waitForIdle: () => session.waitForIdle(),
      newSession: unavailable,
      fork: unavailable,
      navigateTree: unavailable,
      switchSession: unavailable,
      reload: async () => {
        await this.options.extensionUiBroker?.beginGenerationChange("reload");
        try {
          await session.reload({
            beforeSessionStart: async () => {
              await refreshSessionModels(session, services);
              syncAgentRuntimeSettings(session, services.settingsManager);
              this.options.configureNetwork?.(services.settingsManager);
            },
          });
          await this.options.extensionUiBroker?.completeGenerationChange();
        } catch (error) {
          await this.options.extensionUiBroker?.failGenerationChange();
          throw error;
        }
      },
    };
  }

  private promoteInitial(): void {
    const binding = this.staged;
    if (!binding) throw new Error("Initial runtime binding was not staged");
    this.staged = undefined;
    this.active = binding;
    // Keep startup events buffered until createPiInstance constructs ManagedInstance
    // and explicitly activates the initial binding.
  }

  private async promoteStaged(operationId: string, kind: "new" | "switch" | "fork" | "clone", previousSessionFile?: string): Promise<void> {
    const binding = this.staged;
    if (!binding) throw new Error("Replacement runtime binding was not staged");
    this.staged = undefined;
    this.active = binding;
    const events = binding.buffered;
    binding.buffered = [];
    binding.bufferEvents = false;
    this.publishReplacement(operationId, kind, previousSessionFile, binding.session.sessionFile);
    await this.options.extensionUiBroker?.completeGenerationChange();
    this.publishReplacementBuffer(events);
  }

  private publishReplacementBuffer(events: readonly AgentEvent[]): void {
    for (const event of events) {
      // The replacement event already carries the observer's latest cache.
      // Replaying intermediate branch invalidations could regress the new generation.
      if (event.type !== "dock_git_branch_changed") this.publish(event);
    }
  }

  private publishReplacement(operationId: string, kind: ReplacementKind, previousSessionFile?: string, sessionFile?: string): void {
    this.publish({
      type: "dock_session_replaced",
      operationId,
      reason: kind === "switch" ? "resume" : kind === "clone" ? "fork" : kind,
      previousSessionFile,
      sessionFile,
      cwd: this.active?.cwd,
      name: this.active?.session.sessionManager.getSessionName(),
      gitBranch: this.active?.gitBranchObserver?.branch,
    });
  }

  private attributeLifecycleEvent(binding: Binding, event: AgentEvent): AgentEvent {
    if (event.type === "agent_start") {
      const operationId = binding.conversation.nextInputOperationId() ?? this.extensionCommandOperationId;
      binding.runOperationId = operationId;
      return operationId === undefined ? event : { ...event, operationId };
    }
    if (event.type === "agent_settled") {
      return binding.runOperationId === undefined ? event : { ...event, operationId: binding.runOperationId };
    }
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      const operationId = this.manualCompactionOperationId ?? binding.runOperationId ?? this.extensionCommandOperationId;
      return operationId === undefined ? event : { ...event, operationId };
    }
    if (event.type === "session_info_changed" && this.sessionNameOperationId !== undefined) {
      return { ...event, operationId: this.sessionNameOperationId };
    }
    return event;
  }

  private invalidateBindingsSynchronously(): void {
    this.options.publishedFiles.clear();
    this.conversationReader.invalidate();
    this.commandContentCursors.clear();
    for (const binding of [this.active, this.staged]) {
      if (!binding) continue;
      binding.token.active = false;
      releaseSettledWaiters(binding);
      binding.unsubscribe();
      binding.gitBranchObserver?.dispose();
    }
    this.active = undefined;
    this.staged = undefined;
  }

  private publish(event: AgentEvent): void {
    if (event.type === "queue_update") this.queueUpdateSequence += 1;
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch { /* isolate Host observers from Pi callbacks */ }
    }
  }

  private requireActive(): Binding {
    if (!this.active || this.disposed || this.unavailable) throw new Error("Pi runtime is unavailable");
    return this.active;
  }

  private assertCleanSettingsBaseline(binding: Binding, setting: SettingKey | "model" | "thinking"): void {
    const failures = projectSettingsErrors(binding.services.settingsManager.drainErrors());
    if (failures.length > 0) throw new AgentSettingsWriteError(setting, "baseline", false, failures);
  }

  private saveChangedThinkingPreference(binding: Binding, previous: ThinkingLevel): void {
    const { session, services } = binding;
    const effective = session.thinkingLevel;
    // Dock saves the effective choice, without erasing the preference on non-reasoning models.
    if (effective !== previous && (session.supportsThinking() || effective !== "off")) {
      services.settingsManager.setDefaultThinkingLevel(effective);
    }
  }

  private async persistSettings(binding: Binding, setting: SettingKey | "model" | "thinking"): Promise<void> {
    const failures: Array<{ scope: "global" | "project" | "unknown"; message: string }> = [];
    try { await binding.services.settingsManager.flush(); }
    catch (error) { failures.push({ scope: "unknown", message: boundedErrorMessage(error) }); }
    failures.push(...projectSettingsErrors(binding.services.settingsManager.drainErrors()));
    if (failures.length > 0) throw new AgentSettingsWriteError(setting, "write", true, failures);
  }
}

const MAX_PROJECTION_ITEMS = 2_000;
const MAX_TOOL_PROJECTION_BYTES = 600_000;

function exactOptionalText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

function releaseSettledWaiters(binding: Binding): void {
  for (const resolve of binding.settledWaiters.splice(0)) resolve();
}

/** Pi counts a run as busy from the start of its preparation; agent_start follows the preparation. */
function piIsPreparing(binding: Binding): boolean {
  return binding.token.active && binding.session.isStreaming && !binding.awaitingSettled;
}

/**
 * A run stopped during its preparation still runs until its extensions return; input given
 * to Pi meanwhile would join that stopped run and never be answered. The Host keeps it
 * instead, like input during agent_settled, and hands it over once Pi publishes agent_settled.
 */
function piIsFinishingStoppedStart(binding: Binding): boolean {
  return binding.token.active && binding.stoppedBeforeStart && binding.session.isStreaming;
}

/** Pi finished the run and extensions still handle agent_settled; it defers new input until then. */
function piIsSettling(binding: Binding): boolean {
  return binding.token.active && binding.awaitingSettled && !binding.session.isStreaming;
}

function bashFrame(frame: ConversationFrame): AgentEvent {
  return { type: "dock_conversation_frame", frame };
}

/** Shell output is split like assistant deltas so one frame never exceeds the event text bound. */
function bashOutputFrames(operationId: string, output: string): AgentEvent[] {
  const frames: AgentEvent[] = [];
  let offset = 0;
  while (offset < output.length) {
    const end = unicodeSafeEnd(output, Math.min(output.length, offset + MAX_TEXT_CHARS));
    frames.push(bashFrame({ type: "bash.output", data: { operationId, delta: output.slice(offset, end) } }));
    offset = end;
  }
  return frames;
}

interface TreeToolCall { name: string; arguments: Record<string, unknown> }

function collectTreeToolCalls(roots: readonly SessionTreeNode[]): Map<string, TreeToolCall> {
  const calls = new Map<string, TreeToolCall>();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop() as SessionTreeNode;
    const entry = node.entry;
    if (entry.type === "message") {
      const message = entry.message as unknown as Record<string, unknown>;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
          const block = item as Record<string, unknown>;
          if ((block.type === "toolCall" || block.type === "tool_call") && typeof block.id === "string" && typeof block.name === "string") {
            calls.set(block.id, { name: treeLine(block.name, 256, "tool"), arguments: isRecord(block.arguments) ? block.arguments : {} });
          }
        }
      }
    }
    for (const child of node.children) stack.push(child);
  }
  return calls;
}

function projectTreeNode(
  node: SessionTreeNode,
  parentId: string | undefined,
  depth: number,
  output: TreeNodeDto[],
  toolCalls: ReadonlyMap<string, TreeToolCall>,
  attachmentContextKey: Uint8Array,
  entryById: (id: string) => SessionEntry | undefined,
): void {
  const entry = node.entry;
  // Pi 0.99 usage and context-edit records have no Protocol V2 tree kind; they are metadata nodes.
  const kind: TreeNodeDto["kind"] = TREE_NODE_KINDS.has(entry.type) ? entry.type as TreeNodeDto["kind"] : "custom";
  const message = entry.type === "message" ? entry.message as unknown as Record<string, unknown> : undefined;
  const role = message === undefined ? undefined : treeMessageRole(message.role);
  const state = message === undefined ? undefined : treeMessageState(message);
  const displayClass = treeDisplayClass(entry, role, state);
  output.push({
    entryId: entry.id,
    ...(parentId === undefined ? {} : { parentId }),
    depth,
    kind,
    ...(role === undefined ? {} : { role }),
    displayClass,
    ...(state === undefined ? {} : { state }),
    ...(node.label === undefined ? {} : { label: treeLine(node.label, 256, "Session label omitted") }),
    timestamp: entry.timestamp,
    summary: projectTreeSummary(entry, toolCalls, attachmentContextKey, entryById),
    hasChildren: node.children.length > 0,
  });
}

function projectTreeSummary(
  entry: SessionEntry,
  toolCalls: ReadonlyMap<string, TreeToolCall>,
  attachmentContextKey: Uint8Array,
  entryById: (id: string) => SessionEntry | undefined = () => undefined,
): string {
  switch (entry.type) {
    case "message": {
      const message = entry.message as unknown as Record<string, unknown>;
      if (message.role === "bashExecution") {
        return treeLine(message.command, 2_048, "Shell execution");
      }
      if (message.role === "toolResult" || message.role === "tool") {
        const call = typeof message.toolCallId === "string" ? toolCalls.get(message.toolCallId) : undefined;
        const name = call?.name ?? treeLine(message.toolName, 256, "tool");
        return call === undefined ? `Tool: ${name}` : formatTreeToolCall(name, call.arguments);
      }
      if (message.role === "assistant" && typeof message.errorMessage === "string") {
        return treeLine(message.errorMessage, 2_048, "Assistant error");
      }
      if (message.role === "assistant" && message.stopReason === "aborted") return "(aborted)";
      if (message.role === "system") return treeLine(systemPromptChangeText(projectSystemPromptChange(message)), 2_048, "System prompt update");
      const summaryText = contentText(message.content);
      return treeLine(message.role === "user" && summaryText !== undefined ? extractDockAttachmentContext(summaryText, attachmentContextKey).text : summaryText, 2_048, `${treeMessageRole(message.role)} message`);
    }
    case "thinking_level_change": return treeLine(`Thinking level: ${entry.thinkingLevel}`, 2_048, "Thinking level change");
    case "model_change": return treeLine(`Model: ${entry.provider}/${entry.modelId}`, 2_048, "Model change");
    case "compaction": return `[compaction: ${Math.round(entry.tokensBefore / 1_000)}k tokens]`;
    case "branch_summary": return treeLine(`[branch summary]: ${entry.summary}`, 2_048, "[branch summary]");
    case "custom": return treeLine(`Custom entry: ${entry.customType}`, 2_048, "Custom entry");
    case "custom_message": return treeLine(contentText(entry.content), 2_048, `Custom message: ${entry.customType}`);
    case "label": return treeLine(entry.label ? `Label ${entry.targetId}: ${entry.label}` : `Label cleared: ${entry.targetId}`, 2_048, "Label change");
    case "session_info": return treeLine(entry.name ? `Session name: ${entry.name}` : "Session name cleared", 2_048, "Session info");
    case "usage": return treeLine(usageRecordText(projectRecordUsage(entry), entry.provider, entry.model), 2_048, "Usage");
    case "context_edit": {
      // The edited record is an earlier entry on the same branch; describe it the way the tree does.
      const target = entryById(entry.targetId);
      const described = target === undefined ? "an earlier record" : projectTreeSummary(target, toolCalls, attachmentContextKey);
      return treeLine(`${entry.replacement === null ? "Removed from" : "Replaced in"} model context: ${described}`, 2_048, "Model context edit");
    }
  }
}

const TREE_NODE_KINDS: ReadonlySet<string> = new Set<TreeNodeDto["kind"]>(["message", "thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);

function treeMessageRole(value: unknown): "user" | "assistant" | "tool" | "system" {
  if (value === "user" || value === "assistant") return value;
  if (value === "tool" || value === "toolResult") return "tool";
  return "system";
}

function treeMessageState(message: Record<string, unknown>): TreeNodeDto["state"] {
  if (message.role === "assistant") {
    if (message.stopReason === "aborted") return "aborted";
    if (message.stopReason === "error" || typeof message.errorMessage === "string") return "error";
  }
  if ((message.role === "tool" || message.role === "toolResult") && message.isError === true) return "error";
  return undefined;
}

function treeDisplayClass(
  entry: SessionEntry,
  role: TreeNodeDto["role"],
  state: TreeNodeDto["state"],
): TreeNodeDto["displayClass"] {
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    if (role === "tool") return "tool";
    if (message.role === "system") return "metadata";
    if (role === "assistant" && state === undefined && !hasTreeText(message.content) && hasTreeToolCall(message.content)) return "structural";
    return "content";
  }
  if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message") return "content";
  return "metadata";
}

function hasTreeText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.some((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
  });
}

function hasTreeToolCall(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const type = (item as Record<string, unknown>).type;
    return type === "toolCall" || type === "tool_call";
  });
}

function formatTreeToolCall(name: string, args: Record<string, unknown>): string {
  const normalizedName = name.toLowerCase().split(/[.:/]/u).at(-1) ?? name.toLowerCase();
  const path = treeStringArg(args, ["path", "file_path", "output_path"]);
  let detail: string | undefined;
  if (normalizedName === "read") {
    const offset = treeIntegerArg(args.offset);
    const limit = treeIntegerArg(args.limit);
    const range = offset === undefined ? undefined
      : limit === undefined ? `from line ${offset}` : `lines ${offset}-${offset + Math.max(0, limit - 1)}`;
    detail = treeJoin([path && treePathPreview(path), range]);
  } else if (normalizedName === "write") {
    detail = path && treePathPreview(path);
  } else if (normalizedName === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits.length
      : typeof args.oldText === "string" || typeof args.newText === "string" ? 1 : undefined;
    detail = treeJoin([path && treePathPreview(path), edits === undefined ? undefined : `${edits} ${edits === 1 ? "edit" : "edits"}`]);
  } else if (normalizedName === "bash") {
    detail = treeCommandPreview(treeStringArg(args, ["command"]));
  } else if (normalizedName === "grep") {
    detail = treeJoin([treeStringArg(args, ["pattern"]), path && `in ${treePathPreview(path)}`]);
  } else if (normalizedName === "find") {
    detail = treeJoin([treeStringArg(args, ["pattern"]), path && `in ${treePathPreview(path)}`]);
  } else if (normalizedName === "ls") {
    detail = path && treePathPreview(path);
  } else {
    const action = treeStringArg(args, ["action"]);
    const cardId = treeScalarArg(args.card_id ?? args.cardId);
    const query = treeStringArg(args, ["query", "pattern"]);
    const target = treeStringArg(args, ["target_id", "instance_id", "instanceId"]);
    detail = treeJoin([
      path && treePathPreview(path),
      action,
      cardId && `card #${cardId}`,
      query && `query: ${query}`,
      target && `target ${target}`,
    ]);
  }
  return treeLine(`[${name}${detail ? `: ${detail}` : ""}]`, 2_048, `[${name}]`);
}

function treeStringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function treeScalarArg(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function treeIntegerArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function treeJoin(parts: Array<string | undefined | false>): string | undefined {
  const values = parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.replace(/[\t\r\n]+/gu, " ").replace(/\s+/gu, " ").trim());
  return values.length === 0 ? undefined : values.slice(0, 4).join(" · ");
}

function treePathPreview(value: string): string {
  const normalized = value.replace(/[\t\r\n]+/gu, " ").trim();
  const home = process.env.HOME;
  const shortened = home && normalized.startsWith(home) ? `~${normalized.slice(home.length)}` : normalized;
  const parts = shortened.split(/[\\/]/u).filter(Boolean);
  return parts.length > 5 ? `…/${parts.slice(-4).join("/")}` : shortened;
}

function treeCommandPreview(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const lines = command.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const first = lines[0] as string;
  return lines.length === 1 ? first : `${first} ↵ +${lines.length - 1} ${lines.length === 2 ? "line" : "lines"}`;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 8_192);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  let length = 0;
  for (let index = 0; index < Math.min(value.length, 200) && length < 8_192; index += 1) {
    const item = value[index];
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as Record<string, unknown>;
    const part = block.type === "text" && typeof block.text === "string"
      ? block.text
      : (block.type === "toolCall" || block.type === "tool_call") && typeof block.name === "string"
        ? `Tool call: ${block.name}`
        : undefined;
    if (part === undefined) continue;
    const bounded = part.slice(0, 8_192 - length);
    parts.push(bounded);
    length += bounded.length + 1;
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function treeLine(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parts: string[] = [];
  let outputLength = 0;
  let tokenStart = -1;
  let pendingSpace = false;
  const flushToken = (end: number): boolean => {
    if (tokenStart < 0) return false;
    if (pendingSpace && outputLength > 0 && outputLength < limit) {
      parts.push(" ");
      outputLength += 1;
    }
    const remaining = limit - outputLength;
    if (remaining > 0) {
      const token = value.slice(tokenStart, Math.min(end, tokenStart + remaining));
      parts.push(token);
      outputLength += token.length;
    }
    tokenStart = -1;
    pendingSpace = false;
    return outputLength >= limit;
  };
  for (let index = 0; index < value.length && outputLength < limit; index += 1) {
    const code = value.charCodeAt(index);
    if (isTreeLineSeparator(code)) {
      if (flushToken(index)) break;
      pendingSpace = outputLength > 0;
    } else {
      if (tokenStart < 0) tokenStart = index;
      if (index - tokenStart + outputLength >= limit) {
        flushToken(index + 1);
        break;
      }
    }
  }
  if (outputLength < limit && tokenStart >= 0) flushToken(value.length);
  return safeRequiredText(parts.join(""), limit, fallback);
}

function isTreeLineSeparator(code: number): boolean {
  return code <= 0x20
    || (code >= 0x7f && code <= 0xa0)
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

function safeSelectedText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Pi returned invalid selected editor text");
  if (value.length > 256_000) throw new Error("Selected editor text exceeds 256000 characters");
  return value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
}

function validCatalogName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : undefined;
}

function extensionCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  return name.length > 0 ? name : undefined;
}

type PiTool = (ReturnType<AgentSession["getAllTools"]>)[number];
interface VisibleToolRef { tool: PiTool; name: string }

function projectVisibleTools(session: AgentSession): AgentToolProjection {
  const active = new Set(session.getActiveToolNames());
  const selected: VisibleToolRef[] = [];
  let total = 0;
  for (const tool of session.getAllTools()) {
    const name = validCatalogName(tool.name);
    if (name === undefined) continue;
    total += 1;
    retainCanonicalToolPrefix(selected, { tool, name }, MAX_PROJECTION_ITEMS);
  }
  selected.sort(compareVisibleToolRefs);
  const tools: ToolDto[] = [];
  let bytes = 2;
  for (const { tool, name } of selected) {
    if (tools.length >= MAX_PROJECTION_ITEMS) break;
    const schema = projectJsonObject(tool.parameters).value;
    const candidate: ToolDto = {
      name,
      description: safeRequiredText(tool.description, 2_048, "Tool description omitted"),
      active: active.has(tool.name),
      source: projectSource(tool.sourceInfo, tool.sourceInfo.source === "builtin" ? "built-in" : "extension"),
      ...(Object.keys(schema).length > 0 ? { parameterSchema: schema } : {}),
    };
    const itemBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8") + (tools.length > 0 ? 1 : 0);
    if (bytes + itemBytes > MAX_TOOL_PROJECTION_BYTES) break;
    tools.push(candidate);
    bytes += itemBytes;
  }
  tools.sort(compareToolDtos);
  return { tools, total, truncated: tools.length < total };
}

function retainCanonicalToolPrefix(heap: VisibleToolRef[], candidate: VisibleToolRef, limit: number): void {
  if (heap.length < limit) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareVisibleToolRefs(heap[parent]!, heap[index]!) >= 0) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
    return;
  }
  if (compareVisibleToolRefs(candidate, heap[0]!) >= 0) return;
  heap[0] = candidate;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let largest = index;
    if (left < heap.length && compareVisibleToolRefs(heap[left]!, heap[largest]!) > 0) largest = left;
    if (right < heap.length && compareVisibleToolRefs(heap[right]!, heap[largest]!) > 0) largest = right;
    if (largest === index) break;
    [heap[index], heap[largest]] = [heap[largest]!, heap[index]!];
    index = largest;
  }
}

function compareVisibleToolRefs(left: VisibleToolRef, right: VisibleToolRef): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function projectSource(source: SourceInfo, kind: SourceDto["kind"]): SourceDto {
  if (kind === "built-in") return { kind };
  const path = boundedString(source.path, 16_384, "");
  const packageName = source.origin === "package" ? boundedString(source.source, 256, "") : "";
  return {
    kind,
    ...(path ? { path } : {}),
    ...(packageName ? { package: packageName } : {}),
  };
}

function capJsonItems<T>(items: T[], maxBytes: number): T[] {
  const result: T[] = [];
  let bytes = 2;
  for (const item of items.slice(0, MAX_PROJECTION_ITEMS)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (result.length === 0 ? 0 : 1);
    if (bytes + itemBytes > maxBytes) break;
    result.push(item);
    bytes += itemBytes;
  }
  return result;
}

function projectDiagnostic(diagnostic: ResourceDiagnostic): DiagnosticDto {
  return {
    severity: diagnostic.type === "error" ? "error" : "warning",
    message: safeRequiredText(diagnostic.message, 2_048, "Resource diagnostic omitted"),
    ...(diagnostic.path ? { source: boundedString(diagnostic.path, 256, "resource") } : {}),
  };
}

/**
 * Where a child's copy of the conversation ends: before the reply whose tool calls are still
 * running, which includes the call creating the child. Otherwise the child would see its own
 * creation end without a result.
 */
function childForkPoint(branch: ReturnType<SessionManager["getBranch"]>): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const answered = new Set(branch.slice(index + 1).flatMap((later) => later.type === "message" && later.message.role === "toolResult" ? [later.message.toolCallId] : []));
    const running = entry.message.content.some((block) => block.type === "toolCall" && !answered.has(block.id));
    return running ? entry.parentId ?? undefined : branch.at(-1)!.id;
  }
  return branch.at(-1)?.id;
}

async function refreshSessionModels(session: AgentSession, services: AgentSessionServices): Promise<void> {
  // Reload adopts local models.json and saved catalogs without waiting on pi.dev
  // (cards #222/#330). Pi owns loading, merging and provider availability.
  await services.modelRuntime.refresh({ allowNetwork: false });
  const current = session.model;
  if (current) {
    const refreshed = services.modelRuntime.getModel(current.provider, current.id);
    if (refreshed) session.agent.state.model = refreshed;
  }
  if (session.scopedModels.length > 0) {
    session.setScopedModels(session.scopedModels.map((scoped) => ({
      ...scoped,
      model: services.modelRuntime.getModel(scoped.model.provider, scoped.model.id) ?? scoped.model,
    })));
  }
}

function syncAgentRuntimeSettings(session: AgentSession, settingsManager: SettingsManager): void {
  session.agent.transport = settingsManager.getTransport();
  session.agent.thinkingBudgets = settingsManager.getThinkingBudgets();
  session.agent.maxRetryDelayMs = settingsManager.getProviderRetrySettings().maxRetryDelayMs;
}

export async function createPiAgentAdapter(options: CreatePiAgentAdapterOptions): Promise<PiAgentAdapter> {
  // A child can always report to its parent, whatever else it was allowed.
  const allowedTools = options.allowedTools === undefined ? undefined
    : options.child ? [...new Set([...options.allowedTools, ...CHILD_DOCK_TOOL_NAMES])] : options.allowedTools;
  const planGoalPort: PlanGoalPort = {};
  const attachmentContextKey = await loadAttachmentContextKey(options.agentDir);
  const publishedFiles = new TransientFileRegistry();
  const uiContext = options.extensionUiBroker && !options.extensionUiContextPortFactory
    ? createPiExtensionUiContext(options.extensionUiBroker)
    : undefined;
  const createUiContext = options.extensionUiContextPortFactory
    ? () => createPiExtensionUiContext(options.extensionUiContextPortFactory!())
    : undefined;
  const trustByCwd = new Map<string, boolean>([[options.cwd, options.projectTrusted]]);
  // The assistant is the Work's system; a selection saved with an older assistant Work is not read.
  const systemPromptResolver = options.assistantPort !== undefined ? assistantSystemPrompt : piSystemPromptResolver(options.workerConfig, options.agentDir);
  let childStarting = options.child === true;
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const canonicalCwd = await realpath(resolve(cwd));
    const settingsManager = SettingsManager.create(canonicalCwd, agentDir, {
      projectTrusted: trustByCwd.get(canonicalCwd) ?? false,
    });
    configurePiNetwork(settingsManager);
    const services = await createAgentSessionServices({
      ...(options.createModelRuntime === undefined ? {} : { modelRuntime: await options.createModelRuntime() }),
      cwd: canonicalCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        ...(systemPromptResolver === undefined ? {} : { systemPromptResolver }),
        extensionFactories: [
          { name: "alu-dock-tool-result-normalizer", factory: piToolResultNormalizerExtension },
          { name: "alu-dock-retry", factory: retryExtension },
          { name: "alu-dock-plan-goal", factory: planGoalExtension(planGoalPort) },
          { name: "alu-dock-show-image", factory: showImageExtension(publishedFiles) },
          ...(options.dockToolsBridge === undefined ? [] : [{ name: "alu-dock-tools", factory: dockToolsExtension(options.dockToolsBridge) }]),
          ...(options.dockAttachmentPort === undefined ? [] : [{ name: "alu-dock-attachments", factory: dockAttachmentsExtension(options.dockAttachmentPort) }]),
          ...(options.assistantPort === undefined ? [] : [{ name: "alu-dock-assistant", factory: assistantExtension(options.assistantPort, attachmentContextKey) }]),
          ...piBuiltinExtensions(() => planGoalPort.isPlanning?.() ?? false),
        ],
        extensionsOverride: ownCanonicalShowImage,
        appendSystemPromptOverride: (base) => [...base, ALU_DOCK_PI_WORKER_GUIDANCE, ...(options.child ? [ALU_DOCK_CHILD_GUIDANCE] : [])],
        ...(options.dockAttachmentPort === undefined ? {} : {
          additionalSkillPaths: [dockAttachmentSkillPath()],
        }),
      },
    });
    // `model` is a Dock `{provider, id}` reference, not Pi's Model object; resolve it here.
    const { model: requestedModel, ...piCreateOptions } = (options.workerConfig ?? {}) as unknown as Partial<Parameters<typeof createAgentSessionFromServices>[0]>;
    // A child is created once; reloads restore what its session recorded.
    const childStart = childStarting;
    const inheritedConversation = childStart && sessionManager.getBranch().length > 0;
    // A child given its parent's conversation still starts on its own model.
    const startingModel = await resolvePiStartingModel(requestedModel, services.modelRuntime, sessionManager, childStart);
    // Pi starts a model that lacks the requested thinking level at the nearest level it has.
    const result = await createAgentSessionFromServices({
      ...piCreateOptions,
      ...(startingModel === undefined ? {} : { model: startingModel }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...workerToolSelection(allowedTools, options.excludeTools ?? piCreateOptions.excludeTools),
      // Worker-owned services and Session continuity cannot be replaced by wire JSON.
      services,
      sessionManager,
      sessionStartEvent,
      // Preserve existing plugin preferences; wire JSON cannot disable this contract.
      extensionModelMutationPolicy: "legacy-defaults",
    });
    if (inheritedConversation) {
      // Pi records these only for new sessions; without them a reload would restore the parent's.
      if (result.session.model) sessionManager.appendModelChange(result.session.model.provider, result.session.model.id);
      sessionManager.appendThinkingLevelChange(result.session.thinkingLevel);
    }
    childStarting = false;
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const sessionManager = options.sessionManager
    ?? (options.sessionDir
      ? SessionManager.create(options.cwd, options.sessionDir)
      : SessionManager.create(options.cwd));
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd, agentDir: options.agentDir, sessionManager,
  });
  return PiAgentAdapter.create({
    planGoalPort,
    runtime,
    extensionUiBroker: options.extensionUiBroker,
    uiContext,
    uiContextFactory: createUiContext,
    setProjectTrust: (cwd, trusted) => trustByCwd.set(cwd, trusted),
    configureNetwork: configurePiNetwork,
    initialProcessCwd: options.cwd,
    attachmentContextKey,
    publishedFiles,
    ...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
    ...(options.dockAttachmentPort === undefined ? {} : { dockAttachmentPort: options.dockAttachmentPort }),
    ...(options.setProcessCwd === undefined ? {} : { setProcessCwd: options.setProcessCwd }),
  });
}

function dockAttachmentSkillPath(): string {
  return bundledDockSkillPath("dock-attachments");
}

function bundledDockSkillPath(name: string): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, `../../skills/${name}/SKILL.md`),
    resolve(moduleDirectory, `../../../skills/${name}/SKILL.md`),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function compactionFailureReason(message: string): "nothing_to_compact" | "already_compacted" | "cancelled" | "failed" {
  if (message === "Nothing to compact (session too small)") return "nothing_to_compact";
  if (message === "Already compacted") return "already_compacted";
  if (message === "Compaction cancelled") return "cancelled";
  return "failed";
}

function validDate(value: Date): boolean { return value instanceof Date && Number.isFinite(value.getTime()); }
function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return safeRequiredText(message, 2_048, "Settings error details omitted");
}
