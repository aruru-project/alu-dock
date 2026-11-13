import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { getDefaultSystemPromptBody, type ExtensionContext, type ExtensionFactory, type SessionEntry, type SystemPromptSelection } from "@earendil-works/pi-coding-agent";

import {
  ASSISTANT_CONTEXT_DEFAULT_SPAN,
  ASSISTANT_DOCUMENTS,
  ASSISTANT_MEMORY_STATES,
  ASSISTANT_MEMORY_TOPICS,
  ASSISTANT_TOOL_NAMES,
  MAX_ASSISTANT_CONTEXT_SPAN,
  MAX_ASSISTANT_EPISODE_CHARS,
  MAX_ASSISTANT_ID_CHARS,
  MAX_ASSISTANT_NAME_CHARS,
  assistantEntryTextLimit,
  MAX_ASSISTANT_MEMORY_CHARS,
  MAX_ASSISTANT_MEMORY_SOURCES,
  MAX_ASSISTANT_QUERY_CHARS,
  MAX_ASSISTANT_RECORD_BATCH_BYTES,
  MAX_ASSISTANT_SEARCH_LIMIT,
  MAX_ASSISTANT_TIMELINE_LIST_LIMIT,
  MAX_ASSISTANT_TOOL_ARGUMENT_CHARS,
  MAX_ASSISTANT_TOOL_CALLS,
  type AssistantContextResult,
  type AssistantDocument,
  type AssistantDocumentName,
  type AssistantEntry,
  type AssistantEpisode,
  type AssistantEpisodeState,
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
  type AssistantTimelineList,
} from "../core/assistant.js";
import { isDockMessageText } from "../core/dock-tools.js";
import { localSpan } from "../core/local-time.js";
import { extractDockAttachmentContext } from "./dock-attachment-context.js";
import { WATCH_NOTICE_TYPE, WORK_MESSAGE_TYPE, WORK_WAKE_TYPE } from "../worker/dock-tools-client.js";
import { WorkerUiLifecycleCancelledError } from "./worker-extension-ui.js";

/*
 * What makes a Pi Work the personal assistant (card #295). She is the Work's system: each session
 * start (new Work, reload, /new, resume, reopen) loads her persona, the owner's notes, the memories
 * loaded every session and how to recall more from Main into the opening of the system prompt, in
 * place of Pi's "You are an expert coding assistant…"; the session keeps that copy until it starts
 * again. The rest of Pi's default prompt (tools, rules, docs) and the project's context stay. Her conversation goes to Main entry by entry, and her tools search her memories, her
 * timeline and her conversations, read around a hit, change her memories and timeline, and edit her
 * persona and the owner's notes.
 */

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface AssistantCallPort {
  call<R extends AssistantRequest>(request: R): Promise<AssistantResultFor<R>>;
}

const EXTENSION_PATH = "<inline:alu-dock-assistant>";
const OWN_TOOLS = new Set<string>(ASSISTANT_TOOL_NAMES);
/** A Work that is stopping waits this long at most for its last entries to reach Main. */
const SHUTDOWN_SYNC_MS = 1_000;
/** Tool arguments kept of an entry that would not fit one batch otherwise. */
const SQUEEZED_ARGUMENT_CHARS = 200;

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: MAX_ASSISTANT_QUERY_CHARS, description: "Keywords separated by spaces; every one must occur. Chinese works; try other wording when nothing is found. Omit it with from or to to see what you were doing in that time and everything said then." },
    from: { type: "string", description: "Earliest time, as YYYY-MM-DD (the local day) or an ISO time." },
    to: { type: "string", description: "Latest time, as YYYY-MM-DD (including that day) or an ISO time." },
    cursor: { type: "string", description: "The cursor an earlier search returned, to read older results." },
    limit: { type: "integer", minimum: 1, maximum: MAX_ASSISTANT_SEARCH_LIMIT },
  },
  additionalProperties: false,
};
const TIMELINE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "rewrite", "forget", "restore"] },
    id: { type: "string", description: "The line's number, as in #12 (without #); for rewrite, forget and restore." },
    text: { type: "string", maxLength: MAX_ASSISTANT_EPISODE_CHARS, description: "rewrite: what the line should say, in one short sentence." },
    query: { type: "string", maxLength: MAX_ASSISTANT_QUERY_CHARS, description: "list: keywords every line must contain." },
    from: { type: "string", description: "list: earliest time, as YYYY-MM-DD (the local day) or an ISO time." },
    to: { type: "string", description: "list: latest time, as YYYY-MM-DD (including that day) or an ISO time." },
    state: { type: "string", enum: ["active", "forgotten"], description: "list: forgotten to see the lines that were forgotten; default active." },
    cursor: { type: "string", description: "list: the cursor an earlier list returned, to read older lines." },
    limit: { type: "integer", minimum: 1, maximum: MAX_ASSISTANT_TIMELINE_LIST_LIMIT },
  },
  required: ["action"],
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
    action: { type: "string", enum: ["add", "rewrite", "retire", "forget", "restore", "resident", "get", "list", "settings", "set_model", "reorganize"] },
    id: { type: "string", description: "The memory's number, as in #12 (without #); for add, list, settings, set_model and reorganize it is not used." },
    topic: { type: "string", enum: [...ASSISTANT_MEMORY_TOPICS], description: "owner: who your owner is. preferences: what they like and how they want things. relationship: how the two of you get on. events: things you went through, with the day. self: what you decided about yourself. For add; rewrite may move a memory; list may filter by it." },
    text: { type: "string", maxLength: MAX_ASSISTANT_MEMORY_CHARS, description: "add and rewrite: one thing, as a sentence that makes sense on its own." },
    resident: { type: "boolean", description: "add and resident: true to have it loaded at the start of every session; keep that for what matters in every conversation." },
    sources: {
      type: "array", maxItems: MAX_ASSISTANT_MEMORY_SOURCES,
      items: { type: "object", properties: { sessionId: { type: "string" }, entryId: { type: "string" } }, required: ["sessionId", "entryId"], additionalProperties: false },
      description: "add: where it was said, as sessionId and entryId from assistant_search.",
    },
    state: { type: "string", enum: [...ASSISTANT_MEMORY_STATES], description: "list: active (default), retired, or forgotten." },
    query: { type: "string", maxLength: MAX_ASSISTANT_QUERY_CHARS, description: "list: keywords separated by spaces; every one must occur in the memory." },
    cursor: { type: "string", description: "list: the cursor an earlier list returned, to read older memories." },
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

  async text(notify: Notify): Promise<string> {
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

/**
 * An assistant Work's system, whatever was chosen or saved for its directory (2026-11-12, card #295):
 * Pi's default prompt, whose opening the extension below replaces with her. No SYSTEM.md is read.
 */
export function assistantSystemPrompt(): SystemPromptSelection {
  return { kind: "default", body: getDefaultSystemPromptBody() };
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
      // She replaces only the opening; Pi records the change in the session like any prompt change.
      const opening = await load.text((message) => ctx.ui.notify(message, "warning"));
      const options = event.systemPromptOptions;
      options.defaultSystemPromptBody = { ...(options.defaultSystemPromptBody ?? getDefaultSystemPromptBody()), intro: opening };
    });

    // A session whose opening changed after it began (one from before 2026-11-12, one resumed into
    // this Work, or hers again after a reload) keeps its first opening at the head and records the
    // new one as an update, which models that take system messages mid-conversation get after it:
    // the old "coding assistant" or SYSTEM.md would still lead. Her requests lead with her current
    // opening instead, for this request only; the session's records stay as they are. Other prompt
    // and tool updates stay where they are, so switching tools does not resend the conversation.
    pi.on("context_with_system", (event) => {
      const [head, ...rest] = event.messages;
      if (head?.role !== "system" || !rest.some((message) => message.role === "system" && message.sections?.preamble !== undefined)) return undefined;
      const current = getCurrentSystemMessage(event.messages)!;
      const opening = current.sections?.preamble;
      // A head that does not hold its opening as a section (an older session) is merged whole, as Pi
      // does for models that take no updates.
      if (typeof opening !== "string" || head.sections?.preamble === undefined) {
        return { messages: [current, ...event.messages.filter((message) => message.role !== "system")] };
      }
      const messages: typeof event.messages = [{ ...head, sections: { ...head.sections, preamble: opening } }];
      for (const message of rest) {
        if (message.role !== "system" || message.sections?.preamble === undefined) { messages.push(message); continue; }
        const { preamble: _opening, ...sections } = message.sections;
        // An update that only changed the opening has nothing left to say.
        if (message.content.length > 0 || Object.keys(sections).length > 0 || message.toolsAdded?.length || message.toolsRemoved?.length) messages.push({ ...message, sections });
      }
      return { messages };
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
      description: "Search what you remember, your timeline and your past conversations with your owner, by keywords, time, or both. Memories come first: those whose text has every keyword and that were said in the time given; then the timeline (one line per stretch of a conversation saying what the two of you were doing, which is how to answer \"what were we up to that day\"); then what was said, newest first. Each timeline line and each hit names a sessionId and entryId; use assistant_read to see what was said there. When nothing is found, try other words before saying you do not remember.",
      parameters: SEARCH_SCHEMA,
      execute: async (_id: string, params: { query?: string; from?: string; to?: string; cursor?: string; limit?: number }) => {
        const query = params.query?.trim();
        const firstPage = params.cursor === undefined;
        // Memories and the timeline on the first page, under the same words and time; the cursor pages through what was said.
        const [result, memories, timeline] = await Promise.all([
          port.call({ op: "search", ...optional("query", params.query), ...optional("from", params.from), ...optional("to", params.to), ...optional("cursor", params.cursor), limit: params.limit ?? 10 }),
          firstPage && (query || params.from !== undefined || params.to !== undefined)
            ? port.call({ op: "memory_list", ...(query ? { query } : {}), ...optional("from", params.from), ...optional("to", params.to), limit: 10 })
            : undefined,
          firstPage
            ? port.call({ op: "timeline_list", ...(query ? { query } : {}), ...optional("from", params.from), ...optional("to", params.to), limit: query ? 10 : 20 })
            : undefined,
        ]);
        const moreMemories = "(more exist; assistant_memory list with query reads them all)";
        const text = [...(memories ? [renderMemories(memories, query ? "Memories" : "Memories said then", moreMemories)] : []), ...(timeline ? [renderTimeline(timeline)] : []), renderSearch(result)].join("\n\n");
        return { content: [{ type: "text", text }], details: { ...result, ...(memories ? { memories: memories.memories } : {}), ...(timeline ? { episodes: timeline.episodes } : {}) } };
      },
    } as never);

    pi.registerTool({
      name: "assistant_timeline",
      label: "Timeline",
      description: "Your timeline: one line per stretch of a conversation saying what you and your owner were doing or talking about, written in the background as conversations are read. list: the lines of a time range or with keywords, newest first. rewrite: correct what a line says. forget: drop a line your owner does not want kept (what was said stays). restore: bring a forgotten line back. Use it when your owner says a line is wrong or should not be there; to look things up, assistant_search already shows the timeline.",
      parameters: TIMELINE_SCHEMA,
      execute: async (_id: string, params: { action: string; id?: string; text?: string; query?: string; from?: string; to?: string; state?: AssistantEpisodeState; cursor?: string; limit?: number }) => {
        if (params.action === "list") {
          const query = params.query?.trim();
          const list = await port.call({ op: "timeline_list", ...(query ? { query } : {}), ...optional("from", params.from), ...optional("to", params.to), ...(params.state === undefined ? {} : { state: params.state }), ...optional("cursor", params.cursor), limit: params.limit ?? 20 });
          return { content: [{ type: "text", text: renderTimeline(list) }], details: list };
        }
        if (params.id === undefined) throw new Error(`${params.action} needs the line's id.`);
        const before = await port.call({ op: "timeline_get", id: params.id.replace(/^#/u, "") });
        const change = params.action === "rewrite" ? (params.text === undefined ? undefined : { text: params.text })
          : params.action === "forget" ? { state: "forgotten" as const }
          : params.action === "restore" ? { state: "active" as const }
          : undefined;
        if (change === undefined) throw new Error(params.action === "rewrite" ? "rewrite needs text." : `Unknown action ${params.action}.`);
        const episode = await port.call({ op: "timeline_update", id: before.id, revision: before.revision, ...change });
        return { content: [{ type: "text", text: `Done: ${renderEpisode(episode)}\nSessions that start from now on see it as it is now.` }], details: episode };
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
      description: "Your memories of your owner and the two of you. add: remember something new. rewrite: correct what a memory says. retire: set aside one that is no longer true; the background will not record it again from what was said before. forget: forget one when your owner asks; the words it came from, what was said in answer to them and the request to forget it are not found by searches either, the timeline lines covering them are forgotten with it, and the background will not record it again. Other places that happen to mention the same thing stay as they are. restore: bring back a retired or forgotten one, with everything that went with it. resident: whether it is loaded at the start of every session. get: one memory with where it came from and how it changed. list: memories by topic, state or keywords, newest first. settings: which model keeps your memories in the background and how that is going. set_model: change that model when your owner asks. reorganize: start over with the chosen model when your owner asks: what the background made and nobody touched is set aside (each can be restored), the timeline it wrote is cleared, and every conversation is read again; your owner is asked to confirm first. Use this tool when your owner asks you to remember or forget something, or when something is clearly worth remembering. Changes apply to sessions that start later; this session already knows.",
      parameters: MEMORY_SCHEMA,
      execute: async (_id: string, params: { action: string; id?: string; topic?: AssistantMemoryTopic; text?: string; resident?: boolean; sources?: Array<{ sessionId: string; entryId: string }>; state?: AssistantMemoryState; query?: string; cursor?: string; model?: string }, _signal: unknown, _update: unknown, ctx: ExtensionContext) => {
        /** The owner's latest words in this session, once they reached Main: where a memory said here came from, or where he asked for a change. */
        const saidHere = async (): Promise<{ sessionId: string; entryId: string } | undefined> => {
          await recorder?.sync();
          const said = ctx.sessionManager.getBranch().findLast((entry) => ownerSpoke(entry, attachmentContextKey));
          return said === undefined ? undefined : { sessionId: ctx.sessionManager.getSessionId(), entryId: said.id };
        };
        const needId = (): string => {
          if (params.id === undefined) throw new Error(`${params.action} needs the memory's id.`);
          return params.id.replace(/^#/u, "");
        };
        const current = async (): Promise<AssistantMemory> => (await port.call({ op: "memory_get", id: needId() })).memory;
        // A name Main's model list does not have would only fail later, in the background.
        const known = (model: { provider: string; id: string }): void => {
          if (!ctx.modelRegistry.find(model.provider, model.id)) throw new Error(`${model.provider}/${model.id} is not a model Main can use now. Give the exact provider/model-id of one in this Work's model list.`);
        };
        if (params.action === "settings" || params.action === "set_model") {
          let settings: AssistantSettings;
          if (params.action === "set_model") {
            const named = params.model?.trim();
            if (!named) throw new Error("set_model needs model: provider/model-id, or none.");
            const slash = named.indexOf("/");
            if (named !== "none" && (slash <= 0 || slash === named.length - 1)) throw new Error("model must be provider/model-id, or none.");
            const chosen = named === "none" ? null : { provider: named.slice(0, slash), id: named.slice(slash + 1) };
            if (chosen) known(chosen);
            settings = await port.call({ op: "settings_set", extractionModel: chosen });
          } else settings = await port.call({ op: "settings_get" });
          const { extraction } = await port.call({ op: "info" });
          return { content: [{ type: "text", text: renderSettings(settings, extraction) }], details: { settings, extraction } };
        }
        if (params.action === "reorganize") {
          const { extractionModel } = await port.call({ op: "settings_get" });
          if (!extractionModel) throw new Error("No model keeps your memories yet. Ask your owner which one to use, set it with set_model, then start over.");
          known(extractionModel);
          // Starting over sets aside what the background made: the owner says yes first, as in the client.
          if (!ctx.hasUI) throw new Error("Starting over needs your owner's confirmation, and there is nowhere to ask for it here. Ask them to do it in the assistant's settings.");
          const confirmed = await ctx.ui.confirm("从头整理记忆？", `助手会用 ${extractionModel.provider}/${extractionModel.id} 把所有对话从头读一遍：后台整理出、没人改过的记忆挪进「已作废」（可以逐条恢复），后台写的时间线清掉重写；你写过、改过的，和她按你吩咐记下的都留着。读完之前，新开的会话里记忆不全；花费大致等于当初整理这些对话的总和。`);
          if (!confirmed) return { content: [{ type: "text", text: "Your owner did not confirm. Nothing was changed." }], details: { confirmed: false } };
          const result = await port.call({ op: "reorganize", extractionModel });
          return {
            content: [{ type: "text", text: `Started over with ${result.extractionModel.provider}/${result.extractionModel.id}: ${result.retiredMemories} memor${result.retiredMemories === 1 ? "y" : "ies"} the background made were set aside among the retired, ${result.removedLines} timeline line(s) it wrote were cleared, and every conversation is being read again. Until that is done, sessions that start load fewer memories.` }],
            details: { confirmed: true, ...result },
          };
        }
        if (params.action === "list") {
          const query = params.query?.trim();
          const list = await port.call({ op: "memory_list", ...(params.topic === undefined ? {} : { topic: params.topic }), ...(params.state === undefined ? {} : { state: params.state }), ...(query ? { query } : {}), ...optional("cursor", params.cursor), limit: 50 });
          const more = list.nextCursor === undefined ? "" : `Older memories remain; list again with cursor "${list.nextCursor}".`;
          return { content: [{ type: "text", text: renderMemories(list, params.state === undefined || params.state === "active" ? "Memories in use" : `${params.state} memories`, more) }], details: list };
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
            // Said here: the owner's latest words in this session are where it came from.
            const said = await saidHere();
            memory = said === undefined
              ? await port.call(add)
              : await port.call({ ...add, sources: [said] }).catch(() => port.call(add));
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
          // Forgetting also forgets the exchange it was asked in, which tells the same thing.
          const askedAt = params.action === "forget" ? await saidHere() : undefined;
          memory = await port.call({ op: "memory_update", id: before.id, revision: before.revision, ...change, ...(askedAt ? { askedAt } : {}) });
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

/**
 * An entry with many long tool calls keeps a shorter part of each, so it fits one batch alone; text
 * so full of characters JSON must escape that it still does not fit keeps what does.
 */
function fitBatch(entry: AssistantEntry): AssistantEntry {
  const fits = (item: AssistantEntry) => Buffer.byteLength(JSON.stringify(item), "utf8") + 2 <= MAX_ASSISTANT_RECORD_BATCH_BYTES;
  if (fits(entry)) return entry;
  let fitted: AssistantEntry = entry.toolCalls === undefined ? entry
    : { ...entry, toolCalls: entry.toolCalls.map((call) => ({ name: cut(call.name, SQUEEZED_ARGUMENT_CHARS).text, arguments: cut(call.arguments, SQUEEZED_ARGUMENT_CHARS).text })), truncated: true };
  while (!fits(fitted) && fitted.text.length > 0) fitted = { ...fitted, text: cut(fitted.text, Math.floor(fitted.text.length * 0.9)).text, truncated: true };
  return fitted;
}

type Block = { type: string; text?: string; name?: string; arguments?: unknown; thinking?: string };

/** Extension messages in which another Work speaks to this one (card #666). */
const WORK_SPEAKS = new Set<string>([WORK_MESSAGE_TYPE, WATCH_NOTICE_TYPE]);

/** An extension message: another Work's words, or another notice; undefined for the marker that only starts a turn. */
function extensionEntry(base: { entryId: string; at: string }, customType: unknown, content: string | readonly Block[] | undefined): Omit<AssistantEntry, "parentId"> | undefined {
  if (customType === WORK_WAKE_TYPE) return undefined;
  return withText({ ...base, kind: typeof customType === "string" && WORK_SPEAKS.has(customType) ? "work" : "notice" }, contentText(content));
}

/**
 * What Main keeps of one session entry; undefined for what is not part of the conversation. Her own
 * memory tools keep only what she did (the action), not the words they carried or returned: those
 * live in her memories and conversations already, where forgetting reaches them. What another Work
 * says to her is kept as its words, never as the owner's.
 */
export function assistantEntryOf(entry: SessionEntry, attachmentContextKey: Uint8Array): Omit<AssistantEntry, "parentId"> | undefined {
  const base = { entryId: entry.id, at: entry.timestamp };
  if (entry.type === "compaction" || entry.type === "branch_summary") return withText({ ...base, kind: "summary" }, entry.summary);
  if (entry.type === "custom_message") return extensionEntry(base, entry.customType, entry.content as string | Block[]);
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown as { role: string } & Record<string, unknown>;
  switch (message.role) {
    case "user": {
      const raw = contentText(message.content as string | Block[]);
      const { text, attachments } = extractDockAttachmentContext(raw, attachmentContextKey);
      const files = attachments?.length ? `\n[attachments: ${attachments.map((attachment) => attachment.name).join(", ")}]` : "";
      // Another Work's message delivered into her input, as dock_send between top-level Works does.
      return withText({ ...base, kind: isDockMessageText(text) ? "work" : "user" }, `${text}${files}`);
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
      return extensionEntry(base, message.customType, message.content as string | Block[]);
    case "branchSummary":
    case "compactionSummary":
      return withText({ ...base, kind: "summary" }, String(message.summary ?? ""));
    default:
      return undefined;
  }
}

/** Whether this session entry is the owner speaking: his own message, not one another Work sent into her input. */
function ownerSpoke(entry: SessionEntry, attachmentContextKey: Uint8Array): boolean {
  return assistantEntryOf(entry, attachmentContextKey)?.kind === "user";
}

function ownToolAction(input: unknown): Record<string, unknown> {
  const args = input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
  return Object.fromEntries(["action", "document"].filter((key) => typeof args[key] === "string").map((key) => [key, args[key]]));
}

function withText<T extends { kind: AssistantEntry["kind"] }>(entry: T & { entryId: string; at: string }, text: string): Omit<AssistantEntry, "parentId"> {
  const kept = cut(text, assistantEntryTextLimit(entry.kind));
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
  user: "user", assistant: "you", tool_result: "tool result", bash: "shell command", summary: "summary", notice: "notice", work: "another Work",
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

function renderEpisode(episode: AssistantEpisode): string {
  const place = where(episode.session);
  return [
    `#${episode.id} ${localSpan(new Date(episode.fromAt), new Date(episode.toAt))}${place ? ` · ${place}` : ""}${episode.state === "active" ? "" : " · forgotten"}: ${episode.text}`,
    `   starts at sessionId=${episode.session.sessionId} entryId=${episode.entryId}`,
  ].join("\n");
}

function renderTimeline(list: AssistantTimelineList): string {
  if (list.episodes.length === 0) return "Timeline: no line covers this.";
  return [
    "Timeline, newest first (what the two of you were doing; local time):",
    ...list.episodes.map((episode) => `- ${renderEpisode(episode)}`),
    ...(list.nextCursor === undefined ? [] : [`Older lines remain; list them with assistant_timeline and cursor "${list.nextCursor}".`]),
  ].join("\n");
}

function renderSettings(settings: AssistantSettings, extraction: AssistantExtractionStatus | undefined): string {
  const model = settings.extractionModel;
  return [
    model === undefined ? "No model keeps your memories in the background: nothing is extracted from your conversations until your owner chooses one." : `Your memories are kept with ${model.provider}/${model.id}.`,
    ...(extraction === undefined ? [] : [
      `Now: ${extraction.state}; ${extraction.waitingSessions} conversation(s) have something new not read yet.`,
      ...(extraction.skippedParts ? [`${extraction.skippedParts} part(s) of conversations could not be read with this model and were passed over; another model, or starting over, reads them again.`] : []),
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

/** `more`: what to say when the list goes on past this page. */
function renderMemories(list: AssistantMemoryList, title: string, more: string): string {
  if (list.memories.length === 0) return `${title}: none.`;
  return [`${title}:`, ...list.memories.map((memory) => `- ${renderMemory(memory)}`), ...(list.nextCursor === undefined ? [] : [more])].join("\n");
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
