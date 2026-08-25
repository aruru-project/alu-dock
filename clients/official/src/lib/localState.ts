import type { AttachmentDto, MachinePlatform } from './types'

export const LOCAL_UI_STATE_KEY = 'aludock.uiState'
export const LEGACY_SELECTED_WORK_KEY = 'aludock.selectedWork'
export const LEGACY_DRAFT_KEY = 'aludock.draft'
export const LOCAL_UI_STATE_SCHEMA_VERSION = 4 as const

export interface ConnectionLocalUiState {
  selectedWorkId: string | null
  drafts: Record<string, string>
  attachments: Record<string, AttachmentDto[]>
  recentWorkspaces: Record<string, string[]>
  detailMode: boolean
}

export interface LocalUiState {
  schemaVersion: typeof LOCAL_UI_STATE_SCHEMA_VERSION
  activeConnectionId: string | null
  connections: Record<string, ConnectionLocalUiState>
}

export interface LegacyLocalUiState {
  selectedWorkId: string | null
  draft: string | null
}

const MAX_ID_LENGTH = 512
const MAX_DRAFT_LENGTH = 1_000_000
const MAX_WORKSPACE_PATH_LENGTH = 16_384
const MAX_RECENT_MACHINES = 64
export const MAX_RECENT_WORKSPACES_PER_MACHINE = 8
export function emptyLocalUiState(): LocalUiState {
  return { schemaVersion: LOCAL_UI_STATE_SCHEMA_VERSION, activeConnectionId: null, connections: dictionary<ConnectionLocalUiState>() }
}

/** Pure, fail-soft decoder that upgrades supported historical schemas in memory. */
export function decodeLocalUiState(serialized: string | null): LocalUiState | null {
  if (serialized === null) return null
  try {
    return normalizeLocalUiState(JSON.parse(serialized))
  } catch {
    return null
  }
}

/** Pure legacy-key migration scoped to the connection that was active when migration ran. */
export function migrateLocalUiState(
  persisted: LocalUiState | null,
  legacy: LegacyLocalUiState,
  connectionId: string,
): LocalUiState {
  const next = cloneLocalUiState(persisted ?? emptyLocalUiState())
  next.activeConnectionId = connectionId
  if (!Object.hasOwn(next.connections, connectionId)) {
    const selectedWorkId = persisted === null ? safeId(legacy.selectedWorkId) : null
    const drafts = dictionary<string>()
    if (selectedWorkId && persisted === null && typeof legacy.draft === 'string' && legacy.draft.length > 0) {
      drafts[selectedWorkId] = legacy.draft.slice(0, MAX_DRAFT_LENGTH)
    }
    next.connections[connectionId] = {
      selectedWorkId,
      drafts,
      attachments: dictionary<AttachmentDto[]>(),
      recentWorkspaces: dictionary<string[]>(),
      detailMode: true,
    }
  }
  return next
}

export function readAndMigrateLocalUiState(storage: Storage | null, connectionId: string): LocalUiState {
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

  const next = migrateLocalUiState(decodeLocalUiState(serialized), legacy, connectionId)
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
    storage.setItem(LOCAL_UI_STATE_KEY, JSON.stringify(state, (key, value) => key === 'sourceToken' ? undefined : value))
    return true
  } catch {
    return false
  }
}

function normalizeLocalUiState(value: unknown): LocalUiState | null {
  if (!isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4)) return null
  const rawConnections = value.schemaVersion === 4 ? value.connections : value.hosts
  if (!isRecord(rawConnections)) return null
  const connections = dictionary<ConnectionLocalUiState>()
  for (const [connectionId, hostValue] of Object.entries(rawConnections)) {
    if (!safeId(connectionId) || !isRecord(hostValue) || !isRecord(hostValue.drafts)) continue
    const drafts = dictionary<string>()
    for (const [workId, draft] of Object.entries(hostValue.drafts)) {
      if (safeId(workId) && typeof draft === 'string') drafts[workId] = draft.slice(0, MAX_DRAFT_LENGTH)
    }
    const attachments = dictionary<AttachmentDto[]>()
    if (value.schemaVersion >= 2 && isRecord(hostValue.attachments)) {
      for (const [workId, raw] of Object.entries(hostValue.attachments)) {
        if (!safeId(workId) || !Array.isArray(raw)) continue
        const valid = raw.map(normalizeAttachment).filter((item): item is AttachmentDto => item !== null)
        if (valid.length) attachments[workId] = uniqueAttachments(valid)
      }
    }
    const recentWorkspaces = dictionary<string[]>()
    if (value.schemaVersion >= 3 && isRecord(hostValue.recentWorkspaces)) {
      for (const [machineHostId, rawPaths] of Object.entries(hostValue.recentWorkspaces).slice(0, MAX_RECENT_MACHINES)) {
        if (!safeId(machineHostId) || !Array.isArray(rawPaths)) continue
        const paths = uniqueWorkspacePaths(rawPaths)
        if (paths.length) recentWorkspaces[machineHostId] = paths
      }
    }
    connections[connectionId] = {
      selectedWorkId: safeId(hostValue.selectedWorkId),
      drafts,
      attachments,
      recentWorkspaces,
      detailMode: typeof hostValue.detailMode === 'boolean' ? hostValue.detailMode : true,
    }
  }
  return {
    schemaVersion: LOCAL_UI_STATE_SCHEMA_VERSION,
    activeConnectionId: safeId(value.schemaVersion === 4 ? value.activeConnectionId : value.activeHostId),
    connections,
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
  const localUpload = normalizeLocalAttachmentUpload(value.localUpload)
  return {
    fileId: value.fileId,
    name: value.name,
    sizeBytes: value.sizeBytes,
    ...(typeof value.mediaType === 'string' ? { mediaType: value.mediaType } : {}),
    sha256: value.sha256,
    storedAt: value.storedAt,
    ...(localUpload ? { localUpload } : {}),
  }
}

function normalizeLocalAttachmentUpload(value: unknown): AttachmentDto['localUpload'] | null {
  if (!isRecord(value)) return null
  const connectionId = typeof value.connectionId === 'string' ? value.connectionId : value.hostId
  if (typeof connectionId !== 'string' || !safeId(connectionId)
    || typeof value.selectionGeneration !== 'number' || !Number.isSafeInteger(value.selectionGeneration) || value.selectionGeneration < 1
    || typeof value.instanceId !== 'string' || !safeId(value.instanceId)
    || typeof value.machineHostId !== 'string' || !safeId(value.machineHostId)
    || typeof value.ownerHostEpoch !== 'string' || !value.ownerHostEpoch
    || typeof value.runtimeGeneration !== 'number' || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 0) return null
  return {
    connectionId,
    selectionGeneration: value.selectionGeneration,
    instanceId: value.instanceId,
    machineHostId: value.machineHostId,
    ownerHostEpoch: value.ownerHostEpoch,
    runtimeGeneration: value.runtimeGeneration,
  }
}

function uniqueAttachments(items: AttachmentDto[]) {
  const seen = new Set<string>()
  return items.filter((item) => !seen.has(item.fileId) && seen.add(item.fileId))
}

function cloneLocalUiState(state: LocalUiState): LocalUiState {
  const connections = dictionary<ConnectionLocalUiState>()
  for (const [connectionId, connection] of Object.entries(state.connections)) {
    const attachments = dictionary<AttachmentDto[]>()
    for (const [workId, items] of Object.entries(connection.attachments)) attachments[workId] = items.map((item) => ({ ...item }))
    const recentWorkspaces = dictionary<string[]>()
    for (const [machineHostId, paths] of Object.entries(connection.recentWorkspaces)) recentWorkspaces[machineHostId] = [...paths]
    connections[connectionId] = {
      selectedWorkId: connection.selectedWorkId,
      drafts: Object.assign(dictionary<string>(), connection.drafts),
      attachments,
      recentWorkspaces,
      detailMode: connection.detailMode,
    }
  }
  return {
    schemaVersion: LOCAL_UI_STATE_SCHEMA_VERSION,
    activeConnectionId: state.activeConnectionId,
    connections,
  }
}

export function rememberRecentWorkspace(
  state: LocalUiState,
  connectionId: string,
  machineHostId: string,
  path: string,
  platform?: MachinePlatform,
): boolean {
  const connection = state.connections[connectionId]
  if (!connection || !safeId(machineHostId) || !safeWorkspacePath(path)) return false
  if (!Object.hasOwn(connection.recentWorkspaces, machineHostId)) {
    const machineIds = Object.keys(connection.recentWorkspaces)
    if (machineIds.length >= MAX_RECENT_MACHINES) delete connection.recentWorkspaces[machineIds[0]!]
  }
  const current = connection.recentWorkspaces[machineHostId] ?? []
  const key = workspacePathKey(path, platform)
  connection.recentWorkspaces[machineHostId] = [
    path,
    ...current.filter((candidate) => workspacePathKey(candidate, platform) !== key),
  ].slice(0, MAX_RECENT_WORKSPACES_PER_MACHINE)
  return true
}

function uniqueWorkspacePaths(values: unknown[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const value of values) {
    if (!safeWorkspacePath(value) || seen.has(value)) continue
    seen.add(value)
    paths.push(value)
    if (paths.length === MAX_RECENT_WORKSPACES_PER_MACHINE) break
  }
  return paths
}

function workspacePathKey(path: string, platform?: MachinePlatform) {
  if (platform !== 'windows') return path
  const windows = path.replaceAll('/', '\\')
  return (/^[a-z]:\\$/i.test(windows) ? windows : windows.replace(/\\+$/u, '')).toLocaleLowerCase('en-US')
}

function safeWorkspacePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WORKSPACE_PATH_LENGTH
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
