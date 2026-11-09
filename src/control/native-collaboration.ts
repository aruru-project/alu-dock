import { dockMessageText } from "../core/dock-tools.js";
import type { DockToolsMutationPort, DockToolsRequest, DockToolsResult } from "../core/dock-tools.js";
import type { InstanceSnapshot } from "../core/instance-dto.js";
import { systemToolOperation } from "./system-tools.js";

/** A child Work talks only to its parent: it may message it, and its Worker reports a turn that ended without doing so. */
export function assertChildMayRequest(source: Pick<InstanceSnapshot, "parentId">, request: DockToolsRequest): void {
  if (source.parentId !== undefined && request.type !== "send" && request.type !== "unreported_stop") {
    throw new Error("A child Work can only message the Work that created it. Use dock_send to ask it something or to give it your result.");
  }
}

/** The creation of the child Work a spawn request makes; a SubHost finds the child it created for Main by it. */
export function childCreationOperation(spawnOperationId: string): string {
  return systemToolOperation(spawnOperationId, "create");
}

/**
 * Messages between a Work and its own child Works go through the Host they both run on (card #666).
 * One that reaches Main came from a machine whose Alu Dock is older, or named a child Work its machine did not find.
 */
const CHILD_MESSAGES_ELSEWHERE = "Messages between a Work and its child Works are delivered by the machine they run on, and that machine did not take this one. Name the child Work as dock_list shows it; if that does not help, update Alu Dock on that machine.";

/** A top-level Work's message to another top-level Work, through the target's input, for local and Main-routed sources. */
export async function sendDockMessage(
  source: InstanceSnapshot,
  request: Extract<DockToolsRequest, { type: "send" }>,
  port: Pick<DockToolsMutationPort, "send"> & {
    /** Resolves a named target among the Works this source may see. */
    resolveTarget(target: string): InstanceSnapshot;
  },
): Promise<Extract<DockToolsResult, { type: "send" }>> {
  if (source.parentId !== undefined) throw new Error(CHILD_MESSAGES_ELSEWHERE);
  if (request.target === undefined) throw new Error("Name the Work to message with target.");
  const target = port.resolveTarget(request.target);
  if (target.parentId === source.id || request.done !== undefined) throw new Error(CHILD_MESSAGES_ELSEWHERE);
  const { target: delivered, receipt } = await port.send({
    operationId: request.operationId,
    instanceId: target.id,
    message: dockMessageText(source.displayName, request.message),
    delivery: request.delivery ?? "followUp",
  });
  return { type: "send", target: delivered, receipt: { delivery: receipt.delivery, queued: receipt.queued, acceptedAt: receipt.acceptedAt } };
}

/**
 * One orchestration path for local and Main-routed children. The owning Host performs each effect. The task
 * reaches the child as its first prompt, since its conversation has not started; its result comes back as a message.
 */
export async function spawnDockWorker(
  source: InstanceSnapshot,
  request: Extract<DockToolsRequest, { type: "spawn" }>,
  port: Pick<DockToolsMutationPort, "create" | "send">,
): Promise<Extract<DockToolsResult, { type: "spawn" }>> {
  // User decision 2026-11-04: a child Work keeps its parent's thinking level, on another model too.
  // A model without that level starts at the nearest one it has, as Pi does when a Work changes model.
  const thinkingLevel = request.thinkingLevel ?? source.executor.thinkingLevel;
  const created = await port.create({
    type: "create", operationId: childCreationOperation(request.operationId),
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
  return { type: "spawn", instance: sent.target, taskStatus: "accepted" };
}
