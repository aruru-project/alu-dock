import { dockMessageText } from "../core/dock-tools.js";
import type { DockToolsMutationPort, DockToolsRequest, DockToolsResult } from "../core/dock-tools.js";
import type { InstanceSnapshot } from "../core/instance-dto.js";
import { systemToolOperation } from "./system-tools.js";

/** A child Work talks only to its parent: the one Dock request it may make is a message. */
export function assertChildMayRequest(source: Pick<InstanceSnapshot, "parentId">, request: DockToolsRequest): void {
  if (source.parentId !== undefined && request.type !== "send") {
    throw new Error("A child Work can only message the Work that created it. Finish the task and reply, or use dock_send to ask it something.");
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
 * After work reaches a child Work: arrange for its reply to come back, or say plainly that it
 * will not. The work itself was accepted, so the caller must not send it again.
 */
export async function arrangeReply(notifyWhenDone: () => Promise<void>): Promise<string | undefined> {
  try {
    await notifyWhenDone();
    return undefined;
  } catch (error) {
    return `It was accepted, but Dock cannot deliver the child Work's reply to you. Read it later with dock_inspect; do not send it again. ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Delivers the child's reply to the parent once it finishes the work it accepted at `acceptedAt`. */
type NotifyWhenDone = (childId: string, acceptedAt: string) => Promise<void>;

/** One message path for local and Main-routed sources. The owning Host resolves targets and delivers. */
export async function sendDockMessage(
  source: InstanceSnapshot,
  request: Extract<DockToolsRequest, { type: "send" }>,
  port: Pick<DockToolsMutationPort, "send"> & {
    /** Resolves a named target among the Works this source may see. */
    resolveTarget(target: string): InstanceSnapshot;
    parent(parentId: string): InstanceSnapshot;
    notifyWhenDone: NotifyWhenDone;
  },
): Promise<Extract<DockToolsResult, { type: "send" }>> {
  const recipient = messageTarget(source, request);
  const target = "parentId" in recipient ? port.parent(recipient.parentId) : port.resolveTarget(recipient.target);
  const { target: delivered, receipt } = await port.send({
    operationId: request.operationId,
    instanceId: target.id,
    message: dockMessageText(source.displayName, request.message),
    delivery: recipient.delivery,
  });
  // A parent hears back from its child each time it hands the child more work.
  const replyError = target.parentId === source.id ? await arrangeReply(() => port.notifyWhenDone(target.id, receipt.acceptedAt)) : undefined;
  return {
    type: "send", target: delivered,
    receipt: { delivery: receipt.delivery, queued: receipt.queued, acceptedAt: receipt.acceptedAt },
    ...(replyError === undefined ? {} : { error: replyError }),
  };
}

/** One orchestration path for local and Main-routed children. The owning Host performs each effect. */
export async function spawnDockWorker(
  source: InstanceSnapshot,
  request: Extract<DockToolsRequest, { type: "spawn" }>,
  port: Pick<DockToolsMutationPort, "create" | "send"> & { notifyWhenDone: NotifyWhenDone },
): Promise<Extract<DockToolsResult, { type: "spawn" }>> {
  // User decision 2026-11-04: a child Work keeps its parent's thinking level, on another model too.
  // A model without that level starts at the nearest one it has, as Pi does when a Work changes model.
  const thinkingLevel = request.thinkingLevel ?? source.executor.thinkingLevel;
  const created = await port.create({
    type: "create", operationId: systemToolOperation(request.operationId, "create"),
    cwd: request.cwd ?? source.cwd, name: request.name,
    model: request.model ?? source.executor.model,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    child: {
      parentId: source.id,
      ...(request.allowedTools === undefined ? {} : { allowedTools: request.allowedTools }),
      ...(request.withContext ? { withParentContext: true } : {}),
    },
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
