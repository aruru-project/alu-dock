import type { ConversationBootstrap, HostContext, StopResult, Work } from './types'

export type FollowConnectionState = 'connected' | 'disconnected' | 'resync_required'
export interface FollowConnectionStatus {
  state: FollowConnectionState
  message?: string
}

/** Stable identity for the only boundaries that require a conversation reload. */
export function conversationBoundaryKey(
  hostId: string | null,
  selectionGeneration: number | null | undefined,
  workId: string | null | undefined,
): string {
  return JSON.stringify([hostId, selectionGeneration ?? null, workId ?? null])
}

type FollowActivation = {
  connected: boolean
  settled: boolean
  terminal?: FollowConnectionStatus
  resolve: () => void
  reject: (cause: Error) => void
}

/** Retains bootstrap follow status until publication makes that subscription active. */
export class FollowActivationCoordinator {
  private readonly activations = new Map<string, FollowActivation>()

  prepare(subscriptionId: string): Promise<void> {
    if (this.activations.has(subscriptionId)) throw new Error(`Follow ${subscriptionId} is already being prepared.`)
    return new Promise((resolve, reject) => {
      this.activations.set(subscriptionId, { connected: false, settled: false, resolve, reject })
    })
  }

  handleStatus(subscriptionId: string, status: FollowConnectionStatus): boolean {
    const activation = this.activations.get(subscriptionId)
    if (!activation) return false
    if (status.state === 'connected') {
      activation.connected = true
      if (!activation.settled) {
        activation.settled = true
        activation.resolve()
      }
    } else {
      activation.terminal = status
      if (!activation.settled) {
        activation.settled = true
        activation.reject(new Error(status.message || '连接状态已变化，请稍后重试。'))
      }
    }
    return true
  }

  activate(subscriptionId: string): FollowConnectionStatus | undefined {
    const activation = this.activations.get(subscriptionId)
    if (!activation?.connected) throw new Error('Follow 尚未连接，无法发布。')
    this.activations.delete(subscriptionId)
    return activation.terminal
  }

  cancel(subscriptionId: string, cause: Error): void {
    const activation = this.activations.get(subscriptionId)
    if (!activation) return
    this.activations.delete(subscriptionId)
    if (!activation.settled) {
      activation.settled = true
      activation.reject(cause)
    }
  }

  cancelAll(cause: Error): void {
    for (const subscriptionId of [...this.activations.keys()]) this.cancel(subscriptionId, cause)
  }
}

/** Matches WebConsole's compact metric density exactly. */
export function formatTokenCount(value?: number | null): string {
  if (value == null) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.floor(value / 1_000)}k`
  return String(value)
}

export function formatContextUsage(context?: { tokens?: number | null; contextWindow?: number; percent?: number | null }): string {
  return context
    ? `${formatTokenCount(context.tokens)}/${formatTokenCount(context.contextWindow)} (${context.percent == null ? '—' : `${context.percent.toFixed(1)}%`})`
    : '—'
}

/** Matches WebConsole's 160px sticky-bottom threshold without stealing an intentional history scroll. */
export function outputIsNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < 160
}

/** Admission success clears only the exact draft that was submitted; failures and concurrent typing are preserved. */
export function draftAfterSubmit(current: string, captured: string, succeeded: boolean): string {
  return succeeded && current === captured ? '' : current
}

/** A recovery candidate may replace the visible generation only after its follow registration is connected and correlated. */
export function conversationSwapIsCorrelated(
  context: HostContext,
  instanceId: string,
  candidate: ConversationBootstrap,
  followConnected: boolean,
): boolean {
  return followConnected
    && candidate.cursor.instanceId === instanceId
    && candidate.instance.id === instanceId
    && candidate.instance.ownerHostEpoch === candidate.cursor.hostEpoch
    && candidate.instance.runtimeGeneration === candidate.cursor.runtimeGeneration
    && context.hostId.length > 0
}

export function workLifecycleLabel(value: Work['lifecycle']): string {
  return ({
    active: '运行中',
    stopping: '正在停止',
    stopped: '已停止',
    host_lost: '连接已中断',
    runtime_error: '运行故障',
  } as Record<Work['lifecycle'], string>)[value]
}

export function stopConfirmationText(work: Work): string {
  return `停止整个 Work“${work.displayName}”？\n\n这会停止共享 Work、当前运行，并清空所有客户端已经获准的 Queue 项目。此设备上的本地草稿会保留。此操作不同于“中止当前回复”。`
}

export function stopCanStart(work: Work | null, workMutating: boolean, outcomeUnknown: boolean): boolean {
  return !!work && work.lifecycle === 'active' && !workMutating && !outcomeUnknown
}

export function stoppedResultIsCorrelated(result: StopResult, instanceId: string): boolean {
  return result.instance.id === instanceId
    && result.instance.lifecycle === 'stopped'
    && result.instance.execution === 'unavailable'
    && result.receipt.operationId.length > 0
}
