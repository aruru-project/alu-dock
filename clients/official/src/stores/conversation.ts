import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { loadConversationImage, loadPublishedImage, nativeMediaUrl, registerInlineConversationImage } from '../lib/bridge'
import { useConversationContent } from '../lib/conversationContent'
import { useConversationSession } from '../lib/conversationSession'
import { useConversationViewport, type ConversationReadingAnchor } from '../lib/conversationViewport'
import { readConversationPosition, saveConversationPosition } from '../lib/localState'
import { requireConnectionContext } from '../lib/hostResult'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { ConnectionContext, ConversationImageResource, ConversationItem, ConversationProcessItem, Work } from '../lib/types'
import { useObservationStore, type ConversationSink } from './observation'
import { useAppStore } from './app'
import { useExtensionUiStore } from './extension-ui'
import { useSurfacesStore } from './surfaces'
/** Disposable display, media resources and tool expansion. No editor or Queue control.
 * It attaches itself as the observation store's display when created. */
export const useConversationStore = defineStore('conversation', () => {
  const app = useAppStore()
  const page = useSurfacesStore()
  const observation = useObservationStore()
  const selected = computed(() => app.selectedWork)
  const extensionUi = useExtensionUiStore()
  const toolExpansionOverrides = ref<Record<string, boolean>>({})
  const output = ref<HTMLElement | null>(null)
  const conversationViewport = useConversationViewport(output, {
    read: scope => { try { return readConversationPosition(window.localStorage, scope.connectionId, scope.workId) } catch { return undefined } },
    write: (scope, position) => { try { return saveConversationPosition(window.localStorage, scope.connectionId, scope.workId, position) } catch { return false } },
  })
  const readingError = conversationViewport.readingError
  function readingScope(work: Work, hostEpoch: string) {
    const connectionId = app.activeConnectionId, sessionId = work.executor.piSessionId
    return connectionId && sessionId && hostEpoch ? { connectionId, workId: work.id, hostEpoch, sessionId } : null
  }
  const outputAwayFromBottom = conversationViewport.awayFromBottom

  type ConversationImagePart = Extract<ConversationProcessItem, { kind: 'image' }>
  const imageResources = ref<Record<string, ConversationImageResource>>({})
  let imageDomainKey = ''
  let imageLoadEpoch = 0

  const conversationContent = useConversationContent({
    beforeLayoutChange: conversationViewport.captureAnchor,
    afterLayoutChange: (snapshot, stickToBottom) => conversationViewport.restoreAnchor(snapshot as ConversationReadingAnchor | null, stickToBottom),
    isFollowing: conversationViewport.isFollowing,
    layoutChanged: conversationViewport.layoutChanged,
    projected: pruneImageResources,
  })
  const conversationSession = useConversationSession(computed(() => {
    const context = app.connectionContext
    const instanceId = selected.value?.id
    const hostEpoch = app.payload?.host.hostEpoch
    return context && instanceId && hostEpoch ? { ...context, instanceId, hostEpoch } : null
  }), conversationContent)

  const conversationState = conversationContent.state
  const realConversation = conversationContent.items
  const streamingPartIds = conversationContent.streamingPartIds
  const historyTruncated = conversationContent.historyTruncated
  const contentSeeding = conversationContent.seeding
  const historyLoading = conversationContent.historyLoading
  const historyHydrationActiveEntries = conversationContent.hydrationActiveEntries
  const historyHydrationErrors = conversationContent.hydrationErrors
  const historyHydrating = conversationContent.historyHydrating
  const historyError = conversationContent.historyError
  const conversation = realConversation

  const conversationSwitching = computed(() => Boolean(
    selected.value && conversationState.value && selected.value.id !== conversationState.value.instance.id,
  ))

  watch(() => extensionUi.toolsResetRevision, () => { toolExpansionOverrides.value = {} })

  function showAgentActivity(workId: string) {
    conversationContent.showPendingTurn(workId)
    conversationViewport.scrollToBottom()
  }

  const restoringAnchorId = conversationViewport.restoringAnchorId
  /** Expanding or collapsing a turn keeps the row the reader is on where it is. */
  function holdReadingPosition(change: () => void) {
    const anchor = conversationViewport.captureAnchor()
    change()
    void conversationViewport.restoreAnchor(anchor, false)
  }

  const handleOutputScroll = conversationViewport.handleScroll
  const handleOutputMediaLoad = conversationViewport.mediaLoaded

  function scrollOutputToBottom(force = false) {
    if (force) conversationViewport.scrollToBottom()
    else conversationViewport.layoutChanged()
  }

  const idleImageResource: ConversationImageResource = { state: 'idle' }
  const loadingImageResource: ConversationImageResource = { state: 'loading' }

  function imageResource(part: ConversationImagePart): ConversationImageResource {
    const available = imageResources.value[part.imageKey]
    if (available) return available
    const entryId = part.historyEntryId
    if (!part.source && entryId && historyHydrationActiveEntries.value.has(entryId)) return loadingImageResource
    const hydrationError = entryId ? historyHydrationErrors.value[entryId] : undefined
    if (!part.source && hydrationError) return { state: 'error', message: hydrationError }
    return idleImageResource
  }

  function setImageResource(imageKey: string, resource: ConversationImageResource) {
    imageResources.value = { ...imageResources.value, [imageKey]: resource }
  }

  function resetConversationImages() {
    imageLoadEpoch += 1
    imageResources.value = {}
    page.retirePreview('conversation')
    imageDomainKey = ''
  }

  function syncImageDomain(context: ConnectionContext, workId: string, hostEpoch: string, runtimeGeneration: number) {
    const next = JSON.stringify([context.connectionId, context.selectionGeneration, workId, hostEpoch, runtimeGeneration])
    if (imageDomainKey && imageDomainKey !== next) resetConversationImages()
    imageDomainKey = next
  }

  function itemImages(item: ConversationItem): ConversationImagePart[] {
    if (item.kind === 'image') return [item]
    if (item.kind === 'user') return item.images ?? []
    if (item.kind === 'record') return item.parts.filter((part): part is ConversationImagePart => part.kind === 'image')
    return []
  }

  function pruneImageResources(items: ConversationItem[]) {
    const active = new Set<string>()
    for (const item of items) {
      for (const image of itemImages(item)) active.add(image.imageKey)
    }
    const next = { ...imageResources.value }
    let changed = false
    for (const key of Object.keys(next)) {
      if (active.has(key)) continue
      delete next[key]
      changed = true
      page.retirePreview('conversation', key)
    }
    if (changed) imageResources.value = next
  }

  function conversationHasImage(imageKey: string) {
    return realConversation.value.some((item) => itemImages(item).some((image) => image.imageKey === imageKey))
  }

  async function requestConversationImage(part: ConversationImagePart) {
    const source = part.source
    if (!source) {
      if (part.historyEntryId && historyHydrationErrors.value[part.historyEntryId]) retryHistoryEntry(part.historyEntryId)
      return
    }
    const state = conversationState.value
    const work = selected.value
    const cachedResource = imageResources.value[part.imageKey]
    if (cachedResource?.state === 'ready' && cachedResource.url) {
      return
    }
    const displayedResource = imageResource(part)
    if (!state || !work || displayedResource.state === 'loading' || displayedResource.state === 'ready') return
    const capturedHost = requireConnectionContext(app)
    const expectedEpoch = state.cursor.hostEpoch
    const expectedGeneration = state.cursor.runtimeGeneration
    const loadEpoch = imageLoadEpoch
    setImageResource(part.imageKey, { state: 'loading' })
    try {
      let media: { handle: string; url: string; sizeBytes: number }
      if (source.type === 'native') {
        media = nativeMediaUrl(source.media)
      } else if (source.type === 'conversation') {
        media = await loadConversationImage(work.id, expectedEpoch, expectedGeneration, source.contentRef, source.mimeType, capturedHost, part.fileId)
      } else if (source.type === 'inline') {
        media = await registerInlineConversationImage(work.id, expectedEpoch, expectedGeneration, source.data, source.mimeType, capturedHost)
      } else {
        media = await loadPublishedImage(work.id, expectedEpoch, expectedGeneration, source.file, capturedHost)
      }
      if (loadEpoch !== imageLoadEpoch
        || !app.contextMatches(capturedHost)
        || selected.value?.id !== work.id
        || conversationState.value?.cursor.hostEpoch !== expectedEpoch
        || conversationState.value?.cursor.runtimeGeneration !== expectedGeneration
        || !conversationHasImage(part.imageKey)) {
        return
      }
      setImageResource(part.imageKey, {
        state: 'ready',
        url: media.url,
        handle: media.handle,
      })
    } catch (cause) {
      if (loadEpoch !== imageLoadEpoch || !app.contextMatches(capturedHost) || selected.value?.id !== work.id || !conversationHasImage(part.imageKey)) return
      setImageResource(part.imageKey, { state: 'error', message: imageLoadMessage(cause) })
    }
  }

  function markConversationImageFailed(part: ConversationImagePart) {
    if (imageResource(part).state !== 'ready') return
    setImageResource(part.imageKey, { state: 'error', message: '图片内容无法解码，请重新读取。' })
    page.retirePreview('conversation', part.imageKey)
  }

  function imageLoadMessage(cause: unknown) {
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
    if (code === 'file_unavailable') return '图片已经失效，请让 Agent 重新发布。'
    if (code === 'image_too_large') return '图片过大，当前设备无法安全预览。'
    if (code === 'unsupported_image') return '图片格式无法安全显示。'
    return errorMessage(cause, '图片暂时无法读取，请稍后重试。')
  }

  function openImagePreview(part: ConversationImagePart) {
    const resource = imageResource(part)
    if (resource.state !== 'ready' || !resource.url) return
    page.showImagePreview({
      kind: 'conversation',
      imageKey: part.imageKey,
      url: resource.url,
      handle: resource.handle,
      name: (part.name || 'aludock-image').replace(/[\\/]/g, '_'),
    })
  }

  const retryHistoryEntry = conversationSession.retry
  const retryConversationHydration = () => conversationSession.retry()
  const loadEarlierHistory = conversationSession.loadEarlier

  function toolDetailOpen(id: string) {
    return toolExpansionOverrides.value[id] ?? extensionUi.toolsExpanded
  }

  function rememberToolDetail(id: string, event: Event) {
    toolExpansionOverrides.value = { ...toolExpansionOverrides.value, [id]: (event.currentTarget as HTMLDetailsElement).open }
  }

  let enteringWork = false
  const sink: ConversationSink = {
    preparingView: () => conversationContent.preparingView.value,
    matchesToken: conversationSession.matchesToken,
    bind: conversationSession.bind,
    content: (token, change) => {
      conversationSession.accept(token, change)
      if (conversationSession.matchesToken(token) && change.kind === 'checkpoint_end') conversationViewport.seeded()
    },
    failed: conversationSession.failed,
    replay: conversationContent.applyReplayEvent,
    event: (event, instance, changed) => {
      const state = conversationContent.state.value
      if (!state) return
      state.instance = instance
      state.cursor.sequence = event.sequence
      conversationContent.applyConversationEvent(state, event, changed)
    },
    readCut: conversationContent.acceptReadCut,
    read: (bootstrap, sameDomain, earlier) => {
      conversationViewport.bindScope(readingScope(bootstrap.instance, bootstrap.cursor.hostEpoch))
      const anchor = sameDomain ? conversationViewport.captureAnchor() : null
      const following = sameDomain ? conversationViewport.isFollowing() : true
      syncImageDomain(requireConnectionContext(app), bootstrap.instance.id, bootstrap.cursor.hostEpoch, bootstrap.cursor.runtimeGeneration)
      conversationContent.publish(earlier === undefined ? bootstrap : { ...bootstrap, historyTruncated: earlier }, enteringWork)
      enteringWork = false
      if (anchor && !following) void conversationViewport.restoreAnchor(anchor, false)
      else conversationViewport.layoutChanged()
    },
    replace: (snapshot) => {
      conversationViewport.bindScope(readingScope(snapshot, snapshot.ownerHostEpoch ?? ''), true)
      conversationContent.clear()
      syncImageDomain(requireConnectionContext(app), snapshot.id, snapshot.ownerHostEpoch ?? '', snapshot.runtimeGeneration)
    },
  }

  watch(() => JSON.stringify([app.activeConnectionId, selected.value?.id]), (_next, previous) => {
    enteringWork = Boolean(previous && JSON.parse(previous)[1])
    conversationViewport.bindScope(null)
    conversationContent.clear(); resetConversationImages(); toolExpansionOverrides.value = {}
  }, { flush: 'sync' })
  const detachDisplay = observation.attachDisplay(sink)
  onScopeDispose(() => { detachDisplay(); conversationViewport.savePosition(); conversationContent.dispose(); resetConversationImages() })
  function failPreview(imageKey: string) {
    const resource = imageResources.value[imageKey]
    if (resource?.state === 'ready') setImageResource(imageKey, { state: 'error', message: '图片内容无法解码，请重新读取。' })
  }
  return { readingError, output, outputAwayFromBottom, conversationState, conversation, conversationSwitching, streamingPartIds, historyTruncated, contentSeeding, historyLoading, historyHydrating, historyError, setReadInterest: conversationSession.setInterest, showAgentActivity, holdReadingPosition, restoringAnchorId, handleOutputScroll, handleOutputMediaLoad, scrollOutputToBottom, imageResource, requestConversationImage, markConversationImageFailed, openImagePreview, toolDetailOpen, rememberToolDetail, loadEarlierHistory, retryConversationHydration, failPreview }
})
