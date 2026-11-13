import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import {
  ASSISTANT_CONTEXT_DEFAULT_SPAN,
  ASSISTANT_DOCUMENTS,
  ASSISTANT_MEMORY_STATES,
  ASSISTANT_MEMORY_TOPICS,
  MAX_ASSISTANT_CONTEXT_SPAN,
  MAX_ASSISTANT_EPISODE_CHARS,
  MAX_ASSISTANT_ID_CHARS,
  MAX_ASSISTANT_MEMORY_CHARS,
  MAX_ASSISTANT_MEMORY_SOURCES,
  MAX_ASSISTANT_QUERY_CHARS,
  MAX_ASSISTANT_SEARCH_LIMIT,
  MAX_ASSISTANT_TIMELINE_LIST_LIMIT,
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
  type AssistantSearchResult,
  type AssistantSessionInfo,
  type AssistantSettings,
  type AssistantTimelineList,
} from "../core/assistant.js";
import { localSpan } from "../core/local-time.js";
import { ownerSpoke, type AssistantCallPort, type SessionRecorder } from "./recorder.js";

/*
 * Her own tools: search her memories, her timeline and her conversations, read around a hit, change
 * her memories and timeline, and edit her persona and the owner's notes. All of it lives on Main;
 * these only ask.
 */

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

export interface MemoryToolsContext {
  port: AssistantCallPort;
  session: Pick<SessionManager, "getBranch" | "getSessionId">;
  recorder: SessionRecorder;
  models: Pick<ModelRuntime, "getModel">;
  attachmentContextKey: Uint8Array;
  /** Asks the owner in whichever client is open; false when they decline or nobody answers. */
  confirm(title: string, message: string): Promise<boolean>;
}

export function memoryTools({ port, session, recorder, models, attachmentContextKey, confirm }: MemoryToolsContext): AgentTool[] {
  return [
    {
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
    },

    {
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
        return { content: [{ type: "text", text: `Done: ${renderEpisode(episode)}\nWhat you start from shows it this way the next time it is loaded; in this conversation you already know.` }], details: episode };
    },
    },

    {
      name: "assistant_read",
      label: "Read past conversation",
      description: "Read what was said around one entry of a past conversation, including the tools called and what they returned. Use the sessionId and entryId from assistant_search.",
      parameters: READ_SCHEMA,
      execute: async (_id: string, params: { sessionId: string; entryId: string; before?: number; after?: number }) => {
        const result = await port.call({ op: "context", sessionId: params.sessionId, entryId: params.entryId, before: params.before ?? ASSISTANT_CONTEXT_DEFAULT_SPAN, after: params.after ?? ASSISTANT_CONTEXT_DEFAULT_SPAN });
        return { content: [{ type: "text", text: renderContext(result, params.entryId) }], details: result };
    },
    },

    {
      name: "assistant_memory",
      label: "Memories",
      description: "Your memories of your owner and the two of you. add: remember something new. rewrite: correct what a memory says. retire: set aside one that is no longer true; the background will not record it again from what was said before. forget: forget one when your owner asks; the words it came from, what was said in answer to them and the request to forget it are not found by searches either, the timeline lines covering them are forgotten with it, and the background will not record it again. Other places that happen to mention the same thing stay as they are. restore: bring back a retired or forgotten one, with everything that went with it. resident: whether it is loaded at the start of every session. get: one memory with where it came from and how it changed. list: memories by topic, state or keywords, newest first. settings: which model keeps your memories in the background and how that is going. set_model: change that model when your owner asks. reorganize: start over with the chosen model when your owner asks: what the background made and nobody touched is set aside (each can be restored), the timeline it wrote is cleared, and every conversation is read again; your owner is asked to confirm first. Use this tool when your owner asks you to remember or forget something, or when something is clearly worth remembering. What you start from is loaded anew when this Work is reopened or reloaded and when an older part of this conversation is handed over; until then you know what you changed from this conversation.",
      parameters: MEMORY_SCHEMA,
      execute: async (_id: string, params: { action: string; id?: string; topic?: AssistantMemoryTopic; text?: string; resident?: boolean; sources?: Array<{ sessionId: string; entryId: string }>; state?: AssistantMemoryState; query?: string; cursor?: string; model?: string }) => {
        /** The owner's latest words in this session, once they reached Main: where a memory said here came from, or where he asked for a change. */
        const saidHere = async (): Promise<{ sessionId: string; entryId: string } | undefined> => {
          await recorder.sync();
          const said = session.getBranch().findLast((entry) => ownerSpoke(entry, attachmentContextKey));
          return said === undefined ? undefined : { sessionId: session.getSessionId(), entryId: said.id };
        };
        const needId = (): string => {
          if (params.id === undefined) throw new Error(`${params.action} needs the memory's id.`);
          return params.id.replace(/^#/u, "");
        };
        const current = async (): Promise<AssistantMemory> => (await port.call({ op: "memory_get", id: needId() })).memory;
        // A name Main's model list does not have would only fail later, in the background.
        const known = (model: { provider: string; id: string }): void => {
          if (!models.getModel(model.provider, model.id)) throw new Error(`${model.provider}/${model.id} is not a model Main can use now. Give the exact provider/model-id of one in this Work's model list.`);
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
          const confirmed = await confirm("从头整理记忆？", `助手会用 ${extractionModel.provider}/${extractionModel.id} 把所有对话从头读一遍：后台整理出、没人改过的记忆挪进「已作废」（可以逐条恢复），后台写的时间线清掉重写；你写过、改过的，和她按你吩咐记下的都留着。读完之前，新开的会话里记忆不全；花费大致等于当初整理这些对话的总和。`);
          if (!confirmed) return { content: [{ type: "text", text: "Your owner did not confirm. Nothing was changed." }], details: { confirmed: false } };
          const result = await port.call({ op: "reorganize", extractionModel });
          return {
            content: [{ type: "text", text: `Started over with ${result.extractionModel.provider}/${result.extractionModel.id}: ${result.retiredMemories} memor${result.retiredMemories === 1 ? "y" : "ies"} the background made were set aside among the retired, ${result.removedLines} timeline line(s) it wrote were cleared, and every conversation is being read again. Until that is done, fewer memories are loaded with what you start from.` }],
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
        return { content: [{ type: "text", text: `Done: ${renderMemory(memory)}\nWhat you start from shows it this way the next time it is loaded; in this conversation you already know.` }], details: memory };
    },
    },

    {
      name: "assistant_document",
      label: "Persona and notes",
      description: "Read or change your persona (who you are) or the notes your owner wrote by hand (facts and rules that win over anything else). write replaces the whole text; edit replaces one exact passage. What you start from is loaded anew when this Work is reopened or reloaded and when an older part of this conversation is handed over; until then you know what you changed from this conversation.",
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
          : `Saved the ${params.document} document. What you start from carries it the next time it is loaded; in this conversation you already know.`;
        return { content: [{ type: "text", text }], details: { document: result.document, revision: result.revision } };
    },
    },
  ] as unknown as AgentTool[];
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
