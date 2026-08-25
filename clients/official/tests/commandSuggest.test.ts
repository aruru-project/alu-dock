// 输入框斜杠命令建议：触发判定、过滤排序、补全替换、类型分流
import assert from 'node:assert/strict'
import { applySlashArgumentCompletion, applySlashCompletion, commandGoesToComposer, filterCatalogCommands, filterCommandPaletteItems, prefixSlashCommand, slashArgumentContext, slashCommandQuery, subsequenceScore } from '../src/lib/commandSuggest.ts'
import { filterLocalControlCommands, localControlCommands, submittedLocalControl } from '../src/lib/localCommands.ts'
import type { CommandInfo, SourceKind } from '../src/lib/types.ts'

function cmd(name: string, kind: SourceKind, description = ''): CommandInfo {
  return { referenceId: `ref-${kind}-${name}`, name, description, source: { kind }, argumentCompletions: false, contentAvailable: false }
}

// 只有"/"引领的单个 token 才是命令输入态（pi 只展开消息最开头的命令）
assert.equal(slashCommandQuery(''), null)
assert.equal(slashCommandQuery('/'), '')
assert.equal(slashCommandQuery('/id'), 'id')
assert.equal(slashCommandQuery('/idea'), 'idea')
assert.equal(slashCommandQuery('/idea 我的想法'), null, '空格后进入参数输入，不再提示')
assert.equal(slashCommandQuery('看看 /idea 这个'), null, '句中的斜杠不是命令')
assert.equal(slashCommandQuery('/idea\n第二行'), null, '多行草稿不提示')
assert.deepEqual(slashArgumentContext('/review src/'), { name: 'review', prefix: 'src/' })
assert.deepEqual(slashArgumentContext('/review '), { name: 'review', prefix: '' })
assert.equal(slashArgumentContext('/review'), null)

const catalog = [
  cmd('release-notes', 'prompt', '生成发布说明'),
  cmd('research', 'prompt', '调研一个主题'),
  cmd('review', 'extension', '运行代码审查流程'),
]

// 同为名称前缀命中时保持目录原序（Dock 返回的是字母序）
assert.deepEqual(filterCatalogCommands(catalog, 're').map((item) => item.name), ['release-notes', 'research', 'review'])
assert.deepEqual(filterCatalogCommands(catalog, 'review').map((item) => item.name), ['review'])
assert.deepEqual(filterCatalogCommands(catalog, '/review').map((item) => item.name), ['review'], '命令面板接受带斜杠的目录命令')
assert.deepEqual(filterCatalogCommands(catalog, '发布').map((item) => item.name), ['release-notes'], '描述里的中文也要能搜到')
assert.deepEqual(filterCatalogCommands(catalog, '').map((item) => item.name), ['release-notes', 'research', 'review'], '空查询保持目录原序')
assert.deepEqual(filterCatalogCommands(catalog, 'zzz'), [])

// 名称前缀 > 名称包含：敲全词时精确命令必须压过只是包含它的命令
const prefixVsContains = [cmd('x-search', 'extension'), cmd('search', 'prompt')]
assert.deepEqual(filterCatalogCommands(prefixVsContains, 'search').map((item) => item.name), ['search', 'x-search'])

// 模糊子序列：敲 "rn" 也能命中 release-notes，且排在名称前缀命中的后面
assert.deepEqual(filterCatalogCommands(catalog, 'rn').map((item) => item.name), ['release-notes'])
assert.deepEqual(filterCatalogCommands([cmd('rn', 'extension'), cmd('release-notes', 'prompt')], 'rn').map((item) => item.name), ['rn', 'release-notes'])
assert.equal(subsequenceScore('sm', 'set model') !== null, true)
assert.equal(subsequenceScore('zz', 'set model'), null)

// 命令面板中的本地操作沿用同一套斜杠查询，不把控制操作当成 Agent 命令
const localControls = [
  { id: 'session_new', label: 'New Session', keywords: '新建会话 work', description: '开始一段全新的上下文' },
  { id: 'stop', label: 'Stop Work', keywords: '停止工作 instance', description: '停止整个 Work' },
  { id: 'resume', label: 'Resume Session', keywords: '恢复会话 pi session', description: '从保存的 Session 继续' },
]
assert.deepEqual(filterCommandPaletteItems(localControls, '/new').map((item) => item.id), ['session_new'])
assert.deepEqual(filterCommandPaletteItems(localControls, '/stop').map((item) => item.id), ['stop'])
assert.deepEqual(filterCommandPaletteItems(localControls, '/resume').map((item) => item.id), ['resume'])
assert.deepEqual(filterCommandPaletteItems(localControls, 'resume').map((item) => item.id), ['resume'], '不带斜杠的搜索保持不变')
assert.deepEqual(localControlCommands.slice(0, 4).map((item) => item.name), ['new', 'stop', 'reload', 'resume'])
assert.deepEqual(filterLocalControlCommands('st').map((item) => item.name), ['stop', 'state'])
assert.deepEqual(filterLocalControlCommands('tree').map((item) => item.name), ['tree'])
assert.equal(submittedLocalControl('/stop')?.action, 'stop')
assert.equal(submittedLocalControl('/stop now'), undefined, '带参数的文字不是本地控制操作')

// 补全 = 整段替换为 "/name "，尾部空格进入参数输入
assert.equal(applySlashCompletion('idea'), '/idea ')
assert.equal(prefixSlashCommand('idea', '做一个更清楚的登录页'), '/idea 做一个更清楚的登录页')
assert.equal(applySlashArgumentCompletion('review', 'src/components'), '/review src/components')

// prompt/skill 归输入框；extension 归运行面板
assert.equal(commandGoesToComposer(cmd('idea', 'prompt')), true)
assert.equal(commandGoesToComposer(cmd('skill:demo', 'skill')), true)
assert.equal(commandGoesToComposer(cmd('review', 'extension')), false)

console.log('command suggest tests passed')
