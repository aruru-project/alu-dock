import type { DeliverableDto, SavedDeliverableLocation } from './types'

export const DOWNLOAD_HISTORY_KEY = 'aludock.downloadHistory'
export const DOWNLOAD_HISTORY_SCHEMA_VERSION = 1 as const

export interface DownloadedDeliverable {
  hostId: string
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

export function deliveryHistoryKey(hostId: string, instanceId: string, deliveryRef: string) {
  return JSON.stringify([hostId, instanceId, deliveryRef])
}

export function downloadedDelivery(
  history: DownloadHistory,
  hostId: string,
  instanceId: string,
  deliveryRef: string,
): DownloadedDeliverable | undefined {
  const key = deliveryHistoryKey(hostId, instanceId, deliveryRef)
  return history.items.find((item) => deliveryHistoryKey(item.hostId, item.instanceId, item.deliveryRef) === key)
}

export function recordDownloadedDelivery(
  history: DownloadHistory,
  item: DownloadedDeliverable,
): DownloadHistory {
  const key = deliveryHistoryKey(item.hostId, item.instanceId, item.deliveryRef)
  return {
    schemaVersion: DOWNLOAD_HISTORY_SCHEMA_VERSION,
    items: [
      { ...item, savedLocation: { ...item.savedLocation } },
      ...history.items
        .filter((candidate) => deliveryHistoryKey(candidate.hostId, candidate.instanceId, candidate.deliveryRef) !== key)
        .map(cloneItem),
    ],
  }
}

export function removeDownloadedDeliveries(
  history: DownloadHistory,
  items: readonly DownloadedDeliverable[],
): DownloadHistory {
  const removed = new Set(items.map((item) => deliveryHistoryKey(item.hostId, item.instanceId, item.deliveryRef)))
  return {
    schemaVersion: DOWNLOAD_HISTORY_SCHEMA_VERSION,
    items: history.items
      .filter((item) => !removed.has(deliveryHistoryKey(item.hostId, item.instanceId, item.deliveryRef)))
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
    if (!isRecord(value) || value.schemaVersion !== DOWNLOAD_HISTORY_SCHEMA_VERSION || !Array.isArray(value.items)) return null
    const seen = new Set<string>()
    const items: DownloadedDeliverable[] = []
    for (const raw of value.items) {
      const item = normalizeItem(raw)
      if (!item) continue
      const key = deliveryHistoryKey(item.hostId, item.instanceId, item.deliveryRef)
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
  hostId: string,
  instanceId: string,
  deliverables: readonly DeliverableDto[],
  currentListLoaded: boolean,
): DownloadedDeliverable[] {
  if (!currentListLoaded) {
    return history.items.filter((item) => item.hostId !== hostId || item.instanceId !== instanceId)
  }
  return history.items.filter((item) => !deliverables.some((deliverable) =>
    downloadedItemMatches(item, hostId, instanceId, deliverable)))
}

export function downloadedItemMatches(
  item: DownloadedDeliverable,
  hostId: string,
  instanceId: string,
  deliverable: DeliverableDto,
) {
  return deliveryHistoryKey(item.hostId, item.instanceId, item.deliveryRef)
    === deliveryHistoryKey(hostId, instanceId, deliverable.deliveryRef)
}

function normalizeItem(value: unknown): DownloadedDeliverable | null {
  if (!isRecord(value)
    || !nonempty(value.hostId)
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
    hostId: value.hostId,
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
