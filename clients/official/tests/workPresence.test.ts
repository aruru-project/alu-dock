import assert from 'node:assert/strict'
import { workPresence } from '../src/lib/uiBoundaries.ts'

// 真值表对齐 Dock 侧 humanInstanceStatus / activityFromSnapshot（alu_dock/src/core）：
// lifecycle 只表示实例是否存在；agent 是否在做事由 execution / compacting 决定。
const base = { lifecycle: 'active', execution: 'idle', compacting: false, activeInteraction: undefined } as const

{
  const presence = workPresence({ ...base, execution: 'running' })
  assert.equal(presence.tone, 'running')
  assert.equal(presence.label, '运行中')
}
{
  const presence = workPresence({ ...base })
  assert.equal(presence.tone, 'idle', 'an attached instance without an active run reads as idle, never 运行中')
  assert.equal(presence.label, '空闲')
}
{
  const presence = workPresence({ ...base, execution: 'failed' })
  assert.equal(presence.tone, 'failed')
  assert.equal(presence.label, '运行失败')
}
{
  const presence = workPresence({ ...base, execution: 'unavailable' })
  assert.equal(presence.label, '无响应')
}
{
  const presence = workPresence({ ...base, execution: 'running', compacting: true })
  assert.equal(presence.tone, 'compacting', 'compaction outranks the running boundary')
  assert.equal(presence.label, '压缩中')
}
{
  const presence = workPresence({ ...base, execution: 'running', activeInteraction: { id: 'i1', method: 'confirm' } })
  assert.equal(presence.tone, 'waiting')
  assert.equal(presence.label, '等待确认')
}
{
  const presence = workPresence({ ...base, lifecycle: 'host_lost' })
  assert.equal(presence.tone, 'lost')
  assert.equal(presence.label, '连接已中断')
}
{
  const presence = workPresence({ ...base, lifecycle: 'runtime_error', execution: 'unavailable' })
  assert.equal(presence.tone, 'error')
  assert.equal(presence.label, '运行故障')
}
{
  const presence = workPresence({ ...base, lifecycle: 'stopping', execution: 'running' })
  assert.equal(presence.label, '正在停止')
}
{
  const presence = workPresence({ ...base, lifecycle: 'stopped', execution: 'unavailable' })
  assert.equal(presence.tone, 'stopped')
  assert.equal(presence.label, '已停止')
}

console.log('work presence tests passed')
