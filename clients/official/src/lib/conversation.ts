import type {
  AttachmentDto,
  ContentBlock,
  ConversationBootstrap,
  ConversationItem,
  ConversationProcessItem,
  ConversationRecord,
  ConversationTurnItem,
  ConversationTurnStatus,
  ProjectedEvent,
  PublishedFileDto,
  ToolCallPreview,
} from './types'

type ToolItem = Extract<ConversationProcessItem, { kind: 'tool' }>
type ImageItem = Extract<ConversationProcessItem, { kind: 'image' }>
interface ToolProjection {
  item: ToolItem
  args?: unknown
  outputText?: string
  images: ImageItem[]
  omitted: Set<string>
}
interface RecordGroup {
  key: string
  records: ConversationRecord[]
}

const COMMAND_PREVIEW_CHARS = 320
const CONTENT_PREVIEW_CHARS = 280
const EDIT_SIDE_PREVIEW_CHARS = 120
export function toolDetailText(item: ToolItem): string {
  if (item.detailArgs === undefined && item.detailOutputText === undefined && !item.detailOmittedFields?.length) return item.detail ?? ''
  const sections: string[] = []
  if (item.detailArgs !== undefined) sections.push(`参数\n${JSON.stringify(item.detailArgs, null, 2)}`)
  if (item.detailOutputText !== undefined) sections.push(`结果\n${item.detailOutputText}`)
  if (item.detailOmittedFields?.length) sections.push(`未载入内容\n${item.detailOmittedFields.join('\n')}`)
  return sections.join('\n\n')
}

export function standardToolCallPreview(toolName: string, args: unknown): ToolCallPreview | undefined {
  if (!isRecord(args)) return undefined
  if (toolName === 'bash' && typeof args.command === 'string') {
    const command = textPrefix(args.command, COMMAND_PREVIEW_CHARS, 3)
    return {
      title: typeof args.timeout === 'number' ? `timeout ${args.timeout}s` : undefined,
      body: command.text,
      variant: 'command',
      truncated: command.truncated,
    }
  }
  if (toolName === 'read' && typeof args.path === 'string') {
    const range = [
      typeof args.offset === 'number' ? `offset ${args.offset}` : '',
      typeof args.limit === 'number' ? `limit ${args.limit}` : '',
    ].filter(Boolean).join(' · ')
    return { title: args.path, body: range || undefined, variant: 'path', truncated: false }
  }
  if (toolName === 'write' && typeof args.path === 'string' && typeof args.content === 'string') {
    const content = textTail(args.content, CONTENT_PREVIEW_CHARS, 4)
    return { title: args.path, body: content.text, variant: 'content', truncated: content.truncated }
  }
  if (toolName === 'edit' && typeof args.path === 'string' && Array.isArray(args.edits) && args.edits.length > 0) {
    const first = args.edits[0]
    if (!isRecord(first) || typeof first.oldText !== 'string' || typeof first.newText !== 'string') return undefined
    const oldText = textPrefix(first.oldText, EDIT_SIDE_PREVIEW_CHARS, 2)
    const newText = textPrefix(first.newText, EDIT_SIDE_PREVIEW_CHARS, 2)
    return {
      title: `${args.path} · ${args.edits.length} 处`,
      body: `− ${oldText.text}\n＋ ${newText.text}`,
      variant: 'diff',
      truncated: args.edits.length > 1 || oldText.truncated || newText.truncated,
    }
  }
  return undefined
}

function textPrefix(value: string, maximumCharacters: number, maximumLines: number) {
  const window = value.slice(0, maximumCharacters * 2)
  const characters = Array.from(window)
  let text = characters.slice(0, maximumCharacters).join('')
  let truncated = window.length < value.length || characters.length > maximumCharacters
  const lines = text.split('\n')
  if (lines.length > maximumLines) {
    text = lines.slice(0, maximumLines).join('\n')
    truncated = true
  }
  return { text: truncated ? `${text}…` : text, truncated }
}

function textTail(value: string, maximumCharacters: number, maximumLines: number) {
  const window = value.slice(-(maximumCharacters * 2 + 2))
  const characters = Array.from(window)
  let text = characters.slice(-maximumCharacters).join('')
  let truncated = window.length < value.length || characters.length > maximumCharacters
  const lines = text.split('\n')
  if (lines.length > maximumLines) {
    text = lines.slice(-maximumLines).join('\n')
    truncated = true
  }
  return { text: truncated ? `…${text}` : text, truncated }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A run.settled result or a Work's lastRun, as the turn the user sees. */
export function turnStatusFromRunResult(result: unknown): ConversationTurnStatus {
  return result === 'failed' ? 'failed' : result === 'aborted' ? 'aborted' : result === 'interrupted' ? 'interrupted' : 'completed'
}

export function liveDeltaKey(data: Record<string, unknown>): string | null {
  const messageId = typeof data.messageId === 'string' ? data.messageId : ''
  if (!messageId) return null
  return `${messageId}:${data.block === 'thinking' ? 'thinking' : 'text'}`
}

/** 把同一 messageId:block 的 delta 折叠进已入队的第一个事件；回放结果与逐条回放完全一致
 * （文本是追加语义，message.completed 是整体替换语义，折叠都不改变最终投影）。
 *  返回 true 表示折叠进了既有事件（activeEvents 未变长）。 */
export function foldLiveDelta(events: ProjectedEvent[], foldMap: Map<string, ProjectedEvent>, event: ProjectedEvent): boolean {
  const key = liveDeltaKey(event.data)
  if (!key) return false
  const previous = foldMap.get(key)
  if (!previous) {
    foldMap.set(key, event)
    events.push(event)
    return false
  }
  previous.data = { ...previous.data, delta: `${typeof previous.data.delta === 'string' ? previous.data.delta : ''}${typeof event.data.delta === 'string' ? event.data.delta : ''}` }
  return true
}

/** Pi emits cumulative text both as text and as public text content blocks. */
export function foldableToolEvent(event: ProjectedEvent) {
  return (event.eventType === 'tool.args_updated' || event.eventType === 'tool.output_updated')
    && typeof event.data.toolCallId === 'string' && Boolean(event.data.toolCallId)
    && event.data.publishedFile === undefined
    && (event.data.content === undefined || (Array.isArray(event.data.content)
      && event.data.content.every((block) => isRecord(block) && block.type === 'text')))
}

/** Coalesce invisible intermediate values, never lifecycle/image/owner boundaries. */
export function mergeLiveEvents(previous: ProjectedEvent, event: ProjectedEvent): ProjectedEvent | null {
  if (previous.eventType !== event.eventType || previous.runtimeGeneration !== event.runtimeGeneration) return null
  if (event.eventType === 'message.delta' && liveDeltaKey(event.data) && liveDeltaKey(previous.data) === liveDeltaKey(event.data)) {
    return { ...event, occurredAt: previous.occurredAt, data: { ...previous.data, ...event.data,
      delta: `${previous.data.delta ?? ''}${event.data.delta ?? ''}` } }
  }
  if (!foldableToolEvent(previous) || !foldableToolEvent(event) || previous.data.toolCallId !== event.data.toolCallId) return null
  const omitted = [...(Array.isArray(previous.data.omittedFields) ? previous.data.omittedFields : []), ...(Array.isArray(event.data.omittedFields) ? event.data.omittedFields : [])]
  return { ...event, occurredAt: previous.occurredAt, data: { ...previous.data, ...event.data,
    ...(omitted.length ? { omittedFields: [...new Set(omitted)] } : {}) } }
}

const toolStagingGroup = (toolCallId: string) => `live-tool-staging:${toolCallId}`

export function projectConversation(bootstrap: ConversationBootstrap): ConversationItem[] {
  const live = createLiveConversationProjector(bootstrap)
  for (const event of bootstrap.activeEvents) live.apply(event)
  return [...projectRecordGroups(bootstrap.records), ...live.snapshot()]
}

const CONTINUATION_TURN_ID = 'live-turn-continuation'

/** One canonical live algorithm, used both by bootstrap replay and incremental Follow.
 * Maps retain message/tool ownership; settled history is never revisited by apply. */
export function createLiveConversationProjector(
  bootstrap: ConversationBootstrap,
  observe: <T extends object>(value: T) => T = (value) => value,
) {
  const items = observe<ConversationItem[]>([])
  const messageItems = observe(new Map<string, ConversationItem>())
  const toolItems = observe(new Map<string, ToolProjection>())
  const toolOwners = new Map<string, string>()
  const imageItems = observe(new Map<string, ImageItem>())
  // The running turn. Items pushed while it is open belong to it; between
  // run.settled and the next run.started, items stand on their own.
  let turn: ConversationTurnItem | undefined
  let turnHasItems = false

  function openTurn(id: string, startedAt: string | undefined, continuation: boolean) {
    turn = observe<ConversationTurnItem>({ id, kind: 'turn', turnId: id, status: 'running', ...(startedAt ? { startedAt } : {}), ...(continuation ? { continuation: true } : {}) })
    turnHasItems = false
    items.push(turn)
  }
  /** A running segment seen without run.started turns out to be a new run after all. */
  function adoptTurn(sequence: number, startedAt: string) {
    if (!turn) return
    turn.id = turn.turnId = `live-turn-${sequence}`
    turn.startedAt = startedAt
    turn.continuation = false
  }
  function settleTurn(status: ConversationTurnStatus, endedAt?: string, error?: string) {
    if (!turn) return
    turn.status = status
    if (endedAt) turn.endedAt = endedAt
    if (error) turn.error = error
    turn = undefined
  }
  // A read can find the run already in progress: its earlier part is history and
  // its run.started is not replayed, so this segment continues the turn before it.
  if (bootstrap.instance.execution === 'running') openTurn(CONTINUATION_TURN_ID, undefined, true)

  function apply(event: ProjectedEvent) {
    const before = items.length
    applyEvent(event)
    if (turn) for (let index = before; index < items.length; index++) {
      const item = items[index]!
      if (item.kind === 'turn') continue
      item.turnId = turn.turnId
      turnHasItems = true
    }
  }

  function applyEvent(event: ProjectedEvent) {
    const data = event.data
    let formattedTime: string | undefined
    const time = () => formattedTime ??= shortTime(event.occurredAt)
    switch (event.eventType) {
      case 'run.started':
        if (turn?.continuation && !turnHasItems) adoptTurn(event.sequence, event.occurredAt)
        else {
          settleTurn('completed')
          openTurn(`live-turn-${event.sequence}`, event.occurredAt, false)
        }
        break
      case 'message.submitted': {
        if (turn?.continuation && !turnHasItems && data.delivery === 'prompt') adoptTurn(event.sequence, event.occurredAt)
        const messageId = String(data.messageId || `submitted-${event.sequence}`)
        const item: ConversationItem = {
          id: `live-${messageId}`,
          kind: 'user',
          text: String(data.text || ''),
          time: time(),
          attachments: attachmentArray(data.attachments),
        }
        items.push(item)
        messageItems.set(messageId, item)
        break
      }
      case 'message.delta': {
        const messageId = String(data.messageId || `message-${event.sequence}`)
        const groupId = `live-message:${messageId}`
        const block = data.block === 'thinking' ? 'thinking' : 'text'
        const delta = String(data.delta || '')
        let item = messageItems.get(`${messageId}:${block}`)
        if (!item) {
          item = block === 'thinking'
            ? { id: `live-${messageId}-thinking`, kind: 'thinking', groupId, title: '思考中', text: '', open: true, groupTime: time() }
            : { id: `live-${messageId}`, kind: 'assistant', groupId, text: '', time: time(), groupTime: time() }
          items.push(item)
          messageItems.set(`${messageId}:${block}`, item)
        }
        if (item.kind === 'assistant' || item.kind === 'thinking') item.text += delta
        break
      }
      case 'message.completed': {
        const messageId = String(data.messageId || `message-${event.sequence}`)
        const blocks = Array.isArray(data.content) ? (data.content as ContentBlock[]) : []
        const text = blockText(blocks, 'text')
        const thinking = blockText(blocks, 'thinking')
        if (data.role === 'user') {
          const existing = messageItems.get(messageId)
          const user = projectUserMessage(blocks, attachmentArray(data.attachments), `live-${messageId}`, time())
          if (existing?.kind === 'user') {
            existing.text = user.text
            existing.time = user.time
            existing.attachments = user.attachments
            existing.images = user.images
          } else if (user.text || user.attachments?.length || user.images?.length) {
            const item: ConversationItem = { id: `live-${messageId}`, kind: 'user', ...user }
            items.push(item)
            messageItems.set(messageId, item)
          }
          break
        }

        if (data.role === 'tool') {
          const result = blocks.find((block) => block.type === 'tool_result')
          const toolCallId = result?.type === 'tool_result' ? result.toolCallId : typeof data.toolCallId === 'string' ? data.toolCallId : undefined
          const groupId = toolCallId ? toolOwners.get(toolCallId) ?? toolStagingGroup(toolCallId) : `live-message:${messageId}`
          const contentImages = blocks.map((block, index) => applyLiveContentBlock(block, groupId, `live-${messageId}-content-${index}`, toolItems, toolOwners, imageItems, items, '', toolCallId))
          const tool = toolCallId ? toolItems.get(toolCallId) : undefined
          if (tool) for (const image of contentImages) {
            if (image && !tool.images.some((item) => item.imageKey === image.imageKey)) tool.images.push(image)
          }
          break
        }

        if (data.role !== 'assistant') {
          if (text) items.push({ id: `live-${messageId}`, kind: 'notice', tone: data.error ? 'error' : 'info', text })
          break
        }

        const groupId = `live-message:${messageId}`
        const textItem = messageItems.get(`${messageId}:text`)
        if (textItem?.kind === 'assistant') {
          textItem.text = text
          textItem.groupTime = time()
        } else if (text) {
          const item: ConversationItem = { id: `live-${messageId}`, kind: 'assistant', groupId, text, time: time(), groupTime: time() }
          items.push(item)
          messageItems.set(`${messageId}:text`, item)
        }
        const thinkingItem = messageItems.get(`${messageId}:thinking`)
        if (thinkingItem?.kind === 'thinking') {
          thinkingItem.text = thinking
          thinkingItem.groupTime = time()
          thinkingItem.open = false
        } else if (thinking) {
          const item: ConversationItem = { id: `live-${messageId}-thinking`, kind: 'thinking', groupId, title: '思考过程', text: thinking, groupTime: time() }
          items.push(item)
          messageItems.set(`${messageId}:thinking`, item)
        }
        blocks.forEach((block, index) => applyLiveContentBlock(block, groupId, `live-${messageId}-content-${index}`, toolItems, toolOwners, imageItems, items, time()))
        // Inside a run the same error ends it and reaches the turn summary through run.settled.
        if (typeof data.error === 'string' && data.error && !turn) {
          items.push({ id: `live-${messageId}-error`, kind: 'notice', groupId, tone: 'error', text: data.error, groupTime: time() })
        }
        break
      }
      case 'tool.started':
      case 'tool.args_updated':
      case 'tool.output_updated':
      case 'tool.completed': {
        const toolCallId = String(data.toolCallId || `tool-${event.sequence}`)
        const groupId = toolOwners.get(toolCallId) || toolStagingGroup(toolCallId)
        const tool = ensureTool(toolItems, items, toolCallId, String(data.toolName || 'tool'), groupId, `live-tool-${toolCallId}`)
        if (data.toolName) tool.item.name = String(data.toolName)
        if (data.args !== undefined) {
          tool.item.preview = standardToolCallPreview(tool.item.name, data.args)
          if (tool.item.name !== 'show_image') tool.args = data.args
        }
        if (typeof data.text === 'string' && tool.item.name !== 'show_image') tool.outputText = data.text
        addOmitted(tool, data.omittedFields)
        tool.item.groupTime ||= time()
        const eventContent = Array.isArray(data.content) ? (data.content as ContentBlock[]) : []
        eventContent.forEach((block, index) => {
          if (block.type === 'image') {
            const image = ensureContentImage(block, `live-tool-${toolCallId}-content-${index}`, groupId, items, imageItems)
            image.groupTime ||= time()
            if (!tool.images.some((item) => item.imageKey === image.imageKey)) tool.images.push(image)
          }
        })
        const publishedFile = publishedFileFrom(data.publishedFile)
        if (publishedFile) ensurePublishedImage(tool, publishedFile, items, imageItems)
        if (tool.item.name === 'show_image' && (typeof data.text === 'string' || publishedFile)) {
          tool.outputText = safeShowImageOutput(Boolean(data.isError), publishedFile)
        }
        if (event.eventType === 'tool.completed') {
          tool.item.status = data.isError ? 'error' : 'done'
          tool.item.summary = data.isError ? '工具调用失败' : '工具调用完成'
        }
        renderToolDetail(tool)
        break
      }
      case 'extension.notification': {
        const message = stringValue(data.message)
        if (message) appendLiveNotice(items, event, notificationTone(data.level), message)
        break
      }
      case 'extension.error': {
        const message = stringValue(data.error)
        if (message) appendLiveNotice(items, event, 'error', message)
        break
      }
      case 'resources.reloaded': {
        const count = Array.isArray(data.resources) ? data.resources.length : 0
        appendLiveNotice(items, event, 'info', `资源已重新加载（${count}）`)
        break
      }
      case 'settings.write_failed': {
        const message = stringValue(data.error)
        if (message) appendLiveNotice(items, event, 'error', `${stringValue(data.key) ? `${stringValue(data.key)}：` : ''}${message}`)
        break
      }
      case 'run.retry_started': {
        const attempt = Number(data.attempt)
        const maximum = Number(data.maxAttempts)
        const prefix = Number.isFinite(attempt) && Number.isFinite(maximum) ? `正在重试（${attempt}/${maximum}）` : '正在重试'
        appendLiveNotice(items, event, 'info', `${prefix}${stringValue(data.error) ? `：${stringValue(data.error)}` : '…'}`)
        break
      }
      case 'run.retry_completed': {
        const succeeded = data.success === true
        appendLiveNotice(items, event, succeeded ? 'info' : 'error', succeeded ? '重试已恢复。' : stringValue(data.error) || '重试没有成功。')
        break
      }
      case 'compaction.started': {
        const text = data.reason === 'threshold' ? '上下文接近上限，正在自动压缩…'
          : data.reason === 'overflow' ? '上下文超过模型限制，正在自动压缩…'
          : data.reason === 'manual' ? '正在执行手动压缩…' : '正在压缩上下文…'
        appendLiveNotice(items, event, 'info', text)
        break
      }
      case 'compaction.completed':
        appendLiveNotice(items, event, data.error ? 'error' : data.aborted ? 'warning' : 'info', stringValue(data.error) || (data.aborted ? '上下文压缩已取消。' : '上下文压缩完成。'))
        break
      case 'instance.stopped':
        appendLiveNotice(items, event, Array.isArray(data.cleanupErrors) && data.cleanupErrors.length ? 'error' : 'info', 'Work 已停止。')
        break
      case 'instance.runtime_error':
      case 'instance.error':
      case 'command.rejected': {
        const message = stringValue(data.error) || stringValue(data.reason)
        if (message) appendLiveNotice(items, event, 'error', message)
        break
      }
      case 'run.settled': {
        const result = typeof data.result === 'string' ? data.result : ''
        for (const tool of toolItems.values()) {
          if (tool.item.status !== 'running') continue
          tool.item.status = result === 'succeeded' ? 'done' : 'error'
          tool.item.summary = result === 'succeeded' ? '工具调用完成' : result === 'aborted' ? '工具调用已中止' : '工具调用未完成'
        }
        toolItems.clear()
        // The turn summary carries the outcome; a separate notice would repeat it.
        settleTurn(turnStatusFromRunResult(result), event.occurredAt, result === 'failed' ? (typeof data.error === 'string' && data.error ? data.error : '运行失败。') : undefined)
        break
      }
    }
  }
  function affectedIds(event: ProjectedEvent): Set<string> {
    const ids = new Set<string>()
    const add = (item?: ConversationItem) => { if (item) ids.add(item.id) }
    const message = (id: string) => {
      add(messageItems.get(id)); add(messageItems.get(`${id}:text`)); add(messageItems.get(`${id}:thinking`))
    }
    const tool = (id: string) => {
      const projection = toolItems.get(id)
      add(projection?.item)
      projection?.images.forEach(add)
      const owner = toolOwners.get(id)
      if (owner?.startsWith('live-message:')) message(owner.slice('live-message:'.length))
    }
    if (typeof event.data.messageId === 'string') message(event.data.messageId)
    if (typeof event.data.toolCallId === 'string') tool(event.data.toolCallId)
    if (Array.isArray(event.data.content)) for (const block of event.data.content) {
      if (isRecord(block) && typeof block.toolCallId === 'string') tool(block.toolCallId)
    }
    if (event.eventType === 'run.settled') {
      for (const projection of toolItems.values()) if (projection.item.status === 'running') add(projection.item)
      add(turn)
    }
    // Entries without an existing target append at the live tail. Historical
    // layout changes/hydration use the separate unconditional anchor path.
    return ids
  }
  /** A recovery read can confirm completion without replaying run.settled, or
   * find a run in progress whose events were never delivered here. */
  function reconcileRun(instance: ConversationBootstrap['instance']) {
    if (instance.execution !== 'running') settleTurn(turnStatusFromRunResult(instance.lastRun), undefined, instance.lastError)
    else if (!turn) openTurn(CONTINUATION_TURN_ID, undefined, true)
  }
  return { apply, snapshot: () => items, affectedIds, reconcileRun, structureKey: () => `${items.length}` }
}

export function projectRecordGroups(records: ConversationRecord[]): ConversationItem[] {
  const output: ConversationItem[] = []
  const groups = groupRecords(records)
  const turns = historyTurns(groups)
  groups.forEach((group, index) => {
    const turn = turns.get(index)
    if (turn?.opener === index) output.push(turn.item)
    const start = output.length
    projectGroup(group, output)
    // The turn summary already shows the error that ended the turn.
    if (turn?.errorRecordId) {
      const carried = output.findIndex((item, position) => position >= start && item.id === `${turn.errorRecordId}-error`)
      if (carried >= 0) output.splice(carried, 1)
    }
    const entryIds = group.records.map(record => record.entryId)
    for (let index = start; index < output.length; index++) {
      const item = output[index]!
      item.sourceEntryIds = entryIds
      if (turn) item.turnId = turn.item.turnId
      if (item.kind === 'record') for (const part of item.parts) part.sourceEntryIds = entryIds
    }
  })
  return output
}

interface HistoryTurn { opener: number; item: ConversationTurnItem; errorRecordId?: string }

/** History has no run boundaries. A user message opens a turn that runs to the last
 * message record before the next user message; later summaries or shell records
 * between two turns stand on their own. Duration is the span of record timestamps,
 * which Pi writes at message end, so both ends sit close to the real run. */
function historyTurns(groups: RecordGroup[]): Map<number, HistoryTurn> {
  const turns = new Map<number, HistoryTurn>()
  const openers = groups.flatMap((group, index) => isUserMessageGroup(group) ? [index] : [])
  openers.forEach((opener, position) => {
    const next = openers[position + 1] ?? groups.length
    let end = opener
    for (let index = opener + 1; index < next; index++) if (groups[index]!.records[0]!.kind === 'message') end = index
    const records = groups.slice(opener, end + 1).flatMap((group) => group.records)
    const user = groups[opener]!.records[0]!
    const lastAssistant = lastWhere(records, (record) => record.kind === 'message' && record.source === 'assistant')
    const endedAt = lastWhere(records, (record) => record !== user && Boolean(record.timestamp))?.timestamp
    const status: ConversationTurnStatus = lastAssistant?.error || lastAssistant?.stopReason === 'error' ? 'failed'
      : lastAssistant?.stopReason === 'aborted' ? 'aborted'
      // Only the last turn can still be unfinished; an earlier one that ends in a
      // tool call was continued by the next user message (a steer).
      : position === openers.length - 1 && (!lastAssistant || lastAssistant.stopReason === 'toolUse') ? 'interrupted'
      : 'completed'
    const turnId = `turn:${user.recordId}`
    const item: ConversationTurnItem = {
      id: turnId, kind: 'turn', turnId, status,
      ...(user.timestamp ? { startedAt: user.timestamp } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(status === 'failed' ? { error: lastAssistant?.error || '运行失败。' } : {}),
    }
    const turn: HistoryTurn = { opener, item, ...(status === 'failed' && lastAssistant?.error ? { errorRecordId: lastAssistant.recordId } : {}) }
    for (let index = opener; index <= end; index++) turns.set(index, turn)
  })
  return turns
}

function lastWhere<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index--) if (predicate(values[index]!)) return values[index]
  return undefined
}

function isUserMessageGroup(group: RecordGroup) {
  const first = group.records[0]
  return Boolean(first && first.kind === 'message' && first.source === 'user' && group.records.length === 1)
}

function groupRecords(records: ConversationRecord[]) {
  const groups: RecordGroup[] = []
  const toolOwners = new Map<string, RecordGroup>()
  for (const record of records) {
    if (record.visibility !== 'conversation') continue
    const resultOwner = record.content
      .filter((part): part is Extract<ContentBlock, { type: 'tool_result' }> => part.type === 'tool_result')
      .map((part) => toolOwners.get(part.toolCallId))
      .find(Boolean)
    const recordOwner = record.toolCallId ? toolOwners.get(record.toolCallId) : undefined
    let group = resultOwner || (record.source === 'tool' ? recordOwner : undefined)
    if (!group) {
      group = { key: `record:${record.recordId}`, records: [] }
      groups.push(group)
    }
    group.records.push(record)
    if (record.toolCallId && record.source !== 'tool') toolOwners.set(record.toolCallId, group)
    for (const part of record.content) {
      if (part.type === 'tool_call' && part.toolCallId) toolOwners.set(part.toolCallId, group)
    }
  }
  return groups
}

function projectGroup(group: RecordGroup, output: ConversationItem[]) {
  const first = group.records[0]
  if (!first) return
  if (isUserMessageGroup(group)) {
    output.push({ id: first.recordId, kind: 'user', ...projectUserMessage(first.content, first.attachments ?? [], first.recordId, shortTime(first.timestamp), first.entryId) })
    return
  }
  if (first.kind === 'compaction_summary' || first.kind === 'branch_summary') {
    output.push(projectPanel(group, first.kind === 'compaction_summary' ? '上下文摘要' : '分支摘要', 'alu-record-summary', true))
    return
  }
  if (first.kind === 'bash_execution') {
    output.push(projectPanel(group, '运行记录', 'alu-record-shell', true))
    return
  }
  if (first.kind === 'custom_message') {
    output.push(projectPanel(group, '扩展消息', 'alu-record-extension', false))
    return
  }

  const hasAssistant = group.records.some((record) => record.kind === 'message' && record.source === 'assistant')
  const hasTool = group.records.some((record) => record.source === 'tool' || record.content.some((part) => part.type === 'tool_call' || part.type === 'tool_result'))
  if (hasAssistant) {
    const parts = projectRecordContent(group)
    const groupTime = shortTime(group.records.find((record) => record.timestamp)?.timestamp)
    if (!parts.length) {
      parts.push({ id: `${group.key}-empty`, kind: 'notice', groupId: group.key, tone: 'info', text: group.records.find((record) => record.stopReason)?.stopReason || '没有返回内容。', groupTime })
    } else {
      parts[0]!.groupTime = groupTime
    }
    output.push(...parts)
  } else if (hasTool) {
    output.push(projectPanel(group, '工具', 'alu-record-tool', false))
  } else {
    const title = first.source === 'extension' ? '扩展消息' : first.source === 'system' || first.source === 'runtime' ? '运行记录' : '对话记录'
    output.push(projectPanel(group, title, 'alu-record-system', false))
  }
}

function projectPanel(group: RecordGroup, title: string, panelClass: string, folded: boolean): Extract<ConversationItem, { kind: 'record' }> {
  return { id: group.key, kind: 'record', title, panelClass, folded, parts: projectRecordContent(group) }
}

function projectRecordContent(group: RecordGroup) {
  const parts: ConversationProcessItem[] = []
  const tools = new Map<string, ToolProjection>()
  const images = new Map<string, ImageItem>()
  for (const record of group.records) {
    record.content.forEach((block, index) => appendBlock(block, `${record.recordId}-${index}`, group.key, parts, tools, images, record.entryId))
    if (record.error) parts.push({ id: `${record.recordId}-error`, kind: 'notice', groupId: group.key, tone: 'error', text: record.error })
  }
  return parts
}

function appendBlock(block: ContentBlock, id: string, groupId: string, output: ConversationProcessItem[], tools: Map<string, ToolProjection>, images: Map<string, ImageItem>, historyEntryId?: string) {
  if (block.type === 'text') {
    output.push({ id, kind: 'assistant', groupId, text: block.text, time: '' })
  } else if (block.type === 'thinking') {
    output.push({ id, kind: 'thinking', groupId, title: '思考过程', text: block.text })
  } else if (block.type === 'image') {
    ensureContentImage(block, id, groupId, output, images, historyEntryId)
  } else if (block.type === 'tool_call') {
    const tool = ensureTool(tools, output, block.toolCallId, block.toolName, groupId, id)
    tool.item.preview = standardToolCallPreview(block.toolName, block.args)
    if (block.toolName !== 'show_image') tool.args = block.args
    addOmitted(tool, block.omittedFields)
    renderToolDetail(tool)
  } else if (block.type === 'tool_result') {
    const tool = ensureTool(tools, output, block.toolCallId, block.toolName, groupId, id)
    tool.item.name = block.toolName || tool.item.name
    tool.item.status = block.isError ? 'error' : 'done'
    tool.item.summary = block.isError ? '工具调用失败' : '工具调用完成'
    const publishedFile = publishedFileFrom(block.publishedFile)
    tool.outputText = block.toolName === 'show_image' ? safeShowImageOutput(block.isError, publishedFile) : block.text
    addOmitted(tool, block.omittedFields)
    if (publishedFile) ensurePublishedImage(tool, publishedFile, output, images)
    renderToolDetail(tool)
  } else if (block.type === 'omitted') {
    output.push({ id, kind: 'notice', groupId, tone: 'info', text: block.description || '这部分内容暂时没有载入。请刷新对话后重试。' })
  }
}

function applyLiveContentBlock(
  block: ContentBlock,
  groupId: string,
  id: string,
  tools: Map<string, ToolProjection>,
  owners: Map<string, string>,
  images: Map<string, ImageItem>,
  output: ConversationItem[],
  groupTime = '',
  owningToolId?: string,
) {
  if (block.type === 'image') {
    const image = ensureContentImage(block, id, groupId, output, images)
    image.groupTime ||= groupTime
    const tool = owningToolId ? tools.get(owningToolId) : undefined
    if (tool && !tool.images.some((item) => item.imageKey === image.imageKey)) tool.images.push(image)
    return image
  }
  if (block.type !== 'tool_call' && block.type !== 'tool_result') return
  if (block.type === 'tool_call') owners.set(block.toolCallId, groupId)
  else groupId = owners.get(block.toolCallId) ?? toolStagingGroup(block.toolCallId)
  const tool = ensureTool(tools, output, block.toolCallId, block.toolName, groupId, `live-tool-${block.toolCallId}`)
  tool.item.groupId = groupId
  tool.item.groupTime ||= groupTime
  for (const image of tool.images) {
    image.groupId = groupId
    image.groupTime ||= groupTime
  }
  if (block.type === 'tool_call') {
    tool.item.name = block.toolName || tool.item.name
    tool.item.preview = standardToolCallPreview(block.toolName, block.args)
    if (block.toolName !== 'show_image') tool.args = block.args
  } else {
    tool.item.name = block.toolName || tool.item.name
    tool.item.status = block.isError ? 'error' : 'done'
    tool.item.summary = block.isError ? '工具调用失败' : '工具调用完成'
    const publishedFile = publishedFileFrom(block.publishedFile)
    tool.outputText = block.toolName === 'show_image' ? safeShowImageOutput(block.isError, publishedFile) : block.text
    if (publishedFile) ensurePublishedImage(tool, publishedFile, output, images)
  }
  addOmitted(tool, block.omittedFields)
  renderToolDetail(tool)
}

function ensureTool(
  tools: Map<string, ToolProjection>,
  output: Array<ConversationItem | ConversationProcessItem>,
  toolCallId: string,
  toolName: string,
  groupId: string,
  id: string,
) {
  let tool = tools.get(toolCallId)
  if (tool) return tool
  const item: ToolItem = { id, kind: 'tool', groupId, toolCallId, name: toolName || 'tool', summary: '正在运行工具', status: 'running' }
  tool = { item, images: [], omitted: new Set() }
  tools.set(toolCallId, tool)
  output.push(item)
  return tool
}

function ensureContentImage(
  block: Extract<ContentBlock, { type: 'image' }>,
  id: string,
  groupId: string,
  output: Array<ConversationItem | ConversationProcessItem>,
  images: Map<string, ImageItem>,
  historyEntryId?: string,
): ImageItem {
  const contentRef = typeof block.contentRef === 'string' && block.contentRef ? block.contentRef : undefined
  const data = typeof block.data === 'string' && block.data ? block.data : undefined
  const imageKey = contentRef ? `conversation:${contentRef}` : `inline:${id}`
  let item = images.get(imageKey)
  if (!item) {
    item = {
      id: contentRef ? `${id}:${contentRef}` : id,
      kind: 'image',
      groupId,
      imageKey,
      mimeType: block.mimeType,
      fileId: block.fileId,
      source: block.nativeMedia
        ? { type: 'native', media: block.nativeMedia }
        : contentRef
        ? { type: 'conversation', contentRef, mimeType: block.mimeType }
        : data
          ? { type: 'inline', data, mimeType: block.mimeType }
          : undefined,
      historyEntryId,
    }
    images.set(imageKey, item)
    output.push(item)
  } else {
    item.groupId = groupId
    item.historyEntryId ||= historyEntryId
  }
  return item
}

function ensurePublishedImage(
  tool: ToolProjection,
  file: PublishedFileDto,
  output: Array<ConversationItem | ConversationProcessItem>,
  images: Map<string, ImageItem>,
): ImageItem {
  const imageKey = `published:${file.fileRef}`
  let item = images.get(imageKey)
  if (!item) {
    item = {
      id: `${tool.item.id}-image:${file.fileRef}`,
      kind: 'image',
      groupId: tool.item.groupId,
      imageKey,
      mimeType: file.mediaType || '',
      name: file.name,
      sizeBytes: file.sizeBytes,
      source: { type: 'published', file },
      groupTime: tool.item.groupTime,
    }
    images.set(imageKey, item)
    output.push(item)
  } else {
    item.groupId = tool.item.groupId
    item.groupTime ||= tool.item.groupTime
  }
  if (!tool.images.some((image) => image.imageKey === item!.imageKey)) tool.images.push(item)
  return item
}

function safeShowImageOutput(isError: boolean, publishedFile?: PublishedFileDto) {
  if (isError) return '图片没有成功发布。'
  return publishedFile ? '图片结果已生成。' : '这张图片已不可用，请让 Agent 重新发布。'
}

function publishedFileFrom(value: unknown): PublishedFileDto | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const file = value as Partial<PublishedFileDto>
  if (file.presentation !== 'image'
    || typeof file.fileRef !== 'string' || !file.fileRef || file.fileRef.length > 128
    || typeof file.name !== 'string' || !file.name || file.name.length > 1024
    || !Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) < 1 || Number(file.sizeBytes) > 512 * 1024 * 1024
    || (file.mediaType !== undefined && (typeof file.mediaType !== 'string' || !file.mediaType || file.mediaType.length > 256))) return undefined
  return file as PublishedFileDto
}

function addOmitted(tool: ToolProjection, value: unknown) {
  if (!Array.isArray(value)) return
  for (const field of value) if (typeof field === 'string' && field) tool.omitted.add(field)
}

function renderToolDetail(tool: ToolProjection) {
  tool.item.detailArgs = tool.args
  tool.item.detailOutputText = tool.outputText
  tool.item.detailOmittedFields = [...tool.omitted]
}

function projectUserMessage(blocks: ContentBlock[], attachments: AttachmentDto[], id: string, time: string, historyEntryId?: string) {
  const projected: Array<ConversationItem | ConversationProcessItem> = []
  const imageMap = new Map<string, ImageItem>()
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.fileId, attachment]))
  const linkedFileIds = new Set<string>()
  blocks.forEach((block, index) => {
    if (block.type !== 'image') return
    const image = ensureContentImage(block, `${id}-image-${index}`, `user:${id}`, projected, imageMap, historyEntryId)
    const attachment = block.fileId ? attachmentsById.get(block.fileId) : undefined
    if (!attachment) return
    linkedFileIds.add(attachment.fileId)
    image.name = attachment.name
    image.sizeBytes = attachment.sizeBytes
  })
  const images = projected.filter((item): item is ImageItem => item.kind === 'image')
  const visibleAttachments = attachments.filter((attachment) => !linkedFileIds.has(attachment.fileId))
  return {
    text: blockText(blocks, 'text'),
    time,
    ...(visibleAttachments.length ? { attachments: visibleAttachments } : {}),
    ...(images.length ? { images } : {}),
  }
}

function blockText(blocks: ContentBlock[], type: 'text' | 'thinking') {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' | 'thinking' }> => block.type === type).map((block) => block.text).join('')
}

function attachmentArray(value: unknown): AttachmentDto[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is AttachmentDto => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as Partial<AttachmentDto>
    return typeof candidate.fileId === 'string' && typeof candidate.name === 'string'
      && typeof candidate.sizeBytes === 'number' && typeof candidate.sha256 === 'string' && typeof candidate.storedAt === 'string'
  })
}

function appendLiveNotice(
  output: ConversationItem[],
  event: ConversationBootstrap['activeEvents'][number],
  tone: 'info' | 'warning' | 'error',
  text: string,
) {
  output.push({ id: `live-notice-${event.sequence}`, kind: 'notice', tone, text })
}

function notificationTone(value: unknown): 'info' | 'warning' | 'error' {
  return value === 'error' ? 'error' : value === 'warning' ? 'warning' : 'info'
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
function shortTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return timeFormatter.format(date)
}
