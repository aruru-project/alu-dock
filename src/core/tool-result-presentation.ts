import {
  TOOL_OUTPUT_TRUNCATION_MARKER,
  isProjectedDisplayEditDiff,
  projectDisplayEditDiff,
} from "./edit-diff-projection.js";

export const MAX_TOOL_RESULT_TEXT_CHARS = 8_000;
export const MAX_TOOL_FULL_OUTPUT_PATH_CHARS = 4_096;
export const MAX_TOOL_PRESENTATION_NOTICES = 8;
export const MAX_TOOL_PRESENTATION_COUNT = 1_000_000_000;

export type BuiltInToolKind = "bash" | "read" | "edit" | "write" | "grep" | "find" | "ls";
export type ToolPreviewDirection = "head" | "tail" | "head-tail";
export type ToolResultCompleteness = "complete" | "truncated";

export type ToolResultNotice =
  | {
    code: "output_truncated";
    by: "lines" | "bytes";
    shown?: number;
    total?: number;
    limit: number;
    firstLineExceedsLimit?: true;
  }
  | { code: "limit_reached"; unit: "matches" | "results" | "entries"; limit: number }
  | { code: "lines_truncated"; maxChars: number }
  | { code: "continue_with_offset"; offset: number }
  | { code: "full_output_saved"; path: string }
  | { code: "host_projection_truncated" };

/** Closed presentation metadata; raw Pi/custom tool details never cross the control plane. */
export interface BuiltInToolPresentation {
  kind: BuiltInToolKind;
  preview: ToolPreviewDirection;
  completeness: ToolResultCompleteness;
  notices: ToolResultNotice[];
  displayDiff?: string;
}

interface ProjectedTruncation {
  by: "lines" | "bytes";
  shown?: number;
  total?: number;
  limit: number;
  firstLineExceedsLimit?: true;
}

const BUILT_IN_TOOLS = new Set<BuiltInToolKind>(["bash", "read", "edit", "write", "grep", "find", "ls"]);
const DATA_URI = /data:[^,]*;base64,/iu;
const BASE64_PAYLOAD = /^(?=.{128,}$)(?=.*(?:[0-9+/]|={1,2}$))(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const CONTROL_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;

export function builtInToolKind(toolName: unknown): BuiltInToolKind | undefined {
  return typeof toolName === "string" && BUILT_IN_TOOLS.has(toolName as BuiltInToolKind)
    ? toolName as BuiltInToolKind
    : undefined;
}

export function previewDirectionForTool(kind: BuiltInToolKind): ToolPreviewDirection {
  if (kind === "bash") return "tail";
  if (kind === "edit") return "head-tail";
  return "head";
}

/** Extract only documented, decision-relevant stock Pi fields from untrusted runtime details. */
export function projectBuiltInToolPresentation(
  toolName: unknown,
  contentText: string | undefined,
  details: unknown,
  isError: boolean,
): BuiltInToolPresentation | undefined {
  const kind = builtInToolKind(toolName);
  if (kind === undefined) return undefined;
  try {
    const record = plainRecord(details);
    const notices: ToolResultNotice[] = [];
    const truncation = projectTruncation(record?.truncation);
    if (truncation) notices.push({ code: "output_truncated", ...truncation });

    if (kind === "bash") {
      const path = safePath(record?.fullOutputPath);
      if (path !== undefined) notices.push({ code: "full_output_saved", path });
    } else if (kind === "grep") {
      const limit = positiveInteger(record?.matchLimitReached);
      if (limit !== undefined) notices.push({ code: "limit_reached", unit: "matches", limit });
      if (record?.linesTruncated === true) notices.push({ code: "lines_truncated", maxChars: 500 });
    } else if (kind === "find") {
      const limit = positiveInteger(record?.resultLimitReached);
      if (limit !== undefined) notices.push({ code: "limit_reached", unit: "results", limit });
    } else if (kind === "ls") {
      const limit = positiveInteger(record?.entryLimitReached);
      if (limit !== undefined) notices.push({ code: "limit_reached", unit: "entries", limit });
    }

    if (kind === "read") {
      const offset = continuationOffset(contentText);
      if (offset !== undefined) notices.push({ code: "continue_with_offset", offset });
    }

    const displayDiff = kind === "edit" && !isError ? projectDisplayEditDiff(record?.diff) : undefined;
    if (displayDiff !== undefined && hasHostProjectionMarkerLine(displayDiff)) notices.push({ code: "host_projection_truncated" });
    const canonicalNotices = deduplicateNotices(notices);
    return {
      kind,
      preview: previewDirectionForTool(kind),
      completeness: presentationCompleteness(canonicalNotices),
      notices: canonicalNotices,
      ...(displayDiff === undefined ? {} : { displayDiff }),
    };
  } catch {
    return {
      kind,
      preview: previewDirectionForTool(kind),
      completeness: "complete",
      notices: [],
    };
  }
}

/** Revalidate an internal RuntimeSession projection before it reaches a client. */
export function validateBuiltInToolPresentation(
  toolName: unknown,
  value: unknown,
  isError: boolean,
): BuiltInToolPresentation | undefined {
  const expectedKind = builtInToolKind(toolName);
  const record = plainRecord(value);
  if (expectedKind === undefined || record === undefined) return undefined;
  try {
    if (!hasOnlyKeys(record, ["kind", "preview", "completeness", "notices", "displayDiff"])) return undefined;
    if (record.kind !== expectedKind || record.preview !== previewDirectionForTool(expectedKind)) return undefined;
    if (record.completeness !== "complete" && record.completeness !== "truncated") return undefined;
    if (!Array.isArray(record.notices) || record.notices.length > MAX_TOOL_PRESENTATION_NOTICES) return undefined;
    const notices = record.notices.map(validateNotice);
    if (notices.some((notice) => notice === undefined)) return undefined;
    const canonicalNotices = notices as ToolResultNotice[];
    if (!noticesAllowedForTool(expectedKind, canonicalNotices)) return undefined;
    if (record.completeness !== presentationCompleteness(canonicalNotices)) return undefined;
    if (new Set(canonicalNotices.map(noticeKey)).size !== canonicalNotices.length) return undefined;

    let displayDiff: string | undefined;
    if (record.displayDiff !== undefined) {
      if (expectedKind !== "edit" || isError || typeof record.displayDiff !== "string" || !isProjectedDisplayEditDiff(record.displayDiff)) return undefined;
      displayDiff = record.displayDiff;
    }
    const diffWasHostTruncated = displayDiff !== undefined && hasHostProjectionMarkerLine(displayDiff);
    const declaresHostTruncation = canonicalNotices.some((notice) => notice.code === "host_projection_truncated");
    if (expectedKind === "edit" && displayDiff !== undefined && diffWasHostTruncated !== declaresHostTruncation) return undefined;
    return {
      kind: expectedKind,
      preview: previewDirectionForTool(expectedKind),
      completeness: record.completeness,
      notices: canonicalNotices,
      ...(displayDiff === undefined ? {} : { displayDiff }),
    };
  } catch {
    return undefined;
  }
}

/** Apply the Host hard bound without reversing stock Pi's head/tail semantics. */
export function boundToolResultText(
  text: string,
  isError: boolean,
  presentation: BuiltInToolPresentation | undefined,
): { text: string; presentation?: BuiltInToolPresentation } {
  if (!isError && presentation?.displayDiff !== undefined) {
    return { text: presentation.displayDiff, presentation };
  }
  const effectivePresentation = presentation !== undefined
    && hasHostProjectionMarkerLine(text)
    && !presentation.notices.some((notice) => notice.code === "host_projection_truncated")
    ? withNotice(presentation, { code: "host_projection_truncated" })
    : presentation;
  if (text.length <= MAX_TOOL_RESULT_TEXT_CHARS) {
    return { text, ...(effectivePresentation === undefined ? {} : { presentation: effectivePresentation }) };
  }

  const marker = TOOL_OUTPUT_TRUNCATION_MARKER;
  const direction = isError ? "head-tail" : effectivePresentation?.preview ?? "head";
  const projectedText = direction === "tail"
    ? retainTail(text, marker)
    : direction === "head-tail"
      ? retainHeadTail(text, marker)
      : retainHead(text, marker);
  const projectedPresentation = effectivePresentation === undefined
    ? undefined
    : withNotice(effectivePresentation, { code: "host_projection_truncated" });
  return {
    text: projectedText,
    ...(projectedPresentation === undefined ? {} : { presentation: projectedPresentation }),
  };
}

export function toolPresentationMatchesText(
  presentation: BuiltInToolPresentation,
  text: string,
  isError: boolean,
): boolean {
  if (isError && presentation.displayDiff !== undefined) return false;
  if (presentation.displayDiff !== undefined && text !== presentation.displayDiff) return false;
  const declaresHostTruncation = presentation.notices.some((notice) => notice.code === "host_projection_truncated");
  return declaresHostTruncation === hasHostProjectionMarkerLine(text);
}

export function toolPresentationNoticeText(notice: ToolResultNotice): string {
  if (notice.code === "host_projection_truncated") return TOOL_OUTPUT_TRUNCATION_MARKER;
  if (notice.code === "full_output_saved") return `full output saved · ${notice.path}`;
  if (notice.code === "continue_with_offset") return `continue with read offset=${notice.offset}`;
  if (notice.code === "limit_reached") return `${notice.limit.toLocaleString("en-US")} ${notice.unit} limit reached`;
  if (notice.code === "lines_truncated") return `some match lines exceed ${notice.maxChars.toLocaleString("en-US")} chars · use read for full lines`;
  if (notice.firstLineExceedsLimit) return `first line exceeds ${formatBytes(notice.limit)} limit`;
  const shown = notice.shown === undefined ? "output" : `${notice.shown.toLocaleString("en-US")} lines`;
  const total = notice.total === undefined ? "" : ` of ${notice.total.toLocaleString("en-US")}`;
  const limit = notice.by === "lines"
    ? `${notice.limit.toLocaleString("en-US")} line limit`
    : `${formatBytes(notice.limit)} limit`;
  return `truncated · showing ${shown}${total} · ${limit}`;
}

export function isToolPresentationNoticeLine(line: string): boolean {
  const normalized = line.trim();
  if (normalized === `[${TOOL_OUTPUT_TRUNCATION_MARKER}]` || normalized === TOOL_OUTPUT_TRUNCATION_MARKER) return true;
  return /^\[(?:Showing (?:last |lines )|Truncated:|First line exceeds |Line \d+ is |\d+ more lines in file\.|\d+ (?:matches|results|entries) limit reached|Some lines truncated)/iu.test(normalized);
}

function projectTruncation(value: unknown): ProjectedTruncation | undefined {
  const record = plainRecord(value);
  if (record === undefined || record.truncated !== true) return undefined;
  const by = record.truncatedBy === "lines" || record.truncatedBy === "bytes" ? record.truncatedBy : undefined;
  if (by === undefined) return undefined;
  const limit = positiveInteger(by === "lines" ? record.maxLines : record.maxBytes);
  if (limit === undefined) return undefined;
  const shown = nonNegativeInteger(record.outputLines);
  const total = nonNegativeInteger(record.totalLines);
  if (shown !== undefined && total !== undefined && shown > total) return undefined;
  return {
    by,
    ...(shown === undefined ? {} : { shown }),
    ...(total === undefined ? {} : { total }),
    limit,
    ...(record.firstLineExceedsLimit === true ? { firstLineExceedsLimit: true as const } : {}),
  };
}

function validateNotice(value: unknown): ToolResultNotice | undefined {
  const record = plainRecord(value);
  if (record === undefined || typeof record.code !== "string") return undefined;
  if (record.code === "host_projection_truncated") {
    return hasOnlyKeys(record, ["code"]) ? { code: record.code } : undefined;
  }
  if (record.code === "full_output_saved") {
    const path = safePath(record.path);
    return path !== undefined && hasOnlyKeys(record, ["code", "path"]) ? { code: record.code, path } : undefined;
  }
  if (record.code === "continue_with_offset") {
    const offset = positiveInteger(record.offset);
    return offset !== undefined && hasOnlyKeys(record, ["code", "offset"]) ? { code: record.code, offset } : undefined;
  }
  if (record.code === "limit_reached") {
    const limit = positiveInteger(record.limit);
    const unit = record.unit;
    if (limit === undefined || (unit !== "matches" && unit !== "results" && unit !== "entries")) return undefined;
    return hasOnlyKeys(record, ["code", "unit", "limit"]) ? { code: record.code, unit, limit } : undefined;
  }
  if (record.code === "lines_truncated") {
    const maxChars = positiveInteger(record.maxChars);
    return maxChars !== undefined && hasOnlyKeys(record, ["code", "maxChars"])
      ? { code: record.code, maxChars }
      : undefined;
  }
  if (record.code === "output_truncated") {
    if (record.by !== "lines" && record.by !== "bytes") return undefined;
    const shown = record.shown === undefined ? undefined : nonNegativeInteger(record.shown);
    const total = record.total === undefined ? undefined : nonNegativeInteger(record.total);
    const limit = positiveInteger(record.limit);
    if (limit === undefined || (record.shown !== undefined && shown === undefined) || (record.total !== undefined && total === undefined)) return undefined;
    if (shown !== undefined && total !== undefined && shown > total) return undefined;
    if (record.firstLineExceedsLimit !== undefined && record.firstLineExceedsLimit !== true) return undefined;
    if (!hasOnlyKeys(record, ["code", "by", "shown", "total", "limit", "firstLineExceedsLimit"])) return undefined;
    return {
      code: record.code,
      by: record.by,
      ...(shown === undefined ? {} : { shown }),
      ...(total === undefined ? {} : { total }),
      limit,
      ...(record.firstLineExceedsLimit === true ? { firstLineExceedsLimit: true } : {}),
    };
  }
  return undefined;
}

function noticesAllowedForTool(kind: BuiltInToolKind, notices: readonly ToolResultNotice[]): boolean {
  return notices.every((notice) => {
    if (notice.code === "host_projection_truncated") return true;
    if (kind === "bash") return notice.code === "output_truncated" || notice.code === "full_output_saved";
    if (kind === "read") return notice.code === "output_truncated" || notice.code === "continue_with_offset";
    if (kind === "grep") return notice.code === "output_truncated"
      || (notice.code === "limit_reached" && notice.unit === "matches")
      || notice.code === "lines_truncated";
    if (kind === "find") return notice.code === "output_truncated"
      || (notice.code === "limit_reached" && notice.unit === "results");
    if (kind === "ls") return notice.code === "output_truncated"
      || (notice.code === "limit_reached" && notice.unit === "entries");
    return false;
  });
}

function presentationCompleteness(notices: readonly ToolResultNotice[]): ToolResultCompleteness {
  return notices.length > 0 ? "truncated" : "complete";
}

function withNotice(presentation: BuiltInToolPresentation, notice: ToolResultNotice): BuiltInToolPresentation {
  const notices = deduplicateNotices([...presentation.notices, notice]);
  return { ...presentation, completeness: presentationCompleteness(notices), notices };
}

function deduplicateNotices(notices: readonly ToolResultNotice[]): ToolResultNotice[] {
  const seen = new Set<string>();
  const result: ToolResultNotice[] = [];
  for (const notice of notices) {
    const key = noticeKey(notice);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(notice);
    if (result.length >= MAX_TOOL_PRESENTATION_NOTICES) break;
  }
  return result;
}

function noticeKey(notice: ToolResultNotice): string {
  return JSON.stringify(notice);
}

function continuationOffset(contentText: string | undefined): number | undefined {
  if (contentText === undefined) return undefined;
  const tail = contentText.slice(-2_048);
  const match = /\bUse offset=(\d+) to continue\.\]?\s*$/u.exec(tail);
  return match?.[1] === undefined ? undefined : positiveInteger(Number(match[1]));
}

function retainHead(text: string, marker: string): string {
  const notice = `\n${marker}`;
  const end = unicodeSafeSliceEnd(text, MAX_TOOL_RESULT_TEXT_CHARS - notice.length);
  return `${text.slice(0, end)}${notice}`;
}

function retainTail(text: string, marker: string): string {
  const notice = `\n${marker}`;
  const requestedStart = text.length - (MAX_TOOL_RESULT_TEXT_CHARS - notice.length);
  const start = unicodeSafeSliceStart(text, requestedStart);
  return `${text.slice(start)}${notice}`;
}

function retainHeadTail(text: string, marker: string): string {
  const notice = `\n${marker}\n`;
  const available = MAX_TOOL_RESULT_TEXT_CHARS - notice.length;
  const headRequested = Math.ceil(available / 2);
  const tailRequested = Math.floor(available / 2);
  const headEnd = unicodeSafeSliceEnd(text, headRequested);
  const tailStart = unicodeSafeSliceStart(text, text.length - tailRequested);
  return `${text.slice(0, headEnd)}${notice}${text.slice(tailStart)}`;
}

function unicodeSafeSliceEnd(value: string, requestedEnd: number): number {
  return requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
}

function unicodeSafeSliceStart(value: string, requestedStart: number): number {
  return requestedStart > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedStart - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedStart] ?? "")
    ? requestedStart + 1
    : requestedStart;
}

function hasHostProjectionMarkerLine(value: string): boolean {
  return value.split("\n").some((line) => line.endsWith("\r")
    ? line.slice(0, -1) === TOOL_OUTPUT_TRUNCATION_MARKER
    : line === TOOL_OUTPUT_TRUNCATION_MARKER);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOOL_FULL_OUTPUT_PATH_CHARS) return undefined;
  if (CONTROL_TEXT.test(value) || containsBinaryText(value)) return undefined;
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_TOOL_PRESENTATION_COUNT
    ? value as number
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TOOL_PRESENTATION_COUNT
    ? value as number
    : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function containsBinaryText(value: string): boolean {
  if (DATA_URI.test(value) || BASE64_PAYLOAD.test(value.replace(/\s+/gu, ""))) return true;
  return value.split(/[^A-Za-z0-9+/=]+/gu).some((part) => BASE64_PAYLOAD.test(part));
}

