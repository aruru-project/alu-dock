const DISPLAY_EDIT_CHANGE = /^[+-]\s*\d+\s/u;
const DISPLAY_EDIT_ROW = /^[ +-](?:\s*\d+\s|\s+\.\.\.$)/u;
export const TOOL_OUTPUT_TRUNCATION_MARKER = "[tool output truncated by Host projection]";
// Keep Pi's display diff intact in normal operation. This only leaves room below
// the 1 MiB control-frame ceiling for envelopes and adjacent history metadata.
export const MAX_TRANSPORT_EDIT_DIFF_CHARS = 256_000;

/** Validate Pi's display-oriented, line-numbered edit diff without importing Pi types. */
export function isDisplayEditDiff(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const lines = value.split("\n");
  return lines.some((line) => DISPLAY_EDIT_CHANGE.test(line))
    && lines.every((line) => DISPLAY_EDIT_ROW.test(line));
}

/** Preserve Pi's display diff; only the control-frame fallback may shorten it. */
export function projectDisplayEditDiff(value: unknown): string | undefined {
  if (typeof value !== "string" || !isDisplayEditDiff(value)) return undefined;
  if (value.length <= MAX_TRANSPORT_EDIT_DIFF_CHARS) return value;
  const notice = `\n${TOOL_OUTPUT_TRUNCATION_MARKER}`;
  const requestedEnd = MAX_TRANSPORT_EDIT_DIFF_CHARS - notice.length;
  const end = requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
  return `${value.slice(0, end)}${notice}`;
}

/** Accept only raw display diffs or the exact bounded form produced above. */
export function isProjectedDisplayEditDiff(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TRANSPORT_EDIT_DIFF_CHARS) return false;
  if (isDisplayEditDiff(value)) return true;
  const notice = `\n${TOOL_OUTPUT_TRUNCATION_MARKER}`;
  if ((value.length !== MAX_TRANSPORT_EDIT_DIFF_CHARS && value.length !== MAX_TRANSPORT_EDIT_DIFF_CHARS - 1) || !value.endsWith(notice)) return false;
  const body = value.slice(0, -notice.length);
  if (body.length === 0) return false;
  const lines = body.split("\n");
  const partial = lines.at(-1) ?? "";
  return isDisplayEditRowPrefix(partial)
    && lines.slice(0, -1).every((line) => DISPLAY_EDIT_ROW.test(line));
}

function isDisplayEditRowPrefix(value: string): boolean {
  if (value.length === 0) return true;
  return /^[ +-](?: *| *\d+| *\d+ .*)$/u.test(value)
    || /^  *\.{0,3}$/u.test(value);
}
