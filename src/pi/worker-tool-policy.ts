import type { WorkerToolPolicy } from "../core/worker-tool-policy.js";
export { parseWorkerToolPolicy, type WorkerToolPolicy } from "../core/worker-tool-policy.js";

const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/**
 * Pi's public tools option filters the registry itself, including extension refresh and
 * nested executeTool calls. Its CLI convenience keeps MCP tools when an allowlist does
 * not name an MCP server tool, so explicitly close that exception for a capability grant.
 */
export function workerToolSelection(policy: WorkerToolPolicy | undefined, excluded: string[] | undefined): {
  tools?: string[];
  excludeTools?: string[];
} {
  if (!policy) return excluded === undefined ? {} : { excludeTools: excluded };
  const denies = [...(excluded ?? [])];
  if (!policy.allowedTools.some((name) => name.startsWith("mcp__"))) {
    denies.push("mcp__*", ...MCP_RESOURCE_TOOLS.filter((name) => !policy.allowedTools.includes(name)));
  }
  return { tools: [...policy.allowedTools], excludeTools: [...new Set(denies)] };
}
