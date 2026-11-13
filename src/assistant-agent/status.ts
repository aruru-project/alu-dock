import type { ObservedInstanceStatus } from "../core/instance-observation.js";
import { localMinute } from "../core/local-time.js";
import type { Reminder } from "./reminders.js";

/** The hidden note that opens each of her replies; clients do not show it and Main does not read it as speech. */
export const STATUS_NOTE_TYPE = "assistant-status";

/** What she keeps about a Work between replies. */
export interface WorkNote {
  /** The first line of the last thing it sent her. */
  lastSaid?: string;
  /** It still owes her a result for work she handed it. */
  owes?: boolean;
}

export interface StatusInput {
  now: Date;
  /** What started this reply, in a few words. */
  wokenBy: string;
  /** Every Work she can see, or undefined when the list could not be read. */
  works: readonly ObservedInstanceStatus[] | undefined;
  /** Her own Work, as the list names it. */
  selfId: string;
  /** Works she handed something to, watches, or opened for her owner, by ID. */
  notes: ReadonlyMap<string, WorkNote>;
  /** Works she is watching or opened herself: listed like her child Works. */
  followed: ReadonlySet<string>;
  reminders: readonly Reminder[];
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MAX_LISTED_WORKS = 12;

/**
 * What she should know at the start of a reply without calling a tool: the time, what woke her,
 * what the Works she handed things to are doing, and her waiting reminders. Other Works are only
 * counted, so the list never crowds out the conversation.
 */
export function renderStatus(input: StatusInput): string {
  const lines = [`[现状 · ${localMinute(input.now)} ${WEEKDAYS[input.now.getDay()]}] 这是 Dock 自动附上的，不是主人说的话。`, `叫醒你的：${input.wokenBy}`];
  if (input.works === undefined) {
    lines.push("现在读不到 Work 列表。");
  } else {
    const mine = input.works.filter((work) => work.id !== input.selfId && (work.parentId === input.selfId || input.followed.has(work.id)));
    const others = input.works.filter((work) => work.id !== input.selfId && work.parentId === undefined && !mine.includes(work));
    if (mine.length > 0) {
      lines.push("你派出去或在跟着的 Work：");
      for (const work of mine.slice(0, MAX_LISTED_WORKS)) lines.push(`- ${describeWork(work, input.now, input.notes.get(work.id), work.parentId === input.selfId)}`);
      if (mine.length > MAX_LISTED_WORKS) lines.push(`- 还有 ${mine.length - MAX_LISTED_WORKS} 个，用 dock_list 看。`);
    }
    if (others.length > 0) lines.push(`${mine.length > 0 ? "另有" : "主人现在有"} ${others.length} 个别的 Work，要看用 dock_list。`);
  }
  if (input.reminders.length > 0) {
    lines.push("没到点的提醒：");
    for (const reminder of input.reminders.slice(0, MAX_LISTED_WORKS)) lines.push(`- ${localMinute(new Date(reminder.at))} ${firstLine(reminder.text)}（#${reminder.id}）`);
    if (input.reminders.length > MAX_LISTED_WORKS) lines.push(`- 还有 ${input.reminders.length - MAX_LISTED_WORKS} 条。`);
  }
  return lines.join("\n");
}

function describeWork(work: ObservedInstanceStatus, now: Date, note: WorkNote | undefined, child: boolean): string {
  const name = `「${firstLine(work.name ?? work.id, 60)}」`;
  const since = elapsed(work.execution === "running" ? work.runStartedAt ?? work.executionChangedAt : work.executionChangedAt, now);
  const state = work.lifecycle !== "active" ? (work.lifecycle === "stopped" ? "已停止" : "已断开，没在运行")
    : work.execution === "running" ? `在干活，已 ${since}`
    : work.execution === "failed" ? `出错停下了，${since}前`
    : `空闲，${since}前停下`;
  const owes = child && note?.owes ? "；还欠你结果" : "";
  const said = note?.lastSaid ? `；最近说：${note.lastSaid}` : "";
  return `${child ? "子 Work" : "Work"}${name}${state}${owes}${said}`;
}

function elapsed(since: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(since)) / 60_000));
  if (!Number.isFinite(minutes)) return "不知多久";
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} 小时 ${minutes % 60} 分钟` : `${Math.floor(hours / 24)} 天`;
}

/** The first line of a text, short enough for a list. */
export function firstLine(text: string, max = 120): string {
  const line = text.trim().split(/\r?\n/u, 1)[0] ?? "";
  if (line.length <= max) return line;
  let end = max;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}…`;
}
