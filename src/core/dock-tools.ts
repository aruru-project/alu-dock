import type { ModelRef, SystemCatalogResult, SystemCatalogCursor, ResourceContentResult } from "../control/protocol.js";
import type { ThinkingLevel } from "./agent-worker.js";
import type { ModelsResult } from "../control/protocol.js";
import type { CommandReceipt } from "./instance-dto.js";
import type { DeliverableDto } from "./instance-deliverables.js";
import type { MachineDto } from "./machine-dto.js";
import type {
  ObservationDeliverySink,
  ObservationRequest,
  ObservationResult,
  ObservedInstanceStatus,
} from "./instance-observation.js";

export const MAX_DOCK_TOOL_TARGET_CHARS = 256;
export const MAX_DOCK_TOOL_CWD_CHARS = 16_384;
export const MAX_DOCK_TOOL_NAME_CHARS = 256;
export const MAX_DOCK_TOOL_MESSAGE_CHARS = 254_000;

export type DockToolsRequest =
  | ObservationRequest
  | { type: "machines" }
  | { type: "models" }
  | { type: "spawn"; operationId: string; task: string; name: string; cwd?: string; model?: ModelRef; thinkingLevel?: ThinkingLevel; allowedTools?: string[] }
  | { type: "interrupt" | "stop"; operationId: string; target: string }
  | { type: "deliver"; path: string }
  | { type: "system"; cwd: string; machine?: string; id?: string; cursor?: SystemCatalogCursor; offset?: number; revision?: string }
  | { type: "create"; operationId: string; cwd: string; name?: string; machine?: string; systemId?: string; saveDefault?: boolean; model?: ModelRef; thinkingLevel?: ThinkingLevel; allowedTools?: string[]; parentId?: string; parentName?: string }
  | { type: "send"; operationId: string; target: string; message: string; delivery?: "followUp" | "steer" };

export type DockToolsResult =
  | ObservationResult
  | { type: "models"; result: ModelsResult }
  | { type: "spawn"; instance: ObservedInstanceStatus; taskStatus: "accepted" | "failed"; watchStatus?: "watching" | "completed" | "failed"; error?: string }
  | { type: "interrupt"; instance: ObservedInstanceStatus }
  | { type: "stop"; instance: ObservedInstanceStatus }
  | { type: "machines"; machines: MachineDto[] }
  | { type: "deliver"; deliverable: DeliverableDto }
  | { type: "system_catalog"; result: SystemCatalogResult }
  | { type: "system_content"; result: ResourceContentResult }
  | { type: "create"; instance: ObservedInstanceStatus; defaultSaved?: boolean }
  | {
    type: "send";
    target: ObservedInstanceStatus;
    receipt: Pick<CommandReceipt, "delivery" | "queued" | "acceptedAt">;
  };

export interface DockToolsHostPort {
  /** Source Host-owned delegation ceiling, applied before any local or remote routing. */
  authorizeDockToolRequest(sourceInstanceId: string, request: DockToolsRequest): DockToolsRequest;
  dockToolsEnabled(sourceInstanceId: string): boolean;
  configureDockTools(sourceInstanceId: string, enabled: boolean, operationId: string): Promise<{ enabled: boolean }>;
  invokeDockTool(sourceInstanceId: string, request: DockToolsRequest): Promise<DockToolsResult>;
  attachObservationSink(sourceInstanceId: string, sink: ObservationDeliverySink): () => void;
}

export interface DockToolsMutationPort {
  models(instanceId: string): Promise<ModelsResult>;
  interrupt(instanceId: string, operationId: string): Promise<ObservedInstanceStatus>;
  stop(instanceId: string, operationId: string): Promise<ObservedInstanceStatus>;
  create(input: Extract<DockToolsRequest, { type: "create" }>): Promise<DockToolsResult>;
  system(input: Extract<DockToolsRequest, { type: "system" }>): Promise<DockToolsResult>;
  send(input: { operationId: string; instanceId: string; message: string; delivery?: "followUp" | "steer" }): Promise<{
    target: ObservedInstanceStatus;
    receipt: Pick<CommandReceipt, "delivery" | "queued" | "acceptedAt">;
  }>;
}

export function dockMessageText(sourceDisplayName: string, message: string): string {
  const safeName = sourceDisplayName.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim() || "another Dock instance";
  return `[Agent message from ${JSON.stringify(safeName)}]\n${message}`;
}

export type { ObservationDeliverySink };
