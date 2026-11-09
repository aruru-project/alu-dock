// Development preview only: bridge.ts answers native calls with this sample
// data when the page runs in a plain browser under Vite dev. A production build
// never reaches this module (see bridge.ts `native`), so none of it is shipped.
// Pairing and offline screens: add `?preview=onboarding` or `?preview=offline`.
import type { InvokeArgs } from '@tauri-apps/api/core'
import type { SessionContext } from '../lib/bridge'
import type {
  AssistantContextResult, AssistantDocument, AssistantEpisode, AssistantEpisodeEdit, AssistantMemory, AssistantMemoryChange, AssistantMemoryEdit, AssistantMemoryFilter,
  AssistantSearchResult, AssistantSettings, AssistantTimelineFilter, BootstrapPayload, ClientPreferences, CommandsResult, DesktopShellStatus, HostCatalog,
  ModelsResult, SavedSessionPage, SessionTree, SettingsResult, ToolsResult, Work, WorkspacePage,
} from '../lib/types'

function sampleData() {
  const now = new Date().toISOString()
  const previewCommands: CommandsResult = {
    commands: [
      { referenceId: 'preview-compact', name: 'compact', description: '压缩当前 Session 的上下文', source: { kind: 'built-in' }, argumentCompletions: false, contentAvailable: false },
      { referenceId: 'preview-dock-tools', name: 'dock-tools', description: '开启、关闭或查看当前 Work 的 Dock Tools', source: { kind: 'built-in' }, argumentHint: 'on|off|status', argumentCompletions: false, contentAvailable: false },
      { referenceId: 'preview-review', name: 'review', description: '运行 Extension 提供的代码审查流程', source: { kind: 'extension', package: '@alu/review' }, argumentHint: '[scope]', argumentCompletions: true, contentAvailable: false },
      { referenceId: 'preview-release-notes', name: 'release-notes', description: '使用项目 Prompt 生成发布说明', source: { kind: 'prompt' }, argumentHint: '[instructions]', argumentCompletions: false, contentAvailable: false },
    ],
    total: 4,
    truncated: false,
  }
  const previewModels: Omit<ModelsResult, 'instance'> = {
    models: [
      { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200000 },
      { provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, contextWindow: 200000 },
    ],
    availableThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
    total: 2,
    truncated: false,
  }
  const previewTools: Omit<ToolsResult, 'instance'> = {
    tools: [
      { name: 'bash', description: '在 Work 中运行命令', active: true, source: { kind: 'built-in' } },
      { name: 'read', description: '读取 Work 文件内容', active: true, source: { kind: 'built-in' } },
      { name: 'web_search', description: '搜索公开网页', active: false, source: { kind: 'extension', package: '@alu/web' } },
    ],
    total: 3,
    truncated: false,
  }
  const previewSettings: SettingsResult = {
    settings: [
      { key: 'autoCompaction', value: true, source: 'global', writable: true, valueType: 'boolean', reloadRequired: false, hostRestartRequired: false },
      { key: 'enableSkillCommands', value: true, source: 'project', writable: true, valueType: 'boolean', reloadRequired: true, hostRestartRequired: false },
      { key: 'transport', value: 'auto', source: 'global', writable: true, valueType: 'enum', allowedValues: ['auto', 'sse', 'websocket', 'websocket-cached'], reloadRequired: false, hostRestartRequired: false },
      { key: 'editorPaddingX', value: 1, source: 'global', writable: true, valueType: 'integer', min: 0, max: 3, reloadRequired: false, hostRestartRequired: false },
      { key: 'compactionReserveTokens', value: 16384, source: 'effective', writable: false, valueType: 'integer', min: 0, max: 2147483647, reloadRequired: false, hostRestartRequired: false },
      { key: 'warnings', value: { anthropicExtraUsage: true }, source: 'global', writable: true, valueType: 'object', reloadRequired: false, hostRestartRequired: false },
    ],
  }
  const previewSessions = (context: SessionContext): SavedSessionPage => {
    return {
      sessions: [
        { token: 'preview-current', name: 'Official Client', cwd: '/workshop/alu_dock/clients/official', lastActivityAt: now, costTotal: 3.18, current: true },
        { token: 'preview-review', name: 'Protocol review', cwd: '/workshop/alu_dock/clients/official', lastActivityAt: now, costTotal: 0.42, current: false },
        { token: 'preview-dock', firstUserMessage: '检查 Dock 集成的 Session 列表', cwd: '/workshop/alu_dock/clients/official', lastActivityAt: now, current: false },
      ],
      total: 3,
      incomplete: false,
      connectionId: context.connectionId,
      selectionGeneration: context.selectionGeneration,
      hostEpoch: context.expectedHostEpoch,
    }
  }
  const previewTree: SessionTree = {
    leafId: 'assistant-2',
    nodes: [
      { entryId: 'user-1', depth: 0, kind: 'message', role: 'user', displayClass: 'content', summary: '确认当前 Session 的分支内容', hasChildren: true, timestamp: now },
      { entryId: 'assistant-1', parentId: 'user-1', depth: 1, kind: 'message', role: 'assistant', displayClass: 'content', summary: '已完成会话分支检查', hasChildren: true, timestamp: now },
      { entryId: 'tool-1', parentId: 'assistant-1', depth: 2, kind: 'message', role: 'tool', displayClass: 'tool', summary: 'cargo test', hasChildren: false, timestamp: now },
      { entryId: 'user-2', parentId: 'assistant-1', depth: 2, kind: 'message', role: 'user', displayClass: 'content', label: '界面检查', summary: '检查 Session Tree 界面', hasChildren: true, timestamp: now },
      { entryId: 'assistant-2', parentId: 'user-2', depth: 3, kind: 'message', role: 'assistant', displayClass: 'content', summary: '正在完成触控界面', hasChildren: false, timestamp: now },
    ],
  }
  const previewBootstrap: BootstrapPayload = {
    connectionId: 'browser-preview',
    selectionGeneration: 1,
    maxAttachmentsPerMessage: 0,
    host: {
      state: 'preview',
      hostEpoch: 'browser-preview',
      dockVersion: '0.2.0',
      piSdkVersion: 'preview',
      startedAt: now,
      profile: {
        schemaVersion: 1,
        revision: 1,
        hostId: 'browser-preview',
        displayName: '家里的工作站',
        endpoints: [
          { id: 'preview-local', label: '家中局域网', kind: 'local', endpoint: { host: '192.168.1.20', port: 33781 }, state: 'verified' },
          { id: 'preview-remote', label: '外网域名', kind: 'remote', endpoint: { host: 'dock.example.com', port: 443 }, state: 'verified' },
        ],
      },
    },
    total: 5,
    hiddenStopped: 1,
    works: [
      previewWork('Alu Dock Official Client', '/workshop/alu_dock/clients/official', 'running', 'active', 'main'),
      { ...previewWork('独立代码审查', '/workshop/alu_dock/clients/official', 'idle', 'active', 'main', { provider: 'anthropic', id: 'claude-sonnet-4-6' }), parentId: 'preview-Alu Dock Official Client' },
      previewWork('Alu Workstation', '/workshop/alu_workstation', 'unavailable', 'host_lost', undefined, null),
      previewWork('alu_dock', '/workshop/alu_dock', 'idle', 'active', 'main', { provider: 'openrouter', id: 'anthropic/claude-opus-4.1-20250805-thinking-preview' }),
      { ...previewWork('早上的闲聊', '/home/alu/.aludock/assistant', 'idle', 'active'), assistant: true },
    ],
  }

  const previewCatalog: HostCatalog = {
    schemaVersion: 2,
    revision: 1,
    activeTarget: { kind: 'host', hostId: previewBootstrap.connectionId },
    localEndpointEffective: '/run/user/1000/alu-dock/dock.sock',
    selectionGeneration: 1,
    localConnectionSupported: true,
    hosts: [{
      hostId: previewBootstrap.connectionId,
      displayName: previewBootstrap.host.profile!.displayName,
      deviceName: '浏览器预览设备',
      addedAt: now,
      profile: previewBootstrap.host.profile!,
    }],
  }

  function previewWork(
    displayName: string,
    cwd: string,
    execution: Work['execution'],
    lifecycle: Work['lifecycle'],
    gitBranch?: string,
    // null: the Work has not chosen a model yet.
    model: Work['executor']['model'] | null = { provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6' },
  ): Work {
    return {
      id: `preview-${displayName}`,
      displayName,
      cwd,
      gitBranch,
      lifecycle,
      execution,
      compacting: false,
      lastRun: execution === 'unavailable' ? 'interrupted' : 'succeeded',
      reopenable: lifecycle === 'host_lost',
      runtimeGeneration: 1,
      ownerHostEpoch: lifecycle === 'active' ? 'browser-preview' : undefined,
      pending: { steering: 0, followUp: execution === 'running' ? 1 : 0, total: execution === 'running' ? 1 : 0 },
      executor: {
        kind: 'pi',
        piSessionId: 'browser-preview',
        ...(model ? { model } : {}),
        thinkingLevel: 'high',
      },
      metrics: {
        tokens: { input: 48210, output: 9312, total: 57522 },
        cost: 1.84,
        context: { tokens: 57522, contextWindow: 200000, percent: 28.8 },
      },
      extensionStatus: {},
      toolsExpanded: false,
      createdAt: now,
      updatedAt: now,
      eventCursor: { hostEpoch: 'browser-preview', instanceId: `preview-${displayName}`, runtimeGeneration: 1, sequence: 1 },
    }
  }

  // The assistant kept on Main (card #295).
  const assistantWorkspace = '/home/alu/.aludock/assistant'
  const assistantDocuments: Record<'persona' | 'notes', AssistantDocument> = {
    persona: { document: 'persona', revision: 'p1', text: '# 人设\n\n她是这台 Dock 的助手，说话简短，先给结论。\n记得你的习惯，但不替你做决定。\n' },
    notes: { document: 'notes', revision: 'n1', text: '- 早上先说天气和今天的日程。\n- 周五提醒整理本周的工作。\n' },
  }
  const assistantSession = { sessionId: 'preview-assistant-session', name: '早上的闲聊', cwd: assistantWorkspace, workId: 'preview-早上的闲聊', machine: '家里的工作站', startedAt: now, lastAt: now }
  const assistantSearch: AssistantSearchResult = {
    hits: [
      { session: assistantSession, entryId: 'a3', at: now, kind: 'assistant', snippet: '…今天上午有雨，出门记得带伞。日程里十点有一个评审…' },
      { session: { ...assistantSession, sessionId: 'preview-older', name: undefined, workId: 'preview-retired', cwd: '/workshop/alu_dock' }, entryId: 'b7', at: now, kind: 'user', snippet: '明天早上提醒我看一下天气' },
    ],
  }
  const assistantContext: AssistantContextResult = {
    session: assistantSession,
    entries: [
      { entryId: 'a1', at: now, kind: 'user', text: '早，今天怎么样？' },
      { entryId: 'a2', parentId: 'a1', at: now, kind: 'assistant', text: '我先看一下天气。', toolCalls: [{ name: 'bash', arguments: '{"command":"weather --today"}' }] },
      { entryId: 'a2r', parentId: 'a2', at: now, kind: 'tool_result', toolName: 'bash', text: '小雨 14–19°C' },
      { entryId: 'a3', parentId: 'a2r', at: now, kind: 'assistant', text: '今天上午有雨，出门记得带伞。日程里十点有一个评审。' },
    ],
    hasBefore: false,
    hasAfter: false,
  }
  // Her memories, newest first by number, and the model that makes them.
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const said = (entryId: string, minutes: number) => ({ sessionId: assistantSession.sessionId, entryId, at: ago(minutes) })
  const memory = (fields: Partial<AssistantMemory> & Pick<AssistantMemory, 'id' | 'topic' | 'text'>, minutes: number): AssistantMemory => ({
    resident: false, state: 'active', author: 'extraction', createdAt: ago(minutes), updatedAt: ago(minutes), saidAt: fields.sources?.[0]?.at ?? ago(minutes), revision: 1, sources: [], sourceCount: 0, ...fields,
  })
  const assistantMemories: AssistantMemory[] = [
    memory({ id: '14', topic: 'preferences', text: '主人不吃香菜，点外卖要避开。', resident: true, sources: [said('a1', 50)], sourceCount: 1 }, 40),
    memory({ id: '13', topic: 'events', text: '主人今天上午十点有一个评审，出门要带伞。', author: 'assistant', sources: [said('a3', 45)], sourceCount: 1 }, 44),
    memory({ id: '12', topic: 'owner', text: '主人在做 Alu Dock，一个在自己电脑上托管 Agent 工作的软件。', resident: true, author: 'owner', revision: 3, updatedAt: ago(180), sources: [said('a1', 3000)], sourceCount: 4 }, 3000),
    memory({ id: '11', topic: 'relationship', text: '主人喜欢她说话简短，先给结论，不要一上来就列一大堆。', resident: true, author: 'dreaming', revision: 2, updatedAt: ago(600), sources: [said('a2', 4000), said('a3', 3900)], sourceCount: 2 }, 4100),
    memory({ id: '10', topic: 'self', text: '她答应过以后每周五提醒主人整理本周的工作。', sources: [said('a3', 5000)], sourceCount: 1 }, 5000),
    memory({ id: '9', topic: 'preferences', text: '主人早上习惯先看天气。', state: 'retired', author: 'dreaming', revision: 2, updatedAt: ago(600), supersededBy: '11', sources: [said('a1', 6000)], sourceCount: 1 }, 6000),
    memory({ id: '8', topic: 'events', text: '主人上个月去体检了。', state: 'forgotten', author: 'owner', revision: 2, updatedAt: ago(900), sources: [said('a2', 7000)], sourceCount: 1 }, 7000),
  ]
  const assistantMemoryHistory = new Map<string, AssistantMemoryChange[]>(assistantMemories.map((item) => [item.id, [
    ...(item.revision > 1 ? [{ at: item.updatedAt, author: item.author, action: item.state === 'retired' ? 'merged' as const : item.state === 'forgotten' ? 'forgotten' as const : 'rewritten' as const, ...(item.state === 'active' ? { text: item.text } : {}) }] : []),
    { at: item.createdAt, author: item.revision > 1 && item.author !== 'owner' ? 'extraction' as const : item.author, action: 'added' as const, text: item.text },
  ]]))
  const assistantSettings: AssistantSettings = { extractionModel: { provider: 'openai-codex', id: 'gpt-5.6-mini' } }
  // Her timeline: what the two of them were doing, one line per stretch of a conversation, newest first.
  const line = (id: string, fromMinutes: number, toMinutes: number, text: string, fields: Partial<AssistantEpisode> = {}): AssistantEpisode => ({
    id, session: assistantSession, entryId: 'a1', fromAt: ago(fromMinutes), toAt: ago(toMinutes), text, state: 'active', author: 'extraction', createdAt: ago(toMinutes), updatedAt: ago(toMinutes), revision: 1, ...fields,
  })
  const assistantTimeline: AssistantEpisode[] = [
    line('5', 50, 40, '早上聊天气和今天的日程，提醒十点的评审要带伞。'),
    line('4', 1500, 1380, '在 alu_dock 做助手记忆的后台提炼，调触发时机。', { session: { ...assistantSession, sessionId: 'preview-older', name: undefined, workId: 'preview-retired', cwd: '/workshop/alu_dock' } }),
    line('3', 2900, 2800, '深夜睡不着，聊艾尔登法环的新档。', { author: 'owner', revision: 2 }),
    line('2', 4300, 4200, '去体检前问了注意事项。', { state: 'forgotten', author: 'owner', revision: 2 }),
  ]

  const clientPreferences: ClientPreferences = { revision: 1, windowsAwayDelay: 'one_minute', windowsAwaySupported: true }
  const desktopShell: DesktopShellStatus = { supported: false, hostReady: false, loginStartEnabled: false, autoStartLocalHost: false }
  return { previewCommands, previewModels, previewTools, previewSettings, previewSessions, previewTree, previewBootstrap, previewCatalog, clientPreferences, desktopShell,
    assistantWorkspace, assistantDocuments, assistantSearch, assistantContext, assistantMemories, assistantMemoryHistory, assistantTimeline, assistantSettings, ago }
}

let data: ReturnType<typeof sampleData> | undefined
const sample = () => (data ??= sampleData())
const previewScreen = () => new URLSearchParams(window.location.search).get('preview')
const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const workFor = (instanceId: unknown) => sample().previewBootstrap.works.find((work) => work.id === instanceId) ?? sample().previewBootstrap.works[0]!

async function answer(command: string, args: Record<string, unknown>): Promise<unknown> {
  const preview = sample()
  switch (command) {
    case 'get_client_preferences': return { ...preview.clientPreferences }
    case 'update_client_preferences':
      preview.clientPreferences = { ...preview.clientPreferences, revision: Number(args.expectedRevision) + 1, windowsAwayDelay: args.windowsAwayDelay as ClientPreferences['windowsAwayDelay'] }
      return { ...preview.clientPreferences }
    case 'desktop_shell_status': case 'start_desktop_host': return { ...preview.desktopShell }
    // Only Android has system bars to match; a browser has nothing to do.
    case 'set_native_appearance': return undefined
    // A device with no saved Host opens the pairing screen.
    case 'get_host_catalog': return previewScreen() === 'onboarding' ? { ...preview.previewCatalog, activeTarget: undefined, hosts: [] } : preview.previewCatalog
    case 'bootstrap': {
      await delay(280)
      if (previewScreen() === 'offline') throw { code: 'host_unreachable', message: '无法连接“家里的工作站”；浏览器离线状态预览。' }
      return preview.previewBootstrap
    }
    case 'work_catalog': {
      const { connectionId, selectionGeneration, host, works, total, hiddenStopped } = preview.previewBootstrap
      return { connectionId, selectionGeneration, hostEpoch: host.hostEpoch, instances: works, total, hiddenStopped }
    }
    case 'command_catalog': await delay(100); return preview.previewCommands
    case 'list_models': await delay(100); return { ...preview.previewModels, instance: workFor(args.instanceId) }
    case 'list_tools': await delay(100); return { ...preview.previewTools, instance: workFor(args.instanceId) }
    case 'get_settings': await delay(100); return preview.previewSettings
    case 'get_resources': await delay(100); return { resources: [], diagnostics: [], resourceTotal: 0, resourcesTruncated: false, diagnosticTotal: 0, diagnosticsTruncated: false }
    case 'list_sessions': await delay(100); return preview.previewSessions(args as unknown as SessionContext)
    case 'session_tree': await delay(100); return preview.previewTree
    case 'list_deliverables': return [
      { deliveryRef: 'preview-delivery-1', name: 'AluDock_0.1.0_x64-portable.exe', sizeBytes: 17_951_232 },
      { deliveryRef: 'preview-delivery-2', name: '发布说明.txt', sizeBytes: 4_812 },
    ]
    case 'model_visibility': {
      await delay(260)
      return { models: previewMachineModels, total: previewMachineModels.length, truncated: false, hidden: previewHiddenModels }
    }
    case 'set_model_visibility': await delay(200); previewHiddenModels = args.hidden as typeof previewHiddenModels; return { hidden: previewHiddenModels }
    case 'child_models': {
      await delay(260)
      const hidden = new Set(previewHiddenModels.map((model) => `${model.provider}/${model.id}`))
      const models = previewMachineModels.filter((model) => !hidden.has(`${model.provider}/${model.id}`))
      return { models, total: models.length, truncated: false, listed: previewChildModels, limit: 50 }
    }
    case 'set_child_models': await delay(200); previewChildModels = args.models as typeof previewChildModels; return { listed: previewChildModels }
    case 'list_machines': await delay(80); return [
      { hostId: 'preview-main', name: '家里的工作站', kind: 'main', available: true, platform: 'linux', homePath: '/home/alu', workspaceRoots: ['/'] },
      { hostId: 'preview-subhost', name: 'Windows 工作站', kind: 'subhost', available: true, platform: 'windows', homePath: 'C:\\Users\\alu', workspaceRoots: ['C:\\', 'D:\\'] },
    ]
    case 'assistant_info': {
      await delay(80)
      const model = preview.assistantSettings.extractionModel
      return { workspacePath: preview.assistantWorkspace, maxDocumentBytes: 256 * 1024, maxMemoryChars: 1000, maxEpisodeChars: 300,
        extraction: { state: model ? 'idle' : 'off', ...(model ? { model } : {}), waitingSessions: 2, lastRunAt: preview.ago(25) } }
    }
    case 'assistant_memories': {
      await delay(180)
      const filter = args.filter as AssistantMemoryFilter
      const words = (filter.query ?? '').split(/\s+/u).filter(Boolean)
      const matching = preview.assistantMemories
        .filter((item) => item.state === (filter.state ?? 'active') && (!filter.topic || item.topic === filter.topic)
          && words.every((word) => item.text.includes(word)) && (!args.cursor || Number(item.id) < Number(args.cursor)))
        .sort((left, right) => Number(right.id) - Number(left.id))
      const page = matching.slice(0, Number(args.limit))
      return { memories: structuredClone(page), ...(matching.length > page.length ? { nextCursor: page.at(-1)!.id } : {}) }
    }
    case 'assistant_memory': {
      await delay(140)
      const found = preview.assistantMemories.find((item) => item.id === args.id)
      if (!found) throw { code: 'assistant_memory_not_found', message: 'No memory has this number.' }
      return { memory: structuredClone(found), history: structuredClone(preview.assistantMemoryHistory.get(found.id) ?? []) }
    }
    case 'assistant_timeline': {
      await delay(160)
      const filter = args.filter as AssistantTimelineFilter
      const words = (filter.query ?? '').split(/\s+/u).filter(Boolean)
      const from = filter.from ? Date.parse(filter.from) : Number.NEGATIVE_INFINITY
      const to = filter.to ? Date.parse(filter.to) : Number.POSITIVE_INFINITY
      const matching = preview.assistantTimeline
        .filter((item) => item.state === (filter.state ?? 'active') && Date.parse(item.toAt) >= from && Date.parse(item.fromAt) < to
          && words.every((word) => item.text.includes(word)) && (!args.cursor || Number(item.id) < Number(args.cursor)))
        .sort((left, right) => Date.parse(right.fromAt) - Date.parse(left.fromAt))
      const page = matching.slice(0, Number(args.limit))
      return { episodes: structuredClone(page), ...(matching.length > page.length ? { nextCursor: page.at(-1)!.id } : {}) }
    }
    case 'update_assistant_episode': {
      await delay(200)
      const found = preview.assistantTimeline.find((item) => item.id === args.id)
      if (!found) throw { code: 'assistant_episode_not_found', message: 'No timeline line has this number.' }
      if (found.revision !== args.revision) throw { code: 'assistant_episode_changed', message: 'The line changed since it was read.' }
      Object.assign(found, args.edit as AssistantEpisodeEdit, { author: 'owner', updatedAt: new Date().toISOString(), revision: found.revision + 1 })
      return structuredClone(found)
    }
    case 'add_assistant_memory': {
      await delay(220)
      const at = new Date().toISOString()
      const id = String(Math.max(...preview.assistantMemories.map((item) => Number(item.id))) + 1)
      const added: AssistantMemory = { id, topic: args.topic as AssistantMemory['topic'], text: String(args.text), resident: args.resident === true, state: 'active', author: 'owner', createdAt: at, updatedAt: at, saidAt: at, revision: 1, sources: [], sourceCount: 0 }
      preview.assistantMemories.push(added)
      preview.assistantMemoryHistory.set(id, [{ at, author: 'owner', action: 'added', text: added.text }])
      return structuredClone(added)
    }
    case 'update_assistant_memory': {
      await delay(220)
      const found = preview.assistantMemories.find((item) => item.id === args.id)
      if (!found) throw { code: 'assistant_memory_not_found', message: 'No memory has this number.' }
      if (found.revision !== args.revision) throw { code: 'assistant_memory_changed', message: 'The memory changed since it was read.' }
      const edit = args.edit as AssistantMemoryEdit
      const into = preview.assistantMemories.find((item) => item.id === found.supersededBy)
      if (edit.state === 'forgotten' && into?.state === 'active') {
        throw { code: 'assistant_memory_merged', message: `这条记忆已经合并进 #${into.id}（“${into.text}”），只忘掉它的话，那一条里还留着同样的事。要忘掉，请忘掉 #${into.id}，或者把 #${into.id} 里的这部分改掉。这次没有改动。` }
      }
      const at = new Date().toISOString()
      const history = preview.assistantMemoryHistory.get(found.id) ?? []
      if (edit.text !== undefined) history.unshift({ at, author: 'owner', action: 'rewritten', text: edit.text })
      if (edit.topic !== undefined) history.unshift({ at, author: 'owner', action: 'moved' })
      if (edit.resident !== undefined) history.unshift({ at, author: 'owner', action: edit.resident ? 'resident' : 'query_only' })
      if (edit.state !== undefined) history.unshift({ at, author: 'owner', action: edit.state === 'active' ? 'restored' : edit.state })
      Object.assign(found, edit, { author: 'owner', updatedAt: at, revision: found.revision + 1 }, edit.state === 'active' ? { supersededBy: undefined } : {})
      preview.assistantMemoryHistory.set(found.id, history)
      return structuredClone(found)
    }
    case 'assistant_settings': await delay(120); return structuredClone(preview.assistantSettings)
    case 'set_assistant_settings': {
      await delay(200)
      preview.assistantSettings = args.extractionModel ? { extractionModel: args.extractionModel as AssistantSettings['extractionModel'] } : {}
      return structuredClone(preview.assistantSettings)
    }
    case 'assistant_preview': {
      await delay(200)
      const { persona, notes } = preview.assistantDocuments
      return { text: `${persona.text}\n# 手写设定\n\n${notes.text}\n# 最近的对话\n\n- 今天早上聊了天气和评审。\n`, loadedAt: new Date().toISOString() }
    }
    case 'assistant_document': await delay(160); return { ...preview.assistantDocuments[args.document as 'persona' | 'notes'] }
    case 'set_assistant_document': {
      await delay(240)
      const name = args.document as 'persona' | 'notes'
      const current = preview.assistantDocuments[name]
      if (args.baseRevision !== current.revision) throw { code: 'assistant_document_changed', message: 'The document changed since it was read.' }
      preview.assistantDocuments[name] = { document: name, text: String(args.text), revision: `${current.revision}+` }
      return { ...preview.assistantDocuments[name] }
    }
    case 'assistant_search': await delay(220); return preview.assistantSearch
    case 'assistant_context': await delay(160); return preview.assistantContext
    case 'list_workspace': {
      await delay(180)
      const path = String(args.path)
      return {
        path, parent: path === '/workshop' ? '/' : '/workshop', revision: 'browser-preview',
        entries: [
          { name: 'alubot_admin', kind: 'directory', hidden: false },
          { name: 'alu_dock', kind: 'directory', hidden: false },
          { name: 'alu_workstation', kind: 'directory', hidden: false },
          { name: '.experiments', kind: 'directory', hidden: true },
        ],
        total: 4, truncated: false,
      } satisfies WorkspacePage
    }
    case 'attachment_snapshot': return { revision: 0, jobs: [] }
    case 'clear_restored_images': return { imageCount: 0 }
    case 'pending_operations': return []
    case 'restored_image_count': return 0
    case 'system_device_name': case 'begin_windows_away': return null
    case 'watch_host_route':
      // Like the native watch: a known route is answered only after a long wait.
      if (args.seenRouteGeneration != null) await delay(25_000)
      return { connectionId: args.connectionId, selectionGeneration: args.selectionGeneration, routeGeneration: 1, activeEndpointId: 'preview-local' }
    case 'cancel_windows_away': case 'cancel_pairing': case 'reselect_host_route': case 'stop_conversation_follow':
    case 'cancel_attachment_upload': case 'remove_attachment': case 'cancel_workspace_file_read': return false
    // Following, frame ACKs and release calls have nothing to answer in a preview.
    case 'start_conversation_follow': case 'acknowledge_conversation_follow': case 'read_conversation_content': case 'consume_operation':
    case 'release_extension_control': case 'set_extension_widget_viewport': case 'clear_workspace_file_state':
    case 'open_desktop_host_log': case 'open_desktop_tui': return undefined
    default: throw new Error('浏览器预览不执行这项操作，请在 AluDock 客户端中使用。')
  }
}

const previewMachineModels = ['azure-openai-responses', 'openai', 'openai-codex'].flatMap((provider) => [
  { provider, id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true },
  { provider, id: 'gpt-5.6-mini', name: 'GPT-5.6 mini', reasoning: true },
  { provider, id: 'gpt-4.1', name: 'GPT-4.1', reasoning: false },
]).concat([{ provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true }])
let previewChildModels: { provider: string; id: string }[] = [{ provider: 'openai-codex', id: 'gpt-5.6' }, { provider: 'anthropic', id: 'claude-sonnet-4-6' }]
let previewHiddenModels: { provider: string; id: string }[] = [{ provider: 'azure-openai-responses', id: 'gpt-4.1' }, { provider: 'retired-provider', id: 'old-model' }]

export function previewNative<T>(command: string, args?: InvokeArgs): Promise<T> {
  return answer(command, (args ?? {}) as Record<string, unknown>) as Promise<T>
}
