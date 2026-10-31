// Development preview only: bridge.ts answers native calls with this sample
// data when the page runs in a plain browser under Vite dev. A production build
// never reaches this module (see bridge.ts `native`), so none of it is shipped.
// Pairing and offline screens: add `?preview=onboarding` or `?preview=offline`.
import type { InvokeArgs } from '@tauri-apps/api/core'
import type { SessionContext } from '../lib/bridge'
import type {
  BootstrapPayload, ClientPreferences, CommandsResult, DesktopShellStatus, HostCatalog, ModelsResult, SavedSessionPage,
  SessionTree, SettingsResult, ToolsResult, Work, WorkspacePage,
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

  const clientPreferences: ClientPreferences = { revision: 1, windowsAwayDelay: 'one_minute', windowsAwaySupported: true }
  const desktopShell: DesktopShellStatus = { supported: false, hostReady: false, loginStartEnabled: false, autoStartLocalHost: false }
  return { previewCommands, previewModels, previewTools, previewSettings, previewSessions, previewTree, previewBootstrap, previewCatalog, clientPreferences, desktopShell }
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
      const models = ['azure-openai-responses', 'openai', 'openai-codex'].flatMap((provider) => [
        { provider, id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true },
        { provider, id: 'gpt-5.6-mini', name: 'GPT-5.6 mini', reasoning: true },
        { provider, id: 'gpt-4.1', name: 'GPT-4.1', reasoning: false },
      ]).concat([{ provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true }])
      return { models, total: models.length, truncated: false, hidden: previewHiddenModels }
    }
    case 'set_model_visibility': await delay(200); previewHiddenModels = args.hidden as typeof previewHiddenModels; return { hidden: previewHiddenModels }
    case 'list_machines': await delay(80); return [
      { hostId: 'preview-main', name: '家里的工作站', kind: 'main', available: true, platform: 'linux', homePath: '/home/alu', workspaceRoots: ['/'] },
      { hostId: 'preview-subhost', name: 'Windows 工作站', kind: 'subhost', available: true, platform: 'windows', homePath: 'C:\\Users\\alu', workspaceRoots: ['C:\\', 'D:\\'] },
    ]
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

let previewHiddenModels: { provider: string; id: string }[] = [{ provider: 'azure-openai-responses', id: 'gpt-4.1' }, { provider: 'retired-provider', id: 'old-model' }]

export function previewNative<T>(command: string, args?: InvokeArgs): Promise<T> {
  return answer(command, (args ?? {}) as Record<string, unknown>) as Promise<T>
}
