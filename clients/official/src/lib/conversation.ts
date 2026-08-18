import type {
  AttachmentDto,
  ContentBlock,
  ConversationBootstrap,
  ConversationItem,
  ConversationProcessItem,
  ConversationRecord,
} from './types'
type ToolItem = Extract<ConversationProcessItem, { kind: 'tool' }>
interface ToolProjection {
  item: ToolItem
  argsText?: string
  outputText?: string
  omitted: Set<string>
}
interface RecordGroup {
  key: string
  records: ConversationRecord[]
}

export function projectConversation(bootstrap: ConversationBootstrap): ConversationItem[] {
  const items = projectRecordGroups(bootstrap.records)
  const messageItems = new Map<string, ConversationItem>()
  const toolItems = new Map<string, ToolProjection>()
  const toolOwners = new Map<string, string>()
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
        activityVisible = false
        const messageId = String(data.messageId || `message-${event.sequence}`)
        const groupId = `live-message:${messageId}`
        const block = data.block === 'thinking' ? 'thinking' : 'text'
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
          const attachments = attachmentArray(data.attachments)
          if (existing?.kind === 'user') {
            if (text) existing.text = text
            if (attachments.length) existing.attachments = attachments
          } else if (text || attachments.length) {
            items.push({ id: `live-${messageId}`, kind: 'user', text, time, attachments })
          }
          break
        }

        activityVisible = false
        if (data.role === 'tool') {
          for (const block of blocks) applyLiveToolBlock(block, `live-tool-staging`, toolItems, toolOwners, items)
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
        } else if (thinking) {
          const item: ConversationItem = { id: `live-${messageId}-thinking`, kind: 'thinking', groupId, title: '思考过程', text: thinking, groupTime: time }
          items.push(item)
          messageItems.set(`${messageId}:thinking`, item)
        }
        for (const block of blocks) applyLiveToolBlock(block, groupId, toolItems, toolOwners, items, time)
        if (typeof data.error === 'string' && data.error) {
          items.push({ id: `live-${messageId}-error`, kind: 'notice', groupId, tone: 'error', text: data.error, groupTime: time })
        }
        break
      }
      case 'tool.started':
      case 'tool.args_updated':
      case 'tool.output_updated':
      case 'tool.completed': {
        activityVisible = false
        const toolCallId = String(data.toolCallId || `tool-${event.sequence}`)
        const groupId = toolOwners.get(toolCallId) || 'live-tool-staging'
        const tool = ensureTool(toolItems, items, toolCallId, String(data.toolName || 'tool'), groupId, `live-tool-${toolCallId}`)
        if (data.toolName) tool.item.name = String(data.toolName)
        if (data.args !== undefined) tool.argsText = JSON.stringify(data.args, null, 2)
        if (typeof data.text === 'string') tool.outputText = data.text
        addOmitted(tool, data.omittedFields)
        if (event.eventType === 'tool.completed') {
          tool.item.status = data.isError ? 'error' : 'done'
          tool.item.summary = data.isError ? '工具调用失败' : '工具调用完成'
        }
        tool.item.groupTime ||= time
        renderToolDetail(tool)
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
    output.push({ id: first.recordId, kind: 'user', text: blockText(first.content, 'text'), time: shortTime(first.timestamp), attachments: first.attachments })
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
  for (const record of group.records) {
    record.content.forEach((block, index) => appendBlock(block, `${record.recordId}-${index}`, group.key, parts, tools))
    if (record.error) parts.push({ id: `${record.recordId}-error`, kind: 'notice', groupId: group.key, tone: 'error', text: record.error })
  }
  return parts
}

function appendBlock(block: ContentBlock, id: string, groupId: string, output: ConversationProcessItem[], tools: Map<string, ToolProjection>) {
  if (block.type === 'text') {
    output.push({ id, kind: 'assistant', groupId, text: block.text, time: '' })
  } else if (block.type === 'thinking') {
    output.push({ id, kind: 'thinking', groupId, title: '思考过程', text: block.text })
  } else if (block.type === 'image') {
    output.push({ id, kind: 'image', groupId, mimeType: block.mimeType })
  } else if (block.type === 'tool_call') {
    const tool = ensureTool(tools, output, block.toolCallId, block.toolName, groupId, id)
    tool.argsText = JSON.stringify(block.args, null, 2)
    addOmitted(tool, block.omittedFields)
    renderToolDetail(tool)
  } else if (block.type === 'tool_result') {
    const tool = ensureTool(tools, output, block.toolCallId, block.toolName, groupId, id)
    tool.item.name = block.toolName || tool.item.name
    tool.item.status = block.isError ? 'error' : 'done'
    tool.item.summary = block.isError ? '工具调用失败' : '工具调用完成'
    tool.outputText = block.text
    addOmitted(tool, block.omittedFields)
    renderToolDetail(tool)
  } else if (block.type === 'omitted') {
    output.push({ id, kind: 'notice', groupId, tone: 'info', text: block.description || `${block.kind} 未载入` })
  }
}

function applyLiveToolBlock(
  block: ContentBlock,
  groupId: string,
  tools: Map<string, ToolProjection>,
  owners: Map<string, string>,
  output: ConversationItem[],
  groupTime = '',
) {
  if (block.type !== 'tool_call' && block.type !== 'tool_result') return
  owners.set(block.toolCallId, groupId)
  const tool = ensureTool(tools, output, block.toolCallId, block.toolName, groupId, `live-tool-${block.toolCallId}`)
  tool.item.groupId = groupId
  tool.item.groupTime ||= groupTime
  if (block.type === 'tool_call') {
    tool.item.name = block.toolName || tool.item.name
    tool.argsText = JSON.stringify(block.args, null, 2)
  } else {
    tool.item.name = block.toolName || tool.item.name
    tool.item.status = block.isError ? 'error' : 'done'
    tool.item.summary = block.isError ? '工具调用失败' : '工具调用完成'
    tool.outputText = block.text
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

function shortTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
