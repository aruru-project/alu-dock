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

/**
 * Names the operations asked of one subject (a memory, a timeline line, a setting). The same
 * request sent again straight after its reply was lost names the same operation, so the Host
 * does it at most once. Anything else learnt of the subject since ends that: a different
 * request, or reading the subject after the reply was lost. The Host answers a repeated
 * operation with its first result without doing it again, so repeating one after the subject
 * moved on would report a state it is no longer in.
 */
export function onceAfterLostReply() {
  /** The latest request sent about each subject, until it is answered. */
  const latest = new Map<string, { request: string; operationId: string; replyLost: boolean }>()
  async function once<T>(subject: unknown[], request: unknown, send: (operationId: string) => Promise<T>): Promise<T> {
    const key = JSON.stringify(subject)
    const asked = JSON.stringify(request)
    const before = latest.get(key)
    const mine = { request: asked, operationId: before?.replyLost && before.request === asked ? before.operationId : crypto.randomUUID(), replyLost: false }
    latest.set(key, mine)
    try {
      const result = await send(mine.operationId)
      if (latest.get(key) === mine) latest.delete(key)
      return result
    } catch (cause) {
      if (replyLost(cause)) mine.replyLost = true
      else if (latest.get(key) === mine) latest.delete(key)
      throw cause
    }
  }
  /**
   * The subject was read. A request whose reply was lost before this is no longer waiting to be
   * repeated; one still on its way keeps its name, so asking again after losing its reply is
   * still done once.
   */
  function known(subject: unknown[]) {
    const key = JSON.stringify(subject)
    if (latest.get(key)?.replyLost) latest.delete(key)
  }
  return Object.assign(once, { known })
}

// Whether these took effect shows in the conversation: a compaction notice, the new
// Session or branch, the Reload notice, the shell command's row. A lost reply adds
// nothing to it, so it is not told.
const OUTCOME_IN_CONVERSATION = new Set([
  'compact_session', 'new_session', 'switch_session', 'reload_session', 'navigate_session', 'fork_session', 'clone_session',
  'run_shell_command', 'abort_shell_commands',
])
export function lostReplyIsSilent(kind: string): boolean {
  return OUTCOME_IN_CONVERSATION.has(kind)
}

export function operationWork(operation: NativeOperation): Work | undefined {
  const result = operation.result
  return result ? ('instance' in result ? result.instance : 'id' in result ? result : undefined) : undefined
}
