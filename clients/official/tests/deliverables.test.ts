import assert from 'node:assert/strict'
import {
  clearDownloadHistory,
  downloadedDelivery,
  persistDownloadHistory,
  readDownloadHistory,
  recordDownloadedDelivery,
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

const cleared = clearDownloadHistory()
assert.equal(persistDownloadHistory(storage, cleared), true)
assert.deepEqual(readDownloadHistory(storage).items, [])

console.log('downloaded delivery history remains local until the user clears it')
