import type {
  AssistantEntryKind, AssistantExtractionStatus, AssistantMemory, AssistantMemoryAction, AssistantMemoryAuthor,
  AssistantMemoryChange, AssistantMemoryState, AssistantMemoryTopic, AssistantSessionInfo,
} from './types'

/** Who said an entry of her conversation, as the page labels it. */
export function assistantEntryLabel(kind: AssistantEntryKind, toolName?: string): string {
  if (kind === 'user') return '你'
  if (kind === 'assistant') return '助手'
  if (kind === 'tool_result') return toolName ? `工具结果 · ${toolName}` : '工具结果'
  if (kind === 'bash') return '命令'
  if (kind === 'summary') return '摘要'
  if (kind === 'notice') return '提示'
  if (kind === 'work') return '别的 Work'
  return '其他'
}

/** The session's name, or else the last two parts of its directory. */
export function assistantSessionLabel(session: AssistantSessionInfo): string {
  if (session.name?.trim()) return session.name.trim()
  const parts = (session.cwd ?? '').split(/[\\/]/u).filter(Boolean)
  return parts.length ? parts.slice(-2).join('/') : '未命名的对话'
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
export function assistantTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : timeFormat.format(date)
}

const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
/** A stretch of time: "2026/11/07 14:00 – 18:30" within one local day, both dates across days. */
export function assistantSpan(fromAt: string, toAt: string): string {
  const from = new Date(fromAt)
  const to = new Date(toAt)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${fromAt} – ${toAt}`
  const sameDay = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth() && from.getDate() === to.getDate()
  return `${timeFormat.format(from)} – ${sameDay ? clockFormat.format(to) : timeFormat.format(to)}`
}

/** UTF-8 size, the unit of the Host's document limit. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function kilobytes(bytes: number): string {
  const value = bytes / 1024
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

type Known<T> = Exclude<T, 'unrecognized'>

/** What her memories are about, in the order the page offers them. */
export const memoryTopics: ReadonlyArray<{ topic: Known<AssistantMemoryTopic>; label: string }> = [
  { topic: 'owner', label: '主人' },
  { topic: 'preferences', label: '喜好和习惯' },
  { topic: 'relationship', label: '我们之间' },
  { topic: 'events', label: '经历过的事' },
  { topic: 'self', label: '她自己' },
]

export function memoryTopicLabel(topic: AssistantMemoryTopic): string {
  return memoryTopics.find((item) => item.topic === topic)?.label ?? '其他'
}

/**
 * How much of a memory's length is used, against Main's `limit` (0 when not known). What is
 * counted is what would be saved: the text without the spaces around it, as a string's length.
 */
export function memoryLength(text: string, limit: number): { used: number; over: number; label: string } {
  const used = text.trim().length
  const over = limit > 0 && used > limit ? used - limit : 0
  return {
    used,
    over,
    label: over
      ? `超出 ${over} 字：一条记忆最多 ${limit} 字，请删到 ${limit} 字以内再保存。`
      : limit > 0 ? `${used} / ${limit} 字` : `${used} 字`,
  }
}

/** Whether every new session of hers reads it, or only her looking finds it. */
export function memoryResidentLabel(resident: boolean): string {
  return resident ? '每次都带上' : '她查的时候才用'
}

export function memoryStateLabel(state: AssistantMemoryState): string {
  return state === 'active' ? '在用' : state === 'retired' ? '已作废' : state === 'forgotten' ? '已删除' : '状态未知'
}

const WROTE: Record<Known<AssistantMemoryAuthor>, string> = { extraction: '从对话里记下', dreaming: '整理时记下', assistant: '她在对话里记下', owner: '你写的' }
const CHANGED: Record<Known<AssistantMemoryAuthor>, string> = { extraction: '从对话里改的', dreaming: '整理时改的', assistant: '她在对话里改的', owner: '你改的' }

/** Who made the latest change; a memory nobody changed since it was written says who wrote it. */
export function memoryAuthorLabel(memory: Pick<AssistantMemory, 'author' | 'revision'>): string {
  if (memory.author === 'unrecognized') return ''
  return (memory.revision <= 1 ? WROTE : CHANGED)[memory.author]
}

const ACTOR: Record<Known<AssistantMemoryAuthor>, string> = { extraction: '从对话里', dreaming: '整理时', assistant: '她在对话里', owner: '你' }
const ACTION: Record<Known<AssistantMemoryAction>, string> = {
  added: '记下', rewritten: '改写', moved: '换了分类', resident: '设为每次都带上', query_only: '设为她查的时候才用',
  retired: '作废', forgotten: '删除', restored: '恢复', merged: '合并进另一条',
}

/** One line of a memory's history: who did what. */
export function memoryChangeLabel(change: AssistantMemoryChange): string {
  const actor = change.author === 'unrecognized' ? '' : ACTOR[change.author]
  return `${actor}${change.action === 'unrecognized' ? '改动' : ACTION[change.action]}`
}

/** Making memories in the background, in a few words. */
export function extractionStateLabel(status: AssistantExtractionStatus): string {
  if (status.state === 'off') return '没在整理：还没选模型'
  if (status.state === 'working') return '正在整理'
  if (status.state === 'failed') return '上次没有整理成，等着自动再试'
  if (status.state === 'idle') return status.waitingSessions > 0 ? '等对话停下一阵再整理' : '都整理完了'
  return '这个客户端认不出现在的状态，请更新客户端'
}
