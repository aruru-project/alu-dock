import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * The Pi CLI's built-in MCP stack, which SDK sessions do not load on their own. The names are Pi's
 * `builtin:<name>` identities, so `-builtin:mcp` settings and replacement by a third-party MCP
 * extension behave as in the Pi CLI.
 *
 * The Worker runs on the Host machine, often without a display or anyone in front of it, so MCP
 * sign-in never opens a browser there. Pi still shows the authorization URL to the client.
 */
export function piBuiltinExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    { name: "mcp", factory: createMcpExtension({ openUrl: () => {} }), replaceable: true, builtin: true },
  ];
}
