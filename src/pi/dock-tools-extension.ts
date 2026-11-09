import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BoundaryResult, ExtensionAPI, ExtensionContext, ExtensionFactory, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import {
  MAX_DOCK_TOOL_CWD_CHARS,
  MAX_DOCK_TOOL_MESSAGE_CHARS,
  MAX_DOCK_TOOL_NAME_CHARS,
  MAX_DOCK_TOOL_TARGET_CHARS,
  shortenLastWords,
  type DockToolsRequest,
  type DockToolsResult,
  type WorkMessage,
} from "../core/dock-tools.js";
import { MAX_SOURCE_FILE_PATH_CHARS } from "../core/source-file.js";
import { MAX_ALLOWED_TOOLS, MAX_ALLOWED_TOOL_NAME_CHARS } from "../core/worker-tool-policy.js";
import { MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS, type ModelRef } from "../control/protocol.js";
import {
  MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE,
  MAX_OBSERVATION_CURSOR_CHARS,
  MAX_OBSERVATION_MESSAGE_LIMIT,
  type ObservationMessageType,
  type ObservationNotification,
} from "../core/instance-observation.js";
import { THINKING_LEVELS } from "../core/agent-worker.js";
import {
  renderChildWait,
  renderDockToolsResult,
  renderObservationNotification,
  workMessageEntry,
  WORK_WAKE_TYPE,
  type DescribedModel,
  type ModelFacts,
  type RenderContext,
} from "./dock-tools-client.js";
import { ChildMessages, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "./child-messages.js";

export const DOCK_TOOL_NAMES = [
  "dock_spawn",
  "dock_wait",
  "dock_models",
  "dock_interrupt",
  "dock_stop",
  "dock_list",
  "dock_machines",
  "dock_inspect",
  "dock_watch",
  "dock_cancel_watch",
  "dock_deliver_file",
  "dock_system",
  "dock_create",
  "dock_send",
] as const;
/** A child Work reports to its parent and reaches nothing else. */
export const CHILD_DOCK_TOOL_NAMES = ["dock_send"] as const;
const DOCK_TOOLS_EXTENSION_PATH = "<inline:alu-dock-tools>";
const DOCK_TOOLS_STATUS_KEY = "Dock tools";
const DOCK_TOOLS_GUIDE_PATH = fileURLToPath(new URL("../../../docs/agent/dock-tools.md", import.meta.url));

function toolDescription(description: string): string {
  return `${description}\nUsage guide (read when needed): ${DOCK_TOOLS_GUIDE_PATH}`;
}
const DOCK_TOOLS_ACTIONS = ["on", "off", "status"] as const;
type DockToolsAction = typeof DOCK_TOOLS_ACTIONS[number];
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const LIST_SCHEMA = {
  type: "object",
  properties: { scope: { type: "string", enum: ["live", "all"] } },
  additionalProperties: false,
};
const INSPECT_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS },
    limit: { type: "integer", minimum: 1, maximum: MAX_OBSERVATION_MESSAGE_LIMIT },
    types: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["user", "assistant", "other"] } },
    cursor: { type: "string", minLength: 1, maxLength: MAX_OBSERVATION_CURSOR_CHARS },
  },
  required: ["target"],
  additionalProperties: false,
};
const REQUIRED_TARGET_SCHEMA = {
  type: "object",
  properties: { target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS } },
  required: ["target"],
  additionalProperties: false,
};
const OPTIONAL_WATCH_SCHEMA = {
  type: "object",
  properties: { watchId: { type: "string", minLength: 1, maxLength: 128 } },
  additionalProperties: false,
};
const DELIVER_SCHEMA = {
  type: "object",
  properties: { path: { type: "string", minLength: 1, maxLength: MAX_SOURCE_FILE_PATH_CHARS } },
  required: ["path"],
  additionalProperties: false,
};
const MACHINE_NAME_SCHEMA = { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS, description: "An exact name from dock_machines. Omit for this Work's Machine." };
const SYSTEM_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    machine: MACHINE_NAME_SCHEMA,
    id: { type: "string", minLength: 1, maxLength: 128, description: "A candidate's id from the list. Reads that candidate instead of listing." },
    cursor: { type: "object", properties: { revision: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["revision", "offset"], additionalProperties: false, description: "The list's nextCursor, for its next page. Only without id." },
    offset: { type: "integer", minimum: 0, description: "The candidate's nextOffset, to continue reading it. Only with id." },
    revision: { type: "string", minLength: 1, maxLength: 128, description: "The revision that came with nextOffset. Only with id." },
  },
  required: ["cwd"], additionalProperties: false,
};
const CREATE_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    systemId: { type: "string", minLength: 1, maxLength: 128, description: "A candidate's id read with dock_system. Omit for the directory default." },
    saveDefault: { type: "boolean" },
    name: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_NAME_CHARS },
    machine: MACHINE_NAME_SCHEMA,
    model: {
      type: "object",
      properties: {
        provider: { type: "string", minLength: 1, maxLength: MAX_MODEL_PROVIDER_CHARS },
        id: { type: "string", minLength: 1, maxLength: MAX_MODEL_ID_CHARS },
      },
      required: ["provider", "id"],
      additionalProperties: false,
    },
  },
  required: ["cwd"],
  additionalProperties: false,
};
const SEND_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS },
    message: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS },
    delivery: { type: "string", enum: ["followUp", "steer"], description: "For another top-level Work only: default followUp lets its current turn finish; steer deliberately supplies guidance during the turn. A child Work of yours always gets the message at its next step." },
  },
  required: ["target", "message"],
  additionalProperties: false,
};
const WAIT_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS, description: "One child Work's name or id: wait for its final result. Omit to wait for the first message from any child Work." },
    all: { type: "boolean", description: "Wait until every child Work you handed work to has sent its final result or stopped." },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, description: `Default ${DEFAULT_WAIT_SECONDS}.` },
  },
  additionalProperties: false,
};
const CHILD_SEND_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS },
    done: { type: "boolean", description: "true: this is your final result for the work your parent handed you; your turn ends after sending it. false: something your parent must know before then, such as a question that blocks you; keep working." },
  },
  required: ["message", "done"],
  additionalProperties: false,
};

const SPAWN_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_NAME_CHARS },
    task: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS },
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    model: CREATE_SCHEMA.properties.model,
    thinkingLevel: { type: "string", enum: THINKING_LEVELS },
    allowedTools: { type: "array", maxItems: MAX_ALLOWED_TOOLS, items: { type: "string", minLength: 1, maxLength: MAX_ALLOWED_TOOL_NAME_CHARS }, uniqueItems: true, description: "Exact Pi tool names such as read, grep, find, ls, edit, write, bash. Omit for normal full tool access; [] grants none. The child can always message you; it never gets other Dock tools. This limits tools, not what a granted shell can do." },
    withContext: { type: "boolean", description: "true starts the child Work from a copy of your conversation so far, so it already knows what you and the user settled; the task then only needs what is new. Omit it for a fresh start, as for an independent reviewer. A copied conversation makes each of the child Work's model requests larger." },
  },
  required: ["name", "task"], additionalProperties: false,
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

/** Worker-level bridge survives Pi resource reloads while API closures do not. */
export class DockToolsBridge {
  private api: ExtensionAPI | undefined;
  private context: ExtensionContext | undefined;
  private enabledValue: boolean;
  private readonly pendingNotifications = new Map<string, ObservationNotification>();
  private readonly deliveredWatchIds = new Set<string>();
  private readonly suppressedWatchIds = new Set<string>();
  private readonly fencedNotifications = new Map<string, ObservationNotification>();
  private deliveryFenceDepth = 0;
  /**
   * Work messages that reached this Worker and are not in the conversation yet, oldest first. Pi's own
   * queues are not used: taking back the user's Queue empties them, extension messages included.
   */
  private readonly inbox: WorkMessage[] = [];
  /**
   * Work messages went into the conversation, or go in at the end of this step, and no reply has started
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
  private readonly turn: ChildTurn = { taskSeen: false, hasParentWork: false, reachedParent: false };
  readonly children = new ChildMessages();
  readonly toolNames: readonly string[];

  constructor(initiallyEnabled: boolean, private readonly port: DockToolsCallPort, readonly child = false) {
    this.enabledValue = initiallyEnabled;
    this.toolNames = child ? CHILD_DOCK_TOOL_NAMES : DOCK_TOOL_NAMES;
  }

  get enabled(): boolean { return this.enabledValue; }

  /** Binds the current runtime. Work messages arrive even when the tools are unavailable. */
  attach(api: ExtensionAPI, context?: ExtensionContext, toolsAvailable = true): () => void {
    this.api = api;
    this.context = context;
    // A message left unanswered belongs to the conversation it was written into.
    this.awaitingReply = false;
    this.turnRequested = false;
    if (toolsAvailable) {
      this.applyToolVisibility(api);
      if (this.enabledValue && this.deliveryFenceDepth === 0) this.flushPendingNotifications();
    }
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
    this.inbox.push(message);
    this.deliverWorkMessages();
  }

  /** Child Work messages that arrived during the current step, for a dock_wait that starts now. */
  takeArrivedChildMessages(): WorkMessage[] {
    const arrived = this.inbox.filter((message) => message.from.relation === "child");
    for (const message of arrived) this.inbox.splice(this.inbox.indexOf(message), 1);
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

  toolEnded(event: Pick<ToolExecutionEndEvent, "toolName" | "isError" | "parentToolCallId">): void {
    if (!this.child || event.parentToolCallId !== undefined) return;
    this.turn.reachedParent = event.toolName === "dock_send" && !event.isError;
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

  /** Hands waiting messages to Pi in arrival order: written at once while idle, after the current step while busy. */
  private handOver(api: ExtensionAPI): void {
    while (this.inbox.length > 0) {
      const message = this.inbox[0]!;
      api.sendMessage(workMessageEntry(message), { triggerTurn: false });
      this.inbox.shift();
      this.awaitingReply = true;
      // New work from the parent is owed a report again, whatever the child Work sent it before.
      if (this.child && message.from.relation === "parent") {
        this.turn.hasParentWork = true;
        this.turn.reachedParent = false;
      }
    }
  }

  /**
   * A child Work's turn that carried its parent's work ended, and its last call did not reach the parent.
   * The Host tells the parent if a result is still owed; the child Work is not asked to report again.
   */
  private reportUnreportedStop(aborted: boolean): void {
    const { hasParentWork, reachedParent, lastWords, failure } = this.turn;
    Object.assign(this.turn, { hasParentWork: false, reachedParent: false, lastWords: undefined, failure: undefined });
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
      if (!result.enabled) this.suppressEveryPendingNotification();
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
          if (request.watchId === undefined) this.suppressEveryPendingNotification();
          else this.suppressAndRemove(request.watchId);
          for (const watchId of result.cancelledWatchIds) this.suppressAndRemove(watchId);
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

  deliver(notification: ObservationNotification): void {
    if (this.suppressedWatchIds.has(notification.watchId) || this.deliveredWatchIds.has(notification.watchId)) return;
    if (this.deliveryFenceDepth > 0) {
      this.addBounded(this.fencedNotifications, notification);
      return;
    }
    if (!this.enabledValue) {
      this.suppressAndRemove(notification.watchId);
      return;
    }
    if (!this.api) {
      if (!this.pendingNotifications.has(notification.watchId)
        && this.pendingNotifications.size >= MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
        throw new Error("Dock tools completion queue is full");
      }
      this.pendingNotifications.set(notification.watchId, notification);
      return;
    }
    this.sendNotification(this.api, notification);
  }

  private flushPendingNotifications(): void {
    const api = this.api;
    if (!api || !this.enabledValue || this.deliveryFenceDepth > 0) return;
    for (const [watchId, notification] of this.pendingNotifications) {
      try {
        this.sendNotification(api, notification);
        this.pendingNotifications.delete(watchId);
      } catch { /* Keep the one-shot completion for the next binding rather than fail reload. */ }
    }
  }

  private beginDeliveryFence(): void { this.deliveryFenceDepth += 1; }

  private endDeliveryFence(): void {
    this.deliveryFenceDepth -= 1;
    if (this.deliveryFenceDepth !== 0) return;
    const buffered = [...this.fencedNotifications.values()];
    this.fencedNotifications.clear();
    for (const notification of buffered) this.deliver(notification);
    this.flushPendingNotifications();
  }

  private suppressEveryPendingNotification(): void {
    for (const watchId of this.pendingNotifications.keys()) this.suppress(watchId);
    for (const watchId of this.fencedNotifications.keys()) this.suppress(watchId);
    this.pendingNotifications.clear();
    this.fencedNotifications.clear();
  }

  private suppressAndRemove(watchId: string): void {
    this.suppress(watchId);
    this.pendingNotifications.delete(watchId);
    this.fencedNotifications.delete(watchId);
  }

  private addBounded(target: Map<string, ObservationNotification>, notification: ObservationNotification): void {
    if (!target.has(notification.watchId) && target.size >= MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
      throw new Error("Dock tools completion queue is full");
    }
    target.set(notification.watchId, notification);
  }

  private sendNotification(api: ExtensionAPI, notification: ObservationNotification): void {
    api.sendMessage({
      customType: "dock-tools-watch",
      content: renderObservationNotification(notification),
      display: true,
      details: notification,
      // The watcher asked to hear this. While it works the notice joins its next step;
      // queued behind the whole turn it arrived only after the watcher had moved on.
    }, { triggerTurn: true, deliverAs: "steer" });
    this.markDelivered(notification);
  }

  private markDelivered(notification: ObservationNotification): void {
    this.deliveredWatchIds.add(notification.watchId);
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
    if (bridge.child) {
      registerChildTools(pi, bridge);
      return;
    }
    pi.registerTool({
      name: "dock_spawn", label: "Start a child Work",
      description: toolDescription("Create a child Work for a task of yours and start it. It works in your workspace with your model and thinking level. Set model or thinkingLevel only when the user or the project's instructions ask for one, never because a task looks easy or hard; dock_models gives the exact name of a model the user picked. A model without that thinking level runs at the nearest one it has, and the result says so. It starts with only the task unless withContext gives it a copy of your conversation. It appears under you in Dock, talks only to you and cannot reach other Works. It sends you its final result, and any question it must ask first, as messages from it that reach you at your next step if you are still working; if it stops without its result, Dock tells you. Send it more with dock_send and stop it with dock_stop when you no longer need it. Child Works that edit and build at the same time need separate directories: give each its own git worktree as cwd and merge their work yourself. After starting child Works, end your turn unless you have work of your own; do not poll them. If your turn must not end, as during a Dock Goal, use dock_wait. It also stops when you stop. If creation succeeded but the task was not confirmed, inspect it before sending the task again. For an independent review grant only read, grep, find and ls."),
      parameters: SPAWN_SCHEMA,
      execute: async (_toolCallId: string, params: Omit<Extract<DockToolsRequest, { type: "spawn" }>, "type" | "operationId">) => {
        const thinkingAsked = params.thinkingLevel ?? pi.getThinkingLevel();
        return toolResult(await bridge.invoke({ ...params, type: "spawn", operationId: randomUUID() }), { thinkingAsked });
      },
    } as never);
    pi.registerTool({
      name: "dock_wait", label: "Wait for child Works",
      description: toolDescription("Wait in this turn for your child Works: until the first message from any of them, until target sends its final result, or with all=true until every child Work you handed work to has sent its final result or stopped. Messages from child Works that arrive meanwhile come back here instead of separately; one that is not a final result, such as a question, ends the wait at once. Returns early when the user's message reaches you or the user cancels. Use it only when your turn must not end, such as during a Dock Goal, whose next round would start as soon as your turn ends; otherwise end your turn and the messages wake you."),
      parameters: WAIT_SCHEMA,
      execute: async (_toolCallId: string, params: { target?: string; all?: boolean; timeoutSeconds?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { hasPendingMessages(): boolean }) => {
        const result = await bridge.children.wait(params, signal, () => ctx.hasPendingMessages(), bridge.takeArrivedChildMessages());
        return { content: [{ type: "text", text: renderChildWait(result) }], details: result };
      },
    } as never);
    pi.registerTool({
      name: "dock_models", label: "Models for child Works",
      description: toolDescription("Show your own model, which child Works use unless the user or the project's instructions ask for another, and the few models the user picked for child Works, with what each supports. Use it to find the exact name of a model you were asked to use; it is not a recommendation."),
      parameters: EMPTY_SCHEMA,
      execute: async (_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: PiModelContext) => toolResult(await bridge.invoke({ type: "models" }), { facts: modelFacts(ctx) }),
    } as never);
    for (const action of ["interrupt", "stop"] as const) pi.registerTool({
      name: `dock_${action}`, label: action === "interrupt" ? "Interrupt a Work" : "Stop a Work",
      description: toolDescription(action === "interrupt" ? "Interrupt another Work's current turn. Its work stays available for follow-up. Ordinary messages should use dock_send instead." : "Permanently stop another Work. Its child Works also stop and exit and leave the work list; their conversation files remain on disk. Check dock_list first."),
      parameters: REQUIRED_TARGET_SCHEMA,
      execute: async (_toolCallId: string, params: { target: string }) => toolResult(await bridge.invoke({ type: action, operationId: randomUUID(), target: params.target })),
    } as never);
    pi.registerTool({
      name: "dock_list",
      label: "List Dock Works",
      description: toolDescription("List the Works you can see, without reading their conversations. Use scope='all' only when stopped or unavailable history is relevant."),
      parameters: LIST_SCHEMA,
      execute: async (_toolCallId: string, params: { scope?: "live" | "all" }) => toolResult(await bridge.invoke({
        type: "list",
        ...(params.scope === "all" ? { includeHistory: true } : {}),
      })),
    } as never);
    pi.registerTool({
      name: "dock_machines",
      label: "List Dock Machines",
      description: toolDescription("List current Machines with their names, availability, platform, Home, and workspace roots. The Machine this Work runs on is marked."),
      parameters: EMPTY_SCHEMA,
      execute: async () => toolResult(await bridge.invoke({ type: "machines" })),
    } as never);
    pi.registerTool({
      name: "dock_inspect",
      label: "Inspect a Work",
      description: toolDescription("Read a page of another Work’s conversation. Selected messages come whole; one too long for a page says so and continues on the next page. Source roles identify who said each message."),
      parameters: INSPECT_SCHEMA,
      execute: async (_toolCallId: string, params: { target: string; limit?: number; types?: ObservationMessageType[]; cursor?: string }) => toolResult(await bridge.invoke({
        type: "inspect",
        target: params.target,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.types === undefined ? {} : { types: params.types }),
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      })),
    } as never);
    pi.registerTool({
      name: "dock_watch",
      label: "Watch a Work",
      description: toolDescription("Get a notification when another Work becomes idle, stops or fails. Returns immediately; continue other work while waiting. The notification reaches you at your next step if you are still working. Your own child Works need no watch: they send you their results."),
      parameters: REQUIRED_TARGET_SCHEMA,
      execute: async (_toolCallId: string, params: { target: string }) => toolResult(await bridge.invoke({ type: "watch", target: params.target })),
    } as never);
    pi.registerTool({
      name: "dock_cancel_watch",
      label: "Cancel Dock watches",
      description: toolDescription("Cancel one source-owned watch, or all watches when watchId is omitted."),
      parameters: OPTIONAL_WATCH_SCHEMA,
      execute: async (_toolCallId: string, params: { watchId?: string }) => toolResult(await bridge.invoke({ type: "cancel", ...(params.watchId === undefined ? {} : { watchId: params.watchId }) })),
    } as never);
    pi.registerTool({
      name: "dock_deliver_file",
      label: "Deliver a temporary file",
      description: toolDescription("Register an absolute local file path for temporary download by the user. The file must remain unchanged and available."),
      parameters: DELIVER_SCHEMA,
      execute: async (_toolCallId: string, params: { path: string }) => toolResult(await bridge.invoke({ type: "deliver", path: params.path })),
    } as never);
    pi.registerTool({
      name: "dock_system",
      label: "Read Dock systems",
      description: toolDescription("Find the systems a new Work in an absolute cwd can start from, or read one. Without id it lists candidates; pass the list's nextCursor as cursor for the next page. With id it reads that candidate; pass its nextOffset as offset, with the revision that came with it, to continue. cursor goes only without id, offset and revision only with id."),
      parameters: SYSTEM_SCHEMA,
      execute: async (_toolCallId: string, params: Omit<Extract<DockToolsRequest, { type: "system" }>, "type">) => toolResult(await bridge.invoke({ type: "system", ...params })),
    } as never);
    pi.registerTool({
      name: "dock_create",
      label: "Create Dock work",
      description: toolDescription("Create a new top-level Work in an absolute working directory. Omit machine to create it on this Work's Machine; name another Machine exactly as dock_machines lists it. Set systemId only to an id read with dock_system. Without systemId, the creating Host applies its directory default, or Pi native behavior when none is configured; a broken configured default fails creation. saveDefault=true explicitly saves the selected system before creating. Saving and creating are separate outcomes. model is the exact {provider,id} the new Work starts with, as the owner names it; omit it for the target Machine's Pi default. An unavailable model fails creation. The new Work can collaborate immediately. For a task of your own use dock_spawn."),
      parameters: CREATE_SCHEMA,
      execute: async (_toolCallId: string, params: { cwd: string; name?: string; machine?: string; systemId?: string; saveDefault?: boolean; model?: ModelRef }) => toolResult(await bridge.invoke({
        type: "create",
        operationId: randomUUID(),
        cwd: params.cwd,
        ...(params.systemId === undefined ? {} : { systemId: params.systemId }),
        ...(params.saveDefault === undefined ? {} : { saveDefault: params.saveDefault }),
        ...(params.model === undefined ? {} : { model: { provider: params.model.provider, id: params.model.id } }),
        ...(params.name === undefined ? {} : { name: params.name }),
        ...(params.machine === undefined ? {} : { machine: params.machine }),
      })),
    } as never);
    pi.registerTool({
      name: "dock_send",
      label: "Send a Dock message",
      description: toolDescription("Send a message to another Work with your authenticated sender identity. A child Work of yours gets it at its next step as a message from you, and its answers come back the same way. Another top-level Work is started if idle, or gets it after its current turn; use delivery=steer only for deliberate mid-turn guidance. Do not send acknowledgment-only messages: each one wakes the other Work."),
      parameters: SEND_SCHEMA,
      execute: async (_toolCallId: string, params: { target: string; message: string; delivery?: "followUp" | "steer" }) => toolResult(await bridge.invoke({
        type: "send",
        operationId: randomUUID(),
        target: params.target,
        message: params.message,
        ...(params.delivery === undefined ? {} : { delivery: params.delivery }),
      })),
    } as never);
  };
}

function registerDockToolsSwitch(pi: ExtensionAPI, bridge: DockToolsBridge): void {
  pi.registerCommand("dock-tools", {
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

function registerChildTools(pi: ExtensionAPI, bridge: DockToolsBridge): void {
  pi.registerTool({
    name: "dock_send",
    label: "Message your parent",
    description: toolDescription("Send a message to the Work that created you; it reaches your parent at its next step, even while it is working. Your parent sees only what you send this way. done: true sends your final result for the work it handed you, and your turn ends. done: false is for something it must know before then, such as a question that blocks you; keep working afterwards. Do not send acknowledgments or progress reports."),
    parameters: CHILD_SEND_SCHEMA,
    execute: async (_toolCallId: string, params: { message: string; done: boolean }) => {
      const result = toolResult(await bridge.invoke({ type: "send", operationId: randomUUID(), message: params.message, done: params.done }));
      // A final result ends the turn: nothing the model would write after it reaches the parent.
      return params.done ? { ...result, terminate: true } : result;
    },
  } as never);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
    ? [(block as { text: string }).text] : []).join("\n").trim();
}

function isDockToolsAction(value: string): value is DockToolsAction {
  return (DOCK_TOOLS_ACTIONS as readonly string[]).includes(value);
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

function toolResult(value: DockToolsResult, context?: RenderContext): { content: Array<{ type: "text"; text: string }>; details?: DockToolsResult } {
  return {
    content: [{ type: "text", text: renderDockToolsResult(value, context) }],
    ...(value.type === "machines" ? {} : { details: value }),
  };
}
