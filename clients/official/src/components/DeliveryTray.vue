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
  return props.openingKey === deliveryHistoryKey(item.hostId, item.instanceId, item.deliveryRef)
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
          <article v-for="item in history" :key="`${item.hostId}:${item.instanceId}:${item.deliveryRef}`" class="delivery-row history-row">
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
