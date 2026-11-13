import {
  ASSISTANT_MEMORY_TOPICS,
  MAX_ASSISTANT_DOCUMENT_BYTES,
  MAX_ASSISTANT_EPISODE_CHARS,
  MAX_ASSISTANT_MEMORY_CHARS,
  MAX_ASSISTANT_PREVIEW_BYTES,
  type AssistantEpisode,
  type AssistantMemory,
  type AssistantMemoryAuthor,
  type AssistantMemoryTopic,
  type AssistantPreview,
  type AssistantRequest,
  type AssistantResultFor,
  type AssistantSource,
} from "../core/assistant.js";
import type { AssistantDocuments } from "./documents.js";
import type { AssistantExtraction } from "./extraction.js";
import { localSpan, localTime } from "../core/local-time.js";
import type { AssistantMemories } from "./memories.js";
import type { AssistantReaders } from "./readers.js";
import type { AssistantStore } from "./store.js";
import type { AssistantTimeline } from "./timeline.js";

/** How a session she loads heads each topic of what she remembers. */
const TOPIC_HEADINGS: Record<AssistantMemoryTopic, string> = {
  owner: "主人", preferences: "主人的喜好和习惯", relationship: "你们之间", events: "经历过的事", self: "你自己",
};
/** How much of her timeline a session loads: the lines of the last week, at most this many of the newest. */
const LOADED_TIMELINE_DAYS = 7;
const LOADED_TIMELINE_LINES = 40;

/**
 * The assistant service's answers (card #295). It runs in its own process on Main, holds her persona,
 * the owner's notes, her recorded conversations and her memories, and answers the Works opened as her
 * and the owner's clients alike. Writes go through one connection on this thread, a short transaction
 * at a time; conversation searches and context reads run on reader threads, so none of them waits
 * behind another. Memories are few enough to be listed on this thread.
 */
export class AssistantCore {
  constructor(
    private readonly documents: AssistantDocuments,
    private readonly store: AssistantStore,
    private readonly readers: Pick<AssistantReaders, "search" | "context">,
    private readonly memories: AssistantMemories,
    private readonly timeline: AssistantTimeline,
    private readonly extraction: Pick<AssistantExtraction, "status" | "settings" | "setModel" | "reorganize">,
    private readonly workspacePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `signal` ends the asker's wait for a read; a write already started finishes. */
  async answer<R extends AssistantRequest>(request: R, source: AssistantSource, signal?: AbortSignal): Promise<AssistantResultFor<R>> {
    return await this.dispatch(request, source, signal) as AssistantResultFor<R>;
  }

  private async dispatch(request: AssistantRequest, source: AssistantSource, signal?: AbortSignal): Promise<unknown> {
    // The owner's client says so; anyone else asking is a Work opened as her, whether or not Main knows which.
    const author: AssistantMemoryAuthor = source.owner === true && source.workId === undefined ? "owner" : "assistant";
    switch (request.op) {
      case "info": return { workspacePath: this.workspacePath, maxDocumentBytes: MAX_ASSISTANT_DOCUMENT_BYTES, maxMemoryChars: MAX_ASSISTANT_MEMORY_CHARS, maxEpisodeChars: MAX_ASSISTANT_EPISODE_CHARS, extraction: this.extraction.status() };
      case "load": return this.preview();
      case "recorded": return this.store.recorded(request.sessionId);
      case "forgotten": return this.store.forgotten(request.sessionId, request.fromEntryId);
      case "record": return this.store.record(request.session, request.entries, request.throughEntryId, source);
      case "search": return this.readers.search(request, signal);
      case "context": return this.readers.context(request, signal);
      case "document_get": return this.documents.get(request.document);
      case "document_set": return this.documents.set(request.document, request.text, request.baseRevision);
      case "document_edit": return this.documents.edit(request.document, request.oldText, request.newText);
      case "memory_list": { const { op: _op, ...list } = request; return this.memories.list(list); }
      case "memory_get": return this.memories.get(request.id);
      case "memory_add": { const { op: _op, ...add } = request; return this.memories.add(add, author); }
      case "memory_update": { const { op: _op, askedAt, ...update } = request; return this.memories.update(update, author, askedAt); }
      case "timeline_list": { const { op: _op, ...list } = request; return this.timeline.list(list); }
      case "timeline_get": return this.timeline.get(request.id);
      case "timeline_update": { const { op: _op, ...update } = request; return this.timeline.update(update, author); }
      case "settings_get": return this.extraction.settings();
      case "settings_set": return this.extraction.setModel(request.extractionModel);
      case "reorganize": return this.extraction.reorganize(request.extractionModel);
    }
  }

  /**
   * Exactly what a new assistant session loads: the persona, the owner's notes, the memories loaded
   * every session, the last week of her timeline, and how to recall more.
   */
  private async preview(): Promise<AssistantPreview> {
    const loaded = this.now();
    const [persona, notes] = await Promise.all([this.documents.get("persona"), this.documents.get("notes")]);
    const parts = [persona.text.trim()];
    if (notes.text.trim().length > 0) {
      parts.push(`## 主人亲手写的设定\n\n这些是主人亲手写下的事实和规矩，和别的说法冲突时以这里为准。\n\n${notes.text.trim()}`);
    }
    const remembered = rememberedSection(this.memories.resident());
    if (remembered) parts.push(remembered);
    // One more than is loaded, to say so when the week holds more.
    const recent = timelineSection(this.timeline.recent(loaded.getTime() - LOADED_TIMELINE_DAYS * 86_400_000, LOADED_TIMELINE_LINES + 1));
    if (recent) parts.push(recent);
    parts.push([
      "## 记忆",
      "",
      `这份资料载入于 ${localTime(loaded)}。之后新记住或改过的东西不在这里；拿不准时先查，别凭印象说。`,
      "",
      "- 用 assistant_search 按关键词和时间搜你记得的事和你们过去的对话，搜不到就换个说法再搜。只给时间范围不给关键词，它先列那段时间的时间线，再列原话：被问“那天我们在干嘛”时这样查。",
      "- 用 assistant_read 看某一条前后的原话，包括当时调用的工具和查到的结果。",
      "- 用 assistant_memory 记下、改写、作废、忘掉或恢复一条记忆。主人让你记住或忘掉什么时用它；你自己觉得以后一定用得着的事，也可以记。",
      "- 用 assistant_timeline 改写、忘掉或恢复时间线上的一行。时间线是后台按对话写的，主人说某一行写错了或不想留时用它。",
      "- 用 assistant_document 读和改你的人设（persona）和主人的手写设定（notes）。",
    ].join("\n"));
    const text = parts.filter((part) => part.length > 0).join("\n\n");
    // A very long list of memories loaded every session still leaves room for the persona and notes.
    return { text: fitPreview(text), loadedAt: loaded.toISOString() };
  }
}

/** The memories loaded every session, under a heading per topic. */
function rememberedSection(memories: readonly AssistantMemory[]): string | undefined {
  if (memories.length === 0) return undefined;
  const groups = ASSISTANT_MEMORY_TOPICS.map((topic) => {
    const lines = memories.filter((memory) => memory.topic === topic).map((memory) => `- ${memory.text}（#${memory.id}）`);
    return lines.length === 0 ? undefined : `### ${TOPIC_HEADINGS[topic]}\n\n${lines.join("\n")}`;
  }).filter((group): group is string => group !== undefined);
  return ["## 你记得的事", "", "这些是你从过去和主人相处中记下的，每次都带着。括号里是记忆的编号，改写或忘掉时用。", "", ...groups.flatMap((group) => [group, ""])].join("\n").trim();
}

/** The latest week of her timeline, oldest first, so she knows what they have been up to. */
function timelineSection(episodes: readonly AssistantEpisode[]): string | undefined {
  if (episodes.length === 0) return undefined;
  // Oldest first: the newest LOADED_TIMELINE_LINES are the last ones.
  const shown = episodes.slice(-LOADED_TIMELINE_LINES);
  const lines = shown.map((episode) => `- ${localSpan(new Date(episode.fromAt), new Date(episode.toAt))}：${episode.text}（#${episode.id}）`);
  return [
    "## 最近一周的时间线",
    "",
    "你们这几天在做什么、聊什么，一段一行，是后台按对话写的目录。更早的用 assistant_search 只给时间范围查。括号里是这一行的编号。",
    ...(shown.length < episodes.length ? [`这一周的行太多，这里只放了最新的 ${shown.length} 行，前几天的同样用 assistant_search 查。`] : []),
    "",
    ...lines,
  ].join("\n");
}

function fitPreview(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_ASSISTANT_PREVIEW_BYTES) return text;
  const note = "\n\n（记得的事太多，后面的没有放进来；需要时用 assistant_search 查。）";
  const bytes = Buffer.from(text, "utf8").subarray(0, MAX_ASSISTANT_PREVIEW_BYTES - Buffer.byteLength(note, "utf8"));
  // Drop a character cut in half.
  return `${bytes.toString("utf8").replace(/\uFFFD$/u, "")}${note}`;
}
