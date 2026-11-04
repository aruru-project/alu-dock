import { THINKING_LEVELS } from "../core/agent-worker.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  MAX_DOCK_TOOL_CWD_CHARS,
  MAX_DOCK_TOOL_MESSAGE_CHARS,
  MAX_DOCK_TOOL_NAME_CHARS,
  MAX_DOCK_TOOL_TARGET_CHARS,
  type DockToolsRequest,
  type DockToolsResult,
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
  type ObservedInstanceStatus,
} from "../core/instance-observation.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { renderDockToolsResult, renderHelperWait, renderObservationNotification, type DescribedModel, type HelperWaitResult, type ModelFacts } from "./dock-tools-client.js";

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
const DEFAULT_WAIT_SECONDS = 1_800;
const MAX_WAIT_SECONDS = 7_200;
/** How often a wait checks whether a message is waiting for this Work. */
const WAIT_POLL_MS = 200;
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
const SYSTEM_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    machine: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS },
    id: { type: "string", minLength: 1, maxLength: 128 },
    cursor: { type: "object", properties: { revision: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["revision", "offset"], additionalProperties: false },
    offset: { type: "integer", minimum: 0 },
    revision: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["cwd"], additionalProperties: false,
};
const CREATE_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    systemId: { type: "string", minLength: 1, maxLength: 128 },
    saveDefault: { type: "boolean" },
    name: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_NAME_CHARS },
    machine: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS },
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
    delivery: { type: "string", enum: ["followUp", "steer"], description: "Default followUp lets the current turn finish; steer deliberately supplies guidance during the turn." },
  },
  required: ["target", "message"],
  additionalProperties: false,
};
const WAIT_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS, description: "One helper's name or id. Omit to wait for any helper that owes you a reply." },
    all: { type: "boolean", description: "Wait until every awaited helper has replied instead of the first." },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, description: `Default ${DEFAULT_WAIT_SECONDS}.` },
  },
  additionalProperties: false,
};
const CHILD_SEND_SCHEMA = {
  type: "object",
  properties: { message: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS } },
  required: ["message"],
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
    withContext: { type: "boolean", description: "true starts the helper from a copy of your conversation so far, so it already knows what you and the user settled; the task then only needs what is new. Omit it for a fresh start, as for an independent reviewer. A copied conversation makes each of the helper's model requests larger." },
  },
  required: ["name", "task"], additionalProperties: false,
};

export interface DockToolsCallPort {
  configure(action: "on" | "off" | "status"): Promise<{ enabled: boolean }>;
  invoke(request: DockToolsRequest): Promise<DockToolsResult>;
}

/** Worker-level bridge survives Pi resource reloads while API closures do not. */
export class DockToolsBridge {
  private api: ExtensionAPI | undefined;
  private enabledValue: boolean;
  private readonly pendingNotifications = new Map<string, ObservationNotification>();
  private readonly deliveredWatchIds = new Set<string>();
  private readonly suppressedWatchIds = new Set<string>();
  private readonly fencedNotifications = new Map<string, ObservationNotification>();
  private deliveryFenceDepth = 0;
  /** Helpers that owe this Work a reply: handed work, not yet replied or stopped. */
  private readonly awaitedHelpers = new Map<string, ObservedInstanceStatus>();
  /** When each helper's reply last reached this Work, on a counter that orders replies and calls. */
  private readonly lastReplies = new Map<string, number>();
  private replyCount = 0;
  private waiter: { ids: ReadonlySet<string>; all: boolean; replies: ObservationNotification[]; finish(ended: HelperWaitResult["ended"]): void } | undefined;
  readonly toolNames: readonly string[];

  constructor(initiallyEnabled: boolean, private readonly port: DockToolsCallPort, readonly child = false) {
    this.enabledValue = initiallyEnabled;
    this.toolNames = child ? CHILD_DOCK_TOOL_NAMES : DOCK_TOOL_NAMES;
  }

  get enabled(): boolean { return this.enabledValue; }

  attach(api: ExtensionAPI): () => void {
    this.api = api;
    this.applyToolVisibility(api);
    if (this.enabledValue && this.deliveryFenceDepth === 0) this.flushPendingNotifications();
    return () => { if (this.api === api) this.api = undefined; };
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
      if (!result.enabled) {
        // Off cancels every watch on the Host, so no awaited reply will come.
        this.suppressEveryPendingNotification();
        this.awaitedHelpers.clear();
        this.waiter?.finish("cancelled");
      }
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
          if (request.watchId === undefined) {
            // Cancelling every watch includes the ones that bring helpers' replies back.
            this.suppressEveryPendingNotification();
            this.awaitedHelpers.clear();
            this.waiter?.finish("cancelled");
          }
          else this.suppressAndRemove(request.watchId);
          for (const watchId of result.cancelledWatchIds) this.suppressAndRemove(watchId);
        }
        return result;
      } finally {
        this.endDeliveryFence();
      }
    }
    const repliesBefore = this.replyCount;
    const result = await this.port.invoke(request);
    this.noteHelperWork(result, repliesBefore);
    return result;
  }

  /**
   * Waits in the current turn until awaited helpers reply, a message reaches this Work, the
   * user cancels, or time runs out. Replies it takes are returned instead of sent separately.
   */
  async waitForHelpers(
    request: { target?: string; all?: boolean; timeoutSeconds?: number },
    signal: AbortSignal | undefined,
    hasPendingMessages: () => boolean,
  ): Promise<HelperWaitResult> {
    if (this.waiter) throw new Error("dock_wait is already waiting in another call.");
    const awaited = [...this.awaitedHelpers.values()];
    const chosen = request.target === undefined ? awaited : awaited.filter((status) => status.id === request.target || status.name === request.target);
    if (chosen.length > 1 && request.target !== undefined) throw new Error(`More than one helper is named ${request.target}; use its id.`);
    if (chosen.length === 0) return { replies: [], waiting: [], ended: "nothing_pending" };
    const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
    let ended: HelperWaitResult["ended"] | undefined;
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    const waiter = {
      ids: new Set(chosen.map((status) => status.id)), all: request.all === true, replies: [] as ObservationNotification[],
      finish: (reason: HelperWaitResult["ended"]) => { ended ??= reason; wake(); },
    };
    this.waiter = waiter;
    const timer = setTimeout(() => waiter.finish("timeout"), timeoutSeconds * 1_000);
    const poll = setInterval(() => { if (hasPendingMessages()) waiter.finish("message"); }, WAIT_POLL_MS);
    const cancel = (): void => waiter.finish("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    if (hasPendingMessages()) waiter.finish("message");
    try {
      await woken;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", cancel);
      if (this.waiter === waiter) this.waiter = undefined;
    }
    return {
      replies: waiter.replies,
      waiting: chosen.filter((status) => this.awaitedHelpers.has(status.id)),
      ended: ended!,
      ...(ended === "timeout" ? { timeoutSeconds } : {}),
    };
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
    const waiter = this.waiter;
    if (waiter?.ids.has(notification.target.id)) {
      this.markDelivered(notification);
      waiter.replies.push(notification);
      if (!waiter.all || waiter.replies.length === waiter.ids.size) waiter.finish("replied");
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
    this.awaitedHelpers.delete(notification.target.id);
    this.lastReplies.delete(notification.target.id);
    this.lastReplies.set(notification.target.id, ++this.replyCount);
    if (this.lastReplies.size > MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) this.lastReplies.delete(this.lastReplies.keys().next().value!);
    this.deliveredWatchIds.add(notification.watchId);
    while (this.deliveredWatchIds.size > MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
      this.deliveredWatchIds.delete(this.deliveredWatchIds.values().next().value!);
    }
  }

  private noteHelperWork(result: DockToolsResult, repliesBefore: number): void {
    if (result.type === "stop") {
      this.awaitedHelpers.delete(result.instance.id);
      return;
    }
    const helper = result.type === "spawn" && result.taskStatus === "accepted" && result.error === undefined ? result.instance
      : result.type === "send" && result.target.parentId !== undefined && result.error === undefined ? result.target
        : undefined;
    // A helper that failed or finished at once may have replied before this call returned.
    if (helper && (this.lastReplies.get(helper.id) ?? 0) <= repliesBefore) this.awaitedHelpers.set(helper.id, helper);
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
    if (bridge.child) {
      registerChildTools(pi, bridge);
      return;
    }
    pi.registerTool({
      name: "dock_spawn", label: "Delegate a Dock task",
      description: toolDescription("Create a helper Work for a task of yours and start it. It works in your workspace with your current model and thinking unless you choose others; dock_models lists the models. It starts with only the task unless withContext gives it a copy of your conversation. It appears under you in Dock, reports only to you and cannot reach other Works. Its final reply is delivered to you when it finishes, at your next step if you are still working; send further instructions with dock_send and stop it with dock_stop when you no longer need it. Helpers that edit and build at the same time need separate directories: give each its own git worktree as cwd and merge their work yourself. After starting helpers, end your turn unless you have work of your own; do not poll them. If your turn must not end, as during a Dock Goal, use dock_wait. It also stops when you stop. If creation succeeded but the task was not confirmed, inspect it before sending the task again. For an independent review grant only read, grep, find and ls."),
      parameters: SPAWN_SCHEMA,
      execute: async (_toolCallId: string, params: Omit<Extract<DockToolsRequest, { type: "spawn" }>, "type" | "operationId">) => toolResult(await bridge.invoke({ ...params, type: "spawn", operationId: randomUUID() })),
    } as never);
    pi.registerTool({
      name: "dock_wait", label: "Wait for helpers",
      description: toolDescription("Wait in this turn until a helper you handed work to replies; all=true waits for every one of them, target for one. Their final replies come back here instead of arriving separately. Returns early when a message reaches you, such as the user's or a helper's question, or when the user cancels. Use it only when your turn must not end, such as during a Dock Goal, whose next round would start as soon as your turn ends; otherwise end your turn and the replies wake you."),
      parameters: WAIT_SCHEMA,
      execute: async (_toolCallId: string, params: { target?: string; all?: boolean; timeoutSeconds?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { hasPendingMessages(): boolean }) => {
        const result = await bridge.waitForHelpers(params, signal, () => ctx.hasPendingMessages());
        return { content: [{ type: "text", text: renderHelperWait(result) }], details: result };
      },
    } as never);
    pi.registerTool({
      name: "dock_models", label: "Models for helpers",
      description: toolDescription("Show your own model, which a helper uses when you omit model, and the models the user lists for helpers with the user's notes and what each supports. Use it before choosing a model for dock_spawn; usually omit model."),
      parameters: EMPTY_SCHEMA,
      execute: async (_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: PiModelContext) => toolResult(await bridge.invoke({ type: "models" }), modelFacts(ctx)),
    } as never);
    for (const action of ["interrupt", "stop"] as const) pi.registerTool({
      name: `dock_${action}`, label: action === "interrupt" ? "Interrupt a worker" : "Stop a worker",
      description: toolDescription(action === "interrupt" ? "Interrupt another worker's current turn. Its work stays available for follow-up. Ordinary messages should use dock_send instead." : "Permanently stop another Dock worker. Its children also stop and exit. Collected children leave the work list; their conversation files remain on disk. Use dock_list to inspect the team first."),
      parameters: REQUIRED_TARGET_SCHEMA,
      execute: async (_toolCallId: string, params: { target: string }) => toolResult(await bridge.invoke({ type: action, operationId: randomUUID(), target: params.target })),
    } as never);
    pi.registerTool({
      name: "dock_list",
      label: "List Dock siblings",
      description: toolDescription("List sibling Dock instances without reading their conversations. Use scope='all' only when stopped or unavailable history is relevant."),
      parameters: LIST_SCHEMA,
      execute: async (_toolCallId: string, params: { scope?: "live" | "all" }) => toolResult(await bridge.invoke({
        type: "list",
        ...(params.scope === "all" ? { includeHistory: true } : {}),
      })),
    } as never);
    pi.registerTool({
      name: "dock_machines",
      label: "List Dock Machines",
      description: toolDescription("List current Machines with their names, availability, platform, Home, and workspace roots."),
      parameters: EMPTY_SCHEMA,
      execute: async () => toolResult(await bridge.invoke({ type: "machines" })),
    } as never);
    pi.registerTool({
      name: "dock_inspect",
      label: "Inspect a Dock sibling",
      description: toolDescription("Read a page of another worker’s conversation without shortening selected messages. Source roles identify who said each message."),
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
      label: "Watch a Dock sibling",
      description: toolDescription("Get a notification when another worker becomes idle, stops or fails. Returns immediately; continue other work while waiting. The notification reaches you at your next step if you are still working."),
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
      description: toolDescription("Discover systems for an absolute cwd, or read a candidate using id. Follow nextCursor for catalog pages; use nextOffset and revision for content pages. Omitted machine means this work's Machine."),
      parameters: SYSTEM_SCHEMA,
      execute: async (_toolCallId: string, params: Omit<Extract<DockToolsRequest, { type: "system" }>, "type">) => toolResult(await bridge.invoke({ type: "system", ...params })),
    } as never);
    pi.registerTool({
      name: "dock_create",
      label: "Create Dock work",
      description: toolDescription("Create a new Dock instance in an absolute working directory. Use an exact Machine name to place it on another Machine; omit machine to use this work's Machine. Select systemId from dock_system to override the Host default. Without systemId, the creating Host applies its directory default, or Pi native behavior when none is configured; a broken configured default fails creation. saveDefault=true explicitly saves the selected system before creating. Saving and creating are separate outcomes. model is the exact {provider,id} the new instance starts with, as the owner names it; omit it for the target Machine's Pi default. An unavailable model fails creation. The new work can collaborate immediately. For a child task use dock_spawn."),
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
      description: toolDescription("Send a message to another worker with your authenticated sender identity. By default it starts an idle worker or queues behind its current turn. Use delivery=steer only for deliberate mid-turn guidance. A helper you created replies to you when it finishes. Do not send acknowledgment-only messages: each one wakes the other worker."),
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
      return;
    }
    detach = bridge.attach(pi);
    ctx.ui.setStatus(DOCK_TOOLS_STATUS_KEY, bridge.enabled ? "on" : undefined);
  });
  pi.on("session_shutdown", () => detach());
}

function registerChildTools(pi: ExtensionAPI, bridge: DockToolsBridge): void {
  pi.registerTool({
    name: "dock_send",
    label: "Message your parent",
    description: toolDescription("Send a message to the Work that created you. When you finish work it handed you, your final reply already reaches it, so use this only for something it must know before then, such as a question that blocks you. It reaches your parent at its next step, even while it is working. Do not send acknowledgments or progress reports."),
    parameters: CHILD_SEND_SCHEMA,
    execute: async (_toolCallId: string, params: { message: string }) => toolResult(await bridge.invoke({ type: "send", operationId: randomUUID(), message: params.message })),
  } as never);
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

/** Facts come from this Worker's Pi, the same configuration a helper on this machine starts with. */
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

function toolResult(value: DockToolsResult, facts?: ModelFacts): { content: Array<{ type: "text"; text: string }>; details?: DockToolsResult } {
  return {
    content: [{ type: "text", text: renderDockToolsResult(value, facts) }],
    ...(value.type === "machines" ? {} : { details: value }),
  };
}
