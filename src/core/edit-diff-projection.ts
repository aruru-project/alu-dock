const DISPLAY_EDIT_CHANGE = /^[+-]\s*\d+\s/u;
const DISPLAY_EDIT_ROW = /^[ +-](?:\s*\d+\s|\s+\.\.\.$)/u;
const DATA_URI = /data:[^,]*;base64,/iu;
const BASE64_PAYLOAD = /^(?=.{128,}$)(?=.*(?:[0-9+/]|={1,2}$))(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const TOOL_OUTPUT_TRUNCATION_MARKER = "[tool output truncated by Host projection]";
export const MAX_EDIT_DIFF_TEXT_CHARS = 8_000;

/** Validate Pi's display-oriented, line-numbered edit diff without importing Pi types. */
export function isDisplayEditDiff(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const lines = value.split("\n");
  return lines.some((line) => DISPLAY_EDIT_CHANGE.test(line))
    && lines.every((line) => DISPLAY_EDIT_ROW.test(line));
}

/** Produce the closed, hard-bounded edit diff used identically by live events and history. */
export function projectDisplayEditDiff(value: unknown): string | undefined {
  if (typeof value !== "string" || containsBinaryText(value) || !isDisplayEditDiff(value)) return undefined;
  if (value.length <= MAX_EDIT_DIFF_TEXT_CHARS) return value;
  const notice = `\n${TOOL_OUTPUT_TRUNCATION_MARKER}`;
  const requestedEnd = MAX_EDIT_DIFF_TEXT_CHARS - notice.length;
  const end = requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
  return `${value.slice(0, end)}${notice}`;
}

/** Accept only raw display diffs or the exact bounded form produced above. */
export function isProjectedDisplayEditDiff(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EDIT_DIFF_TEXT_CHARS || containsBinaryText(value)) return false;
  if (isDisplayEditDiff(value)) return true;
  const notice = `\n${TOOL_OUTPUT_TRUNCATION_MARKER}`;
  if ((value.length !== MAX_EDIT_DIFF_TEXT_CHARS && value.length !== MAX_EDIT_DIFF_TEXT_CHARS - 1) || !value.endsWith(notice)) return false;
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

function containsBinaryText(value: string): boolean {
  if (DATA_URI.test(value) || BASE64_PAYLOAD.test(value.replace(/\s+/gu, ""))) return true;
  return value.split(/[^A-Za-z0-9+/=]+/gu).some((part) => BASE64_PAYLOAD.test(part));
}
