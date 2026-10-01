import type { ConversationItem, ConversationProcessItem, ConversationTurnItem, ConversationTurnStatus } from './types'

export type GroupedProcessItem = ConversationProcessItem & { groupId: string }
export type StandaloneConversationRow = Extract<ConversationItem, { kind: 'user' | 'turn' | 'record' | 'shell' }> | Extract<ConversationProcessItem, { kind: 'notice' }>
export type AssistantGroupRow = { id: string; kind: 'assistant-group'; parts: GroupedProcessItem[]; time: string; sourceEntryIds?: string[]; turnId?: string }
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
        group = { id: item.groupId, kind: 'assistant-group', parts: [], time: '', ...(item.turnId ? { turnId: item.turnId } : {}) }
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
  return item.kind !== 'user' && item.kind !== 'turn' && item.kind !== 'record' && item.kind !== 'shell' && Boolean(item.groupId)
}

/** One turn as the view lays it out: the user message(s) that opened it, its
 * summary line, and the body the summary line expands. Grouping is a pure
 * function of the flat rows; it owns no state. */
export interface ConversationTurnSection {
  kind: 'turn'
  id: string
  status: ConversationTurnStatus
  startedAt?: string
  endedAt?: string
  error?: string
  openers: ConversationRow[]
  body: ConversationRow[]
  toolCalls: number
  failedToolCalls: number
  /** The last Agent message of the turn. Its row stays when the body is collapsed,
   * so its text is visible and an incomplete preview still gets read in full. */
  finalRowId?: string
}
export type ConversationSection = ConversationTurnSection | { kind: 'row'; id: string; row: ConversationRow }

export function conversationSections(rows: readonly ConversationRow[]): ConversationSection[] {
  const sections: ConversationSection[] = []
  const owners = new Map<string, ConversationTurnSection>()
  for (const row of rows) {
    if (row.kind === 'turn') {
      const previous = row.continuation ? lastTurnSection(sections) : undefined
      if (previous) {
        // The live segment continues the history turn: the run is still this
        // one, so anything projected between them is part of its process.
        const trailing: ConversationRow[] = []
        while (sections[sections.length - 1] !== previous) {
          const section = sections.pop()!
          if (section.kind === 'row') trailing.unshift(section.row)
        }
        previous.body.push(...trailing)
        applyTurnFacts(previous, row)
        owners.set(row.turnId, previous)
        continue
      }
      const section: ConversationTurnSection = { kind: 'turn', id: row.turnId, status: row.status, openers: [], body: [], toolCalls: 0, failedToolCalls: 0 }
      applyTurnFacts(section, row)
      sections.push(section)
      owners.set(row.turnId, section)
      continue
    }
    const section = row.turnId ? owners.get(row.turnId) : undefined
    if (!section) {
      sections.push({ kind: 'row', id: row.id, row })
      continue
    }
    if (row.kind === 'user' && section.body.length === 0) section.openers.push(row)
    else section.body.push(row)
  }
  for (const section of sections) {
    if (section.kind !== 'turn') continue
    for (const row of section.body) {
      if (row.kind !== 'assistant-group') continue
      section.finalRowId = row.id
      for (const part of row.parts) {
        if (part.kind === 'tool') {
          section.toolCalls += 1
          if (part.status === 'error') section.failedToolCalls += 1
        }
      }
    }
  }
  return sections
}

function lastTurnSection(sections: ConversationSection[]): ConversationTurnSection | undefined {
  for (let index = sections.length - 1; index >= 0; index--) {
    const section = sections[index]!
    if (section.kind === 'turn') return section
  }
  return undefined
}

function applyTurnFacts(section: ConversationTurnSection, turn: ConversationTurnItem) {
  section.status = turn.status
  if (turn.startedAt && !section.startedAt) section.startedAt = turn.startedAt
  if (turn.status === 'running') delete section.endedAt
  else if (turn.endedAt) section.endedAt = turn.endedAt
  if (turn.error) section.error = turn.error
  else if (turn.status !== 'failed') delete section.error
}

/** What a collapsed turn still shows: the reader's own messages, images the Agent
 * produced, warnings and errors, and the final reply. Everything else is process.
 * In the final message every text block and notice stays; only its thinking and
 * tool calls fold. */
export function partVisibleWhenCollapsed(part: ConversationProcessItem, finalRow: boolean): boolean {
  if (finalRow) return part.kind !== 'thinking' && part.kind !== 'tool'
  return part.kind === 'image' || (part.kind === 'notice' && part.tone !== 'info')
}

export function rowVisibleWhenCollapsed(row: ConversationRow, finalRowId: string | undefined): boolean {
  if (row.kind === 'user' || row.id === finalRowId) return true
  if (row.kind === 'assistant-group' || row.kind === 'record') return row.parts.some((part) => partVisibleWhenCollapsed(part, false))
  if (row.kind === 'notice') return row.tone !== 'info'
  return false
}

/** The reader's own open/closed choice for a turn outlives the run's settlement
 * and the live→history id change, which lands the same turn at the same position. */
export function reconcileTurnOverrides(
  overrides: Map<string, boolean>,
  before: readonly string[],
  after: readonly string[],
  settled: Iterable<string>,
  awayFromBottom: boolean,
) {
  const known = new Set(before)
  // Where a turn known before now lives: itself, or the new id at its position.
  const landed = (id: string) => {
    if (after.includes(id)) return id
    const position = before.indexOf(id)
    const successor = position >= 0 ? after[position] : undefined
    return successor && !known.has(successor) ? successor : undefined
  }
  for (const [id, open] of [...overrides]) {
    if (after.includes(id) || !before.includes(id)) continue
    overrides.delete(id)
    const successor = landed(id)
    if (successor) overrides.set(successor, open)
  }
  // Settling folds the process by default, but not out from under someone reading it.
  for (const id of settled) {
    const target = landed(id)
    if (!target || overrides.has(target)) continue
    if (awayFromBottom) overrides.set(target, true)
  }
}

/** The turn whose collapsed body hides the row or part a saved reading position
 * points at; opening it lets the viewport find that element again. */
export function turnHidingAnchor(sections: readonly ConversationSection[], anchorId: string | undefined): ConversationTurnSection | undefined {
  if (!anchorId) return undefined
  for (const section of sections) {
    if (section.kind !== 'turn') continue
    for (const row of section.body) {
      if (row.id === anchorId) return rowVisibleWhenCollapsed(row, section.finalRowId) ? undefined : section
      if (row.kind !== 'assistant-group' && row.kind !== 'record') continue
      const part = row.parts.find((candidate) => candidate.id === anchorId)
      if (!part) continue
      const visible = rowVisibleWhenCollapsed(row, section.finalRowId) && partVisibleWhenCollapsed(part, row.id === section.finalRowId)
      return visible ? undefined : section
    }
  }
  return undefined
}

/** Only a running turn is measured against the clock; a settled turn without an
 * end time has no duration. */
export function turnDurationMs(section: Pick<ConversationTurnSection, 'status' | 'startedAt' | 'endedAt'>, now: number): number | undefined {
  if (!section.startedAt) return undefined
  const running = section.status === 'running'
  if (!running && !section.endedAt) return undefined
  const started = Date.parse(section.startedAt)
  const ended = running ? now : Date.parse(section.endedAt!)
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return undefined
  return Math.max(0, ended - started)
}

/** Settled turns read like a measurement (`4m 13s`); a running one ticks like a clock (`0:42`). */
export function formatTurnDuration(milliseconds: number, running: boolean): string {
  const total = Math.floor(milliseconds / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (running) {
    const clock = `${minutes}:${String(seconds).padStart(2, '0')}`
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : clock
  }
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function turnStatusLabel(status: ConversationTurnStatus): string {
  switch (status) {
    case 'running': return '运行中'
    case 'failed': return '失败'
    case 'aborted': return '已中止'
    case 'interrupted': return '未完成'
    default: return ''
  }
}

export function turnToolCallsLabel(section: Pick<ConversationTurnSection, 'status' | 'toolCalls' | 'failedToolCalls'>): string {
  if (!section.toolCalls) return section.status === 'running' ? '' : '没有工具调用'
  const failed = section.failedToolCalls ? `（${section.failedToolCalls} 次失败）` : ''
  return section.status === 'running' ? `已调用 ${section.toolCalls} 个工具${failed}` : `${section.toolCalls} 次工具调用${failed}`
}
