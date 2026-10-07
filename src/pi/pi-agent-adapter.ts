import { piSystemPromptResolver } from "./system-template-provider.js";
import { resolvePiStartingModel } from "./pi-starting-model.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
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
  SettingsManager,
  type ResourceDiagnostic,
  type SessionEntry,
  type SessionTreeNode,
  type SourceInfo,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

import { ResourceContentError } from "../core/resource-content.js";
import { MAX_SOURCE_FILE_PATH_CHARS } from "../core/source-file.js";
import { dockToolsExtension, type DockToolsBridge } from "./dock-tools-extension.js";
import {
  dockAttachmentsExtension,
  DOCK_ATTACHMENT_RESOLVE_TOOL,
  redactDockAttachmentToolResult,
  type DockAttachmentCallPort,
} from "./dock-attachments-extension.js";
import { appendDockAttachmentContext, extractDockAttachmentContext } from "./dock-attachment-context.js";
import { isPortableAbsoluteLocalPath } from "../core/local-path.js";
import { hardenWindowsPrivatePath, noFollowFlag } from "../platform/private-state.js";

import {
  MAX_BASH_COMMAND_CHARS,
  MAX_IMAGE_AGGREGATE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
  MAX_RECORD_USAGE_TEXT_CHARS,
  MAX_SEMANTIC_HISTORY_PAGE_BYTES,
  MAX_STOP_CLEANUP_ERROR_CHARS,
  MAX_SYSTEM_PROMPT_NAME_CHARS,
  MAX_TEXT_CHARS,
  type AttachmentDto,
  type ContentBlockDto,
  type ConversationFrame,
  type ConversationImageBody,
  type ImagePathDto,
  type PublishedFileDto,
  type RecordUsageDto,
  type SystemPromptBlockDto,
  type SystemPromptChangeDto,
  type TreeNodeDto,
  MAX_CONVERSATION_CHUNK_CHARS,
  MAX_CONVERSATION_CONTENT_BLOCKS,
  MAX_CONVERSATION_CONTENT_PAGE_BYTES,
} from "../core/instance-dto.js";
import type { NestedToolCallsDto } from "../core/nested-tool-calls.js";
import { projectJsonObject, type JsonObject, type JsonValue } from "../core/json-value.js";
import { sliceSemanticHistory, slimSemanticHistoryBlock, slimSemanticHistoryEntry } from "../core/history-pagination.js";
import { projectBuiltInToolPresentation } from "../core/tool-result-presentation.js";
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
  AgentConversationContentChunk,
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
import { parseOptionalAgentErrorText, parseSessionTreeResult, type SessionTreeResult } from "../control/protocol.js";
import { AgentModelNotFoundError, AgentSettingsWriteError, AgentUnknownToolError } from "../core/agent-worker.js";
import { configurePiNetwork } from "./configure-pi-network.js";
import { projectPiModelList } from "./pi-model-list.js";
import { GitBranchObserver, type GitBranchObserverPort } from "./git-branch-observer.js";
import { createPiExtensionUiContext } from "./pi-extension-ui-adapter.js";
import { piToolResultNormalizerExtension } from "./pi-tool-result-normalizer.js";
import { retryExtension } from "./retry-extension.js";
import { planGoalExtension, type PlanGoalStart } from "./plan-goal-extension.js";
import { TransientFileRegistry } from "./transient-file-registry.js";
import { piBuiltinExtensions } from "./pi-builtin-extensions.js";
import { LiveNestedToolCalls, nestedCallArgumentsJson, projectPiNestedToolCalls } from "./pi-nested-tool-calls.js";
import { ownCanonicalShowImage, publishedFileFailureFromDetails, publishedFileFromDetails, redactShowImageResult, showImageExtension, SHOW_IMAGE_UNAVAILABLE_MESSAGE } from "./show-image-extension.js";
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
  planGoalStart?: PlanGoalStart;
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
}

export interface CreatePiAgentAdapterOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  /** Pi owns the meaning of these JSON-safe createAgentSession fields. */
  workerConfig?: JsonObject;
  projectTrusted: boolean;
  extensionUiBroker?: PiExtensionUiLifecyclePort;
  extensionUiContextPortFactory?: () => PiExtensionUiPort;
  setProcessCwd?: (cwd: string) => void;
  sessionManager?: SessionManager;
  dockToolsBridge?: DockToolsBridge;
  dockAttachmentPort?: DockAttachmentCallPort;
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
  settledWaiters: Array<() => void>;
  conversationReadState?: ConversationReadState;
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

interface ConversationReadEntry {
  source: SessionEntry;
  semantic: Parameters<typeof sliceSemanticHistory>[0][number];
  contentRef: string;
}
interface ConversationReadState {
  revision: string;
  sessionId: string;
  leafId: string | null;
  entries: ConversationReadEntry[];
  byRef: Map<string, ConversationReadEntry>;
  /** Earlier entries on the branch, so a context edit can be shown the way its target is. */
  byEntryId: Map<string, SessionEntry>;
  imageSources: Map<string, object>;
  previews: Map<SessionEntry, { projected: AgentHistoryEntry; bytes: number }>;
  previewBytes: number;
  reading?: { item: ConversationReadEntry; blocks: ConversationSourceBlock[] };
}

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
  private conversationScope = randomUUID();
  private sessionNameOperationId: string | undefined;
  private manualCompactionOperationId: string | undefined;
  private extensionCommandOperationId: string | undefined;
  private readonly conversationHistoryCursors = new Map<string, { revision: string; end: number; view?: "references" }>();
  private readonly conversationContentCursors = new Map<string, { revision: string; contentRef: string; blockIndex: number; offset: number; view?: "references" }>();
  private readonly commandContentCursors = new Map<string, { commandKey: string; revision: string; offset: number }>();

  private constructor(private readonly options: PiAgentAdapterOptions) {
    if (options.planGoalStart) options.planGoalStart.prompt = async (text, mayStart) => {
      let started = false;
      await this.requireActive().session.prompt(text, {
        source: "extension", expandPromptTemplates: false,
        preflightResult: (disposition: PiPromptDisposition) => {
          if (disposition !== "started") return;
          if (!mayStart()) throw new Error("当前请求已取消或预算已用尽，请按最新请求继续。");
          started = true;
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
        const delivery = requestedDelivery === "auto" ? (admissionRunning ? "steer" : "prompt") : requestedDelivery;
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
        if ((context?.type === "command" || context?.type === "host_queue") && piIsSettling(binding)) {
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
          const actualDelivery = binding.session.isStreaming ? delivery : "prompt";
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
    return this.conversationEntries();
  }

  async getConversationHistory(cursor?: string, limit = 50, view?: "references"): Promise<AgentConversationHistoryPage> {
    const state = this.conversationState();
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    let end = state.entries.length;
    if (cursor !== undefined) {
      const continuation = this.conversationHistoryCursors.get(cursor);
      if (!continuation || continuation.revision !== state.revision || continuation.view !== view) throw new AgentConversationCursorError("Conversation history cursor is stale");
      end = continuation.end;
    }
    // A continuation reads its accepted prefix, not tool results appended after
    // that page boundary (which could otherwise move an old semantic range).
    const page = sliceSemanticHistory(state.entries.slice(0, end).map(({ semantic }) => semantic), end, boundedLimit);
    const selected = state.entries.slice(page.start, page.end);
    let entries = selected.map((item) => {
      const projected = this.conversationProjection(state, item.source);
      const entry = previewConversationEntry(projected);
      const blocks = conversationContentBlocks(item.source, projected, this.options.attachmentContextKey, this.options.publishedFiles, state.byEntryId);
      return {
        entry, contentRef: item.contentRef,
        contentComplete: conversationPreviewIsComplete(blocks, entry, view),
        totalBlocks: blocks.length,
      };
    });
    const nextCursor = page.hasEarlier ? randomUUID() : undefined;
    const result = (): AgentConversationHistoryPage => ({
      revision: state.revision,
      entries,
      hasEarlier: page.hasEarlier,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
    if (Buffer.byteLength(JSON.stringify(result()), "utf8") > MAX_SEMANTIC_HISTORY_PAGE_BYTES) {
      entries = entries.map((item, index) => {
        const entry = slimSemanticHistoryEntry(item.entry);
        return { ...item, entry, contentComplete: item.contentComplete && conversationPreviewIsComplete(
          conversationContentBlocks(selected[index]!.source, this.conversationProjection(state, selected[index]!.source), this.options.attachmentContextKey, this.options.publishedFiles, state.byEntryId), entry, view,
        ) };
      });
    }
    const bounded = result();
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_SEMANTIC_HISTORY_PAGE_BYTES) {
      throw new Error("A complete conversation section is too large to return in one history page");
    }
    if (nextCursor !== undefined) {
      this.conversationHistoryCursors.set(nextCursor, { revision: state.revision, end: page.start, view });
      trimTokenMap(this.conversationHistoryCursors);
    }
    return bounded;
  }

  getConversationImage(contentRef: string): ConversationImageBody {
    const image = this.options.publishedFiles.image(contentRef)
      ?? this.options.publishedFiles.image(contentRef, this.conversationState().imageSources.get(contentRef));
    if (image === undefined) throw new AgentConversationCursorError("Conversation image reference is stale");
    return image;
  }

  async getConversationContent(contentRef: string, cursor?: string, view?: "references"): Promise<AgentConversationContentPage> {
    const nativeImage = view === undefined ? this.options.publishedFiles.readImageContent(contentRef, cursor) : undefined;
    if (nativeImage !== undefined) return nativeImage;
    const state = this.conversationState();
    const image = this.options.publishedFiles.image(contentRef, state.imageSources.get(contentRef));
    if (image !== undefined) {
      if (view === "references") {
        if (cursor !== undefined) throw new AgentConversationCursorError("Conversation image reference view has no continuation");
        return { revision: contentRef, contentRef, complete: true, chunks: [
          { type: "image_ref", blockIndex: 0, mimeType: image.mimeType, contentRef: image.contentRef },
        ] };
      }
      const restored = this.options.publishedFiles.readImageContent(contentRef, cursor);
      if (restored !== undefined) return restored;
    }
    let blockIndex = 0;
    let offset = 0;
    if (cursor !== undefined) {
      const continuation = this.conversationContentCursors.get(cursor);
      if (!continuation || continuation.revision !== state.revision || continuation.contentRef !== contentRef || continuation.view !== view) {
        throw new AgentConversationCursorError("Conversation content cursor is stale");
      }
      blockIndex = continuation.blockIndex;
      offset = continuation.offset;
    }
    const selected = state.byRef.get(contentRef);
    if (!selected) throw new AgentConversationCursorError("Conversation content reference is stale");
    // Keep only the most recently read record's full block view. Persisted
    // previews are cached, but full joined text/argument JSON is not duplicated
    // for the whole session or for every continuation token.
    if (state.reading?.item !== selected) state.reading = {
      item: selected, blocks: conversationContentBlocks(selected.source, this.conversationProjection(state, selected.source), this.options.attachmentContextKey, this.options.publishedFiles, state.byEntryId),
    };
    const blocks = state.reading.blocks;
    const chunks: AgentConversationContentChunk[] = [];
    let chars = 0;
    while (blockIndex < blocks.length && chunks.length < 64 && chars < 64_000) {
      const block = blocks[blockIndex]!;
      if (block.type === "text" || block.type === "thinking") {
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.text, Math.min(block.text.length, offset + Math.min(MAX_CONVERSATION_CHUNK_CHARS, remaining)));
        const text = block.text.slice(offset, end);
        const blockComplete = end >= block.text.length;
        chunks.push({ blockIndex, type: block.type, text, offset, blockComplete });
        chars += text.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "image") {
        if (view === "references") {
          const { data: _data, type: _type, ...reference } = block;
          chunks.push({ ...reference, type: "image_ref", blockIndex });
          blockIndex += 1;
          offset = 0;
          continue;
        }
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.data, Math.min(block.data.length, offset + Math.min(MAX_CONVERSATION_CHUNK_CHARS, remaining)));
        const data = block.data.slice(offset, end);
        const blockComplete = end >= block.data.length;
        chunks.push({ type: "image", mimeType: block.mimeType, blockIndex, data, offset, blockComplete });
        chars += data.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "tool_call") {
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.argumentsJson, Math.min(block.argumentsJson.length, offset + Math.min(MAX_CONVERSATION_CHUNK_CHARS, remaining)));
        const argumentsJson = block.argumentsJson.slice(offset, end);
        const blockComplete = end >= block.argumentsJson.length;
        chunks.push({ ...block, blockIndex, argumentsJson, offset, blockComplete });
        chars += argumentsJson.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "tool_result") {
        const { nestedCalls, ...identity } = block;
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.text, Math.min(block.text.length, offset + Math.min(MAX_CONVERSATION_CHUNK_CHARS, remaining)));
        const text = block.text.slice(offset, end);
        let chunk: Extract<AgentConversationContentChunk, { type: "tool_result" }> = { ...identity, blockIndex, text, offset, blockComplete: end >= block.text.length };
        if (chunk.blockComplete && nestedCalls !== undefined) {
          // The calls arrive once, with the chunk that completes the result. A page that cannot
          // also hold them ends before it, or carries the text alone and leaves them for the next.
          const withCalls = { ...chunk, nestedCalls };
          if (contentPageFits(state.revision, contentRef, [...chunks, withCalls])) chunk = withCalls;
          else if (chunks.length > 0) break;
          else if (text.length > 0) chunk = { ...chunk, blockComplete: false };
          // Otherwise the calls alone exceed a page: the result still completes, without them.
        }
        chunks.push(chunk);
        chars += text.length;
        if (chunk.blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else {
        chunks.push({ ...block, blockIndex } as AgentConversationContentChunk);
        blockIndex += 1;
        offset = 0;
      }
    }
    if (blockIndex >= blocks.length) return { revision: state.revision, contentRef, chunks, complete: true };
    const nextCursor = randomUUID();
    this.conversationContentCursors.set(nextCursor, { revision: state.revision, contentRef, blockIndex, offset, view });
    trimTokenMap(this.conversationContentCursors);
    return { revision: state.revision, contentRef, chunks, complete: false, nextCursor };
  }

  private conversationEntries(binding: Binding = this.requireActive()): AgentHistoryEntry[] {
    const state = this.conversationState(binding);
    return state.entries.map(({ source }) => this.conversationProjection(state, source));
  }

  private conversationProjection(state: ConversationReadState, source: SessionEntry): AgentHistoryEntry {
    const cached = state.previews.get(source);
    if (cached) {
      state.previews.delete(source);
      state.previews.set(source, cached);
      return cached.projected;
    }
    const projected = projectHistoryEntry(source, this.options.attachmentContextKey, this.options.publishedFiles, state.byEntryId);
    const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
    // One existing producer page budget for hot previews, not a second transcript.
    if (bytes <= MAX_SEMANTIC_HISTORY_PAGE_BYTES) {
      while (state.previewBytes + bytes > MAX_SEMANTIC_HISTORY_PAGE_BYTES) {
        const oldest = state.previews.keys().next().value!;
        state.previewBytes -= state.previews.get(oldest)!.bytes;
        state.previews.delete(oldest);
      }
      state.previews.set(source, { projected, bytes });
      state.previewBytes += bytes;
    }
    return projected;
  }

  private conversationState(binding: Binding = this.requireActive()): ConversationReadState {
    const manager = binding.session.sessionManager;
    const sessionId = manager.getSessionId();
    const leafId = manager.getLeafId();
    const previous = binding.conversationReadState;
    // Pi's public SessionManager is append-only. Unchanged leaf object identity
    // avoids walking/projecting/hashing the branch for each content chunk.
    if (previous?.sessionId === sessionId && previous.leafId === leafId
      && previous.entries.at(-1)?.source === manager.getLeafEntry()) return previous;
    const branch = manager.getBranch();
    const appended = previous?.sessionId === sessionId
      && previous.entries.length <= branch.length
      && previous.entries.every((item, index) => item.source === branch[index]);
    const state: ConversationReadState = appended ? previous : {
      revision: createHash("sha256").update(this.conversationScope).update(randomUUID()).digest("hex"),
      sessionId, leafId, entries: [], byRef: new Map(), byEntryId: new Map(), imageSources: new Map(), previews: new Map(), previewBytes: 0,
    };
    if (!appended) {
      this.conversationHistoryCursors.clear();
      this.conversationContentCursors.clear();
    }
    // Retain just the current authoritative branch, not a snapshot per scan.
    // The revision and old page end positions survive verified prefix append;
    // a different branch/session/scope starts a new read domain for old clients too.
    for (const source of branch.slice(state.entries.length)) {
      const projected = this.conversationProjection(state, source);
      const content = source.type === "message" ? (source.message as unknown as Record<string, unknown>).content
        : source.type === "custom_message" ? source.content : undefined;
      if (Array.isArray(content)) for (const block of content) {
        if (!isRecord(block) || block.type !== "image") continue;
        const imageRef = this.options.publishedFiles.imageReference(block)
          ?? registerConversationImage(this.options.publishedFiles, typeof block.data === "string" ? block.data : undefined, safeImageMimeType(block.mimeType), block)?.contentRef;
        if (imageRef !== undefined) state.imageSources.set(imageRef, block);
      }
      const item: ConversationReadEntry = {
        source,
        semantic: {
          source: projected.source,
          content: projected.content.flatMap((block) => block.type === "tool_call" || block.type === "tool_result"
            ? [{ type: block.type, toolCallId: block.toolCallId }] : []),
        },
        contentRef: conversationContentRef(sessionId, source.id),
      };
      state.entries.push(item);
      state.byRef.set(item.contentRef, item);
      state.byEntryId.set(source.id, source);
    }
    state.leafId = leafId;
    binding.conversationReadState = state;
    return state;
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
    this.options.planGoalStart?.cancelPending?.();
    const session = this.active?.session;
    if (!session) return;
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
    await session.abort();
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
      history: this.conversationEntries(binding),
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
        uiContext,
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
    this.conversationScope = randomUUID();
    this.conversationHistoryCursors.clear();
    this.conversationContentCursors.clear();
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

function boundedString(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (value.length <= limit) return value;
  const requestedEnd = Math.max(0, limit - 1);
  const end = requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
  return `${value.slice(0, end)}…`;
}

function boundedContentString(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length <= limit) return value;
  return value.slice(0, unicodeSafeEnd(value, limit));
}

function optionalContentString(value: unknown, limit: number): string | undefined {
  const content = boundedContentString(value, limit);
  return content.length > 0 ? content : undefined;
}

interface PiImageContent { type: "image"; data: string; mimeType: string }

async function resolveAttachmentImages(
  attachments: readonly AttachmentDto[] | undefined,
  port: DockAttachmentCallPort | undefined,
): Promise<ImagePathDto[] | undefined> {
  const images = (attachments ?? []).filter((attachment) => safeImageMimeType(attachment.mediaType) === attachment.mediaType);
  if (images.length === 0) return undefined;
  if (!port) throw new Error("This image attachment can’t be opened right now. Re-upload it and try again.");
  return Promise.all(images.map(async (attachment) => {
    const resolved = await port.access({ type: "resolve", fileId: attachment.fileId });
    if (resolved.type !== "resolve" || resolved.attachment.fileId !== attachment.fileId) {
      throw new Error(`The image attachment ${attachment.name} is no longer available. Re-upload it and try again.`);
    }
    return { path: resolved.path, mimeType: attachment.mediaType! };
  }));
}

function safeImageMimeType(value: unknown): string {
  return typeof value === "string"
    && value.length <= MAX_IMAGE_MIME_TYPE_CHARS
    && /^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(value)
    ? value
    : "image/unknown";
}

function imageBase64Metadata(data: string): { sha256: string; sizeBytes: number } | undefined {
  if (data.length === 0 || data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) return undefined;
  try {
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
    return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
  } catch { return undefined; }
}

function registerConversationImage(publishedFiles: TransientFileRegistry | undefined, data: string | undefined, mimeType: string, source?: object): { contentRef: string; sha256: string; sizeBytes: number } | undefined {
  if (publishedFiles === undefined || data === undefined) return undefined;
  try { return publishedFiles.registerImage(data, mimeType, source); }
  catch { return undefined; }
}

async function loadPiImages(images: readonly ImagePathDto[] | undefined): Promise<PiImageContent[] | undefined> {
  if (images === undefined || images.length === 0) return undefined;
  if (!Array.isArray(images) || images.length > MAX_INPUT_IMAGES) throw new Error(`Image input exceeds ${MAX_INPUT_IMAGES} files`);
  const opened: Array<{ handle: Awaited<ReturnType<typeof open>>; mimeType: string; size: number }> = [];
  let aggregate = 0;
  try {
    const seen = new Set<string>();
    for (const [index, image] of images.entries()) {
      const imageNumber = index + 1;
      if (!image || typeof image.path !== "string" || image.path.length < 1 || image.path.length > MAX_IMAGE_PATH_CHARS || !isPortableAbsoluteLocalPath(image.path) || /[\u0000-\u001f\u007f-\u009f]/u.test(image.path)) throw new Error(`Image ${imageNumber} path must be a bounded absolute local path`);
      const mimeType = safeImageMimeType(image.mimeType);
      if (mimeType !== image.mimeType) throw new Error(`Image ${imageNumber} MIME type must be a bounded image/* value`);
      const descriptorKey = `${image.path}\u0000${mimeType}`;
      if (seen.has(descriptorKey)) throw new Error("Image descriptors must be unique");
      seen.add(descriptorKey);
      let handle: Awaited<ReturnType<typeof open>>;
      try { handle = await open(image.path, "r"); }
      catch { throw new Error(`Image ${imageNumber} could not be opened`); }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`Image ${imageNumber} path is not a regular file`);
        if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image ${imageNumber} exceeds ${MAX_IMAGE_BYTES} bytes`);
        aggregate += stat.size;
        if (aggregate > MAX_IMAGE_AGGREGATE_BYTES) throw new Error(`Image input exceeds ${MAX_IMAGE_AGGREGATE_BYTES} aggregate bytes`);
        opened.push({ handle, mimeType, size: stat.size });
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    }
    const result: PiImageContent[] = [];
    for (const [index, image] of opened.entries()) {
      const bytes = Buffer.allocUnsafe(image.size);
      let offset = 0;
      try {
        while (offset < bytes.length) {
          const read = await image.handle.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        const extra = Buffer.allocUnsafe(1);
        const extraRead = await image.handle.read(extra, 0, 1, offset);
        if (extraRead.bytesRead > 0) throw new Error("changed");
      } catch {
        throw new Error(`Image ${index + 1} could not be read as a stable file`);
      }
      result.push({ type: "image", data: bytes.subarray(0, offset).toString("base64"), mimeType: image.mimeType });
    }
    return result;
  } finally {
    await Promise.all(opened.map(({ handle }) => handle.close().catch(() => {})));
  }
}

function safeOptionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return boundedString(value, limit, "");
}

function exactOptionalText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

function safeRequiredText(value: unknown, limit: number, fallback: string): string {
  return safeOptionalText(value, limit) ?? fallback;
}

export function projectAgentSessionEvents(event: AgentSessionEvent, publishedFiles?: TransientFileRegistry): AgentEvent[] {
  const source = event as unknown as Record<string, unknown>;
  if (source.type === "message_update" && isRecord(source.assistantMessageEvent)) {
    const update = source.assistantMessageEvent;
    if ((update.type === "text_delta" || update.type === "thinking_delta") && typeof update.delta === "string" && update.delta.length > MAX_TEXT_CHARS) {
      const projected: AgentEvent[] = [];
      let offset = 0;
      while (offset < update.delta.length) {
        const end = unicodeSafeEnd(update.delta, Math.min(update.delta.length, offset + MAX_TEXT_CHARS));
        projected.push(projectAgentSessionEvent({ ...source, assistantMessageEvent: { ...update, delta: update.delta.slice(offset, end) } }, publishedFiles));
        offset = end;
      }
      return projected;
    }
  }
  if (source.type === "entry_appended") return [{ type: "conversation_checkpoint" }];
  const projected = projectAgentSessionEvent(source, publishedFiles);
  if (source.type === "turn_end" || source.type === "agent_settled" || source.type === "compaction_end") {
    return [projected, { type: "conversation_checkpoint" }];
  }
  return [projected];
}

function projectAgentSessionEvent(event: AgentSessionEvent | Record<string, unknown>, publishedFiles?: TransientFileRegistry): AgentEvent {
  const source = event as unknown as Record<string, unknown>;
  const type = typeof source.type === "string" ? source.type : "unknown";
  if (type === "agent_end") return { type, willRetry: source.willRetry === true };
  if (type === "turn_end" || type === "entry_appended") return { type };
  if ((type === "message_start" || type === "message_end") && isRecord(source.message)) {
    return { type, message: projectRuntimeMessage(source.message, publishedFiles) };
  }
  if (type === "message_update" && isRecord(source.assistantMessageEvent)) {
    return { type, assistantMessageEvent: projectAssistantMessageEvent(source.assistantMessageEvent) };
  }
  // Calls a tool made itself (for example from a codemode script) name the call that made them.
  const parent = typeof source.parentToolCallId === "string" ? { parentToolCallId: safeRequiredText(source.parentToolCallId, 128, "unknown") } : {};
  if (type === "tool_execution_start" && "parentToolCallId" in parent) {
    // Shown only inside the caller: the arguments follow Pi's record, not Dock's model-call bounds.
    const argumentsJson = nestedCallArgumentsJson(source.args);
    return {
      type,
      toolCallId: safeRequiredText(source.toolCallId, 128, "unknown"),
      toolName: safeRequiredText(source.toolName, 256, "tool"),
      ...(argumentsJson === undefined ? {} : { argumentsJson }),
      ...parent,
    };
  }
  if (type === "tool_execution_start") {
    return {
      type,
      toolCallId: safeRequiredText(source.toolCallId, 128, "unknown"),
      toolName: safeRequiredText(source.toolName, 256, "tool"),
      args: projectJsonObject(source.args).value,
    };
  }
  if (type === "tool_execution_end" || type === "tool_execution_update") {
    const resultKey = type === "tool_execution_end" ? "result" : "partialResult";
    const result = isRecord(source[resultKey]) ? source[resultKey] as Record<string, unknown> : undefined;
    const toolName = typeof source.toolName === "string" ? source.toolName : undefined;
    const isError = type === "tool_execution_end" && source.isError === true;
    const contentText = optionalContentString(toolResultText(result?.content), 256_000);
    const content = projectPrivateToolContent(result?.content, publishedFiles);
    const publishedFile = publishedFiles === undefined ? undefined : publishedFileFromDetails(result?.details, publishedFiles);
    const showImageError = publishedFiles === undefined ? undefined : publishedFileFailureFromDetails(result?.details, publishedFiles);
    const presentation = projectBuiltInToolPresentation(toolName, contentText, result?.details, isError);
    return {
      type,
      toolCallId: safeRequiredText(source.toolCallId, 128, "unknown"),
      toolName: safeRequiredText(source.toolName, 256, "tool"),
      [resultKey]: { content, ...(publishedFile === undefined ? {} : { publishedFile }), ...(showImageError === undefined ? {} : { showImageError }), ...(presentation === undefined ? {} : { presentation }) },
      ...(type === "tool_execution_end" ? { isError } : {}),
      ...parent,
    };
  }
  if (type === "compaction_end") {
    return {
      type,
      reason: source.reason,
      aborted: source.aborted === true,
      willRetry: source.willRetry === true,
      ...(source.errorMessage === undefined ? {} : { errorMessage: parseOptionalAgentErrorText(source.errorMessage) }),
    };
  }
  return source as AgentEvent;
}

function projectRuntimeMessage(message: Record<string, unknown>, publishedFiles?: TransientFileRegistry): Record<string, unknown> {
  const role = safeRequiredText(message.role, 64, "system");
  const projected: Record<string, unknown> = {
    role,
    content: role === "toolResult" ? projectPrivateToolContent(message.content, publishedFiles) : projectPrivateContent(message.content, publishedFiles, role === "user"),
  };
  const stopReason = safeOptionalText(message.stopReason, 128);
  const errorMessage = parseOptionalAgentErrorText(message.errorMessage);
  const toolCallId = safeOptionalText(message.toolCallId, 128);
  if (stopReason !== undefined) projected.stopReason = stopReason;
  if (errorMessage !== undefined) projected.errorMessage = errorMessage;
  if (toolCallId !== undefined) projected.toolCallId = toolCallId;
  return projected;
}

function projectAssistantMessageEvent(update: Record<string, unknown>): Record<string, unknown> {
  const type = safeRequiredText(update.type, 64, "unknown");
  const projected: Record<string, unknown> = { type };
  if (typeof update.contentIndex === "number" && Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0) projected.contentIndex = update.contentIndex;
  const delta = safeOptionalText(update.delta, MAX_TEXT_CHARS);
  if (delta !== undefined) projected.delta = delta;
  if (isRecord(update.partial)) projected.partial = { content: projectPrivateContent(update.partial.content) };
  if (isRecord(update.toolCall)) projected.toolCall = projectPrivateToolCall(update.toolCall);
  return projected;
}

function projectPrivateContent(content: unknown, publishedFiles?: TransientFileRegistry, user = false): unknown {
  // Authentication must run before public text clipping, including for long user
  // messages whose signed attachment context is at the end. This stays in Worker.
  if (typeof content === "string") return user ? content : boundedContentString(content, 256_000);
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const item of content.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS)) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      blocks.push({ type: "text", text: user ? item.text : boundedContentString(item.text, MAX_TEXT_CHARS) });
    } else if (item.type === "thinking") {
      const thinking = optionalContentString(item.thinking, MAX_TEXT_CHARS);
      if (thinking !== undefined) blocks.push({ type: "thinking", thinking });
    }
    else if (item.type === "toolCall" || item.type === "tool_call") blocks.push(projectPrivateToolCall(item));
    else if (item.type === "image") {
      const mimeType = safeImageMimeType(item.mimeType);
      const imageData = typeof item.data === "string" ? item.data : undefined;
      const image = registerConversationImage(publishedFiles, imageData, mimeType, item);
      blocks.push({
        type: "image",
        mimeType,
        ...(image === undefined ? {} : { contentRef: image.contentRef, sha256: image.sha256 }),
      });
    }
  }
  return blocks;
}

function projectPrivateToolContent(content: unknown, publishedFiles?: TransientFileRegistry): unknown {
  if (typeof content === "string") return boundedContentString(content, 256_000);
  if (!Array.isArray(content)) return [];
  return content.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS).flatMap((item): Record<string, unknown>[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: boundedContentString(item.text, 256_000) }];
    if (item.type === "image") {
      const mimeType = safeImageMimeType(item.mimeType);
      const image = registerConversationImage(publishedFiles, typeof item.data === "string" ? item.data : undefined, mimeType, item);
      return [{ type: "image", mimeType, ...(image === undefined ? {} : { contentRef: image.contentRef }) }];
    }
    return [];
  });
}

function projectPrivateToolCall(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "toolCall",
    id: safeRequiredText(value.id, 128, "unknown"),
    name: safeRequiredText(value.name, 256, "tool"),
    arguments: projectJsonObject(value.arguments).value,
  };
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    parts.push(item.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

interface PiConversationInput {
  operationId: string;
  text: string;
  runtimeText?: string;
  consumedText?: string;
  delivery: "prompt" | "steer" | "followUp";
  fromQueue: boolean;
  images?: ImagePathDto[];
  attachments?: AttachmentDto[];
}

function piInputConsumedText(input: PiConversationInput): string {
  return input.consumedText ?? input.runtimeText ?? input.text;
}

/** Pi keeps the handed-over text intact and only appends its own notes after a blank line. */
function piStoredTextMatches(stored: string, handedOver: string): boolean {
  return stored === handedOver || stored.startsWith(`${handedOver}\n\n`);
}

export class PiConversationProjector {
  private readonly inputs: PiConversationInput[] = [];
  private steeringQueue: string[] = [];
  private followUpQueue: string[] = [];

  constructor(private readonly attachmentContextKey: Uint8Array) {}
  private readonly announcedToolCalls = new Set<string>();
  private readonly completedToolCalls = new Set<string>();
  private readonly nestedCalls = new LiveNestedToolCalls();
  /** Latest output of each running tool, repeated when only its nested calls change. */
  private readonly toolOutputs = new Map<string, Extract<ConversationFrame, { type: "tool.output_updated" }>["data"]>();
  private messageSequence = 0;
  private currentUserMessageId: string | undefined;
  private currentUserAttachments: AttachmentDto[] | undefined;
  private currentAssistantMessageId: string | undefined;
  private lastAssistantOutcome: { stopReason?: string; error?: string } | undefined;

  trackInput(input: PiConversationInput): PiConversationInput {
    const tracked = structuredClone(input);
    this.inputs.push(tracked);
    return tracked;
  }

  cancelInput(input: PiConversationInput): void {
    const index = this.inputs.indexOf(input);
    if (index >= 0) this.inputs.splice(index, 1);
  }

  nextInputOperationId(): string | undefined {
    return this.inputs[0]?.operationId;
  }

  clearQueuedInputs(cleared: ClearedAgentQueue): void {
    const remove = (delivery: "steer" | "followUp", texts: readonly string[]): void => {
      for (const text of texts) {
        const index = this.inputs.findIndex((input) => input.delivery === delivery && piInputConsumedText(input) === text);
        if (index >= 0) this.inputs.splice(index, 1);
      }
    };
    remove("steer", cleared.steering);
    remove("followUp", cleared.followUp);
  }

  observeQueueUpdate(steering: readonly string[], followUp: readonly string[]): void {
    // Pi publishes this after input hooks and template/skill expansion, before a queued message can start.
    // Capture that public queue text once so later consumption keeps the Dock operation identity.
    this.captureQueuedInputs("steer", this.steeringQueue, steering);
    this.captureQueuedInputs("followUp", this.followUpQueue, followUp);
    this.steeringQueue = [...steering];
    this.followUpQueue = [...followUp];
  }

  private captureQueuedInputs(
    delivery: "steer" | "followUp",
    previous: readonly string[],
    current: readonly string[],
  ): void {
    if (current.length <= previous.length) return;
    for (const consumedText of current.slice(previous.length)) {
      const input = this.inputs.find((candidate) => candidate.delivery === delivery && candidate.consumedText === undefined);
      if (input !== undefined) input.consumedText = consumedText;
    }
  }

  project(event: AgentEvent): AgentEvent[] {
    if (event.type === "agent_start") {
      this.currentUserMessageId = undefined;
      this.currentUserAttachments = undefined;
      this.currentAssistantMessageId = undefined;
      this.announcedToolCalls.clear();
      this.completedToolCalls.clear();
      this.nestedCalls.clear();
      this.toolOutputs.clear();
      this.lastAssistantOutcome = undefined;
      return [event];
    }
    if (event.type === "agent_settled") {
      const outcome = this.lastAssistantOutcome;
      this.lastAssistantOutcome = undefined;
      return [{
        type: "agent_settled",
        ...(typeof event.operationId === "string" ? { operationId: event.operationId } : {}),
        ...(outcome?.stopReason === undefined ? {} : { stopReason: outcome.stopReason }),
        ...(outcome?.error === undefined ? {} : { error: outcome.error }),
      }];
    }
    if (event.type === "message_start") return this.projectMessageStart(event);
    if (event.type === "message_update") return this.projectMessageUpdate(event);
    if (event.type === "message_end") return this.projectMessageEnd(event);
    if (event.type === "tool_execution_start") return this.projectToolStart(event);
    if (event.type === "tool_execution_update") return this.projectToolUpdate(event);
    if (event.type === "tool_execution_end") return this.projectToolEnd(event);
    return [event];
  }

  private projectMessageStart(event: AgentEvent): AgentEvent[] {
    const message = isRecord(event.message) ? event.message : undefined;
    if (message?.role !== "user") {
      if (message?.role === "assistant") this.ensureAssistantMessageId();
      return [];
    }
    const consumedText = toolResultText(message.content) ?? "";
    const extracted = extractDockAttachmentContext(consumedText, this.attachmentContextKey);
    // An exact match wins; otherwise accept the same text with Pi's notes appended.
    let inputIndex = this.inputs.findIndex((candidate) => piInputConsumedText(candidate) === consumedText || candidate.text === extracted.text);
    if (inputIndex < 0) {
      inputIndex = this.inputs.findIndex((candidate) => piStoredTextMatches(consumedText, piInputConsumedText(candidate)) || piStoredTextMatches(extracted.text, candidate.text));
    }
    const input = inputIndex < 0 ? undefined : this.inputs.splice(inputIndex, 1)[0];
    const operationId = input?.operationId ?? "runtime-initiated";
    this.currentUserMessageId = input === undefined
      ? `user-runtime-${++this.messageSequence}`
      : `user-${input.operationId}`;
    this.currentUserAttachments = structuredClone(input?.attachments ?? extracted.attachments);
    const data = {
      operationId,
      messageId: this.currentUserMessageId,
      role: "user" as const,
      text: boundedContentString(input?.text || extracted.text, 256_000),
      ...(input?.images === undefined ? {} : { images: structuredClone(input.images) }),
      ...(this.currentUserAttachments === undefined ? {} : { attachments: structuredClone(this.currentUserAttachments) }),
      delivery: input?.delivery ?? "prompt",
    };
    return [
      ...(input?.fromQueue === true ? [{ type: "dock_queue_consumed", operationId: input.operationId }] : []),
      this.frame({ type: "message.submitted", data }),
    ];
  }

  private projectMessageUpdate(event: AgentEvent): AgentEvent[] {
    const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
    if (!update) return [];
    if (update.type === "start") {
      this.ensureAssistantMessageId();
      return [];
    }
    if ((update.type === "text_delta" || update.type === "thinking_delta") && typeof update.delta === "string" && update.delta.length > 0) {
      return [this.frame({
        type: "message.delta",
        data: {
          messageId: this.ensureAssistantMessageId(),
          block: update.type === "text_delta" ? "text" : "thinking",
          delta: boundedContentString(update.delta, MAX_TEXT_CHARS),
        },
      })];
    }
    if (update.type !== "toolcall_start" && update.type !== "toolcall_delta" && update.type !== "toolcall_end") return [];
    this.ensureAssistantMessageId();
    const index = typeof update.contentIndex === "number" && Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0
      ? update.contentIndex
      : 0;
    const partial = isRecord(update.partial) ? update.partial : undefined;
    const partialContent = Array.isArray(partial?.content) ? partial.content : [];
    const partialToolCall = isRecord(partialContent[index]) ? partialContent[index] : undefined;
    const finalToolCall = isRecord(update.toolCall) ? update.toolCall : undefined;
    const toolCall = finalToolCall ?? partialToolCall;
    const rawId = typeof toolCall?.id === "string" ? toolCall.id : undefined;
    if (!rawId) return [];
    const toolCallId = safeRequiredText(rawId, 128, "unknown");
    const toolName = safeRequiredText(toolCall?.name, 256, "tool");
    const args = projectJsonObject(toolCall?.arguments ?? {});
    if (!this.announcedToolCalls.has(toolCallId)) {
      this.announcedToolCalls.add(toolCallId);
      return [this.frame({ type: "tool.started", data: {
        toolCallId,
        toolName,
        args: args.value,
        ...(args.omittedFields.length === 0 ? {} : { omittedFields: args.omittedFields }),
      } })];
    }
    return [this.frame({ type: "tool.args_updated", data: {
      toolCallId,
      args: args.value,
      ...(args.omittedFields.length === 0 ? {} : { omittedFields: args.omittedFields }),
    } })];
  }

  private projectMessageEnd(event: AgentEvent): AgentEvent[] {
    const message = isRecord(event.message) ? event.message : undefined;
    // Pi 0.99 records system prompt and tool changes as system messages; they are not conversation.
    if (!message || message.role === "system") return [];
    const role = typeof message.role === "string" ? message.role : "system";
    if (role === "toolResult") {
      const toolCallId = safeRequiredText(message.toolCallId, 128, "unknown");
      if (this.completedToolCalls.delete(toolCallId)) return [];
    }
    let messageId: string;
    let dockRole: "user" | "assistant" | "tool" | "system";
    if (role === "assistant") {
      messageId = this.ensureAssistantMessageId();
      dockRole = "assistant";
      this.lastAssistantOutcome = {
        ...(typeof message.stopReason === "string" ? { stopReason: boundedString(message.stopReason, 128, "unknown") } : {}),
        ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      };
    } else if (role === "user") {
      messageId = this.currentUserMessageId ?? `user-runtime-${++this.messageSequence}`;
      dockRole = "user";
    } else if (role === "toolResult") {
      messageId = `tool-result-${safeRequiredText(message.toolCallId, 128, "unknown")}`;
      dockRole = "tool";
    } else {
      messageId = `message-${++this.messageSequence}`;
      dockRole = "system";
    }
    const userProjection = role === "user" ? projectDockUserContent(message.content, this.attachmentContextKey) : undefined;
    const projected = this.frame({ type: "message.completed", data: {
      messageId,
      role: dockRole,
      content: userProjection?.content ?? projectDockContent(message.content),
      ...(role !== "user" || (this.currentUserAttachments ?? userProjection?.attachments) === undefined ? {} : { attachments: structuredClone(this.currentUserAttachments ?? userProjection?.attachments) }),
      ...(typeof message.stopReason === "string" ? { stopReason: boundedString(message.stopReason, 128, "unknown") } : {}),
      ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
    } });
    if (role === "assistant") this.currentAssistantMessageId = undefined;
    if (role === "user") { this.currentUserMessageId = undefined; this.currentUserAttachments = undefined; }
    return [projected];
  }

  private projectToolStart(event: AgentEvent): AgentEvent[] {
    const toolCallId = safeRequiredText(event.toolCallId, 128, "unknown");
    const toolName = safeRequiredText(event.toolName, 256, "tool");
    // Nested calls never reach the model as tool calls; they are listed inside their caller, as in Pi.
    if (typeof event.parentToolCallId === "string") {
      const argumentsJson = typeof event.argumentsJson === "string" ? event.argumentsJson : undefined;
      return this.nestedCallsChanged(this.nestedCalls.start(toolCallId, event.parentToolCallId, toolName, argumentsJson));
    }
    const args = projectJsonObject(event.args ?? {});
    if (this.announcedToolCalls.has(toolCallId)) {
      return [this.frame({ type: "tool.args_updated", data: {
        toolCallId,
        args: args.value,
        ...(args.omittedFields.length === 0 ? {} : { omittedFields: args.omittedFields }),
      } })];
    }
    this.announcedToolCalls.add(toolCallId);
    return [this.frame({ type: "tool.started", data: {
      toolCallId,
      toolName,
      args: args.value,
      ...(args.omittedFields.length === 0 ? {} : { omittedFields: args.omittedFields }),
    } })];
  }

  private projectToolUpdate(event: AgentEvent): AgentEvent[] {
    if (typeof event.parentToolCallId === "string") return [];
    const toolCallId = safeRequiredText(event.toolCallId, 128, "unknown");
    const toolName = safeRequiredText(event.toolName, 256, "tool");
    const result = isRecord(event.partialResult) ? event.partialResult : undefined;
    const publishedFile = result?.publishedFile as never;
    const showImageError = typeof result?.showImageError === "string" ? result.showImageError : undefined;
    const text = boundedContentString(redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, toolResultText(result?.content) ?? ""), publishedFile, showImageError), 256_000);
    const frames: AgentEvent[] = [];
    if (!this.announcedToolCalls.has(toolCallId)) {
      this.announcedToolCalls.add(toolCallId);
      frames.push(this.frame({ type: "tool.started", data: { toolCallId, toolName, args: {} } }));
    }
    const data = {
      toolCallId,
      text,
      ...(Array.isArray(result?.content) ? { content: projectPublicToolContent(toolName, result.content, text) } : {}),
      ...(publishedFile === undefined ? {} : { publishedFile }),
      ...(result?.presentation === undefined ? {} : { presentation: result.presentation as never }),
    };
    this.toolOutputs.set(toolCallId, data);
    const nestedCalls = this.nestedCalls.snapshot(toolCallId);
    frames.push(this.frame({ type: "tool.output_updated", data: { ...data, ...(nestedCalls === undefined ? {} : { nestedCalls }) } }));
    return frames;
  }

  private projectToolEnd(event: AgentEvent): AgentEvent[] {
    const toolCallId = safeRequiredText(event.toolCallId, 128, "unknown");
    const toolName = safeRequiredText(event.toolName, 256, "tool");
    const result = isRecord(event.result) ? event.result : undefined;
    const isError = event.isError === true;
    if (typeof event.parentToolCallId === "string") {
      const root = this.nestedCalls.end(toolCallId, isError, result?.content);
      return root === undefined ? [] : this.nestedCallsChanged(root);
    }
    const nestedCalls = this.nestedCalls.finish(toolCallId);
    this.toolOutputs.delete(toolCallId);
    const publishedFile = result?.publishedFile as never;
    const showImageError = typeof result?.showImageError === "string" ? result.showImageError : undefined;
    const text = boundedContentString(redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, toolResultText(result?.content) ?? ""), publishedFile, showImageError), 256_000);
    const projected = projectJsonObject({ content: result?.content });
    this.announcedToolCalls.delete(toolCallId);
    this.completedToolCalls.add(toolCallId);
    return [this.frame({ type: "tool.completed", data: {
      toolCallId,
      toolName,
      text,
      isError,
      ...(Array.isArray(result?.content) ? { content: projectPublicToolContent(toolName, result.content, text) } : {}),
      ...(publishedFile === undefined ? {} : { publishedFile }),
      ...(result?.presentation === undefined ? {} : { presentation: result.presentation as never }),
      ...(nestedCalls === undefined ? {} : { nestedCalls }),
      ...(projected.omittedFields.length === 0 ? {} : { omittedFields: projected.omittedFields }),
    } })];
  }

  /** Repeat the calling tool's latest output with its current list of nested calls. */
  private nestedCallsChanged(toolCallId: string): AgentEvent[] {
    const nestedCalls = this.nestedCalls.snapshot(toolCallId);
    if (nestedCalls === undefined || !this.announcedToolCalls.has(toolCallId)) return [];
    const output = this.toolOutputs.get(toolCallId) ?? { toolCallId, text: "" };
    return [this.frame({ type: "tool.output_updated", data: { ...output, nestedCalls } })];
  }

  private ensureAssistantMessageId(): string {
    this.currentAssistantMessageId ??= `assistant-${++this.messageSequence}`;
    return this.currentAssistantMessageId;
  }

  private frame(frame: ConversationFrame): AgentEvent {
    return { type: "dock_conversation_frame", frame };
  }
}

function releaseSettledWaiters(binding: Binding): void {
  for (const resolve of binding.settledWaiters.splice(0)) resolve();
}

/** Pi finished the run and extensions still handle agent_settled; it defers new input until then. */
function piIsSettling(binding: Binding): boolean {
  return binding.token.active && binding.awaitingSettled && !binding.session.isStreaming;
}

function projectHistoryEntry(
  entry: SessionEntry,
  attachmentContextKey: Uint8Array,
  publishedFiles?: TransientFileRegistry,
  earlier: ReadonlyMap<string, SessionEntry> = new Map(),
): AgentHistoryEntry {
  const base = {
    recordId: entry.id,
    entryId: entry.id,
    ...(entry.parentId === null ? {} : { parentId: entry.parentId }),
    timestamp: entry.timestamp,
  };
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "system";
    if (role === "toolResult") {
      const toolCallId = safeRequiredText(message.toolCallId, 128, `tool-${entry.id}`);
      const toolName = safeRequiredText(message.toolName, 256, "tool");
      const isError = message.isError === true;
      const publishedFile = publishedFiles === undefined ? undefined : publishedFileFromDetails(message.details, publishedFiles);
      const showImageError = publishedFiles === undefined ? undefined : publishedFileFailureFromDetails(message.details, publishedFiles);
      const text = boundedContentString(redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, toolResultText(message.content) ?? ""), publishedFile, showImageError), 256_000);
      const presentation = projectBuiltInToolPresentation(toolName, text, message.details, isError);
      const nestedCalls = projectPiNestedToolCalls(message.nestedCalls);
      let firstText = true;
      return {
        ...base,
        kind: "message",
        source: "tool",
        visibility: "conversation",
        content: boundConversationPreviewBlocks(toolResultParts(message.content).slice(0, MAX_CONVERSATION_CONTENT_BLOCKS).flatMap((part): ContentBlockDto[] => {
          if (part.type === "image") return projectDockContent([part], undefined, publishedFiles);
          const attachMetadata = firstText;
          firstText = false;
          return [{
            type: "tool_result", toolCallId, toolName, isError,
            text: boundedContentString(redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, part.text as string), publishedFile, showImageError), 256_000),
            ...(attachMetadata && publishedFile !== undefined ? { publishedFile } : {}),
            ...(attachMetadata && presentation !== undefined ? { presentation } : {}),
            ...(attachMetadata && nestedCalls !== undefined ? { nestedCalls } : {}),
          }];
        })),
        toolCallId,
        toolName,
        isError,
        ...(toolName === "show_image" ? {} : projectRecordMetadata(message.details)),
      };
    }
    if (role === "bashExecution") {
      const command = boundedContentString(message.command, MAX_BASH_COMMAND_CHARS);
      const output = boundedContentString(message.output, 256_000);
      return {
        ...base,
        kind: "bash_execution",
        source: "runtime",
        visibility: "conversation",
        content: command.length > 0 || output.length > 0
          ? [{ type: "text", text: boundedContentString(command.length > 0 ? `! ${command}${output ? `\n${output}` : ""}` : output, MAX_TEXT_CHARS) }]
          : [],
        command,
        ...(typeof message.exitCode === "number" && Number.isSafeInteger(message.exitCode) ? { exitCode: message.exitCode } : {}),
        ...(typeof message.cancelled === "boolean" ? { cancelled: message.cancelled } : {}),
        ...(typeof message.truncated === "boolean" ? { truncated: message.truncated } : {}),
        ...(typeof message.fullOutputPath === "string" ? { fullOutputPath: boundedString(message.fullOutputPath, 16_384, "") } : {}),
        ...(typeof message.excludeFromContext === "boolean" ? { excludeFromContext: message.excludeFromContext } : {}),
      };
    }
    if (role === "branchSummary") {
      const summary = boundedContentString(message.summary, MAX_TEXT_CHARS);
      return {
        ...base,
        kind: "branch_summary",
        source: "runtime",
        visibility: "conversation",
        content: summary ? [{ type: "text", text: summary }] : [],
        ...(typeof message.fromId === "string" ? { fromEntryId: safeRequiredText(message.fromId, 128, "unknown") } : {}),
      };
    }
    if (role === "compactionSummary") {
      const summary = boundedContentString(message.summary, MAX_TEXT_CHARS);
      return {
        ...base,
        kind: "compaction_summary",
        source: "runtime",
        visibility: "conversation",
        content: summary ? [{ type: "text", text: summary }] : [],
        ...(typeof message.tokensBefore === "number" && Number.isSafeInteger(message.tokensBefore) && message.tokensBefore >= 0 ? { tokensBefore: message.tokensBefore } : {}),
      };
    }
    if (message.role === "system") {
      // Pi 0.99 records system prompt and tool changes as system messages, not conversation.
      return {
        ...base,
        kind: "message",
        source: "system",
        visibility: "metadata",
        // The names say what changed; the texts (often the whole prompt and every tool) are read on demand.
        content: [],
        systemPrompt: projectSystemPromptChange(message),
      };
    }
    const custom = role === "custom";
    const userProjection = role === "user" ? projectDockUserContent(message.content, attachmentContextKey, publishedFiles) : undefined;
    return {
      ...base,
      kind: custom ? "custom_message" : "message",
      source: custom ? "extension" : role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
      visibility: custom && message.display === false ? "hidden" : "conversation",
      content: userProjection?.content ?? projectDockContent(message.content, undefined, publishedFiles),
      ...(userProjection?.attachments === undefined ? {} : { attachments: userProjection.attachments }),
      ...(typeof message.stopReason === "string" ? { stopReason: boundedString(message.stopReason, 128, "unknown") } : {}),
      ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      ...(custom && typeof message.customType === "string" ? { customType: boundedString(message.customType, 256, "custom") } : {}),
      ...(custom && typeof message.display === "boolean" ? { display: message.display } : {}),
      ...projectRecordMetadata(message.details),
    };
  }
  if (entry.type === "custom_message") {
    return {
      ...base,
      kind: "custom_message",
      source: "extension",
      visibility: entry.display ? "conversation" : "hidden",
      content: projectDockContent(entry.content, undefined, publishedFiles),
      customType: boundedString(entry.customType, 256, "custom"),
      display: entry.display,
      ...projectRecordMetadata(entry.details),
    };
  }
  if (entry.type === "custom") {
    return {
      ...base,
      kind: "custom",
      source: "extension",
      visibility: "metadata",
      content: [],
      customType: boundedString(entry.customType, 256, "custom"),
      ...projectRecordMetadata(entry.data),
    };
  }
  if (entry.type === "thinking_level_change") {
    return { ...base, kind: "thinking_level_change", source: "runtime", visibility: "metadata", content: [], thinkingLevel: boundedString(entry.thinkingLevel, 64, "off") };
  }
  if (entry.type === "model_change") {
    return {
      ...base,
      kind: "model_change",
      source: "runtime",
      visibility: "metadata",
      content: [],
      provider: boundedString(entry.provider, 256, "unknown"),
      modelId: boundedString(entry.modelId, 512, "unknown"),
    };
  }
  if (entry.type === "compaction") {
    return {
      ...base,
      kind: "compaction_summary",
      source: "runtime",
      visibility: "conversation",
      content: entry.summary ? [{ type: "text", text: boundedContentString(entry.summary, MAX_TEXT_CHARS) }] : [],
      firstKeptEntryId: boundedString(entry.firstKeptEntryId, 128, "unknown"),
      tokensBefore: Math.max(0, Math.floor(entry.tokensBefore)),
      ...projectRecordMetadata(entry.details),
    };
  }
  if (entry.type === "branch_summary") {
    return {
      ...base,
      kind: "branch_summary",
      source: "runtime",
      visibility: "conversation",
      content: entry.summary ? [{ type: "text", text: boundedContentString(entry.summary, MAX_TEXT_CHARS) }] : [],
      fromEntryId: boundedString(entry.fromId, 128, "unknown"),
      ...projectRecordMetadata(entry.details),
    };
  }
  if (entry.type === "session_info") {
    return {
      ...base,
      kind: "session_info",
      source: "runtime",
      visibility: "metadata",
      content: [],
      ...(entry.name === undefined ? {} : { name: boundedString(entry.name, 256, "") }),
    };
  }
  if (entry.type === "label") {
    return {
      ...base,
      kind: "label",
      source: "runtime",
      visibility: "metadata",
      content: [],
      targetEntryId: boundedString(entry.targetId, 128, "unknown"),
      ...(entry.label === undefined ? {} : { label: boundedString(entry.label, 256, "") }),
    };
  }
  // Pi 0.99 usage and context-edit records have no Protocol V2 kind of their own:
  // they are runtime custom records that carry their facts in typed fields.
  const runtime = { ...base, kind: "custom", source: "runtime", visibility: "metadata", customType: boundedString(entry.type, 256, "runtime") } as const;
  if (entry.type === "usage") {
    return {
      ...runtime,
      content: [],
      provider: boundedString(entry.provider, 256, "unknown"),
      modelId: boundedString(entry.model, 512, "unknown"),
      usage: projectRecordUsage(entry),
    };
  }
  if (entry.type === "context_edit") {
    const replaced = contextEditReplacement(entry, earlier);
    return {
      ...runtime,
      content: replaced === undefined ? [] : projectHistoryEntry(replaced, attachmentContextKey, publishedFiles).content.map(recordedToolText),
      targetEntryId: boundedString(entry.targetId, 128, "unknown"),
      contextEdit: entry.replacement === null ? "omit" : "replace",
    };
  }
  return { ...runtime, content: [] };
}

/**
 * The edited entry with the replacement as its content, so the replacement is shown (and
 * attachment context or private paths removed) exactly as the original would be.
 */
function contextEditReplacement(entry: Extract<SessionEntry, { type: "context_edit" }>, earlier: ReadonlyMap<string, SessionEntry>): SessionEntry | undefined {
  const target = earlier.get(entry.targetId);
  if (entry.replacement === null || target === undefined) return undefined;
  if (target.type === "message") return { ...target, message: { ...target.message, content: entry.replacement.content } as typeof target.message };
  if (target.type === "custom_message") return { ...target, content: entry.replacement.content as typeof target.content };
  return undefined;
}

/**
 * Replacement content is text about a tool, not the tool call or result itself: an edit made
 * long after its target must not join the tool's history page unit. A tool result preview may
 * be far longer than a text preview; as text it keeps the text preview bound and the rest is
 * read through the record's content reference.
 */
function recordedToolText(block: ContentBlockDto): ContentBlockDto {
  if (block.type === "tool_result") return { type: "text", text: boundedContentString(block.text, MAX_TEXT_CHARS) };
  if (block.type === "tool_call") return { type: "text", text: boundedContentString(`${block.toolName} ${JSON.stringify(block.args)}`, MAX_TEXT_CHARS) };
  return block;
}

/**
 * The texts a system prompt record carries, each with what it is: the instruction text, each
 * section the record sets to a non-empty text, then each added tool's definition, in record order.
 */
function systemPromptBlocks(message: Record<string, unknown>): Array<{ block: SystemPromptBlockDto; text: string }> {
  const blocks: Array<{ block: SystemPromptBlockDto; text: string }> = [];
  const name = (value: unknown): string => safeRequiredText(value, MAX_SYSTEM_PROMPT_NAME_CHARS, "unnamed");
  const instructions = typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n")
      : "";
  if (instructions.length > 0) blocks.push({ block: { kind: "instructions" }, text: instructions });
  if (isRecord(message.sections)) {
    for (const [section, text] of Object.entries(message.sections)) {
      if (typeof text === "string" && text.length > 0) blocks.push({ block: { kind: "section", name: name(section) }, text });
    }
  }
  for (const tool of Array.isArray(message.toolsAdded) ? message.toolsAdded : []) {
    if (!isRecord(tool)) continue;
    let text: string;
    try {
      text = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2);
    } catch {
      text = JSON.stringify({ name: tool.name });
    }
    blocks.push({ block: { kind: "tool", name: name(tool.name) }, text });
  }
  return blocks.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS);
}

function systemPromptTexts(message: Record<string, unknown>): string[] {
  return systemPromptBlocks(message).map((item) => item.text);
}

function projectSystemPromptChange(message: Record<string, unknown>): SystemPromptChangeDto {
  const sections = isRecord(message.sections) ? Object.entries(message.sections) : [];
  const names = (values: unknown[]): string[] => values.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS)
    .map((value) => safeRequiredText(value, MAX_SYSTEM_PROMPT_NAME_CHARS, "unnamed"));
  const toolNames = (value: unknown): string[] => names(Array.isArray(value) ? value.map((tool) => isRecord(tool) ? tool.name : undefined) : []);
  return {
    sections: names(sections.filter(([, text]) => typeof text === "string").map(([name]) => name)),
    removedSections: names(sections.filter(([, text]) => text === null).map(([name]) => name)),
    toolsAdded: toolNames(message.toolsAdded),
    toolsRemoved: toolNames(message.toolsRemoved),
    blocks: systemPromptBlocks(message).map((item) => item.block),
  };
}

function projectRecordUsage(entry: Extract<SessionEntry, { type: "usage" }>): RecordUsageDto {
  const usage = isRecord(entry.usage) ? entry.usage as unknown as Record<string, unknown> : {};
  const cost = isRecord(usage.cost) ? usage.cost : {};
  const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const tokens = { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) };
  const note = safeOptionalText(entry.note, MAX_RECORD_USAGE_TEXT_CHARS);
  return {
    kind: safeRequiredText(entry.kind, MAX_RECORD_USAGE_TEXT_CHARS, "usage"),
    tokens: { ...tokens, total: count(usage.totalTokens) || tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
    cost: typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total >= 0 ? cost.total : 0,
    ...(note === undefined ? {} : { note }),
  };
}

function projectDockUserContent(content: unknown, attachmentContextKey: Uint8Array, publishedFiles?: TransientFileRegistry): { content: ContentBlockDto[]; attachments?: AttachmentDto[] } {
  if (typeof content === "string") {
    const extracted = extractDockAttachmentContext(content, attachmentContextKey);
    return { content: projectDockContent(extracted.text, undefined, publishedFiles), ...(extracted.attachments === undefined ? {} : { attachments: extracted.attachments }) };
  }
  if (!Array.isArray(content)) return { content: projectDockContent(content, undefined, publishedFiles) };
  let attachments: AttachmentDto[] | undefined;
  const visible = content.map((item) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return item;
    const extracted = extractDockAttachmentContext(item.text, attachmentContextKey);
    if (extracted.attachments === undefined) return item;
    attachments = extracted.attachments;
    return { ...item, text: extracted.text };
  });
  return { content: projectDockContent(visible, attachments, publishedFiles), ...(attachments === undefined ? {} : { attachments }) };
}

function projectPublicToolContent(toolName: string, content: unknown, redactedText: string): ContentBlockDto[] {
  if (toolName === "show_image" || toolName === DOCK_ATTACHMENT_RESOLVE_TOOL) {
    return redactedText.length === 0 ? [] : [{ type: "text", text: redactedText }];
  }
  return projectDockContent(content);
}

function projectDockContent(content: unknown, attachments?: readonly AttachmentDto[], publishedFiles?: TransientFileRegistry): ContentBlockDto[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: boundedContentString(content, MAX_TEXT_CHARS) }] : [];
  if (!Array.isArray(content)) return [];
  const imageAttachments = new Map<string, AttachmentDto[]>();
  for (const attachment of attachments ?? []) {
    if (safeImageMimeType(attachment.mediaType) !== attachment.mediaType) continue;
    const key = `${attachment.sha256}\u0000${attachment.mediaType}`;
    const matches = imageAttachments.get(key) ?? [];
    matches.push(attachment);
    imageAttachments.set(key, matches);
  }
  const blocks: ContentBlockDto[] = [];
  for (const item of content.slice(0, MAX_CONVERSATION_CONTENT_BLOCKS)) {
    if (!isRecord(item)) continue;
    let block: ContentBlockDto | undefined;
    if (item.type === "text" && typeof item.text === "string") block = { type: "text", text: boundedContentString(item.text, MAX_TEXT_CHARS) };
    else if (item.type === "thinking" && typeof item.thinking === "string") block = { type: "thinking", text: boundedContentString(item.thinking, MAX_TEXT_CHARS) };
    else if (item.type === "image") {
      const mimeType = safeImageMimeType(item.mimeType);
      const registered = registerConversationImage(publishedFiles, typeof item.data === "string" ? item.data : undefined, mimeType, item);
      const sha256 = typeof item.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256)
        ? item.sha256
        : registered?.sha256 ?? (typeof item.data === "string" ? imageBase64Metadata(item.data)?.sha256 : undefined);
      const contentRef = typeof item.contentRef === "string"
        ? safeRequiredText(item.contentRef, 128, "unknown")
        : registered?.contentRef;
      const matches = sha256 === undefined ? undefined : imageAttachments.get(`${sha256}\u0000${mimeType}`);
      const fileId = matches?.shift()?.fileId;
      block = {
        type: "image",
        mimeType,
        ...(contentRef === undefined ? {} : { contentRef }),
        ...(fileId === undefined ? {} : { fileId }),
      };
    }
    else if ((item.type === "toolCall" || item.type === "tool_call") && typeof item.name === "string") {
      const projected = projectJsonObject(item.arguments);
      block = {
        type: "tool_call",
        toolCallId: safeRequiredText(item.id, 128, "unknown"),
        toolName: safeRequiredText(item.name, 256, "tool"),
        args: projected.value,
        ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
      };
    }
    if (block === undefined) continue;
    blocks.push(block);
  }
  return boundConversationPreviewBlocks(blocks);
}

function boundConversationPreviewBlocks(blocks: ContentBlockDto[]): ContentBlockDto[] {
  // Reserve tool and media identities before spending bytes in source order.
  // If arguments/text no longer fit, emit their slim identity, never lose the
  // tool edge that both Host and Worker semantic pagination depend on.
  const identities = blocks.map(slimSemanticHistoryBlock);
  const size = (block: ContentBlockDto | undefined): number => block === undefined ? 0 : Buffer.byteLength(JSON.stringify(block), "utf8") + 1;
  let remaining = 512_000 - 2 - identities.reduce((total, block) => total + size(block), 0);
  return blocks.flatMap((block, index) => {
    const identity = identities[index];
    const extra = size(block) - size(identity);
    if (extra <= remaining) { remaining -= extra; return [block]; }
    return identity === undefined ? [] : [identity];
  });
}

function projectRecordMetadata(value: unknown): { metadata?: JsonValue; metadataOmittedFields?: string[] } {
  if (value === undefined) return {};
  const projected = projectJsonObject({ value });
  const metadata = projected.value.value;
  return {
    ...(metadata === undefined ? {} : { metadata }),
    ...(projected.omittedFields.length === 0 ? {} : {
      metadataOmittedFields: projected.omittedFields.map((path) => path === "/value" ? "/" : path.replace(/^\/value/u, "")),
    }),
  };
}

type ConversationTextSourceBlock = { type: "text" | "thinking"; text: string };
type ConversationOmittedSourceBlock = { type: "omitted"; kind: "image" | "binary"; description: string };
type ConversationSourceBlock =
  | ConversationTextSourceBlock
  | { type: "image"; mimeType: string; data: string; contentRef?: string; fileId?: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; argumentsJson: string }
  | { type: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean; publishedFile?: PublishedFileDto; nestedCalls?: NestedToolCallsDto; omittedFields?: string[] }
  | ConversationOmittedSourceBlock;

/** Whether a conversation.content page with these chunks stays within the Worker's page bound. */
function contentPageFits(revision: string, contentRef: string, chunks: readonly AgentConversationContentChunk[]): boolean {
  const page = { revision, contentRef, chunks, complete: false, nextCursor: randomUUID() };
  return Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_CONVERSATION_CONTENT_PAGE_BYTES;
}

function conversationContentBlocks(
  entry: SessionEntry,
  projected: AgentHistoryEntry,
  attachmentContextKey: Uint8Array,
  publishedFiles: TransientFileRegistry,
  earlier: ReadonlyMap<string, SessionEntry> = new Map(),
): ConversationSourceBlock[] {
  if (entry.type === "context_edit") {
    const replaced = contextEditReplacement(entry, earlier);
    return replaced === undefined ? [] : conversationContentBlocks(replaced, projectHistoryEntry(replaced, attachmentContextKey, publishedFiles), attachmentContextKey, publishedFiles)
      .map((block): ConversationSourceBlock => block.type === "tool_result" ? { type: "text", text: block.text }
        : block.type === "tool_call" ? { type: "text", text: `${block.toolName} ${block.argumentsJson}` } : block);
  }
  // Reuse canonical image identities in source order, independently of text clipping.
  const images = projected.content.filter((block) => block.type === "image")[Symbol.iterator]();
  const imageSource = (item: Record<string, unknown>): Extract<ConversationSourceBlock, { type: "image" }> => {
    const contentRef = publishedFiles.imageReference(item);
    return {
      ...conversationImageSource(item),
      ...(contentRef === undefined ? {} : { contentRef }),
      ...images.next().value,
    };
  };
  const omitted = (kind: "image" | "binary", description: string): ConversationOmittedSourceBlock => ({ type: "omitted", kind, description });
  const text = (type: "text" | "thinking", value: unknown): ConversationTextSourceBlock | undefined => (
    typeof value === "string" && value.length > 0 ? { type, text: value } : undefined
  );
  const textBlocks = (type: "text" | "thinking", value: unknown): ConversationSourceBlock[] => {
    const block = text(type, value);
    return block === undefined ? [] : [block];
  };
  if (entry.type === "compaction" || entry.type === "branch_summary") return textBlocks("text", entry.summary);
  if (entry.type === "thinking_level_change" || entry.type === "model_change" || entry.type === "session_info") {
    return [];
  }
  let content = entry.type === "custom_message"
    ? entry.content
    : entry.type === "message"
      ? (entry.message as unknown as Record<string, unknown>).content
      : undefined;
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "system") return systemPromptTexts(message).flatMap((value) => textBlocks("text", value));
    const role = typeof message.role === "string" ? message.role : "system";
    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      return textBlocks("text", command.length > 0 ? `! ${command}${output ? `\n${output}` : ""}` : output);
    }
    if (role === "branchSummary" || role === "compactionSummary") return textBlocks("text", message.summary);
    if (role === "toolResult") {
      const toolCallId = typeof message.toolCallId === "string" ? boundedString(message.toolCallId, 128, "unknown") : "unknown";
      const toolName = typeof message.toolName === "string" ? boundedString(message.toolName, 256, "tool") : "tool";
      const isError = message.isError === true;
      const projectedToolResult = projected.content.find((block) => block.type === "tool_result");
      let firstText = true;
      return toolResultParts(message.content).map((part): ConversationSourceBlock => {
        if (part.type === "image") return imageSource(part);
        const attachMetadata = firstText;
        firstText = false;
        return {
          type: "tool_result", toolCallId, toolName, isError,
          text: redactShowImageResult(toolName, redactDockAttachmentToolResult(toolName, part.text as string),
            projectedToolResult?.publishedFile, projectedToolResult?.text ?? SHOW_IMAGE_UNAVAILABLE_MESSAGE),
          ...(attachMetadata && projectedToolResult?.publishedFile !== undefined ? { publishedFile: projectedToolResult.publishedFile } : {}),
          ...(attachMetadata && projectedToolResult?.nestedCalls !== undefined ? { nestedCalls: projectedToolResult.nestedCalls } : {}),
        };
      });
    }
    if (role === "user") content = stripDockAttachmentContext(content, attachmentContextKey);
  }
  const items = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  return items.flatMap((item): ConversationSourceBlock[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text") return textBlocks("text", item.text);
    if (item.type === "thinking") return textBlocks("thinking", item.thinking);
    if (item.type === "image") return [imageSource(item)];
    if ((item.type === "toolCall" || item.type === "tool_call") && typeof item.name === "string") {
      try {
        const argumentsJson = JSON.stringify(item.arguments ?? {});
        return [{
          type: "tool_call",
          toolCallId: safeRequiredText(item.id, 128, "unknown"),
          toolName: safeRequiredText(item.name, 256, "tool"),
          argumentsJson,
        }];
      } catch {
        return [omitted("binary", "Unserializable tool arguments omitted")];
      }
    }
    return [];
  });
}

/** Preserve image/text ordering; only neighboring text items share a result block. */
function toolResultParts(content: unknown): Record<string, unknown>[] {
  const items = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const parts: Record<string, unknown>[] = [];
  let hasText = false;
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "image") parts.push(item);
    else if (item.type === "text" && typeof item.text === "string") {
      const previous = parts.at(-1);
      if (previous?.type === "text") previous.text = `${previous.text}${item.text}`;
      else parts.push({ type: "text", text: item.text });
      hasText = true;
    }
  }
  // Image-only tools still need their tool-result identity, not invented text.
  if (!hasText) parts.unshift({ type: "text", text: "" });
  return parts;
}

function conversationImageSource(item: Record<string, unknown>): Extract<ConversationSourceBlock, { type: "image" }> {
  const mimeType = safeImageMimeType(item.mimeType);
  const data = typeof item.data === "string" ? item.data : "";
  return { type: "image", mimeType, data };
}

function stripDockAttachmentContext(content: unknown, attachmentContextKey: Uint8Array): unknown {
  if (typeof content === "string") return extractDockAttachmentContext(content, attachmentContextKey).text;
  if (!Array.isArray(content)) return content;
  return content.map((item) => (
    isRecord(item) && item.type === "text" && typeof item.text === "string"
      ? { ...item, text: extractDockAttachmentContext(item.text, attachmentContextKey).text }
      : item
  ));
}

/** Exact content comparison after every preview transform; metadata is separate. */
function conversationPreviewIsComplete(blocks: readonly ConversationSourceBlock[], entry: AgentHistoryEntry, view?: "references"): boolean {
  if (blocks.length !== entry.content.length) return false;
  return blocks.every((source, index) => {
    const preview = entry.content[index]!;
    if (source.type !== preview.type) return false;
    switch (source.type) {
      case "text": case "thinking":
        return (preview.type === "text" || preview.type === "thinking") && source.text === preview.text;
      case "image":
        // Legacy readers only fetch original image bytes when this is false.
        // A descriptor enables the separate image path, but is not an inline
        // complete preview for consumers of conversation.content.
        return view === "references" && preview.type === "image"
          && source.mimeType === preview.mimeType && source.contentRef === preview.contentRef && source.fileId === preview.fileId;
      case "tool_call":
        return preview.type === "tool_call" && !preview.omittedFields?.length
          && source.argumentsJson === JSON.stringify(preview.args);
      case "tool_result":
        return preview.type === "tool_result" && !preview.omittedFields?.length && source.text === preview.text
          && JSON.stringify(source.publishedFile) === JSON.stringify(preview.publishedFile)
          && JSON.stringify(source.nestedCalls) === JSON.stringify(preview.nestedCalls);
      case "omitted":
        return preview.type === "omitted" && preview.kind === source.kind && preview.description === source.description;
    }
  });
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

function unicodeSafeEnd(value: string, requestedEnd: number): number {
  return requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
}

function conversationContentRef(sessionId: string, entryId: string): string {
  return createHash("sha256").update(sessionId).update("\u0000").update(entryId).digest("hex");
}

function trimTokenMap<T>(map: Map<string, T>, max = 8_192): void {
  while (map.size > max) map.delete(map.keys().next().value as string);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

/**
 * conversation.history entries carry bounded previews; complete content is read
 * through conversation.content refs. This is the only preview projection point.
 */
function previewConversationEntry(entry: AgentHistoryEntry): AgentHistoryEntry {
  const content: AgentHistoryEntry["content"] = [];
  let remaining = 4_000;
  for (const [index, block] of entry.content.entries()) {
    // Media identities remain visible even after text/block preview limits.
    if (index >= 16 && block.type !== "image" && block.type !== "tool_call" && block.type !== "tool_result") continue;
    if (block.type === "text" || block.type === "thinking") {
      const text = block.text.length <= remaining ? block.text : block.text.slice(0, unicodeSafeEnd(block.text, remaining));
      if (text.length > 0) content.push({ type: block.type, text });
      remaining = Math.max(0, remaining - text.length);
    } else if (block.type === "tool_call") {
      const size = JSON.stringify(block.args).length;
      if (size <= remaining) {
        content.push(block);
        remaining -= size;
      } else content.push(slimSemanticHistoryBlock(block)!);
    } else if (block.type === "tool_result") {
      const text = block.text.length <= remaining ? block.text : block.text.slice(0, unicodeSafeEnd(block.text, remaining));
      const { presentation: _presentation, ...metadata } = block;
      content.push(text === block.text ? block : { ...metadata, text });
      remaining = Math.max(0, remaining - text.length);
    } else {
      content.push(block);
    }
  }
  return { ...entry, content };
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
  const planGoalStart: PlanGoalStart = {};
  const attachmentContextKey = await loadAttachmentContextKey(options.agentDir);
  const publishedFiles = new TransientFileRegistry();
  const uiContext = options.extensionUiBroker && !options.extensionUiContextPortFactory
    ? createPiExtensionUiContext(options.extensionUiBroker)
    : undefined;
  const createUiContext = options.extensionUiContextPortFactory
    ? () => createPiExtensionUiContext(options.extensionUiContextPortFactory!())
    : undefined;
  const trustByCwd = new Map<string, boolean>([[options.cwd, options.projectTrusted]]);
  const systemPromptResolver = piSystemPromptResolver(options.workerConfig, options.agentDir);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const canonicalCwd = await realpath(resolve(cwd));
    const settingsManager = SettingsManager.create(canonicalCwd, agentDir, {
      projectTrusted: trustByCwd.get(canonicalCwd) ?? false,
    });
    configurePiNetwork(settingsManager);
    const services = await createAgentSessionServices({
      cwd: canonicalCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        ...(systemPromptResolver === undefined ? {} : { systemPromptResolver }),
        extensionFactories: [
          { name: "alu-dock-tool-result-normalizer", factory: piToolResultNormalizerExtension },
          { name: "alu-dock-retry", factory: retryExtension },
          { name: "alu-dock-plan-goal", factory: planGoalExtension(planGoalStart) },
          { name: "alu-dock-show-image", factory: showImageExtension(publishedFiles) },
          ...(options.dockToolsBridge === undefined ? [] : [{ name: "alu-dock-tools", factory: dockToolsExtension(options.dockToolsBridge) }]),
          ...(options.dockAttachmentPort === undefined ? [] : [{ name: "alu-dock-attachments", factory: dockAttachmentsExtension(options.dockAttachmentPort) }]),
          ...piBuiltinExtensions(),
        ],
        extensionsOverride: ownCanonicalShowImage,
        appendSystemPromptOverride: (base) => [...base, ALU_DOCK_PI_WORKER_GUIDANCE],
        ...(options.dockAttachmentPort === undefined ? {} : {
          additionalSkillPaths: [dockAttachmentSkillPath()],
        }),
      },
    });
    // `model` is a Dock `{provider, id}` reference, not Pi's Model object; resolve it here.
    const { model: requestedModel, ...piCreateOptions } = (options.workerConfig ?? {}) as unknown as Partial<Parameters<typeof createAgentSessionFromServices>[0]>;
    const startingModel = await resolvePiStartingModel(requestedModel, services.modelRuntime, sessionManager);
    const result = await createAgentSessionFromServices({
      ...piCreateOptions,
      ...(startingModel === undefined ? {} : { model: startingModel }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.excludeTools === undefined ? {} : { excludeTools: options.excludeTools }),
      // Worker-owned services and Session continuity cannot be replaced by wire JSON.
      services,
      sessionManager,
      sessionStartEvent,
      // Preserve existing plugin preferences; wire JSON cannot disable this contract.
      extensionModelMutationPolicy: "legacy-defaults",
    });
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
    planGoalStart,
    runtime,
    extensionUiBroker: options.extensionUiBroker,
    uiContext,
    uiContextFactory: createUiContext,
    setProjectTrust: (cwd, trusted) => trustByCwd.set(cwd, trusted),
    configureNetwork: configurePiNetwork,
    initialProcessCwd: options.cwd,
    attachmentContextKey,
    publishedFiles,
    ...(options.dockAttachmentPort === undefined ? {} : { dockAttachmentPort: options.dockAttachmentPort }),
    ...(options.setProcessCwd === undefined ? {} : { setProcessCwd: options.setProcessCwd }),
  });
}

async function loadAttachmentContextKey(agentDir: string): Promise<Buffer> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const keyPath = join(agentDir, ".alu-dock-attachment-context-key");
  for (;;) {
    try {
      const handle = await open(keyPath, fsConstants.O_RDONLY | noFollowFlag());
      try {
        const details = await handle.stat();
        const getuid = process.getuid;
        if (!details.isFile() || (typeof getuid === "function" && details.uid !== getuid())) {
          throw new Error("Dock attachment context key is not a regular user-owned file");
        }
        await hardenWindowsPrivatePath(keyPath, false);
        await handle.chmod(0o600);
        const encoded = (await handle.readFile("utf8")).trim();
        const key = Buffer.from(encoded, "base64");
        if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("Dock attachment context key is invalid");
        return key;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = randomBytes(32);
    try {
      const handle = await open(keyPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
      try {
        await handle.writeFile(`${key.toString("base64")}\n`, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await hardenWindowsPrivatePath(keyPath, false);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
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
