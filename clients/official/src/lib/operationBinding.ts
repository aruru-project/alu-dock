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

/** The reply was lost on the way back (core `unknown`). A Host-reported `effect_unknown` is a Host fact, not this. */
export function replyLost(cause: unknown): boolean {
  return !!cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true
}

// Whether these took effect shows in the conversation: a compaction notice, the new
// Session or branch, the Reload notice. A lost reply adds nothing to it, so it is not told.
const OUTCOME_IN_CONVERSATION = new Set(['compact_session', 'new_session', 'switch_session', 'reload_session', 'fork_session', 'clone_session'])
export function lostReplyIsSilent(kind: string): boolean {
  return OUTCOME_IN_CONVERSATION.has(kind)
}

export function operationWork(operation: NativeOperation): Work | undefined {
  const result = operation.result
  return result ? ('instance' in result ? result.instance : 'id' in result ? result : undefined) : undefined
}
