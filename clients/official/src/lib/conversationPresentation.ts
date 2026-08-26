import type { ConversationProcessItem } from './types'

export function assistantMarkdownSource(parts: readonly ConversationProcessItem[]): string {
  return parts
    .filter((part): part is Extract<ConversationProcessItem, { kind: 'assistant' }> => part.kind === 'assistant' && part.text.length > 0)
    .map((part) => part.text)
    .join('\n\n')
}
