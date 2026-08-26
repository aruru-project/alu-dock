import type { AttachmentDto, ConnectionContext, ProjectedEvent, QueueItem, Work } from './types'

export interface LiveProjectionState extends ConnectionContext {
  hostEpoch: string
  instance: Work
  queue: QueueItem[]
  sequence: number
}

export interface LiveEventEnvelope extends ConnectionContext {
  instanceId: string
  event: ProjectedEvent
}

export type LiveReduction =
  | { kind: 'ignored'; state: LiveProjectionState; reason: 'stale_identity' | 'stale_event' }
  | { kind: 'rebuild'; state: LiveProjectionState; reason: 'generation_boundary' | 'sequence_gap' }
  | { kind: 'applied'; state: LiveProjectionState; conversationChanged: boolean; configChanged: boolean }

const conversationEvents = new Set([
  'message.submitted', 'message.delta', 'message.completed',
  'tool.started', 'tool.args_updated', 'tool.output_updated', 'tool.completed',
  'run.settled', 'run.retry_started', 'run.retry_completed',
  'compaction.started', 'compaction.completed',
  'instance.stopped', 'instance.runtime_error', 'instance.error', 'command.rejected',
  'resources.reloaded', 'settings.write_failed',
  'extension.notification', 'extension.error',
])
const configEvents = new Set([
  'model.changed', 'thinking.changed', 'settings.changed', 'settings.write_failed',
  'resources.reloaded', 'extension.status_changed', 'extension.tools_expanded_changed',
])

/** Reduce one already authenticated follow event without crossing connection, Work, or generation boundaries. */
export function reduceLiveEvent(state: LiveProjectionState, envelope: LiveEventEnvelope): LiveReduction {
  const event = envelope.event
  if (envelope.connectionId !== state.connectionId
    || envelope.selectionGeneration !== state.selectionGeneration
    || envelope.instanceId !== state.instance.id) {
    return { kind: 'ignored', state, reason: 'stale_identity' }
  }
  if (event.runtimeGeneration < state.instance.runtimeGeneration
    || (event.runtimeGeneration === state.instance.runtimeGeneration && event.sequence <= state.sequence)) {
    return { kind: 'ignored', state, reason: 'stale_event' }
  }
  if (event.runtimeGeneration !== state.instance.runtimeGeneration
    || event.eventType === 'session.replaced') {
    return { kind: 'rebuild', state, reason: 'generation_boundary' }
  }
  if (event.sequence !== state.sequence + 1) return { kind: 'rebuild', state, reason: 'sequence_gap' }

  const instance: Work = {
    ...state.instance,
    pending: { ...state.instance.pending },
    executor: { ...state.instance.executor, model: state.instance.executor.model ? { ...state.instance.executor.model } : undefined },
    extensionStatus: { ...state.instance.extensionStatus },
    updatedAt: event.occurredAt,
  }
  let queue = state.queue.map((item) => ({ ...item, attachments: item.attachments.map((attachment) => ({ ...attachment })) }))
  const data = event.data

  switch (event.eventType) {
    case 'run.started':
      instance.execution = 'running'
      instance.lastError = undefined
      break
    case 'run.settled': {
      const result = enumValue(data.result, ['never', 'succeeded', 'failed', 'aborted', 'interrupted'] as const)
      if (result) instance.lastRun = result
      if (instance.compacting) {
        // A compaction may start before the preceding run's settlement is published.
        // That older settlement must not erase the newer active execution boundary.
        instance.execution = 'running'
      } else {
        instance.execution = result === 'failed' ? 'failed' : instance.lifecycle === 'active' ? 'idle' : 'unavailable'
      }
      instance.lastError = result === 'failed' ? stringValue(data.error) : undefined
      break
    }
    case 'message.queued': {
      const queueItemId = stringValue(data.queueItemId)
      if (queueItemId && !queue.some((item) => item.queueItemId === queueItemId)) {
        const delivery = stringValue(data.delivery) || 'followUp'
        queue.push({
          queueItemId,
          delivery,
          text: stringValue(data.text) || '',
          attachments: attachmentArray(data.attachments),
          imageCount: Array.isArray(data.images) ? data.images.length : 0,
          acceptedAt: stringValue(data.acceptedAt) || event.occurredAt,
        })
        incrementPending(instance, delivery, 1)
      }
      break
    }
    case 'message.submitted': {
      const queueItemId = stringValue(data.queueItemId)
      if (queueItemId) queue = queue.filter((item) => item.queueItemId !== queueItemId)
      // queue.changed is the authoritative post-consumption count. Decrementing here
      // would apply the same dequeue twice and could expose Abort while work remains.
      break
    }
    case 'queue.changed': {
      const pending = pendingValue(data)
      if (pending) instance.pending = pending
      break
    }
    case 'queue.cleared': {
      const ids = stringArray(data.queueItemIds)
      if (ids.length) queue = queue.filter((item) => !ids.includes(item.queueItemId))
      else if (data.reason !== 'dequeued') queue = []
      const removed = pendingValue(data)
      if (removed) {
        const steering = Math.max(0, instance.pending.steering - removed.steering)
        const followUp = Math.max(0, instance.pending.followUp - removed.followUp)
        instance.pending = {
          steering,
          followUp,
          total: Math.max(steering + followUp, instance.pending.total - removed.total, 0),
        }
      }
      break
    }
    case 'instance.state_changed': {
      instance.lifecycle = enumValue(data.lifecycle, ['active', 'stopping', 'stopped', 'host_lost', 'runtime_error'] as const) ?? instance.lifecycle
      instance.execution = enumValue(data.execution, ['idle', 'running', 'failed', 'unavailable'] as const) ?? instance.execution
      if (typeof data.compacting === 'boolean') instance.compacting = data.compacting
      instance.lastRun = enumValue(data.lastRun, ['never', 'succeeded', 'failed', 'aborted', 'interrupted'] as const) ?? instance.lastRun
      instance.pending = pendingValue(data.pending) ?? instance.pending
      instance.lastError = stringValue(data.lastError)
      break
    }
    case 'instance.stopped':
      instance.lifecycle = 'stopped'
      instance.execution = 'unavailable'
      instance.compacting = false
      instance.ownerHostEpoch = undefined
      instance.pending = { steering: 0, followUp: 0, total: 0 }
      instance.activeInteraction = undefined
      queue = []
      break
    case 'instance.runtime_error':
      instance.lifecycle = 'runtime_error'
      instance.execution = 'unavailable'
      instance.ownerHostEpoch = undefined
      instance.lastError = stringValue(data.error)
      break
    case 'compaction.started':
      instance.execution = 'running'
      instance.compacting = true
      break
    case 'compaction.completed':
      instance.compacting = false
      if (!data.willRetry) instance.execution = 'idle'
      if (typeof data.error === 'string') instance.lastError = data.error
      break
    case 'model.changed': {
      const provider = stringValue(data.provider)
      const id = stringValue(data.id)
      if (provider && id) instance.executor.model = { provider, id }
      const thinking = stringValue(data.thinkingLevel)
      if (thinking) instance.executor.thinkingLevel = thinking
      break
    }
    case 'thinking.changed': {
      const thinking = stringValue(data.thinkingLevel)
      if (thinking) instance.executor.thinkingLevel = thinking
      break
    }
    case 'git.branch_changed':
      instance.gitBranch = stringValue(data.branch)
      break
    case 'session.metrics_changed':
      if (isRecord(data.metrics)) instance.metrics = structuredClone(data.metrics) as Work['metrics']
      break
    case 'session.info_changed':
      instance.name = stringValue(data.name)
      instance.displayName = stringValue(data.displayName) || instance.displayName
      break
    case 'extension.status_changed': {
      const key = stringValue(data.key)
      if (key) {
        const text = stringValue(data.text)
        if (text === undefined) delete instance.extensionStatus[key]
        else instance.extensionStatus[key] = text
      }
      break
    }
    case 'extension.tools_expanded_changed':
      if (typeof data.expanded === 'boolean') instance.toolsExpanded = data.expanded
      break
    case 'interaction.requested': {
      const id = stringValue(data.interactionId)
      const method = enumValue(data.method, ['select', 'confirm', 'input', 'editor'] as const)
      if (id && method) instance.activeInteraction = { id, method, expiresAt: stringValue(data.expiresAt) }
      break
    }
    case 'interaction.resolved':
    case 'interaction.cancelled':
      if (data.interactionId === instance.activeInteraction?.id) instance.activeInteraction = undefined
      break
  }

  return {
    kind: 'applied',
    state: { ...state, instance, queue, sequence: event.sequence },
    conversationChanged: conversationEvents.has(event.eventType),
    configChanged: configEvents.has(event.eventType),
  }
}

function incrementPending(instance: Work, delivery: string, delta: number) {
  const key = delivery === 'steer' ? 'steering' : 'followUp'
  instance.pending[key] = Math.max(0, instance.pending[key] + delta)
  instance.pending.total = Math.max(instance.pending.steering + instance.pending.followUp, instance.pending.total + delta, 0)
}

function pendingValue(value: unknown): Work['pending'] | undefined {
  if (!isRecord(value)
    || !Number.isFinite(value.steering)
    || !Number.isFinite(value.followUp)
    || !Number.isFinite(value.total)) return undefined
  const steering = Math.max(0, value.steering as number)
  const followUp = Math.max(0, value.followUp as number)
  return { steering, followUp, total: Math.max(steering + followUp, value.total as number, 0) }
}
function attachmentArray(value: unknown): AttachmentDto[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is AttachmentDto => {
    if (!isRecord(item)) return false
    return typeof item.fileId === 'string' && typeof item.name === 'string' && typeof item.sizeBytes === 'number'
      && typeof item.sha256 === 'string' && typeof item.storedAt === 'string'
  }).map((item) => ({ ...item }))
}
function stringValue(value: unknown) { return typeof value === 'string' ? value : undefined }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : undefined
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
