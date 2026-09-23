import { ref, type Ref } from 'vue'
import { readConversationContent } from './bridge'
import type { ConnectionContext } from './types'
import type { ConversationContentChange, useConversationContent } from './conversationContent'

export type ConversationScope = ConnectionContext & { instanceId: string; hostEpoch: string }

/** The conversation region talks to the local content owner. Its parent supplies
 * selection facts, not global refresh/reset/recovery business callbacks. */
export function useConversationSession(scope: Ref<ConversationScope | null>, content: ReturnType<typeof useConversationContent>) {
  const token = ref<string | null>(null)
  function bind(contentToken: string, canLoadEarlier: boolean) {
    const replaced = token.value !== null && token.value !== contentToken && content.state.value !== null
    token.value = contentToken
    content.hydrationActiveEntries.value = new Set()
    content.hydrationErrors.value = {}
    content.historyLoading.value = false
    content.historyError.value = null
    content.historyTruncated.value = canLoadEarlier
    if (content.state.value) content.state.value.historyTruncated = canLoadEarlier
    return replaced
  }
  function accept(contentToken: string, change: ConversationContentChange) {
    if (change.kind === 'checkpoint_begin') token.value = contentToken
    if (token.value !== contentToken) return
    content.applyContent(change)
  }
  async function request(intent: 'earlier' | 'retry' | 'interest', entryIds: string[] = []) {
    const target = scope.value, identity = token.value
    if (!target || !identity) return
    try { await readConversationContent(target, target.instanceId, target.hostEpoch, identity, intent, entryIds) }
    catch {
      const current = scope.value
      if (current?.connectionId === target.connectionId && current.selectionGeneration === target.selectionGeneration
        && current.instanceId === target.instanceId && current.hostEpoch === target.hostEpoch && token.value === identity) {
        content.historyError.value = '这部分对话暂时无法读取，请重试。'
      }
    }
  }
  return { bind, accept, failed: content.bindingFailed, matchesToken: (value: string) => token.value === value, loadEarlier: () => request('earlier'), retry: (entryId?: string) => request('retry', entryId ? [entryId] : []), setInterest: (entryIds: string[]) => request('interest', entryIds) }
}
