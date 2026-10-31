import type { DockToolsRequest } from "../core/dock-tools.js";
import { parseWorkerToolPolicy } from "../core/worker-tool-policy.js";

/** Applied by the source Host, never from caller-supplied parent identity. */
export function constrainDelegatedTools(request: DockToolsRequest, sourcePolicy: unknown): DockToolsRequest {
  if (request.type !== "create" && request.type !== "spawn") return request;
  const ceiling = parseWorkerToolPolicy(sourcePolicy);
  const selected = request.allowedTools === undefined ? undefined : parseWorkerToolPolicy({ allowedTools: request.allowedTools });
  if (!ceiling) return request;
  if (selected?.allowedTools.some((name) => !ceiling.allowedTools.includes(name))) {
    throw new Error("A delegated worker cannot receive tools outside its parent's permission ceiling.");
  }
  return { ...request, allowedTools: [...(selected?.allowedTools ?? ceiling.allowedTools)] };
}
