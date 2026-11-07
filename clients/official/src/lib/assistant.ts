import type { AssistantEntryKind, AssistantSessionInfo } from './types'

/** Who said an entry of her conversation, as the page labels it. */
export function assistantEntryLabel(kind: AssistantEntryKind, toolName?: string): string {
  if (kind === 'user') return '你'
  if (kind === 'assistant') return '助手'
  if (kind === 'tool_result') return toolName ? `工具结果 · ${toolName}` : '工具结果'
  if (kind === 'bash') return '命令'
  if (kind === 'summary') return '摘要'
  if (kind === 'notice') return '提示'
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

/** UTF-8 size, the unit of the Host's document limit. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function kilobytes(bytes: number): string {
  const value = bytes / 1024
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}
