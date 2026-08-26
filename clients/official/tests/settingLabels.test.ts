import assert from 'node:assert/strict'
import { settingDescription, settingLabel, settingOptionLabel, settingValueLabel } from '../src/lib/settingLabels.ts'

// 设置页使用客户端文案解释 Dock 返回的机器值。
assert.equal(settingLabel('autoCompaction'), 'Auto-compact')
assert.equal(settingDescription('defaultProjectTrust'), '项目尚无信任记录时采用的处理方式')
assert.equal(settingOptionLabel('doubleEscapeAction', 'tree'), '打开 Session Tree')
assert.equal(settingValueLabel('warnings', { anthropicExtraUsage: false }), 'Anthropic 额外用量提醒：关闭')
