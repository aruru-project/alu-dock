import { randomUUID } from "node:crypto";
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
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { convertToLlm, createFindTool, createGrepTool, createLsTool, createReadTool, ModelRuntime, SessionManager, SettingsManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

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
import { compareToolDtos, type CommandDto } from "../core/config-projection.js";
import { isDockMessageText, MAX_DOCK_TOOL_MESSAGE_CHARS, type DockToolsRequest, type WorkMessage } from "../core/dock-tools.js";
import type { ObservationNotification } from "../core/instance-observation.js";
import { projectJsonObject, type JsonObject } from "../core/json-value.js";
import { localMinute } from "../core/local-time.js";
import { mainModelOwner } from "../model-service/owner.js";
import { configurePiNetwork } from "../pi/configure-pi-network.js";
import { appendDockAttachmentContext } from "../pi/dock-attachment-context.js";
import {
  loadAttachmentContextKey,
  loadPiImages,
  PiConversationProjector,
  PiSessionConversation,
  type PiConversationSource,
  projectAgentSessionEvents,
  resolveAttachmentImages,
} from "../pi/pi-conversation.js";
import { projectPiModelList } from "../pi/pi-model-list.js";
import { resolvePiStartingModel } from "../pi/pi-starting-model.js";
import { TransientFileRegistry } from "../pi/transient-file-registry.js";
import { dockAttachmentTools } from "../worker/dock-attachment-tools.js";
import { topLevelDockTools, type DockToolRuntime } from "../worker/dock-tool-definitions.js";
import { DOCK_TOOLS_COMMAND, DOCK_TOOLS_STATUS_KEY, isDockToolsAction, watchNoticeEntry, workMessageEntry, type DescribedModel } from "../worker/dock-tools-client.js";
import type { WorkerAgent, WorkerHost } from "../worker/worker-shell.js";
import { HANDOFF_STATE_TYPE, HANDOFF_STATUS_KEY, Handoff, rewriteWithoutPrompt, type HandoffRecord } from "./handoff.js";
import { memoryTools } from "./memory-tools.js";
import { AssistantToolExtensions, type AssistantBuiltinExtensions } from "./tool-extensions.js";
import { AssistantOpening } from "./opening.js";
import { SessionRecorder, type AssistantCallPort } from "./recorder.js";
import { MAX_REMINDER_CHARS, Reminders, reminderTime, type Reminder } from "./reminders.js";
import { DOCK_NOTE_TYPE, firstLine, renderStatus, STATUS_NOTE_TYPE } from "./status.js";
import { MAX_WORK_WAKES, WakeBudget, type WakeSource } from "./wake.js";
import { WORKS_STATE_TYPE, WorkDesk } from "./works.js";

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

/** Requests to the model one reply may make before it is told to wrap up. */
export const MAX_REPLY_STEPS = 20;
/** Kept with her conversation: the reminders still waiting. */
const REMINDERS_STATE_TYPE = "assistant-reminders";
/** A reminder that came due, in her conversation. */
const REMINDER_NOTE_TYPE = "assistant-reminder";
const REMIND_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["set", "list", "cancel"] },
    at: { type: "string", description: "set: when, as YYYY-MM-DD HH:mm in local time or an ISO time." },
    inMinutes: { type: "integer", minimum: 1, maximum: 525_600, description: "set: minutes from now, instead of at." },
    inSeconds: { type: "integer", minimum: 1, maximum: 86_400, description: "set: seconds from now, instead of at; added to inMinutes when both are given." },
    text: { type: "string", maxLength: MAX_REMINDER_CHARS, description: "set: what to do or say then, written so it makes sense on its own later." },
    id: { type: "string", description: "cancel: the reminder's id, as in #r1a2b3c4 (without #)." },
  },
  required: ["action"],
  additionalProperties: false,
};

/** What an entry her owner had her forget says in her conversation from then on. */
const FORGOTTEN_NOTE = "（这一条里的事主人让我忘掉了。）";

/** One message the owner (or another Work, through her input) sent while she was replying. */
interface QueuedInput {
  operationId: string;
  delivery: "steer" | "followUp";
  text: string;
}

/** `/dock-tools`, alone or with what to do. */
const DOCK_TOOLS_INPUT = new RegExp(`^\\s*/${DOCK_TOOLS_COMMAND}(?:\\s+(.*))?$`, "su");
const DOCK_TOOLS_SWITCH: CommandDto = {
  name: DOCK_TOOLS_COMMAND, source: { kind: "built-in" }, description: "开启、关闭或查看助手的 Dock tools（派 Work、联系别的 Work）",
  argumentHint: "on|off|status", argumentCompletions: false,
};
const NO_OTHER_SESSION = "常驻助手的对话是一条连续的线，不另开会话、不切换或分叉。你可以直接继续说；要载入刚改过的人设和记忆，请用 Reload，重启也会保留这段对话。";

/**
 * The personal assistant's own Agent (card #667). She is not a Pi coding Work: she keeps a
 * conversation in Pi's session format and asks the model through Pi's model runtime and loop, but
 * loads no project context or Pi extensions. She can read files; changing them and running commands
 * belong to the Works she hands tasks to.
 */
export async function createAssistantAgent(init: AssistantWorkerInit, host: WorkerHost, builtins: AssistantBuiltinExtensions = {}): Promise<WorkerAgent> {
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
  if (init.initialName !== undefined && session.getSessionName() !== init.initialName) session.appendSessionInfo(init.initialName);
  const attachmentContextKey = await loadAttachmentContextKey(agentDir);
  const her = new AssistantAgent(cwd, host, { call: assistant }, models, settings, session, attachmentContextKey, builtins);
  await her.chooseStartingModel(init.workerConfig?.model, init.sessionFile === undefined);
  await her.loadExtensions();
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
  private tools: AgentTool[];
  private readonly builtInTools: AgentTool[];
  private readonly extensions: AssistantToolExtensions;
  private readonly workTools: AgentTool[];
  private model: Model<Api> | undefined;
  private thinkingLevel: ThinkingLevel = "off";
  /** The reply in progress, retries included; undefined while she is idle. */
  private running: Promise<void> | undefined;
  private runOperationId: string | undefined;
  private stopRequested = false;
  private retryWait: AbortController | undefined;
  private readonly queue: QueuedInput[] = [];
  /** Work messages and reminders waiting for the loop, never drafts the owner can take back. */
  private readonly arrivals = new Set<AgentMessage>();
  private readonly wake = new WakeBudget();
  private toldWakesSpent = false;
  private readonly desk: WorkDesk;
  private readonly reminders: Reminders;
  private readonly savedState = new Map<string, string>();
  /** What her owner said in the reply in progress, as he said it; handed on with the work she gives out. */
  private ownerWords: string[] = [];
  private steps = 0;
  /** The reply reached its last step: only messages to other Works still go out. */
  private closing = false;
  /** Whether the model's context was built from the conversation yet; until then the session alone holds it. */
  private contextReady = false;
  private readonly handoff: Handoff;
  /** What clients are shown of her conversation: from the hand-over record before the latest one on. */
  private readonly shown: RecentConversation;
  /** The entries Main said were forgotten when it was last asked. */
  private forgottenSeen = new Set<string>();
  /** Main's existing global forgetting counter, including memories without a source in this session. */
  private forgettingRevision: number | undefined;
  /** She forgot something in the reply in progress. */
  private forgetting = false;
  /** What is done to her context between replies; the next reply waits for it. */
  private settling: Promise<void> = Promise.resolve();
  /** The last entry already counted in `metricsValue`. */
  private countedThrough: string | undefined;
  private metricsValue: AgentSessionMetrics = {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  private lastUsageTokens: number | undefined;
  private onDisk = false;
  private disposed: Promise<AgentCleanupResult> | undefined;

  constructor(
    private readonly cwd: string,
    private readonly host: WorkerHost,
    private readonly port: AssistantCallPort,
    private readonly models: ModelRuntime,
    private readonly settings: SettingsManager,
    private readonly session: SessionManager,
    private readonly attachmentContextKey: Uint8Array,
    builtins: AssistantBuiltinExtensions,
  ) {
    this.extensions = new AssistantToolExtensions(cwd, builtins, {
      notify: (message, level) => this.tell(message, level),
      confirm: async (title, message, signal) => await host.call("ui.confirm", { title, message }, signal) === true,
      status: (key, text) => { void host.call("ui.setStatus", { key, ...(text === undefined ? {} : { text }) }).catch(() => {}); },
    });
    this.conversation = new PiSessionConversation({ attachmentContextKey, publishedFiles: this.publishedFiles });
    this.shown = new RecentConversation(session);
    this.handoff = new Handoff({
      branch: () => this.session.getBranch(),
      contextWindow: () => this.model?.contextWindow ?? 0,
      settings: async () => (await port.call({ op: "settings_get" })).handoff,
      status: (text) => { void this.host.call("ui.setStatus", { key: HANDOFF_STATUS_KEY, text }).catch(() => {}); },
      rememberResult: (text) => this.saveState(HANDOFF_STATE_TYPE, text),
      complete: (system, prompt, maxTokens, signal) => this.complete(system, prompt, maxTokens, signal),
      forgotten: () => this.forgottenEntries(),
      ready: () => { if (this.running === undefined) this.settleSoon(); },
      tell: (message) => this.tell(message, "warning"),
    });
    this.projector = new PiConversationProjector(attachmentContextKey);
    const notify = (message: string): void => this.tell(message, "warning");
    this.recorder = new SessionRecorder(port, session, attachmentContextKey, notify);
    this.opening = new AssistantOpening(port, notify);
    this.desk = new WorkDesk(host, (state) => this.saveState(WORKS_STATE_TYPE, state));
    this.reminders = new Reminders(
      (reminders) => this.saveState(REMINDERS_STATE_TYPE, { reminders }),
      (reminder, lateMs) => this.reminderDue(reminder, lateMs),
    );
    this.restoreState();
    this.workTools = this.dockTools();
    this.tools = [
      createReadTool(cwd), createLsTool(cwd), createFindTool(cwd), createGrepTool(cwd),
      ...(host.attachments === undefined ? [] : dockAttachmentTools(host.attachments) as AgentTool[]),
      ...memoryTools({
        port, session, recorder: this.recorder, models, attachmentContextKey,
        confirm: async (title, message) => await host.call("ui.confirm", { title, message }, this.agent.signal) === true,
      }),
      this.reminderTool(),
      ...this.workTools,
    ];
    this.builtInTools = this.tools;
    this.agent = new Agent({
      initialState: { tools: this.tools },
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
      convertToLlm,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: session.getSessionId(),
      finishTurn: (turn) => {
        this.steps += 1;
        if (this.closing) return { action: "end" };
        // Tool results mean she would ask the model again. At the limit she gets one more request to
        // say where things stand, so a long reply never ends without a word to her owner.
        if (turn.toolResults.length > 0 && this.steps >= MAX_REPLY_STEPS) {
          this.closing = true;
          this.agent.steer(this.dockNote(`[步数上限] 这一轮已经走了 ${MAX_REPLY_STEPS} 步，这是最后一步。现在用几句话向主人交代做到哪了、还差什么；要通知别的 Work 可以用 dock_send。这一步里其他工具都不会执行。`));
        }
        return undefined;
      },
      beforeToolCall: async ({ toolCall }) => this.closing && toolCall.name !== "dock_send"
        ? { block: true, reason: "这一轮已到步数上限，这个调用没有执行。" }
        : undefined,
      // Before every request: a conversation grown long gets its hand-over record started. The record
      // takes its place between replies; only past the point where she cannot go on without one does
      // she wait for it here and go on from it inside the reply.
      prepareRequest: async ({ context }, signal) => {
        const tokens = estimateContextTokens(convertToLlm(context.messages)).tokens;
        this.handoff.consider(tokens);
        if (this.handoff.mustWait(tokens)) {
          // Stop does not wait for the record: the request that follows ends at once.
          const stopped = new Promise<void>((done) => signal?.addEventListener("abort", () => done(), { once: true }));
          await Promise.race([this.handoff.require(tokens), stopped]);
          if (signal?.aborted) return undefined;
          const record = this.handoff.take();
          if (record !== undefined && await this.takeOver(record, true)) context = { ...context, messages: [...this.agent.state.messages] };
        }
        // Each request (including retries) takes the latest choice; one already in flight is left alone.
        return { ...(this.model === undefined ? {} : { model: this.model }), thinkingLevel: this.thinkingLevel, context };
      },
    });
    this.agent.subscribe((event) => this.observe(event));
  }

  get persistedName(): string | undefined { return this.session.getSessionName(); }

  async loadExtensions(): Promise<void> {
    try {
      const { extensions = [] } = await this.port.call({ op: "settings_get" });
      this.tools = [...this.builtInTools, ...await this.extensions.load(extensions, this.builtInTools)];
      this.agent.state.tools = this.tools;
    } catch {
      // A settings outage must not take away chat or the tools that already worked.
      this.tell("暂时读不到助手扩展设置，现有工具没有改变。请稍后 Reload 重试。", "warning");
    }
  }

  // ---- What the Host asks -------------------------------------------------------------------

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state(): AgentWorkerState {
    const sessionFile = this.session.getSessionFile();
    // Asked for with every event; a conversation once on disk stays there.
    this.onDisk ||= sessionFile !== undefined && isOwnRegularFile(sessionFile);
    const durable = this.onDisk;
    return {
      sessionId: this.session.getSessionId(),
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(durable ? { durableSessionFile: sessionFile } : {}),
      isStreaming: this.running !== undefined,
      isCompacting: false,
      modelState: this.modelState(),
      metrics: this.metrics(),
      extensionCommands: [DOCK_TOOLS_COMMAND],
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
      case "session.history": return this.conversation.entries(this.shown);
      case "conversation.history": return this.conversation.history(this.shown, request.params.cursor, request.params.limit, request.params.view);
      case "conversation.content": return this.conversation.content(this.shown, request.params.contentRef, request.params.cursor, request.params.view);
      case "conversation.image": return this.conversation.image(this.shown, request.params.contentRef);
      case "session.name": {
        this.session.appendSessionInfo(request.params.name);
        const name = this.session.getSessionName();
        this.publish({ type: "session_info_changed", ...(name === undefined ? {} : { name }), operationId: request.params.operationId });
        return name;
      }
      // Tools can be inspected, not individually switched. The Dock switch keeps its own meaning.
      case "tool.list": {
        const tools = this.tools.map((tool) => ({
          name: tool.name, description: tool.description,
          active: this.host.dockToolsEnabled() || !this.workTools.includes(tool),
          source: this.extensions.sources.get(tool.name) ?? { kind: "built-in" as const }, parameterSchema: projectJsonObject(tool.parameters).value,
        })).sort(compareToolDtos);
        return { tools, total: tools.length, truncated: false };
      }
      // She has none of these: clients open her Work and show them empty.
      case "settings.get": return [];
      case "resource.get": return { resources: [], diagnostics: [], resourceTotal: 0, resourcesTruncated: false, diagnosticTotal: 0, diagnosticsTruncated: false };
      // The one command she takes: her owner's switch for her Dock tools, as every Work has it.
      case "command.catalog": {
        const commands = [DOCK_TOOLS_SWITCH].filter((command) => command.name.startsWith(request.params.prefix ?? ""));
        return { commands, total: commands.length, truncated: false };
      }
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
      case "tool.set_active":
        throw this.notHers("助手的工具可以查看，不能逐个开关。要开关派 Work、联系别的 Work 的能力，请用 /dock-tools on 或 /dock-tools off。");
      case "settings.update": case "command.content": case "command.complete":
        throw this.notHers("助手没有可以在这里调整的设置。要刷新人设和记忆，请用 Reload。");
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
    // A record being written asks the model through the Host; the reloaded conversation writes its own.
    this.handoff.discard();
    this.opening.refresh();
    await this.loadExtensions();
    await this.dropForgotten().catch(() => {});
    this.contextReady = false;
    const sessionFile = this.session.getSessionFile();
    const name = this.session.getSessionName();
    this.publish({
      type: "dock_session_replaced", reason: "reload", operationId, cwd: this.cwd,
      ...(sessionFile === undefined ? {} : { previousSessionFile: sessionFile, sessionFile }),
      ...(name === undefined ? {} : { name }),
    });
    this.extensions.showStatus();
    return { cancelled: false };
  }

  /** Her owner's switch for collaboration. Reading files and attachments stays available. */
  private async switchDockTools(action: string): Promise<void> {
    if (!isDockToolsAction(action)) {
      this.tell("用法：/dock-tools on、/dock-tools off 或 /dock-tools status。", "warning");
      return;
    }
    const enabled = action === "status" ? this.host.dockToolsEnabled() : await this.host.configureDockTools(action === "on");
    this.showDockTools();
    this.tell(enabled
      ? "助手的 Dock tools 开着：她可以派 Work 干活、联系别的 Work。"
      : "助手的 Dock tools 关着：她不能派 Work，也看不到别的 Work；仍能聊天、用记忆、读取文件和附件。要恢复派活，用 /dock-tools on。");
  }

  /** Clients show the switch's state where every Work shows it. */
  private showDockTools(): void {
    void this.host.call("ui.setStatus", { key: DOCK_TOOLS_STATUS_KEY, ...(this.host.dockToolsEnabled() ? { text: "on" } : {}) }).catch(() => {});
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
        this.showDockTools();
        void this.handoff.refresh();
        this.extensions.showStatus();
        // Reminders that came due while she was not running fire now that the Host listens.
        this.reminders.start();
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
      case "work_message": this.workSaid(control.message); return null;
      case "observation_delivery": this.watchFired(control.notification); return null;
      case "dispose": return this.dispose();
    }
  }

  dispose(): Promise<AgentCleanupResult> {
    this.disposed ??= (async () => {
      const cleanupErrors: string[] = [];
      this.reminders.stop();
      this.handoff.stop();
      try { await this.abort(); } catch (error) { cleanupErrors.push(`abort: ${error instanceof Error ? error.message : String(error)}`); }
      cleanupErrors.push(...await this.extensions.dispose());
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
    const dockTools = DOCK_TOOLS_INPUT.exec(message);
    if (dockTools) {
      preflight({ success: true, inputKind: "extension_command", delivery: "prompt", custody: "runtime" });
      await this.switchDockTools(dockTools[1]?.trim() || "status");
      return null;
    }
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
    // Another top-level Work speaks to her through her input, with Dock's source line first.
    const fromWork = isDockMessageText(message);
    if (actual !== "prompt") {
      if (!fromWork) this.ownerWords.push(message);
      this.queue.push({ operationId, delivery: actual, text: modelText });
      if (actual === "steer") this.agent.steer(userMessage); else this.agent.followUp(userMessage);
      this.publishQueue();
      return null;
    }
    if (!this.admit(fromWork ? "work" : "owner")) {
      // It joins the conversation without a reply: the Host shows the message as taken without a run.
      this.observe({ type: "message_start", message: userMessage });
      this.observe({ type: "message_end", message: userMessage });
      this.publish(this.checkpoint());
      return null;
    }
    if (!fromWork) this.ownerWords = [message];
    await this.reply(operationId, [userMessage], fromWork ? "别的 Work 发来的消息" : "主人的消息");
    return null;
  }

  // ---- What reaches her from Works and from her own reminders ---------------------------------

  /** A message from a child Work, or Dock's notice that one stopped without its result. */
  private workSaid(message: WorkMessage): void {
    this.desk.heard(message);
    const name = `「${firstLine(message.from.name, 60)}」`;
    const wokenBy = message.type === "child_stopped" ? `子 Work${name}没交结果就停下了`
      : message.from.relation === "parent" ? `父 Work${name}的消息`
        : `子 Work${name}${message.done ? "交来的结果" : "的消息"}`;
    this.arrive("work", workMessageEntry(message), wokenBy, message.from.relation === "child" ? message.from.id : undefined);
  }

  private watchFired(notification: ObservationNotification): void {
    this.desk.watched(notification);
    this.arrive("work", watchNoticeEntry(notification), `你盯着的 Work「${firstLine(notification.target.name ?? notification.target.id, 60)}」有了动静`);
  }

  private reminderDue(reminder: Reminder, lateMs: number): void {
    const late = lateMs >= 60_000 ? `，晚了 ${Math.round(lateMs / 60_000)} 分钟（到点时 Dock 没在运行）` : "";
    const content = `[提醒 · 你定在 ${localMinute(new Date(reminder.at))}${late}]\n${reminder.text}`;
    this.arrive("reminder", { customType: REMINDER_NOTE_TYPE, content, display: true, details: { id: reminder.id, at: reminder.at } }, `你定的提醒（#${reminder.id}）`);
  }

  /**
   * Something that is not her owner speaking reached her. While she replies it joins the reply at
   * its next step; while she is idle it starts a reply, unless Works have already started as many
   * in a row as they may, and then it waits in the conversation for her owner.
   */
  private arrive(source: WakeSource, entry: { customType: string; content: string; display: boolean; details?: unknown }, wokenBy: string, childId?: string): void {
    const message = customMessage(entry.customType, entry.content, entry.display, entry.details);
    if (this.running !== undefined) { this.arrivals.add(message); this.agent.steer(message); return; }
    if (this.model !== undefined && this.admit(source, childId)) { void this.reply(undefined, [message], wokenBy); return; }
    this.observe({ type: "message_start", message });
    this.observe({ type: "message_end", message });
  }

  /** Whether this may start a reply; says so once when Works have used up the replies they may start. */
  private admit(source: WakeSource, childId?: string): boolean {
    if (this.wake.admit(source)) {
      if (source !== "work") this.toldWakesSpent = false;
      return true;
    }
    if (!this.toldWakesSpent) {
      this.toldWakesSpent = true;
      this.tell(`助手已经连续 ${MAX_WORK_WAKES} 次被别的 Work 的消息叫醒。之后它们的消息她照样收到，但先不回应，等你跟她说话。`, "warning");
      // A child Work that waits for her answer is told why none comes.
      if (childId !== undefined) void this.desk.invoke({
        type: "send", operationId: randomUUID(), target: childId,
        message: `[Dock 自动通知] 助手已经连续 ${MAX_WORK_WAKES} 次被 Work 的消息叫醒，现在不再自动回应 Work 的消息，要等主人跟她说话。你的消息已经送到，她之后会看到。`,
      }).catch(() => {});
    }
    return false;
  }

  /** A note from Dock inside her reply; clients do not show it. */
  private dockNote(text: string): AgentMessage {
    return customMessage(DOCK_NOTE_TYPE, text, false);
  }

  // ---- Her tools beyond memory ------------------------------------------------------------------

  private reminderTool(): AgentTool {
    return {
      name: "assistant_remind",
      label: "Reminders",
      description: "Wake yourself later. set: at a time (at) or after a while (inMinutes, inSeconds), with a text that says what to do then; when it comes due you get a turn that starts with the reminder, even if nobody is talking to you. list: the reminders still waiting. cancel: drop one. Reminders survive a restart; one that came due while Dock was not running fires as soon as it is back and says how late it is. Use it when your owner asks to be reminded of something, or to look at something again later instead of waiting in this turn.",
      parameters: REMIND_SCHEMA,
      execute: async (_id: string, params: { action: string; at?: string; inMinutes?: number; inSeconds?: number; text?: string; id?: string }) => {
        const line = (reminder: Reminder): string => `#${reminder.id} ${localMinute(new Date(reminder.at))} ${firstLine(reminder.text)}`;
        if (params.action === "set") {
          if (params.text === undefined) throw new Error("set needs text.");
          const reminder = this.reminders.set(reminderTime(params, Date.now()), params.text);
          return { content: [{ type: "text", text: `Set: ${line(reminder)}` }], details: reminder };
        }
        if (params.action === "cancel") {
          if (params.id === undefined) throw new Error("cancel needs the reminder's id.");
          const removed = this.reminders.cancel(params.id);
          if (!removed) throw new Error(`No reminder #${params.id.replace(/^#/u, "")} is waiting.`);
          return { content: [{ type: "text", text: `Cancelled: ${line(removed)}` }], details: removed };
        }
        if (params.action !== "list") throw new Error(`Unknown action ${params.action}.`);
        const waiting = this.reminders.list();
        return { content: [{ type: "text", text: waiting.length === 0 ? "No reminder is waiting." : ["Waiting reminders (local time):", ...waiting.map((reminder) => `- ${line(reminder)}`)].join("\n") }], details: { reminders: waiting } };
      },
    } as unknown as AgentTool;
  }

  /** The Dock tools of a top-level Work, asked through her desk so her status knows what she handed out. */
  private dockTools(): AgentTool[] {
    const describe = (model: Model<Api>): DescribedModel => ({
      provider: model.provider, id: model.id,
      thinkingLevels: getSupportedThinkingLevels(model),
      ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      images: model.input.includes("image"),
    });
    const runtime: DockToolRuntime = {
      invoke: (request) => this.desk.invoke(this.withOwnerWords(request)),
      thinkingLevel: () => this.thinkingLevel,
      modelFacts: () => ({
        ...(this.model === undefined ? {} : { current: describe(this.model) }),
        describe: (ref) => { const model = this.models.getModel(ref.provider, ref.id); return model ? describe(model) : undefined; },
      }),
    };
    return topLevelDockTools({ conversationCopy: false, waitInTurn: false, usageGuide: false })
      .map((tool) => ({
        name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
        execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
          const { text, details } = await tool.execute(params, runtime, signal);
          return { content: [{ type: "text", text }], details };
        },
      })) as unknown as AgentTool[];
  }

  /**
   * A child Work sees only its task. What her owner said in this reply goes with it as he said it,
   * so a retelling that drifted can be checked against his words.
   */
  private withOwnerWords(request: DockToolsRequest): DockToolsRequest {
    if (request.type !== "spawn" || this.ownerWords.length === 0) return request;
    const quoted = this.ownerWords.flatMap((words) => words.split(/\r?\n/u)).map((line) => `> ${line}`).join("\n");
    const task = `${request.task}\n\n---\n下面是主人这一轮的原话，由 Dock 原样附上，供你核对上面的任务有没有走样；两者对不上时，先问清楚再做。\n${quoted}`;
    return task.length > MAX_DOCK_TOOL_MESSAGE_CHARS ? request : { ...request, task };
  }

  // ---- What is kept with her conversation besides what was said -------------------------------

  private saveState(type: string, state: unknown): void {
    const serialized = JSON.stringify(state);
    if (this.savedState.get(type) === serialized) return;
    this.savedState.set(type, serialized);
    this.session.appendCustomEntry(type, state);
  }

  private restoreState(): void {
    const latest = new Map<string, unknown>();
    for (const entry of this.session.getBranch()) if (entry.type === "custom") latest.set(entry.customType, entry.data);
    for (const [type, state] of latest) this.savedState.set(type, JSON.stringify(state));
    this.desk.restore(latest.get(WORKS_STATE_TYPE));
    this.reminders.restore((latest.get(REMINDERS_STATE_TYPE) as { reminders?: unknown } | undefined)?.reminders);
    const lastCompaction = this.session.getBranch().findLast((entry) => entry.type === "compaction");
    this.handoff.restore(latest.get(HANDOFF_STATE_TYPE), lastCompaction?.timestamp);
  }

  private clearQueue(): ClearedAgentQueue {
    const cleared: ClearedAgentQueue = {
      steering: this.queue.filter((item) => item.delivery === "steer").map((item) => item.text),
      followUp: this.queue.filter((item) => item.delivery === "followUp").map((item) => item.text),
    };
    this.queue.length = 0;
    this.agent.clearAllQueues();
    // Taking back drafts must not discard Work results or due reminders. Keep them in the session,
    // not in a new steering queue: abort_restore_queue must leave her stopped, not wake her again.
    if (this.arrivals.size > 0) {
      this.contextReady = false;
      for (const message of this.arrivals) {
        this.observe({ type: "message_start", message });
        this.observe({ type: "message_end", message });
      }
    }
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
  private reply(operationId: string | undefined, messages: AgentMessage[], wokenBy: string): Promise<void> {
    if (this.running !== undefined) throw new Error("The assistant is already replying");
    this.runOperationId = operationId;
    this.stopRequested = false;
    this.steps = 0;
    this.closing = false;
    const run = (async () => {
      const model = this.model;
      if (model === undefined) return;
      await this.settling;
      void this.recorder.sync();
      // What her owner had her forget anywhere since her last reply leaves what the model is given.
      await this.dropForgotten().catch(() => {});
      await this.leadWithOpening();
      await this.noteStatus(wokenBy).catch(() => {});
      if (this.stopRequested) {
        // Stopped before the model was asked: what started the reply stays in the conversation, unanswered.
        this.publish({ type: "agent_start", ...(operationId === undefined ? {} : { operationId }) });
        for (const message of messages) {
          this.observe({ type: "message_start", message });
          this.observe({ type: "message_end", message });
        }
        this.agent.state.messages = [...this.agent.state.messages, ...messages];
        return;
      }
      this.agent.state.model = model;
      this.agent.state.thinkingLevel = clampThinkingLevel(model, this.thinkingLevel);
      await this.agent.prompt(messages);
      let attempt = 0;
      for (;;) {
        const last = this.lastAssistantMessage();
        if (last !== undefined && !this.stopRequested && attempt < RETRY_DELAYS_MS.length && this.passingFailure(last, this.models.getModel(last.provider, last.model) ?? model)) {
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
        this.steps = 0;
        this.closing = false;
        await this.agent.continue();
      }
    })().catch((error: unknown) => error instanceof Error ? error.message : String(error)).then((failure) => {
      const settledOperationId = this.runOperationId;
      const aborted = this.stopRequested;
      this.running = undefined;
      this.runOperationId = undefined;
      this.stopRequested = false;
      this.ownerWords = [];
      for (const event of this.projector.project({
        type: "agent_settled",
        ...(settledOperationId === undefined ? {} : { operationId: settledOperationId }),
        ...(aborted ? { aborted: true } : {}),
      })) {
        this.publish(typeof failure === "string" ? { ...event, stopReason: "error", error: failure } : event);
      }
      this.publish(this.checkpoint());
      this.settleSoon();
    });
    this.running = run;
    return run;
  }

  private settleSoon(): void {
    this.settling = this.settling.then(() => this.settleContext()).catch(() => {});
  }

  /**
   * Between replies: her words reach Main, what she just forgot leaves what the model is given, and
   * a hand-over record that is ready takes its place, or one is started when the conversation is long.
   */
  private async settleContext(): Promise<void> {
    if (this.forgetting) {
      this.forgetting = false;
      // Main hides the exchange she was asked in once it has it; then what is hidden leaves her context.
      await this.recorder.sync();
      // The record under way may tell what she just forgot: it is written again from what is left.
      this.handoff.discard();
      await this.dropForgotten();
    } else void this.recorder.sync();
    if (this.running !== undefined) return;
    const record = this.handoff.take();
    if (record !== undefined) await this.takeOver(record);
    else if (this.contextReady) this.handoff.consider(estimateContextTokens(convertToLlm(this.agent.state.messages)).tokens);
  }

  /**
   * Puts a finished hand-over record in place of the conversation before it, loads her persona and
   * memories anew (the model's cached prefix is lost at this point anyway) and rebuilds what the
   * model is given. False when the record was thrown away instead.
   */
  private async takeOver(record: HandoffRecord, insideReply = false): Promise<boolean> {
    const forgotten = await this.forgottenEntries();
    const branch = this.session.getBranch();
    const keptFrom = branch.findIndex((entry) => entry.id === record.firstKeptEntryId);
    const kept = new Set(branch.slice(Math.max(0, keptFrom)).map((entry) => entry.id));
    // Something forgotten since writing began lies in what the record tells: it is written again.
    // What is forgotten leaves her context between replies, never under a reply in progress.
    if (keptFrom < 0 || forgotten?.some((id) => !record.forgottenAtStart.has(id) && !kept.has(id))) {
      if (!insideReply) await this.dropForgotten(forgotten);
      return false;
    }
    this.session.appendCompaction(record.summary, record.firstKeptEntryId, record.tokensBefore);
    this.handoff.applied();
    if (!insideReply) await this.dropForgotten(forgotten);
    this.opening.refresh();
    this.contextReady = false;
    await this.leadWithOpening();
    this.publish(this.checkpoint());
    void this.recorder.sync();
    return true;
  }

  /** One request to her model outside the conversation. */
  private async complete(system: string, prompt: string, maxTokens: number, signal: AbortSignal): Promise<string> {
    const model = this.model;
    if (model === undefined) throw new Error("没有可用的模型");
    const reply = await this.models.completeSimple(model, { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { signal, maxTokens: Math.min(maxTokens, model.maxTokens || maxTokens) });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "模型没有回答");
    if (reply.stopReason === "length") throw new Error("模型的回答被截断了");
    return reply.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
  }

  // ---- Forgetting ---------------------------------------------------------------------------------

  /** The entries of this conversation her owner had her forget, or undefined when Main does not answer. */
  private async forgottenEntries(): Promise<string[] | undefined> {
    try {
      const result = await this.port.call({ op: "forgotten", sessionId: this.session.getSessionId() });
      if (this.forgettingRevision !== undefined && result.revision !== this.forgettingRevision) {
        // The opening can contain a resident memory or timeline line from another conversation.
        // Forgetting in the UI and forgetting through a tool must both evict that cached text.
        this.opening.refresh();
        this.contextReady = false;
        this.handoff.discard();
      }
      this.forgettingRevision = result.revision;
      return result.entryIds;
    } catch {
      return undefined;
    }
  }

  /**
   * What Main hides because her owner had her forget it also leaves what the model is given: each
   * such entry still in front of her says only that it was forgotten, and a hand-over record written
   * before the forgetting is rewritten without it. The conversation file keeps what was said.
   */
  private async dropForgotten(known?: string[]): Promise<void> {
    const forgotten = known ?? await this.forgottenEntries();
    if (forgotten === undefined || forgotten.every((id) => this.forgottenSeen.has(id))) return;
    const hidden = new Set(forgotten);
    const branch = this.session.getBranch();
    const edited = new Set(branch.flatMap((entry) => entry.type === "context_edit" ? [entry.targetId] : []));
    let changed = false;
    // Main keeps no results of her own memory tools, yet they repeat what was remembered: the results
    // of a forgotten message's calls go with it.
    const forgottenCalls = new Set<string>();
    for (const entry of this.session.buildContextEntries()) {
      const message = entry.type === "message" ? entry.message : undefined;
      const forgottenResult = message?.role === "toolResult" && forgottenCalls.has(message.toolCallId);
      if (message?.role === "assistant" && hidden.has(entry.id)) for (const block of message.content) if (block.type === "toolCall") forgottenCalls.add(block.id);
      if ((!hidden.has(entry.id) && !forgottenResult) || edited.has(entry.id)) continue;
      if (entry.type === "custom_message" || message?.role === "user") this.session.appendContextEdit(entry.id, { content: FORGOTTEN_NOTE });
      else if (message?.role === "toolResult") this.session.appendContextEdit(entry.id, { content: [{ type: "text", text: FORGOTTEN_NOTE }] });
      else if (message?.role === "assistant") {
        // Her calls keep their place, so their results still belong to something; what they carried goes.
        const calls = message.content.flatMap((block) => block.type === "toolCall" ? [{ ...block, arguments: {} }] : []);
        this.session.appendContextEdit(entry.id, { content: [{ type: "text", text: FORGOTTEN_NOTE }, ...calls] });
      } else continue;
      changed = true;
    }
    if (await this.rewriteRecord(hidden)) changed = true;
    this.forgottenSeen = hidden;
    if (!changed) return;
    this.contextReady = false;
    this.publish(this.checkpoint());
  }

  /** The hand-over record in use, when it was written before something in this conversation was forgotten, is rewritten without it. */
  private async rewriteRecord(hidden: ReadonlySet<string>): Promise<boolean> {
    const record = this.session.buildContextEntries()[0];
    if (record?.type !== "compaction" || !hidden.has(record.id)) return false;
    try {
      const since = Date.parse(record.timestamp);
      const { memories } = await this.port.call({ op: "memory_list", state: "forgotten", limit: 50 });
      const texts = memories.filter((memory) => Date.parse(memory.updatedAt) > since).map((memory) => memory.text);
      if (texts.length === 0) return false;
      const { system, prompt } = rewriteWithoutPrompt(record.summary, texts);
      const rewritten = (await this.complete(system, prompt, 4_096, new AbortController().signal)).trim();
      if (rewritten.length === 0) return false;
      this.session.appendCompaction(rewritten, record.firstKeptEntryId, record.tokensBefore);
      return true;
    } catch {
      // Tried again the next time something is found forgotten; until then the record stays.
      return false;
    }
  }

  /** Her opening leads what the model is given; the conversation follows as the session holds it. */
  private async leadWithOpening(): Promise<void> {
    const { text, changed } = await this.opening.text();
    if (!changed && this.contextReady) return;
    const opening = createInitialSystemMessage(text, this.tools.map(toToolDeclaration));
    const conversation = this.session.buildSessionContext().messages.filter((message) => message.role !== "system");
    this.agent.state.messages = opening === undefined ? conversation : [opening, ...conversation];
    this.contextReady = true;
  }

  /**
   * What she should know before she answers, without calling a tool: the time, what woke her and
   * what the Works she handed things to are doing. It is saved with the conversation, hidden from
   * clients, and stays where it was written so the model's cached prefix does not change.
   */
  private async noteStatus(wokenBy: string): Promise<void> {
    const lost = this.desk.takeLost();
    const text = [
      renderStatus({
        now: new Date(), wokenBy, dockTools: this.host.dockToolsEnabled(), works: this.host.dockToolsEnabled() ? await this.desk.list() : [], selfId: this.host.identity.instanceId,
        notes: this.desk.notes, followed: this.desk.following, reminders: this.reminders.list(),
      }),
      ...(lost.length === 0 ? [] : [`这个 Work 重新打开过，下面这些你派出去的子 Work 已经不在了，它们没交的结果不会再来：${lost.map((name) => `「${name}」`).join("、")}。有事叫醒你时再跟主人说，需要的话重新派。`]),
    ].join("\n");
    this.session.appendCustomMessageEntry(STATUS_NOTE_TYPE, text, false);
    this.agent.state.messages = [...this.agent.state.messages, customMessage(STATUS_NOTE_TYPE, text, false)];
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
    if (entry?.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error") this.session.appendContextEdit(entry.id, null);
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
    if (event.type === "tool_execution_start" && event.toolName === "assistant_memory" && (event.args as { action?: unknown } | undefined)?.action === "forget") this.forgetting = true;
    if (event.type === "message_end") {
      this.arrivals.delete(event.message);
      this.keep(event.message);
      // Outside a reply nothing else adds it to what the model is given next.
      if (this.running === undefined && this.contextReady) this.agent.state.messages = [...this.agent.state.messages, event.message];
    }
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
    // A Work's message or a reminder shows in clients as soon as it is in the conversation.
    if (event.type === "message_end" && event.message.role === "custom") this.publish(this.checkpoint());
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
    return { type: "conversation_checkpoint", history: this.conversation.entries(this.shown) };
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
    // An old request can finish after model.set. Its provider is history, not a newer choice.
    const selected = this.session.getBranch().findLast((entry) => entry.type === "model_change") ?? recorded.model;
    const fromSession = selected === null ? undefined : this.models.getModel(selected.provider, selected.modelId);
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
    void this.handoff.refresh();
    return this.modelState();
  }

  private selectThinkingLevel(level: ThinkingLevel): AgentModelState {
    this.thinkingLevel = this.model === undefined ? level : clampThinkingLevel(this.model, level) as ThinkingLevel;
    this.session.appendThinkingLevelChange(this.thinkingLevel);
    return this.modelState();
  }

  // ---- Counts -----------------------------------------------------------------------------------

  private metrics(): AgentSessionMetrics {
    // Asked for with every event: the conversation is walked only when it has grown.
    const leaf = this.session.getLeafId() ?? undefined;
    if (leaf !== this.countedThrough) {
      const entries = this.session.getBranch();
      const from = this.countedThrough === undefined ? 0 : entries.findIndex((entry) => entry.id === this.countedThrough) + 1;
      for (const entry of entries.slice(from)) this.count(entry);
      this.countedThrough = leaf;
    }
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

/**
 * What clients are shown of her conversation. It never starts over, so the whole of it would grow
 * without end; clients get it from the hand-over record before the latest one on, and find what
 * came earlier by searching her conversations. The file keeps everything.
 */
class RecentConversation implements PiConversationSource {
  constructor(private readonly session: SessionManager) {}
  getSessionId(): string { return this.session.getSessionId(); }
  getLeafId(): string | null { return this.session.getLeafId(); }
  getLeafEntry(): SessionEntry | undefined { return this.session.getLeafEntry(); }
  getBranch(): SessionEntry[] {
    const branch = this.session.getBranch();
    let records = 0;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      if (branch[index]!.type === "compaction" && ++records === 2) return branch.slice(index);
    }
    return branch;
  }
}

/** A message in the conversation that is neither her owner's nor hers, as Pi's sessions keep them. */
function customMessage(customType: string, content: string, display: boolean, details?: unknown): AgentMessage {
  return { role: "custom", customType, content, display, ...(details === undefined ? {} : { details }), timestamp: Date.now() };
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
