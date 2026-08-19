import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  MAX_DOCK_TOOL_CWD_CHARS,
  MAX_DOCK_TOOL_MESSAGE_CHARS,
  MAX_DOCK_TOOL_NAME_CHARS,
  MAX_DOCK_TOOL_TARGET_CHARS,
  type DockToolsRequest,
  type DockToolsResult,
} from "../core/dock-tools.js";
import {
  MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE,
  MAX_OBSERVATION_CURSOR_CHARS,
  MAX_OBSERVATION_MESSAGE_LIMIT,
  OBSERVATION_DATA_NOTICE,
  type ObservationMessageType,
  type ObservationNotification,
} from "../core/instance-observation.js";
import { renderDockToolsResult, renderObservationNotification } from "./dock-tools-client.js";

export const DOCK_TOOL_NAMES = [
  "dock_list",
  "dock_inspect",
  "dock_watch",
  "dock_cancel_watch",
  "dock_create",
  "dock_send",
] as const;
const DOCK_TOOLS_EXTENSION_PATH = "<inline:alu-dock-tools>";
const TOOL_NAMES = new Set<string>(DOCK_TOOL_NAMES);
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
const CREATE_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    name: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_NAME_CHARS },
  },
  required: ["cwd"],
  additionalProperties: false,
};
const SEND_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS },
    message: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS },
  },
  required: ["target", "message"],
  additionalProperties: false,
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

  constructor(initiallyEnabled: boolean, private readonly port: DockToolsCallPort) {
    this.enabledValue = initiallyEnabled;
  }

  get enabled(): boolean { return this.enabledValue; }

  attach(api: ExtensionAPI): () => void {
    this.api = api;
    this.applyToolVisibility(api);
    if (this.enabledValue && this.deliveryFenceDepth === 0) this.flushPendingNotifications();
    return () => { if (this.api === api) this.api = undefined; };
  }

  async configure(action: "on" | "off" | "status"): Promise<boolean> {
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
    return this.port.invoke(request);
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
    }, { triggerTurn: true, deliverAs: "followUp" });
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
    const unrelated = api.getActiveTools().filter((name) => !TOOL_NAMES.has(name));
    api.setActiveTools(this.enabledValue ? [...unrelated, ...DOCK_TOOL_NAMES] : unrelated);
  }
}

export function dockToolsExtension(bridge: DockToolsBridge): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "dock_list",
      label: "List Dock siblings",
      description: "List sibling Dock instances without reading their conversations. Use scope='all' only when stopped or unavailable history is relevant.",
      parameters: LIST_SCHEMA,
      execute: async (_toolCallId: string, params: { scope?: "live" | "all" }) => toolResult(await bridge.invoke({
        type: "list",
        ...(params.scope === "all" ? { includeHistory: true } : {}),
      })),
    } as never);
    pi.registerTool({
      name: "dock_inspect",
      label: "Inspect a Dock sibling",
      description: `Read a bounded page of one sibling's conversation. ${OBSERVATION_DATA_NOTICE}`,
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
      description: `Register a one-shot watch for a sibling's next terminal execution state. ${OBSERVATION_DATA_NOTICE}`,
      parameters: REQUIRED_TARGET_SCHEMA,
      execute: async (_toolCallId: string, params: { target: string }) => toolResult(await bridge.invoke({ type: "watch", target: params.target })),
    } as never);
    pi.registerTool({
      name: "dock_cancel_watch",
      label: "Cancel Dock watches",
      description: "Cancel one source-owned watch, or all watches when watchId is omitted.",
      parameters: OPTIONAL_WATCH_SCHEMA,
      execute: async (_toolCallId: string, params: { watchId?: string }) => toolResult(await bridge.invoke({ type: "cancel", ...(params.watchId === undefined ? {} : { watchId: params.watchId }) })),
    } as never);
    pi.registerTool({
      name: "dock_create",
      label: "Create Dock work",
      description: "Create a new Dock instance in an absolute working directory. The new instance starts with Dock tools off.",
      parameters: CREATE_SCHEMA,
      execute: async (_toolCallId: string, params: { cwd: string; name?: string }) => toolResult(await bridge.invoke({
        type: "create",
        operationId: randomUUID(),
        cwd: params.cwd,
        ...(params.name === undefined ? {} : { name: params.name }),
      })),
    } as never);
    pi.registerTool({
      name: "dock_send",
      label: "Send a Dock message",
      description: "Send a user message to one sibling through normal Dock Queue/delivery semantics. Dock adds a visible source-instance wrapper.",
      parameters: SEND_SCHEMA,
      execute: async (_toolCallId: string, params: { target: string; message: string }) => toolResult(await bridge.invoke({
        type: "send",
        operationId: randomUUID(),
        target: params.target,
        message: params.message,
      })),
    } as never);

    pi.registerCommand("dock-tools", {
      description: "Turn Agent-facing Dock tools on or off, or show their status",
      handler: async (args, ctx) => {
        const action = args.trim() || "status";
        if (action !== "on" && action !== "off" && action !== "status") {
          ctx.ui.notify("Use /dock-tools on, /dock-tools off, or /dock-tools status.", "warning");
          return;
        }
        const enabled = await bridge.configure(action);
        ctx.ui.notify(`Dock tools are ${enabled ? "on" : "off"}.`, "info");
        if (action !== "status") await ctx.reload();
      },
    });

    let detach = (): void => {};
    pi.on("session_start", (_event, ctx) => {
      detach();
      const collision = pi.getAllTools().find((tool) => TOOL_NAMES.has(tool.name)
        && tool.sourceInfo.path !== DOCK_TOOLS_EXTENSION_PATH);
      if (collision) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.has(name)));
        ctx.ui.notify(`Dock tools are unavailable because ${collision.name} is already registered.`, "error");
        return;
      }
      detach = bridge.attach(pi);
    });
    pi.on("session_shutdown", () => detach());
  };
}

function toolResult(value: DockToolsResult): { content: Array<{ type: "text"; text: string }>; details: DockToolsResult } {
  return { content: [{ type: "text", text: renderDockToolsResult(value) }], details: value };
}
