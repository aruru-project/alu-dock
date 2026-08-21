import type {
  AttachmentDto,
  ContentBlock,
  ConversationBootstrap,
  ConversationItem,
  ConversationProcessItem,
  ConversationRecord,
  ProjectedEvent,
  PublishedFileDto,
} from './types'
type ToolItem = Extract<ConversationProcessItem, { kind: 'tool' }>
type ImageItem = Extract<ConversationProcessItem, { kind: 'image' }>
interface ToolProjection {
  item: ToolItem
  argsText?: string
  outputText?: string
  image?: ImageItem
  omitted: Set<string>
}
interface RecordGroup {
  key: string
  records: ConversationRecord[]
}

export interface ConversationProjectionOptions {
  compact?: boolean
}

export function mergeHydratedConversationRecords(previews: ConversationRecord[], completed: ConversationRecord[]) {
  const replacements = new Map(completed.map((record) => [record.entryId, record]))
  return previews.map((record) => replacements.get(record.entryId) ?? record)
}

/* ── 流式增量补丁 ─────────────────────────────────────
 * message.delta 一次运行可以产生上千个事件。它们全部堆在 activeEvents 里，
 * 每个事件都触发整段会话重投影（重放全部 activeEvents）会让成本随流式长度平方膨胀。
 * 这里提供两个配套机制：折叠（foldLiveDelta）让 activeEvents 按消息数增长；
 * 定位键（liveDeltaKey / liveProjectionTargetKey）让调用方可以把 delta 直接
 * 追加到已投影的条目上，只为首包 delta 做整段重投影。
 */

/** delta 事件的归并键，与 projector 里 messageItems 的键方案一致（messageId:block）。 */
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

/** 已投影条目对应的 delta 键；只有 live 分组的 assistant/thinking 条目可被增量追加，其余返回 null。 */
export function liveProjectionTargetKey(item: ConversationItem): string | null {
  if (item.kind !== 'assistant' && item.kind !== 'thinking') return null
  const groupId = item.groupId
  if (!groupId || !groupId.startsWith('live-message:')) return null
  const messageId = groupId.slice('live-message:'.length)
  if (item.kind === 'thinking') return item.id === `live-${messageId}-thinking` ? `${messageId}:thinking` : null
  return item.id === `live-${messageId}` ? `${messageId}:text` : null
}

export function projectConversation(bootstrap: ConversationBootstrap, options: ConversationProjectionOptions = {}): ConversationItem[] {
  const processIsVisible = options.compact !== true
  const items = projectRecordGroups(bootstrap.records)
  const messageItems = new Map<string, ConversationItem>()
  const toolItems = new Map<string, ToolProjection>()
  const toolOwners = new Map<string, string>()
  const imageItems = new Map<string, ImageItem>()
  let activityVisible = bootstrap.instance.execution === 'running'
  let activityId = `activity-${bootstrap.instance.id}`

  for (const event of bootstrap.activeEvents) {
    const data = event.data
    const time = shortTime(event.occurredAt)
    switch (event.eventType) {
      case 'run.started':
        activityVisible = true
        activityId = `live-activity-${event.sequence}`
        break
      case 'message.submitted': {
        activityVisible = true
        const messageId = String(data.messageId || `submitted-${event.sequence}`)
        const item: ConversationItem = {
          id: `live-${messageId}`,
          kind: 'user',
          text: String(data.text || ''),
          time,
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
        if (processIsVisible || block === 'text') activityVisible = false
        const delta = String(data.delta || '')
        let item = messageItems.get(`${messageId}:${block}`)
        if (!item) {
          item = block === 'thinking'
            ? { id: `live-${messageId}-thinking`, kind: 'thinking', groupId, title: '思考中', text: '', open: true, groupTime: time }
            : { id: `live-${messageId}`, kind: 'assistant', groupId, text: '', time, groupTime: time }
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
          const user = projectUserMessage(blocks, attachmentArray(data.attachments), `live-${messageId}`, time)
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
          if (processIsVisible || blocks.some(compactVisibleBlock)) activityVisible = false
          blocks.forEach((block, index) => applyLiveContentBlock(block, `live-tool-staging`, `live-${messageId}-content-${index}`, toolItems, toolOwners, imageItems, items))
          break
        }

        if (data.role !== 'assistant') {
          if (processIsVisible || Boolean(data.error)) activityVisible = false
          if (text) items.push({ id: `live-${messageId}`, kind: 'notice', tone: data.error ? 'error' : 'info', text })
          break
        }

        if (processIsVisible || blocks.some(compactVisibleBlock) || Boolean(data.error)) activityVisible = false
        const groupId = `live-message:${messageId}`
        const textItem = messageItems.get(`${messageId}:text`)
        if (textItem?.kind === 'assistant') {
          textItem.text = text
          textItem.groupTime = time
        } else if (text) {
          const item: ConversationItem = { id: `live-${messageId}`, kind: 'assistant', groupId, text, time, groupTime: time }
          items.push(item)
          messageItems.set(`${messageId}:text`, item)
        }
        const thinkingItem = messageItems.get(`${messageId}:thinking`)
        if (thinkingItem?.kind === 'thinking') {
          thinkingItem.text = thinking
          thinkingItem.groupTime = time
          thinkingItem.open = false
        } else if (thinking) {
          const item: ConversationItem = { id: `live-${messageId}-thinking`, kind: 'thinking', groupId, title: '思考过程', text: thinking, groupTime: time }
          items.push(item)
          messageItems.set(`${messageId}:thinking`, item)
        }
        blocks.forEach((block, index) => applyLiveContentBlock(block, groupId, `live-${messageId}-content-${index}`, toolItems, toolOwners, imageItems, items, time))
        if (typeof data.error === 'string' && data.error) {
          items.push({ id: `live-${messageId}-error`, kind: 'notice', groupId, tone: 'error', text: data.error, groupTime: time })
        }
        break
      }
      case 'tool.started':
      case 'tool.args_updated':
      case 'tool.output_updated':
      case 'tool.completed': {
        const toolCallId = String(data.toolCallId || `tool-${event.sequence}`)
        const groupId = toolOwners.get(toolCallId) || 'live-tool-staging'
        const tool = ensureTool(toolItems, items, toolCallId, String(data.toolName || 'tool'), groupId, `live-tool-${toolCallId}`)
        if (data.toolName) tool.item.name = String(data.toolName)
        if (data.args !== undefined && tool.item.name !== 'show_image') tool.argsText = JSON.stringify(data.args, null, 2)
        if (typeof data.text === 'string' && tool.item.name !== 'show_image') tool.outputText = data.text
        addOmitted(tool, data.omittedFields)
        tool.item.groupTime ||= time
        const eventContent = Array.isArray(data.content) ? (data.content as ContentBlock[]) : []
        eventContent.forEach((block, index) => {
          if (block.type === 'image') {
            const image = ensureContentImage(block, `live-tool-${toolCallId}-content-${index}`, groupId, items, imageItems)
            image.groupTime ||= time
          }
        })
        const publishedFile = publishedFileFrom(data.publishedFile)
        if (processIsVisible || eventContent.some(compactVisibleBlock) || publishedFile) activityVisible = false
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
      case 'compaction.started':
        appendLiveNotice(items, event, 'info', `正在压缩上下文${stringValue(data.reason) ? `（${stringValue(data.reason)}）` : ''}…`)
        break
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
        activityVisible = false
        const result = typeof data.result === 'string' ? data.result : ''
        for (const tool of toolItems.values()) {
          if (tool.item.status !== 'running') continue
          tool.item.status = result === 'succeeded' ? 'done' : 'error'
          tool.item.summary = result === 'succeeded' ? '工具调用完成' : result === 'aborted' ? '工具调用已中止' : '工具调用未完成'
        }
        toolItems.clear()
        if (result === 'failed') {
          items.push({ id: `live-run-settled-${event.sequence}`, kind: 'notice', tone: 'error', text: typeof data.error === 'string' ? data.error : '运行失败。' })
        } else if (result === 'aborted') {
          items.push({ id: `live-run-settled-${event.sequence}`, kind: 'notice', tone: 'warning', text: '当前运行已中止。' })
        } else if (result === 'interrupted') {
          items.push({ id: `live-run-settled-${event.sequence}`, kind: 'notice', tone: 'warning', text: '当前运行已被打断。' })
        }
        break
      }
    }
  }
  if (activityVisible) items.push({ id: activityId, kind: 'activity' })
  return items
}

function projectRecordGroups(records: ConversationRecord[]): ConversationItem[] {
  const output: ConversationItem[] = []
  for (const group of groupRecords(records)) projectGroup(group, output)
  return output
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
  if (first.kind === 'message' && first.source === 'user' && group.records.length === 1) {
    output.push({ id: first.recordId, kind: 'user', ...projectUserMessage(first.content, first.attachments ?? [], first.recordId, shortTime(first.timestamp)) })
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
    record.content.forEach((block, index) => appendBlock(block, `${record.recordId}-${index}`, group.key, parts, tools, images))
    if (record.error) parts.push({ id: `${record.recordId}-error`, kind: 'notice', groupId: group.key, tone: 'error', text: record.error })
  }
  return parts
}

function appendBlock(block: ContentBlock, id: string, groupId: string, output: ConversationProcessItem[], tools: Map<string, ToolProjection>, images: Map<string, ImageItem>) {
  if (block.type === 'text') {
    output.push({ id, kind: 'assistant', groupId, text: block.text, time: '' })
  } else if (block.type === 'thinking') {
    output.push({ id, kind: 'thinking', groupId, title: '思考过程', text: block.text })
  } else if (block.type === 'image') {
    ensureContentImage(block, id, groupId, output, images)
  } else if (block.type === 'tool_call') {
    const tool = ensureTool(tools, output, block.toolCallId, block.toolName, groupId, id)
    if (block.toolName !== 'show_image') tool.argsText = JSON.stringify(block.args, null, 2)
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
    output.push({ id, kind: 'notice', groupId, tone: 'info', text: block.description || `${block.kind} 未载入` })
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
) {
  if (block.type === 'image') {
    const image = ensureContentImage(block, id, groupId, output, images)
    image.groupTime ||= groupTime
    return
  }
  if (block.type !== 'tool_call' && block.type !== 'tool_result') return
  owners.set(block.toolCallId, groupId)
  const tool = ensureTool(tools, output, block.toolCallId, block.toolName, groupId, `live-tool-${block.toolCallId}`)
  tool.item.groupId = groupId
  tool.item.groupTime ||= groupTime
  if (tool.image) {
    tool.image.groupId = groupId
    tool.image.groupTime ||= groupTime
  }
  if (block.type === 'tool_call') {
    tool.item.name = block.toolName || tool.item.name
    if (block.toolName !== 'show_image') tool.argsText = JSON.stringify(block.args, null, 2)
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
  const item: ToolItem = { id, kind: 'tool', groupId, name: toolName || 'tool', summary: '正在运行工具', status: 'running', detail: '' }
  tool = { item, omitted: new Set() }
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
): ImageItem {
  const contentRef = typeof block.contentRef === 'string' && block.contentRef ? block.contentRef : undefined
  const data = typeof block.data === 'string' && block.data ? block.data : undefined
  const imageKey = contentRef ? `conversation:${contentRef}` : `inline:${id}`
  let item = images.get(imageKey)
  if (!item) {
    item = {
      id,
      kind: 'image',
      groupId,
      imageKey,
      mimeType: block.mimeType,
      fileId: block.fileId,
      source: contentRef
        ? { type: 'conversation', contentRef, mimeType: block.mimeType }
        : data
          ? { type: 'inline', data, mimeType: block.mimeType }
          : undefined,
    }
    images.set(imageKey, item)
    output.push(item)
  } else {
    item.groupId = groupId
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
      id: `${tool.item.id}-image`,
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
  tool.image = item
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
  const sections: string[] = []
  if (tool.argsText !== undefined) sections.push(`参数\n${tool.argsText}`)
  if (tool.outputText !== undefined) sections.push(`结果\n${tool.outputText}`)
  if (tool.omitted.size) sections.push(`未载入内容\n${[...tool.omitted].join('\n')}`)
  tool.item.detail = sections.join('\n\n')
}

function projectUserMessage(blocks: ContentBlock[], attachments: AttachmentDto[], id: string, time: string) {
  const projected: Array<ConversationItem | ConversationProcessItem> = []
  const imageMap = new Map<string, ImageItem>()
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.fileId, attachment]))
  const linkedFileIds = new Set<string>()
  blocks.forEach((block, index) => {
    if (block.type !== 'image') return
    const image = ensureContentImage(block, `${id}-image-${index}`, `user:${id}`, projected, imageMap)
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

function compactVisibleBlock(block: ContentBlock) {
  return (block.type === 'text' && Boolean(block.text))
    || block.type === 'image'
    || (block.type === 'tool_result' && Boolean(publishedFileFrom(block.publishedFile)))
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

function shortTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
