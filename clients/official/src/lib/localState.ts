import type { AttachmentDto } from './types'

export const LOCAL_UI_STATE_KEY = 'aludock.uiState'
export const LEGACY_SELECTED_WORK_KEY = 'aludock.selectedWork'
export const LEGACY_DRAFT_KEY = 'aludock.draft'
export const LOCAL_UI_STATE_SCHEMA_VERSION = 2 as const

export interface HostLocalUiState {
  selectedWorkId: string | null
  drafts: Record<string, string>
  attachments: Record<string, AttachmentDto[]>
  detailMode: boolean
}

export interface LocalUiState {
  schemaVersion: typeof LOCAL_UI_STATE_SCHEMA_VERSION
  activeHostId: string | null
  hosts: Record<string, HostLocalUiState>
}

export interface LegacyLocalUiState {
  selectedWorkId: string | null
  draft: string | null
}

const MAX_ID_LENGTH = 512
const MAX_DRAFT_LENGTH = 1_000_000
export function emptyLocalUiState(): LocalUiState {
  return { schemaVersion: LOCAL_UI_STATE_SCHEMA_VERSION, activeHostId: null, hosts: dictionary<HostLocalUiState>() }
}

/** Pure, fail-soft decoder with an in-place schema-v1 migration. */
export function decodeLocalUiState(serialized: string | null): LocalUiState | null {
  if (serialized === null) return null
  try {
    return normalizeLocalUiState(JSON.parse(serialized))
  } catch {
    return null
  }
}

/** Pure legacy-key migration scoped to the Host that was active when migration ran. */
export function migrateLocalUiState(
  persisted: LocalUiState | null,
  legacy: LegacyLocalUiState,
  hostId: string,
): LocalUiState {
  const next = cloneLocalUiState(persisted ?? emptyLocalUiState())
  next.activeHostId = hostId
  if (!Object.hasOwn(next.hosts, hostId)) {
    const selectedWorkId = persisted === null ? safeId(legacy.selectedWorkId) : null
    const drafts = dictionary<string>()
    if (selectedWorkId && persisted === null && typeof legacy.draft === 'string' && legacy.draft.length > 0) {
      drafts[selectedWorkId] = legacy.draft.slice(0, MAX_DRAFT_LENGTH)
    }
    next.hosts[hostId] = { selectedWorkId, drafts, attachments: dictionary<AttachmentDto[]>(), detailMode: true }
  }
  return next
}

export function readAndMigrateLocalUiState(storage: Storage | null, hostId: string): LocalUiState {
  let serialized: string | null = null
  let legacy: LegacyLocalUiState = { selectedWorkId: null, draft: null }
  try {
    serialized = storage?.getItem(LOCAL_UI_STATE_KEY) ?? null
    legacy = {
      selectedWorkId: storage?.getItem(LEGACY_SELECTED_WORK_KEY) ?? null,
      draft: storage?.getItem(LEGACY_DRAFT_KEY) ?? null,
    }
  } catch {
    // Storage can be disabled; the in-memory state remains usable.
  }

  const next = migrateLocalUiState(decodeLocalUiState(serialized), legacy, hostId)
  try {
    storage?.setItem(LOCAL_UI_STATE_KEY, JSON.stringify(next))
    storage?.removeItem(LEGACY_SELECTED_WORK_KEY)
    storage?.removeItem(LEGACY_DRAFT_KEY)
  } catch {
    // Quota/security failures must never prevent bootstrap.
  }
  return next
}

export function persistLocalUiState(storage: Storage | null, state: LocalUiState): boolean {
  try {
    if (!storage) return false
    storage.setItem(LOCAL_UI_STATE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

function normalizeLocalUiState(value: unknown): LocalUiState | null {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !isRecord(value.hosts)) return null
  const hosts = dictionary<HostLocalUiState>()
  for (const [hostId, hostValue] of Object.entries(value.hosts)) {
    if (!safeId(hostId) || !isRecord(hostValue) || !isRecord(hostValue.drafts)) continue
    const drafts = dictionary<string>()
    for (const [workId, draft] of Object.entries(hostValue.drafts)) {
      if (safeId(workId) && typeof draft === 'string') drafts[workId] = draft.slice(0, MAX_DRAFT_LENGTH)
    }
    const attachments = dictionary<AttachmentDto[]>()
    if (value.schemaVersion === 2 && isRecord(hostValue.attachments)) {
      for (const [workId, raw] of Object.entries(hostValue.attachments)) {
        if (!safeId(workId) || !Array.isArray(raw)) continue
        const valid = raw.map(normalizeAttachment).filter((item): item is AttachmentDto => item !== null)
        if (valid.length) attachments[workId] = uniqueAttachments(valid)
      }
    }
    hosts[hostId] = {
      selectedWorkId: safeId(hostValue.selectedWorkId),
      drafts,
      attachments,
      detailMode: typeof hostValue.detailMode === 'boolean' ? hostValue.detailMode : true,
    }
  }
  return {
    schemaVersion: LOCAL_UI_STATE_SCHEMA_VERSION,
    activeHostId: safeId(value.activeHostId),
    hosts,
  }
}

function normalizeAttachment(value: unknown): AttachmentDto | null {
  if (!isRecord(value)
    || typeof value.fileId !== 'string' || !value.fileId
    || typeof value.name !== 'string' || !value.name
    || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.storedAt !== 'string'
    || (value.mediaType !== undefined && typeof value.mediaType !== 'string')) return null
  return {
    fileId: value.fileId,
    name: value.name,
    sizeBytes: value.sizeBytes,
    ...(typeof value.mediaType === 'string' ? { mediaType: value.mediaType } : {}),
    sha256: value.sha256,
    storedAt: value.storedAt,
  }
}

function uniqueAttachments(items: AttachmentDto[]) {
  const seen = new Set<string>()
  return items.filter((item) => !seen.has(item.fileId) && seen.add(item.fileId))
}

function cloneLocalUiState(state: LocalUiState): LocalUiState {
  const hosts = dictionary<HostLocalUiState>()
  for (const [hostId, host] of Object.entries(state.hosts)) {
    const attachments = dictionary<AttachmentDto[]>()
    for (const [workId, items] of Object.entries(host.attachments)) attachments[workId] = items.map((item) => ({ ...item }))
    hosts[hostId] = {
      selectedWorkId: host.selectedWorkId,
      drafts: Object.assign(dictionary<string>(), host.drafts),
      attachments,
      detailMode: host.detailMode,
    }
  }
  return {
    schemaVersion: LOCAL_UI_STATE_SCHEMA_VERSION,
    activeHostId: state.activeHostId,
    hosts,
  }
}

function safeId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}
