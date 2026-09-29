<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  File,
  X,
} from '@lucide/vue'
import {
  cancelWorkspaceFileRead,
  clearWorkspaceFileState,
  getWorkspaceEntryMetadata,
  isTauri,
  listWorkspaceEntries,
  loadWorkspaceCachedImage,
  loadWorkspaceCachedText,
  readWorkspaceFile,
  saveWorkspaceCachedFile,
  type WorkspaceFileContext,
} from '../lib/bridge'
import { rasterImageMimeType } from '../lib/rasterImage'
import { userErrorMessage } from '../lib/userError'
import DirectoryBrowser from './DirectoryBrowser.vue'
import ImageZoomSurface from './ImageZoomSurface.vue'
import MarkdownDocumentSurface from './MarkdownDocumentSurface.vue'
import {
  classifyWorkspacePreview as classifyPreview,
  formatWorkspaceBytes as formatBytes,
  workspaceEntryIsFile as entryIsFile,
  workspaceEntryIsMarkdown as entryIsMarkdown,
  type DirectoryPage,
  type WorkspacePreviewKind,
} from '../lib/workspaceBrowser'
import type {
  ConnectionContext,
  Work,
  WorkspaceFileCacheResult,
  WorkspaceFileCursor,
  WorkspaceFileEntry,
  WorkspaceFileReadProgress,
} from '../lib/types'

const props = defineProps<{
  open: boolean
  work: Work | null
  context: ConnectionContext | null
  hostEpoch: string
}>()
const emit = defineEmits<{ close: [] }>()

type PreviewKind = WorkspacePreviewKind
type PreviewPhase = 'empty' | 'metadata' | 'confirm' | 'reading' | 'ready' | 'unsupported' | 'error'
type PendingIntent = 'preview' | 'save'

const directoryBrowser = ref<InstanceType<typeof DirectoryBrowser> | null>(null)
const directoryKey = computed(() => JSON.stringify([
  props.context?.connectionId, props.context?.selectionGeneration,
  props.work?.id, props.work?.runtimeGeneration, props.hostEpoch,
]))
const showHidden = ref(false)
const mobilePreview = ref(false)
const selectedEntry = ref<WorkspaceFileEntry | null>(null)
const previewKind = ref<PreviewKind>('unsupported')
const previewPhase = ref<PreviewPhase>('empty')
const previewText = ref('')
const previewImageUrl = ref('')
const previewError = ref('')
const cacheResult = ref<WorkspaceFileCacheResult | null>(null)
const largeFileConfirmBytes = ref<number | null>(null)
const pendingIntent = ref<PendingIntent>('preview')
const progressBytes = ref(0)
const progressTotal = ref(0)
const activeReadId = ref('')
const saving = ref(false)
const saveStatus = ref('')
const isMobile = ref(false)
let operationEpoch = 0
let unlistenProgress: UnlistenFn | null = null
let componentMounted = false
let fileCleanup = Promise.resolve()

const selectedPathLabel = computed(() => {
  const path = selectedEntry.value?.path
  return path ? displayPath(path) : '选择一个文件查看内容'
})
const progressPercent = computed(() => {
  if (!progressTotal.value) return 0
  return Math.max(0, Math.min(100, Math.round(progressBytes.value / progressTotal.value * 100)))
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
    && current.connectionId === context.connectionId
    && current.selectionGeneration === context.selectionGeneration
    && current.instanceId === context.instanceId
    && current.expectedHostEpoch === context.expectedHostEpoch
    && current.expectedRuntimeGeneration === context.expectedRuntimeGeneration
}

function displayPath(path: string): string {
  return path === '.' ? '.' : `./${path}`
}

function parentPath(path: string): string {
  if (path === '.') return '.'
  const parts = path.split('/')
  parts.pop()
  return parts.length ? parts.join('/') : '.'
}

function errorCode(cause: unknown): string {
  return cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
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

async function invalidateFile(clearSelection: boolean): Promise<number> {
  const epoch = ++operationEpoch
  const readId = activeReadId.value
  const context = currentContext()
  activeReadId.value = ''
  revokePreviewImage()
  cacheResult.value = null
  largeFileConfirmBytes.value = null
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
  const cleanup = async () => {
    if (readId && context) await cancelWorkspaceFileRead(readId, context).catch(() => false)
    await clearWorkspaceFileState().catch(() => undefined)
  }
  fileCleanup = fileCleanup.then(cleanup, cleanup)
  await fileCleanup
  return epoch
}

async function readDirectoryPage(path: string, cursor?: WorkspaceFileCursor): Promise<DirectoryPage> {
  const context = currentContext()
  if (!context) throw new Error('当前工作暂时无法读取目录。请重新打开工作区后重试。')
  const page = await listWorkspaceEntries(path, cursor, context)
  return { ...page, parent: page.path === '.' ? undefined : parentPath(page.path) }
}
async function openFile(entry: WorkspaceFileEntry, saveAfterRead = false) {
  if (!entryIsFile(entry)) return
  const cleanup = invalidateFile(true)
  const epoch = operationEpoch
  selectedEntry.value = entry
  previewKind.value = classifyPreview(entry)
  previewPhase.value = 'metadata'
  previewError.value = ''
  pendingIntent.value = saveAfterRead ? 'save' : 'preview'
  mobilePreview.value = true
  await cleanup
  const context = currentContext()
  if (!context || epoch !== operationEpoch || !contextMatches(context) || !props.open) return
  try {
    const metadata = await getWorkspaceEntryMetadata(entry.path, context)
    if (epoch !== operationEpoch || !contextMatches(context) || !props.open) return
    selectedEntry.value = metadata.entry
    previewKind.value = classifyPreview(metadata.entry)
    largeFileConfirmBytes.value = metadata.largeFileConfirmBytes
    if (previewKind.value === 'unsupported' && !saveAfterRead) {
      previewPhase.value = 'unsupported'
      return
    }
    if ((metadata.entry.sizeBytes ?? 0) > metadata.largeFileConfirmBytes) {
      previewPhase.value = 'confirm'
      return
    }
    await beginRead(false, saveAfterRead, epoch)
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
      const mediaType = rasterImageMimeType(bytes)
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
  if (entry) await openFile(entry)
}

async function cancelRead() {
  if (!activeReadId.value) return
  const epoch = await invalidateFile(false)
  if (epoch !== operationEpoch) return
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
  await openFile(entry, true)
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

async function handleMobileBack() {
  if (mobilePreview.value) {
    await invalidateFile(true)
    return
  }
  if (!directoryBrowser.value?.goBack()) emit('close')
}

watch(
  () => [
    props.open,
    props.context?.connectionId,
    props.context?.selectionGeneration,
    props.work?.id,
    props.work?.lifecycle,
    props.work?.runtimeGeneration,
    props.hostEpoch,
  ] as const,
  (current, previous) => {
    const changed = !previous || current.slice(1).some((value, index) => value !== previous[index + 1])
    if (!props.open) {
      if (!changed && !previous?.[0]) return
      void invalidateFile(true)
      return
    }
    if (props.work?.lifecycle !== 'active' || !currentContext()) {
      emit('close')
      return
    }
    if (changed || !previous?.[0]) void invalidateFile(true)
  },
  { immediate: true },
)

onMounted(() => {
  componentMounted = true
  if (!isTauri) return
  void listen<WorkspaceFileReadProgress>('aludock://workspace-read-progress', ({ payload }) => {
    const context = currentContext()
    if (!context
      || payload.readId !== activeReadId.value
      || payload.connectionId !== context.connectionId
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
            <span class="workspace-kicker">当前 Work</span>
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
          <DirectoryBrowser
            :key="directoryKey"
            ref="directoryBrowser"
            v-model:show-hidden="showHidden"
            class="workspace-tree"
            start-path="."
            :load-page="readDirectoryPage"
            :selected-path="selectedEntry?.path"
            @file="openFile"
            @mobile="isMobile = $event"
            @refresh="invalidateFile(true)"
          />

          <main class="workspace-preview" aria-label="文件预览">
            <div class="workspace-preview-toolbar">
              <div><strong>{{ selectedEntry?.name || '预览' }}</strong><span>{{ selectedPathLabel }}</span></div>
              <button v-if="selectedEntry" type="button" class="workspace-save-button" :disabled="saving || previewPhase === 'metadata' || previewPhase === 'reading'" @click="requestSave"><Download :size="16" />{{ saving ? '保存中…' : '另存为' }}</button>
            </div>

            <div v-if="previewPhase === 'empty'" class="workspace-preview-empty">
              <File :size="34" />
              <strong>选择文件以预览</strong>
              <p>Markdown 可切换阅读与原文；其他文本按 UTF-8 源码显示。</p>
            </div>
            <div v-else-if="previewPhase === 'metadata'" class="workspace-preview-state"><span class="workspace-spinner" /><strong>正在读取文件信息…</strong></div>
            <div v-else-if="previewPhase === 'confirm'" class="workspace-preview-state workspace-confirm">
              <span class="workspace-confirm-mark">!</span>
              <strong>这是一个较大的文件</strong>
              <p>{{ formatBytes(selectedEntry?.sizeBytes) }} · 读取可能占用较多流量和设备内存。</p>
              <div><button type="button" class="workspace-secondary-button" @click="invalidateFile(true)">返回</button><button type="button" class="workspace-primary-button" @click="confirmPendingRead">{{ pendingIntent === 'save' ? '读取并另存为' : '继续读取' }}</button></div>
            </div>
            <div v-else-if="previewPhase === 'reading'" class="workspace-preview-state workspace-reading" role="status">
              <span class="workspace-spinner large" />
              <strong>正在读取 {{ selectedEntry?.name }}…</strong>
              <p>{{ formatBytes(progressBytes) }} / {{ formatBytes(progressTotal) }}</p>
              <div class="workspace-progress"><span :style="{ width: `${progressPercent}%` }" /></div>
              <button type="button" class="workspace-secondary-button" @click="cancelRead">取消</button>
            </div>
            <MarkdownDocumentSurface
              v-else-if="previewPhase === 'ready' && previewKind === 'text' && selectedEntry && entryIsMarkdown(selectedEntry)"
              class="workspace-markdown-preview"
              :source="previewText"
              :document-key="selectedEntry.path"
              initial-mode="reading"
              :aria-label="`${selectedEntry.name} Markdown 预览`"
            />
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
.workspace-preview-toolbar {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--alu-border);
  background: rgba(13, 21, 35, .94);
}
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
