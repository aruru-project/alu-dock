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

export interface SlashArgumentContext { name: string; prefix: string }

/** 已完成命令 token 后的全部文字是 owner 用来生成参数候选的前缀。 */
export function slashArgumentContext(text: string): SlashArgumentContext | null {
  const match = text.match(/^\/([^\s/]+)\s([\s\S]*)$/)
  return match ? { name: match[1] ?? '', prefix: match[2] ?? '' } : null
}

export function applySlashArgumentCompletion(name: string, value: string): string {
  return `/${name} ${value}`
}

/** 子序列模糊匹配（"sm" 命中 "Set Model"）：命中返回跨度罚分（越小越好），未命中返回 null。 */
export function subsequenceScore(query: string, text: string): number | null {
  if (!query) return 0
  let qi = 0
  let spanStart = -1
  let spanEnd = -1
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      if (spanStart < 0) spanStart = ti
      spanEnd = ti
      qi++
    }
  }
  if (qi < query.length) return null
  return (spanEnd - spanStart + 1) * 10 + spanStart
}

export interface CommandPaletteSearchItem {
  readonly id: string
  readonly label: string
  readonly keywords: string
  readonly description: string
}

/** 命令面板同时接受名称和 `/名称`，斜杠只表示“按命令查找”。 */
export function commandPaletteQuery(rawQuery: string): string {
  const query = rawQuery.trim().toLowerCase()
  return query.startsWith('/') ? query.slice(1).trimStart() : query
}

export function filterCommandPaletteItems<T extends CommandPaletteSearchItem>(items: readonly T[], rawQuery: string): T[] {
  const query = commandPaletteQuery(rawQuery)
  if (!query) return [...items]
  return items.filter((item) => {
    if (`${item.id} ${item.label} ${item.keywords} ${item.description}`.toLowerCase().includes(query)) return true
    return subsequenceScore(query, item.label.toLowerCase()) !== null || subsequenceScore(query, item.id.toLowerCase()) !== null
  })
}

/** 名称优先（前缀 > 包含 > 模糊子序列），其次描述/来源；名称命中永远排在描述命中前面。 */
export function filterCatalogCommands(commands: CommandInfo[], rawQuery: string): CommandInfo[] {
  const query = commandPaletteQuery(rawQuery)
  const matched = commands.flatMap((command, index) => {
    if (!query) return [{ command, index, rank: 2, fuzzy: 0 }]
    const name = command.name.toLowerCase()
    if (name.startsWith(query)) return [{ command, index, rank: 0, fuzzy: 0 }]
    if (name.includes(query)) return [{ command, index, rank: 1, fuzzy: 0 }]
    const fuzzy = subsequenceScore(query, name)
    if (fuzzy !== null) return [{ command, index, rank: 2, fuzzy }]
    const fields = `${command.description ?? ''} ${command.source.kind} ${command.source.package ?? ''}`.toLowerCase()
    if (fields.includes(query)) return [{ command, index, rank: 3, fuzzy: 0 }]
    return []
  })
  return matched
    .sort((a, b) => a.rank - b.rank || a.fuzzy - b.fuzzy || a.index - b.index)
    .map((entry) => entry.command)
}

/** 建议只在整段草稿都是未完成命令 token 时出现，因此补全就是整段替换为 "/name "。 */
export function applySlashCompletion(name: string): string {
  return `/${name} `
}

/** 命令面板选中 Prompt/Skill 后，把命令放到用户已有草稿前面，仍由用户确认发送。 */
export function prefixSlashCommand(name: string, draft: string): string {
  return `${applySlashCompletion(name)}${draft}`
}

/** 选中命令后的去向：prompt/skill 本质是"发一条消息"，归输入框；extension 有独立输出，归运行面板。 */
export function commandGoesToComposer(command: CommandInfo): boolean {
  return command.source.kind === 'prompt' || command.source.kind === 'skill'
}

export function catalogSourceLabel(kind: string): string {
  return ({ 'built-in': 'WebConsole', extension: 'Extension', skill: 'Skill', prompt: 'Prompt' } as Record<string, string>)[kind] ?? kind
}
