import {
  ASSISTANT_MEMORY_TOPICS,
  MAX_ASSISTANT_EPISODE_CHARS,
  MAX_ASSISTANT_MEMORY_CHARS,
  type AssistantMemoryTopic,
} from "../core/assistant.js";
import { localDay, localMinute, localSpan } from "../core/local-time.js";
import type { MemoryRow } from "./memories.js";
import type { EntryRow } from "./store.js";
import type { EpisodeRow } from "./timeline.js";

/*
 * What the extraction model reads and how its reply is read back (card #295). The prompts say what
 * her memory is for and leave the judgment of what is worth keeping to the model; only the lines it
 * must not cross are rules. Following "Components of agent memory" (Anthropic, 2026): fixed rules
 * about what to record made strong models remember worse, a small loaded layer is followed better,
 * and a later pass that checks memories against the original words corrects them.
 *
 * The same reading also writes her timeline (timeline.ts), which judges nothing: one line per stretch
 * of the conversation saying what they were doing, work included, so that what did not become a
 * memory is still there to turn to.
 *
 * The model reads only what was said, by the owner, by her and by other Works, and every word of it
 * (owner's decision of 2026-11-10): not what tools returned or which tools she called, not the
 * summaries Pi writes when it compacts a conversation, which repeat what was said under a later time.
 * Of her memories it is shown those loaded every session, as she is; the others it looks up with
 * SEARCH_TOOL, as she does, rather than being handed a pile of them. That search also shows what the
 * owner had her forget and what he or she set aside, marked as not to be recorded again: without
 * them the model, reading an old conversation, would make the same memory once more.
 *
 * The persona may describe any assistant, so the prompts call her "助手" and let the persona name her;
 * "主人" is the product's word for her owner.
 */

/** Rounds of searches the model may make before it answers. */
export const SEARCH_ROUNDS = 3;
/** Groups of words one search may look up, and memories it lists for each. */
const SEARCH_QUERIES = 5;
export const SEARCH_HITS = 15;

const RULES_COMMON = `- 密码、密钥、令牌、证件号码这类东西不记。
- 主人要她忘掉的事不记。查记忆时会看到标着“主人让忘掉的”和“已作废”的旧记忆：让忘掉的事不要再记，除非这次读到主人明确说要重新记住它；已作废的是后来判定不对或不再成立的事，这次读到的话如果是在它作废之前说的，就不要照着再记，作废之后主人又说起才按新说的记。这两种都不能改写、作废或合并。
- 主人手写的设定优先：别重复它，也别和它矛盾。标着“主人定的”的记忆不能改写，也不能作废；标着“常驻由主人定”的，不能改它常驻与否。
- 一条只写一件事，写成单独看也懂的陈述句，称呼用“主人”和她的名字，不超过 150 字，用主人平时说的语言。推测要写明是推测。长期成立的事写成长期的样子（比如生日只写月日），某一天的事写明是哪天。`;

const TOPICS_LINE = `记忆分五类（topic）：owner 主人这个人（身份、住处和工作、生日、身体和作息、在意的人），preferences 主人的喜好和习惯，relationship 他们之间，events 经历过的事（写明哪天），self 她自己（她定下的改变、答应主人的事）。`;

const RESIDENT_LINE = `resident 决定这条是不是每次开会话都带上：认识主人很久的人不用想就知道的事填 true，比如他是谁、住在哪做什么、生日、明显的喜好和忌口、眼下生活里的大事（比如快要搬家、换工作）、他们之间说话做事的规矩、她答应过一直要做到的事；已经过去的某一天的事、只在聊到时才用得上的细节填 false，她需要时会去查。常驻的每条都写得精炼，同一件事别分成几条。`;

const EXTRACTION_SYSTEM = `你替一位个人助手整理她的记忆，并记她的时间线。她是谁见下面的人设；她的使用者，下面称“主人”。

记忆是为以后准备的：下次和主人聊天时，她要像一个认识主人很久的人，记得主人是什么样的人、他们之间怎么相处、一起经历过什么。每段对话的原话都会留着，她随时能搜；记忆要记的，是她以后不翻原话也该知道的事。做了什么工作、怎么做的，原话里都有，时间线里也会写，记忆里不必记：修了什么问题、升了什么版本、测试过没过，这些细节都不是记忆。但主人这阵子在做什么项目、为什么做、对它多上心，是他生活的一部分，和别的事一样看值不值得记。值得记的是这些事透露出的主人这个人、他们的关系，和一个老朋友以后会提起的经历：他难熬或高兴的时候、生活里的变化、对他要紧的事。什么值得记，由你判断。

时间线是另一回事：像日记的目录，一行写清一段时间里主人在做什么、聊什么（例：“在 alu_dock 做助手记忆的后台提炼，调触发时机”“深夜睡不着，聊艾尔登法环的新档”），以后她被问起“那天我们在干嘛”时翻它。时间线不挑重要不重要，工程上的事也照实写——在哪个项目做什么、卡在哪、做完没有——但不写细节和数字（路径、命令、版本号、测试个数都不写）。下面列着这个会话已有的行：这次读到的还是同一天同一件事，就改写那一行（rewrite），把新读到的加进去，别丢掉它原来说的；换了一天，或者话题明显换了，才新加一行（add）。标着“主人定的，不能改”的行不要改写：接着它的事另加一行，只写这次读到的。这次读到的每段对话都要落在某一行里，所以每次至少新加或改写一行。每行不超过 80 字，用主人平时说的语言；起止时间会自动标在行前，行里不用再写日期；密码密钥、主人要她忘掉的事，时间线里同样不写。

必须遵守：
${RULES_COMMON}
- 每条记忆、每行时间线都写明出自这次对话的哪几条（方括号里的编号）。
- 和已有记忆说的是同一件事，就改写那一条，别另加；已有的记忆不再成立，就作废它。
- 没有值得记的记忆，就不改记忆；时间线照常写。

下面只列出了每次都带着的记忆（常驻的），其他记忆没有列出。打算新记、改写或作废记忆之前，先用 search_memories 查一查：这件事以前记过没有、有没有和它矛盾的旧记忆。查到了就改写或作废那一条，别另加一条。它按字面找：一组里用空格隔开的词都要原样出现在记忆里，所以一组最好只放一个词，一次多查几组、换几种说法（比如“上海”“搬家”“工作”）；最多查 ${SEARCH_ROUNDS} 轮。没有要记的就不用查。只能改写或作废列出的和查到的记忆。

${TOPICS_LINE}
${RESIDENT_LINE}

只回复一个 JSON 对象，不要其他文字：
{"changes":[
  {"do":"add","topic":"preferences","text":"……","resident":false,"from":[3,5]},
  {"do":"rewrite","id":"12","text":"……","from":[7]},
  {"do":"retire","id":"9","from":[8]}
],"timeline":[
  {"do":"add","text":"……","from":[1,2,3]},
  {"do":"rewrite","id":"4","text":"……","from":[4,5]}
]}
没有要改的记忆就让 changes 为空：{"changes":[],"timeline":[……]}；timeline 不能为空。`;

const DREAM_SYSTEM = `你替一位个人助手做一次记忆整理，就像人在睡觉时整理白天的经历。她是谁见下面的人设；她的使用者，下面称“主人”。整理的目的和记的时候一样：下次聊天时，她要像一个认识主人很久的人那样，记得主人和他们之间的事。

这次着重看“最近变过的记忆”，每条后面附着它出处的原话。
- 对照原话：记错的改正（rewrite）；原话撑不起来的作废（retire）。
- 说同一件事的几条合成一条（merge）；不再成立的作废。几段对话里反复出现的事，可以合成一条新的认识。
- 让每次都带上的那部分（常驻）保持精炼：说同一件事的常驻记忆合成一条；常驻记忆里夹带的、已经过去的某一天的细节去掉（经历里有就行）；按下面 resident 的说明不该常驻的，改成不常驻（resident 设为 false）。带上的越精炼，她越容易照着做。
- 没有把握就不要动。

下面只列出了要看的记忆和常驻的记忆。要找和它们说同一件事、或和它们矛盾的其他记忆，用 search_memories 查；它按字面找，一组最好只放一个词，一次多查几组、换几种说法，最多查 ${SEARCH_ROUNDS} 轮。只能改写、作废、合并列出的和查到的记忆。

必须遵守：
${RULES_COMMON}

${TOPICS_LINE}
${RESIDENT_LINE}

只回复一个 JSON 对象，不要其他文字：
{"changes":[
  {"do":"rewrite","id":"12","text":"……"},
  {"do":"retire","id":"9"},
  {"do":"merge","ids":["3","8"],"text":"……","topic":"preferences","resident":true},
  {"do":"resident","id":"5","resident":false}
]}
没有要改的就回复 {"changes":[]}。`;

/** Last in a prompt, so the answer that comes after any searches still keeps to the agreed form. */
const ANSWER_REMINDER = "需要的话先查记忆；最后只回复一个 JSON 对象，格式照前面说的。每条要写出处的，把编号单独写成 from 数组，不要写进 text。";

export interface ModelPrompt { system: string; prompt: string }

/** A memory as the model sees it, with the words it came from when it is being checked. */
export interface ShownMemory { row: MemoryRow; sources?: string[]; unshownSources?: number }

export interface ExtractionInput {
  persona: string;
  notes: string;
  /** The memories loaded every session; the model searches for the others. */
  resident: ShownMemory[];
  /** This conversation's latest timeline lines, oldest first, which the model may extend. */
  episodes: EpisodeRow[];
  /** What came just before, already read. */
  leadIn: string[];
  /** The entries to read, numbered from 1 in this order. */
  lines: string[];
}

export function extractionPrompt(input: ExtractionInput): ModelPrompt {
  return {
    system: EXTRACTION_SYSTEM,
    prompt: [
      ...background(input.persona, input.notes),
      "## 每次都带着的记忆（其他的用 search_memories 查）",
      input.resident.length === 0 ? "（没有。）" : input.resident.map((memory) => memoryLine(memory)).join("\n"),
      "## 这个会话已有的时间线（最近几行）",
      input.episodes.length === 0 ? "（还没有。）" : input.episodes.map((row) => episodeLine(row)).join("\n"),
      ...(input.leadIn.length === 0 ? [] : ["## 前面已经读过的对话（帮你理解上下文，不从这里记）", input.leadIn.join("\n")]),
      "## 这次要读的对话（“Work 消息”是别的 Work 发给她的，不是主人说的：它做了什么可以写进时间线，但别把它的话当成主人的话或主人的情况记进记忆）",
      input.lines.map((line, index) => `[${index + 1}] ${line}`).join("\n"),
      ANSWER_REMINDER,
    ].join("\n\n"),
  };
}

export interface DreamInput {
  persona: string;
  notes: string;
  /** Changed since the last pass, each with the words it came from. */
  focus: ShownMemory[];
  /** The others loaded every session, to compare with; the model searches for the rest. */
  resident: ShownMemory[];
  residentTotal: { count: number; chars: number };
}

export function dreamPrompt(input: DreamInput): ModelPrompt {
  return {
    system: DREAM_SYSTEM,
    prompt: [
      ...background(input.persona, input.notes),
      "## 最近变过的记忆",
      input.focus.map((memory) => memoryLine(memory)).join("\n"),
      "## 其他常驻的记忆（供对照；不常驻的用 search_memories 查）",
      input.resident.length === 0 ? "（没有。）" : input.resident.map((memory) => memoryLine(memory)).join("\n"),
      `## 常驻的记忆现在共 ${input.residentTotal.count} 条，约 ${input.residentTotal.chars} 字。`,
      ANSWER_REMINDER,
    ].join("\n\n"),
  };
}

/** Both documents whole: a rule the owner wrote anywhere in them counts. */
function background(persona: string, notes: string): string[] {
  return [
    "## 她的人设",
    persona.trim() || "（没有写。）",
    "## 主人手写的设定",
    notes.trim() || "（没有写。）",
  ];
}

/** The search the model may make of her memories while it reads, as a tool it calls. */
export const SEARCH_TOOL = {
  name: "search_memories",
  description: `查她的记忆：在用的，以及主人让忘掉的和已作废的（会标出来，不能改，也别再记）。queries 是几组词，每组里用空格隔开的词都要原样出现在记忆里，所以一组最好只放一个词；每组最多列出 ${SEARCH_HITS} 条，新的在前。`,
  parameters: {
    type: "object",
    properties: {
      queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: SEARCH_QUERIES, description: "要查的几组词，比如 [\"上海\", \"搬家\", \"工作\"]。" },
    },
    required: ["queries"],
    additionalProperties: false,
  },
} as const;

/** The groups of words a search names, each split into the words that must all occur; undefined when it names none. */
export function searchQueries(args: Record<string, unknown>): string[][] | undefined {
  if (!Array.isArray(args.queries)) return undefined;
  const queries = args.queries.filter((query): query is string => typeof query === "string")
    .map((query) => query.trim().split(/\s+/u).filter((word) => word.length > 0)).filter((words) => words.length > 0)
    .slice(0, SEARCH_QUERIES);
  return queries.length === 0 ? undefined : queries;
}

/** What one search found, for each group of words. */
export function searchResultText(found: ReadonlyArray<{ words: string[]; rows: MemoryRow[] }>): string {
  return found.map(({ words, rows }) => [
    `## ${words.join(" ")}`,
    rows.length === 0 ? "（没有。）" : rows.map((row) => memoryLine({ row })).join("\n"),
  ].join("\n")).join("\n\n");
}

function memoryLine(memory: ShownMemory): string {
  const { row } = memory;
  // One the owner had her forget, or that he or she set aside: on record so that it is not made again.
  const marks = row.state === "forgotten" ? ["主人让忘掉的，别再记"]
    : row.state === "retired" ? [`已作废（${localDay(new Date(row.updated_at))}），这之前说的别再照着记`]
    : [
      row.topic,
      row.resident === 1 ? "常驻" : "不常驻",
      ...(row.author === "owner" ? ["主人定的"] : row.resident_fixed === 1 ? ["常驻由主人定"] : []),
    ];
  const sources = (memory.sources ?? []).map((source) => `\n    原话：${source}`).join("")
    + (memory.unshownSources ? `\n    （还有 ${memory.unshownSources} 处原话太长，没有列出。）` : "");
  return `[#${row.id}]（${marks.join("，")}）${row.text}${sources}`;
}

/** A timeline line as the model sees it; one the owner wrote last is marked, since it may not be rewritten. */
function episodeLine(row: EpisodeRow): string {
  const span = localSpan(new Date(row.from_ms), new Date(row.to_ms));
  return `[#${row.id}] ${span}${row.author === "owner" ? "（主人定的，不能改）" : ""} ${row.text}`;
}

/**
 * What was said in one entry as the model reads it, whole, with its local time; undefined for an
 * entry that is not words said (see SPOKEN in store.ts) or that the owner had her forget. `tail`
 * keeps only the last that many characters, for words already read and shown again as lead-in.
 */
export function spokenLine(row: EntryRow, tail?: number): string | undefined {
  // Forgotten: not to be remembered again.
  if (row.forgotten > 0) return undefined;
  const speaker = row.kind === "user" ? "主人" : row.kind === "assistant" ? "助手" : row.kind === "work" ? "Work 消息" : undefined;
  const words = row.text.replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
  if (speaker === undefined || words.length === 0) return undefined;
  const characters = [...words];
  const kept = tail !== undefined && characters.length > tail ? `……${characters.slice(characters.length - tail).join("")}` : words;
  return `${localMinute(new Date(row.at))} ${speaker}：${kept}`;
}

export type ExtractionChange =
  | { do: "add"; topic: AssistantMemoryTopic; text: string; resident: boolean; from: number[] }
  | { do: "rewrite"; id: number; text: string; from: number[] }
  | { do: "retire"; id: number; from: number[] };

/** A timeline line the model adds or extends, naming the numbered entries it covers. */
export type TimelineChange =
  | { do: "add"; text: string; from: number[] }
  | { do: "rewrite"; id: number; text: string; from: number[] };

export type DreamChange =
  | { do: "rewrite"; id: number; text: string }
  | { do: "retire"; id: number }
  | { do: "merge"; ids: number[]; text: string; topic?: AssistantMemoryTopic; resident?: boolean }
  | { do: "resident"; id: number; resident: boolean };

/** The reply is not the agreed JSON at all; single changes that do not fit are left out instead. */
export class ReplyFormatError extends Error {}

/**
 * `lines`: how many numbered entries the prompt showed. Every part read is to land on the timeline, so
 * a reply that adds or extends no line is not in the agreed form: it is asked again rather than
 * leaving that stretch of the conversation without a line.
 */
export function parseExtractionReply(reply: string, lines: number): { changes: ExtractionChange[]; timeline: TimelineChange[] } {
  const body = replyObject(reply);
  const rawChanges = replyChanges(body);
  if (!Array.isArray(body.timeline)) throw new ReplyFormatError("The reply has no timeline");
  const timeline: TimelineChange[] = [];
  for (const raw of body.timeline as unknown[]) {
    const change = record(raw);
    const from = references(change?.from, lines);
    const text = episodeText(change?.text);
    if (change?.do === "add" && from.length > 0 && text !== undefined) { timeline.push({ do: "add", text, from }); continue; }
    const id = memoryId(change?.id);
    if (change?.do === "rewrite" && from.length > 0 && text !== undefined && id !== undefined) timeline.push({ do: "rewrite", id, text, from });
  }
  if (timeline.length === 0) throw new ReplyFormatError("The reply writes no timeline line for what it read");
  const changes: ExtractionChange[] = [];
  for (const raw of rawChanges) {
    const change = record(raw);
    const from = references(change?.from, lines);
    const kind = change?.do;
    if (kind === "add" && from.length > 0) {
      const topic = topicOf(change!.topic);
      const text = memoryText(change!.text);
      if (topic !== undefined && text !== undefined) { changes.push({ do: "add", topic, text, resident: change!.resident === true, from }); continue; }
    } else if (kind === "rewrite" && from.length > 0) {
      const id = memoryId(change!.id);
      const text = memoryText(change!.text);
      if (id !== undefined && text !== undefined) { changes.push({ do: "rewrite", id, text, from }); continue; }
    } else if (kind === "retire") {
      const id = memoryId(change!.id);
      if (id !== undefined) changes.push({ do: "retire", id, from });
    }
  }
  return { changes, timeline };
}

export function parseDreamReply(reply: string): { changes: DreamChange[] } {
  const changes: DreamChange[] = [];
  for (const raw of replyChanges(replyObject(reply))) {
    const change = record(raw);
    const kind = change?.do;
    const id = memoryId(change?.id);
    if (kind === "rewrite") {
      const text = memoryText(change!.text);
      if (id !== undefined && text !== undefined) { changes.push({ do: "rewrite", id, text }); continue; }
    } else if (kind === "retire" && id !== undefined) {
      changes.push({ do: "retire", id });
      continue;
    } else if (kind === "merge") {
      const ids = Array.isArray(change!.ids) ? [...new Set(change!.ids.map(memoryId))] : [];
      const text = memoryText(change!.text);
      const topic = change!.topic === undefined ? undefined : topicOf(change!.topic);
      if (ids.length >= 2 && ids.every((item) => item !== undefined) && text !== undefined && (change!.topic === undefined || topic !== undefined)) {
        changes.push({ do: "merge", ids: ids as number[], text, ...(topic === undefined ? {} : { topic }), ...(typeof change!.resident === "boolean" ? { resident: change!.resident } : {}) });
        continue;
      }
    } else if (kind === "resident" && id !== undefined && typeof change!.resident === "boolean") {
      changes.push({ do: "resident", id, resident: change!.resident });
    }
  }
  return { changes };
}

/** The reply's JSON object, from the first "{" to the last "}" so a fence or a remark around it does no harm. */
function replyObject(reply: string): Record<string, unknown> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) throw new ReplyFormatError("The reply holds no JSON object");
  let value: unknown;
  try { value = JSON.parse(reply.slice(start, end + 1)); }
  catch { throw new ReplyFormatError("The reply's JSON cannot be read"); }
  const body = record(value);
  if (!body) throw new ReplyFormatError("The reply is not a JSON object");
  return body;
}

function replyChanges(body: Record<string, unknown>): unknown[] {
  if (!Array.isArray(body.changes)) throw new ReplyFormatError("The reply has no list of changes");
  return body.changes;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function topicOf(value: unknown): AssistantMemoryTopic | undefined {
  return ASSISTANT_MEMORY_TOPICS.includes(value as AssistantMemoryTopic) ? value as AssistantMemoryTopic : undefined;
}

function memoryText(value: unknown): string | undefined {
  return boundedText(value, MAX_ASSISTANT_MEMORY_CHARS);
}

function episodeText(value: unknown): string | undefined {
  return boundedText(value, MAX_ASSISTANT_EPISODE_CHARS);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= max ? text : undefined;
}

function memoryId(value: unknown): number | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.replace(/^#/u, "") : "";
  return /^[1-9][0-9]{0,14}$/u.test(text) ? Number(text) : undefined;
}

/** The numbered entries a change names, in range and each once. */
function references(value: unknown, lines: number): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => typeof item === "string" ? Number(item.replace(/^\[|\]$/gu, "")) : item)
    .filter((item): item is number => Number.isSafeInteger(item) && (item as number) >= 1 && (item as number) <= lines))];
}
