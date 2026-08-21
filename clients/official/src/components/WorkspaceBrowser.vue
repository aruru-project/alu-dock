<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FileImage,
  Folder,
  FolderOpen,
  RefreshCw,
  X,
} from '@lucide/vue'
import {
  cancelWorkspaceFileRead,
  clearWorkspaceFileState,
  getWorkspaceEntryMetadata,
  listWorkspaceEntries,
  loadWorkspaceCachedImage,
  loadWorkspaceCachedText,
  readWorkspaceFile,
  saveWorkspaceCachedFile,
  type WorkspaceFileContext,
} from '../lib/bridge'
import { userErrorMessage } from '../lib/userError'
import ImageZoomSurface from './ImageZoomSurface.vue'
import {
  classifyWorkspacePreview as classifyPreview,
  mergeWorkspaceDirectoryEntries,
  workspaceEntryIsDirectory as entryIsDirectory,
  workspaceEntryIsFile as entryIsFile,
  type WorkspacePreviewKind,
} from '../lib/workspaceBrowser'
import type {
  HostContext,
  Work,
  WorkspaceFileCacheResult,
  WorkspaceFileCursor,
  WorkspaceFileEntry,
  WorkspaceFileReadProgress,
} from '../lib/types'

const props = defineProps<{
  open: boolean
  work: Work | null
  context: HostContext | null
  hostEpoch: string
}>()
const emit = defineEmits<{ close: [] }>()

interface DirectoryState {
  entries: WorkspaceFileEntry[]
  revision: string
  nextCursor?: WorkspaceFileCursor
  loading: boolean
  error: string
  loadToken: number
}

type TreeRow =
  | { kind: 'entry'; entry: WorkspaceFileEntry; depth: number }
  | { kind: 'more'; path: string; depth: number }
  | { kind: 'status'; path: string; depth: number; text: string; retryable: boolean }
type PreviewKind = WorkspacePreviewKind
type PreviewPhase = 'empty' | 'metadata' | 'confirm' | 'reading' | 'ready' | 'unsupported' | 'error'
type PendingIntent = 'preview' | 'save'

const directories = reactive<Record<string, DirectoryState>>({})
const expandedPaths = ref(new Set<string>(['.']))
const showHidden = ref(false)
const mobilePath = ref('.')
const mobilePreview = ref(false)
const selectedEntry = ref<WorkspaceFileEntry | null>(null)
const previewKind = ref<PreviewKind>('unsupported')
const previewPhase = ref<PreviewPhase>('empty')
const previewText = ref('')
const previewImageUrl = ref('')
const previewError = ref('')
const cacheResult = ref<WorkspaceFileCacheResult | null>(null)
const largeFileConfirmBytes = ref(10 * 1024 * 1024)
const pendingIntent = ref<PendingIntent>('preview')
const progressBytes = ref(0)
const progressTotal = ref(0)
const activeReadId = ref('')
const saving = ref(false)
const saveStatus = ref('')
const isMobile = ref(false)
let operationEpoch = 0
let unlistenProgress: UnlistenFn | null = null
let mediaQuery: MediaQueryList | null = null
let componentMounted = false

const selectedPathLabel = computed(() => {
  const path = selectedEntry.value?.path
  return path ? displayPath(path) : '选择一个文件查看内容'
})
const progressPercent = computed(() => {
  if (!progressTotal.value) return 0
  return Math.max(0, Math.min(100, Math.round(progressBytes.value / progressTotal.value * 100)))
})
const currentMobileState = computed(() => directories[mobilePath.value])
const mobileBreadcrumbs = computed(() => {
  const parts = mobilePath.value === '.' ? [] : mobilePath.value.split('/')
  return [
    { name: '.', path: '.' },
    ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') })),
  ]
})

function currentContext(): WorkspaceFileContext | null {
  if (!props.context || !props.work || props.work.lifecycle !== 'active' || !props.hostEpoch) return null
  return {
    ...props.context,
    instanceId: props.work.id,
    expectedHostEpoch: props.hostEpoch,
    expectedRuntimeGeneration: props.work.runtimeGeneration,
  }
}

function contextMatches(context: WorkspaceFileContext): boolean {
  const current = currentContext()
  return !!current
    && current.hostId === context.hostId
    && current.selectionGeneration === context.selectionGeneration
    && current.instanceId === context.instanceId
    && current.expectedHostEpoch === context.expectedHostEpoch
    && current.expectedRuntimeGeneration === context.expectedRuntimeGeneration
}

function visibleEntries(path: string): WorkspaceFileEntry[] {
  return (directories[path]?.entries ?? []).filter((entry) => showHidden.value || !entry.hidden)
}

const treeRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = []
  const visit = (path: string, depth: number) => {
    const state = directories[path]
    if (!state) return
    for (const entry of visibleEntries(path)) {
      rows.push({ kind: 'entry', entry, depth })
      if (entryIsDirectory(entry) && expandedPaths.value.has(entry.path)) visit(entry.path, depth + 1)
    }
    if (state.loading) rows.push({ kind: 'status', path, depth, text: '正在读取…', retryable: false })
    else if (state.error) rows.push({ kind: 'status', path, depth, text: state.error, retryable: true })
    else if (state.nextCursor) rows.push({ kind: 'more', path, depth })
  }
  if (expandedPaths.value.has('.')) visit('.', 0)
  return rows
})

function displayPath(path: string): string {
  return path === '.' ? '.' : `./${path}`
}

function parentPath(path: string): string {
  if (path === '.') return '.'
  const parts = path.split('/')
  parts.pop()
  return parts.length ? parts.join('/') : '.'
}

function formatBytes(value?: number): string {
  if (value == null) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

function errorCode(cause: unknown): string {
  return cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
}

function imageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a') return 'image/gif'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a') return 'image/gif'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

function newReadId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16)
    const value = character === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function markImagePreviewFailed() {
  previewError.value = '图片内容无法完整显示，可以将原文件另存到设备。'
  previewPhase.value = 'error'
}

function revokePreviewImage() {
  if (previewImageUrl.value) URL.revokeObjectURL(previewImageUrl.value)
  previewImageUrl.value = ''
}

async function invalidateFile(clearSelection: boolean) {
  operationEpoch += 1
  const readId = activeReadId.value
  const context = currentContext()
  activeReadId.value = ''
  if (readId && context) void cancelWorkspaceFileRead(readId, context).catch(() => undefined)
  await clearWorkspaceFileState().catch(() => undefined)
  revokePreviewImage()
  cacheResult.value = null
  previewText.value = ''
  previewError.value = ''
  progressBytes.value = 0
  progressTotal.value = 0
  saving.value = false
  saveStatus.value = ''
  if (clearSelection) {
    selectedEntry.value = null
    previewPhase.value = 'empty'
    mobilePreview.value = false
  }
}

function resetDirectories() {
  for (const key of Object.keys(directories)) delete directories[key]
  expandedPaths.value = new Set(['.'])
  mobilePath.value = '.'
}

async function resetBrowser() {
  await invalidateFile(true)
  resetDirectories()
  if (props.open && currentContext()) await loadDirectory('.', true)
}

async function loadDirectory(path: string, reset = false) {
  const context = currentContext()
  if (!context) return
  const existing = directories[path]
  if (existing?.loading) return
  const state: DirectoryState = existing ?? {
    entries: [], revision: '', nextCursor: undefined, loading: false, error: '', loadToken: 0,
  }
  directories[path] = state
  const cursor = reset ? undefined : state.nextCursor
  const token = state.loadToken + 1
  state.loadToken = token
  state.loading = true
  state.error = ''
  try {
    const page = await listWorkspaceEntries(path, cursor, context)
    if (!contextMatches(context) || state.loadToken !== token || !props.open) return
    state.entries = mergeWorkspaceDirectoryEntries(
      state.entries,
      state.revision,
      page.entries,
      page.revision,
      cursor,
    )
    state.revision = page.revision
    state.nextCursor = page.nextCursor
  } catch (cause) {
    if (!contextMatches(context) || state.loadToken !== token || !props.open) return
    state.error = userErrorMessage(cause, '无法读取这个目录。请检查连接后重试。')
  } finally {
    if (state.loadToken === token) state.loading = false
  }
}

async function toggleDesktopDirectory(entry: WorkspaceFileEntry) {
  if (!entryIsDirectory(entry)) return
  const expanded = new Set(expandedPaths.value)
  if (expanded.has(entry.path)) expanded.delete(entry.path)
  else expanded.add(entry.path)
  expandedPaths.value = expanded
  if (expanded.has(entry.path) && !directories[entry.path]) await loadDirectory(entry.path, true)
}

async function openMobileDirectory(entry: WorkspaceFileEntry) {
  if (!entryIsDirectory(entry)) return
  mobilePath.value = entry.path
  if (!directories[entry.path]) await loadDirectory(entry.path, true)
}

async function goToMobilePath(path: string) {
  mobilePath.value = path
  if (!directories[path]) await loadDirectory(path, true)
}

async function openFile(entry: WorkspaceFileEntry) {
  if (!entryIsFile(entry)) return
  await invalidateFile(true)
  const context = currentContext()
  if (!context) return
  const epoch = operationEpoch
  selectedEntry.value = entry
  previewKind.value = classifyPreview(entry)
  previewPhase.value = 'metadata'
  previewError.value = ''
  mobilePreview.value = true
  try {
    const metadata = await getWorkspaceEntryMetadata(entry.path, context)
    if (epoch !== operationEpoch || !contextMatches(context) || !props.open) return
    selectedEntry.value = metadata.entry
    previewKind.value = classifyPreview(metadata.entry)
    largeFileConfirmBytes.value = metadata.largeFileConfirmBytes
    if (previewKind.value === 'unsupported') {
      previewPhase.value = 'unsupported'
      return
    }
    if ((metadata.entry.sizeBytes ?? 0) > metadata.largeFileConfirmBytes) {
      pendingIntent.value = 'preview'
      previewPhase.value = 'confirm'
      return
    }
    await beginRead(false, false, epoch)
  } catch (cause) {
    if (epoch !== operationEpoch || !contextMatches(context)) return
    previewError.value = userErrorMessage(cause, '无法读取这个文件的状态。请刷新目录后重试。')
    previewPhase.value = 'error'
  }
}

async function beginRead(largeFileConfirmed: boolean, saveAfterRead: boolean, expectedEpoch = operationEpoch) {
  const context = currentContext()
  const entry = selectedEntry.value
  if (!context || !entry || expectedEpoch !== operationEpoch) return
  const readId = newReadId()
  activeReadId.value = readId
  previewPhase.value = 'reading'
  previewError.value = ''
  saveStatus.value = ''
  progressBytes.value = 0
  progressTotal.value = entry.sizeBytes ?? 0
  try {
    const result = await readWorkspaceFile(readId, entry, largeFileConfirmed, context)
    if (expectedEpoch !== operationEpoch || activeReadId.value !== readId || !contextMatches(context) || !props.open) return
    activeReadId.value = ''
    cacheResult.value = result
    progressBytes.value = result.sizeBytes
    progressTotal.value = result.sizeBytes
    if (saveAfterRead) {
      previewPhase.value = previewKind.value === 'unsupported' ? 'unsupported' : 'ready'
      await saveCached(result.cacheId, context, expectedEpoch)
      return
    }
    await loadCachedPreview(result, context, expectedEpoch)
  } catch (cause) {
    if (expectedEpoch !== operationEpoch || activeReadId.value !== readId || !contextMatches(context)) return
    activeReadId.value = ''
    if (errorCode(cause) === 'workspace_large_file_confirmation_required') {
      try {
        const metadata = await getWorkspaceEntryMetadata(entry.path, context)
        if (expectedEpoch !== operationEpoch || !contextMatches(context)) return
        selectedEntry.value = metadata.entry
        largeFileConfirmBytes.value = metadata.largeFileConfirmBytes
        pendingIntent.value = saveAfterRead ? 'save' : 'preview'
        previewPhase.value = 'confirm'
        return
      } catch (metadataCause) {
        cause = metadataCause
      }
    }
    previewError.value = userErrorMessage(cause, '没有完整读取这个文件。请重试。')
    previewPhase.value = 'error'
  }
}

async function loadCachedPreview(
  result: WorkspaceFileCacheResult,
  context: WorkspaceFileContext,
  expectedEpoch: number,
) {
  try {
    if (previewKind.value === 'text') {
      previewText.value = await loadWorkspaceCachedText(result.cacheId, context)
    } else if (previewKind.value === 'image') {
      const bytes = await loadWorkspaceCachedImage(result.cacheId, context)
      const mediaType = imageMimeType(bytes)
      if (!mediaType) throw new Error('图片内容不是可安全显示的 PNG、JPEG、GIF 或 WebP 格式。')
      const imageBuffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(imageBuffer).set(bytes)
      const url = URL.createObjectURL(new Blob([imageBuffer], { type: mediaType }))
      if (expectedEpoch !== operationEpoch || !contextMatches(context) || !props.open) {
        URL.revokeObjectURL(url)
        return
      }
      revokePreviewImage()
      previewImageUrl.value = url
    }
    if (expectedEpoch === operationEpoch && contextMatches(context)) previewPhase.value = 'ready'
  } catch (cause) {
    if (expectedEpoch !== operationEpoch || !contextMatches(context)) return
    previewError.value = userErrorMessage(cause, '这个文件无法安全预览，可以将原文件另存到设备。')
    previewPhase.value = 'error'
  }
}

async function confirmPendingRead() {
  await beginRead(true, pendingIntent.value === 'save')
}

async function retryRead() {
  const entry = selectedEntry.value
  if (!entry) return
  const confirmed = (entry.sizeBytes ?? 0) > largeFileConfirmBytes.value
  await invalidateFile(false)
  await beginRead(confirmed, false)
}

async function cancelRead() {
  const readId = activeReadId.value
  const context = currentContext()
  if (!readId || !context) return
  operationEpoch += 1
  activeReadId.value = ''
  await cancelWorkspaceFileRead(readId, context).catch(() => false)
  await clearWorkspaceFileState().catch(() => undefined)
  previewError.value = '已停止读取。'
  previewPhase.value = 'error'
}

async function requestSave() {
  const context = currentContext()
  const entry = selectedEntry.value
  if (!context || !entry || saving.value) return
  saveStatus.value = ''
  if (cacheResult.value) {
    await saveCached(cacheResult.value.cacheId, context, operationEpoch)
    return
  }
  if ((entry.sizeBytes ?? 0) > largeFileConfirmBytes.value) {
    pendingIntent.value = 'save'
    previewPhase.value = 'confirm'
    return
  }
  await beginRead(false, true)
}

async function saveCached(cacheId: string, context: WorkspaceFileContext, expectedEpoch: number) {
  saving.value = true
  try {
    const result = await saveWorkspaceCachedFile(cacheId, context)
    if (expectedEpoch !== operationEpoch || !contextMatches(context)) return
    if (result.status === 'saved') saveStatus.value = `已保存到 ${result.label}`
  } catch (cause) {
    if (expectedEpoch !== operationEpoch || !contextMatches(context)) return
    saveStatus.value = userErrorMessage(cause, '没有完成另存为。请重试。')
  } finally {
    if (expectedEpoch === operationEpoch) saving.value = false
  }
}

function handleMobileBack() {
  if (mobilePreview.value) {
    mobilePreview.value = false
    return
  }
  if (mobilePath.value !== '.') void goToMobilePath(parentPath(mobilePath.value))
  else emit('close')
}

function updateMobileMode() {
  isMobile.value = mediaQuery?.matches ?? false
}

watch(
  () => [
    props.open,
    props.context?.hostId,
    props.context?.selectionGeneration,
    props.work?.id,
    props.work?.lifecycle,
    props.work?.runtimeGeneration,
    props.hostEpoch,
  ] as const,
  (current, previous) => {
    if (!props.open) {
      void invalidateFile(true)
      return
    }
    const changed = !previous || current.slice(1).some((value, index) => value !== previous[index + 1])
    if (props.work?.lifecycle !== 'active' || !currentContext()) {
      emit('close')
      return
    }
    if (changed || !directories['.']) void resetBrowser()
  },
  { immediate: true },
)

onMounted(() => {
  componentMounted = true
  mediaQuery = window.matchMedia('(max-width: 720px)')
  updateMobileMode()
  if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', updateMobileMode)
  else mediaQuery.addListener(updateMobileMode)
  void listen<WorkspaceFileReadProgress>('aludock://workspace-read-progress', ({ payload }) => {
    const context = currentContext()
    if (!context
      || payload.readId !== activeReadId.value
      || payload.hostId !== context.hostId
      || payload.selectionGeneration !== context.selectionGeneration
      || payload.instanceId !== context.instanceId) return
    progressBytes.value = payload.bytesReceived
    progressTotal.value = Math.max(payload.observedSizeBytes, payload.bytesReceived)
  }).then((unlisten) => {
    if (componentMounted) unlistenProgress = unlisten
    else unlisten()
  })
})

onBeforeUnmount(() => {
  componentMounted = false
  operationEpoch += 1
  unlistenProgress?.()
  if (mediaQuery) {
    if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', updateMobileMode)
    else mediaQuery.removeListener(updateMobileMode)
  }
  revokePreviewImage()
  void clearWorkspaceFileState().catch(() => undefined)
})
</script>

<template>
  <Transition name="workspace-fade">
    <div v-if="open" class="workspace-overlay" @keydown.esc.stop.prevent="$emit('close')">
      <section class="workspace-browser" role="dialog" aria-modal="true" aria-labelledby="workspace-browser-title">
        <header class="workspace-header">
          <button v-if="isMobile" type="button" class="workspace-icon-button workspace-mobile-back" aria-label="返回" @click="handleMobileBack"><ArrowLeft :size="20" /></button>
          <div class="workspace-heading">
            <span class="workspace-kicker">ACTIVE WORK</span>
            <h1 id="workspace-browser-title">工作区</h1>
            <p>{{ work?.displayName }} · 根目录 <code>.</code></p>
          </div>
          <div class="workspace-header-actions">
            <button type="button" class="workspace-toggle" :aria-pressed="showHidden" @click="showHidden = !showHidden">
              <Eye v-if="showHidden" :size="16" /><EyeOff v-else :size="16" />
              <span>{{ showHidden ? '隐藏隐藏文件' : '显示隐藏文件' }}</span>
            </button>
            <button type="button" class="workspace-icon-button" aria-label="关闭工作区" @click="$emit('close')"><X :size="20" /></button>
          </div>
        </header>

        <div class="workspace-body" :class="{ 'mobile-preview-open': mobilePreview }">
          <aside class="workspace-tree" aria-label="工作区目录">
            <div class="workspace-tree-toolbar">
              <div v-if="isMobile" class="workspace-breadcrumbs" aria-label="当前目录">
                <template v-for="(crumb, index) in mobileBreadcrumbs" :key="crumb.path">
                  <span v-if="index" aria-hidden="true">/</span>
                  <button type="button" @click="goToMobilePath(crumb.path)">{{ crumb.name }}</button>
                </template>
              </div>
              <span v-else>目录</span>
              <button type="button" class="workspace-icon-button" :disabled="directories[isMobile ? mobilePath : '.']?.loading" :aria-label="`刷新 ${displayPath(isMobile ? mobilePath : '.')}`" @click="loadDirectory(isMobile ? mobilePath : '.', true)"><RefreshCw :size="15" :class="{ spinning: directories[isMobile ? mobilePath : '.']?.loading }" /></button>
            </div>

            <div v-if="isMobile" class="workspace-mobile-list" role="list">
              <button
                v-for="entry in visibleEntries(mobilePath)"
                :key="entry.path"
                type="button"
                class="workspace-mobile-row"
                :class="{ selected: selectedEntry?.path === entry.path, unavailable: !entryIsDirectory(entry) && !entryIsFile(entry) }"
                :disabled="!entryIsDirectory(entry) && !entryIsFile(entry)"
                @click="entryIsDirectory(entry) ? openMobileDirectory(entry) : openFile(entry)"
              >
                <Folder v-if="entryIsDirectory(entry)" :size="19" />
                <FileImage v-else-if="classifyPreview(entry) === 'image'" :size="19" />
                <File v-else :size="19" />
                <span><strong>{{ entry.name }}</strong><small>{{ entryIsDirectory(entry) ? '文件夹' : formatBytes(entry.sizeBytes) }}</small></span>
                <ChevronRight v-if="entryIsDirectory(entry) || entryIsFile(entry)" :size="17" />
              </button>
              <div v-if="currentMobileState?.loading" class="workspace-directory-status"><span class="workspace-spinner" />正在读取目录…</div>
              <button v-else-if="currentMobileState?.error" type="button" class="workspace-directory-status error" @click="loadDirectory(mobilePath, true)">{{ currentMobileState.error }}<span>重试</span></button>
              <button v-else-if="currentMobileState?.nextCursor" type="button" class="workspace-load-more" @click="loadDirectory(mobilePath)">加载更多</button>
              <div v-else-if="currentMobileState && !visibleEntries(mobilePath).length" class="workspace-directory-status">这个目录没有{{ showHidden ? '' : '可见'}}项目</div>
            </div>

            <div v-else class="workspace-tree-scroll" role="tree" aria-label="工作区文件树">
              <button type="button" class="workspace-tree-root" :aria-expanded="expandedPaths.has('.')" @click="expandedPaths.has('.') ? expandedPaths = new Set() : expandedPaths = new Set(['.'])">
                <FolderOpen :size="17" /><span>.</span>
              </button>
              <template v-for="(row, index) in treeRows" :key="row.kind === 'entry' ? row.entry.path : `${row.kind}:${row.path}:${index}`">
                <button
                  v-if="row.kind === 'entry'"
                  type="button"
                  class="workspace-tree-row"
                  :class="{ selected: selectedEntry?.path === row.entry.path, unavailable: !entryIsDirectory(row.entry) && !entryIsFile(row.entry) }"
                  :style="{ paddingLeft: `${18 + row.depth * 18}px` }"
                  :disabled="!entryIsDirectory(row.entry) && !entryIsFile(row.entry)"
                  role="treeitem"
                  :aria-expanded="entryIsDirectory(row.entry) ? expandedPaths.has(row.entry.path) : undefined"
                  @click="entryIsDirectory(row.entry) ? toggleDesktopDirectory(row.entry) : openFile(row.entry)"
                >
                  <ChevronDown v-if="entryIsDirectory(row.entry) && expandedPaths.has(row.entry.path)" :size="14" class="workspace-chevron" />
                  <ChevronRight v-else-if="entryIsDirectory(row.entry)" :size="14" class="workspace-chevron" />
                  <span v-else class="workspace-chevron" />
                  <FolderOpen v-if="entryIsDirectory(row.entry) && expandedPaths.has(row.entry.path)" :size="16" />
                  <Folder v-else-if="entryIsDirectory(row.entry)" :size="16" />
                  <FileImage v-else-if="classifyPreview(row.entry) === 'image'" :size="16" />
                  <File v-else :size="16" />
                  <span class="workspace-tree-name">{{ row.entry.name }}</span>
                  <span v-if="entryIsFile(row.entry)" class="workspace-tree-size">{{ formatBytes(row.entry.sizeBytes) }}</span>
                </button>
                <button v-else-if="row.kind === 'more'" type="button" class="workspace-tree-more" :style="{ paddingLeft: `${48 + row.depth * 18}px` }" @click="loadDirectory(row.path)">加载更多</button>
                <button v-else-if="row.retryable" type="button" class="workspace-tree-message error" :style="{ paddingLeft: `${30 + row.depth * 18}px` }" @click="loadDirectory(row.path, true)">{{ row.text }} · 重试</button>
                <div v-else class="workspace-tree-message" :style="{ paddingLeft: `${30 + row.depth * 18}px` }"><span class="workspace-spinner" />{{ row.text }}</div>
              </template>
            </div>
          </aside>

          <main class="workspace-preview" aria-label="文件预览">
            <div class="workspace-preview-toolbar">
              <div><strong>{{ selectedEntry?.name || '预览' }}</strong><span>{{ selectedPathLabel }}</span></div>
              <button v-if="selectedEntry" type="button" class="workspace-save-button" :disabled="saving || previewPhase === 'metadata' || previewPhase === 'reading'" @click="requestSave"><Download :size="16" />{{ saving ? '保存中…' : '另存为' }}</button>
            </div>

            <div v-if="previewPhase === 'empty'" class="workspace-preview-empty">
              <File :size="34" />
              <strong>选择文件以预览</strong>
              <p>文本按 UTF-8 源码显示；图片会先验证实际格式。</p>
            </div>
            <div v-else-if="previewPhase === 'metadata'" class="workspace-preview-state"><span class="workspace-spinner" /><strong>正在读取文件信息…</strong></div>
            <div v-else-if="previewPhase === 'confirm'" class="workspace-preview-state workspace-confirm">
              <span class="workspace-confirm-mark">!</span>
              <strong>这是一个较大的文件</strong>
              <p>{{ formatBytes(selectedEntry?.sizeBytes) }} · 读取可能占用较多流量和设备内存。</p>
              <div><button type="button" class="workspace-secondary-button" @click="mobilePreview = false">返回</button><button type="button" class="workspace-primary-button" @click="confirmPendingRead">{{ pendingIntent === 'save' ? '读取并另存为' : '继续读取' }}</button></div>
            </div>
            <div v-else-if="previewPhase === 'reading'" class="workspace-preview-state workspace-reading" role="status">
              <span class="workspace-spinner large" />
              <strong>正在读取 {{ selectedEntry?.name }}…</strong>
              <p>{{ formatBytes(progressBytes) }} / {{ formatBytes(progressTotal) }}</p>
              <div class="workspace-progress"><span :style="{ width: `${progressPercent}%` }" /></div>
              <button type="button" class="workspace-secondary-button" @click="cancelRead">取消</button>
            </div>
            <pre v-else-if="previewPhase === 'ready' && previewKind === 'text'" class="workspace-text-preview" tabindex="0"><code>{{ previewText }}</code></pre>
            <div v-else-if="previewPhase === 'ready' && previewKind === 'image'" class="workspace-image-preview"><ImageZoomSurface :url="previewImageUrl" :name="selectedEntry?.name || '工作区图片'" @failed="markImagePreviewFailed" /></div>
            <div v-else-if="previewPhase === 'unsupported'" class="workspace-preview-state">
              <File :size="34" />
              <strong>这个文件不提供应用内预览</strong>
              <p>可以将原文件另存到设备后，用合适的应用打开。</p>
              <button type="button" class="workspace-primary-button" :disabled="saving" @click="requestSave"><Download :size="16" />{{ saving ? '准备中…' : '另存为' }}</button>
            </div>
            <div v-else-if="previewPhase === 'error'" class="workspace-preview-state error" role="alert">
              <strong>暂时无法预览</strong>
              <p>{{ previewError }}</p>
              <div><button v-if="previewKind !== 'unsupported'" type="button" class="workspace-secondary-button" @click="retryRead">重试读取</button><button type="button" class="workspace-primary-button" :disabled="saving" @click="requestSave"><Download :size="16" />另存为原文件</button></div>
            </div>
            <div v-if="saveStatus" class="workspace-save-status" role="status">{{ saveStatus }}</div>
          </main>
        </div>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.workspace-overlay {
  position: fixed;
  z-index: 82;
  inset: 0;
  display: grid;
  padding: 26px;
  background: rgba(4, 7, 14, .82);
  backdrop-filter: blur(12px);
  place-items: center;
}
.workspace-browser {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: min(1180px, 100%);
  height: min(780px, 100%);
  overflow: hidden;
  color: var(--alu-text);
  border: 1px solid var(--alu-border);
  border-radius: 15px;
  background: #090e19;
  box-shadow: 0 28px 90px rgba(0, 0, 0, .62);
}
.workspace-header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
  min-height: 78px;
  padding: 12px 16px 12px 20px;
  border-bottom: 1px solid var(--alu-border);
  background: linear-gradient(105deg, rgba(16, 27, 45, .98), rgba(10, 16, 29, .98));
}
.workspace-heading { min-width: 0; flex: 1; }
.workspace-kicker { display: block; color: var(--alu-blue); font-size: 8px; font-weight: 700; letter-spacing: .2em; }
.workspace-heading h1 { margin: 3px 0 2px; color: var(--alu-text); font-size: 18px; line-height: 1.1; }
.workspace-heading p { overflow: hidden; margin: 0; color: var(--alu-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.workspace-heading code { color: var(--alu-pink); }
.workspace-header-actions { display: flex; align-items: center; gap: 8px; }
.workspace-icon-button,
.workspace-toggle,
.workspace-save-button,
.workspace-primary-button,
.workspace-secondary-button {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--alu-text-muted);
  border: 1px solid var(--alu-border);
  border-radius: 8px;
  background: rgba(18, 28, 45, .8);
}
.workspace-icon-button { width: 38px; padding: 0; }
.workspace-toggle { padding: 0 12px; font-size: 10px; }
.workspace-icon-button:hover,
.workspace-toggle:hover,
.workspace-secondary-button:hover { color: var(--alu-text); border-color: var(--alu-blue-border); background: var(--alu-hover); }
.workspace-body { display: grid; min-height: 0; grid-template-columns: minmax(280px, 38%) minmax(0, 1fr); }
.workspace-tree { display: grid; min-width: 0; min-height: 0; grid-template-rows: 47px minmax(0, 1fr); border-right: 1px solid var(--alu-border); background: #0b111d; }
.workspace-tree-toolbar,
.workspace-preview-toolbar {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 13px;
  border-bottom: 1px solid var(--alu-border);
  background: rgba(13, 21, 35, .94);
}
.workspace-tree-toolbar > span { color: var(--alu-text-muted); font-size: 9px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
.workspace-tree-toolbar .workspace-icon-button { width: 32px; min-height: 32px; border-color: transparent; background: transparent; }
.workspace-tree-scroll,
.workspace-mobile-list { min-height: 0; overflow: auto; padding: 8px 7px 18px; scrollbar-color: var(--alu-border) transparent; }
.workspace-tree-root,
.workspace-tree-row,
.workspace-tree-more,
.workspace-tree-message {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  align-items: center;
  gap: 7px;
  padding: 4px 9px;
  color: var(--alu-text-muted);
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 10px;
  text-align: left;
}
.workspace-tree-root { color: var(--alu-text); font-weight: 700; }
.workspace-tree-row:hover,
.workspace-tree-root:hover,
.workspace-tree-more:hover { color: var(--alu-text); background: var(--alu-hover); }
.workspace-tree-row.selected { color: var(--alu-text); background: var(--alu-blue-bg); box-shadow: inset 2px 0 var(--alu-blue); }
.workspace-tree-row.unavailable { opacity: .5; }
.workspace-chevron { width: 14px; flex: 0 0 14px; }
.workspace-tree-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-tree-size { flex: 0 0 auto; color: var(--alu-text-faint); font-size: 8px; }
.workspace-tree-more { color: var(--alu-blue); }
.workspace-tree-message { color: var(--alu-text-faint); }
.workspace-tree-message.error { color: var(--alu-rose); }
.workspace-spinner {
  display: inline-block;
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  border: 2px solid rgba(126, 200, 224, .22);
  border-top-color: var(--alu-blue);
  border-radius: 50%;
  animation: workspace-spin .85s linear infinite;
}
.workspace-spinner.large { width: 27px; height: 27px; border-width: 3px; }
.workspace-preview { position: relative; display: grid; min-width: 0; min-height: 0; grid-template-rows: 55px minmax(0, 1fr); background: #080d17; }
.workspace-preview-toolbar { padding: 0 16px; }
.workspace-preview-toolbar > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.workspace-preview-toolbar strong,
.workspace-preview-toolbar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-preview-toolbar strong { color: var(--alu-text); font-size: 11px; }
.workspace-preview-toolbar span { color: var(--alu-text-faint); font-size: 8px; }
.workspace-save-button { flex: 0 0 auto; min-height: 34px; padding: 0 11px; color: var(--alu-blue); font-size: 9px; }
.workspace-save-button:hover { color: #dff8ff; border-color: var(--alu-blue-border); background: var(--alu-blue-bg); }
.workspace-preview-empty,
.workspace-preview-state,
.workspace-image-preview {
  display: flex;
  min-height: 0;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  padding: 28px;
  color: var(--alu-text-faint);
  text-align: center;
}
.workspace-preview-empty strong,
.workspace-preview-state strong { color: var(--alu-text); font-size: 13px; }
.workspace-preview-empty p,
.workspace-preview-state p { max-width: 470px; margin: 0; color: var(--alu-text-muted); font-family: var(--font-reading); font-size: 11px; line-height: 1.7; }
.workspace-confirm-mark { display: grid; width: 42px; height: 42px; color: #14100a; border-radius: 50%; background: var(--alu-amber); font-size: 22px; font-weight: 900; place-items: center; }
.workspace-preview-state > div { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.workspace-primary-button,
.workspace-secondary-button { min-height: 38px; padding: 0 14px; font-size: 10px; }
.workspace-primary-button { color: #07121b; border-color: var(--alu-blue); background: var(--alu-blue); font-weight: 700; }
.workspace-primary-button:hover { background: #a5e7f5; }
.workspace-progress { width: min(360px, 75%); height: 5px; overflow: hidden; border-radius: 5px; background: var(--alu-border); }
.workspace-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--alu-blue), var(--alu-pink)); transition: width .18s ease; }
.workspace-text-preview {
  min-width: 0;
  min-height: 0;
  margin: 0;
  overflow: auto;
  padding: 19px 22px 50px;
  color: #d4e3ee;
  background: #070b13;
  font: 11px/1.65 'JetBrains Mono', 'Noto Sans SC', ui-monospace, monospace;
  tab-size: 2;
  white-space: pre;
  scrollbar-color: var(--alu-border) transparent;
}
.workspace-image-preview { overflow: auto; padding: 22px; background: radial-gradient(circle at center, rgba(126, 200, 224, .055), transparent 55%), #070b13; }
.workspace-image-preview :deep(.alu-image-zoom-stage) { width: 100%; height: 100%; }
.workspace-preview-state.error strong,
.workspace-preview-state.error p { color: var(--alu-rose); }
.workspace-save-status { position: absolute; right: 14px; bottom: 14px; max-width: calc(100% - 28px); padding: 9px 12px; color: var(--alu-text); border: 1px solid var(--alu-blue-border); border-radius: 8px; background: rgba(12, 29, 41, .96); box-shadow: 0 8px 28px rgba(0, 0, 0, .42); font-size: 9px; }
.workspace-breadcrumbs { display: flex; min-width: 0; align-items: center; gap: 5px; overflow: auto; color: var(--alu-text-faint); }
.workspace-breadcrumbs button { min-height: 30px; padding: 0 2px; color: var(--alu-blue); border: 0; background: transparent; font-size: 10px; }
.workspace-mobile-list { display: none; }
.workspace-mobile-row { display: grid; width: 100%; min-height: 52px; grid-template-columns: 22px minmax(0, 1fr) 18px; align-items: center; gap: 9px; padding: 7px 9px; color: var(--alu-text-muted); border: 0; border-bottom: 1px solid rgba(45, 57, 79, .55); background: transparent; text-align: left; }
.workspace-mobile-row > span { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.workspace-mobile-row strong { overflow: hidden; color: var(--alu-text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.workspace-mobile-row small { color: var(--alu-text-faint); font-size: 8px; }
.workspace-directory-status,
.workspace-load-more { display: flex; width: 100%; min-height: 48px; align-items: center; justify-content: center; gap: 8px; padding: 8px; color: var(--alu-text-muted); border: 0; background: transparent; font-size: 10px; text-align: center; }
.workspace-directory-status.error { color: var(--alu-rose); }
.workspace-directory-status.error span,
.workspace-load-more { color: var(--alu-blue); }
.workspace-mobile-back { display: none; }
.workspace-fade-enter-active,
.workspace-fade-leave-active { transition: opacity .16s ease; }
.workspace-fade-enter-from,
.workspace-fade-leave-to { opacity: 0; }
@keyframes workspace-spin { to { transform: rotate(360deg); } }

@media (max-width: 720px) {
  .workspace-overlay { padding: 0; background: #080d17; backdrop-filter: none; }
  .workspace-browser { width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; }
  .workspace-header { min-height: calc(66px + env(safe-area-inset-top)); padding: env(safe-area-inset-top) 10px 0; }
  .workspace-mobile-back { display: inline-flex; }
  .workspace-heading h1 { font-size: 15px; }
  .workspace-heading p { font-size: 9px; }
  .workspace-kicker { display: none; }
  .workspace-toggle { width: 40px; min-height: 40px; padding: 0; }
  .workspace-toggle span { display: none; }
  .workspace-header-actions .workspace-icon-button { width: 40px; min-height: 40px; }
  .workspace-body { display: block; min-height: 0; }
  .workspace-tree,
  .workspace-preview { width: 100%; height: 100%; border: 0; }
  .workspace-tree { grid-template-rows: 48px minmax(0, 1fr); }
  .workspace-tree-scroll { display: none; }
  .workspace-mobile-list { display: block; }
  .workspace-preview { display: none; grid-template-rows: 54px minmax(0, 1fr); }
  .workspace-body.mobile-preview-open .workspace-tree { display: none; }
  .workspace-body.mobile-preview-open .workspace-preview { display: grid; }
  .workspace-preview-toolbar { padding: 0 11px; }
  .workspace-save-button { min-width: 88px; min-height: 40px; }
  .workspace-text-preview { padding: 15px 14px 44px; font-size: 10px; }
  .workspace-preview-empty,
  .workspace-preview-state,
  .workspace-image-preview { padding: 22px 18px; }
  .workspace-primary-button,
  .workspace-secondary-button { min-height: 44px; }
}
</style>
