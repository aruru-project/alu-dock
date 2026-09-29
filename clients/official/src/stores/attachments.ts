import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  attachmentSnapshot, cancelAttachmentUpload, clearRestoredImages, isTauri, loadAttachmentPreview, nativeMediaUrl, pickAttachments, removeAttachment,
  restoredImageCount as nativeRestoredImageCount, stageClipboardImage, uploadAttachment,
} from '../lib/bridge'
import { attachmentUploadMatches, attachmentUploadTarget, bindLocalAttachment, moveAttachmentPreviewResource } from '../lib/attachmentDraft'
import { isRasterImageMimeType, rasterImageMimeType } from '../lib/rasterImage'
import { requireConnectionContext } from '../lib/hostResult'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { AttachmentJobSnapshot, SelectedAttachment } from '../lib/types'
import { createSignal } from '../lib/signal'
import { useAppStore } from './app'
import { useHostStore } from './host'
import { useObservationStore } from './observation'
import { useSurfacesStore } from './surfaces'
type AttachmentPreviewResource = { handle: string; url: string; mediaType: string }
/** The editor's attachment selection, uploads and previews. Failures go to the editor's message line. */
export const useAttachmentsStore = defineStore('attachments', () => {
  const app = useAppStore()
  const surfaces = useSurfacesStore()
  const host = useHostStore()
  const observation = useObservationStore()
  const errorReported = createSignal<[message: string | null]>()
  const selected = computed(() => app.selectedWork)
  const draftAttachments = computed(() => app.currentAttachments)
  const maxMessageAttachments = computed(() => app.payload?.maxAttachmentsPerMessage ?? 0)
  const attachmentPreviews = ref<Record<string, AttachmentPreviewResource>>({})
  const reportError = (message: string | null) => errorReported.emit(message)
  const attachmentWorkKey = computed(() => JSON.stringify([app.activeConnectionId, selected.value?.id]))
  const clearingImageWorks = ref(new Set<string>())
  const pickingWorks = ref(new Set<string>())
  const clearingRestoredImages = computed(() => clearingImageWorks.value.has(attachmentWorkKey.value))
  const attachmentPicking = computed(() => pickingWorks.value.has(attachmentWorkKey.value))
  const jobs = ref<AttachmentJobSnapshot[]>([])
  const storageError = '无法保存附件选择，请检查本机存储后重试；原选择保持不变。'
  const localErrors = ref<Record<string, string>>({})
  type UploadDraft = SelectedAttachment & { state: 'hashing' | 'uploading' | 'finalizing' | 'error'; progress: number; error?: string; retryable: boolean }
  const uploadDrafts = computed<UploadDraft[]>(() => app.currentPendingAttachments.map(selection => {
    const job = jobs.value.find(item => item.token === selection.jobId)
    const mismatch = selection.sessionId !== selected.value?.executor.piSessionId
      || !!(job?.target && selected.value && app.connectionContext && !attachmentUploadMatches(
        { ...app.connectionContext, instanceId: selected.value.id, ...job.target }, attachmentUploadTarget(selected.value, app.connectionContext)))
    const active = job && ['hashing', 'uploading', 'finalizing'].includes(job.state)
    return { token: selection.jobId, name: job?.name ?? '待恢复附件', sizeBytes: job?.sizeBytes ?? 0, mediaType: job?.mediaType,
      state: active && !mismatch ? job.state as 'hashing' | 'uploading' | 'finalizing' : 'error',
      progress: job?.progress?.totalBytes ? job.progress.bytesProcessed / job.progress.totalBytes : 0,
      error: mismatch ? '工作已更新，附件仍保留；请移除这项选择后重新选择文件。' : localErrors.value[selection.jobId] ?? job?.error?.message ?? (job ? '附件已保留，点击重试即可继续加入。' : '这项附件在当前应用中不可用，请移除后重新选择。'),
      retryable: !!job && !mismatch && job.state !== 'unknown',
    }
  }))
  const restoredImageCount = computed(() => app.currentRestoredImageCount)
  let viewEpoch = 0
  let jobsRevision = -1
  // Scalars, not a retained reactive Work: an A→B→A visit is a new handoff.
  function captureView() {
    const work = selected.value, context = app.connectionContext
    return work && context ? { epoch: viewEpoch, context: { ...context }, workId: work.id,
      sessionId: work.executor.piSessionId, runtimeGeneration: work.runtimeGeneration,
      ownerHostEpoch: work.ownerHostEpoch, machineHostId: work.hostId, lifecycle: work.lifecycle } : null
  }
  type AttachmentView = ReturnType<typeof captureView>
  function viewMatches(view: AttachmentView): view is NonNullable<AttachmentView> {
    const work = selected.value
    return !!view && view.epoch === viewEpoch && app.contextMatches(view.context) && !!work
      && work.id === view.workId && work.executor.piSessionId === view.sessionId
      && work.runtimeGeneration === view.runtimeGeneration && work.ownerHostEpoch === view.ownerHostEpoch
      && work.hostId === view.machineHostId && work.lifecycle === view.lifecycle
  }
  function reportViewError(view: AttachmentView, cause: unknown) {
    if (viewMatches(view)) reportError(errorMessage(cause))
  }
  function refreshCurrentJobs() {
    const view = captureView()
    return refreshJobs(view).catch(cause => reportViewError(view, cause))
  }
  async function refreshJobs(view = captureView()) {
    if (!viewMatches(view)) return
    const snapshot = await attachmentSnapshot(view.workId, view.context)
    if (!viewMatches(view)) return
    if (snapshot.revision < jobsRevision) return
    jobsRevision = snapshot.revision
    jobs.value = snapshot.jobs.map(item => {
      const previous = jobs.value.find(old => old.token === item.token)
      return previous && previous.revision > item.revision ? previous : item
    })
    applyReceipts()
    for (const attachment of draftAttachments.value) {
      const job = jobs.value.find(item => item.token === attachment.localUpload?.jobId)
      if (job && !attachmentPreviews.value[attachment.fileId]) {
        await prepareAttachmentPreview(job, view)
        if (!viewMatches(view)) return
        moveAttachmentPreview(job.token, attachment.fileId)
      }
    }
  }
  function applyReceipts() {
    if (!app.operationResultsReady) return
    const work = selected.value, context = app.connectionContext
    if (!work || !context) return
    for (const selection of [...app.currentPendingAttachments]) {
      const job = jobs.value.find(item => item.token === selection.jobId)
      if (!job?.result || !job.target || selection.sessionId !== work.executor.piSessionId) continue
      const target = { ...context, instanceId: work.id, ...job.target }
      if (!attachmentUploadMatches(target, attachmentUploadTarget(work, context))) continue
      if (app.completeAttachmentSelection(selection, bindLocalAttachment(job.result.attachment, job.token, target))) {
        moveAttachmentPreview(job.token, job.result.attachment.fileId)
        delete localErrors.value[job.token]
      } else localErrors.value[job.token] = storageError
    }
  }
  watch(() => app.operationResultsReady, applyReceipts)

  function setAttachmentPreview(key: string, resource: AttachmentPreviewResource) {
    attachmentPreviews.value = { ...attachmentPreviews.value, [key]: resource }
  }

  function removeAttachmentPreview(key: string) {
    const resource = attachmentPreviews.value[key]
    if (!resource) return
    const next = { ...attachmentPreviews.value }
    delete next[key]
    attachmentPreviews.value = next
    surfaces.retirePreview('attachment', key)
  }

  function moveAttachmentPreview(from: string, to: string) {
    const moved = moveAttachmentPreviewResource(attachmentPreviews.value, from, to)
    if (!moved.moved) return
    attachmentPreviews.value = moved.resources
    surfaces.moveAttachmentPreview(from, to)
  }

  function resetAttachmentPreviews() {
    attachmentPreviews.value = {}
    surfaces.retirePreview('attachment')
  }

  function openAttachmentPreview(key: string, name: string) {
    const resource = attachmentPreviews.value[key]
    if (!resource) return
    surfaces.showImagePreview({
      kind: 'attachment',
      attachmentKey: key,
      url: resource.url,
      handle: resource.handle,
      name: name.replace(/[\\/]/g, '_'),
    })
  }

  function attachmentCanPreview(mediaType?: string) {
    return !!mediaType && isRasterImageMimeType(mediaType)
  }

  async function prepareAttachmentPreview(item: SelectedAttachment, view: AttachmentView) {
    if (!viewMatches(view) || !attachmentCanPreview(item.mediaType) || attachmentPreviews.value[item.token]) return
    try {
      const media = await loadAttachmentPreview(view.workId, item.token, view.context)
      if (!viewMatches(view)) return
      setAttachmentPreview(item.token, { handle: media.handle, mediaType: media.mimeType, url: nativeMediaUrl(media).url })
    } catch {
      // A source may still be uploaded as an ordinary file when local raster preview is unavailable.
    }
  }


  function acceptSelections(items: SelectedAttachment[], view: AttachmentView) {
    if (!viewMatches(view)) return false
    if (draftAttachments.value.length + app.currentPendingAttachments.length + items.length > maxMessageAttachments.value) {
      reportError('所选文件超过本条消息可用的附件数量，请减少选择后重试。')
      return false
    }
    if (!app.setPendingAttachments([...app.currentPendingAttachments, ...items.map(item => ({
      jobId: item.token, revision: crypto.randomUUID(), sessionId: view.sessionId,
    }))])) { reportError(storageError); return false }
    return true
  }
  async function launchAttachmentUpload(item: SelectedAttachment, view = captureView()) {
    if (!viewMatches(view) || !app.currentPendingAttachments.some(selection => selection.jobId === item.token && selection.sessionId === view.sessionId)) return
    try {
      const job = jobs.value.find(job => job.token === item.token)
      if (!job || job.state === 'selected' || job.state === 'failed') await uploadAttachment(selected.value!, item.token, view.context)
      if (!viewMatches(view)) return
      await refreshJobs(view)
      if (!viewMatches(view)) return
      await prepareAttachmentPreview(item, view)
      if (!viewMatches(view)) return
      const completed = jobs.value.find(job => job.token === item.token)?.result
      if (completed && draftAttachments.value.some(attachment => attachment.fileId === completed.attachment.fileId)) moveAttachmentPreview(item.token, completed.attachment.fileId)
    } catch (cause) { reportViewError(view, cause) }
  }
  async function chooseAttachments() {
    const work = selected.value
    if (!work || !isTauri || work.lifecycle !== 'active' || host.pairingInProgress || attachmentPicking.value) return
    const view = captureView()
    if (!viewMatches(view)) return
    const pendingKey = attachmentWorkKey.value
    pickingWorks.value.add(pendingKey)
    reportError(null)
    try {
      const picked = await pickAttachments(view.workId, view.context)
      if (viewMatches(view)) await refreshJobs(view)
      if (acceptSelections(picked, view)) {
        for (const item of picked) void launchAttachmentUpload(item, view)
      } else {
        for (const item of picked) await removeAttachment(view.workId, item.token, view.context)
      }
    } catch (cause) { reportViewError(view, cause) }
    finally { pickingWorks.value.delete(pendingKey) }
  }
  async function handleComposerPaste(event: ClipboardEvent) {
    if (!isTauri) return
    const images = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null)
    if (!images.length) return
    event.preventDefault()
    const work = selected.value
    if (!work || work.lifecycle !== 'active' || host.pairingInProgress || attachmentPicking.value) { reportError('当前暂时不能添加剪贴板图片，请稍后重试。'); return }
    if (images.length + draftAttachments.value.length + app.currentPendingAttachments.length > maxMessageAttachments.value) {
      reportError(`一条消息最多可附加 ${maxMessageAttachments.value} 个文件，请减少选择后重试。`); return
    }
    const view = captureView()
    if (!viewMatches(view)) return
    const pendingKey = attachmentWorkKey.value
    pickingWorks.value.add(pendingKey)
    try {
      for (const [index, file] of images.entries()) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!viewMatches(view)) return
        if (!rasterImageMimeType(bytes)) throw new Error('剪贴板图片不是可用的 PNG、JPEG、GIF 或 WebP 格式，请重新复制。')
        const item = await stageClipboardImage(view.workId, bytes, index + 1, view.context)
        if (viewMatches(view)) await refreshJobs(view)
        if (!acceptSelections([item], view)) {
          await removeAttachment(view.workId, item.token, view.context)
          return
        }
        void launchAttachmentUpload(item, view)
      }
    } catch (cause) { reportViewError(view, cause) }
    finally { pickingWorks.value.delete(pendingKey) }
  }
  async function cancelUpload(item: SelectedAttachment) {
    const view = captureView()
    if (!viewMatches(view)) return
    try { await cancelAttachmentUpload(view.workId, item.token, view.context); await refreshJobs(view) }
    catch (cause) { reportViewError(view, cause) }
  }
  async function removeUpload(item: SelectedAttachment) {
    const view = captureView()
    if (!viewMatches(view)) return
    if (!app.setPendingAttachments(app.currentPendingAttachments.filter(selection => selection.jobId !== item.token))) { reportError(storageError); return }
    removeAttachmentPreview(item.token)
    try { await removeAttachment(view.workId, item.token, view.context); await refreshJobs(view) }
    catch (cause) { reportViewError(view, cause) }
  }
  function removeUploaded(fileId: string) {
    const view = captureView()
    if (!viewMatches(view)) return
    const attachment = draftAttachments.value.find(item => item.fileId === fileId)
    if (!app.setCurrentAttachments(draftAttachments.value.filter(item => item.fileId !== fileId))) { reportError(storageError); return }
    removeAttachmentPreview(fileId)
    const token = attachment?.localUpload?.jobId
    if (token) void removeAttachment(view.workId, token, view.context).then(() => refreshJobs(view)).catch(cause => reportViewError(view, cause))
  }
  async function refreshRestoredImageCount() {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    const workId = selected.value?.id
    if (!context || !workId) return
    try {
      const work = selected.value
      if (!work) return
      const count = await nativeRestoredImageCount(work, context)
      if (app.contextMatches(context) && selected.value?.id === workId) app.setRestoredImageCount(context.connectionId, workId, count)
    } catch (cause) { console.error('Cannot read restored image count.', cause) }
  }

  /** The input store checks that no send or Queue retrieval is running first. */
  async function clearQueueImages() {
    const work = selected.value
    if (!work || host.pairingInProgress || clearingRestoredImages.value) return
    const context = requireConnectionContext(app)
    const pendingKey = attachmentWorkKey.value
    clearingImageWorks.value.add(pendingKey)
    try {
      await clearRestoredImages(work, context)
      if (!app.contextMatches(context) || selected.value?.id !== work.id) return
      app.setRestoredImageCount(context.connectionId, work.id, 0)
    } catch (cause) {
      if (app.contextMatches(context) && selected.value?.id === work.id) reportError(errorMessage(cause))
    } finally {
      clearingImageWorks.value.delete(pendingKey)
    }
  }


  watch(() => JSON.stringify([app.connectionContext, selected.value?.id, selected.value?.executor.piSessionId, selected.value?.runtimeGeneration, selected.value?.ownerHostEpoch, selected.value?.hostId, selected.value?.lifecycle]), () => {
    viewEpoch++
    jobs.value = []
    jobsRevision = -1
    localErrors.value = {}
    resetAttachmentPreviews()
    if (selected.value) {
      const pending = app.currentPendingAttachments.filter(item => item.sessionId === selected.value!.executor.piSessionId)
      if (pending.length !== app.currentPendingAttachments.length && !app.setPendingAttachments(pending)) reportError(storageError)
      void refreshCurrentJobs()
      void refreshRestoredImageCount()
    }
  }, { immediate: true, flush: 'sync' })
  let unlisten: UnlistenFn | undefined
  let disposed = false
  async function listenNative() {
    if (unlisten) return
    const release = await listen<AttachmentJobSnapshot>('aludock://attachment-progress', ({ payload }) => {
      if (payload.connectionId === app.activeConnectionId && payload.workId === selected.value?.id) {
        // Resolve authority through the scoped query, not an event from an old local endpoint.
        void refreshCurrentJobs()
      }
    })
    if (disposed) release(); else { unlisten = release; await refreshCurrentJobs() }
  }
  // A replaced Session may have dropped the images returned from its Queue.
  const offReplaced = observation.onReplaced(() => { void refreshRestoredImageCount() })
  onScopeDispose(() => { disposed = true; viewEpoch++; unlisten?.(); offReplaced(); resetAttachmentPreviews() })
  return {
    draftAttachments, attachmentPreviews, uploadDrafts, attachmentPicking, clearingRestoredImages, restoredImageCount,
    maxMessageAttachments, onError: errorReported.on, refreshRestoredImageCount, clearQueueImages, chooseAttachments, handleComposerPaste,
    launchAttachmentUpload, cancelUpload, removeUpload, removeUploaded, openAttachmentPreview, removeAttachmentPreview, listenNative,
    previewFailed: () => reportError('这个图片附件无法预览，原附件仍保持不变。'),
  }
})
