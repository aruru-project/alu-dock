export const MAX_ALLOWED_TOOLS = 256;
export const MAX_ALLOWED_TOOL_NAME_CHARS = 256;
/** Caps this field's contribution to the private Worker process bootstrap, like Worker configuration. */
export const MAX_ALLOWED_TOOLS_BYTES = 16_000;

/**
 * Exact tool names a parent lets its child Work use: a capability ceiling inside Pi's
 * tool registry, not a filesystem or process sandbox.
 */
export function parseAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_TOOLS || value.some((name) => typeof name !== "string"
    || name.length === 0 || name.length > MAX_ALLOWED_TOOL_NAME_CHARS || name.trim() !== name
    || /[\s\u0000-\u001f\u007f*]/u.test(name) || /^[+-]/u.test(name))) {
    throw new Error("Allowed tools need exact tool names, not patterns or selection modifiers.");
  }
  if (new Set(value).size !== value.length) throw new Error("Allowed tools contain duplicate names.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ALLOWED_TOOLS_BYTES) throw new Error("Allowed tools are too long.");
  return [...value] as string[];
}
