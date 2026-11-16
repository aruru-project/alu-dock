import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ConversationBootstrap, ProjectedEvent } from '../lib/types'
import { useAppStore } from './app'

export interface CommandConsoleEntry {
  id: string
  kind: 'command' | 'status' | 'output'
  text: string
  level?: 'info' | 'warning' | 'error'
  operationId: string
}

interface CommandOperation {
  connectionId: string
  connectionHostEpoch: string
  contextKey: string
  /** Whether the command itself is still active; handoff is not an outcome. */
  active: boolean
  succeeded: boolean
  sequence: number
}

export interface CommandReceipt {
  operationId: string
  kind: 'prompt' | 'extension_command'
  queued: boolean
}

export const useCommandConsoleStore = defineStore('command-console', () => {
  const app = useAppStore()
  // Results belong to the Work/runtime that started them, not the open panel or
  // current visit. Switching away and back must not send their replay into chat.
  const contextKey = computed(() => scopeKey(app.activeConnectionId ?? '', app.selectedWork?.id ?? '',
    app.selectedWork?.ownerHostEpoch ?? '', app.selectedWork?.runtimeGeneration ?? 0))
  const output = ref<CommandConsoleEntry[]>([])
  const operations = ref<Record<string, CommandOperation>>({})
  const entries = computed(() => output.value.filter(entry => operations.value[entry.operationId]?.contextKey === contextKey.value))
  let entrySequence = 0
  onScopeDispose(() => { operations.value = {}; output.value = [] })

  // Null payloads mean a connection is being changed/read, not that its Works
  // were deleted. Only an accepted list/runtime/Host identity retires output.
  watch(() => {
    const payload = app.payload
    return payload ? JSON.stringify([payload.connectionId, payload.host.hostEpoch,
      payload.works.map(work => scopeKey(payload.connectionId, work.id, work.ownerHostEpoch ?? '', work.runtimeGeneration))]) : ''
  }, () => {
    const payload = app.payload
    if (!payload) return
    const current = new Set(payload.works.map(work => scopeKey(payload.connectionId, work.id, work.ownerHostEpoch ?? '', work.runtimeGeneration)))
    retire(operation => operation.connectionId === payload.connectionId
      && (operation.connectionHostEpoch !== payload.host.hostEpoch || !current.has(operation.contextKey)))
  }, { flush: 'sync' })
  watch(() => app.catalog?.hosts.map(host => host.hostId), hosts => {
    if (hosts) retire(operation => operation.connectionId !== 'local' && !hosts.includes(operation.connectionId))
  }, { flush: 'sync' })

  function retire(obsolete: (operation: CommandOperation) => boolean) {
    let removed = false
    for (const [id, operation] of Object.entries(operations.value)) {
      if (!obsolete(operation)) continue
      delete operations.value[id]
      removed = true
    }
    if (removed) output.value = output.value.filter(entry => operations.value[entry.operationId])
  }

  const hasActiveOperation = computed(() => Object.values(operations.value).some(operation => operation.contextKey === contextKey.value && operation.active))

  function isActive(operationId: string) {
    const operation = operations.value[operationId]
    return !!operation && operation.contextKey === contextKey.value && operation.active
  }

  function beginOperation(operationId: string, name: string, argumentsText: string) {
    const argumentsValue = argumentsText.trim()
    operations.value[operationId] = { connectionId: app.activeConnectionId ?? '', connectionHostEpoch: app.payload?.host.hostEpoch ?? '',
      contextKey: contextKey.value, active: true, succeeded: false, sequence: -1 }
    append({ kind: 'command', text: `/${name}${argumentsValue ? ` ${argumentsValue}` : ''}`, operationId })
  }

  function receiveReceipt(operationId: string, receipt: CommandReceipt) {
    const operation = operations.value[operationId]
    if (!operation || !operation.active || receipt.operationId !== operationId) return
    if (receipt.kind === 'extension_command') return
    operation.active = false
    append({
      kind: 'status',
      text: receipt.queued ? '已加入 Queue。' : '已交给 Agent，后续内容显示在主要对话。',
      operationId,
    })
  }

  function failOperation(operationId: string, message: string): boolean {
    // A lost call reply cannot undo an observed success. A real failure event,
    // however, is still reported after a prompt/Queue handoff or run.started.
    if (operations.value[operationId]?.succeeded) return false
    return reportFailure(operationId, message)
  }

  function reportFailure(operationId: string, message: string): boolean {
    const operation = operations.value[operationId]
    if (!operation) return false
    operation.active = false
    operation.succeeded = false
    append({ kind: 'output', level: 'error', text: message || '命令执行失败。', operationId })
    return true
  }

  function operationSucceeded(operationId: string) {
    return operations.value[operationId]?.succeeded === true
  }

  /** True only for output owned here. All other events keep their ordinary display path. */
  function handleDockEvent(connectionId: string, cursor: ConversationBootstrap['cursor'], event: ProjectedEvent): boolean {
    const operationId = typeof event.data.operationId === 'string' ? event.data.operationId : ''
    const operation = operationId ? operations.value[operationId] : undefined
    if (!operation || operation.contextKey !== scopeKey(connectionId, cursor.instanceId, cursor.hostEpoch, event.runtimeGeneration)) return false
    const ownsOutput = event.eventType === 'extension.notification' || event.eventType === 'command.rejected'
      || (event.eventType === 'instance.error' && event.data.source === 'command_background')
    // A cached view can replay events already displayed here, even after its
    // control facts have advanced. It still belongs here, but is not appended again.
    if (event.sequence <= operation.sequence) return ownsOutput
    operation.sequence = event.sequence

    switch (event.eventType) {
      case 'command.handled':
        operation.succeeded = true
        operation.active = false
        break
      case 'command.rejected':
      case 'instance.error':
        if (ownsOutput) reportFailure(operationId, stringValue(event.data.error) || stringValue(event.data.reason) || '命令执行失败。')
        break
      case 'run.started':
        if (operation.active) {
          operation.active = false
          append({ kind: 'status', text: '命令已启动 Agent；后续内容显示在主要对话。', operationId })
        }
        break
      case 'extension.notification':
        append({
          kind: 'output',
          level: event.data.level === 'error' ? 'error' : event.data.level === 'warning' ? 'warning' : 'info',
          text: stringValue(event.data.message),
          operationId,
        })
        break
    }
    return ownsOutput
  }

  function append(entry: Omit<CommandConsoleEntry, 'id'>) {
    if (!entry.text) return
    // notify(error), a thrown command failure and its receipt can describe the
    // same error. Only coalesce within this one command; other commands stay visible.
    if (entry.level === 'error' && output.value.some(old => old.operationId === entry.operationId && old.level === 'error' && old.text === entry.text)) return
    entrySequence += 1
    output.value.push({ ...entry, id: `${entry.operationId}:${entrySequence}` })
  }

  return { entries, hasActiveOperation, isActive, beginOperation, receiveReceipt, failOperation, operationSucceeded, handleDockEvent }
})

function scopeKey(connectionId: string, workId: string, hostEpoch: string, runtimeGeneration: number) {
  return JSON.stringify([connectionId, workId, hostEpoch, runtimeGeneration])
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}
