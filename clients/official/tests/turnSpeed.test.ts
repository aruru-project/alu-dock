import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import type { ProjectedEvent } from '../src/lib/types.ts'

// turnSpeed imports the projector's live turn ids, so it loads through Vite.
const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom' })
const { createTurnSpeedMeter, formatTurnSpeed, turnsHandedOff } = await server.ssrLoadModule('/src/lib/turnSpeed.ts') as typeof import('../src/lib/turnSpeed.ts')

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 2, 12, 0, 0) + seconds * 1000).toISOString()
function feed() {
  const meter = createTurnSpeedMeter()
  let sequence = 0
  return (eventType: string, seconds: number, output: number | undefined, data: Record<string, unknown> = {}, skipped = 0) => {
    const previous = sequence
    sequence += 1 + skipped
    const event: ProjectedEvent = { sequence, runtimeGeneration: 1, occurredAt: at(seconds), eventType, data }
    return meter.apply(event, skipped ? previous + skipped : previous, output)
  }
}

{
  const apply = feed()
  apply('run.started', 0, 100)
  apply('message.submitted', 0, 100, { role: 'user' })
  apply('message.delta', 5, 100, { block: 'thinking', delta: '想' })
  apply('tool.started', 6, 100, { toolCallId: 'call-1' })
  apply('message.completed', 7, 100, { role: 'assistant' })
  // Execution: the same call reports its start again, a running tool calls another one.
  apply('tool.args_updated', 8, 100, { toolCallId: 'call-1' })
  apply('tool.started', 9, 100, { toolCallId: 'call-1/1' })
  apply('tool.completed', 20, 100, { toolCallId: 'call-1' })
  apply('message.delta', 30, 100, { block: 'text', delta: '好' })
  apply('message.completed', 32, 100, { role: 'assistant' })
  assert.deepEqual(apply('session.metrics_changed', 32, 500), { turnId: 'live-turn-1', tokensPerSecond: 100 },
    '一轮的速度 = 新增输出 400 ÷ 两次出字共 4 秒；等待首字和工具执行的时间不算')
  apply('run.settled', 33, 500)
  assert.deepEqual(apply('session.metrics_changed', 33, 600), { turnId: 'live-turn-1', tokensPerSecond: 125 },
    '运行结束后才报到的最后一次输出仍计入这一轮')
  assert.equal(apply('compaction.started', 40, 600), undefined, '结束后的压缩不会抹掉已显示的速度')
}

{
  const apply = feed()
  apply('run.started', 0, 100)
  apply('message.delta', 1, 100, { block: 'text', delta: '先' })
  assert.equal(apply('session.metrics_changed', 3, 400), undefined, '回复还没结束时不按半截时间算')
  assert.deepEqual(apply('message.completed', 3, 400, { role: 'assistant' }), { turnId: 'live-turn-1', tokensPerSecond: 150 },
    'token 总数先于回复结束送到时，结束那一刻按完整时间算出速度')
}

{
  const apply = feed()
  apply('message.delta', 0, 100, { block: 'text', delta: '中途' })
  apply('message.completed', 5, 100, { role: 'assistant' })
  assert.equal(apply('session.metrics_changed', 5, 300), undefined, '没有从开头看到的轮不显示速度')
}

{
  const apply = feed()
  apply('run.started', 0, 100)
  apply('message.delta', 1, 100)
  apply('message.completed', 4, 100, { role: 'assistant' })
  assert.ok(apply('session.metrics_changed', 4, 400)?.tokensPerSecond)
  assert.deepEqual(apply('message.delta', 20, 400, {}, 3), { turnId: 'live-turn-1' }, '运行中漏看了事件，这一轮的速度撤下')
  assert.equal(apply('session.metrics_changed', 25, 900), undefined)
}

{
  const apply = feed()
  apply('run.started', 0, 100)
  apply('message.delta', 1, 100)
  apply('message.completed', 4, 100, { role: 'assistant' })
  apply('session.metrics_changed', 4, 400)
  assert.deepEqual(apply('compaction.started', 5, 400), { turnId: 'live-turn-1' }, '运行中发生压缩，这一轮的速度撤下')
}

{
  const apply = feed()
  apply('run.started', 0, 100)
  apply('message.delta', 1, 100)
  apply('message.completed', 1.5, 100, { role: 'assistant' })
  assert.equal(apply('session.metrics_changed', 2, 150), undefined, '出字不到 1 秒不显示速度')
}

assert.deepEqual(turnsHandedOff(['turn:a', 'live-turn-5'], ['turn:a', 'turn:b']), [['live-turn-5', 'turn:b']],
  '运行结束交给历史后，速度跟着这一轮换到历史的位置')
assert.deepEqual(turnsHandedOff(['turn:a', 'turn:x'], ['turn:a', 'turn:y']), [], '切换分支换掉的历史轮不继承别的轮的速度')

assert.equal(formatTurnSpeed(123.4), '123 tok/s')
assert.equal(formatTurnSpeed(8.25), '8.3 tok/s')
await server.close()
