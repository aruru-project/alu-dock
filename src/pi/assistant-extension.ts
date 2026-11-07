import type { ExtensionContext, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  ASSISTANT_CONTEXT_DEFAULT_SPAN,
  ASSISTANT_DOCUMENTS,
  ASSISTANT_MEMORY_STATES,
  ASSISTANT_MEMORY_TOPICS,
  ASSISTANT_TOOL_NAMES,
  MAX_ASSISTANT_CONTEXT_SPAN,
  MAX_ASSISTANT_ID_CHARS,
  MAX_ASSISTANT_NAME_CHARS,
  MAX_ASSISTANT_ENTRY_TEXT_CHARS,
  MAX_ASSISTANT_MEMORY_CHARS,
  MAX_ASSISTANT_MEMORY_SOURCES,
  MAX_ASSISTANT_QUERY_CHARS,
  MAX_ASSISTANT_RECORD_BATCH_BYTES,
  MAX_ASSISTANT_SEARCH_LIMIT,
  MAX_ASSISTANT_TOOL_ARGUMENT_CHARS,
  MAX_ASSISTANT_TOOL_CALLS,
  type AssistantContextResult,
  type AssistantDocument,
  type AssistantDocumentName,
  type AssistantEntry,
  type AssistantExtractionStatus,
  type AssistantMemory,
  type AssistantMemoryDetail,
  type AssistantMemoryList,
  type AssistantMemoryState,
  type AssistantMemoryTopic,
  type AssistantPreview,
  type AssistantRequest,
  type AssistantResultFor,
  type AssistantSearchResult,
  type AssistantSessionInfo,
  type AssistantSettings,
} from "../core/assistant.js";
import { extractDockAttachmentContext } from "./dock-attachment-context.js";
import { WorkerUiLifecycleCancelledError } from "./worker-extension-ui.js";

/*
 * What makes a Pi Work the personal assistant (card #295). Each session start (new Work, reload,
 * /new, resume, reopen) loads her persona, the owner's notes, the memories loaded every session and
 * how to recall more from Main into a prompt section; the session keeps that copy until it starts
 * again. Her conversation goes to Main entry by entry, and her tools search her memories and
 * conversations, read around a hit, change her memories, and edit her persona and the owner's notes.
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
/** Tool arguments kept of an entry that would not fit one batch otherwise. */
const SQUEEZED_ARGUMENT_CHARS = 200;

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: MAX_ASSISTANT_QUERY_CHARS, description: "Keywords separated by spaces; every one must occur. Chinese works; try other wording when nothing is found. Omit it with from or to to list everything said in that time." },
    from: { type: "string", description: "Earliest time, as YYYY-MM-DD (the local day) or an ISO time." },
    to: { type: "string", description: "Latest time, as YYYY-MM-DD (including that day) or an ISO time." },
    cursor: { type: "string", description: "The cursor an earlier search returned, to read older results." },
    limit: { type: "integer", minimum: 1, maximum: MAX_ASSISTANT_SEARCH_LIMIT },
  },
  additionalProperties: false,
};
const READ_SCHEMA = {
  type: "object",
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: MAX_ASSISTANT_ID_CHARS },
    entryId: { type: "string", minLength: 1, maxLength: MAX_ASSISTANT_ID_CHARS },
    before: { type: "integer", minimum: 0, maximum: MAX_ASSISTANT_CONTEXT_SPAN, description: `Entries before it; default ${ASSISTANT_CONTEXT_DEFAULT_SPAN}.` },
    after: { type: "integer", minimum: 0, maximum: MAX_ASSISTANT_CONTEXT_SPAN, description: `Entries after it; default ${ASSISTANT_CONTEXT_DEFAULT_SPAN}.` },
  },
  required: ["sessionId", "entryId"],
  additionalProperties: false,
};
const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["add", "rewrite", "retire", "forget", "restore", "resident", "get", "list", "settings", "set_model"] },
    id: { type: "string", description: "The memory's number, as in #12 (without #); for every action but add and list." },
    topic: { type: "string", enum: [...ASSISTANT_MEMORY_TOPICS], description: "owner: who your owner is. preferences: what they like and how they want things. relationship: how the two of you get on. events: things you went through, with the day. self: what you decided about yourself. For add; rewrite may move a memory; list may filter by it." },
    text: { type: "string", maxLength: MAX_ASSISTANT_MEMORY_CHARS, description: "add and rewrite: one thing, as a sentence that makes sense on its own." },
    resident: { type: "boolean", description: "add and resident: true to have it loaded at the start of every session; keep that for what matters in every conversation." },
    sources: {
      type: "array", maxItems: MAX_ASSISTANT_MEMORY_SOURCES,
      items: { type: "object", properties: { sessionId: { type: "string" }, entryId: { type: "string" } }, required: ["sessionId", "entryId"], additionalProperties: false },
      description: "add: where it was said, as sessionId and entryId from assistant_search.",
    },
    state: { type: "string", enum: [...ASSISTANT_MEMORY_STATES], description: "list: active (default), retired, or forgotten." },
    model: { type: "string", description: "set_model: the model that keeps your memories, as provider/model-id from Main's model list, or none to stop." },
  },
  required: ["action"],
  additionalProperties: false,
};
const DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    document: { type: "string", enum: [...ASSISTANT_DOCUMENTS], description: "persona: who you are. notes: the facts and rules your owner wrote by hand." },
    action: { type: "string", enum: ["read", "write", "edit"] },
    text: { type: "string", description: "write: the whole new text." },
    oldText: { type: "string", description: "edit: an exact passage that occurs once." },
    newText: { type: "string", description: "edit: what replaces it." },
  },
  required: ["document", "action"],
  additionalProperties: false,
};

type Notify = (message: string) => void;

/**
 * Where each session this Worker has had became hers, set the first time the Worker sees it: a
 * session it started (a new Work, /new, or one it reopened) is hers from its first entry (null); one
 * resumed or forked into it, from after its last entry then, since what came before was not hers or
 * is kept under the session it came from. Later visits (reload, switching away and back) keep the
 * first answer. Held for this Worker's life: after a Host restart the new Worker sees a session
 * afresh, and one Main never recorded is then recorded from its start.
 */
const sessionStarts = new Map<string, string | null>();

/**
 * What one session loaded from Main. Its first run asks and waits; when that fails, later runs go on
 * without her and ask again in the background. It asks at the first run rather than at session start,
 * because a reload or a new session cancels the Work's questions still open while it is replaced.
 */
class SessionLoad {
  loaded: AssistantPreview | undefined;
  failure: Error | undefined;
  private pending: Promise<void> | undefined;
  private told = false;

  constructor(private readonly port: AssistantCallPort) {}

  private start(): Promise<void> {
    this.pending ??= this.port.call({ op: "load" }).then(
      (preview) => { this.loaded = preview; this.failure = undefined; },
      (error: unknown) => { this.failure = error instanceof Error ? error : new Error(String(error)); },
    ).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async section(notify: Notify): Promise<string> {
    if (!this.loaded && !this.failure) await this.start();
    if (this.loaded) return this.loaded.text;
    // Try again in the background; this run goes on without her and the owner is told once.
    void this.start();
    if (!this.told) {
      this.told = true;
      notify(`这一轮没能从 Main 载入助手的人设和设定（${this.failure?.message ?? "原因不明"}）。她这一轮不知道你写给她的设定；Main 恢复后，之后的回合会自动载入。`);
    }
    return `You are the owner's personal assistant, but your persona and notes could not be loaded from Main just now (${this.failure?.message ?? "unknown reason"}). Say so if it matters, and do not make them up.`;
  }
}

export function assistantExtension(port: AssistantCallPort, attachmentContextKey: Uint8Array): ExtensionFactory {
  return (pi) => {
    let load: SessionLoad | undefined;
    let recorder: SessionRecorder | undefined;

    pi.on("session_start", (event, ctx) => {
      load = new SessionLoad(port);
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionStarts.has(sessionId)) {
        sessionStarts.set(sessionId, event.reason === "resume" || event.reason === "fork" ? ctx.sessionManager.getEntries().at(-1)?.id ?? null : null);
      }
      // Like loading, catching up waits for the first run, after any replacement has finished.
      recorder = new SessionRecorder(port, ctx.sessionManager, attachmentContextKey, sessionStarts.get(sessionId) ?? undefined,
        (message) => ctx.ui.notify(message, "warning"));
      const collision = pi.getAllTools().find((tool) => OWN_TOOLS.has(tool.name) && tool.sourceInfo.path !== EXTENSION_PATH);
      if (collision) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => !OWN_TOOLS.has(name)));
        ctx.ui.notify(`另一个扩展也提供了 ${collision.name}，所以这个会话里助手不能搜记忆、读以前的对话或改设定。停用那个扩展后执行 /reload 即可恢复。`, "error");
      }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      load ??= new SessionLoad(port);
      void recorder?.sync();
      event.systemPromptOptions.sections[SECTION] = await load.section((message) => ctx.ui.notify(message, "warning"));
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
      description: "Search what you remember and your past conversations with your owner, by keywords, time, or both. Memories whose text has every keyword come first; then what was said, newest first. Each hit names its sessionId and entryId; use assistant_read to see what was said around it. When nothing is found, try other words before saying you do not remember.",
      parameters: SEARCH_SCHEMA,
      execute: async (_id: string, params: { query?: string; from?: string; to?: string; cursor?: string; limit?: number }) => {
        const query = params.query?.trim();
        // Memories on the first page of a keyword search; the cursor pages through what was said.
        const memories = query && params.cursor === undefined ? await port.call({ op: "memory_list", query, limit: 10 }) : undefined;
        const result = await port.call({ op: "search", ...optional("query", params.query), ...optional("from", params.from), ...optional("to", params.to), ...optional("cursor", params.cursor), limit: params.limit ?? 10 });
        return { content: [{ type: "text", text: [...(memories ? [renderMemories(memories, "Memories")] : []), renderSearch(result)].join("\n\n") }], details: { ...result, ...(memories ? { memories: memories.memories } : {}) } };
      },
    } as never);

    pi.registerTool({
      name: "assistant_read",
      label: "Read past conversation",
      description: "Read what was said around one entry of a past conversation, including the tools called and what they returned. Use the sessionId and entryId from assistant_search.",
      parameters: READ_SCHEMA,
      execute: async (_id: string, params: { sessionId: string; entryId: string; before?: number; after?: number }) => {
        const result = await port.call({ op: "context", sessionId: params.sessionId, entryId: params.entryId, before: params.before ?? ASSISTANT_CONTEXT_DEFAULT_SPAN, after: params.after ?? ASSISTANT_CONTEXT_DEFAULT_SPAN });
        return { content: [{ type: "text", text: renderContext(result, params.entryId) }], details: result };
      },
    } as never);

    pi.registerTool({
      name: "assistant_memory",
      label: "Memories",
      description: "Your memories of your owner and the two of you. add: remember something new. rewrite: correct what a memory says. retire: set aside one that is no longer true. forget: forget one when your owner asks; the words it came from are not found by searches either. restore: bring back a retired or forgotten one. resident: whether it is loaded at the start of every session. get: one memory with where it came from and how it changed. list: memories by topic or state, newest first. settings: which model keeps your memories in the background and how that is going. set_model: change that model when your owner asks. Use it when your owner asks you to remember or forget something, or when something is clearly worth remembering. Changes apply to sessions that start later; this session already knows.",
      parameters: MEMORY_SCHEMA,
      execute: async (_id: string, params: { action: string; id?: string; topic?: AssistantMemoryTopic; text?: string; resident?: boolean; sources?: Array<{ sessionId: string; entryId: string }>; state?: AssistantMemoryState; model?: string }, _signal: unknown, _update: unknown, ctx: ExtensionContext) => {
        const needId = (): string => {
          if (params.id === undefined) throw new Error(`${params.action} needs the memory's id.`);
          return params.id.replace(/^#/u, "");
        };
        const current = async (): Promise<AssistantMemory> => (await port.call({ op: "memory_get", id: needId() })).memory;
        if (params.action === "settings" || params.action === "set_model") {
          let settings: AssistantSettings;
          if (params.action === "set_model") {
            const named = params.model?.trim();
            if (!named) throw new Error("set_model needs model: provider/model-id, or none.");
            const slash = named.indexOf("/");
            if (named !== "none" && (slash <= 0 || slash === named.length - 1)) throw new Error("model must be provider/model-id, or none.");
            settings = await port.call({ op: "settings_set", extractionModel: named === "none" ? null : { provider: named.slice(0, slash), id: named.slice(slash + 1) } });
          } else settings = await port.call({ op: "settings_get" });
          const { extraction } = await port.call({ op: "info" });
          return { content: [{ type: "text", text: renderSettings(settings, extraction) }], details: { settings, extraction } };
        }
        if (params.action === "list") {
          const list = await port.call({ op: "memory_list", ...(params.topic === undefined ? {} : { topic: params.topic }), ...(params.state === undefined ? {} : { state: params.state }), limit: 50 });
          return { content: [{ type: "text", text: renderMemories(list, params.state === undefined || params.state === "active" ? "Memories in use" : `${params.state} memories`) }], details: list };
        }
        if (params.action === "get") {
          const detail = await port.call({ op: "memory_get", id: needId() });
          return { content: [{ type: "text", text: renderMemoryDetail(detail) }], details: detail };
        }
        let memory: AssistantMemory;
        if (params.action === "add") {
          if (params.topic === undefined || params.text === undefined) throw new Error("add needs topic and text.");
          const add = { op: "memory_add" as const, topic: params.topic, text: params.text, resident: params.resident ?? false };
          if (params.sources?.length) memory = await port.call({ ...add, sources: params.sources });
          else {
            // Said here: the owner's latest words in this session, once they reached Main, are where it came from.
            await recorder?.sync();
            const said = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && (entry.message as { role?: string }).role === "user");
            memory = said === undefined
              ? await port.call(add)
              : await port.call({ ...add, sources: [{ sessionId: ctx.sessionManager.getSessionId(), entryId: said.id }] })
                .catch(() => port.call(add));
          }
        } else {
          const before = await current();
          const change = params.action === "rewrite" ? { ...(params.text === undefined ? {} : { text: params.text }), ...(params.topic === undefined ? {} : { topic: params.topic }) }
            : params.action === "retire" ? { state: "retired" as const }
            : params.action === "forget" ? { state: "forgotten" as const }
            : params.action === "restore" ? { state: "active" as const }
            : params.action === "resident" ? (params.resident === undefined ? {} : { resident: params.resident })
            : undefined;
          if (change === undefined) throw new Error(`Unknown action ${params.action}.`);
          if (Object.keys(change).length === 0) throw new Error(params.action === "rewrite" ? "rewrite needs text or topic." : "resident needs resident: true or false.");
          memory = await port.call({ op: "memory_update", id: before.id, revision: before.revision, ...change });
        }
        return { content: [{ type: "text", text: `Done: ${renderMemory(memory)}\nSessions that start from now on load it as it is now.` }], details: memory };
      },
    } as never);

    pi.registerTool({
      name: "assistant_document",
      label: "Persona and notes",
      description: "Read or change your persona (who you are) or the notes your owner wrote by hand (facts and rules that win over anything else). write replaces the whole text; edit replaces one exact passage. Changes apply to sessions that start later; this session already knows what you changed.",
      parameters: DOCUMENT_SCHEMA,
      execute: async (_id: string, params: { document: AssistantDocumentName; action: "read" | "write" | "edit"; text?: string; oldText?: string; newText?: string }) => {
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
export class SessionRecorder {
  private through: string | undefined;
  private known = false;
  private running: Promise<void> | undefined;
  private again = false;
  private told = false;

  /**
   * `startAfter`: when Main has not recorded this session, it starts after this entry instead of from
   * its first. It is fixed when the session came in, so entries written while Main was away are kept.
   */
  constructor(
    private readonly port: AssistantCallPort,
    private readonly session: ReadonlySessionManager,
    private readonly attachmentContextKey: Uint8Array,
    private readonly startAfter: string | undefined,
    private readonly notify: Notify,
  ) {}

  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do { this.again = false; await this.once(); } while (this.again);
      this.told = false;
    })().catch((error: unknown) => {
      // The next run or session start catches up; the owner hears once until it does. A question the
      // Work's own session replacement cancelled is not a failure to report.
      if (this.told || error instanceof WorkerUiLifecycleCancelledError) return;
      this.told = true;
      this.notify(`刚才的对话还没记进助手的记忆（${error instanceof Error ? error.message : String(error)}）。连上 Main 后会自动补记，不用重发。`);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async once(): Promise<void> {
    const sessionId = this.session.getSessionId();
    const entries = this.session.getEntries();
    if (!this.known) {
      this.through = (await this.port.call({ op: "recorded", sessionId })).lastEntryId;
      if (this.through === undefined && this.startAfter !== undefined) {
        await this.port.call({ op: "record", session: this.sessionInfo(sessionId), entries: [], throughEntryId: this.startAfter });
        this.through = this.startAfter;
      }
      this.known = true;
    }
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
    const session = this.sessionInfo(sessionId);
    // The batch is a JSON array: its brackets, and a comma before every entry but the first.
    let batch: AssistantEntry[] = [];
    let bytes = 2;
    const send = async (throughEntryId: string) => {
      await this.port.call({ op: "record", session, entries: batch, throughEntryId });
      this.through = throughEntryId;
      batch = [];
      bytes = 2;
    };
    for (const [index, entry] of pending.entries()) {
      const mapped = keeps(entry) ? assistantEntryOf(entry, this.attachmentContextKey) : undefined;
      if (!mapped) continue;
      const parentId = parentOf(entry);
      const item = fitBatch(parentId === undefined ? mapped : { ...mapped, parentId });
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (batch.length > 0 ? 1 : 0);
      if (batch.length > 0 && bytes + size > MAX_ASSISTANT_RECORD_BATCH_BYTES) await send(pending[index - 1]!.id);
      bytes += Buffer.byteLength(JSON.stringify(item), "utf8") + (batch.length > 0 ? 1 : 0);
      batch.push(item);
    }
    await send(pending.at(-1)!.id);
  }

  private sessionInfo(sessionId: string) {
    const sessionFile = this.session.getSessionFile();
    const name = this.session.getSessionName();
    return { sessionId, ...(sessionFile === undefined ? {} : { sessionFile }), cwd: this.session.getCwd(), ...(name === undefined ? {} : { name: cut(name, MAX_ASSISTANT_NAME_CHARS).text }) };
  }
}

/** An entry with many long tool calls keeps a shorter part of each, so it fits one batch alone. */
function fitBatch(entry: AssistantEntry): AssistantEntry {
  if (Buffer.byteLength(JSON.stringify(entry), "utf8") + 2 <= MAX_ASSISTANT_RECORD_BATCH_BYTES || entry.toolCalls === undefined) return entry;
  return { ...entry, toolCalls: entry.toolCalls.map((call) => ({ name: cut(call.name, SQUEEZED_ARGUMENT_CHARS).text, arguments: cut(call.arguments, SQUEEZED_ARGUMENT_CHARS).text })), truncated: true };
}

type Block = { type: string; text?: string; name?: string; arguments?: unknown; thinking?: string };

/**
 * What Main keeps of one session entry; undefined for what is not part of the conversation. Her own
 * memory tools keep only what she did (the action), not the words they carried or returned: those
 * live in her memories and conversations already, where forgetting reaches them.
 */
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
        .map((block) => ({ name: block.name as string, arguments: cut(JSON.stringify(OWN_TOOLS.has(block.name as string) ? ownToolAction(block.arguments) : block.arguments ?? {}), MAX_ASSISTANT_TOOL_ARGUMENT_CHARS).text }));
      if (text.length === 0 && toolCalls.length === 0) return undefined;
      return withText({ ...base, kind: "assistant", ...(toolCalls.length === 0 ? {} : { toolCalls }) }, text);
    }
    case "toolResult":
      if (typeof message.toolName === "string" && OWN_TOOLS.has(message.toolName)) return undefined;
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

function ownToolAction(input: unknown): Record<string, unknown> {
  const args = input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
  return Object.fromEntries(["action", "document"].filter((key) => typeof args[key] === "string").map((key) => [key, args[key]]));
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

const STATE_NAMES: Record<AssistantMemoryState, string> = { active: "in use", retired: "retired", forgotten: "forgotten" };

function renderSettings(settings: AssistantSettings, extraction: AssistantExtractionStatus | undefined): string {
  const model = settings.extractionModel;
  return [
    model === undefined ? "No model keeps your memories in the background: nothing is extracted from your conversations until your owner chooses one." : `Your memories are kept with ${model.provider}/${model.id}.`,
    ...(extraction === undefined ? [] : [
      `Now: ${extraction.state}; ${extraction.waitingSessions} conversation(s) have something new not read yet.`,
      ...(extraction.lastRunAt === undefined ? [] : [`Last run: ${extraction.lastRunAt}.`]),
      ...(extraction.lastError === undefined ? [] : [`Problem: ${extraction.lastError}`]),
      ...(extraction.retryAt === undefined ? [] : [`Next try: ${extraction.retryAt}.`]),
    ]),
  ].join("\n");
}

function renderMemory(memory: AssistantMemory): string {
  const marks = [memory.topic, memory.resident ? "loaded every session" : "found when searched", ...(memory.state === "active" ? [] : [STATE_NAMES[memory.state]])];
  return `#${memory.id} [${marks.join(" · ")}] ${memory.text}`;
}

function renderMemories(list: AssistantMemoryList, title: string): string {
  if (list.memories.length === 0) return `${title}: none.`;
  return [`${title}:`, ...list.memories.map((memory) => `- ${renderMemory(memory)}`), ...(list.nextCursor === undefined ? [] : ["(more exist; narrow by topic or keywords)"])].join("\n");
}

function renderMemoryDetail(detail: AssistantMemoryDetail): string {
  const { memory } = detail;
  return [
    renderMemory(memory),
    `Since ${memory.createdAt}; last changed ${memory.updatedAt} by ${memory.author}.`,
    ...(memory.supersededBy === undefined ? [] : [`Merged into #${memory.supersededBy}.`]),
    memory.sources.length === 0 ? "Where it was said: not recorded." : `Where it was said (${memory.sourceCount}):`,
    ...memory.sources.map((source) => `- ${source.at} sessionId=${source.sessionId} entryId=${source.entryId}`),
    ...(detail.history.length === 0 ? [] : ["Changes, newest first:", ...detail.history.map((change) => `- ${change.at} ${change.author} ${change.action}${change.text === undefined ? "" : `: ${change.text}`}`)]),
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
