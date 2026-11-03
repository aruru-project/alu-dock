import { dockMessageText } from "../core/dock-tools.js";
import type { DockToolsMutationPort, DockToolsRequest, DockToolsResult } from "../core/dock-tools.js";
import type { InstanceSnapshot } from "../core/instance-dto.js";
import { systemToolOperation } from "./system-tools.js";

/** A child Work talks only to its parent: the one Dock request it may make is a message. */
export function assertChildMayRequest(source: Pick<InstanceSnapshot, "parentId">, request: DockToolsRequest): void {
  if (source.parentId !== undefined && request.type !== "send") {
    throw new Error("A helper Work can only message the Work that created it. Finish the task and reply, or use dock_send to ask it something.");
  }
}

/**
 * Who a message goes to, and when. A child always reaches its parent at the parent's next
 * step, even mid-turn: it sends only what the parent must know before the child finishes.
 * A top-level Work names its target and by default lets the target's current turn finish.
 */
export function messageTarget(
  source: Pick<InstanceSnapshot, "parentId">,
  request: { target?: string; delivery?: "followUp" | "steer" },
): { parentId: string; delivery: "auto" } | { target: string; delivery: "followUp" | "steer" } {
  if (source.parentId !== undefined) return { parentId: source.parentId, delivery: "auto" };
  if (request.target === undefined) throw new Error("Name the Work to message with target.");
  return { target: request.target, delivery: request.delivery ?? "followUp" };
}

/**
 * After work reaches a helper: arrange for its reply to come back, or say plainly that it
 * will not. The work itself was accepted, so the caller must not send it again.
 */
export async function arrangeReply(notifyWhenDone: () => Promise<void>): Promise<string | undefined> {
  try {
    await notifyWhenDone();
    return undefined;
  } catch (error) {
    return `It was accepted, but Dock cannot deliver the helper's reply to you. Read it later with dock_inspect; do not send it again. ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** One orchestration path for local and Main-routed children. The owning Host performs each effect. */
export async function spawnDockWorker(
  source: InstanceSnapshot,
  request: Extract<DockToolsRequest, { type: "spawn" }>,
  port: Pick<DockToolsMutationPort, "create" | "send"> & {
    /** Delivers the child's reply to the parent once it finishes the work it accepted at `acceptedAt`. */
    notifyWhenDone(childId: string, acceptedAt: string): Promise<void>;
  },
): Promise<Extract<DockToolsResult, { type: "spawn" }>> {
  // Another model may not support the parent's thinking level, so it starts at that model's default.
  const thinkingLevel = request.thinkingLevel ?? (request.model === undefined ? source.executor.thinkingLevel : undefined);
  const created = await port.create({
    type: "create", operationId: systemToolOperation(request.operationId, "create"),
    cwd: request.cwd ?? source.cwd, name: request.name,
    model: request.model ?? source.executor.model,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    child: { parentId: source.id, ...(request.allowedTools === undefined ? {} : { allowedTools: request.allowedTools }) },
  });
  if (created.type !== "create") throw new Error("Worker creation returned an unexpected result. Inspect Dock before retrying.");
  let sent: Awaited<ReturnType<typeof port.send>>;
  try {
    sent = await port.send({ operationId: systemToolOperation(request.operationId, "task"), instanceId: created.instance.id, message: dockMessageText(source.displayName, request.task), delivery: "followUp" });
  } catch (error) {
    // The child exists; an interrupted response cannot prove the task was never accepted.
    return { type: "spawn", instance: created.instance, taskStatus: "failed", error: `Worker created, but task acceptance was not confirmed. Inspect this worker before sending the task again. ${error instanceof Error ? error.message : String(error)}` };
  }
  const replyError = await arrangeReply(() => port.notifyWhenDone(created.instance.id, sent.receipt.acceptedAt));
  return { type: "spawn", instance: sent.target, taskStatus: "accepted", ...(replyError === undefined ? {} : { error: replyError }) };
}
