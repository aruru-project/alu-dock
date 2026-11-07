/*
 * The personal assistant (card #295): her persona, the owner's hand-written notes, and the
 * conversations of the Works opened as her. Main keeps all of it in its assistant service; Works on
 * any machine reach it through their Host, and clients through Protocol V2 on Main.
 *
 * This file is the one definition of what crosses those boundaries. The Worker adapter, the Host,
 * the machine connection and the service all parse with it. Questions are closed; answers ignore
 * fields they do not know, so a newer Main can add to them.
 */

/** The two texts the owner and the assistant edit: who she is, and what the owner told her by hand. */
export const ASSISTANT_DOCUMENTS = ["persona", "notes"] as const;
export type AssistantDocumentName = typeof ASSISTANT_DOCUMENTS[number];

/** One document in UTF-8; persona and notes together stay well inside one control record. */
export const MAX_ASSISTANT_DOCUMENT_BYTES = 256 * 1024;
export const MAX_ASSISTANT_QUERY_CHARS = 256;
export const MAX_ASSISTANT_SEARCH_LIMIT = 50;
/** Entries read on each side of one conversation entry, and how many when the asker does not say. */
export const MAX_ASSISTANT_CONTEXT_SPAN = 50;
export const ASSISTANT_CONTEXT_DEFAULT_SPAN = 6;
/** One recorded entry's text; a longer tool output is cut here and stays whole in the Agent's own session file. */
export const MAX_ASSISTANT_ENTRY_TEXT_CHARS = 32_000;
export const MAX_ASSISTANT_TOOL_CALLS = 64;
export const MAX_ASSISTANT_TOOL_ARGUMENT_CHARS = 2_000;
/** A search hit's excerpt in UTF-16 code units, its "…" marks included. */
export const MAX_ASSISTANT_SNIPPET_CHARS = 400;
/** The entries of one recorded batch in UTF-8 JSON, sent as a single private call and machine record. */
export const MAX_ASSISTANT_RECORD_BATCH_BYTES = 384 * 1024;
/** The entries of one context answer in UTF-8 JSON; the rest of that answer is small. */
export const MAX_ASSISTANT_RESULT_BYTES = 768 * 1024;
/**
 * What a session loads: both documents, the memories loaded every session, and the lines around
 * them. There is no other limit on those memories; this is what one record carries with room to spare.
 */
export const MAX_ASSISTANT_PREVIEW_BYTES = MAX_ASSISTANT_RESULT_BYTES;
export const MAX_ASSISTANT_ID_CHARS = 128;
/**
 * Entry times the memory accepts, in milliseconds either side of 1970 (about the years 1717 to 2223):
 * the store orders entries by time × 1024, which must stay a safe JavaScript integer.
 */
export const ASSISTANT_TIME_RANGE_MS = 8_000_000_000_000;
export const MAX_ASSISTANT_NAME_CHARS = 1_024;
export const MAX_ASSISTANT_REVISION_CHARS = 128;
const MAX_PATH_CHARS = 16_384;
const MAX_CURSOR_CHARS = 256;

/** The assistant's own tools; their calls and results are kept for context but not searched again. */
export const ASSISTANT_TOOL_NAMES = ["assistant_search", "assistant_read", "assistant_document", "assistant_memory"] as const;

/**
 * What her memories are about. They describe the owner and the two of them, not the work they did:
 * who he is, what he likes and how he wants things, how they get on, what they went through, and
 * what she resolved about herself.
 */
export const ASSISTANT_MEMORY_TOPICS = ["owner", "preferences", "relationship", "events", "self"] as const;
export type AssistantMemoryTopic = typeof ASSISTANT_MEMORY_TOPICS[number];
/** In use; set aside as no longer true (kept for the record); or forgotten at the owner's word. */
export const ASSISTANT_MEMORY_STATES = ["active", "retired", "forgotten"] as const;
export type AssistantMemoryState = typeof ASSISTANT_MEMORY_STATES[number];
/**
 * Who made a memory's latest change: extraction from a conversation, dreaming (the later pass that
 * checks and tidies memories), the assistant in a conversation, or the owner. Neither background pass
 * changes what the owner changed last.
 */
export const ASSISTANT_MEMORY_AUTHORS = ["extraction", "dreaming", "assistant", "owner"] as const;
export type AssistantMemoryAuthor = typeof ASSISTANT_MEMORY_AUTHORS[number];
export const ASSISTANT_MEMORY_ACTIONS = ["added", "rewritten", "moved", "resident", "query_only", "retired", "forgotten", "restored", "merged"] as const;
export type AssistantMemoryAction = typeof ASSISTANT_MEMORY_ACTIONS[number];
/** One memory's text in characters. */
export const MAX_ASSISTANT_MEMORY_CHARS = 1_000;
/** Places a memory names as where it was said, in a question and in an answer. */
export const MAX_ASSISTANT_MEMORY_SOURCES = 20;
export const MAX_ASSISTANT_MEMORY_LIST_LIMIT = 100;
/** Changes shown for one memory, newest first. */
export const MAX_ASSISTANT_MEMORY_HISTORY = 50;
const MAX_MODEL_PROVIDER_CHARS = 256;
const MAX_MODEL_ID_CHARS = 512;
const MEMORY_ID = /^[1-9][0-9]{0,14}$/u;

export interface AssistantDocument { document: AssistantDocumentName; text: string; revision: string }
/** What a new assistant session loads, and when it was put together. */
export interface AssistantPreview { text: string; loadedAt: string }
/** A model of Main's model service. */
export interface AssistantModelRef { provider: string; id: string }
export interface AssistantSettings {
  /** The model that turns her conversations into memories; without it nothing is extracted. */
  extractionModel?: AssistantModelRef;
}
/**
 * Extraction as it stands: `off` without a model; `idle` with nothing to do; `working` on a
 * conversation now; `failed` when the last try did not work, to be tried again at `retryAt`.
 */
export interface AssistantExtractionStatus {
  state: "off" | "idle" | "working" | "failed";
  model?: AssistantModelRef;
  /** Conversations with something said since they were last read for memories. */
  waitingSessions: number;
  lastRunAt?: string;
  lastError?: string;
  retryAt?: string;
}
export interface AssistantInfo { workspacePath: string; maxDocumentBytes: number; extraction?: AssistantExtractionStatus }

/** Where something was said: an entry of a recorded conversation. */
export interface AssistantMemorySource { sessionId: string; entryId: string; at: string }
export interface AssistantMemory {
  id: string;
  topic: AssistantMemoryTopic;
  text: string;
  /** Loaded into every new assistant session; otherwise found only when she looks. */
  resident: boolean;
  state: AssistantMemoryState;
  /** Who made the latest change. */
  author: AssistantMemoryAuthor;
  createdAt: string;
  updatedAt: string;
  /** Goes up with every change; an update names the revision it started from. */
  revision: number;
  /** The earliest places it was said, at most MAX_ASSISTANT_MEMORY_SOURCES of `sourceCount`. */
  sources: AssistantMemorySource[];
  sourceCount: number;
  /** The memory this one was merged into. */
  supersededBy?: string;
}
export interface AssistantMemoryChange { at: string; author: AssistantMemoryAuthor; action: AssistantMemoryAction; text?: string }
export interface AssistantMemoryDetail { memory: AssistantMemory; history: AssistantMemoryChange[] }
/** Newest first. Without `state`, the memories in use. Every word of `query` must occur. */
export interface AssistantMemoryListRequest {
  query?: string;
  topic?: AssistantMemoryTopic;
  state?: AssistantMemoryState;
  resident?: boolean;
  author?: AssistantMemoryAuthor;
  cursor?: string;
  limit: number;
}
export interface AssistantMemoryList { memories: AssistantMemory[]; nextCursor?: string }
export interface AssistantMemoryAddRequest { topic: AssistantMemoryTopic; text: string; resident: boolean; sources?: Array<{ sessionId: string; entryId: string }> }
/** Changes what it names, if nobody changed the memory since `revision`. */
export interface AssistantMemoryUpdateRequest {
  id: string;
  revision: number;
  text?: string;
  topic?: AssistantMemoryTopic;
  resident?: boolean;
  state?: AssistantMemoryState;
}

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
  /** The text or a tool call was cut; the whole of it is in the Agent's own session file. */
  truncated?: true;
}

/**
 * Where a conversation took place: the Agent's session, and the Work and machine it ran in. In a
 * search hit the Work and machine are those of that entry; in a context answer, of its latest entry.
 */
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

/** Keywords, a time range, or both; without keywords every entry in the range is listed. */
export interface AssistantSearchRequest { query?: string; from?: string; to?: string; cursor?: string; limit: number }
export interface AssistantContextRequest { sessionId: string; entryId: string; before: number; after: number }

export type AssistantRequest =
  | { op: "info" }
  | { op: "load" }
  | { op: "recorded"; sessionId: string }
  /**
   * `throughEntryId` is the last entry of the Agent's session this batch covers, kept or not. A
   * batch without entries only moves that mark, as when a session opened as the assistant starts
   * from history that was not hers.
   */
  | { op: "record"; session: AssistantRecordSession; entries: AssistantEntry[]; throughEntryId: string }
  | ({ op: "search" } & AssistantSearchRequest)
  | ({ op: "context" } & AssistantContextRequest)
  | { op: "document_get"; document: AssistantDocumentName }
  /** Without `baseRevision` the text replaces whatever is there. */
  | { op: "document_set"; document: AssistantDocumentName; text: string; baseRevision?: string }
  | { op: "document_edit"; document: AssistantDocumentName; oldText: string; newText: string }
  | ({ op: "memory_list" } & AssistantMemoryListRequest)
  | { op: "memory_get"; id: string }
  | ({ op: "memory_add" } & AssistantMemoryAddRequest)
  | ({ op: "memory_update" } & AssistantMemoryUpdateRequest)
  | { op: "settings_get" }
  /** `null` stops extraction. */
  | { op: "settings_set"; extractionModel: AssistantModelRef | null };

export type AssistantResultFor<R extends AssistantRequest> =
  R extends { op: "info" } ? AssistantInfo
  : R extends { op: "load" } ? AssistantPreview
  : R extends { op: "recorded" } ? { lastEntryId?: string }
  : R extends { op: "record" } ? { lastEntryId: string }
  : R extends { op: "search" } ? AssistantSearchResult
  : R extends { op: "context" } ? AssistantContextResult
  : R extends { op: "memory_list" } ? AssistantMemoryList
  : R extends { op: "memory_get" } ? AssistantMemoryDetail
  : R extends { op: "memory_add" | "memory_update" } ? AssistantMemory
  : R extends { op: "settings_get" | "settings_set" } ? AssistantSettings
  : AssistantDocument;

/** What a Host offers its assistant Works and, on Main, its clients. */
export interface AssistantHostPort {
  request<R extends AssistantRequest>(request: R, source: AssistantSource, signal?: AbortSignal): Promise<AssistantResultFor<R>>;
}

/** Refusals the owner can act on; each is also the Protocol V2 error code. */
export const ASSISTANT_ERROR_CODES = [
  "assistant_unavailable", "assistant_document_changed", "assistant_document_too_large",
  "assistant_edit_not_found", "assistant_edit_ambiguous", "assistant_entry_not_found", "assistant_query_timeout",
  "assistant_memory_not_found", "assistant_memory_changed", "invalid_request",
] as const;
export type AssistantErrorCode = typeof ASSISTANT_ERROR_CODES[number];
export class AssistantError extends Error {
  constructor(readonly code: AssistantErrorCode, message: string) { super(message); this.name = "AssistantError"; }
}
export function isAssistantErrorCode(code: unknown): code is AssistantErrorCode {
  return ASSISTANT_ERROR_CODES.includes(code as AssistantErrorCode);
}

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
function id(input: unknown, field: string): string { return text(input, field, MAX_ASSISTANT_ID_CHARS, 1); }
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
function entryKind(input: unknown, field: string): AssistantEntryKind {
  if (!ENTRY_KINDS.includes(input as AssistantEntryKind)) fail(`${field} is unknown`);
  return input as AssistantEntryKind;
}

function oneOf<T extends string>(input: unknown, values: readonly T[], field: string): T {
  if (!values.includes(input as T)) fail(`${field} must be one of ${values.join(", ")}`);
  return input as T;
}
function flag(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") fail(`${field} must be true or false`);
  return input as boolean;
}
function memoryId(input: unknown, field: string): string {
  if (typeof input !== "string" || !MEMORY_ID.test(input)) fail(`${field} must be a memory ID`);
  return input as string;
}
function memoryText(input: unknown, field: string): string {
  const value = text(input, field, MAX_ASSISTANT_MEMORY_CHARS);
  if (value.trim().length === 0) fail(`${field} must not be empty`);
  return value.trim();
}
function modelRef(input: unknown, field: string, closed: boolean): AssistantModelRef {
  const value = record(input, field);
  if (closed) only(value, ["provider", "id"], field);
  return { provider: text(value.provider, `${field}.provider`, MAX_MODEL_PROVIDER_CHARS, 1), id: text(value.id, `${field}.id`, MAX_MODEL_ID_CHARS, 1) };
}

function parseMemoryList(value: Record<string, unknown>, field: string): AssistantMemoryListRequest {
  const query = optionalText(value.query, `${field}.query`, MAX_ASSISTANT_QUERY_CHARS);
  const cursor = optionalText(value.cursor, `${field}.cursor`, MAX_CURSOR_CHARS, 1);
  return {
    ...(query === undefined || query.trim().length === 0 ? {} : { query }),
    ...(value.topic === undefined ? {} : { topic: oneOf(value.topic, ASSISTANT_MEMORY_TOPICS, `${field}.topic`) }),
    ...(value.state === undefined ? {} : { state: oneOf(value.state, ASSISTANT_MEMORY_STATES, `${field}.state`) }),
    ...(value.resident === undefined ? {} : { resident: flag(value.resident, `${field}.resident`) }),
    ...(value.author === undefined ? {} : { author: oneOf(value.author, ASSISTANT_MEMORY_AUTHORS, `${field}.author`) }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: count(value.limit, `${field}.limit`, MAX_ASSISTANT_MEMORY_LIST_LIMIT, 1),
  };
}

function parseMemoryAdd(value: Record<string, unknown>, field: string): AssistantMemoryAddRequest {
  let sources: AssistantMemoryAddRequest["sources"];
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length > MAX_ASSISTANT_MEMORY_SOURCES) fail(`${field}.sources must list at most ${MAX_ASSISTANT_MEMORY_SOURCES} places`);
    sources = (value.sources as unknown[]).map((raw, index) => {
      const source = record(raw, `${field}.sources[${index}]`);
      only(source, ["sessionId", "entryId"], `${field}.sources[${index}]`);
      return { sessionId: id(source.sessionId, `${field}.sources[${index}].sessionId`), entryId: id(source.entryId, `${field}.sources[${index}].entryId`) };
    });
  }
  return {
    topic: oneOf(value.topic, ASSISTANT_MEMORY_TOPICS, `${field}.topic`),
    text: memoryText(value.text, `${field}.text`),
    resident: flag(value.resident, `${field}.resident`),
    ...(sources === undefined || sources.length === 0 ? {} : { sources }),
  };
}

function parseMemoryUpdate(value: Record<string, unknown>, field: string): AssistantMemoryUpdateRequest {
  const update: AssistantMemoryUpdateRequest = {
    id: memoryId(value.id, `${field}.id`),
    revision: count(value.revision, `${field}.revision`, Number.MAX_SAFE_INTEGER, 1),
    ...(value.text === undefined ? {} : { text: memoryText(value.text, `${field}.text`) }),
    ...(value.topic === undefined ? {} : { topic: oneOf(value.topic, ASSISTANT_MEMORY_TOPICS, `${field}.topic`) }),
    ...(value.resident === undefined ? {} : { resident: flag(value.resident, `${field}.resident`) }),
    ...(value.state === undefined ? {} : { state: oneOf(value.state, ASSISTANT_MEMORY_STATES, `${field}.state`) }),
  };
  if (update.text === undefined && update.topic === undefined && update.resident === undefined && update.state === undefined) fail(`${field} changes nothing`);
  return update;
}

function parseSettingsSet(value: Record<string, unknown>, field: string): AssistantModelRef | null {
  if (!("extractionModel" in value)) fail(`${field}.extractionModel is required`);
  return value.extractionModel === null ? null : modelRef(value.extractionModel, `${field}.extractionModel`, true);
}

/** `closed` refuses unknown fields, as in a question; an answer ignores them. */
function parseEntry(input: unknown, field: string, closed: boolean): AssistantEntry {
  const value = record(input, field);
  if (closed) only(value, ["entryId", "parentId", "at", "kind", "text", "toolName", "toolCalls", "truncated"], field);
  const parentId = value.parentId === undefined ? undefined : id(value.parentId, `${field}.parentId`);
  const toolName = optionalText(value.toolName, `${field}.toolName`, MAX_ASSISTANT_NAME_CHARS, 1);
  let toolCalls: AssistantToolCall[] | undefined;
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls) || value.toolCalls.length > MAX_ASSISTANT_TOOL_CALLS) fail(`${field}.toolCalls must list at most ${MAX_ASSISTANT_TOOL_CALLS} calls`);
    toolCalls = (value.toolCalls as unknown[]).map((raw, index) => {
      const call = record(raw, `${field}.toolCalls[${index}]`);
      if (closed) only(call, ["name", "arguments"], `${field}.toolCalls[${index}]`);
      return { name: text(call.name, `${field}.toolCalls[${index}].name`, MAX_ASSISTANT_NAME_CHARS, 1), arguments: text(call.arguments, `${field}.toolCalls[${index}].arguments`, MAX_ASSISTANT_TOOL_ARGUMENT_CHARS) };
    });
  }
  if (value.truncated !== undefined && value.truncated !== true) fail(`${field}.truncated must be true when present`);
  const at = time(value.at, `${field}.at`);
  if (Math.abs(Date.parse(at)) >= ASSISTANT_TIME_RANGE_MS) fail(`${field}.at is outside the times the memory keeps`);
  return {
    entryId: id(value.entryId, `${field}.entryId`),
    ...(parentId === undefined ? {} : { parentId }),
    at,
    kind: entryKind(value.kind, `${field}.kind`),
    text: text(value.text, `${field}.text`, MAX_ASSISTANT_ENTRY_TEXT_CHARS),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(value.truncated === true ? { truncated: true as const } : {}),
  };
}

function parseSearch(value: Record<string, unknown>, field: string): AssistantSearchRequest {
  const query = optionalText(value.query, `${field}.query`, MAX_ASSISTANT_QUERY_CHARS);
  const from = value.from === undefined ? undefined : time(value.from, `${field}.from`);
  const to = value.to === undefined ? undefined : time(value.to, `${field}.to`);
  if ((query === undefined || query.trim().length === 0) && from === undefined && to === undefined) fail(`${field} needs keywords or a time range`);
  const cursor = optionalText(value.cursor, `${field}.cursor`, MAX_CURSOR_CHARS, 1);
  return {
    ...(query === undefined || query.trim().length === 0 ? {} : { query }),
    ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...(cursor === undefined ? {} : { cursor }),
    limit: count(value.limit, `${field}.limit`, MAX_ASSISTANT_SEARCH_LIMIT, 1),
  };
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
  return question(() => {
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
        const name = optionalText(session.name, `${field}.session.name`, MAX_ASSISTANT_NAME_CHARS);
        if (!Array.isArray(value.entries)) fail(`${field}.entries must be a list`);
        if (Buffer.byteLength(JSON.stringify(value.entries), "utf8") > MAX_ASSISTANT_RECORD_BATCH_BYTES) fail(`${field}.entries is larger than one batch may be`);
        return {
          op: "record",
          session: {
            sessionId: id(session.sessionId, `${field}.session.sessionId`),
            ...(sessionFile === undefined ? {} : { sessionFile }),
            cwd: text(session.cwd, `${field}.session.cwd`, MAX_PATH_CHARS, 1),
            ...(name === undefined ? {} : { name }),
          },
          entries: (value.entries as unknown[]).map((entry, index) => parseEntry(entry, `${field}.entries[${index}]`, true)),
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
        const baseRevision = optionalText(value.baseRevision, `${field}.baseRevision`, MAX_ASSISTANT_REVISION_CHARS, 1);
        return { op: "document_set", document: documentName(value.document, `${field}.document`), text: documentText(value.text, `${field}.text`), ...(baseRevision === undefined ? {} : { baseRevision }) };
      }
      case "document_edit":
        only(value, ["op", "document", "oldText", "newText"], field);
        return { op: "document_edit", document: documentName(value.document, `${field}.document`), oldText: text(value.oldText, `${field}.oldText`, MAX_ASSISTANT_DOCUMENT_BYTES, 1), newText: documentText(value.newText, `${field}.newText`) };
      case "memory_list":
        only(value, ["op", "query", "topic", "state", "resident", "author", "cursor", "limit"], field);
        return { op: "memory_list", ...parseMemoryList(value, field) };
      case "memory_get":
        only(value, ["op", "id"], field);
        return { op: "memory_get", id: memoryId(value.id, `${field}.id`) };
      case "memory_add":
        only(value, ["op", "topic", "text", "resident", "sources"], field);
        return { op: "memory_add", ...parseMemoryAdd(value, field) };
      case "memory_update":
        only(value, ["op", "id", "revision", "text", "topic", "resident", "state"], field);
        return { op: "memory_update", ...parseMemoryUpdate(value, field) };
      case "settings_get":
        only(value, ["op"], field);
        return { op: "settings_get" };
      case "settings_set":
        only(value, ["op", "extractionModel"], field);
        return { op: "settings_set", extractionModel: parseSettingsSet(value, field) };
      default:
        return fail(`${field}.op is unknown`);
    }
  });
}

/** The client's search request carries the same fields as the Worker's. */
export function parseAssistantSearchParams(input: Record<string, unknown>, field: string): AssistantSearchRequest {
  return question(() => parseSearch(input, field));
}
export function parseAssistantContextParams(input: Record<string, unknown>, field: string): AssistantContextRequest {
  return question(() => parseContext(input, field));
}
export function parseAssistantMemoryListParams(input: Record<string, unknown>, field: string): AssistantMemoryListRequest {
  return question(() => parseMemoryList(input, field));
}
export function parseAssistantMemoryId(input: unknown, field: string): string {
  return question(() => memoryId(input, field));
}
export function parseAssistantMemoryAddParams(input: Record<string, unknown>, field: string): AssistantMemoryAddRequest {
  return question(() => parseMemoryAdd(input, field));
}
export function parseAssistantMemoryUpdateParams(input: Record<string, unknown>, field: string): AssistantMemoryUpdateRequest {
  return question(() => parseMemoryUpdate(input, field));
}
export function parseAssistantSettingsSetParams(input: Record<string, unknown>, field: string): AssistantModelRef | null {
  return question(() => parseSettingsSet(input, field));
}
export function parseAssistantDocumentName(input: unknown, field: string): AssistantDocumentName {
  return question(() => documentName(input, field));
}
export function parseAssistantDocumentText(input: unknown, field: string): string {
  return question(() => documentText(input, field));
}
/** What the Host says about the asker; anything else is left out. */
export function parseAssistantSource(input: unknown): AssistantSource {
  if (input === null || typeof input !== "object") return {};
  const value = input as Record<string, unknown>;
  const fits = (item: unknown, max: number): item is string => typeof item === "string" && item.length > 0 && item.length <= max;
  return {
    ...(fits(value.workId, MAX_ASSISTANT_ID_CHARS) ? { workId: value.workId } : {}),
    ...(fits(value.machine, MAX_ASSISTANT_NAME_CHARS) ? { machine: value.machine } : {}),
  };
}

function parseSession(input: unknown, field: string): AssistantSessionInfo {
  const value = record(input, field);
  const optional = (key: string, max: number) => {
    const item = optionalText(value[key], `${field}.${key}`, max, 1);
    return item === undefined ? {} : { [key]: item };
  };
  return {
    sessionId: id(value.sessionId, `${field}.sessionId`),
    ...optional("sessionFile", MAX_PATH_CHARS), ...optional("cwd", MAX_PATH_CHARS), ...optional("name", MAX_ASSISTANT_NAME_CHARS),
    ...optional("workId", MAX_ASSISTANT_ID_CHARS), ...optional("machine", MAX_ASSISTANT_NAME_CHARS),
    startedAt: time(value.startedAt, `${field}.startedAt`), lastAt: time(value.lastAt, `${field}.lastAt`),
  } as AssistantSessionInfo;
}

export function parseAssistantInfo(input: unknown, field = "assistant info"): AssistantInfo {
  return answer(() => {
    const value = record(input, field);
    return {
      workspacePath: text(value.workspacePath, `${field}.workspacePath`, MAX_PATH_CHARS, 1),
      maxDocumentBytes: count(value.maxDocumentBytes, `${field}.maxDocumentBytes`, Number.MAX_SAFE_INTEGER, 1),
      ...(value.extraction === undefined ? {} : { extraction: parseExtractionStatus(value.extraction, `${field}.extraction`) }),
    };
  });
}

function parseExtractionStatus(input: unknown, field: string): AssistantExtractionStatus {
  const value = record(input, field);
  const optionalTime = (key: string) => value[key] === undefined ? {} : { [key]: time(value[key], `${field}.${key}`) };
  const lastError = optionalText(value.lastError, `${field}.lastError`, 4_000, 1);
  return {
    state: oneOf(value.state, ["off", "idle", "working", "failed"] as const, `${field}.state`),
    ...(value.model === undefined ? {} : { model: modelRef(value.model, `${field}.model`, false) }),
    waitingSessions: count(value.waitingSessions, `${field}.waitingSessions`, Number.MAX_SAFE_INTEGER),
    ...optionalTime("lastRunAt"),
    ...(lastError === undefined ? {} : { lastError }),
    ...optionalTime("retryAt"),
  } as AssistantExtractionStatus;
}

export function parseAssistantMemory(input: unknown, field = "assistant memory"): AssistantMemory {
  return answer(() => {
    const value = record(input, field);
    if (!Array.isArray(value.sources) || value.sources.length > MAX_ASSISTANT_MEMORY_SOURCES) fail(`${field}.sources must list at most ${MAX_ASSISTANT_MEMORY_SOURCES} places`);
    return {
      id: memoryId(value.id, `${field}.id`),
      topic: oneOf(value.topic, ASSISTANT_MEMORY_TOPICS, `${field}.topic`),
      text: text(value.text, `${field}.text`, MAX_ASSISTANT_MEMORY_CHARS, 1),
      resident: flag(value.resident, `${field}.resident`),
      state: oneOf(value.state, ASSISTANT_MEMORY_STATES, `${field}.state`),
      author: oneOf(value.author, ASSISTANT_MEMORY_AUTHORS, `${field}.author`),
      createdAt: time(value.createdAt, `${field}.createdAt`),
      updatedAt: time(value.updatedAt, `${field}.updatedAt`),
      revision: count(value.revision, `${field}.revision`, Number.MAX_SAFE_INTEGER, 1),
      sources: (value.sources as unknown[]).map((raw, index) => {
        const source = record(raw, `${field}.sources[${index}]`);
        return { sessionId: id(source.sessionId, `${field}.sources[${index}].sessionId`), entryId: id(source.entryId, `${field}.sources[${index}].entryId`), at: time(source.at, `${field}.sources[${index}].at`) };
      }),
      sourceCount: count(value.sourceCount, `${field}.sourceCount`, Number.MAX_SAFE_INTEGER),
      ...(value.supersededBy === undefined ? {} : { supersededBy: memoryId(value.supersededBy, `${field}.supersededBy`) }),
    };
  });
}

export function parseAssistantMemoryList(input: unknown, field = "assistant memories"): AssistantMemoryList {
  return answer(() => {
    const value = record(input, field);
    if (!Array.isArray(value.memories) || value.memories.length > MAX_ASSISTANT_MEMORY_LIST_LIMIT) fail(`${field}.memories must list at most ${MAX_ASSISTANT_MEMORY_LIST_LIMIT} memories`);
    const nextCursor = optionalText(value.nextCursor, `${field}.nextCursor`, MAX_CURSOR_CHARS, 1);
    return { memories: (value.memories as unknown[]).map((raw, index) => parseAssistantMemory(raw, `${field}.memories[${index}]`)), ...(nextCursor === undefined ? {} : { nextCursor }) };
  });
}

export function parseAssistantMemoryDetail(input: unknown, field = "assistant memory"): AssistantMemoryDetail {
  return answer(() => {
    const value = record(input, field);
    if (!Array.isArray(value.history) || value.history.length > MAX_ASSISTANT_MEMORY_HISTORY) fail(`${field}.history must list at most ${MAX_ASSISTANT_MEMORY_HISTORY} changes`);
    return {
      memory: parseAssistantMemory(value.memory, `${field}.memory`),
      history: (value.history as unknown[]).map((raw, index) => {
        const change = record(raw, `${field}.history[${index}]`);
        const changed = optionalText(change.text, `${field}.history[${index}].text`, MAX_ASSISTANT_MEMORY_CHARS);
        return {
          at: time(change.at, `${field}.history[${index}].at`),
          author: oneOf(change.author, ASSISTANT_MEMORY_AUTHORS, `${field}.history[${index}].author`),
          action: oneOf(change.action, ASSISTANT_MEMORY_ACTIONS, `${field}.history[${index}].action`),
          ...(changed === undefined ? {} : { text: changed }),
        };
      }),
    };
  });
}

export function parseAssistantSettings(input: unknown, field = "assistant settings"): AssistantSettings {
  return answer(() => {
    const value = record(input, field);
    return value.extractionModel === undefined ? {} : { extractionModel: modelRef(value.extractionModel, `${field}.extractionModel`, false) };
  });
}
export function parseAssistantPreview(input: unknown, field = "assistant preview"): AssistantPreview {
  return answer(() => {
    const value = record(input, field);
    const loaded = text(value.text, `${field}.text`, MAX_ASSISTANT_PREVIEW_BYTES);
    if (Buffer.byteLength(loaded, "utf8") > MAX_ASSISTANT_PREVIEW_BYTES) fail(`${field}.text is too long`);
    return { text: loaded, loadedAt: time(value.loadedAt, `${field}.loadedAt`) };
  });
}
export function parseAssistantDocument(input: unknown, field = "assistant document"): AssistantDocument {
  return answer(() => {
    const value = record(input, field);
    return { document: documentName(value.document, `${field}.document`), text: text(value.text, `${field}.text`, MAX_ASSISTANT_DOCUMENT_BYTES), revision: text(value.revision, `${field}.revision`, MAX_ASSISTANT_REVISION_CHARS, 1) };
  });
}
export function parseAssistantSearchResult(input: unknown, field = "assistant search"): AssistantSearchResult {
  return answer(() => {
    const value = record(input, field);
    if (!Array.isArray(value.hits) || value.hits.length > MAX_ASSISTANT_SEARCH_LIMIT) fail(`${field}.hits must list at most ${MAX_ASSISTANT_SEARCH_LIMIT} hits`);
    const nextCursor = optionalText(value.nextCursor, `${field}.nextCursor`, MAX_CURSOR_CHARS, 1);
    return {
      hits: (value.hits as unknown[]).map((raw, index) => {
        const hit = record(raw, `${field}.hits[${index}]`);
        return {
          session: parseSession(hit.session, `${field}.hits[${index}].session`),
          entryId: id(hit.entryId, `${field}.hits[${index}].entryId`),
          at: time(hit.at, `${field}.hits[${index}].at`),
          kind: entryKind(hit.kind, `${field}.hits[${index}].kind`),
          snippet: text(hit.snippet, `${field}.hits[${index}].snippet`, MAX_ASSISTANT_SNIPPET_CHARS),
        };
      }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });
}
export function parseAssistantContextResult(input: unknown, field = "assistant context"): AssistantContextResult {
  return answer(() => {
    const value = record(input, field);
    if (!Array.isArray(value.entries) || value.entries.length > 2 * MAX_ASSISTANT_CONTEXT_SPAN + 1) fail(`${field}.entries is too long`);
    if (typeof value.hasBefore !== "boolean" || typeof value.hasAfter !== "boolean") fail(`${field}.hasBefore and hasAfter must be true or false`);
    return { session: parseSession(value.session, `${field}.session`), entries: (value.entries as unknown[]).map((entry, index) => parseEntry(entry, `${field}.entries[${index}]`, false)), hasBefore: value.hasBefore as boolean, hasAfter: value.hasAfter as boolean };
  });
}

/** Checks a service answer against the question it answers. */
export function parseAssistantResult<R extends AssistantRequest>(request: R, input: unknown): AssistantResultFor<R> {
  switch (request.op) {
    case "info": return parseAssistantInfo(input) as AssistantResultFor<R>;
    case "load": return parseAssistantPreview(input) as AssistantResultFor<R>;
    case "recorded": return answer(() => {
      const value = record(input, "recorded");
      return value.lastEntryId === undefined ? {} : { lastEntryId: id(value.lastEntryId, "recorded.lastEntryId") };
    }) as AssistantResultFor<R>;
    case "record": return answer(() => ({ lastEntryId: id(record(input, "record").lastEntryId, "record.lastEntryId") })) as AssistantResultFor<R>;
    case "search": return parseAssistantSearchResult(input) as AssistantResultFor<R>;
    case "context": return parseAssistantContextResult(input) as AssistantResultFor<R>;
    case "memory_list": return parseAssistantMemoryList(input) as AssistantResultFor<R>;
    case "memory_get": return parseAssistantMemoryDetail(input) as AssistantResultFor<R>;
    case "memory_add":
    case "memory_update": return parseAssistantMemory(input) as AssistantResultFor<R>;
    case "settings_get":
    case "settings_set": return parseAssistantSettings(input) as AssistantResultFor<R>;
    default: return parseAssistantDocument(input) as AssistantResultFor<R>;
  }
}

function question<T>(read: () => T): T {
  try { return read(); }
  catch (error) { if (error instanceof FormatError) throw new AssistantError("invalid_request", error.message); throw error; }
}
function answer<T>(read: () => T): T {
  try { return read(); }
  catch (error) { if (error instanceof FormatError) throw new Error(`The assistant answer is not readable: ${error.message}`); throw error; }
}
