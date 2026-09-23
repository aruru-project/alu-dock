import type { ReadonlyRefs } from './ownerView'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { isTauri, loadConversationImage, loadPublishedImage, nativeMediaUrl, registerInlineConversationImage } from './bridge'
import { useConversationContent } from './conversationContent'
import { useConversationSession } from './conversationSession'
import { useConversationViewport, type ConversationReadingAnchor } from './conversationViewport'
import { readConversationPosition, saveConversationPosition } from './localState'
import { requireConnectionContext } from './hostResult'
import { userErrorMessage as errorMessage } from './userError'
import type { ConnectionContext, ConversationImageResource, ConversationItem, ConversationProcessItem, Work } from './types'
import type { ConversationSink } from './workObservation'
import type { usePageSurfaces } from './pageSurfaces'
import { useAppStore } from '../stores/app'
import { useExtensionUiStore } from '../stores/extension-ui'
/** Disposable display, media resources and tool expansion. No editor or Queue control. */
export function useConversationRegion(page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'imagePreview' | 'retirePreview' | 'showImagePreview'>>) {
  const app = useAppStore()
  const selected = computed(() => app.selectedWork)
  const detailMode = computed(() => app.detailMode)
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

  const previewConversation: ConversationItem[] = [
    { id: 'u1', kind: 'user', text: '请结合这份发布检查清单确认 Linux 客户端。', time: '19:38', attachments: [{ fileId: '45c6f7e8-9462-4fde-8ab9-1829dff71234', name: 'Linux 发布检查清单.pdf', sizeBytes: 248320, mediaType: 'application/pdf', sha256: 'a'.repeat(64), storedAt: '2026-08-17T08:00:00.000Z' }] },
    {
      id: 'a1',
      kind: 'assistant',
      groupId: 'preview-assistant-1',
      text: '已完成连接检查，Work 列表和当前对话已准备好。',
      time: '19:41',
    },
    { id: 't1', kind: 'thinking', groupId: 'preview-assistant-tools', title: '检查顺序', text: '先确认连接状态和 Work 列表，再检查窄屏布局。', open: true, groupTime: '19:41' },
    { id: 'tool1', kind: 'tool', groupId: 'preview-assistant-tools', name: '检查工作列表', summary: '已读取 Work 列表', status: 'done', detail: '已找到 5 个 Work' },
    {
      id: 'a2',
      kind: 'assistant',
      groupId: 'preview-assistant-2',
      text: '连接中断后，当前消息和草稿仍会保留；恢复连接后会继续显示最新内容。',
      time: '19:42',
    },
  ]

  const conversationContent = useConversationContent({
    compact: computed(() => !detailMode.value),
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
  const conversation = computed(() => (isTauri ? realConversation.value : previewConversation))

  const conversationSwitching = computed(() => Boolean(
    selected.value && conversationState.value && selected.value.id !== conversationState.value.instance.id,
  ))

  watch(detailMode, () => {
    if (conversationState.value) conversationContent.reproject(conversationState.value)
  })
  watch(() => extensionUi.toolsResetRevision, () => { toolExpansionOverrides.value = {} })

  function showAgentActivity(workId: string) {
    conversationContent.showActivity(workId)
    conversationViewport.scrollToBottom()
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

  const sink: ConversationSink = {
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
      conversationContent.publish(earlier === undefined ? bootstrap : { ...bootstrap, historyTruncated: earlier })
      if (anchor && !following) void conversationViewport.restoreAnchor(anchor, false)
      else conversationViewport.layoutChanged()
    },
    replace: (snapshot) => {
      conversationViewport.bindScope(readingScope(snapshot, snapshot.ownerHostEpoch ?? ''), true)
      conversationContent.clear()
      syncImageDomain(requireConnectionContext(app), snapshot.id, snapshot.ownerHostEpoch ?? '', snapshot.runtimeGeneration)
    },
  }

  watch(() => JSON.stringify([app.activeConnectionId, selected.value?.id]), () => {
    conversationViewport.bindScope(null)
    conversationContent.clear(); resetConversationImages(); toolExpansionOverrides.value = {}
  }, { flush: 'sync' })
  onScopeDispose(() => { conversationViewport.savePosition(); conversationContent.dispose(); resetConversationImages() })
  function failPreview(imageKey: string) {
    const resource = imageResources.value[imageKey]
    if (resource?.state === 'ready') setImageResource(imageKey, { state: 'error', message: '图片内容无法解码，请重新读取。' })
  }
  return { readingError, output, outputAwayFromBottom, conversationState, conversation, conversationSwitching, streamingPartIds, historyTruncated, contentSeeding, historyLoading, historyHydrating, historyError, conversationSession, sink, showAgentActivity, handleOutputScroll, handleOutputMediaLoad, scrollOutputToBottom, imageResource, requestConversationImage, markConversationImageFailed, openImagePreview, toolDetailOpen, rememberToolDetail, loadEarlierHistory, retryConversationHydration, failPreview }
}
