/*
 * The personal assistant (card #295): her persona, the owner's hand-written notes, and the
 * conversations of the Works opened as her. Main keeps all of it in its assistant service; Works on
 * any machine reach it through their Host, and clients through Protocol V2 on Main.
 *
 * This file is the one definition of what crosses those boundaries. The Worker adapter, the Host,
 * the machine connection and the service all parse with it.
 */

/** The two texts the owner and the assistant edit: who she is, and what the owner told her by hand. */
export const ASSISTANT_DOCUMENTS = ["persona", "notes"] as const;
export type AssistantDocumentName = typeof ASSISTANT_DOCUMENTS[number];

/** One document in UTF-8; persona and notes together stay well inside one control record. */
export const MAX_ASSISTANT_DOCUMENT_BYTES = 256 * 1024;
export const MAX_ASSISTANT_QUERY_CHARS = 256;
export const MAX_ASSISTANT_SEARCH_LIMIT = 50;
/** Entries read on each side of one conversation entry. */
export const MAX_ASSISTANT_CONTEXT_SPAN = 50;
/** One recorded entry's text; a longer tool output is cut here and stays whole in the Agent's own session file. */
export const MAX_ASSISTANT_ENTRY_TEXT_CHARS = 32_000;
export const MAX_ASSISTANT_TOOL_CALLS = 64;
export const MAX_ASSISTANT_TOOL_ARGUMENT_CHARS = 2_000;
export const MAX_ASSISTANT_SNIPPET_CHARS = 400;
/** One batch of recorded entries, sent as a single private call and machine record. */
export const MAX_ASSISTANT_RECORD_BATCH_BYTES = 384 * 1024;
/** Search and context answers leave room for their envelope under one control record. */
export const MAX_ASSISTANT_RESULT_BYTES = 768 * 1024;
const MAX_ID_CHARS = 128;
const MAX_PATH_CHARS = 16_384;
const MAX_NAME_CHARS = 1_024;
const MAX_CURSOR_CHARS = 256;
const MAX_REVISION_CHARS = 128;

/** The assistant's own tools; their calls and results are kept for context but not searched again. */
export const ASSISTANT_TOOL_NAMES = ["assistant_search", "assistant_read", "assistant_document"] as const;

export interface AssistantDocument { document: AssistantDocumentName; text: string; revision: string }
/** What a new assistant session loads, and when it was put together. */
export interface AssistantPreview { text: string; loadedAt: string }
export interface AssistantInfo { workspacePath: string; maxDocumentBytes: number }

export type AssistantEntryKind = "user" | "assistant" | "tool_result" | "bash" | "summary" | "notice";
export interface AssistantToolCall { name: string; arguments: string }
/** One entry of a conversation, as the assistant service keeps it. */
export interface AssistantEntry {
  entryId: string;
  /** The nearest earlier entry of the same branch that is kept too. */
  parentId?: string;
  at: string;
  kind: AssistantEntryKind;
  text: string;
  toolName?: string;
  toolCalls?: AssistantToolCall[];
  /** The text was cut at MAX_ASSISTANT_ENTRY_TEXT_CHARS. */
  truncated?: true;
}

/** Where a conversation took place: the Agent's session and the Work and machine it ran in. */
export interface AssistantSessionInfo {
  sessionId: string;
  sessionFile?: string;
  cwd?: string;
  name?: string;
  workId?: string;
  machine?: string;
  startedAt: string;
  lastAt: string;
}

export interface AssistantSearchHit { session: AssistantSessionInfo; entryId: string; at: string; kind: AssistantEntryKind; snippet: string }
export interface AssistantSearchResult { hits: AssistantSearchHit[]; nextCursor?: string }
export interface AssistantContextResult { session: AssistantSessionInfo; entries: AssistantEntry[]; hasBefore: boolean; hasAfter: boolean }

/** The session an assistant Work records into; the Host adds the Work and machine. */
export interface AssistantRecordSession { sessionId: string; sessionFile?: string; cwd: string; name?: string }
/** Added by the Host that relays a Worker's question, never by the Worker. */
export interface AssistantSource { workId?: string; machine?: string }

export interface AssistantSearchRequest { query: string; from?: string; to?: string; cursor?: string; limit: number }
export interface AssistantContextRequest { sessionId: string; entryId: string; before: number; after: number }

export type AssistantRequest =
  | { op: "info" }
  | { op: "load" }
  | { op: "recorded"; sessionId: string }
  /** `throughEntryId` is the last entry of the Agent's session this batch covers, kept or not. */
  | { op: "record"; session: AssistantRecordSession; entries: AssistantEntry[]; throughEntryId: string }
  | ({ op: "search" } & AssistantSearchRequest)
  | ({ op: "context" } & AssistantContextRequest)
  | { op: "document_get"; document: AssistantDocumentName }
  /** Without `baseRevision` the text replaces whatever is there. */
  | { op: "document_set"; document: AssistantDocumentName; text: string; baseRevision?: string }
  | { op: "document_edit"; document: AssistantDocumentName; oldText: string; newText: string };

export type AssistantResultFor<R extends AssistantRequest> =
  R extends { op: "info" } ? AssistantInfo
  : R extends { op: "load" } ? AssistantPreview
  : R extends { op: "recorded" } ? { lastEntryId?: string }
  : R extends { op: "record" } ? { lastEntryId: string }
  : R extends { op: "search" } ? AssistantSearchResult
  : R extends { op: "context" } ? AssistantContextResult
  : AssistantDocument;

/** What a Host offers its assistant Works and, on Main, its clients. */
export interface AssistantHostPort {
  request<R extends AssistantRequest>(request: R, source: AssistantSource, signal?: AbortSignal): Promise<AssistantResultFor<R>>;
}

/** A refusal the owner can act on; `code` is the Protocol V2 error code. */
export class AssistantError extends Error {
  constructor(readonly code: AssistantErrorCode, message: string) { super(message); this.name = "AssistantError"; }
}
export type AssistantErrorCode = "assistant_unavailable" | "assistant_document_changed" | "assistant_document_too_large" | "assistant_edit_not_found" | "assistant_entry_not_found" | "invalid_request";

class FormatError extends Error {}
const fail = (message: string): never => { throw new FormatError(message); };

function record(input: unknown, field: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(`${field} must be an object`);
  return input as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${field} has an unknown field ${key}`);
}
function text(input: unknown, field: string, max: number, min = 0): string {
  if (typeof input !== "string" || input.length < min || input.length > max) fail(`${field} must be text of ${min}–${max} characters`);
  return input as string;
}
function optionalText(input: unknown, field: string, max: number, min = 0): string | undefined {
  return input === undefined ? undefined : text(input, field, max, min);
}
function id(input: unknown, field: string): string { return text(input, field, MAX_ID_CHARS, 1); }
function time(input: unknown, field: string): string {
  const value = text(input, field, 64, 1);
  if (!Number.isFinite(Date.parse(value))) fail(`${field} must be a time`);
  return value;
}
function count(input: unknown, field: string, max: number, min = 0): number {
  if (!Number.isSafeInteger(input) || (input as number) < min || (input as number) > max) fail(`${field} must be a whole number from ${min} to ${max}`);
  return input as number;
}
function documentName(input: unknown, field: string): AssistantDocumentName {
  if (!ASSISTANT_DOCUMENTS.includes(input as AssistantDocumentName)) fail(`${field} must be persona or notes`);
  return input as AssistantDocumentName;
}
function documentText(input: unknown, field: string): string {
  const value = text(input, field, MAX_ASSISTANT_DOCUMENT_BYTES);
  if (Buffer.byteLength(value, "utf8") > MAX_ASSISTANT_DOCUMENT_BYTES) {
    throw new AssistantError("assistant_document_too_large", `这段内容超过 ${MAX_ASSISTANT_DOCUMENT_BYTES / 1024} KB，没有保存。请删短一些再存。`);
  }
  return value;
}
const ENTRY_KINDS: readonly AssistantEntryKind[] = ["user", "assistant", "tool_result", "bash", "summary", "notice"];

export function parseAssistantEntry(input: unknown, field = "entry"): AssistantEntry {
  const value = record(input, field);
  only(value, ["entryId", "parentId", "at", "kind", "text", "toolName", "toolCalls", "truncated"], field);
  if (!ENTRY_KINDS.includes(value.kind as AssistantEntryKind)) fail(`${field}.kind is unknown`);
  const parentId = value.parentId === undefined ? undefined : id(value.parentId, `${field}.parentId`);
  const toolName = optionalText(value.toolName, `${field}.toolName`, MAX_NAME_CHARS, 1);
  let toolCalls: AssistantToolCall[] | undefined;
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls) || value.toolCalls.length > MAX_ASSISTANT_TOOL_CALLS) fail(`${field}.toolCalls must list at most ${MAX_ASSISTANT_TOOL_CALLS} calls`);
    toolCalls = (value.toolCalls as unknown[]).map((raw, index) => {
      const call = record(raw, `${field}.toolCalls[${index}]`);
      only(call, ["name", "arguments"], `${field}.toolCalls[${index}]`);
      return { name: text(call.name, `${field}.toolCalls[${index}].name`, MAX_NAME_CHARS, 1), arguments: text(call.arguments, `${field}.toolCalls[${index}].arguments`, MAX_ASSISTANT_TOOL_ARGUMENT_CHARS) };
    });
  }
  if (value.truncated !== undefined && value.truncated !== true) fail(`${field}.truncated must be true when present`);
  return {
    entryId: id(value.entryId, `${field}.entryId`),
    ...(parentId === undefined ? {} : { parentId }),
    at: time(value.at, `${field}.at`),
    kind: value.kind as AssistantEntryKind,
    text: text(value.text, `${field}.text`, MAX_ASSISTANT_ENTRY_TEXT_CHARS),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(value.truncated === true ? { truncated: true as const } : {}),
  };
}

function parseSearch(value: Record<string, unknown>, field: string): AssistantSearchRequest {
  const query = text(value.query, `${field}.query`, MAX_ASSISTANT_QUERY_CHARS, 1);
  if (query.trim().length === 0) fail(`${field}.query must not be blank`);
  const from = value.from === undefined ? undefined : time(value.from, `${field}.from`);
  const to = value.to === undefined ? undefined : time(value.to, `${field}.to`);
  const cursor = optionalText(value.cursor, `${field}.cursor`, MAX_CURSOR_CHARS, 1);
  return { query, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...(cursor === undefined ? {} : { cursor }), limit: count(value.limit, `${field}.limit`, MAX_ASSISTANT_SEARCH_LIMIT, 1) };
}

function parseContext(value: Record<string, unknown>, field: string): AssistantContextRequest {
  return {
    sessionId: id(value.sessionId, `${field}.sessionId`),
    entryId: id(value.entryId, `${field}.entryId`),
    before: count(value.before, `${field}.before`, MAX_ASSISTANT_CONTEXT_SPAN),
    after: count(value.after, `${field}.after`, MAX_ASSISTANT_CONTEXT_SPAN),
  };
}

/** Throws AssistantError("invalid_request") naming the bad field. */
export function parseAssistantRequest(input: unknown, field = "request"): AssistantRequest {
  try {
    const value = record(input, field);
    switch (value.op) {
      case "info":
      case "load":
        only(value, ["op"], field);
        return { op: value.op };
      case "recorded":
        only(value, ["op", "sessionId"], field);
        return { op: "recorded", sessionId: id(value.sessionId, `${field}.sessionId`) };
      case "record": {
        only(value, ["op", "session", "entries", "throughEntryId"], field);
        const session = record(value.session, `${field}.session`);
        only(session, ["sessionId", "sessionFile", "cwd", "name"], `${field}.session`);
        const sessionFile = optionalText(session.sessionFile, `${field}.session.sessionFile`, MAX_PATH_CHARS, 1);
        const name = optionalText(session.name, `${field}.session.name`, MAX_NAME_CHARS);
        if (!Array.isArray(value.entries)) fail(`${field}.entries must be a list`);
        return {
          op: "record",
          session: {
            sessionId: id(session.sessionId, `${field}.session.sessionId`),
            ...(sessionFile === undefined ? {} : { sessionFile }),
            cwd: text(session.cwd, `${field}.session.cwd`, MAX_PATH_CHARS, 1),
            ...(name === undefined ? {} : { name }),
          },
          entries: (value.entries as unknown[]).map((entry, index) => parseAssistantEntry(entry, `${field}.entries[${index}]`)),
          throughEntryId: id(value.throughEntryId, `${field}.throughEntryId`),
        };
      }
      case "search":
        only(value, ["op", "query", "from", "to", "cursor", "limit"], field);
        return { op: "search", ...parseSearch(value, field) };
      case "context":
        only(value, ["op", "sessionId", "entryId", "before", "after"], field);
        return { op: "context", ...parseContext(value, field) };
      case "document_get":
        only(value, ["op", "document"], field);
        return { op: "document_get", document: documentName(value.document, `${field}.document`) };
      case "document_set": {
        only(value, ["op", "document", "text", "baseRevision"], field);
        const baseRevision = optionalText(value.baseRevision, `${field}.baseRevision`, MAX_REVISION_CHARS, 1);
        return { op: "document_set", document: documentName(value.document, `${field}.document`), text: documentText(value.text, `${field}.text`), ...(baseRevision === undefined ? {} : { baseRevision }) };
      }
      case "document_edit":
        only(value, ["op", "document", "oldText", "newText"], field);
        return { op: "document_edit", document: documentName(value.document, `${field}.document`), oldText: text(value.oldText, `${field}.oldText`, MAX_ASSISTANT_DOCUMENT_BYTES, 1), newText: documentText(value.newText, `${field}.newText`) };
      default:
        return fail(`${field}.op is unknown`);
    }
  } catch (error) {
    if (error instanceof FormatError) throw new AssistantError("invalid_request", error.message);
    throw error;
  }
}

/** The client's search request carries the same fields as the Worker's. */
export function parseAssistantSearchParams(input: Record<string, unknown>, field: string): AssistantSearchRequest {
  try { return parseSearch(input, field); }
  catch (error) { if (error instanceof FormatError) throw new AssistantError("invalid_request", error.message); throw error; }
}
export function parseAssistantContextParams(input: Record<string, unknown>, field: string): AssistantContextRequest {
  try { return parseContext(input, field); }
  catch (error) { if (error instanceof FormatError) throw new AssistantError("invalid_request", error.message); throw error; }
}
export function parseAssistantDocumentName(input: unknown, field: string): AssistantDocumentName {
  try { return documentName(input, field); }
  catch (error) { if (error instanceof FormatError) throw new AssistantError("invalid_request", error.message); throw error; }
}
export function parseAssistantDocumentText(input: unknown, field: string): string {
  try { return documentText(input, field); }
  catch (error) { if (error instanceof FormatError) throw new AssistantError("invalid_request", error.message); throw error; }
}

function parseSession(input: unknown, field: string): AssistantSessionInfo {
  const value = record(input, field);
  only(value, ["sessionId", "sessionFile", "cwd", "name", "workId", "machine", "startedAt", "lastAt"], field);
  const optional = (key: string, max: number) => {
    const item = optionalText(value[key], `${field}.${key}`, max, 1);
    return item === undefined ? {} : { [key]: item };
  };
  return {
    sessionId: id(value.sessionId, `${field}.sessionId`),
    ...optional("sessionFile", MAX_PATH_CHARS), ...optional("cwd", MAX_PATH_CHARS), ...optional("name", MAX_NAME_CHARS),
    ...optional("workId", MAX_ID_CHARS), ...optional("machine", MAX_NAME_CHARS),
    startedAt: time(value.startedAt, `${field}.startedAt`), lastAt: time(value.lastAt, `${field}.lastAt`),
  } as AssistantSessionInfo;
}
function parseDocument(input: unknown, field: string): AssistantDocument {
  const value = record(input, field);
  only(value, ["document", "text", "revision"], field);
  return { document: documentName(value.document, `${field}.document`), text: text(value.text, `${field}.text`, MAX_ASSISTANT_DOCUMENT_BYTES), revision: text(value.revision, `${field}.revision`, MAX_REVISION_CHARS, 1) };
}

export function parseAssistantInfo(input: unknown, field = "assistant info"): AssistantInfo {
  return format(() => {
    const value = record(input, field); only(value, ["workspacePath", "maxDocumentBytes"], field);
    return { workspacePath: text(value.workspacePath, `${field}.workspacePath`, MAX_PATH_CHARS, 1), maxDocumentBytes: count(value.maxDocumentBytes, `${field}.maxDocumentBytes`, Number.MAX_SAFE_INTEGER, 1) };
  });
}
export function parseAssistantPreview(input: unknown, field = "assistant preview"): AssistantPreview {
  return format(() => {
    const value = record(input, field); only(value, ["text", "loadedAt"], field);
    return { text: text(value.text, `${field}.text`, 4 * MAX_ASSISTANT_DOCUMENT_BYTES), loadedAt: time(value.loadedAt, `${field}.loadedAt`) };
  });
}
export function parseAssistantDocument(input: unknown, field = "assistant document"): AssistantDocument { return format(() => parseDocument(input, field)); }
export function parseAssistantSearchResult(input: unknown, field = "assistant search"): AssistantSearchResult {
  return format(() => {
    const value = record(input, field); only(value, ["hits", "nextCursor"], field);
    if (!Array.isArray(value.hits) || value.hits.length > MAX_ASSISTANT_SEARCH_LIMIT) fail(`${field}.hits must list at most ${MAX_ASSISTANT_SEARCH_LIMIT} hits`);
    const nextCursor = optionalText(value.nextCursor, `${field}.nextCursor`, MAX_CURSOR_CHARS, 1);
    return {
      hits: (value.hits as unknown[]).map((raw, index) => {
        const hit = record(raw, `${field}.hits[${index}]`);
        only(hit, ["session", "entryId", "at", "kind", "snippet"], `${field}.hits[${index}]`);
        if (!ENTRY_KINDS.includes(hit.kind as AssistantEntryKind)) fail(`${field}.hits[${index}].kind is unknown`);
        return { session: parseSession(hit.session, `${field}.hits[${index}].session`), entryId: id(hit.entryId, `${field}.hits[${index}].entryId`), at: time(hit.at, `${field}.hits[${index}].at`), kind: hit.kind as AssistantEntryKind, snippet: text(hit.snippet, `${field}.hits[${index}].snippet`, MAX_ASSISTANT_SNIPPET_CHARS + 2) };
      }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });
}
export function parseAssistantContextResult(input: unknown, field = "assistant context"): AssistantContextResult {
  return format(() => {
    const value = record(input, field); only(value, ["session", "entries", "hasBefore", "hasAfter"], field);
    if (!Array.isArray(value.entries) || value.entries.length > 2 * MAX_ASSISTANT_CONTEXT_SPAN + 1) fail(`${field}.entries is too long`);
    if (typeof value.hasBefore !== "boolean" || typeof value.hasAfter !== "boolean") fail(`${field}.hasBefore and hasAfter must be true or false`);
    return { session: parseSession(value.session, `${field}.session`), entries: (value.entries as unknown[]).map((entry, index) => parseAssistantEntry(entry, `${field}.entries[${index}]`)), hasBefore: value.hasBefore as boolean, hasAfter: value.hasAfter as boolean };
  });
}

/** Checks a service answer against the question it answers. */
export function parseAssistantResult<R extends AssistantRequest>(request: R, input: unknown): AssistantResultFor<R> {
  switch (request.op) {
    case "info": return parseAssistantInfo(input) as AssistantResultFor<R>;
    case "load": return parseAssistantPreview(input) as AssistantResultFor<R>;
    case "recorded": return format(() => {
      const value = record(input, "recorded"); only(value, ["lastEntryId"], "recorded");
      return value.lastEntryId === undefined ? {} : { lastEntryId: id(value.lastEntryId, "recorded.lastEntryId") };
    }) as AssistantResultFor<R>;
    case "record": return format(() => {
      const value = record(input, "record"); only(value, ["lastEntryId"], "record");
      return { lastEntryId: id(value.lastEntryId, "record.lastEntryId") };
    }) as AssistantResultFor<R>;
    case "search": return parseAssistantSearchResult(input) as AssistantResultFor<R>;
    case "context": return parseAssistantContextResult(input) as AssistantResultFor<R>;
    default: return parseAssistantDocument(input) as AssistantResultFor<R>;
  }
}

function format<T>(read: () => T): T {
  try { return read(); }
  catch (error) { if (error instanceof FormatError) throw new Error(`The assistant answer is not readable: ${error.message}`); throw error; }
}
