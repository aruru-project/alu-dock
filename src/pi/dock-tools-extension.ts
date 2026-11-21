import { randomUUID } from "node:crypto";
import type { BoundaryResult, ExtensionAPI, ExtensionContext, ExtensionFactory, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import {
  DOCK_REPORT_TOOL,
  DOCK_SPAWN_TOOL,
  MAX_DOCK_TOOL_MESSAGE_CHARS,
  MAX_DOCK_TOOL_TARGET_CHARS,
  shortenLastWords,
  type ChildRole,
  type DockToolsRequest,
  type DockToolsResult,
  type WorkMessage,
} from "../core/dock-tools.js";
import { MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE, type ObservationNotification } from "../core/instance-observation.js";
import {
  DOCK_TOOLS_ACTIONS, DOCK_TOOLS_COMMAND, DOCK_TOOLS_STATUS_KEY, isDockToolsAction,
  watchNoticeEntry,
  workMessageEntry,
  WORK_WAKE_TYPE,
  type DescribedModel,
  type ModelFacts,
} from "../worker/dock-tools-client.js";
import { ChildMessages } from "../worker/child-messages.js";
import { dockToolOutput, toolDescription, topLevelDockTools, type DockToolDefinition, type DockToolOutput } from "../worker/dock-tool-definitions.js";

const TOP_LEVEL_DOCK_TOOLS = topLevelDockTools();
/** The Dock tools of a top-level Pi Work, in the order they are registered. */
export const DOCK_TOOL_NAMES: readonly string[] = TOP_LEVEL_DOCK_TOOLS.map((tool) => tool.name);
/** A helper child Work reports to its parent and reaches nothing else. */
export const CHILD_DOCK_TOOL_NAMES: readonly string[] = [DOCK_REPORT_TOOL];
/** What a lead child Work uses on its own child Works besides its dock_send (card #674); it reaches no other Work. */
const LEAD_DOCK_TOOLS: readonly DockToolDefinition[] = TOP_LEVEL_DOCK_TOOLS.filter((tool) =>
  [DOCK_SPAWN_TOOL, "dock_wait", "dock_models", "dock_interrupt", "dock_stop", "dock_list", "dock_inspect"].includes(tool.name));
/** A lead child Work's Dock tools: reporting to its parent, and starting and managing child Works of its own. */
export const LEAD_DOCK_TOOL_NAMES: readonly string[] = [DOCK_REPORT_TOOL, ...LEAD_DOCK_TOOLS.map((tool) => tool.name)];
const DOCK_TOOLS_EXTENSION_PATH = "<inline:alu-dock-tools>";
const REPORT_DONE_DESCRIPTION = "true: your final result for the work your parent handed you; your turn ends after sending it. false: something your parent should know or answer now, such as a finding that affects its work, a question or a point to agree on; keep working.";
const CHILD_SEND_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS },
    done: { type: "boolean", description: REPORT_DONE_DESCRIPTION },
  },
  required: ["message", "done"],
  additionalProperties: false,
};
const LEAD_SEND_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS, description: "One of your own child Works, by name or id. Omit to message the Work that created you." },
    message: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS },
    done: { type: "boolean", description: `Required without target, never with it. ${REPORT_DONE_DESCRIPTION}` },
  },
  required: ["message"],
  additionalProperties: false,
};

export interface DockToolsCallPort {
  configure(action: "on" | "off" | "status"): Promise<{ enabled: boolean }>;
  invoke(request: DockToolsRequest): Promise<DockToolsResult>;
}

/** What a child Work's current turn did with its parent's work, to tell its parent when it stops without reporting. */
interface ChildTurn {
  /** The first prompt a child Work gets is the task it was created for; later ones are the user's own. */
  taskSeen: boolean;
  /** The task or a parent message went into the conversation for this turn. */
  hasParentWork: boolean;
  /** The last call of the turn so far delivered a message to the parent. */
  reachedParent: boolean;
  /**
   * The final result reached the parent in this turn and no parent work came after it. Other calls made in
   * the same step do not undo it: Pi ends a turn after a batch only when every call in it ends the turn.
   */
  resultSent: boolean;
  lastWords?: string;
  failure?: string;
}

/** The parts of a Pi message the bridge reads. */
interface ObservedMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

/** What waits to go into the conversation: a message from a parent or child Work, or a watch notice. */
type InboxItem = { kind: "work"; message: WorkMessage } | { kind: "watch"; notification: ObservationNotification };

/** Worker-level bridge survives Pi resource reloads while API closures do not. */
export class DockToolsBridge {
  private api: ExtensionAPI | undefined;
  private context: ExtensionContext | undefined;
  private enabledValue: boolean;
  /** Watches whose notice went into the inbox: at most one notice per watch. */
  private readonly deliveredWatchIds = new Set<string>();
  private readonly suppressedWatchIds = new Set<string>();
  /** While a cancel or off waits for the Host, nothing from the inbox goes into the conversation. */
  private deliveryFenceDepth = 0;
  /**
   * What reached this Worker and is not in the conversation yet, oldest first: Work messages and watch
   * notices. Pi's own queues are not used: taking back the user's Queue empties them, extension messages
   * included.
   */
  private readonly inbox: InboxItem[] = [];
  /**
   * Inbox items went into the conversation, or go in at the end of this step, and no reply has started
   * since. Tracked where they are handed over: Pi tells extensions about messages of its run only, not
   * about extension messages it writes.
   */
  private awaitingReply = false;
  /**
   * The user stopped the last turn. Like the user's own waiting input after Stop, what is already here joins
   * the conversation without starting another turn; a new message, or a turn started otherwise, ends this.
   */
  private stoppedByUser = false;
  /**
   * A turn was asked for and has not started. Pi holds a turn asked for while it settles and starts it
   * once done, so asking again then would run one turn too many.
   */
  private turnRequested = false;
  private readonly turn: ChildTurn = { taskSeen: false, hasParentWork: false, reachedParent: false, resultSent: false };
  /** A child Work owes its parent a result from its task, and from each parent message, until its final result reaches the parent. */
  private owesParent = false;
  readonly children = new ChildMessages();
  readonly toolNames: readonly string[];

  /** `role` is set for a child Work; a top-level Work has none. */
  constructor(initiallyEnabled: boolean, private readonly port: DockToolsCallPort, readonly role?: ChildRole) {
    this.enabledValue = initiallyEnabled;
    this.toolNames = role === "lead" ? LEAD_DOCK_TOOL_NAMES : role === "helper" ? CHILD_DOCK_TOOL_NAMES : DOCK_TOOL_NAMES;
  }

  /** A child Work, which owes its parent the result of the work it was handed. */
  get child(): boolean { return this.role !== undefined; }

  get enabled(): boolean { return this.enabledValue; }

  /** Its parent's message waits for this Work's next step; a dock_wait in progress stops for it, as for the user's. */
  get parentMessageWaiting(): boolean {
    return this.inbox.some((item) => item.kind === "work" && item.message.from.relation === "parent");
  }

  /** Binds the current runtime; what waited meanwhile goes in now. Messages arrive even when the tools are unavailable. */
  attach(api: ExtensionAPI, context?: ExtensionContext, toolsAvailable = true): () => void {
    this.api = api;
    this.context = context;
    // A message left unanswered belongs to the conversation it was written into.
    this.awaitingReply = false;
    this.turnRequested = false;
    if (toolsAvailable) this.applyToolVisibility(api);
    this.deliverWorkMessagesSoon();
    return () => {
      if (this.api !== api) return;
      this.api = undefined;
      this.context = undefined;
    };
  }

  /** A message from this Work's parent or child Work, or Dock's notice about a child Work. */
  receive(message: WorkMessage): void {
    if (this.children.receive(message)) return;
    this.stoppedByUser = false;
    this.inbox.push({ kind: "work", message });
    this.deliverWorkMessages();
  }

  /** Child Work messages that arrived during the current step, for a dock_wait that starts now. */
  takeArrivedChildMessages(): WorkMessage[] {
    const arrived: WorkMessage[] = [];
    for (let index = 0; index < this.inbox.length;) {
      const item = this.inbox[index]!;
      if (item.kind === "work" && item.message.from.relation === "child") {
        arrived.push(item.message);
        this.inbox.splice(index, 1);
      } else index += 1;
    }
    return arrived;
  }

  /**
   * At the end of a step (Pi's turn_end and agent_before_settle): waiting messages join the conversation
   * right after it, and the Agent gets one more request to answer them instead of stopping.
   */
  atStepEnd(): BoundaryResult | undefined {
    const api = this.api;
    if (!api) return undefined;
    try { this.handOver(api); } catch { return undefined; }
    return this.awaitingReply ? { continue: true } : undefined;
  }

  settled(aborted: boolean): void {
    if (this.child) this.reportUnreportedStop(aborted);
    // Pi's abort leaves no automatic continuation after the user stops a turn, and these messages join
    // that rule. Otherwise what came after the last step, or went unanswered, starts the next turn.
    if (aborted) {
      this.stoppedByUser = true;
      this.awaitingReply = false;
    }
    // Pi defers what is sent while it settles; deliver once it is done.
    this.deliverWorkMessagesSoon();
  }

  /** Pi defers what is sent while it settles or binds a runtime; deliver once it is done. */
  deliverWorkMessagesSoon(): void { setTimeout(() => this.deliverWorkMessages(), 0); }

  runStarting(messageType: "user" | "custom"): void {
    // The new turn answers whatever waits in the conversation.
    this.stoppedByUser = false;
    this.turnRequested = false;
    if (!this.child || messageType !== "user" || this.turn.taskSeen) return;
    this.turn.taskSeen = true;
    this.turn.hasParentWork = true;
    this.owesParent = true;
  }

  messageStarted(message: ObservedMessage): void {
    if (message.role === "assistant") this.awaitingReply = false;
  }

  messageEnded(message: ObservedMessage): void {
    if (!this.child || message.role !== "assistant") return;
    const text = textOf(message.content);
    if (text) this.turn.lastWords = text;
    this.turn.failure = message.stopReason === "error" ? message.errorMessage ?? "" : undefined;
  }

  toolEnded(event: Pick<ToolExecutionEndEvent, "toolName" | "isError" | "parentToolCallId" | "result">): void {
    if (!this.child || event.parentToolCallId !== undefined) return;
    const details = (event.result as { details?: { to?: unknown; done?: unknown } } | undefined)?.details;
    // A lead's message to one of its own child Works does not reach its parent.
    const sent = event.toolName === DOCK_REPORT_TOOL && !event.isError && details?.to !== "child";
    if (sent && details?.done === true) {
      this.turn.resultSent = true;
      this.owesParent = false;
    }
    this.turn.reachedParent = sent || this.turn.resultSent;
  }

  /** An idle Work takes waiting messages now and starts a turn for them; a busy one takes them at the end of its step. */
  private deliverWorkMessages(): void {
    const api = this.api, context = this.context;
    if (!api || !context) return;
    try {
      if (!context.isIdle()) return;
      this.handOver(api);
      if (this.stoppedByUser || !this.awaitingReply || this.turnRequested) return;
      api.sendMessage({ customType: WORK_WAKE_TYPE, content: "", display: false }, { triggerTurn: true });
      this.turnRequested = true;
    } catch { /* The runtime is being replaced; the next one delivers them. */ }
  }

  /** Hands waiting items to Pi in arrival order: written at once while idle, after the current step while busy. */
  private handOver(api: ExtensionAPI): void {
    // A cancel or off waiting for the Host decides first which watch notices may still go in.
    if (this.deliveryFenceDepth > 0) return;
    while (this.inbox.length > 0) {
      const item = this.inbox[0]!;
      api.sendMessage<unknown>(item.kind === "work" ? workMessageEntry(item.message) : watchNoticeEntry(item.notification), { triggerTurn: false });
      this.inbox.shift();
      this.awaitingReply = true;
      // New work from the parent is owed a report again, whatever the child Work sent it before. A lead's
      // own child Works work on what its parent handed it: while that result is owed, theirs count too.
      const fromParent = item.kind === "work" && item.message.from.relation === "parent";
      if (this.child && (fromParent || (item.kind === "work" && this.role === "lead" && this.owesParent))) {
        this.turn.hasParentWork = true;
        this.turn.reachedParent = false;
        this.turn.resultSent = false;
      }
      if (this.child && fromParent) this.owesParent = true;
    }
  }

  /**
   * A child Work's turn that carried its parent's work ended, and its last call did not reach the parent.
   * The Host tells the parent if a result is still owed; the child Work is not asked to report again.
   */
  private reportUnreportedStop(aborted: boolean): void {
    const { hasParentWork, reachedParent, lastWords, failure } = this.turn;
    // Card #674: a lead hands parts of the work to its own child Works and ends its turn while they work.
    // That is no stop: their messages wake it, and the result it owes is still owed in the turns to come.
    if (!aborted && hasParentWork && !reachedParent && this.children.waiting.length > 0) return;
    Object.assign(this.turn, { hasParentWork: false, reachedParent: false, resultSent: false, lastWords: undefined, failure: undefined });
    if (!hasParentWork || reachedParent) return;
    void this.port.invoke({
      type: "unreported_stop",
      reason: aborted ? "aborted" : failure !== undefined ? "failed" : "ended",
      ...(!aborted && failure ? { error: shortenLastWords(failure) } : {}),
      ...(lastWords === undefined ? {} : { lastWords: shortenLastWords(lastWords) }),
    }).catch(() => { /* Dock tools are off or the Host is gone: no one can be told. */ });
  }

  async configure(action: "on" | "off" | "status"): Promise<boolean> {
    if (action === "status") return this.enabledValue;
    const previous = this.enabledValue;
    const fenced = action === "off";
    if (fenced) {
      this.beginDeliveryFence();
      this.enabledValue = false;
      if (this.api) this.applyToolVisibility(this.api);
    }
    try {
      const result = await this.port.configure(action);
      this.enabledValue = result.enabled;
      // Off cancels every watch on the Host. Messages from child Works still arrive.
      if (!result.enabled) this.withdrawWatchNotices();
      if (this.api) this.applyToolVisibility(this.api);
      return result.enabled;
    } catch (error) {
      this.enabledValue = previous;
      if (this.api) this.applyToolVisibility(this.api);
      throw error;
    } finally {
      if (fenced) this.endDeliveryFence();
    }
  }

  async invoke(request: DockToolsRequest): Promise<DockToolsResult> {
    if (!this.enabledValue) throw new Error("Dock tools are off. Use /dock-tools on first.");
    if (request.type === "cancel") {
      this.beginDeliveryFence();
      try {
        const result = await this.port.invoke(request);
        if (result.type === "cancel") {
          if (request.watchId === undefined) this.withdrawWatchNotices();
          else this.withdrawWatchNotice(request.watchId);
          for (const watchId of result.cancelledWatchIds) this.withdrawWatchNotice(watchId);
        }
        return result;
      } finally {
        this.endDeliveryFence();
      }
    }
    const before = this.children.position;
    const result = await this.port.invoke(request);
    this.children.noteWork(result, before);
    return result;
  }

  /**
   * A watch notice joins the inbox with the Work messages, so it reaches the Agent the same way. While a
   * cancel or off waits for the Host it waits too, even with the tools already shown as off.
   */
  deliver(notification: ObservationNotification): void {
    const { watchId } = notification;
    if (this.suppressedWatchIds.has(watchId) || this.deliveredWatchIds.has(watchId)) return;
    if (!this.enabledValue && this.deliveryFenceDepth === 0) {
      this.suppress(watchId);
      return;
    }
    this.markDelivered(watchId);
    this.stoppedByUser = false;
    this.inbox.push({ kind: "watch", notification });
    this.deliverWorkMessages();
  }

  private beginDeliveryFence(): void { this.deliveryFenceDepth += 1; }

  private endDeliveryFence(): void {
    this.deliveryFenceDepth -= 1;
    if (this.deliveryFenceDepth === 0) this.deliverWorkMessages();
  }

  /** A cancelled watch's notice that is not in the conversation yet never goes in; a late copy is dropped. */
  private withdrawWatchNotice(watchId: string): void {
    this.suppress(watchId);
    const index = this.inbox.findIndex((item) => item.kind === "watch" && item.notification.watchId === watchId);
    if (index >= 0) this.inbox.splice(index, 1);
  }

  private withdrawWatchNotices(): void {
    for (const item of [...this.inbox]) if (item.kind === "watch") this.withdrawWatchNotice(item.notification.watchId);
  }

  private markDelivered(watchId: string): void {
    this.deliveredWatchIds.add(watchId);
    while (this.deliveredWatchIds.size > MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
      this.deliveredWatchIds.delete(this.deliveredWatchIds.values().next().value!);
    }
  }

  private suppress(watchId: string): void {
    this.suppressedWatchIds.add(watchId);
    while (this.suppressedWatchIds.size > MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
      this.suppressedWatchIds.delete(this.suppressedWatchIds.values().next().value!);
    }
  }

  private applyToolVisibility(api: ExtensionAPI): void {
    const unrelated = api.getActiveTools().filter((name) => !this.toolNames.includes(name));
    api.setActiveTools(this.enabledValue ? [...unrelated, ...this.toolNames] : unrelated);
  }
}

export function dockToolsExtension(bridge: DockToolsBridge): ExtensionFactory {
  return (pi) => {
    registerDockToolsSwitch(pi, bridge);
    registerWorkMessages(pi, bridge);
    if (bridge.role !== undefined) registerReport(pi, bridge, bridge.role);
    const tools = bridge.role === "lead" ? LEAD_DOCK_TOOLS : bridge.role === "helper" ? [] : TOP_LEVEL_DOCK_TOOLS;
    for (const tool of tools) pi.registerTool({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      execute: async (_toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: PiModelContext & { hasPendingMessages(): boolean }) => piToolResult(await tool.execute(params, {
        invoke: (request) => bridge.invoke(request),
        thinkingLevel: () => pi.getThinkingLevel(),
        modelFacts: () => modelFacts(ctx),
        wait: (request, waitSignal) => bridge.children.wait(request, waitSignal, () => ctx.hasPendingMessages() || bridge.parentMessageWaiting, bridge.takeArrivedChildMessages()),
      }, signal)),
    } as never);
  };
}

function registerDockToolsSwitch(pi: ExtensionAPI, bridge: DockToolsBridge): void {
  pi.registerCommand(DOCK_TOOLS_COMMAND, {
    description: "Turn Agent-facing Dock tools on or off, or show their status",
    getArgumentCompletions: (prefix) => DOCK_TOOLS_ACTIONS
      .filter((action) => action.startsWith(prefix))
      .map((action) => ({ value: action, label: action })),
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!isDockToolsAction(action)) {
        ctx.ui.notify("Use /dock-tools on, /dock-tools off, or /dock-tools status.", "warning");
        return;
      }
      const enabled = await bridge.configure(action);
      const collision = findDockToolCollision(pi, bridge);
      ctx.ui.setStatus(DOCK_TOOLS_STATUS_KEY, enabled ? collision === undefined ? "on" : "unavailable" : undefined);
      ctx.ui.notify(`Dock tools are ${enabled ? "on" : "off"}.`, "info");
    },
  });

  let detach = (): void => {};
  pi.on("session_start", (_event, ctx) => {
    detach();
    const collision = findDockToolCollision(pi, bridge);
    if (collision) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !bridge.toolNames.includes(name)));
      ctx.ui.setStatus(DOCK_TOOLS_STATUS_KEY, bridge.enabled ? "unavailable" : undefined);
      ctx.ui.notify(`Dock tools are unavailable because ${collision.name} is already registered.`, "error");
      detach = bridge.attach(pi, ctx, false);
      return;
    }
    detach = bridge.attach(pi, ctx);
    ctx.ui.setStatus(DOCK_TOOLS_STATUS_KEY, bridge.enabled ? "on" : undefined);
  });
  pi.on("session_shutdown", () => detach());
}

/**
 * Messages between this Work and its parent or child Works join the conversation the way the user's
 * steering does (card #666): at once with a new turn when idle, at the end of the current step when busy.
 */
function registerWorkMessages(pi: ExtensionAPI, bridge: DockToolsBridge): void {
  pi.on("turn_end", () => bridge.atStepEnd());
  pi.on("agent_before_settle", () => bridge.atStepEnd());
  pi.on("agent_settled", (event) => bridge.settled(event.aborted));
  pi.on("session_compact", () => bridge.deliverWorkMessagesSoon());
  pi.on("session_compact_failed", () => bridge.deliverWorkMessagesSoon());
  pi.on("before_agent_start", (event) => { bridge.runStarting(event.messageType); });
  pi.on("message_start", (event) => bridge.messageStarted(event.message as ObservedMessage));
  pi.on("message_end", (event) => { bridge.messageEnded(event.message as ObservedMessage); });
  pi.on("tool_execution_end", (event) => bridge.toolEnded(event));
  // The marker that starts a turn for an idle Work is not something the model reads.
  pi.on("context", (event) => event.messages.some(isWorkWake)
    ? { messages: event.messages.filter((message) => !isWorkWake(message)) }
    : undefined);
}

function isWorkWake(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === WORK_WAKE_TYPE;
}

/** A child Work's dock_send. A lead's also reaches its own child Works, named by target. */
function registerReport(pi: ExtensionAPI, bridge: DockToolsBridge, role: ChildRole): void {
  const toParent = "it reaches your parent at its next step, even while it is working. You and your parent work at the same time. With done: false, tell it what it should know or answer now, such as a finding that affects its work, a question or a point to agree on, and keep working. With done: true, send your final result for the work it handed you; your turn ends. Your parent sees only what you send this way.";
  pi.registerTool({
    name: DOCK_REPORT_TOOL,
    label: role === "lead" ? "Message your parent or child Work" : "Message your parent",
    description: toolDescription(role === "lead"
      ? `Send a message to the Work that created you, leaving out target: ${toParent} Or send one to a child Work of your own, naming it with target and leaving out done; it gets the message at its next step and owes you a result again. Never send acknowledgments or empty progress such as that you are still working.`
      : `Send a message to the Work that created you; ${toParent} Never send acknowledgments or empty progress such as that you are still working.`),
    parameters: role === "lead" ? LEAD_SEND_SCHEMA : CHILD_SEND_SCHEMA,
    execute: async (_toolCallId: string, params: { target?: string; message: string; done?: boolean }) => {
      if (params.target === undefined && params.done === undefined) {
        throw new Error("Set done when you message the Work that created you: true for your final result, false for something it should know or answer now.");
      }
      const result = piToolResult(dockToolOutput(await bridge.invoke({
        type: "send", operationId: randomUUID(), message: params.message,
        ...(params.target === undefined ? {} : { target: params.target }),
        ...(params.done === undefined ? {} : { done: params.done }),
      })));
      // A final result ends the turn: nothing the model would write after it reaches the parent.
      return params.done === true ? { ...result, terminate: true } : result;
    },
  } as never);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
    ? [(block as { text: string }).text] : []).join("\n").trim();
}


function findDockToolCollision(pi: ExtensionAPI, bridge: DockToolsBridge): ReturnType<ExtensionAPI["getAllTools"]>[number] | undefined {
  return pi.getAllTools().find((tool) => bridge.toolNames.includes(tool.name)
    && tool.sourceInfo.path !== DOCK_TOOLS_EXTENSION_PATH);
}

/** The part of Pi's tool context that knows this Worker's models. */
interface PiModelContext {
  model: PiModel | undefined;
  modelRegistry: { getAvailable(): PiModel[] };
}
type PiModel = Parameters<typeof getSupportedThinkingLevels>[0];

/** Facts come from this Worker's Pi, the same configuration a child Work on this machine starts with. */
function modelFacts(ctx: PiModelContext): ModelFacts {
  const describe = (model: PiModel): DescribedModel => ({
    provider: model.provider, id: model.id,
    thinkingLevels: getSupportedThinkingLevels(model),
    ...(typeof model.contextWindow === "number" && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    images: model.input.includes("image"),
  });
  const available = new Map(ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]));
  return {
    ...(ctx.model ? { current: describe(ctx.model) } : {}),
    describe: (ref) => { const model = available.get(`${ref.provider}/${ref.id}`); return model ? describe(model) : undefined; },
  };
}

/** A Dock tool call's outcome in the shape Pi's tools return. */
function piToolResult(output: DockToolOutput): { content: Array<{ type: "text"; text: string }>; details?: unknown } {
  return {
    content: [{ type: "text", text: output.text }],
    ...(output.details === undefined ? {} : { details: output.details }),
  };
}
