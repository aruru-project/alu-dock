import type { ConversationItem, ConversationProcessItem } from './types'

export type GroupedProcessItem = ConversationProcessItem & { groupId: string }
export type StandaloneConversationRow = Extract<ConversationItem, { kind: 'user' | 'activity' | 'record' }> | Extract<ConversationProcessItem, { kind: 'notice' }>
export type AssistantGroupRow = { id: string; kind: 'assistant-group'; parts: GroupedProcessItem[]; time: string; sourceEntryIds?: string[] }
export type ConversationRow = StandaloneConversationRow | AssistantGroupRow

export function assistantMarkdownSource(parts: readonly ConversationProcessItem[]): string {
  return parts
    .filter((part): part is Extract<ConversationProcessItem, { kind: 'assistant' }> => part.kind === 'assistant' && part.text.length > 0)
    .map((part) => part.text)
    .join('\n\n')
}

export function conversationRows(items: readonly ConversationItem[]): ConversationRow[] {
  const rows: ConversationRow[] = []
  const groups = new Map<string, AssistantGroupRow>()
  for (const item of items) {
    if (isGroupedProcessItem(item)) {
      let group = groups.get(item.groupId)
      if (!group) {
        group = { id: item.groupId, kind: 'assistant-group', parts: [], time: '' }
        groups.set(item.groupId, group)
        rows.push(group)
      }
      group.sourceEntryIds = [...new Set([...(group.sourceEntryIds ?? []), ...(item.sourceEntryIds ?? [])])]
      group.parts.push(item)
      group.time ||= item.groupTime || (item.kind === 'assistant' ? item.time : '')
    } else {
      rows.push(item as StandaloneConversationRow)
    }
  }
  return rows
}

function isGroupedProcessItem(item: ConversationItem): item is GroupedProcessItem {
  return item.kind !== 'user' && item.kind !== 'activity' && item.kind !== 'record' && Boolean(item.groupId)
}
