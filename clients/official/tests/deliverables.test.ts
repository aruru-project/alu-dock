import assert from 'node:assert/strict'
import {
  downloadedDelivery,
  pastDownloadedDeliveries,
  persistDownloadHistory,
  readDownloadHistory,
  recordDownloadedDelivery,
  removeDownloadedDeliveries,
} from '../src/lib/downloadHistory.ts'

const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
} as Storage

const first = {
  hostId: 'host-a',
  instanceId: 'work-a',
  deliveryRef: 'delivery-1',
  name: 'report.zip',
  sizeBytes: 42,
  savedLocation: { kind: 'path' as const, value: '/Downloads/report.zip', label: '/Downloads/report.zip' },
  downloadedAt: '2026-08-19T11:00:00.000Z',
  sha256: 'a'.repeat(64),
  workName: 'Release',
}

const completed = recordDownloadedDelivery(readDownloadHistory(storage), first)
assert.equal(persistDownloadHistory(storage, completed), true)
const afterRestart = readDownloadHistory(storage)
assert.equal(downloadedDelivery(afterRestart, 'host-a', 'work-a', 'delivery-1')?.savedLocation.value, '/Downloads/report.zip')
assert.equal(downloadedDelivery(afterRestart, 'host-a', 'work-a', 'delivery-2'), undefined, 'a new delivery item remains downloadable even when it represents the same file')
assert.equal(downloadedDelivery(afterRestart, 'host-a', 'work-b', 'delivery-1'), undefined, 'download receipts stay scoped to their Work')

const past = {
  ...first,
  instanceId: 'work-b',
  deliveryRef: 'delivery-old',
  name: 'older-report.zip',
  downloadedAt: '2026-08-18T11:00:00.000Z',
}
const withPast = recordDownloadedDelivery(afterRestart, past)
const visiblePastWhileCurrentWorkLoads = pastDownloadedDeliveries(withPast, 'host-a', 'work-a', [], false)
assert.deepEqual(visiblePastWhileCurrentWorkLoads.map((item) => item.deliveryRef), ['delivery-old'])
const cleared = removeDownloadedDeliveries(withPast, visiblePastWhileCurrentWorkLoads)
assert.equal(persistDownloadHistory(storage, cleared), true)
assert.equal(downloadedDelivery(readDownloadHistory(storage), 'host-a', 'work-a', 'delivery-1')?.name, 'report.zip', 'clearing past downloads keeps the current Work receipt available')
assert.equal(downloadedDelivery(readDownloadHistory(storage), 'host-a', 'work-b', 'delivery-old'), undefined)

console.log('download receipts preserve the current Work while past records are cleared')
