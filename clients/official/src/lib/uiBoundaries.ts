import type { ConversationBootstrap, ConnectionContext, StopResult, Work } from './types'

/** WebView focus is authoritative when the native window focus snapshot races page reload. */
export function initialWindowFocused(
  nativeFocused: boolean,
  webViewFocused: boolean,
  visibleMobileWebView: boolean,
): boolean {
  return nativeFocused || webViewFocused || visibleMobileWebView
}

/** Stable identity for the only boundaries that require a conversation reload. */
export function conversationBoundaryKey(
  connectionId: string | null,
  selectionGeneration: number | null | undefined,
  workId: string | null | undefined,
): string {
  return JSON.stringify([connectionId, selectionGeneration ?? null, workId ?? null])
}

/** Matches WebConsole's compact metric density exactly. */
export function formatTokenCount(value?: number | null): string {
  const number = value == null ? NaN : Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${Math.floor(number / 1_000)}k`
  return String(number)
}

/** Same session-total cache ratio as the Work TUI; output tokens are not input cache usage. */
export function formatCacheHitRate(tokens?: NonNullable<Work['metrics']>['tokens']): string {
  if (tokens?.input == null || tokens.cacheRead == null || tokens.cacheWrite == null) return '—'
  const inputTotal = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return inputTotal > 0 ? `${Math.round(tokens.cacheRead / inputTotal * 100)}%` : '—'
}

/** Top bar: `245k/372k (65.9%)`. The project status panel lists it as `245k/372k · 65.9%`
 * and shows `—` until the context window is known. */
export function formatContextUsage(context?: { tokens?: number | null; contextWindow?: number; percent?: number | null }, layout: 'bar' | 'status' = 'bar'): string {
  if (!context || (layout === 'status' && !context.contextWindow)) return '—'
  const used = `${formatTokenCount(context.tokens)}/${formatTokenCount(context.contextWindow)}`
  const percent = context.percent == null ? '—' : `${context.percent.toFixed(1)}%`
  return layout === 'status' ? `${used} · ${percent}` : `${used} (${percent})`
}

/** Admission success clears only the exact draft that was submitted; failures and concurrent typing are preserved. */
export function draftAfterSubmit(current: string, captured: string, succeeded: boolean): string {
  return succeeded && current === captured ? '' : current
}

/** Correlate a committed native read with its display binding. */
export function conversationReadMatches(
  context: ConnectionContext,
  instanceId: string,
  candidate: ConversationBootstrap,
): boolean {
  return candidate.cursor.instanceId === instanceId
    && candidate.instance.id === instanceId
    && candidate.instance.ownerHostEpoch === candidate.cursor.hostEpoch
    && candidate.instance.runtimeGeneration === candidate.cursor.runtimeGeneration
    && context.connectionId.length > 0
}

export type WorkPresenceTone =
  | 'running' | 'idle' | 'waiting' | 'compacting'
  | 'failed' | 'stopping' | 'stopped' | 'lost' | 'error'

/**
 * Dock 权威实例语义（humanInstanceStatus + activityFromSnapshot）：lifecycle 只说明
 * 实例是否存在；agent 是否在做事要看 execution / compacting / activeInteraction。
 * 列表与状态面板的灯和文案只能从这里取，不得再各自从 lifecycle 拼。
 */
export function workPresence(
  work: Pick<Work, 'lifecycle' | 'execution' | 'compacting' | 'activeInteraction'>,
): { tone: WorkPresenceTone; label: string } {
  if (work.lifecycle === 'unrecognized' || work.execution === 'unrecognized') return { tone: 'idle', label: '状态未知，请更新客户端' }
  if (work.lifecycle === 'stopped') return { tone: 'stopped', label: '已停止' }
  if (work.lifecycle === 'host_lost') return { tone: 'lost', label: '连接已中断' }
  if (work.lifecycle === 'runtime_error') return { tone: 'error', label: '运行故障' }
  if (work.lifecycle === 'stopping') return { tone: 'stopping', label: '正在停止' }
  if (work.compacting) return { tone: 'compacting', label: '压缩中' }
  if (work.execution === 'running') {
    return work.activeInteraction ? { tone: 'waiting', label: '等待确认' } : { tone: 'running', label: '运行中' }
  }
  if (work.execution === 'failed') return { tone: 'failed', label: '运行失败' }
  if (work.execution === 'unavailable') return { tone: 'failed', label: '无响应' }
  return { tone: 'idle', label: '空闲' }
}

export function stopConfirmationText(work: Work): string {
  return `停止整个 Work“${work.displayName}”？\n\n这会停止共享 Work、当前运行，并清空所有客户端已经获准的 Queue 项目。此设备上的本地草稿会保留。此操作不同于“中止当前回复”。`
}

export function stopCanStart(work: Work | null, workMutating: boolean): boolean {
  return !!work && ['active', 'stopping', 'runtime_error'].includes(work.lifecycle) && !workMutating
}

export function stoppedResultIsCorrelated(result: StopResult, instanceId: string): boolean {
  return result.instance.id === instanceId
    && result.instance.lifecycle === 'stopped'
    && result.instance.execution === 'unavailable'
    && result.receipt.operationId.length > 0
}
