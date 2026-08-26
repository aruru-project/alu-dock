import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ProjectedEvent, Work } from '../lib/types'

export interface CommandConsoleEntry {
  id: string
  kind: 'command' | 'status' | 'output'
  text: string
  level?: 'info' | 'warning' | 'error'
  operationId: string
}

interface CommandOperation {
  operationId: string
  completed: boolean
}

export interface CommandReceipt {
  operationId: string
  kind: 'prompt' | 'extension_command'
  queued: boolean
}

export const useCommandConsoleStore = defineStore('command-console', () => {
  const contextKey = ref('')
  const entries = ref<CommandConsoleEntry[]>([])
  const operations = ref<Record<string, CommandOperation>>({})
  const activeOperationId = ref('')
  let entrySequence = 0
  const knownOperationIds: string[] = []
  const successfulOperationIds = new Set<string>()

  const hasActiveOperation = computed(() => {
    const operation = operations.value[activeOperationId.value]
    return !!operation && !operation.completed
  })

  function bindContext(connectionId: string, selectionGeneration: number, work: Work) {
    const next = JSON.stringify([
      connectionId,
      selectionGeneration,
      work.id,
      work.ownerHostEpoch ?? '',
      work.runtimeGeneration,
    ])
    if (next === contextKey.value) return
    contextKey.value = next
    entries.value = []
    operations.value = {}
    activeOperationId.value = ''
    knownOperationIds.splice(0)
    successfulOperationIds.clear()
  }

  function beginOperation(operationId: string, name: string, argumentsText: string) {
    const argumentsValue = argumentsText.trim()
    rememberOperation(operationId)
    operations.value = {
      ...operations.value,
      [operationId]: { operationId, completed: false },
    }
    activeOperationId.value = operationId
    append({
      kind: 'command',
      text: `/${name}${argumentsValue ? ` ${argumentsValue}` : ''}`,
      operationId,
    })
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
    finish(operationId)
  }

  function failOperation(operationId: string, message: string): boolean {
    if (successfulOperationIds.has(operationId)) return false
    const operation = operations.value[operationId]
    if (!operation || operation.completed) return false
    operation.completed = true
    append({ kind: 'output', level: 'error', text: message || '命令执行失败。', operationId })
    finish(operationId)
    return true
  }

  function operationSucceeded(operationId: string) {
    return successfulOperationIds.has(operationId)
  }

  function handleDockEvent(event: ProjectedEvent): { matched: boolean; commandOrigin: boolean } {
    const operationId = typeof event.data.operationId === 'string' ? event.data.operationId : ''
    const operation = operationId ? operations.value[operationId] : undefined
    if (!operation) {
      if (operationId && event.eventType === 'command.handled' && knownOperationIds.includes(operationId)) {
        successfulOperationIds.add(operationId)
        return { matched: true, commandOrigin: true }
      }
      return { matched: false, commandOrigin: !!operationId }
    }

    switch (event.eventType) {
      case 'command.handled':
        successfulOperationIds.add(operationId)
        if (!operation.completed) {
          operation.completed = true
          finish(operationId)
        }
        break
      case 'command.rejected':
      case 'instance.error':
        failOperation(operationId, stringValue(event.data.error) || stringValue(event.data.reason) || '命令执行失败。')
        break
      case 'run.started':
        if (!operation.completed) {
          operation.completed = true
          append({ kind: 'status', text: '命令已启动 Agent；后续内容显示在主要对话。', operationId })
          finish(operationId)
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
    return { matched: true, commandOrigin: true }
  }

  function rememberOperation(operationId: string) {
    knownOperationIds.push(operationId)
    while (knownOperationIds.length > 128) {
      const removed = knownOperationIds.shift()
      if (removed) successfulOperationIds.delete(removed)
    }
  }

  function append(entry: Omit<CommandConsoleEntry, 'id'>) {
    if (!entry.text) return
    entrySequence += 1
    entries.value = [...entries.value, { ...entry, id: `${entry.operationId}:${entrySequence}` }]
  }

  function finish(operationId: string) {
    if (activeOperationId.value === operationId) activeOperationId.value = ''
  }

  return {
    entries,
    hasActiveOperation,
    bindContext,
    beginOperation,
    receiveReceipt,
    failOperation,
    operationSucceeded,
    handleDockEvent,
  }
})

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}
