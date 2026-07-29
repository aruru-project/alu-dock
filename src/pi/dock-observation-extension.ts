import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE,
  OBSERVATION_DATA_NOTICE,
  type ObservationNotification,
  type ObservationRequest,
  type ObservationResult,
} from "../core/instance-observation.js";

export const DOCK_OBSERVATION_TOOL_NAMES = ["dock_inspect", "dock_watch", "dock_cancel_watch"] as const;
const DOCK_OBSERVATION_EXTENSION_PATH = "<inline:alu-dock-observation>";
const TOOL_NAMES = new Set<string>(DOCK_OBSERVATION_TOOL_NAMES);
const OPTIONAL_TARGET_SCHEMA = {
  type: "object",
  properties: { target: { type: "string", minLength: 1, maxLength: 256 } },
  additionalProperties: false,
};
const REQUIRED_TARGET_SCHEMA = {
  type: "object",
  properties: { target: { type: "string", minLength: 1, maxLength: 256 } },
  required: ["target"],
  additionalProperties: false,
};
const OPTIONAL_WATCH_SCHEMA = {
  type: "object",
  properties: { watchId: { type: "string", minLength: 1, maxLength: 128 } },
  additionalProperties: false,
};

export interface DockObservationCallPort {
  configure(action: "on" | "off" | "status"): Promise<{ enabled: boolean }>;
  observe(request: ObservationRequest): Promise<ObservationResult>;
}

/** Worker-level bridge survives Pi binding reloads while API closures do not. */
export class DockObservationBridge {
  private api: ExtensionAPI | undefined;
  private enabledValue: boolean;
  private readonly pendingNotifications = new Map<string, ObservationNotification>();
  private readonly deliveredWatchIds = new Set<string>();

  constructor(initiallyEnabled: boolean, private readonly port: DockObservationCallPort) {
    this.enabledValue = initiallyEnabled;
  }

  get enabled(): boolean { return this.enabledValue; }

  attach(api: ExtensionAPI): () => void {
    this.api = api;
    this.applyToolVisibility(api);
    for (const [watchId, notification] of this.pendingNotifications) {
      try {
        this.sendNotification(api, notification);
        this.pendingNotifications.delete(watchId);
      } catch { /* Keep the one-shot completion for the next binding rather than fail reload. */ }
    }
    return () => { if (this.api === api) this.api = undefined; };
  }

  async configure(action: "on" | "off" | "status"): Promise<boolean> {
    const result = await this.port.configure(action);
    this.enabledValue = result.enabled;
    if (!result.enabled) this.pendingNotifications.clear();
    if (this.api) this.applyToolVisibility(this.api);
    return result.enabled;
  }

  observe(request: ObservationRequest): Promise<ObservationResult> {
    if (!this.enabledValue) return Promise.reject(new Error("Dock observation is off. Use /dock-observe on first."));
    return this.port.observe(request);
  }

  deliver(notification: ObservationNotification): void {
    if (!this.enabledValue || this.deliveredWatchIds.has(notification.watchId)) return;
    if (!this.api) {
      if (!this.pendingNotifications.has(notification.watchId)
        && this.pendingNotifications.size >= MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
        throw new Error("Dock observation completion queue is full");
      }
      this.pendingNotifications.set(notification.watchId, notification);
      return;
    }
    this.sendNotification(this.api, notification);
  }

  private sendNotification(api: ExtensionAPI, notification: ObservationNotification): void {
    api.sendMessage({
      customType: "dock-observation",
      content: `${OBSERVATION_DATA_NOTICE}\n${JSON.stringify(notification)}`,
      display: true,
      details: notification,
    }, { triggerTurn: true, deliverAs: "followUp" });
    this.deliveredWatchIds.add(notification.watchId);
    while (this.deliveredWatchIds.size > MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
      this.deliveredWatchIds.delete(this.deliveredWatchIds.values().next().value!);
    }
  }

  private applyToolVisibility(api: ExtensionAPI): void {
    const unrelated = api.getActiveTools().filter((name) => !TOOL_NAMES.has(name));
    api.setActiveTools(this.enabledValue ? [...unrelated, ...DOCK_OBSERVATION_TOOL_NAMES] : unrelated);
  }
}

export function dockObservationExtension(bridge: DockObservationBridge): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "dock_inspect",
      label: "Inspect Dock siblings",
      description: `List sibling instances or inspect one sibling's bounded current activity. ${OBSERVATION_DATA_NOTICE}`,
      parameters: OPTIONAL_TARGET_SCHEMA,
      execute: async (_toolCallId: string, params: { target?: string }) => toolResult(await bridge.observe(
        params.target === undefined ? { type: "list" } : { type: "inspect", target: params.target },
      )),
    } as never);
    pi.registerTool({
      name: "dock_watch",
      label: "Watch a Dock sibling",
      description: `Register a one-shot watch for a sibling's next terminal execution state. ${OBSERVATION_DATA_NOTICE}`,
      parameters: REQUIRED_TARGET_SCHEMA,
      execute: async (_toolCallId: string, params: { target: string }) => toolResult(await bridge.observe({ type: "watch", target: params.target })),
    } as never);
    pi.registerTool({
      name: "dock_cancel_watch",
      label: "Cancel Dock watches",
      description: "Cancel one source-owned watch, or all watches when watchId is omitted.",
      parameters: OPTIONAL_WATCH_SCHEMA,
      execute: async (_toolCallId: string, params: { watchId?: string }) => toolResult(await bridge.observe({ type: "cancel", ...(params.watchId === undefined ? {} : { watchId: params.watchId }) })),
    } as never);

    pi.registerCommand("dock-observe", {
      description: "Turn read-only sibling observation on or off, or show its status",
      handler: async (args, ctx) => {
        const action = args.trim() || "status";
        if (action !== "on" && action !== "off" && action !== "status") {
          ctx.ui.notify("Use /dock-observe on, /dock-observe off, or /dock-observe status.", "warning");
          return;
        }
        const enabled = await bridge.configure(action);
        ctx.ui.notify(`Dock sibling observation is ${enabled ? "on" : "off"}.`, "info");
      },
    });

    let detach = (): void => {};
    pi.on("session_start", (_event, ctx) => {
      detach();
      const collision = pi.getAllTools().find((tool) => TOOL_NAMES.has(tool.name)
        && tool.sourceInfo.path !== DOCK_OBSERVATION_EXTENSION_PATH);
      if (collision) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.has(name)));
        ctx.ui.notify(`Dock observation tools are unavailable because ${collision.name} is already registered.`, "error");
        return;
      }
      detach = bridge.attach(pi);
    });
    pi.on("session_shutdown", () => detach());
  };
}

function toolResult(value: ObservationResult): { content: Array<{ type: "text"; text: string }>; details: ObservationResult } {
  return {
    content: [{ type: "text", text: `${OBSERVATION_DATA_NOTICE}\n${JSON.stringify(value)}` }],
    details: value,
  };
}
