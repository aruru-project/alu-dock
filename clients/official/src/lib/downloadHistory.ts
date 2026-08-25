import type { DeliverableDto, SavedDeliverableLocation } from './types'

export const DOWNLOAD_HISTORY_KEY = 'aludock.downloadHistory'
export const DOWNLOAD_HISTORY_SCHEMA_VERSION = 2 as const

export interface DownloadedDeliverable {
  connectionId: string
  instanceId: string
  deliveryRef: string
  name: string
  sizeBytes: number
  savedLocation: SavedDeliverableLocation
  downloadedAt: string
  sha256: string
  workName?: string
}

export interface DownloadHistory {
  schemaVersion: typeof DOWNLOAD_HISTORY_SCHEMA_VERSION
  items: DownloadedDeliverable[]
}

export function emptyDownloadHistory(): DownloadHistory {
  return { schemaVersion: DOWNLOAD_HISTORY_SCHEMA_VERSION, items: [] }
}

export function deliveryHistoryKey(connectionId: string, instanceId: string, deliveryRef: string) {
  return JSON.stringify([connectionId, instanceId, deliveryRef])
}

export function downloadedDelivery(
  history: DownloadHistory,
  connectionId: string,
  instanceId: string,
  deliveryRef: string,
): DownloadedDeliverable | undefined {
  const key = deliveryHistoryKey(connectionId, instanceId, deliveryRef)
  return history.items.find((item) => deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef) === key)
}

export function recordDownloadedDelivery(
  history: DownloadHistory,
  item: DownloadedDeliverable,
): DownloadHistory {
  const key = deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef)
  return {
    schemaVersion: DOWNLOAD_HISTORY_SCHEMA_VERSION,
    items: [
      { ...item, savedLocation: { ...item.savedLocation } },
      ...history.items
        .filter((candidate) => deliveryHistoryKey(candidate.connectionId, candidate.instanceId, candidate.deliveryRef) !== key)
        .map(cloneItem),
    ],
  }
}

export function removeDownloadedDeliveries(
  history: DownloadHistory,
  items: readonly DownloadedDeliverable[],
): DownloadHistory {
  const removed = new Set(items.map((item) => deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef)))
  return {
    schemaVersion: DOWNLOAD_HISTORY_SCHEMA_VERSION,
    items: history.items
      .filter((item) => !removed.has(deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef)))
      .map(cloneItem),
  }
}

export function readDownloadHistory(storage: Storage | null): DownloadHistory {
  try {
    return decodeDownloadHistory(storage?.getItem(DOWNLOAD_HISTORY_KEY) ?? null) ?? emptyDownloadHistory()
  } catch {
    return emptyDownloadHistory()
  }
}

export function persistDownloadHistory(storage: Storage | null, history: DownloadHistory): boolean {
  try {
    if (!storage) return false
    storage.setItem(DOWNLOAD_HISTORY_KEY, JSON.stringify(history))
    return true
  } catch {
    return false
  }
}

export function decodeDownloadHistory(serialized: string | null): DownloadHistory | null {
  if (serialized === null) return null
  try {
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !Array.isArray(value.items)) return null
    const seen = new Set<string>()
    const items: DownloadedDeliverable[] = []
    for (const raw of value.items) {
      const item = normalizeItem(raw, value.schemaVersion)
      if (!item) continue
      const key = deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
    return { schemaVersion: DOWNLOAD_HISTORY_SCHEMA_VERSION, items }
  } catch {
    return null
  }
}

export function pastDownloadedDeliveries(
  history: DownloadHistory,
  connectionId: string,
  instanceId: string,
  deliverables: readonly DeliverableDto[],
  currentListLoaded: boolean,
): DownloadedDeliverable[] {
  if (!currentListLoaded) {
    return history.items.filter((item) => item.connectionId !== connectionId || item.instanceId !== instanceId)
  }
  return history.items.filter((item) => !deliverables.some((deliverable) =>
    downloadedItemMatches(item, connectionId, instanceId, deliverable)))
}

export function downloadedItemMatches(
  item: DownloadedDeliverable,
  connectionId: string,
  instanceId: string,
  deliverable: DeliverableDto,
) {
  return deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef)
    === deliveryHistoryKey(connectionId, instanceId, deliverable.deliveryRef)
}

function normalizeItem(value: unknown, schemaVersion: 1 | 2): DownloadedDeliverable | null {
  if (!isRecord(value)) return null
  const connectionId = schemaVersion === 1 ? value.hostId : value.connectionId
  if (!nonempty(connectionId)
    || !nonempty(value.instanceId)
    || !nonempty(value.deliveryRef)
    || !nonempty(value.name)
    || typeof value.sizeBytes !== 'number'
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0
    || !isSavedLocation(value.savedLocation)
    || !nonempty(value.downloadedAt)
    || !Number.isFinite(Date.parse(value.downloadedAt))
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || (value.workName !== undefined && typeof value.workName !== 'string')) return null
  return {
    connectionId,
    instanceId: value.instanceId,
    deliveryRef: value.deliveryRef,
    name: value.name,
    sizeBytes: value.sizeBytes,
    savedLocation: { ...value.savedLocation },
    downloadedAt: value.downloadedAt,
    sha256: value.sha256,
    ...(value.workName ? { workName: value.workName } : {}),
  }
}

function isSavedLocation(value: unknown): value is SavedDeliverableLocation {
  return isRecord(value)
    && (value.kind === 'path' || value.kind === 'uri')
    && nonempty(value.value)
    && nonempty(value.label)
}

function cloneItem(item: DownloadedDeliverable): DownloadedDeliverable {
  return { ...item, savedLocation: { ...item.savedLocation } }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
