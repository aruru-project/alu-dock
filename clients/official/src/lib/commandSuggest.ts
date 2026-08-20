import type { CommandInfo } from './types'

/**
 * 输入框斜杠命令建议的纯逻辑层。
 *
 * 语义以 pi 为准：只有整条消息以 "/" 开头（命令在消息最前面、独占第一个 token）
 * 才会被 pi 展开成模板/技能/扩展命令；出现在句子中间的 "/xxx" 只是普通文本。
 * 因此建议只在「整段草稿就是一个未完成的命令 token」时出现。
 */

/** 返回正在输入的命令查询词；草稿不是命令输入态时返回 null。 */
export function slashCommandQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  if (text.includes('\n')) return null
  const token = text.slice(1)
  if (/\s/.test(token)) return null
  return token
}

function rank(command: CommandInfo, query: string): number {
  const name = command.name.toLowerCase()
  if (!query) return 2
  if (name.startsWith(query)) return 0
  if (name.includes(query)) return 1
  return 2
}

/** 名称优先（前缀 > 包含），其次描述/来源；名称命中永远排在描述命中前面。 */
export function filterCatalogCommands(commands: CommandInfo[], rawQuery: string): CommandInfo[] {
  const query = rawQuery.trim().toLowerCase()
  const matched = commands.filter((command) => {
    if (!query) return true
    return `${command.name} ${command.description ?? ''} ${command.source.kind} ${command.source.package ?? ''}`
      .toLowerCase()
      .includes(query)
  })
  return matched
    .map((command, index) => ({ command, index, rank: rank(command, query) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command)
}

/** 建议只在整段草稿都是未完成命令 token 时出现，因此补全就是整段替换为 "/name "。 */
export function applySlashCompletion(name: string): string {
  return `/${name} `
}

/** 选中命令后的去向：prompt/skill 本质是"发一条消息"，归输入框；extension 有独立输出，归运行面板。 */
export function commandGoesToComposer(command: CommandInfo): boolean {
  return command.source.kind === 'prompt' || command.source.kind === 'skill'
}

export function catalogSourceLabel(kind: string): string {
  return ({ 'built-in': 'WebConsole', extension: 'Extension', skill: 'Skill', prompt: 'Prompt' } as Record<string, string>)[kind] ?? kind
}
