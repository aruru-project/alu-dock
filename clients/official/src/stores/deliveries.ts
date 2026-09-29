import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { downloadDeliverable, listDeliverables, openSavedDeliverable } from '../lib/bridge'
import {
  deliveryHistoryKey, downloadedDelivery, pastDownloadedDeliveries, persistDownloadHistory, readDownloadHistory,
  recordDownloadedDelivery, removeDownloadedDeliveries, type DownloadedDeliverable
} from '../lib/downloadHistory'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { DeliverableDto, DeliverableDownloadProgress } from '../lib/types'
import { useAppStore } from './app'
import { useSurfacesStore } from './surfaces'
/** Files the Agent delivered for the selected Work and this device's download history. */
export const useDeliveriesStore = defineStore('deliveries', () => {
  const app = useAppStore()
  const page = useSurfacesStore()
  const selected = computed(() => app.selectedWork)
  const deliverables = ref<DeliverableDto[]>([])
  const deliveryLoading = ref(false)
  const deliveryListLoaded = ref(false)
  const deliveryError = ref('')
  const downloadingDeliveries = ref<Set<string>>(new Set())
  const deliveryProgress = ref<Record<string, number>>({})
  const openingDeliveryKey = ref('')
  const downloadHistoryStorage = (() => {
    try { return window.localStorage } catch { return null }
  })()
  const downloadHistory = ref(readDownloadHistory(downloadHistoryStorage))
  let deliveryLoadEpoch = 0

  const currentDeliverableRows = computed(() => {
    const context = app.connectionContext
    const instanceId = selected.value?.id
    if (!context || !instanceId) return []
    return deliverables.value.map((deliverable) => {
      const key = deliveryHistoryKey(context.connectionId, instanceId, deliverable.deliveryRef)
      return {
        deliverable,
        downloaded: downloadedDelivery(downloadHistory.value, context.connectionId, instanceId, deliverable.deliveryRef),
        downloading: downloadingDeliveries.value.has(key),
        progress: deliveryProgress.value[key] ?? 0,
      }
    })
  })
  const olderDownloadHistory = computed(() => {
    const context = app.connectionContext
    const instanceId = selected.value?.id
    if (!context || !instanceId) return downloadHistory.value.items
    return pastDownloadedDeliveries(
      downloadHistory.value,
      context.connectionId,
      instanceId,
      deliverables.value,
      deliveryListLoaded.value,
    )
  })
  const pendingDeliverableCount = computed(() => currentDeliverableRows.value.filter((row) => !row.downloaded).length)

  watch(
    () => [app.activeConnectionId, app.connectionContext?.selectionGeneration, selected.value?.id, selected.value?.execution] as const,
    (current, previous) => {
      if (!previous) return
      const sameWork = current[0] === previous[0] && current[1] === previous[1] && current[2] === previous[2]
      if (sameWork && previous[3] === 'running' && current[3] !== 'running') void refreshDeliverables()
    },
  )

  function openDeliveryTray() {
    page.openDeliveryTray()
    void refreshDeliverables()
  }

  async function refreshDeliverables() {
    const context = app.connectionContext
    const instanceId = selected.value?.id
    if (!context || !instanceId) {
      deliverables.value = []
      deliveryLoading.value = false
      deliveryListLoaded.value = false
      return
    }
    const epoch = ++deliveryLoadEpoch
    deliveryLoading.value = true
    deliveryError.value = ''
    try {
      const items = await listDeliverables(instanceId, context)
      if (epoch !== deliveryLoadEpoch || !app.contextMatches(context) || selected.value?.id !== instanceId) return
      deliverables.value = items
      deliveryListLoaded.value = true
    } catch (cause) {
      if (epoch !== deliveryLoadEpoch || !app.contextMatches(context) || selected.value?.id !== instanceId) return
      deliveryError.value = errorMessage(cause, '无法加载当前 Work 的文件。请检查连接后重试。')
    } finally {
      if (epoch === deliveryLoadEpoch) deliveryLoading.value = false
    }
  }

  async function saveDeliverable(deliverable: DeliverableDto, redownload = false) {
    const context = app.connectionContext
    const work = selected.value
    if (!context || !work) return
    const existing = downloadedDelivery(downloadHistory.value, context.connectionId, work.id, deliverable.deliveryRef)
    if (existing && !redownload) {
      await openDownloadedDeliverable(existing)
      return
    }
    const key = deliveryHistoryKey(context.connectionId, work.id, deliverable.deliveryRef)
    if (downloadingDeliveries.value.has(key)) return
    downloadingDeliveries.value = new Set(downloadingDeliveries.value).add(key)
    deliveryProgress.value = { ...deliveryProgress.value, [key]: 0 }
    deliveryError.value = ''
    try {
      const result = await downloadDeliverable(work.id, deliverable, context)
      if (result.status === 'cancelled') return
      const next = recordDownloadedDelivery(downloadHistory.value, {
        connectionId: context.connectionId,
        instanceId: work.id,
        deliveryRef: result.deliverable.deliveryRef,
        name: result.deliverable.name,
        sizeBytes: result.deliverable.sizeBytes,
        savedLocation: result.location,
        downloadedAt: new Date().toISOString(),
        sha256: result.sha256,
        workName: work.displayName,
      })
      const persisted = persistDownloadHistory(downloadHistoryStorage, next)
      downloadHistory.value = next
      if (!persisted) deliveryError.value = '文件已保存，但下载记录未能更新。下次打开客户端时可能仍显示“下载”。'
    } catch (cause) {
      deliveryError.value = errorMessage(cause, '文件没有下载完成，请重试。')
    } finally {
      const pending = new Set(downloadingDeliveries.value)
      pending.delete(key)
      downloadingDeliveries.value = pending
      const progress = { ...deliveryProgress.value }
      delete progress[key]
      deliveryProgress.value = progress
    }
  }

  async function openDownloadedDeliverable(item: DownloadedDeliverable) {
    const key = deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef)
    if (openingDeliveryKey.value) return
    openingDeliveryKey.value = key
    deliveryError.value = ''
    try {
      await openSavedDeliverable(item.savedLocation)
    } catch (cause) {
      const fallback = item.savedLocation.kind === 'path'
        ? '暂时无法打开保存位置。请稍后重试。'
        : '暂时无法打开这个文件。请稍后重试。'
      deliveryError.value = errorMessage(cause, fallback)
    } finally {
      if (openingDeliveryKey.value === key) openingDeliveryKey.value = ''
    }
  }

  /** Resolves to whether the past records were removed. */
  async function clearLocalDownloadHistory(): Promise<boolean> {
    if (!olderDownloadHistory.value.length) return false
    const confirmed = await page.askConfirm('清空过去的下载记录？', '这些记录将从列表移除。已保存的文件保留在原位置。')
    if (!confirmed) return false
    const next = removeDownloadedDeliveries(downloadHistory.value, olderDownloadHistory.value)
    if (!persistDownloadHistory(downloadHistoryStorage, next)) {
      deliveryError.value = '下载记录未能清空，请重试。'
      return false
    }
    downloadHistory.value = next
    deliveryError.value = ''
    return true
  }

  watch(() => JSON.stringify([app.activeConnectionId, app.connectionContext?.selectionGeneration, selected.value?.id]), () => {
    ++deliveryLoadEpoch; deliverables.value = []; deliveryListLoaded.value = false; deliveryError.value = ''
    if (selected.value) void refreshDeliverables()
  })
  let unlisten: UnlistenFn | undefined
  let disposed = false
  async function listenNative() {
    if (unlisten) return
    const release = await listen<DeliverableDownloadProgress>('aludock://deliverable-progress', ({ payload }) => {
      const key = deliveryHistoryKey(payload.connectionId, payload.instanceId, payload.deliveryRef)
      if (!downloadingDeliveries.value.has(key)) return
      deliveryProgress.value = {
        ...deliveryProgress.value,
        [key]: payload.totalBytes > 0 ? Math.min(1, payload.bytesReceived / payload.totalBytes) : 0,
      }
    })
    if (disposed) release(); else unlisten = release
  }
  onScopeDispose(() => { disposed = true; unlisten?.() })
  return { deliveryLoading, deliveryError, currentDeliverableRows, olderDownloadHistory, pendingDeliverableCount, openingDeliveryKey, openDeliveryTray, refreshDeliverables, saveDeliverable, openDownloadedDeliverable, clearLocalDownloadHistory, listenNative }
})
