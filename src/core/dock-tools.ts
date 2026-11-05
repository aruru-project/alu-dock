import { MAX_CHILD_MODELS, MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS, type ModelRef, type SystemCatalogResult, type SystemCatalogCursor, type ResourceContentResult } from "../control/protocol.js";
import type { ThinkingLevel } from "./agent-worker.js";
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
/**
 * The user's list of models shown to Agents for child Works: a short hand-picked list, not a catalog.
 * It only names models; a note on when to use one would be followed as a rule (user decision 2026-11-04).
 */
export const MAX_CHILD_MODEL_PROBLEM_CHARS = 1_024;

/** The user's list as this machine's Host read it; `problem` explains a file it could not use. */
export interface ChildModelList {
  models: ModelRef[];
  problem?: string;
}

/** Shared by the Host's file reader and the Worker boundary; throws a message naming the bad entry. */
export function parseChildModelEntries(input: unknown): ModelRef[] {
  if (!Array.isArray(input)) throw new Error('"models" must be a list');
  if (input.length > MAX_CHILD_MODELS) throw new Error(`"models" can list at most ${MAX_CHILD_MODELS} models`);
  return input.map((item, index) => {
    const entry = item as Record<string, unknown> | null;
    const valid = entry !== null && typeof entry === "object" && !Array.isArray(entry)
      && Object.keys(entry).every((key) => key === "provider" || key === "id")
      && typeof entry.provider === "string" && entry.provider.length > 0 && entry.provider.length <= MAX_MODEL_PROVIDER_CHARS
      && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= MAX_MODEL_ID_CHARS;
    if (!valid) throw new Error(`entry ${index + 1} must be {"provider": "…", "id": "…"}`);
    return { provider: entry.provider as string, id: entry.id as string };
  });
}

export type DockToolsRequest =
  | ObservationRequest
  | { type: "machines" }
  | { type: "models" }
  | { type: "spawn"; operationId: string; task: string; name: string; cwd?: string; model?: ModelRef; thinkingLevel?: ThinkingLevel; allowedTools?: string[]; withContext?: boolean }
  | { type: "interrupt" | "stop"; operationId: string; target: string }
  | { type: "deliver"; path: string }
  | { type: "system"; cwd: string; machine?: string; id?: string; cursor?: SystemCatalogCursor; offset?: number; revision?: string }
  | { type: "create"; operationId: string; cwd: string; name?: string; machine?: string; systemId?: string; saveDefault?: boolean; model?: ModelRef }
  /** A child Work omits target: it can only message its parent. */
  | { type: "send"; operationId: string; target?: string; message: string; delivery?: "followUp" | "steer" };

/** What the Host creates for dock_create, plus what dock_spawn chooses for a child. */
export type DockCreateInput = Extract<DockToolsRequest, { type: "create" }> & {
  thinkingLevel?: ThinkingLevel;
  child?: DockChildSelection;
};

/** A child belongs to a top-level Work on the same Host; its tools never exceed what the parent named. */
export interface DockChildSelection {
  parentId: string;
  allowedTools?: string[];
  /** Start from a copy of the parent's conversation so far instead of an empty one. */
  withParentContext?: boolean;
}

/** What starts a child's Worker; the Registry has already turned `withParentContext` into its session file. */
export type DockChildStart = Omit<DockChildSelection, "withParentContext">;

export type DockToolsResult =
  | ObservationResult
  | ({ type: "models" } & ChildModelList)
  | { type: "spawn"; instance: ObservedInstanceStatus; taskStatus: "accepted" | "failed"; error?: string }
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
    /** The message was delivered, but its child Work's reply will not come back. */
    error?: string;
  };

export interface DockToolsHostPort {
  dockToolsEnabled(sourceInstanceId: string): boolean;
  configureDockTools(sourceInstanceId: string, enabled: boolean, operationId: string): Promise<{ enabled: boolean }>;
  invokeDockTool(sourceInstanceId: string, request: DockToolsRequest): Promise<DockToolsResult>;
  attachObservationSink(sourceInstanceId: string, sink: ObservationDeliverySink): () => void;
}

export interface DockToolsMutationPort {
  /** This machine's list of models for child Works. */
  childModels(): Promise<ChildModelList>;
  interrupt(instanceId: string, operationId: string): Promise<ObservedInstanceStatus>;
  stop(instanceId: string, operationId: string): Promise<ObservedInstanceStatus>;
  create(input: DockCreateInput): Promise<DockToolsResult>;
  system(input: Extract<DockToolsRequest, { type: "system" }>): Promise<DockToolsResult>;
  /** `auto` joins a busy target's current turn at its next step and starts an idle one. */
  send(input: { operationId: string; instanceId: string; message: string; delivery?: "followUp" | "steer" | "auto" }): Promise<{
    target: ObservedInstanceStatus;
    receipt: Pick<CommandReceipt, "delivery" | "queued" | "acceptedAt">;
  }>;
}

export function dockMessageText(sourceDisplayName: string, message: string): string {
  const safeName = sourceDisplayName.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim() || "another Dock instance";
  return `[Agent message from ${JSON.stringify(safeName)}]\n${message}`;
}

export type { ObservationDeliverySink };
