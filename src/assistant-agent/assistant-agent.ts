import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { Agent, type AgentEvent as LoopEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  createInitialSystemMessage,
  getSupportedThinkingLevels,
  isContextOverflow,
  isRetryableAssistantError,
  toToolDeclaration,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type TextContent,
} from "@earendil-works/pi-ai";
import { convertToLlm, ModelRuntime, SessionManager, SettingsManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  AgentCompactionKnownFailureError,
  AgentInvalidDeliveryModeError,
  AgentModelNotFoundError,
  AgentQueueRejectedBeforeEffectError,
  THINKING_LEVELS,
  type AgentCleanupResult,
  type AgentCommandPreflightResult,
  type AgentEvent,
  type AgentInvokeContext,
  type AgentModelState,
  type AgentRequest,
  type AgentSessionMetrics,
  type AgentWorkerControl,
  type AgentWorkerState,
  type ClearedAgentQueue,
  type ThinkingLevel,
} from "../core/agent-worker.js";
import type { JsonObject } from "../core/json-value.js";
import { mainModelOwner } from "../model-service/owner.js";
import { configurePiNetwork } from "../pi/configure-pi-network.js";
import { appendDockAttachmentContext } from "../pi/dock-attachment-context.js";
import {
  loadAttachmentContextKey,
  loadPiImages,
  PiConversationProjector,
  PiSessionConversation,
  projectAgentSessionEvents,
  resolveAttachmentImages,
} from "../pi/pi-conversation.js";
import { projectPiModelList } from "../pi/pi-model-list.js";
import { resolvePiStartingModel } from "../pi/pi-starting-model.js";
import { TransientFileRegistry } from "../pi/transient-file-registry.js";
import type { WorkerAgent, WorkerHost } from "../worker/worker-shell.js";
import { memoryTools } from "./memory-tools.js";
import { AssistantOpening } from "./opening.js";
import { SessionRecorder, type AssistantCallPort } from "./recorder.js";

/** What the Host gives her Worker to start with. */
export interface AssistantWorkerInit {
  cwd: string;
  /** Pi's agent directory: where her conversations are kept and, without Main's model service, the models are read. */
  agentDir: string;
  sessionDir?: string;
  /** The conversation to open again. */
  sessionFile?: string;
  initialName?: string;
  workerConfig?: JsonObject;
}

/** A reply that failed for a passing reason is asked for again this many times, waiting longer each time. */
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];
/** A Work that is stopping waits this long at most for her last words to reach Main. */
const SHUTDOWN_SYNC_MS = 1_000;

/** One message the owner (or another Work, through her input) sent while she was replying. */
interface QueuedInput {
  operationId: string;
  delivery: "steer" | "followUp";
  text: string;
  message: AgentMessage;
}

const NO_OTHER_SESSION = "助手的对话是一条连续的线，不能新建、切换、分叉或回到某一点。想从头开始，就停掉这个 Work，再以助手身份新开一个；她的记忆都还在。要让她载入刚改过的人设和记忆，用 Reload。";

/**
 * The personal assistant's own Agent (card #667). She is not a Pi coding Work: she keeps a
 * conversation in Pi's session format and asks the model through Pi's model runtime and loop, but
 * has no project context, extensions, shell or file tools of her own.
 */
export async function createAssistantAgent(init: AssistantWorkerInit, host: WorkerHost): Promise<WorkerAgent> {
  const assistant = host.assistant;
  if (!assistant) throw new Error("This Work was not opened as the assistant");
  const cwd = resolve(init.cwd);
  const agentDir = resolve(init.agentDir);
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  // Her model calls use Pi's proxy and network settings, as every Work's do.
  configurePiNetwork(settings);
  const models = host.models
    ? await ModelRuntime.create({ owner: mainModelOwner(host.models) })
    : await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const sessionDir = init.sessionDir === undefined ? undefined : resolve(init.sessionDir);
  const session = init.sessionFile === undefined
    ? SessionManager.create(cwd, sessionDir)
    : SessionManager.open(resolve(init.sessionFile), sessionDir, cwd);
  if (init.initialName !== undefined && init.sessionFile === undefined) session.appendSessionInfo(init.initialName);
  const attachmentContextKey = await loadAttachmentContextKey(agentDir);
  const her = new AssistantAgent(cwd, host, { call: assistant }, models, settings, session, attachmentContextKey);
  await her.chooseStartingModel(init.workerConfig?.model, init.sessionFile === undefined);
  return her;
}

class AssistantAgent implements WorkerAgent {
  readonly diagnostics: string[] = [];
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private buffered: AgentEvent[] | undefined = [];
  private readonly publishedFiles = new TransientFileRegistry();
  private readonly conversation: PiSessionConversation;
  private readonly projector: PiConversationProjector;
  private readonly recorder: SessionRecorder;
  private readonly opening: AssistantOpening;
  private readonly agent: Agent;
  private readonly tools: AgentTool[];
  private model: Model<Api> | undefined;
  private thinkingLevel: ThinkingLevel = "off";
  /** The reply in progress, retries included; undefined while she is idle. */
  private running: Promise<void> | undefined;
  private runOperationId: string | undefined;
  private stopRequested = false;
  private retryWait: AbortController | undefined;
  private readonly queue: QueuedInput[] = [];
  /** The last entry already counted in `metricsValue`. */
  private countedThrough: string | undefined;
  private metricsValue: AgentSessionMetrics = {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  private lastUsageTokens: number | undefined;
  private disposed: Promise<AgentCleanupResult> | undefined;

  constructor(
    private readonly cwd: string,
    private readonly host: WorkerHost,
    port: AssistantCallPort,
    private readonly models: ModelRuntime,
    private readonly settings: SettingsManager,
    private readonly session: SessionManager,
    private readonly attachmentContextKey: Uint8Array,
  ) {
    this.conversation = new PiSessionConversation({ attachmentContextKey, publishedFiles: this.publishedFiles });
    this.projector = new PiConversationProjector(attachmentContextKey);
    const notify = (message: string): void => this.tell(message, "warning");
    this.recorder = new SessionRecorder(port, session, attachmentContextKey, undefined, notify);
    this.opening = new AssistantOpening(port, notify);
    this.tools = memoryTools({
      port, session, recorder: this.recorder, models, attachmentContextKey,
      confirm: async (title, message) => await host.call("ui.confirm", { title, message }) === true,
    });
    this.agent = new Agent({
      initialState: { tools: this.tools },
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
      convertToLlm,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: session.getSessionId(),
    });
    this.agent.subscribe((event) => this.observe(event));
  }

  get persistedName(): string | undefined { return this.session.getSessionName(); }

  // ---- What the Host asks -------------------------------------------------------------------

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state(): AgentWorkerState {
    const sessionFile = this.session.getSessionFile();
    const durable = sessionFile !== undefined && isOwnRegularFile(sessionFile);
    return {
      sessionId: this.session.getSessionId(),
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(durable ? { durableSessionFile: sessionFile } : {}),
      isStreaming: this.running !== undefined,
      isCompacting: false,
      modelState: this.modelState(),
      metrics: this.metrics(),
      extensionCommands: [],
    };
  }

  async dispatch(request: AgentRequest, context: AgentInvokeContext | undefined, preflight: (result: AgentCommandPreflightResult) => void): Promise<unknown> {
    switch (request.type) {
      case "command.submit": return this.submit(request.params, context, preflight);
      case "command.abort": await this.abort(); return null;
      case "command.abort_restore_queue": { const cleared = this.clearQueue(); await this.abort(); return cleared; }
      case "queue.dequeue": return this.clearQueue();
      case "model.list": {
        // Models and sign-ins changed on Main since the last look count from this one.
        await this.models.refresh({ allowNetwork: false }).catch(() => {});
        return { ...projectPiModelList(await this.models.getAvailable()), availableThinkingLevels: this.modelState().availableThinkingLevels };
      }
      case "model.set": return this.selectModel(request.params.provider, request.params.modelId);
      case "thinking.set": return this.selectThinkingLevel(request.params.level);
      case "session.history": return this.conversation.entries(this.session);
      case "conversation.history": return this.conversation.history(this.session, request.params.cursor, request.params.limit, request.params.view);
      case "conversation.content": return this.conversation.content(this.session, request.params.contentRef, request.params.cursor, request.params.view);
      case "conversation.image": return this.conversation.image(this.session, request.params.contentRef);
      case "session.name": {
        this.session.appendSessionInfo(request.params.name);
        const name = this.session.getSessionName();
        this.publish({ type: "session_info_changed", ...(name === undefined ? {} : { name }), operationId: request.params.operationId });
        return name;
      }
      // She has none of these: clients open her Work and show them empty.
      case "tool.list": return { tools: [], total: 0, truncated: false };
      case "settings.get": return [];
      case "resource.get": return { resources: [], diagnostics: [], resourceTotal: 0, resourcesTruncated: false, diagnosticTotal: 0, diagnosticsTruncated: false };
      case "command.catalog": return { commands: [], total: 0, truncated: false };
      case "session.list": return { sessions: [], total: 0, truncated: false };
      case "session.tree": return { nodes: [] };
      // Her conversation is one line: nothing replaces it. The request ends as cancelled, which every
      // client already shows as "nothing changed", and the owner is told why.
      case "session.new": case "session.switch": case "session.fork": case "session.clone": case "session.navigate":
        this.tell(NO_OTHER_SESSION);
        return { cancelled: true };
      case "session.reload": return this.reload(request.params.operationId);
      case "session.compact":
        this.tell("助手的对话由她自己整理，不用手动压缩。");
        throw new AgentCompactionKnownFailureError("nothing_to_compact", "The assistant keeps her own conversation short");
      case "session.compaction.prompts": throw this.notHers("助手的对话由她自己整理，没有可以查看的压缩提示。");
      case "bash.run": case "bash.abort": throw this.notHers("助手自己不跑命令。请在别的 Work 里运行。");
      case "tool.set_active": case "settings.update": case "command.content": case "command.complete":
        throw this.notHers("助手没有可以在这里调整的工具、设置或命令。");
    }
  }

  /**
   * Reload keeps her conversation and has her load her persona, the owner's notes and her memories
   * anew before her next reply: how what the owner just changed reaches a conversation that never
   * starts over.
   */
  private async reload(operationId: string): Promise<{ cancelled: boolean }> {
    if (this.running !== undefined) {
      this.tell("她正在回复，等这一轮结束再 Reload。");
      return { cancelled: true };
    }
    // Nothing of hers is on its way to Main when the Host starts counting from the reloaded conversation.
    await this.recorder.sync();
    this.opening.refresh();
    const sessionFile = this.session.getSessionFile();
    const name = this.session.getSessionName();
    this.publish({
      type: "dock_session_replaced", reason: "reload", operationId, cwd: this.cwd,
      ...(sessionFile === undefined ? {} : { previousSessionFile: sessionFile, sessionFile }),
      ...(name === undefined ? {} : { name }),
    });
    return { cancelled: false };
  }

  /** Says something to the owner outside the conversation, in whichever client is open. */
  private tell(message: string, level: "info" | "warning" = "info"): void {
    void this.host.call("ui.notify", { message, level }).catch(() => {});
  }

  /** What this kind of Work does not have: the owner is told why, and the request fails. */
  private notHers(message: string): Error {
    this.tell(message);
    return new Error(message);
  }

  async control(control: AgentWorkerControl): Promise<unknown> {
    switch (control.type) {
      case "activate": {
        const waiting = this.buffered ?? [];
        this.buffered = undefined;
        for (const event of waiting) this.publish(event);
        return null;
      }
      case "wait_for_idle": await this.running; return null;
      case "resolve_file_source": {
        if (control.kind !== "published") throw new Error("The assistant has no project resources");
        const { dto: file, source } = this.publishedFiles.resolve(control.ref);
        return { kind: "published", file, source };
      }
      case "resolve_session_target": throw this.notHers(NO_OTHER_SESSION);
      // What she and her owner said stays with her; a Work she hands something to gets it in the task.
      case "branch_for_child": throw new Error("The assistant's conversation is not copied to other Works. Put what the Work needs into its task.");
      case "observation_delivery": case "work_message":
        throw new Error("The assistant cannot take messages from other Works yet");
      case "dispose": return this.dispose();
    }
  }

  dispose(): Promise<AgentCleanupResult> {
    this.disposed ??= (async () => {
      const cleanupErrors: string[] = [];
      try { await this.abort(); } catch (error) { cleanupErrors.push(`abort: ${error instanceof Error ? error.message : String(error)}`); }
      // Her last words reach Main now when they can; otherwise the next time this conversation opens.
      await Promise.race([this.recorder.sync(), new Promise((done) => setTimeout(done, SHUTDOWN_SYNC_MS).unref())]);
      this.publishedFiles.clear();
      return { cleanupErrors };
    })();
    return this.disposed;
  }

  // ---- Messages in --------------------------------------------------------------------------

  private async submit(
    params: Extract<AgentRequest, { type: "command.submit" }>["params"],
    context: AgentInvokeContext | undefined,
    preflight: (result: AgentCommandPreflightResult) => void,
  ): Promise<null> {
    const { operationId, message, images, delivery: requested } = params;
    if (this.model === undefined) {
      preflight({ success: false });
      throw this.notHers("这个 Work 还没有可用的模型，所以这句话没有发出去。请先在模型列表里选一个，再发一遍。");
    }
    const attachments = context !== undefined && context.type !== "session_switch" ? context.attachments : undefined;
    const busy = context?.type === "defer_to_host" || this.running !== undefined;
    const delivery = requested === "auto" ? (busy ? "steer" : "prompt") : requested === "followUp" && !busy ? "prompt" : requested;
    const handedOver = context?.type === "force_queue" || context?.type === "host_queue";
    if (!handedOver && ((busy && delivery === "prompt") || (!busy && delivery !== "prompt"))) {
      preflight({ success: false });
      throw new AgentInvalidDeliveryModeError(delivery, busy);
    }
    const queueAvailable = context?.type === "command" || context?.type === "defer_to_host" ? context.queueAvailable : true;
    if (!handedOver && delivery !== "prompt" && !queueAvailable) {
      preflight({ success: false });
      throw new AgentQueueRejectedBeforeEffectError();
    }
    if (context?.type === "defer_to_host") {
      if (delivery === "prompt") throw new Error("Host-deferred input requires queued delivery");
      preflight({ success: true, inputKind: "prompt", delivery, custody: "host" });
      return null;
    }
    let content: Array<TextContent | ImageContent>;
    const modelText = attachments === undefined ? message : appendDockAttachmentContext(message, attachments, this.attachmentContextKey);
    try {
      const attached = await resolveAttachmentImages(attachments, this.host.attachments === undefined ? undefined : { access: this.host.attachments });
      const pictures = await loadPiImages(attached === undefined ? images : [...(images ?? []), ...attached]);
      content = [{ type: "text", text: modelText }, ...(pictures ?? [])];
    } catch (error) {
      preflight({ success: false });
      throw error;
    }
    const userMessage: AgentMessage = { role: "user", content, timestamp: Date.now() };
    // Decided only now, after the files were read: a reply can end while they are being read.
    // A reply that began meanwhile takes this message at its next step; one that ended lets it start the next.
    const actual = this.running === undefined ? "prompt" : delivery === "prompt" ? "steer" : delivery;
    this.projector.trackInput({
      operationId, text: message, runtimeText: modelText, delivery: actual, fromQueue: handedOver || actual !== "prompt",
      ...(images === undefined ? {} : { images }), ...(attachments === undefined ? {} : { attachments }),
    });
    preflight({ success: true, inputKind: "prompt", delivery: actual, custody: "runtime" });
    if (actual !== "prompt") {
      this.queue.push({ operationId, delivery: actual, text: modelText, message: userMessage });
      if (actual === "steer") this.agent.steer(userMessage); else this.agent.followUp(userMessage);
      this.publishQueue();
      return null;
    }
    await this.reply(operationId, [userMessage]);
    return null;
  }

  private clearQueue(): ClearedAgentQueue {
    const cleared: ClearedAgentQueue = {
      steering: this.queue.filter((item) => item.delivery === "steer").map((item) => item.text),
      followUp: this.queue.filter((item) => item.delivery === "followUp").map((item) => item.text),
    };
    this.queue.length = 0;
    this.agent.clearAllQueues();
    this.projector.clearQueuedInputs(cleared);
    this.publishQueue();
    return cleared;
  }

  private publishQueue(): void {
    const texts = (delivery: "steer" | "followUp"): string[] => this.queue.filter((item) => item.delivery === delivery).map((item) => item.text);
    const steering = texts("steer"), followUp = texts("followUp");
    this.projector.observeQueueUpdate(steering, followUp);
    this.publish({ type: "queue_update", steering, followUp });
  }

  private async abort(): Promise<void> {
    if (this.running === undefined) return;
    this.stopRequested = true;
    this.retryWait?.abort();
    this.agent.abort();
    await this.running;
  }

  // ---- One reply ----------------------------------------------------------------------------

  /**
   * Runs her loop for these messages until she has nothing more to say. A reply that failed for a
   * passing reason is asked for again, and what was sent while she replied starts the next reply,
   * also after a stop, as in Pi.
   */
  private reply(operationId: string | undefined, messages: AgentMessage[]): Promise<void> {
    if (this.running !== undefined) throw new Error("The assistant is already replying");
    this.runOperationId = operationId;
    this.stopRequested = false;
    const run = (async () => {
      const model = this.model;
      if (model === undefined) return;
      void this.recorder.sync();
      await this.leadWithOpening();
      this.agent.state.model = model;
      this.agent.state.thinkingLevel = clampThinkingLevel(model, this.thinkingLevel);
      await this.agent.prompt(messages);
      let attempt = 0;
      for (;;) {
        const last = this.lastAssistantMessage();
        if (last !== undefined && !this.stopRequested && attempt < RETRY_DELAYS_MS.length && this.passingFailure(last, model)) {
          const delayMs = RETRY_DELAYS_MS[attempt]!;
          attempt += 1;
          this.publish({ type: "auto_retry_start", attempt, maxAttempts: RETRY_DELAYS_MS.length, delayMs, errorMessage: last.errorMessage ?? "Unknown error" });
          // The failed attempt stays in the conversation and leaves what the model is given.
          this.leaveOutOfContext(last);
          if (await this.waitBeforeRetry(delayMs)) { await this.agent.continue(); continue; }
          this.publish({ type: "auto_retry_end", success: false, attempt, finalError: "Retry cancelled" });
          attempt = 0;
        } else if (attempt > 0) {
          const failed = last?.stopReason === "error";
          this.publish({ type: "auto_retry_end", success: !failed, attempt, ...(failed && last.errorMessage !== undefined ? { finalError: last.errorMessage } : {}) });
          attempt = 0;
        }
        if (!this.agent.hasQueuedMessages()) break;
        this.stopRequested = false;
        await this.agent.continue();
      }
    })().catch((error: unknown) => error instanceof Error ? error.message : String(error)).then((failure) => {
      const settledOperationId = this.runOperationId;
      const aborted = this.stopRequested;
      this.running = undefined;
      this.runOperationId = undefined;
      this.stopRequested = false;
      for (const event of this.projector.project({
        type: "agent_settled",
        ...(settledOperationId === undefined ? {} : { operationId: settledOperationId }),
        ...(aborted ? { aborted: true } : {}),
      })) {
        this.publish(typeof failure === "string" ? { ...event, stopReason: "error", error: failure } : event);
      }
      this.publish(this.checkpoint());
      void this.recorder.sync();
    });
    this.running = run;
    return run;
  }

  /** Her opening leads what the model is given; the conversation follows as the session holds it. */
  private async leadWithOpening(): Promise<void> {
    const { text, changed } = await this.opening.text();
    const messages = this.agent.state.messages;
    if (!changed && messages[0]?.role === "system") return;
    const opening = createInitialSystemMessage(text, this.tools.map(toToolDeclaration));
    const conversation = this.session.buildSessionContext().messages.filter((message) => message.role !== "system");
    this.agent.state.messages = opening === undefined ? conversation : [opening, ...conversation];
  }

  private lastAssistantMessage(): AssistantMessage | undefined {
    const last = this.agent.state.messages.at(-1);
    return last?.role === "assistant" ? last : undefined;
  }

  private passingFailure(message: AssistantMessage, model: Model<Api>): boolean {
    return !isContextOverflow(message, model.contextWindow) && isRetryableAssistantError(message);
  }

  private leaveOutOfContext(failed: AssistantMessage): void {
    const messages = this.agent.state.messages;
    if (messages.at(-1) === failed) this.agent.state.messages = messages.slice(0, -1);
    const entry = this.session.getLeafEntry();
    if (entry?.type === "message" && entry.message === failed) this.session.appendContextEdit(entry.id, null);
  }

  private waitBeforeRetry(delayMs: number): Promise<boolean> {
    const wait = new AbortController();
    this.retryWait = wait;
    return new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(true), delayMs);
      wait.signal.addEventListener("abort", () => { clearTimeout(timer); done(false); }, { once: true });
    }).finally(() => { if (this.retryWait === wait) this.retryWait = undefined; });
  }

  // ---- What her loop does, as the Host and Main see it -----------------------------------------

  private observe(event: LoopEvent): void {
    if (event.type === "message_end") this.keep(event.message);
    const projected = projectAgentSessionEvents(event as never, this.publishedFiles).map((item) => {
      if (item.type !== "agent_start") return item;
      // The reply belongs to the message that starts it: the one sent, or the first that waited.
      this.runOperationId = this.projector.nextInputOperationId() ?? this.runOperationId;
      return this.runOperationId === undefined ? item : { ...item, operationId: this.runOperationId };
    });
    for (const item of projected.flatMap((value) => this.projector.project(value))) {
      if (item.type === "dock_queue_consumed") this.consumed(item.operationId);
      this.publish(item.type === "conversation_checkpoint" ? this.checkpoint() : item);
    }
  }

  /** Every message of the conversation is saved as it completes; prompt and tool changes are not conversation. */
  private keep(message: AgentMessage): void {
    if (message.role === "system") return;
    if (message.role === "custom") {
      this.session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      return;
    }
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") this.session.appendMessage(message);
  }

  private consumed(operationId: unknown): void {
    const index = this.queue.findIndex((item) => item.operationId === operationId);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.publishQueue();
  }

  private checkpoint(): AgentEvent {
    return { type: "conversation_checkpoint", history: this.conversation.entries(this.session) };
  }

  private publish(event: AgentEvent): void {
    if (this.buffered !== undefined) { this.buffered.push(event); return; }
    for (const listener of this.listeners) listener(event);
  }

  // ---- Model ----------------------------------------------------------------------------------

  /** The model a conversation already chose, else the one chosen when the Work was created, else Pi's default. */
  async chooseStartingModel(chosen: unknown, fresh: boolean): Promise<void> {
    const recorded = this.session.buildSessionContext();
    const starting = await resolvePiStartingModel(chosen, this.models, this.session);
    const fromSession = recorded.model === null ? undefined : this.models.getModel(recorded.model.provider, recorded.model.modelId);
    const provider = this.settings.getDefaultProvider(), modelId = this.settings.getDefaultModel();
    const fromSettings = provider === undefined || modelId === undefined ? undefined : this.models.getModel(provider, modelId);
    this.model = starting ?? fromSession ?? fromSettings ?? (await this.models.getAvailable())[0];
    const level = (THINKING_LEVELS as readonly string[]).includes(recorded.thinkingLevel) && !fresh
      ? recorded.thinkingLevel as ThinkingLevel
      : this.settings.getDefaultThinkingLevel() as ThinkingLevel | undefined ?? "off";
    this.thinkingLevel = this.model === undefined ? level : clampThinkingLevel(this.model, level) as ThinkingLevel;
    if (this.model === undefined) this.diagnostics.push("助手还没有可用的模型。请在这个 Work 的模型列表里选一个。");
    else if (fresh) {
      // A new conversation records what it starts with, so opening it again keeps the choice.
      this.session.appendModelChange(this.model.provider, this.model.id);
      this.session.appendThinkingLevelChange(this.thinkingLevel);
    }
  }

  private modelState(): AgentModelState {
    return {
      model: this.model === undefined ? undefined : { provider: this.model.provider, id: this.model.id },
      thinkingLevel: this.thinkingLevel,
      availableThinkingLevels: this.model === undefined ? ["off"] : getSupportedThinkingLevels(this.model) as ThinkingLevel[],
    };
  }

  private async selectModel(provider: string, modelId: string): Promise<AgentModelState> {
    const model = this.models.getModel(provider, modelId);
    if (!model || !(await this.models.checkAuth(provider))) throw new AgentModelNotFoundError(provider, modelId);
    this.model = model;
    this.thinkingLevel = clampThinkingLevel(model, this.thinkingLevel) as ThinkingLevel;
    this.session.appendModelChange(model.provider, model.id);
    return this.modelState();
  }

  private selectThinkingLevel(level: ThinkingLevel): AgentModelState {
    this.thinkingLevel = this.model === undefined ? level : clampThinkingLevel(this.model, level) as ThinkingLevel;
    this.session.appendThinkingLevelChange(this.thinkingLevel);
    return this.modelState();
  }

  // ---- Counts -----------------------------------------------------------------------------------

  private metrics(): AgentSessionMetrics {
    const entries = this.session.getBranch();
    const from = this.countedThrough === undefined ? 0 : entries.findIndex((entry) => entry.id === this.countedThrough) + 1;
    for (const entry of entries.slice(from)) this.count(entry);
    this.countedThrough = entries.at(-1)?.id;
    const window = this.model?.contextWindow;
    return {
      ...structuredClone(this.metricsValue),
      ...(window === undefined || window <= 0 ? {} : {
        context: {
          tokens: this.lastUsageTokens ?? null,
          contextWindow: window,
          percent: this.lastUsageTokens === undefined ? null : Math.min(100, this.lastUsageTokens / window * 100),
        },
      }),
    };
  }

  private count(entry: SessionEntry): void {
    if (entry.type === "compaction") { this.lastUsageTokens = undefined; return; }
    if (entry.type !== "message") return;
    const message = entry.message;
    const counts = this.metricsValue.messages;
    if (message.role === "user") counts.user += 1;
    else if (message.role === "toolResult") counts.toolResults += 1;
    else if (message.role === "assistant") {
      counts.assistant += 1;
      counts.toolCalls += message.content.filter((block) => block.type === "toolCall").length;
      const usage = message.usage;
      const tokens = this.metricsValue.tokens;
      tokens.input += usage.input; tokens.output += usage.output; tokens.cacheRead += usage.cacheRead; tokens.cacheWrite += usage.cacheWrite;
      tokens.total += usage.totalTokens;
      this.metricsValue.cost += usage.cost.total;
      if (message.stopReason !== "error" && message.stopReason !== "aborted" && usage.totalTokens > 0) this.lastUsageTokens = usage.totalTokens;
    } else return;
    counts.total += 1;
  }
}

/** A file the Host can open this conversation from again: a real file of this user, not a link. */
function isOwnRegularFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    const getuid = process.getuid;
    const owned = typeof getuid === "function" ? info.uid === getuid() : process.platform === "win32";
    return info.isFile() && !info.isSymbolicLink() && relative(realpathSync(path), resolve(path)) === "" && owned;
  } catch {
    return false;
  }
}
