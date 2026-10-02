import type { SettingKey, SettingValue } from './types'

interface SettingPresentation {
  label: string
  description: string
}

const SETTING_PRESENTATIONS = {
  autoCompaction: { label: 'Auto-compact', description: 'Context 过大时自动整理，腾出继续对话的空间' },
  compactionReserveTokens: { label: 'Compaction 预留 Token', description: 'Compaction 时为下一次 Model 回复预留的 Token 数' },
  compactionKeepRecentTokens: { label: 'Compaction 保留的近期 Token', description: 'Compaction 时保留的近期对话 Token 数' },
  autoRetry: { label: '自动重试', description: '遇到暂时性错误时自动再次尝试' },
  enableSkillCommands: { label: 'Skill 命令', description: '把已加载的 Skill 注册为可输入的命令' },
  hideThinking: { label: 'Hide Thinking', description: '在对话中隐藏 Model 的 Thinking' },
  showCacheMissNotices: { label: 'Cache miss 提示', description: 'Context cache 明显失效时在对话中显示提示' },
  showHardwareCursor: { label: '显示终端光标', description: '在输入位置显示终端光标，便于输入法定位' },
  clearOnShrink: { label: '收缩时清除空行', description: '内容变少时清除终端中多余的空行' },
  showTerminalProgress: { label: '显示终端进度', description: '在支持的终端标签栏中显示运行进度' },
  quietStartup: { label: '简洁启动', description: '启动时隐藏详细的欢迎信息' },
  collapseChangelog: { label: '折叠更新日志', description: '更新后以精简形式显示更新记录' },
  enableInstallTelemetry: { label: '分享匿名安装与更新统计', description: '匿名分享安装和更新版本信息' },
  steeringMode: { label: 'Steering mode', description: 'Agent 运行时，多条补充消息如何发送' },
  followUpMode: { label: 'Follow-up mode', description: 'Agent 停止后，多条后续消息如何发送' },
  transport: { label: '网络连接方式', description: '选择 Model 服务支持的网络连接方式' },
  doubleEscapeAction: { label: '连按两次 Esc', description: '输入框为空时连按两次 Esc 执行的操作' },
  treeFilterMode: { label: 'Session Tree 默认筛选', description: '打开 Session Tree 时默认显示哪些内容' },
  defaultProjectTrust: { label: '默认项目信任方式', description: '项目尚无信任记录时采用的处理方式' },
  cacheWarming: { label: '缓存保温', description: '任务中途发小请求让 Model 的提示缓存不过期，每次刷新都会计费；对所有项目生效' },
  httpIdleTimeoutMs: { label: 'HTTP 空闲等待时间', description: '等待 HTTP 数据期间允许的最长空闲时间（毫秒）' },
  editorPaddingX: { label: '输入框水平留白', description: '输入框左右两侧的留白' },
  outputPad: { label: '消息水平留白', description: '用户消息、回复和 Thinking 两侧的留白' },
  autocompleteMaxVisible: { label: '自动补全显示数量', description: '自动补全列表一次显示的最大条数' },
  warnings: { label: '警告选项', description: '选择需要显示的使用提醒' },
} satisfies Record<SettingKey, SettingPresentation>

const OPTION_LABELS: Partial<Record<SettingKey, Record<string, string>>> = {
  steeringMode: { 'one-at-a-time': '逐条发送', all: '一次发送全部' },
  followUpMode: { 'one-at-a-time': '逐条发送', all: '一次发送全部' },
  transport: { auto: '自动选择', sse: 'SSE', websocket: 'WebSocket', 'websocket-cached': 'WebSocket（使用缓存）' },
  doubleEscapeAction: { tree: '打开 Session Tree', fork: '从当前位置创建分支', none: '不执行操作' },
  treeFilterMode: { default: '默认', 'no-tools': '隐藏 Tools', 'user-only': '仅用户消息', 'labeled-only': '仅有标签的内容', all: '全部内容' },
  defaultProjectTrust: { ask: '每次询问', always: '始终信任', never: '从不信任' },
  cacheWarming: { off: '关闭', streaming: '仅运行中', idle: '运行中和空闲时' },
}

export function settingLabel(key: SettingKey): string {
  return SETTING_PRESENTATIONS[key].label
}

export function settingDescription(key: SettingKey): string {
  return SETTING_PRESENTATIONS[key].description
}

export function settingOptionLabel(key: SettingKey, value: string | number | boolean): string {
  return OPTION_LABELS[key]?.[String(value)] ?? String(value)
}

export function settingValueLabel(key: SettingKey, value: SettingValue): string {
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (typeof value === 'string') return settingOptionLabel(key, value)
  if (typeof value === 'number') {
    if (key === 'httpIdleTimeoutMs') return `${value} 毫秒`
    if (key === 'compactionReserveTokens' || key === 'compactionKeepRecentTokens') return `${value} Token`
    return String(value)
  }
  return `Anthropic 额外用量提醒：${value.anthropicExtraUsage === false ? '关闭' : '开启'}`
}
