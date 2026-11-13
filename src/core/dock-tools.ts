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

/** Who sent a Work message, as its recipient knows them. */
export interface WorkMessageSender {
  relation: "parent" | "child";
  /** The sender's ID as the recipient's own Dock tools name it. */
  id: string;
  name: string;
}

/** How a child Work that still owed its parent a result stopped. */
export type ChildStopReason = "ended" | "aborted" | "failed" | "stopped" | "crashed";
/** The most of a stopped child Work's last reply (or its error) its parent's notice quotes. */
export const MAX_CHILD_LAST_WORDS_CHARS = 16_000;
const LAST_WORDS_SHORTENED = "\n[…shortened]";

/** What a notice quotes of a stopped child Work's text, at most MAX_CHILD_LAST_WORDS_CHARS. */
export function shortenLastWords(text: string): string {
  if (text.length <= MAX_CHILD_LAST_WORDS_CHARS) return text;
  let end = MAX_CHILD_LAST_WORDS_CHARS - LAST_WORDS_SHORTENED.length;
  const high = text.charCodeAt(end - 1);
  if (high >= 0xd800 && high <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${LAST_WORDS_SHORTENED}`;
}

/**
 * What passes between a Work and its parent or child Works. The Host both run on writes it into the
 * recipient's conversation as a message from that Work, never as the user's (card #666).
 */
export type WorkMessage =
  /** `done` marks a child Work's final result for the work it was handed. */
  | { type: "message"; from: WorkMessageSender; text: string; done?: true }
  /** Dock's notice that a child Work stopped while it still owed this Work a result. */
  | { type: "child_stopped"; from: WorkMessageSender; reason: ChildStopReason; error?: string; lastWords?: string };

export type DockToolsRequest =
  | ObservationRequest
  | { type: "machines" }
  | { type: "models" }
  | { type: "spawn"; operationId: string; task: string; name: string; cwd?: string; model?: ModelRef; thinkingLevel?: ThinkingLevel; allowedTools?: string[]; withContext?: boolean }
  | { type: "interrupt" | "stop"; operationId: string; target: string }
  | { type: "deliver"; path: string }
  | { type: "system"; cwd: string; machine?: string; id?: string; cursor?: SystemCatalogCursor; offset?: number; revision?: string }
  /** `assistant` is only accepted from older callers so they receive a clear refusal: Main already keeps one assistant. */
  | { type: "create"; operationId: string; cwd: string; name?: string; machine?: string; systemId?: string; saveDefault?: boolean; model?: ModelRef; assistant?: true }
  /** A child Work omits target: it can only message its parent, and `done` says whether this is its final result. */
  | { type: "send"; operationId: string; target?: string; message: string; delivery?: "followUp" | "steer"; done?: boolean }
  /** A child Work's turn ended without its last call reaching its parent. Dock tells the parent if a result is still owed. */
  | { type: "unreported_stop"; reason: Extract<ChildStopReason, "ended" | "aborted" | "failed">; error?: string; lastWords?: string };

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
  /** `currentHostId` is the source Work's own Machine; only the source Host adds it. */
  | { type: "machines"; machines: MachineDto[]; currentHostId?: string }
  | { type: "deliver"; deliverable: DeliverableDto }
  | { type: "system_catalog"; result: SystemCatalogResult }
  | { type: "system_content"; result: ResourceContentResult }
  | { type: "create"; instance: ObservedInstanceStatus; defaultSaved?: boolean }
  | {
    type: "send";
    target: ObservedInstanceStatus;
    receipt: Pick<CommandReceipt, "delivery" | "queued" | "acceptedAt">;
    /** Set by an older Main: the message was delivered, but its child Work's reply will not come back. */
    error?: string;
  }
  /** A message between a Work and its parent or child Work, taken by the recipient's Worker. */
  | { type: "work_message"; to: "parent" | "child"; target: ObservedInstanceStatus; acceptedAt: string; done?: true }
  | { type: "unreported_stop"; notified: boolean };

export interface DockToolsHostPort {
  dockToolsEnabled(sourceInstanceId: string): boolean;
  configureDockTools(sourceInstanceId: string, enabled: boolean, operationId: string): Promise<{ enabled: boolean }>;
  invokeDockTool(sourceInstanceId: string, request: DockToolsRequest): Promise<DockToolsResult>;
  attachObservationSink(sourceInstanceId: string, sink: ObservationDeliverySink): () => void;
}

/**
 * The Host a Work runs on, which also runs its child Works. It answers what passes between a Work and
 * its own child Works itself, so those messages need neither Main nor a SubHost's link to it.
 */
export interface LocalDockToolsHostPort extends DockToolsHostPort {
  answersLocally(sourceInstanceId: string, request: DockToolsRequest): boolean;
  /** A SubHost learns the ID Main gave a child Work created here through Main, so its parent can name it by that ID. */
  noteSpawnedChild(sourceInstanceId: string, spawnOperationId: string, result: DockToolsResult): void;
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

/** Whether a Work's input is another Work's message that dockMessageText wrapped, not its user speaking. */
export function isDockMessageText(text: string): boolean {
  return /^\[Agent message from "(?:[^"\\\n]|\\.)*"\]\n/u.test(text);
}

/**
 * The Host a Work runs on marks that Work's Machine in Main's list. Main's answer to a SubHost never
 * carries the mark, so a SubHost of an earlier release still accepts it.
 */
export function withCurrentMachine(result: DockToolsResult, hostId: string | undefined): DockToolsResult {
  if (result.type !== "machines" || hostId === undefined || !result.machines.some((machine) => machine.hostId === hostId)) return result;
  return { ...result, currentHostId: hostId };
}

export type { ObservationDeliverySink };

