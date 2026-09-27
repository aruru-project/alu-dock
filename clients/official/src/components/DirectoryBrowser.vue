<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowLeft, ChevronDown, ChevronRight, Eye, EyeOff, File, FileImage, Folder, FolderOpen, RefreshCw } from '@lucide/vue'
import {
  classifyWorkspacePreview,
  formatWorkspaceBytes as formatBytes,
  mergeWorkspaceDirectoryEntries,
  workspaceDirectoryState,
  workspaceEntryIsDirectory as isDirectory,
  workspaceEntryIsFile as isFile,
  type DirectoryPage,
  type WorkspaceDirectoryState,
} from '../lib/workspaceBrowser'
import type { WorkspaceFileCursor, WorkspaceFileEntry } from '../lib/types'
import { userErrorMessage, type UserErrorPresentation } from '../lib/userError'
import { copyPlainText } from '../lib/clipboard'

const props = defineProps<{
  startPath: string
  loadPage: (path: string, cursor?: WorkspaceFileCursor) => Promise<DirectoryPage>
  describeError?: (cause: unknown, path: string) => UserErrorPresentation
  selectedPath?: string
  picker?: boolean
  disabled?: boolean
}>()
const showHidden = defineModel<boolean>('showHidden', { default: false })
const emit = defineEmits<{
  file: [entry: WorkspaceFileEntry]
  directory: [path: string]
  mobile: [mobile: boolean]
  refresh: []
}>()

type TreeRow =
  | { kind: 'entry'; entry: WorkspaceFileEntry; depth: number }
  | { kind: 'status'; path: string; depth: number; state: WorkspaceDirectoryState }
const directories = reactive<Record<string, WorkspaceDirectoryState>>({})
const expanded = ref(new Set<string>())
const filterCollapsed = ref(new Set<string>())
const rootPath = ref(props.startPath)
const mobilePath = ref(props.startPath)
const selectedDirectory = ref(props.startPath)
const trail = ref([{ path: props.startPath, name: props.startPath }])
const search = ref('')
const isMobile = ref(false)
const refreshing = ref(false)
let epoch = 0
let mediaQuery: MediaQueryList | undefined
const currentPath = computed(() => isMobile.value ? mobilePath.value : rootPath.value)
const currentState = computed(() => directories[currentPath.value])
const currentParent = computed(() => currentState.value?.parent ?? (isMobile.value ? trail.value.at(-2)?.path : undefined))
const selected = computed(() => props.picker ? selectedDirectory.value : props.selectedPath)
const filterText = computed(() => search.value.trim().toLocaleLowerCase())

function visibleEntries(path: string, filterNames = true) {
  return (directories[path]?.entries ?? []).filter(entry =>
    (showHidden.value || !entry.hidden)
    && (!filterNames || !filterText.value || entry.name.toLocaleLowerCase().includes(filterText.value)))
}

function directoryExpanded(path: string) {
  return !filterCollapsed.value.has(path)
    && (expanded.value.has(path) || (!!filterText.value && !!directories[path]))
}

const treeRows = computed<TreeRow[]>(() => {
  const visit = (path: string, depth: number): TreeRow[] => {
    const state = directories[path]
    if (!state) return []
    const rows: TreeRow[] = []
    for (const entry of visibleEntries(path, false)) {
      const children = isDirectory(entry) && (filterText.value || expanded.value.has(entry.path))
        ? visit(entry.path, depth + 1) : []
      // Keep matching descendants and their loading/retry routes, without scanning new directories.
      if (filterText.value && !entry.name.toLocaleLowerCase().includes(filterText.value)
        && !children.some(row => row.kind === 'entry' || row.state.loading || row.state.error)) continue
      rows.push({ kind: 'entry', entry, depth })
      if (directoryExpanded(entry.path)) for (const child of children) rows.push(child)
    }
    if (state.loading || state.error || state.nextCursor || !rows.length) {
      rows.push({ kind: 'status', path, depth, state })
    }
    return rows
  }
  return directoryExpanded(rootPath.value) ? visit(rootPath.value, 0) : []
})

function choose(path: string) {
  selectedDirectory.value = path
  emit('directory', directories[path]?.path ?? path)
}

async function loadDirectory(path: string, reset = false) {
  const state = workspaceDirectoryState(directories, path)
  if (state.loading) return
  const requestEpoch = epoch
  const cursor = reset ? undefined : state.nextCursor
  const token = ++state.loadToken
  state.loading = true
  state.error = ''
  state.diagnostic = undefined
  state.diagnosticCopyState = undefined
  try {
    const page = await props.loadPage(path, cursor)
    if (requestEpoch !== epoch || state.loadToken !== token) return
    state.entries = mergeWorkspaceDirectoryEntries(state.entries, state.revision, page.entries, page.revision, cursor)
    state.revision = page.revision
    state.nextCursor = page.nextCursor
    state.path = page.path
    state.parent = page.parent
    // Keep the requested tree location separate from the Host's canonical path.
    // A directory link can lead back to an ancestor without replacing its rows.
    if (selectedDirectory.value === path) emit('directory', page.path)
  } catch (cause) {
    if (requestEpoch === epoch && state.loadToken === token) {
      const presentation = props.describeError?.(cause, path)
        ?? { message: userErrorMessage(cause, '无法读取这个目录。请检查连接后重试。') }
      state.error = presentation.message
      state.diagnostic = presentation.diagnostic
    }
  } finally {
    if (requestEpoch === epoch && state.loadToken === token) state.loading = false
  }
}

async function copyDiagnostic(state: WorkspaceDirectoryState) {
  const diagnostic = state.diagnostic
  if (!diagnostic) return
  try {
    await copyPlainText(diagnostic)
    if (state.diagnostic === diagnostic) state.diagnosticCopyState = 'copied'
  } catch {
    if (state.diagnostic === diagnostic) state.diagnosticCopyState = 'failed'
  }
}

function reset() {
  ++epoch
  for (const key of Object.keys(directories)) delete directories[key]
  rootPath.value = props.startPath
  mobilePath.value = props.startPath
  trail.value = [{ path: props.startPath, name: props.startPath }]
  expanded.value = new Set([props.startPath])
  search.value = ''
  refreshing.value = false
  choose(props.startPath)
  void loadDirectory(props.startPath, true)
}

function navigate(path: string, name = path) {
  if (props.disabled) return
  const index = trail.value.findIndex(crumb => crumb.path === path)
  trail.value = index >= 0 ? trail.value.slice(0, index + 1) : [...trail.value, { path, name }]
  mobilePath.value = path
  if (!isMobile.value) {
    rootPath.value = path
    expanded.value = new Set([path])
  }
  search.value = ''
  choose(path)
  if (!directories[path]) void loadDirectory(path, true)
}

function goBack(): boolean {
  const parent = currentParent.value
  if (!parent || props.disabled) return false
  // Above the starting directory, the Host-provided parent becomes the new root.
  if (!trail.value.some(crumb => crumb.path === parent)) trail.value = []
  navigate(parent)
  return true
}

function activate(entry: WorkspaceFileEntry) {
  if (props.disabled) return
  if (!isDirectory(entry)) {
    if (isFile(entry)) emit('file', entry)
    return
  }
  if (isMobile.value) navigate(entry.path, entry.name)
  else toggleDirectory(entry.path)
}

async function refresh() {
  if (props.disabled || refreshing.value) return
  // Retain expanded descendants under collapsed ancestors, plus branches shown by filtering.
  const filteredPaths = filterText.value ? treeRows.value.flatMap(row =>
    row.kind === 'entry' && isDirectory(row.entry) && directories[row.entry.path] ? [row.entry.path] : []) : []
  const paths = isMobile.value ? [mobilePath.value] : [...new Set([rootPath.value, ...expanded.value, ...filteredPaths])]
    .filter(path => path === rootPath.value || directories[path])
  const requestEpoch = ++epoch
  for (const key of Object.keys(directories)) delete directories[key]
  if (isMobile.value) expanded.value = new Set([rootPath.value])
  refreshing.value = true
  emit('refresh')
  try {
    for (const path of paths) {
      if (requestEpoch !== epoch) return
      await loadDirectory(path, true)
    }
  } finally {
    if (requestEpoch === epoch) refreshing.value = false
  }
}

function toggleDirectory(path: string) {
  if (props.disabled) return
  choose(path)
  if (directoryExpanded(path)) {
    expanded.value.delete(path)
    if (filterText.value) filterCollapsed.value.add(path)
  } else {
    filterCollapsed.value.delete(path)
    expanded.value.add(path)
    if (!directories[path]) void loadDirectory(path, true)
  }
}

function updateMobileMode() {
  isMobile.value = mediaQuery?.matches ?? false
  emit('mobile', isMobile.value)
  if (!directories[currentPath.value]) void loadDirectory(currentPath.value, true)
}
watch(filterText, () => { filterCollapsed.value = new Set() }, { flush: 'sync' })
watch(() => props.startPath, reset, { immediate: true })
onMounted(() => {
  mediaQuery = window.matchMedia('(max-width: 720px)')
  updateMobileMode()
  mediaQuery.addEventListener('change', updateMobileMode)
})
onBeforeUnmount(() => {
  ++epoch
  mediaQuery?.removeEventListener('change', updateMobileMode)
})
defineExpose({ goBack })
</script>

<template>
  <aside class="directory-browser" :class="{ 'directory-picker': picker }" aria-label="工作区目录">
    <div class="directory-toolbar">
      <button v-if="picker && currentParent" type="button" class="directory-icon-button" aria-label="返回上级目录" :disabled="disabled" @click="goBack"><ArrowLeft :size="17" /></button>
      <div v-if="isMobile" class="directory-breadcrumbs" aria-label="当前目录">
        <template v-for="(crumb, index) in trail" :key="crumb.path">
          <span v-if="index" aria-hidden="true">/</span>
          <button type="button" :disabled="disabled" :title="crumb.path" @click="navigate(crumb.path)">{{ crumb.name }}</button>
        </template>
      </div>
      <span v-else class="directory-heading">目录</span>
      <button v-if="picker" type="button" class="directory-icon-button" :aria-label="showHidden ? '隐藏隐藏目录' : '显示隐藏目录'" :aria-pressed="showHidden" @click="showHidden = !showHidden"><Eye v-if="showHidden" :size="17" /><EyeOff v-else :size="17" /></button>
      <button type="button" class="directory-icon-button" :disabled="disabled || refreshing || currentState?.loading" aria-label="刷新目录" @click="refresh"><RefreshCw :size="16" :class="{ spinning: refreshing || currentState?.loading }" /></button>
    </div>
    <div v-if="picker" class="directory-search"><input v-model="search" type="search" aria-label="搜索目录名称" placeholder="筛选已加载的目录…" /></div>

    <div v-if="isMobile" class="directory-scroll directory-mobile-list" role="list">
      <button v-for="entry in visibleEntries(mobilePath)" :key="entry.path" type="button" class="directory-mobile-row" :class="{ selected: selected === entry.path }" :disabled="disabled || (!isDirectory(entry) && !isFile(entry))" @click="activate(entry)">
        <Folder v-if="isDirectory(entry)" :size="19" /><FileImage v-else-if="classifyWorkspacePreview(entry) === 'image'" :size="19" /><File v-else :size="19" />
        <span><strong>{{ entry.name }}</strong><small>{{ isDirectory(entry) ? (entry.kind === 'symlink' ? '目录链接' : '文件夹') : formatBytes(entry.sizeBytes) }}{{ entry.hidden ? ' · 隐藏' : '' }}</small></span>
        <ChevronRight v-if="isDirectory(entry) || isFile(entry)" :size="17" />
      </button>
      <div v-if="currentState?.loading" class="directory-status" role="status"><span class="directory-spinner" />正在读取目录…</div>
      <div v-else-if="currentState?.error" class="directory-error-actions">
        <button type="button" class="directory-status error" :disabled="disabled" @click="loadDirectory(mobilePath, true)">{{ currentState.error }} · 重试</button>
        <button v-if="currentState.diagnostic" type="button" class="directory-diagnostic" :disabled="disabled" @click="copyDiagnostic(currentState)">{{ currentState.diagnosticCopyState === 'copied' ? '诊断信息已复制' : currentState.diagnosticCopyState === 'failed' ? '复制失败，请重试' : '复制诊断信息' }}</button>
      </div>
      <button v-else-if="currentState?.nextCursor" type="button" class="directory-more" :disabled="disabled" @click="loadDirectory(mobilePath)">加载更多</button>
      <div v-else-if="currentState && !visibleEntries(mobilePath).length" class="directory-status">{{ search ? '没有匹配项' : `这个目录没有${showHidden ? '' : '可见'}项目` }}</div>
    </div>

    <div v-else class="directory-scroll" role="tree" aria-label="工作区文件树">
      <button type="button" class="directory-tree-root" :class="{ selected: picker && selected === rootPath }" :aria-expanded="directoryExpanded(rootPath)" :disabled="disabled" :title="rootPath" @click="toggleDirectory(rootPath)"><FolderOpen :size="17" /><span>{{ rootPath }}</span></button>
      <template v-for="row in treeRows" :key="row.kind === 'entry' ? row.entry.path : `status:${row.path}`">
        <button v-if="row.kind === 'entry'" type="button" class="directory-tree-row" :class="{ selected: selected === row.entry.path }" :style="{ paddingLeft: `${18 + row.depth * 18}px` }" :disabled="disabled || (!isDirectory(row.entry) && !isFile(row.entry))" role="treeitem" :aria-expanded="isDirectory(row.entry) ? directoryExpanded(row.entry.path) : undefined" :aria-selected="selected === row.entry.path" :title="row.entry.path" @click="activate(row.entry)">
          <ChevronDown v-if="isDirectory(row.entry) && directoryExpanded(row.entry.path)" :size="14" class="directory-chevron" /><ChevronRight v-else-if="isDirectory(row.entry)" :size="14" class="directory-chevron" /><span v-else class="directory-chevron" />
          <FolderOpen v-if="isDirectory(row.entry) && directoryExpanded(row.entry.path)" :size="16" /><Folder v-else-if="isDirectory(row.entry)" :size="16" /><FileImage v-else-if="classifyWorkspacePreview(row.entry) === 'image'" :size="16" /><File v-else :size="16" />
          <span class="directory-name">{{ row.entry.name }}</span><span v-if="row.entry.kind === 'symlink'" class="directory-detail">↗</span><span v-if="isFile(row.entry)" class="directory-detail">{{ formatBytes(row.entry.sizeBytes) }}</span>
        </button>
        <template v-else>
          <div v-if="row.state.loading" class="directory-status" :style="{ paddingLeft: `${30 + row.depth * 18}px` }" role="status"><span class="directory-spinner" />正在读取…</div>
          <div v-else-if="row.state.error" class="directory-error-actions" :style="{ paddingLeft: `${30 + row.depth * 18}px` }">
            <button type="button" class="directory-status error" :disabled="disabled" @click="loadDirectory(row.path, true)">{{ row.state.error }} · 重试</button>
            <button v-if="row.state.diagnostic" type="button" class="directory-diagnostic" :disabled="disabled" @click="copyDiagnostic(row.state)">{{ row.state.diagnosticCopyState === 'copied' ? '诊断信息已复制' : row.state.diagnosticCopyState === 'failed' ? '复制失败，请重试' : '复制诊断信息' }}</button>
          </div>
          <button v-else-if="row.state.nextCursor" type="button" class="directory-more" :style="{ paddingLeft: `${48 + row.depth * 18}px` }" :disabled="disabled" @click="loadDirectory(row.path)">加载更多</button>
          <div v-else class="directory-status" :style="{ paddingLeft: `${30 + row.depth * 18}px` }">{{ search ? '没有匹配项' : `这个目录没有${showHidden ? '' : '可见'}项目` }}</div>
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.directory-browser { display: flex; min-width: 0; min-height: 0; flex-direction: column; border-right: 1px solid var(--alu-border); background: #0b111d; }
.directory-picker { flex: 1 1 auto; border-right: 0; }
.directory-toolbar { display: flex; min-width: 0; min-height: 47px; flex: 0 0 auto; align-items: center; gap: 8px; padding: 0 13px; border-bottom: 1px solid var(--alu-border); background: rgba(13, 21, 35, .94); }
.directory-heading { flex: 1; color: var(--alu-text-muted); font-size: 9px; font-weight: 700; }
.directory-icon-button { display: inline-flex; width: 32px; min-height: 32px; flex: 0 0 auto; align-items: center; justify-content: center; padding: 0; color: var(--alu-text-muted); border: 0; border-radius: 7px; background: transparent; }
.directory-icon-button:hover:not(:disabled) { color: var(--alu-text); background: var(--alu-hover); }
.directory-search { padding: 8px 13px; border-bottom: 1px solid var(--alu-border); }
.directory-search input { width: 100%; padding: 7px 9px; color: var(--alu-text); border: 1px solid var(--alu-border); border-radius: 6px; background: var(--alu-bg); font: inherit; font-size: 12px; }
.directory-scroll { flex: 1; min-height: 0; overflow: auto; padding: 8px 7px 18px; scrollbar-color: var(--alu-border) transparent; }
.directory-tree-root, .directory-tree-row, .directory-more, .directory-status { display: flex; width: 100%; min-width: 0; min-height: 34px; align-items: center; gap: 7px; padding: 4px 9px; color: var(--alu-text-muted); border: 0; border-radius: 6px; background: transparent; font-size: 10px; text-align: left; }
.directory-tree-root { color: var(--alu-text); font-weight: 700; }
.directory-tree-root > span, .directory-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.directory-tree-root > svg, .directory-tree-row > svg { flex-shrink: 0; }
.directory-tree-row:hover:not(:disabled), .directory-tree-root:hover:not(:disabled), .directory-more:hover:not(:disabled) { color: var(--alu-text); background: var(--alu-hover); }
.selected { color: var(--alu-text); background: var(--alu-blue-bg); box-shadow: inset 2px 0 var(--alu-blue); }
button:disabled { opacity: .5; }
.directory-chevron { width: 14px; flex: 0 0 14px; }
.directory-detail { flex: 0 0 auto; color: var(--alu-text-faint); font-size: 8px; }
.directory-status { color: var(--alu-text-faint); }
.directory-status.error { color: var(--alu-rose); }
.directory-error-actions { display: flex; min-width: 0; flex-direction: column; align-items: flex-start; }
.directory-diagnostic { min-height: 34px; margin: 0 9px 4px; padding: 4px 8px; color: var(--alu-blue); border: 1px solid var(--alu-border); border-radius: 6px; background: transparent; font-size: 10px; }
.directory-diagnostic:hover:not(:disabled) { background: var(--alu-hover); }
.directory-more { color: var(--alu-blue); }
.directory-spinner { display: inline-block; width: 13px; height: 13px; flex: 0 0 auto; border: 2px solid rgba(126, 200, 224, .22); border-top-color: var(--alu-blue); border-radius: 50%; animation: directory-spin .85s linear infinite; }
.spinning { animation: directory-spin .85s linear infinite; }
.directory-breadcrumbs { display: flex; min-width: 0; flex: 1; align-items: center; gap: 5px; overflow: auto; color: var(--alu-text-faint); }
.directory-breadcrumbs button { min-height: 30px; padding: 0 2px; color: var(--alu-blue); border: 0; background: transparent; font-size: 10px; white-space: nowrap; }
.directory-mobile-row { display: grid; width: 100%; min-height: 52px; grid-template-columns: 22px minmax(0, 1fr) 18px; align-items: center; gap: 9px; padding: 7px 9px; color: var(--alu-text-muted); border: 0; border-bottom: 1px solid rgba(45, 57, 79, .55); background: transparent; text-align: left; }
.directory-mobile-row > span { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.directory-mobile-row strong { overflow: hidden; color: var(--alu-text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.directory-mobile-row small { color: var(--alu-text-faint); font-size: 8px; }
@keyframes directory-spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) {
  .directory-browser { width: 100%; height: 100%; border: 0; }
  .directory-picker { height: auto; }
  .directory-toolbar { min-height: 48px; }
  .directory-icon-button { width: 40px; min-height: 40px; }
  .directory-mobile-list .directory-diagnostic { min-height: 44px; align-self: center; }
  .directory-mobile-list .directory-status, .directory-mobile-list .directory-more { min-height: 48px; justify-content: center; text-align: center; }
}
</style>
