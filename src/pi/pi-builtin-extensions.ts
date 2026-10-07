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
 *
 * While `isPlanning` returns true, codemode uses its "on" mode, so it does not hide the other
 * tools from a planning model; otherwise it follows the person's `codemode.mode` setting.
 */
export function piBuiltinExtensions(isPlanning?: () => boolean): InlineExtension[] {
  const codemodeOptions = { get mode() { return isPlanning?.() ? "on" as const : undefined; } };
  return [
    { name: "codemode", factory: createCodemodeExtension(codemodeOptions), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    { name: "mcp", factory: createMcpExtension({ openUrl: () => {} }), replaceable: true, builtin: true },
  ];
}
