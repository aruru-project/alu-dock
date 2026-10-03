export type ControlSection = 'commands' | 'dock-tools' | 'sessions' | 'tree' | 'new-session' | 'rename-session' | 'compact-session' | 'reload-session' | 'models' | 'thinking' | 'tools' | 'resources' | 'settings' | 'quick-buttons'
export type LocalControlAction = 'stop' | 'restoreQueue' | 'refresh'

export interface LocalControlCommand {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly keywords: string
  readonly description: string
  readonly section?: ControlSection
  readonly action?: LocalControlAction
}

/** 客户端拥有的控制操作。命令面板和输入框建议共用这一份目录。 */
export const localControlCommands: readonly LocalControlCommand[] = [
  { id: 'session_new', name: 'new', label: 'New Session', keywords: '新建会话 work', description: '在当前 Work 开始一段空白 Session', section: 'new-session' },
  { id: 'stop', name: 'stop', label: 'Stop Work', keywords: '停止工作 instance', description: '停止当前 Work；执行前需要确认', action: 'stop' },
  { id: 'reload', name: 'reload', label: 'Reload Session', keywords: '重新加载 resources', description: '保留当前 Session，重新读取已加载资源', section: 'reload-session' },
  { id: 'resume', name: 'resume', label: 'Resume Session', keywords: '恢复会话 pi session', description: '切换到当前 Work 保存的其他 Session', section: 'sessions' },
  { id: 'tree', name: 'tree', label: 'Session Tree', keywords: '会话树 navigate fork clone', description: '浏览、切换或分叉当前会话树', section: 'tree' },
  { id: 'model', name: 'model', label: 'Set Model', keywords: '切换模型', description: '切换当前模型', section: 'models' },
  { id: 'thinking', name: 'thinking', label: 'Set Thinking', keywords: '思考等级', description: '调整思考等级', section: 'thinking' },
  { id: 'name', name: 'name', label: 'Rename Session', keywords: '重命名会话', description: '修改当前 Session 名称', section: 'rename-session' },
  { id: 'compact', name: 'compact', label: 'Compact Context', keywords: '压缩上下文', description: '手动压缩当前上下文', section: 'compact-session' },
  { id: 'dequeue', name: 'dequeue', label: 'Restore Queue', keywords: '取回排队消息', description: '把尚未执行的消息取回输入框', action: 'restoreQueue' },
  { id: 'refresh', name: 'refresh', label: '刷新状态', keywords: '刷新 重新连接 reconnect reload status', description: '重新读取工作列表和当前 Work 的状态', action: 'refresh' },
  { id: 'tools', name: 'tools', label: 'Active Tools', keywords: '启用工具', description: '查看或切换可用工具', section: 'tools' },
  { id: 'settings', name: 'settings', label: 'Settings', keywords: '设置', description: '查看或修改 Pi 设置', section: 'settings' },
  { id: 'state', name: 'state', label: 'Project Status', keywords: '当前状态 git branch', description: '查看 Work、Git、Session 与已加载能力', section: 'resources' },
  { id: 'resources', name: 'resources', label: 'Loaded Resources', keywords: '资源 diagnostics skill context', description: '打开 Project Status 的资源与诊断', section: 'resources' },
]

export function filterLocalControlCommands(query: string): LocalControlCommand[] {
  const normalized = query.toLowerCase()
  if (!normalized) return [...localControlCommands]
  return localControlCommands
    .flatMap((command, index) => {
      const name = command.name.toLowerCase()
      if (name.startsWith(normalized)) return [{ command, index, rank: 0 }]
      if (name.includes(normalized)) return [{ command, index, rank: 1 }]
      return []
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.command)
}

export function localControlCommand(name: string): LocalControlCommand | undefined {
  return localControlCommands.find((command) => command.name === name)
}

/** 仅把完整、无参数的本地命令识别为客户端操作。 */
export function submittedLocalControl(text: string): LocalControlCommand | undefined {
  const match = text.match(/^\/([^\s/]+)\s*$/)
  return match ? localControlCommand(match[1] ?? '') : undefined
}
