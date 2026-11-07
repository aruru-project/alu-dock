import { reactive } from 'vue'
import { getAssistantContext } from './bridge'
import { currentConnectionCall } from './hostResult'
import type { AssistantEntry, AssistantSessionInfo, ConnectionContext } from './types'
import { userErrorMessage } from './userError'

const CONTEXT_SPAN = 6
const CONTEXT_MORE = 12

/** One entry of her conversations to read around: a search hit, or where a memory was said. */
export interface ConversationPlace {
  sessionId: string
  entryId: string
  /** Shown until the read says where the conversation took place. */
  session?: AssistantSessionInfo
}

/** The entries read around one place, oldest first. */
export interface ConversationReading {
  place: ConversationPlace | null
  session: AssistantSessionInfo | null
  entries: AssistantEntry[]
  hasBefore: boolean
  hasAfter: boolean
  loading: boolean
  loadingBefore: boolean
  loadingAfter: boolean
  error: string
}

/**
 * Reading her conversation around one entry, then further back or on from the edge shown.
 * Each page that reads conversations keeps its own, so leaving one does not close the other.
 */
export function useConversationReading(app: { connectionContext: ConnectionContext | null }, messages: {
  failure: string
  /** The entry is no longer there; how to go on depends on where it was opened from. */
  notFound?: string
}) {
  const state = reactive<ConversationReading>({
    place: null, session: null, entries: [], hasBefore: false, hasAfter: false,
    loading: false, loadingBefore: false, loadingAfter: false, error: '',
  })
  let epoch = 0

  function close() {
    epoch++
    Object.assign(state, { place: null, session: null, entries: [], hasBefore: false, hasAfter: false, loading: false, loadingBefore: false, loadingAfter: false, error: '' })
  }

  async function open(place: ConversationPlace) {
    close()
    const current = epoch
    state.place = place
    state.session = place.session ?? null
    state.loading = true
    try {
      const result = await currentConnectionCall(app, (context) => getAssistantContext(place.sessionId, place.entryId, CONTEXT_SPAN, CONTEXT_SPAN, context))
      if (current !== epoch) return
      Object.assign(state, { session: result.session, entries: result.entries, hasBefore: result.hasBefore, hasAfter: result.hasAfter })
    } catch (cause) {
      if (current !== epoch) return
      const notFound = messages.notFound && cause && typeof cause === 'object' && 'code' in cause && cause.code === 'assistant_entry_not_found'
      state.error = notFound ? messages.notFound! : userErrorMessage(cause, messages.failure)
    } finally {
      if (current === epoch) state.loading = false
    }
  }

  /** Reads further back (`before`) or on (`after`) from the first or last entry shown. */
  async function readMore(direction: 'before' | 'after') {
    const session = state.session
    const edge = direction === 'before' ? state.entries[0] : state.entries.at(-1)
    if (!session || !edge || state.loadingBefore || state.loadingAfter || state.loading) return
    const current = epoch
    const flag = direction === 'before' ? 'loadingBefore' : 'loadingAfter'
    state[flag] = true
    state.error = ''
    try {
      const result = await currentConnectionCall(app, (context) => getAssistantContext(session.sessionId, edge.entryId,
        direction === 'before' ? CONTEXT_MORE : 0, direction === 'after' ? CONTEXT_MORE : 0, context))
      if (current !== epoch) return
      // The answer repeats the edge entry it was read from.
      const added = result.entries.filter((entry) => entry.entryId !== edge.entryId)
      if (direction === 'before') {
        state.entries = [...added, ...state.entries]
        state.hasBefore = result.hasBefore
      } else {
        state.entries = [...state.entries, ...added]
        state.hasAfter = result.hasAfter
      }
    } catch (cause) {
      if (current === epoch) state.error = userErrorMessage(cause, '没有读到更多对话。请重试。')
    } finally {
      if (current === epoch) state[flag] = false
    }
  }

  return { state, open, readMore, close }
}
