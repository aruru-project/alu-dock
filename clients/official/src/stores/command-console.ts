import { computed, ref } from 'vue'
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
  contextKey: string
  completed: boolean
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

  const hasActiveOperation = computed(() => Object.values(operations.value).some(operation => operation.contextKey === contextKey.value && !operation.completed))

  function isActive(operationId: string) {
    const operation = operations.value[operationId]
    return !!operation && operation.contextKey === contextKey.value && !operation.completed
  }

  function beginOperation(operationId: string, name: string, argumentsText: string) {
    const argumentsValue = argumentsText.trim()
    operations.value[operationId] = { contextKey: contextKey.value, completed: false, succeeded: false, sequence: -1 }
    append({ kind: 'command', text: `/${name}${argumentsValue ? ` ${argumentsValue}` : ''}`, operationId })
  }

  function receiveReceipt(operationId: string, receipt: CommandReceipt) {
    const operation = operations.value[operationId]
    if (!operation || operation.completed || receipt.operationId !== operationId) return
    if (receipt.kind === 'extension_command') return
    operation.completed = true
    append({
      kind: 'status',
      text: receipt.queued ? '已加入 Queue。' : '已交给 Agent，后续内容显示在主要对话。',
      operationId,
    })
  }

  function failOperation(operationId: string, message: string): boolean {
    const operation = operations.value[operationId]
    if (!operation || operation.completed || operation.succeeded) return false
    operation.completed = true
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
        operation.completed = true
        break
      case 'command.rejected':
      case 'instance.error':
        if (ownsOutput) failOperation(operationId, stringValue(event.data.error) || stringValue(event.data.reason) || '命令执行失败。')
        break
      case 'run.started':
        if (!operation.completed) {
          operation.completed = true
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
