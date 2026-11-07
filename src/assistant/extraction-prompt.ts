import {
  ASSISTANT_MEMORY_TOPICS,
  ASSISTANT_TOOL_NAMES,
  MAX_ASSISTANT_MEMORY_CHARS,
  type AssistantMemoryTopic,
} from "../core/assistant.js";
import { localMinute } from "./local-time.js";
import type { MemoryRow } from "./memories.js";
import type { EntryRow } from "./store.js";

/*
 * What the extraction model reads and how its reply is read back (card #295). The prompts say what
 * her memory is for and leave the judgment of what is worth keeping to the model; only the lines it
 * must not cross are rules. Following "Components of agent memory" (Anthropic, 2026): fixed rules
 * about what to record made strong models remember worse, a small loaded layer is followed better,
 * and a later pass that checks memories against the original words corrects them.
 *
 * The persona may describe any assistant, so the prompts call her "助手" and let the persona name her;
 * "主人" is the product's word for her owner.
 */

const OWN_TOOLS = new Set<string>(ASSISTANT_TOOL_NAMES);

/** A conversation entry's words in a prompt; longer ones keep their start and end. */
const SPOKEN_CHARS = 4_000;
const TOOL_CALL_CHARS = 160;
const TOOL_RESULT_CHARS = 300;
const SUMMARY_CHARS = 2_000;
/** What a memory being checked shows of each place it was said. */
const SOURCE_CHARS = 300;
const PERSONA_CHARS = 4_000;
const NOTES_CHARS = 20_000;

const RULES_COMMON = `- 密码、密钥、令牌、证件号码这类东西不记。
- 主人要她忘掉的事不记。
- 主人手写的设定优先：别重复它，也别和它矛盾。标着“主人定的”的记忆不能改写，也不能作废；标着“常驻由主人定”的，不能改它常驻与否。
- 一条只写一件事，写成单独看也懂的陈述句，称呼用“主人”和她的名字，不超过 150 字，用主人平时说的语言。推测要写明是推测。长期成立的事写成长期的样子（比如生日只写月日），某一天的事写明是哪天。`;

const TOPICS_LINE = `记忆分五类（topic）：owner 主人这个人（身份、住处和工作、生日、身体和作息、在意的人），preferences 主人的喜好和习惯，relationship 他们之间，events 经历过的事（写明哪天），self 她自己（她定下的改变、答应主人的事）。`;

const RESIDENT_LINE = `resident 决定这条是不是每次开会话都带上：认识主人很久的人不用想就知道的事填 true，比如他是谁、住在哪做什么、生日、明显的喜好和忌口、眼下生活里的大事（比如快要搬家、换工作）、他们之间说话做事的规矩、她答应过一直要做到的事；已经过去的某一天的事、只在聊到时才用得上的细节填 false，她需要时会去查。常驻的每条都写得精炼，同一件事别分成几条。`;

const EXTRACTION_SYSTEM = `你替一位个人助手整理她的记忆。她是谁见下面的人设；她的使用者，下面称“主人”。

记忆是为以后准备的：下次和主人聊天时，她要像一个认识主人很久的人，记得主人是什么样的人、他们之间怎么相处、一起经历过什么。每段对话的原话都会留着，她随时能搜；记忆要记的，是她以后不翻原话也该知道的事。做了什么工作、怎么做的，原话里都有，不必记：修了什么问题、升了什么版本、测试过没过，都不算经历。值得记的是这些事透露出的主人这个人、他们的关系，和一个老朋友以后会提起的经历：他难熬或高兴的时候、生活里的变化、对他要紧的事。什么值得记，由你判断。

必须遵守：
${RULES_COMMON}
- 每条写明出自这次对话的哪几条（方括号里的编号）。
- 和已有记忆说的是同一件事，就改写那一条，别另加；已有的记忆不再成立，就作废它。
- 没有值得记的，就什么都不改。

${TOPICS_LINE}
${RESIDENT_LINE}

只回复一个 JSON 对象，不要其他文字：
{"changes":[
  {"do":"add","topic":"preferences","text":"……","resident":false,"from":[3,5]},
  {"do":"rewrite","id":"12","text":"……","from":[7]},
  {"do":"retire","id":"9","from":[8]}
]}
没有要改的就回复 {"changes":[]}。`;

const DREAM_SYSTEM = `你替一位个人助手做一次记忆整理，就像人在睡觉时整理白天的经历。她是谁见下面的人设；她的使用者，下面称“主人”。整理的目的和记的时候一样：下次聊天时，她要像一个认识主人很久的人那样，记得主人和他们之间的事。

这次着重看“最近变过的记忆”，每条后面附着它出处的原话。
- 对照原话：记错的改正（rewrite）；原话撑不起来的作废（retire）。
- 说同一件事的几条合成一条（merge）；不再成立的作废。几段对话里反复出现的事，可以合成一条新的认识。
- 让每次都带上的那部分（常驻）保持精炼：说同一件事的常驻记忆合成一条；常驻记忆里夹带的、已经过去的某一天的细节去掉（经历里有就行）；按下面 resident 的说明不该常驻的，改成不常驻（resident 设为 false）。带上的越精炼，她越容易照着做。
- 没有把握就不要动。

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

export interface ModelPrompt { system: string; prompt: string }

/** A memory as the model sees it, with the words it came from when it is being checked. */
export interface ShownMemory { row: MemoryRow; sources?: string[] }

export interface ExtractionInput {
  persona: string;
  notes: string;
  memories: ShownMemory[];
  /** Memories in use left out to keep the prompt short. */
  omitted: number;
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
      "## 已有的记忆",
      input.memories.length === 0 ? "（还没有。）" : input.memories.map((memory) => memoryLine(memory)).join("\n"),
      ...(input.omitted > 0 ? [`（另有 ${input.omitted} 条较早的不常驻记忆没有列出。）`] : []),
      ...(input.leadIn.length === 0 ? [] : ["## 前面已经读过的对话（帮你理解上下文，不从这里记）", input.leadIn.join("\n")]),
      "## 这次要读的对话（主人的话有时是别的 Work 转来的，不用区分）",
      input.lines.map((line, index) => `[${index + 1}] ${line}`).join("\n"),
    ].join("\n\n"),
  };
}

export interface DreamInput {
  persona: string;
  notes: string;
  /** Changed since the last pass, each with the words it came from. */
  focus: ShownMemory[];
  /** Others in use to compare with: everything loaded every session and the same topics. */
  related: ShownMemory[];
  resident: { count: number; chars: number };
}

export function dreamPrompt(input: DreamInput): ModelPrompt {
  return {
    system: DREAM_SYSTEM,
    prompt: [
      ...background(input.persona, input.notes),
      "## 最近变过的记忆",
      input.focus.map((memory) => memoryLine(memory)).join("\n"),
      "## 其他相关的记忆（供对照）",
      input.related.length === 0 ? "（没有。）" : input.related.map((memory) => memoryLine(memory)).join("\n"),
      `## 常驻的记忆现在共 ${input.resident.count} 条，约 ${input.resident.chars} 字。`,
    ].join("\n\n"),
  };
}

function background(persona: string, notes: string): string[] {
  return [
    "## 她的人设",
    clip(persona.trim(), PERSONA_CHARS) || "（没有写。）",
    "## 主人手写的设定",
    clip(notes.trim(), NOTES_CHARS) || "（没有写。）",
  ];
}

function memoryLine(memory: ShownMemory): string {
  const { row } = memory;
  const marks = [
    row.topic,
    row.resident === 1 ? "常驻" : "不常驻",
    ...(row.author === "owner" ? ["主人定的"] : row.resident_fixed === 1 ? ["常驻由主人定"] : []),
  ];
  const sources = (memory.sources ?? []).map((source) => `\n    原话：${source}`).join("");
  return `[#${row.id}]（${marks.join("，")}）${row.text}${sources}`;
}

/** An entry as the model reads it, with its local time; undefined for what it need not read. */
export function spokenLine(row: EntryRow, chars = SPOKEN_CHARS): string | undefined {
  const words = spoken(row, chars);
  return words === undefined ? undefined : `${localMinute(new Date(row.at))} ${words}`;
}

/** Where a memory came from, for checking it against the original words. */
export function sourceLine(row: EntryRow): string | undefined {
  return spokenLine(row, SOURCE_CHARS);
}

function spoken(row: EntryRow, chars: number): string | undefined {
  // Forgotten: not to be remembered again.
  if (row.forgotten > 0) return undefined;
  switch (row.kind) {
    case "user": return row.text.trim().length === 0 ? undefined : `主人：${clip(row.text, chars)}`;
    case "assistant": {
      const calls = toolCalls(row.tool_calls).filter((call) => !OWN_TOOLS.has(call.name))
        .map((call) => `（用了 ${call.name}：${clip(call.arguments, TOOL_CALL_CHARS)}）`);
      const text = row.text.trim();
      if (text.length === 0 && calls.length === 0) return undefined;
      return `助手：${[clip(text, chars), ...calls].filter((part) => part.length > 0).join(" ")}`;
    }
    case "tool_result":
      if (row.search_text.length === 0 || (row.tool_name !== null && OWN_TOOLS.has(row.tool_name))) return undefined;
      return `（${row.tool_name ?? "工具"} 的结果）${clip(row.text, Math.min(chars, TOOL_RESULT_CHARS))}`;
    case "bash": return `（主人在命令行执行）${clip(row.text, Math.min(chars, TOOL_RESULT_CHARS))}`;
    case "summary": return `（之前对话的摘要）${clip(row.text, Math.min(chars, SUMMARY_CHARS))}`;
    default: return undefined;
  }
}

function toolCalls(json: string | null): Array<{ name: string; arguments: string }> {
  if (json === null) return [];
  try {
    const calls = JSON.parse(json) as unknown;
    return Array.isArray(calls) ? calls.filter((call): call is { name: string; arguments: string } => typeof call?.name === "string" && typeof call?.arguments === "string") : [];
  } catch {
    return [];
  }
}

/** Runs of blank space become one; a longer text keeps its first two thirds and its last third. */
export function clip(text: string, chars: number): string {
  const flat = text.replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
  const characters = [...flat];
  if (characters.length <= chars) return flat;
  const head = Math.floor(chars * 2 / 3);
  return `${characters.slice(0, head).join("")}……（中间省略）……${characters.slice(characters.length - (chars - head)).join("")}`;
}

export type ExtractionChange =
  | { do: "add"; topic: AssistantMemoryTopic; text: string; resident: boolean; from: number[] }
  | { do: "rewrite"; id: number; text: string; from: number[] }
  | { do: "retire"; id: number; from: number[] };

export type DreamChange =
  | { do: "rewrite"; id: number; text: string }
  | { do: "retire"; id: number }
  | { do: "merge"; ids: number[]; text: string; topic?: AssistantMemoryTopic; resident?: boolean }
  | { do: "resident"; id: number; resident: boolean };

/** The reply is not the agreed JSON at all; single changes that do not fit are left out instead. */
export class ReplyFormatError extends Error {}

/** `lines`: how many numbered entries the prompt showed. */
export function parseExtractionReply(reply: string, lines: number): { changes: ExtractionChange[]; skipped: number } {
  let skipped = 0;
  const changes: ExtractionChange[] = [];
  for (const raw of replyChanges(reply)) {
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
      if (id !== undefined) { changes.push({ do: "retire", id, from }); continue; }
    }
    skipped += 1;
  }
  return { changes, skipped };
}

export function parseDreamReply(reply: string): { changes: DreamChange[]; skipped: number } {
  let skipped = 0;
  const changes: DreamChange[] = [];
  for (const raw of replyChanges(reply)) {
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
      continue;
    }
    skipped += 1;
  }
  return { changes, skipped };
}

/** The reply's `changes`, from the first "{" to the last "}" so a fence or a remark around it does no harm. */
function replyChanges(reply: string): unknown[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) throw new ReplyFormatError("The reply holds no JSON object");
  let value: unknown;
  try { value = JSON.parse(reply.slice(start, end + 1)); }
  catch { throw new ReplyFormatError("The reply's JSON cannot be read"); }
  const changes = record(value)?.changes;
  if (!Array.isArray(changes)) throw new ReplyFormatError("The reply has no list of changes");
  return changes;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function topicOf(value: unknown): AssistantMemoryTopic | undefined {
  return ASSISTANT_MEMORY_TOPICS.includes(value as AssistantMemoryTopic) ? value as AssistantMemoryTopic : undefined;
}

function memoryText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= MAX_ASSISTANT_MEMORY_CHARS ? text : undefined;
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
