<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  Download,
  ExternalLink,
  FileDown,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from '@lucide/vue'
import type { DeliverableDto } from '../lib/types'
import { deliveryHistoryKey, type DownloadedDeliverable } from '../lib/downloadHistory'
import { formatFileSize } from '../lib/fileSize'

export interface CurrentDeliverableRow {
  deliverable: DeliverableDto
  downloaded?: DownloadedDeliverable
  downloading: boolean
  progress: number
}

const props = defineProps<{
  open: boolean
  loading: boolean
  error: string
  currentWorkName: string
  current: CurrentDeliverableRow[]
  history: DownloadedDeliverable[]
  openingKey: string
}>()

const emit = defineEmits<{
  close: []
  refresh: []
  download: [deliverable: DeliverableDto]
  redownload: [deliverable: DeliverableDto]
  openSaved: [item: DownloadedDeliverable]
  clear: []
}>()

const tray = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const clearButton = ref<HTMLButtonElement | null>(null)
const pendingRows = computed(() => props.current.filter((row) => !row.downloaded).slice().reverse())
const downloadedRows = computed(() => props.current
  .filter((row): row is CurrentDeliverableRow & { downloaded: DownloadedDeliverable } => Boolean(row.downloaded))
  .slice()
  .sort((left, right) => Date.parse(right.downloaded.downloadedAt) - Date.parse(left.downloaded.downloadedAt)))

watch(() => props.open, async (open) => {
  if (!open) return
  await nextTick()
  closeButton.value?.focus()
})

defineExpose({
  focusClear: () => clearButton.value?.focus(),
  focusClose: () => closeButton.value?.focus(),
})

function keepFocusInside(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !tray.value) return
  const focusable = [...tray.value.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.offsetParent !== null)
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) {
    event.preventDefault()
    tray.value.focus()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function isOpening(item: DownloadedDeliverable) {
  return props.openingKey === deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef)
}

function savedFileAction(item: DownloadedDeliverable) {
  return item.savedLocation.kind === 'path' ? '打开位置' : '打开文件'
}

function dateLabel(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
</script>

<template>
  <button
    class="delivery-tray-scrim"
    :class="{ open }"
    :aria-hidden="!open"
    :tabindex="open ? 0 : -1"
    aria-label="关闭文件列表"
    @click="emit('close')"
  />
  <aside
    ref="tray"
    class="delivery-tray"
    :class="{ open }"
    :aria-hidden="!open"
    :inert="!open || undefined"
    role="dialog"
    aria-modal="true"
    aria-labelledby="delivery-tray-title"
    tabindex="-1"
    @keydown="keepFocusInside"
  >
    <header class="delivery-tray-head">
      <div class="delivery-tray-mark" aria-hidden="true"><FileDown :size="18" /></div>
      <div>
        <h2 id="delivery-tray-title">文件</h2>
        <p>查看当前 Work 交付的文件</p>
      </div>
      <button type="button" title="刷新当前 Work 的文件" aria-label="刷新当前 Work 的文件" :disabled="loading || !currentWorkName" @click="emit('refresh')">
        <RefreshCw :size="16" :class="{ spinning: loading }" />
      </button>
      <button ref="closeButton" type="button" aria-label="关闭文件列表" @click="emit('close')"><X :size="18" /></button>
    </header>

    <div class="delivery-tray-body">
      <div v-if="error" class="delivery-tray-message is-error" role="alert">{{ error }}</div>

      <section class="delivery-tray-section" aria-labelledby="current-deliveries-title">
        <div class="delivery-section-title">
          <div><span id="current-deliveries-title">当前 Work</span><small :title="currentWorkName">{{ currentWorkName || '未选择 Work' }}</small></div>
          <b>{{ current.length }} 个文件</b>
        </div>

        <div v-if="loading && !current.length" class="delivery-empty"><LoaderCircle :size="18" class="spinning" /><span>正在加载…</span></div>
        <div v-else-if="!current.length" class="delivery-empty"><FileDown :size="20" /><span>{{ currentWorkName ? '当前 Work 还没有文件' : '选择一个 Work 后查看文件' }}</span></div>
        <div v-else class="delivery-current-groups">
          <section v-if="pendingRows.length" class="delivery-current-group" aria-labelledby="pending-deliveries-title">
            <div class="delivery-subsection-title"><span id="pending-deliveries-title">待下载</span><b>{{ pendingRows.length }}</b></div>
            <div class="delivery-file-list">
              <article v-for="row in pendingRows" :key="row.deliverable.deliveryRef" class="delivery-row">
                <div class="delivery-file-copy">
                  <strong :title="row.deliverable.name">{{ row.deliverable.name }}</strong>
                  <span>{{ formatFileSize(row.deliverable.sizeBytes) }} · {{ row.downloading ? `正在下载 ${Math.round(row.progress * 100)}%` : '可下载' }}</span>
                  <div v-if="row.downloading" class="delivery-progress" role="progressbar" :aria-label="`正在下载：${row.deliverable.name}`" :aria-valuenow="Math.round(row.progress * 100)" aria-valuemin="0" aria-valuemax="100">
                    <i :style="{ width: `${Math.max(2, row.progress * 100)}%` }" />
                  </div>
                </div>
                <button
                  type="button"
                  class="delivery-row-action"
                  :disabled="row.downloading"
                  :aria-label="`下载 ${row.deliverable.name}`"
                  @click="emit('download', row.deliverable)"
                ><Download :size="16" /><span>{{ row.downloading ? `${Math.round(row.progress * 100)}%` : '下载' }}</span></button>
              </article>
            </div>
          </section>

          <section v-if="downloadedRows.length" class="delivery-current-group" aria-labelledby="downloaded-deliveries-title">
            <div class="delivery-subsection-title"><span id="downloaded-deliveries-title">已下载</span><b>{{ downloadedRows.length }}</b></div>
            <div class="delivery-file-list">
              <article v-for="(row, index) in downloadedRows" :key="row.deliverable.deliveryRef" class="delivery-row" :class="{ 'is-recent': index === 0 }">
                <div class="delivery-file-copy">
                  <strong :title="row.deliverable.name">{{ row.deliverable.name }}</strong>
                  <div class="delivery-file-meta">
                    <em v-if="index === 0">最近下载</em>
                    <span>{{ formatFileSize(row.deliverable.sizeBytes) }} · {{ dateLabel(row.downloaded.downloadedAt) }}</span>
                  </div>
                  <div v-if="row.downloading" class="delivery-progress" role="progressbar" :aria-label="`正在重新下载：${row.deliverable.name}`" :aria-valuenow="Math.round(row.progress * 100)" aria-valuemin="0" aria-valuemax="100">
                    <i :style="{ width: `${Math.max(2, row.progress * 100)}%` }" />
                  </div>
                </div>
                <div class="delivery-row-actions">
                  <button
                    type="button"
                    class="delivery-row-action is-open"
                    :disabled="isOpening(row.downloaded)"
                    :aria-label="`${savedFileAction(row.downloaded)}：${row.deliverable.name}`"
                    @click="emit('openSaved', row.downloaded)"
                  ><component :is="row.downloaded.savedLocation.kind === 'path' ? FolderOpen : ExternalLink" :size="16" /><span>{{ isOpening(row.downloaded) ? '正在打开' : savedFileAction(row.downloaded) }}</span></button>
                  <button
                    type="button"
                    class="delivery-row-action is-secondary"
                    :disabled="row.downloading"
                    :aria-label="`重新下载：${row.deliverable.name}`"
                    title="重新下载"
                    @click="emit('redownload', row.deliverable)"
                  ><RotateCcw :size="15" /><span>重新下载</span></button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>

      <section v-if="history.length" class="delivery-tray-section delivery-history" aria-labelledby="download-history-title">
        <div class="delivery-section-title">
          <div><span id="download-history-title">过去的下载</span></div>
          <b>{{ history.length }} 条</b>
        </div>
        <div class="delivery-file-list">
          <article v-for="item in history" :key="`${item.connectionId}:${item.instanceId}:${item.deliveryRef}`" class="delivery-row history-row">
            <div class="delivery-file-copy">
              <strong :title="item.name">{{ item.name }}</strong>
              <span>{{ formatFileSize(item.sizeBytes) }}<template v-if="item.workName"> · {{ item.workName }}</template> · {{ dateLabel(item.downloadedAt) }}</span>
              <small :title="item.savedLocation.label">{{ item.savedLocation.label }}</small>
            </div>
            <button type="button" class="delivery-row-action is-open" :disabled="isOpening(item)" :aria-label="`${savedFileAction(item)}：${item.name}`" @click="emit('openSaved', item)"><component :is="item.savedLocation.kind === 'path' ? FolderOpen : ExternalLink" :size="16" /><span>{{ isOpening(item) ? '正在打开' : savedFileAction(item) }}</span></button>
          </article>
        </div>
      </section>
    </div>

    <footer v-if="history.length" class="delivery-tray-footer">
      <button ref="clearButton" type="button" @click="emit('clear')"><Trash2 :size="15" />清空过去记录</button>
    </footer>
  </aside>
</template>

<style scoped>
.delivery-tray-scrim { position: fixed; z-index: 53; inset: 0; padding: 0; pointer-events: none; opacity: 0; border: 0; background: rgba(3, 6, 13, .74); backdrop-filter: blur(3px); transition: opacity .22s ease; }
.delivery-tray-scrim.open { pointer-events: auto; opacity: 1; }
.delivery-tray { position: fixed; z-index: 54; inset: 0 0 0 auto; display: flex; width: min(440px, 94vw); flex-direction: column; overflow: hidden; color: var(--alu-text); border-left: 1px solid var(--alu-border); background: color-mix(in srgb, var(--alu-bg) 96%, #071425); box-shadow: -18px 0 60px rgba(0, 0, 0, .5); transform: translateX(102%); transition: transform .25s cubic-bezier(.4, 0, .2, 1); }
.delivery-tray.open { transform: translateX(0); }
.delivery-tray-head { display: grid; min-height: 72px; flex: 0 0 auto; grid-template-columns: 38px minmax(0, 1fr) 34px 34px; align-items: center; gap: 8px; padding: max(12px, env(safe-area-inset-top)) 14px 12px; border-bottom: 1px solid var(--alu-border); background: linear-gradient(145deg, color-mix(in srgb, var(--alu-blue) 8%, transparent), transparent 62%); }
.delivery-tray-mark { display: grid; width: 36px; height: 36px; place-items: center; color: var(--alu-blue); border: 1px solid var(--alu-blue-border); border-radius: 10px; background: color-mix(in srgb, var(--alu-blue) 8%, transparent); box-shadow: inset 0 0 18px color-mix(in srgb, var(--alu-blue) 5%, transparent); }
.delivery-tray-head h2, .delivery-tray-head p { margin: 0; }
.delivery-tray-head h2 { font: 700 14px var(--font-reading); letter-spacing: .03em; }
.delivery-tray-head p { margin-top: 3px; color: var(--alu-text-muted); font: 11px var(--font-reading); }
.delivery-tray-head > button { display: grid; width: 34px; height: 34px; place-items: center; padding: 0; color: var(--alu-text-muted); border: 0; border-radius: 8px; background: transparent; cursor: pointer; }
.delivery-tray-head > button:hover:not(:disabled) { color: var(--alu-text); background: var(--alu-hover); }
.delivery-tray-head > button:disabled { opacity: .4; cursor: default; }
.delivery-tray-body { min-height: 0; flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 14px; }
.delivery-tray-message { margin-bottom: 12px; padding: 10px 12px; border-radius: 9px; font: 12px/1.5 var(--font-reading); }
.delivery-tray-message.is-error { color: var(--alu-rose); border: 1px solid var(--alu-rose-border); background: var(--alu-rose-bg); }
.delivery-tray-section + .delivery-tray-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--alu-border); }
.delivery-section-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin: 0 2px 12px; }
.delivery-section-title > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.delivery-section-title span { color: var(--alu-text); font: 750 12px var(--font-reading); letter-spacing: .04em; text-transform: uppercase; }
.delivery-section-title small { overflow: hidden; color: var(--alu-text-muted); font: 11px var(--font-reading); text-overflow: ellipsis; white-space: nowrap; }
.delivery-section-title b { flex: 0 0 auto; color: var(--alu-text-muted); font: 600 11px var(--font-reading); white-space: nowrap; }
.delivery-empty { display: flex; min-height: 92px; align-items: center; justify-content: center; gap: 9px; color: var(--alu-text-muted); border: 1px dashed var(--alu-border); border-radius: 11px; background: color-mix(in srgb, var(--alu-bg-raised) 70%, transparent); font: 12px var(--font-reading); }
.delivery-current-groups { display: flex; flex-direction: column; gap: 18px; }
.delivery-current-group { min-width: 0; }
.delivery-subsection-title { display: flex; align-items: center; justify-content: space-between; margin: 0 2px 7px; color: var(--alu-text-muted); }
.delivery-subsection-title span { font: 700 11px var(--font-reading); }
.delivery-subsection-title b { font: 650 11px var(--font-reading); }
.delivery-file-list { overflow: hidden; border: 1px solid var(--alu-border); border-radius: 11px; background: color-mix(in srgb, var(--alu-bg-raised) 72%, transparent); }
.delivery-row { position: relative; display: grid; min-height: 72px; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 11px 12px; background: transparent; transition: background .16s ease; }
.delivery-row + .delivery-row { border-top: 1px solid var(--alu-border); }
.delivery-row:hover { background: color-mix(in srgb, var(--alu-blue) 4%, var(--alu-bg-raised)); }
.delivery-row.is-recent { background: color-mix(in srgb, var(--alu-mint) 4%, transparent); }
.delivery-file-copy { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
.delivery-file-copy strong { display: -webkit-box; overflow: hidden; color: var(--alu-text); font: 650 13px/1.4 var(--font-reading); overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
.delivery-file-copy > span, .delivery-file-copy > small, .delivery-file-meta span { overflow: hidden; color: var(--alu-text-muted); font: 12px/1.35 var(--font-reading); text-overflow: ellipsis; white-space: nowrap; }
.delivery-file-copy > small { color: color-mix(in srgb, var(--alu-text-muted) 80%, transparent); font-size: 11px; }
.delivery-file-meta { display: flex; min-width: 0; align-items: center; gap: 7px; }
.delivery-file-meta em { flex: 0 0 auto; padding: 2px 6px; color: var(--alu-mint); border: 1px solid color-mix(in srgb, var(--alu-mint) 24%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--alu-mint) 6%, transparent); font: 700 10px/1.2 var(--font-reading); font-style: normal; }
.delivery-progress { width: 100%; height: 3px; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--alu-blue) 12%, transparent); }
.delivery-progress i { display: block; height: 100%; border-radius: inherit; background: var(--alu-blue); transition: width .16s ease; }
.delivery-row-actions { display: flex; align-items: center; gap: 6px; }
.delivery-row-action { display: inline-flex; min-height: 36px; align-items: center; justify-content: center; gap: 6px; padding: 0 11px; color: var(--alu-blue); border: 1px solid var(--alu-blue-border); border-radius: 8px; background: color-mix(in srgb, var(--alu-blue) 6%, transparent); font: 700 12px var(--font-reading); white-space: nowrap; cursor: pointer; }
.delivery-row-action.is-open { color: var(--alu-mint); border-color: color-mix(in srgb, var(--alu-mint) 22%, transparent); background: color-mix(in srgb, var(--alu-mint) 5%, transparent); }
.delivery-row-action.is-secondary { width: 36px; padding: 0; color: var(--alu-text-muted); border-color: transparent; background: transparent; }
.delivery-row-action.is-secondary span { display: none; }
.delivery-row-action.is-secondary:hover:not(:disabled) { color: var(--alu-blue); border-color: var(--alu-blue-border); background: color-mix(in srgb, var(--alu-blue) 6%, transparent); }
.delivery-row-action:disabled { opacity: .55; cursor: default; }
.delivery-tray-footer { display: flex; min-height: 58px; flex: 0 0 auto; align-items: center; justify-content: flex-start; padding: 10px 14px max(10px, env(safe-area-inset-bottom)); border-top: 1px solid var(--alu-border); background: var(--alu-bg); }
.delivery-tray-footer button { display: inline-flex; min-height: 36px; align-items: center; gap: 7px; padding: 0 11px; color: var(--alu-rose); border: 1px solid var(--alu-rose-border); border-radius: 8px; background: var(--alu-rose-bg); font: 700 12px var(--font-reading); cursor: pointer; }
@media (max-width: 640px) {
  .delivery-tray-head { min-height: 68px; }
  .delivery-tray-body { padding: 12px 10px; }
  .delivery-row { min-height: 76px; gap: 8px; padding: 10px; }
  .delivery-row-actions { gap: 4px; }
  .delivery-row-action { min-width: 44px; min-height: 44px; padding: 0 9px; }
  .delivery-row-action span { display: none; }
  .delivery-row-action.is-secondary { width: 44px; }
  .delivery-tray-footer button { min-height: 44px; }
}
.delivery-tray {
  top: var(--aludock-inset-top);
  right: var(--aludock-inset-right);
  bottom: max(var(--aludock-inset-bottom), var(--aludock-ime-bottom));
}
@media (max-width: 1000px) {
  .delivery-tray {
    width: min(390px, 100%);
    max-width: 100%;
  }
}
</style>
