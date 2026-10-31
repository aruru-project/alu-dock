import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

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

/** Native Dock workers replace the legacy extension rather than running two child owners. */
export function withoutLegacySubagents(base: LoadExtensionsResult): LoadExtensionsResult {
  const removed = base.extensions.filter((extension) => extension.tools.has("subagent"));
  if (removed.length === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !extension.tools.has("subagent")),
    warnings: [...(base.warnings ?? []), ...removed.map((extension) => ({
      path: extension.path,
      warning: "Dock manages child workers directly. This legacy subagent extension is disabled in Dock; standalone Pi is unchanged.",
    }))],
  };
}
