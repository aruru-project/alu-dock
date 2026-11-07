import type { ExtensionContext, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  ASSISTANT_TOOL_NAMES,
  MAX_ASSISTANT_CONTEXT_SPAN,
  MAX_ASSISTANT_ENTRY_TEXT_CHARS,
  MAX_ASSISTANT_QUERY_CHARS,
  MAX_ASSISTANT_RECORD_BATCH_BYTES,
  MAX_ASSISTANT_SEARCH_LIMIT,
  MAX_ASSISTANT_TOOL_ARGUMENT_CHARS,
  MAX_ASSISTANT_TOOL_CALLS,
  type AssistantContextResult,
  type AssistantDocument,
  type AssistantEntry,
  type AssistantPreview,
  type AssistantRequest,
  type AssistantResultFor,
  type AssistantSearchResult,
  type AssistantSessionInfo,
} from "../core/assistant.js";
import { extractDockAttachmentContext } from "./dock-attachment-context.js";

/*
 * What makes a Pi Work the personal assistant (card #295). Each session start (new Work, reload,
 * /new, resume, reopen) loads her persona, the owner's notes and how to recall more from Main into a
 * prompt section; the session keeps that copy until it starts again. Her conversation goes to Main
 * entry by entry, and her tools search and read it and edit her persona and the owner's notes.
 */

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface AssistantCallPort {
  call<R extends AssistantRequest>(request: R): Promise<AssistantResultFor<R>>;
}

const EXTENSION_PATH = "<inline:alu-dock-assistant>";
const OWN_TOOLS = new Set<string>(ASSISTANT_TOOL_NAMES);
/** The prompt section holding what the session loaded; Pi records it and any later change in the session. */
const SECTION = "assistant";
/** A Work that is stopping waits this long at most for its last entries to reach Main. */
const SHUTDOWN_SYNC_MS = 1_000;
const DEFAULT_CONTEXT_SPAN = 6;

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: MAX_ASSISTANT_QUERY_CHARS, description: "Keywords separated by spaces; every one must occur. Chinese works; try other wording when nothing is found." },
    from: { type: "string", description: "Earliest time, as YYYY-MM-DD (the local day) or an ISO time." },
    to: { type: "string", description: "Latest time, as YYYY-MM-DD (including that day) or an ISO time." },
    cursor: { type: "string", description: "The cursor an earlier search returned, to read older results." },
    limit: { type: "integer", minimum: 1, maximum: MAX_ASSISTANT_SEARCH_LIMIT },
  },
  required: ["query"],
  additionalProperties: false,
};
const READ_SCHEMA = {
  type: "object",
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: 128 },
    entryId: { type: "string", minLength: 1, maxLength: 128 },
    before: { type: "integer", minimum: 0, maximum: MAX_ASSISTANT_CONTEXT_SPAN, description: `Entries before it; default ${DEFAULT_CONTEXT_SPAN}.` },
    after: { type: "integer", minimum: 0, maximum: MAX_ASSISTANT_CONTEXT_SPAN, description: `Entries after it; default ${DEFAULT_CONTEXT_SPAN}.` },
  },
  required: ["sessionId", "entryId"],
  additionalProperties: false,
};
const DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    document: { type: "string", enum: ["persona", "notes"], description: "persona: who you are. notes: the facts and rules your owner wrote by hand." },
    action: { type: "string", enum: ["read", "write", "edit"] },
    text: { type: "string", description: "write: the whole new text." },
    oldText: { type: "string", description: "edit: an exact passage that occurs once." },
    newText: { type: "string", description: "edit: what replaces it." },
  },
  required: ["document", "action"],
  additionalProperties: false,
};

export function assistantExtension(port: AssistantCallPort, attachmentContextKey: Uint8Array): ExtensionFactory {
  return (pi) => {
    let loading: Promise<AssistantPreview | Error> | undefined;
    let recorder: SessionRecorder | undefined;
    const load = () => port.call({ op: "load" }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

    pi.on("session_start", (_event, ctx) => {
      loading = load();
      recorder = new SessionRecorder(port, ctx.sessionManager, attachmentContextKey);
      void recorder.sync();
      const collision = pi.getAllTools().find((tool) => OWN_TOOLS.has(tool.name) && tool.sourceInfo.path !== EXTENSION_PATH);
      if (collision) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => !OWN_TOOLS.has(name)));
        ctx.ui.notify(`The assistant's tools are unavailable because ${collision.name} is already registered.`, "error");
      }
    });

    pi.on("before_agent_start", async (event) => {
      let loaded = await (loading ??= load());
      // A session that could not load at its start tries again before each run, until it can.
      if (loaded instanceof Error) loaded = await (loading = load());
      event.systemPromptOptions.sections[SECTION] = loaded instanceof Error
        ? `You are the owner's personal assistant, but your persona and notes could not be loaded from Main just now (${loaded.message}). Say so if it matters, and do not make them up.`
        : loaded.text;
    });

    // Her words go to Main once each run settles; a stopped run or a failed send is caught up later.
    pi.on("agent_settled", () => { void recorder?.sync(); });
    pi.on("session_compact", () => { void recorder?.sync(); });
    pi.on("session_shutdown", async () => {
      const current = recorder;
      if (!current) return;
      await Promise.race([current.sync(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_SYNC_MS).unref())]);
    });

    pi.registerTool({
      name: "assistant_search",
      label: "Search memory",
      description: "Search your past conversations with your owner by keywords and time, newest first. Each hit names its sessionId and entryId; use assistant_read to see what was said around it. When nothing is found, try other words before saying you do not remember.",
      parameters: SEARCH_SCHEMA,
      execute: async (_id: string, params: { query: string; from?: string; to?: string; cursor?: string; limit?: number }) => {
        const result = await port.call({ op: "search", query: params.query, ...optional("from", params.from), ...optional("to", params.to), ...optional("cursor", params.cursor), limit: params.limit ?? 10 });
        return { content: [{ type: "text", text: renderSearch(result) }], details: result };
      },
    } as never);

    pi.registerTool({
      name: "assistant_read",
      label: "Read past conversation",
      description: "Read what was said around one entry of a past conversation, including the tools called and what they returned. Use the sessionId and entryId from assistant_search.",
      parameters: READ_SCHEMA,
      execute: async (_id: string, params: { sessionId: string; entryId: string; before?: number; after?: number }) => {
        const result = await port.call({ op: "context", sessionId: params.sessionId, entryId: params.entryId, before: params.before ?? DEFAULT_CONTEXT_SPAN, after: params.after ?? DEFAULT_CONTEXT_SPAN });
        return { content: [{ type: "text", text: renderContext(result, params.entryId) }], details: result };
      },
    } as never);

    pi.registerTool({
      name: "assistant_document",
      label: "Persona and notes",
      description: "Read or change your persona (who you are) or the notes your owner wrote by hand (facts and rules that win over anything else). write replaces the whole text; edit replaces one exact passage. Changes apply to sessions that start later; this session already knows what you changed.",
      parameters: DOCUMENT_SCHEMA,
      execute: async (_id: string, params: { document: "persona" | "notes"; action: "read" | "write" | "edit"; text?: string; oldText?: string; newText?: string }) => {
        let result: AssistantDocument;
        if (params.action === "read") result = await port.call({ op: "document_get", document: params.document });
        else if (params.action === "write") {
          if (params.text === undefined) throw new Error("write needs text: the whole new document.");
          result = await port.call({ op: "document_set", document: params.document, text: params.text });
        } else {
          if (params.oldText === undefined || params.newText === undefined) throw new Error("edit needs oldText and newText.");
          result = await port.call({ op: "document_edit", document: params.document, oldText: params.oldText, newText: params.newText });
        }
        const text = params.action === "read"
          ? (result.text.length === 0 ? `The ${params.document} document is empty.` : result.text)
          : `Saved the ${params.document} document. Sessions that start from now on load it.`;
        return { content: [{ type: "text", text }], details: { document: result.document, revision: result.revision } };
      },
    } as never);
  };
}

/** Sends one session's new entries to Main, in order, from where Main last recorded it. */
class SessionRecorder {
  private through: string | undefined;
  private known = false;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly port: AssistantCallPort,
    private readonly session: ReadonlySessionManager,
    private readonly attachmentContextKey: Uint8Array,
  ) {}

  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do { this.again = false; await this.once(); } while (this.again);
    })().catch(() => { /* Main is unreachable; the next run or session start catches up. */ }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async once(): Promise<void> {
    const sessionId = this.session.getSessionId();
    if (!this.known) {
      this.through = (await this.port.call({ op: "recorded", sessionId })).lastEntryId;
      this.known = true;
    }
    const entries = this.session.getEntries();
    const recordedAt = this.through === undefined ? -1 : entries.findIndex((entry) => entry.id === this.through);
    const pending = entries.slice(recordedAt + 1);
    if (pending.length === 0) return;
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    const kept = new Map<string, boolean>();
    const keeps = (entry: SessionEntry): boolean => {
      let value = kept.get(entry.id);
      if (value === undefined) { value = assistantEntryOf(entry, this.attachmentContextKey) !== undefined; kept.set(entry.id, value); }
      return value;
    };
    // The nearest earlier entry of the branch that Main keeps too, so reading back follows the branch.
    const parentOf = (entry: SessionEntry): string | undefined => {
      let parent = entry.parentId === null ? undefined : byId.get(entry.parentId);
      while (parent && !keeps(parent)) parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
      return parent?.id;
    };
    const sessionFile = this.session.getSessionFile();
    const name = this.session.getSessionName();
    const session = { sessionId, ...(sessionFile === undefined ? {} : { sessionFile }), cwd: this.session.getCwd(), ...(name === undefined ? {} : { name }) };
    let batch: AssistantEntry[] = [];
    let bytes = 0;
    const send = async (throughEntryId: string) => {
      await this.port.call({ op: "record", session, entries: batch, throughEntryId });
      this.through = throughEntryId;
      batch = [];
      bytes = 0;
    };
    for (const [index, entry] of pending.entries()) {
      const mapped = keeps(entry) ? assistantEntryOf(entry, this.attachmentContextKey) : undefined;
      if (mapped) {
        const parentId = parentOf(entry);
        const item = parentId === undefined ? mapped : { ...mapped, parentId };
        const size = Buffer.byteLength(JSON.stringify(item), "utf8");
        if (batch.length > 0 && bytes + size > MAX_ASSISTANT_RECORD_BATCH_BYTES - 16 * 1024) await send(pending[index - 1]!.id);
        batch.push(item);
        bytes += size;
      }
    }
    await send(pending.at(-1)!.id);
  }
}

type Block = { type: string; text?: string; name?: string; arguments?: unknown; thinking?: string };

/** What Main keeps of one session entry; undefined for what is not part of the conversation. */
export function assistantEntryOf(entry: SessionEntry, attachmentContextKey: Uint8Array): Omit<AssistantEntry, "parentId"> | undefined {
  const base = { entryId: entry.id, at: entry.timestamp };
  if (entry.type === "compaction" || entry.type === "branch_summary") return withText({ ...base, kind: "summary" }, entry.summary);
  if (entry.type === "custom_message") return withText({ ...base, kind: "notice" }, contentText(entry.content));
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown as { role: string } & Record<string, unknown>;
  switch (message.role) {
    case "user": {
      const raw = contentText(message.content as string | Block[]);
      const { text, attachments } = extractDockAttachmentContext(raw, attachmentContextKey);
      const files = attachments?.length ? `\n[attachments: ${attachments.map((attachment) => attachment.name).join(", ")}]` : "";
      return withText({ ...base, kind: "user" }, `${text}${files}`);
    }
    case "assistant": {
      const blocks = Array.isArray(message.content) ? message.content as Block[] : [];
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
      const toolCalls = blocks.filter((block) => block.type === "toolCall" && typeof block.name === "string").slice(0, MAX_ASSISTANT_TOOL_CALLS)
        .map((block) => ({ name: block.name as string, arguments: cut(JSON.stringify(block.arguments ?? {}), MAX_ASSISTANT_TOOL_ARGUMENT_CHARS).text }));
      if (text.length === 0 && toolCalls.length === 0) return undefined;
      return withText({ ...base, kind: "assistant", ...(toolCalls.length === 0 ? {} : { toolCalls }) }, text);
    }
    case "toolResult":
      return withText({ ...base, kind: "tool_result", ...(typeof message.toolName === "string" && message.toolName.length > 0 ? { toolName: message.toolName } : {}) }, contentText(message.content as string | Block[]));
    case "bashExecution":
      return withText({ ...base, kind: "bash" }, `$ ${String(message.command ?? "")}\n${String(message.output ?? "")}`);
    case "custom":
      return withText({ ...base, kind: "notice" }, contentText(message.content as string | Block[]));
    case "branchSummary":
    case "compactionSummary":
      return withText({ ...base, kind: "summary" }, String(message.summary ?? ""));
    default:
      return undefined;
  }
}

function withText<T extends { kind: AssistantEntry["kind"] }>(entry: T & { entryId: string; at: string }, text: string): Omit<AssistantEntry, "parentId"> {
  const kept = cut(text, MAX_ASSISTANT_ENTRY_TEXT_CHARS);
  return { ...entry, text: kept.text, ...(kept.cut ? { truncated: true as const } : {}) } as Omit<AssistantEntry, "parentId">;
}

function contentText(content: string | readonly Block[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.type === "text" ? block.text ?? "" : block.type === "image" ? "[image]" : "").filter((part) => part.length > 0).join("\n");
}

/** Cuts at a character boundary so no half of a surrogate pair is left. */
function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

function where(session: AssistantSessionInfo): string {
  return [session.name ? `"${session.name}"` : undefined, session.cwd, session.machine].filter((part) => part !== undefined).join(" · ");
}

const SPEAKERS: Record<AssistantEntry["kind"], string> = {
  user: "user", assistant: "you", tool_result: "tool result", bash: "shell command", summary: "summary", notice: "notice",
};

function renderSearch(result: AssistantSearchResult): string {
  if (result.hits.length === 0) return "Nothing found. Try other words, fewer words, or a wider time range.";
  const lines = result.hits.map((hit, index) => [
    `${index + 1}. ${hit.at} · ${SPEAKERS[hit.kind]} · ${where(hit.session)}`,
    `   sessionId=${hit.session.sessionId} entryId=${hit.entryId}`,
    `   ${hit.snippet}`,
  ].join("\n"));
  return [
    `Found ${result.hits.length} entr${result.hits.length === 1 ? "y" : "ies"}, newest first:`,
    ...lines,
    ...(result.nextCursor === undefined ? [] : [`Older results remain; search again with cursor "${result.nextCursor}".`]),
  ].join("\n");
}

function renderContext(result: AssistantContextResult, target: string): string {
  const header = [`Conversation ${where(result.session)}`.trim(), ...(result.session.sessionFile ? [`Session file: ${result.session.sessionFile}`] : [])];
  const lines = result.entries.map((entry) => {
    const marker = entry.entryId === target ? "▶ " : "";
    const speaker = entry.kind === "tool_result" && entry.toolName ? `tool result (${entry.toolName})` : SPEAKERS[entry.kind];
    const calls = (entry.toolCalls ?? []).map((call) => `\n   ↳ called ${call.name} ${call.arguments}`).join("");
    const cutNote = entry.truncated ? "\n   [cut here; the whole text is in the session file]" : "";
    return `${marker}[${entry.at}] ${speaker} (entryId=${entry.entryId}):\n${entry.text}${calls}${cutNote}`;
  });
  return [
    ...header,
    ...(result.hasBefore ? ["(earlier entries exist; read again with a larger before)"] : []),
    ...lines,
    ...(result.hasAfter ? ["(later entries exist; read again with a larger after)"] : []),
  ].join("\n\n");
}
