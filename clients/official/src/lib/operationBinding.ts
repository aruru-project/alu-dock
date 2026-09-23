import type { AttachmentDto, Work, QueueDequeueResult } from './types'

export interface EditorCapture {
  connectionId: string
  workId: string
  sessionId: string
  text: string
  textRevision?: string
  attachments: { attachment: AttachmentDto; revision?: string }[]
}
export interface NativeOperation {
  operationId: string
  kind: string
  connectionId: string
  instanceId: string
  hostEpoch: string
  runtimeGeneration: number
  sessionId: string
  editor: EditorCapture | null
  state: 'pending' | 'unknown' | 'succeeded' | 'failed'
  result?: Work | QueueDequeueResult | { instance: Work; cancelled?: boolean; editorText?: string; selectedText?: string; receipt?: { queued: boolean } } | null
  error?: { code?: string; outcomeUnknown?: boolean; operationId?: string; message?: string }
}
/** Frozen at the user action, never looked up implicitly by the IPC bridge. */
export interface OperationTarget {
  connectionId: string
  selectionGeneration: number
  instanceId: string
  expectedHostEpoch: string
  expectedRuntimeGeneration: number
}
/** Actions that consume or replace the original editor require a durable capture. */
export interface OperationContext extends OperationTarget {
  operationEditor: EditorCapture
}
export interface HostOperationContext {
  connectionId: string
  selectionGeneration: number
  expectedHostEpoch: string
}

export function operationDomain(kind: string): string {
  if (['set_model', 'set_thinking'].includes(kind)) return 'models'
  if (kind === 'set_active_tools') return 'tools'
  if (kind === 'update_setting') return 'settings'
  if (['navigate_session', 'fork_session', 'clone_session'].includes(kind)) return 'tree'
  if (kind.endsWith('_session')) return kind === 'adopt_session' ? 'work' : 'sessions'
  if (['create_work', 'reopen_work', 'forget_work', 'stop_work', 'set_system_default'].includes(kind)) return 'work'
  return 'conversation'
}
export function operationWork(operation: NativeOperation): Work | undefined {
  const result = operation.result
  return result ? ('instance' in result ? result.instance : 'id' in result ? result : undefined) : undefined
}
