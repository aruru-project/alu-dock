import { dockMessageText } from "../core/dock-tools.js";
import type { DockToolsRequest, DockToolsResult, DockToolsMutationPort } from "../core/dock-tools.js";
import type { InstanceSnapshot } from "../core/instance-dto.js";
import type { ObservationResult } from "../core/instance-observation.js";
import { systemToolOperation } from "./system-tools.js";

/** One orchestration path for local and Main-routed children. The normal Host owns each effect. */
export async function spawnDockWorker(
  source: InstanceSnapshot,
  request: Extract<DockToolsRequest, { type: "spawn" }>,
  port: Pick<DockToolsMutationPort, "create" | "send"> & {
    watch(target: string): Promise<ObservationResult>;
  },
): Promise<Extract<DockToolsResult, { type: "spawn" }>> {
  const created = await port.create({
    type: "create", operationId: systemToolOperation(request.operationId, "create"),
    cwd: request.cwd ?? source.cwd, name: request.name,
    parentId: source.id, parentName: source.displayName,
    model: request.model ?? source.executor.model,
    thinkingLevel: request.thinkingLevel ?? source.executor.thinkingLevel,
    ...(request.allowedTools === undefined ? {} : { allowedTools: request.allowedTools }),
  });
  if (created.type !== "create") throw new Error("Worker creation returned an unexpected result. Inspect Dock before retrying.");
  if (request.thinkingLevel !== undefined && created.instance.thinkingLevel !== request.thinkingLevel) {
    return { type: "spawn", instance: created.instance, taskStatus: "failed", error: `Worker created with effective thinking ${created.instance.thinkingLevel ?? "off"}, not requested ${request.thinkingLevel}. Its model does not support that effort. No task was sent; select supported settings or send a task to this worker explicitly.` };
  }
  let target;
  try {
    target = (await port.send({ operationId: systemToolOperation(request.operationId, "task"), instanceId: created.instance.id, message: dockMessageText(source.displayName, request.task), delivery: "followUp" })).target;
  } catch (error) {
    // The child exists; an interrupted response cannot prove the task was never accepted.
    return { type: "spawn", instance: created.instance, taskStatus: "failed", error: `Worker created, but task acceptance was not confirmed. Inspect this worker before sending the task again. ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const watch = await port.watch(created.instance.id);
    return { type: "spawn", instance: target, taskStatus: "accepted", watchStatus: watch.type === "watch" ? watch.status : undefined };
  } catch (error) {
    return { type: "spawn", instance: target, taskStatus: "accepted", watchStatus: "failed", error: `Task accepted, but completion notification registration failed. Inspect this worker or register dock_watch; do not resend the task. ${error instanceof Error ? error.message : String(error)}` };
  }
}
