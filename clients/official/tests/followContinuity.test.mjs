// #298: Host controller-only events consume sequence numbers but are not
// delivered on ordinary Follow. They must not trigger a conversation reload.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'

const root = fileURLToPath(new URL('../', import.meta.url))
globalThis.window = { location: { search: '' } }
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { reduceLiveEvent } = await server.ssrLoadModule('/src/lib/liveReducer.ts')
  const { useExtensionUiStore } = await server.ssrLoadModule('/src/stores/extension-ui.ts')
  setActivePinia(createPinia())
  const extension = useExtensionUiStore()
  const context = { connectionId: 'host', selectionGeneration: 1 }
  const instance = { id: 'work', ownerHostEpoch: 'epoch', runtimeGeneration: 1, extensionStatus: {}, pending: { steering: 0, followUp: 0, total: 0 }, executor: { kind: 'pi', piSessionId: 'session' } }
  let state = { ...context, instance, hostEpoch: 'epoch', queue: [], sequence: 10 }
  await extension.bootstrap(context, 'follow', {
    instance, records: [], activeEvents: [], queue: [], historyRevision: 1, historyTruncated: false,
    cursor: { instanceId: 'work', hostEpoch: 'epoch', runtimeGeneration: 1, sequence: 10 },
    extensionUi: { status: {}, toolsExpanded: false, events: [] },
  })
  for (const sequence of [11, 14]) {
    const event = { sequence, runtimeGeneration: 1, occurredAt: '2026-09-15T00:00:00Z', eventType: 'extension.status_changed', data: { key: 'phase', text: `visible-${sequence}` } }
    const reduced = reduceLiveEvent(state, { ...context, instanceId: 'work', event })
    assert.equal(reduced.kind, 'applied', 'hidden controller events do not require a new conversation')
    state = reduced.state
    assert.equal(await extension.applyLive('work', 'follow', event), true, 'Extension UI follows the same visible stream')
  }
  assert.equal(state.instance.extensionStatus.phase, 'visible-14')
  assert.equal(extension.status.phase, 'visible-14')
  console.log('PASS: visible Follow continues across controller-only event numbers in conversation and Extension UI')
} finally {
  await server.close()
  delete globalThis.window
}
