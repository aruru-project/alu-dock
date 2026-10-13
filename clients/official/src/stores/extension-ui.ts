import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { releaseExtensionControl } from '../lib/bridge'
import type {
  ActiveInteraction,
  ConversationBootstrap,
  ExtensionControllerBinding,
  ExtensionControllerEmission,
  InteractionRequest,
  ProjectedEvent,
  Work,
} from '../lib/types'

export interface ExtensionWidget { key: string; lines: string[]; placement: 'aboveEditor' | 'belowEditor' }

export const useExtensionUiStore = defineStore('extension-ui', () => {
  const connectionId = ref('')
  const selectionGeneration = ref(0)
  const instanceId = ref('')
  const hostEpoch = ref('')
  const runtimeGeneration = ref(0)
  const subscriptionId = ref('')
  const lastSequence = ref(0)
  const status = ref<Record<string, string>>({})
  const aboveWidgets = ref<Record<string, ExtensionWidget>>({})
  const belowWidgets = ref<Record<string, ExtensionWidget>>({})
  const toolsExpanded = ref(false)
  const toolsResetRevision = ref(0)
  const activeSummary = ref<ActiveInteraction | undefined>()
  const activeRequest = ref<InteractionRequest | undefined>()
  const controller = ref<ExtensionControllerBinding | undefined>()
  const controllerState = ref<'detached' | 'acquiring' | 'attached' | 'disconnected'>('detached')
  /** Questions arrive with the Work's updates; this window never takes them over from others. */
  const shared = ref(false)
  /** Latest live editor/title text from the extension; applied once by the input area. */
  const directive = ref<{ id: number; title?: string; editorText?: string } | undefined>()
  let directiveId = 0
  let lifecycleRevision = 0
  let acquisitionRevision = 0

  // Only the operator connection needs a step to open a question; shared questions arrive by themselves.
  const hasAttention = computed(() => !shared.value && !!activeSummary.value && !activeRequest.value)
  const isCurrent = (work: Work | null | undefined) => !!work
    && work.id === instanceId.value
    && work.ownerHostEpoch === hostEpoch.value
    && work.runtimeGeneration === runtimeGeneration.value

  async function bootstrap(connection: { connectionId: string; selectionGeneration: number }, subscription: string, projection: ConversationBootstrap): Promise<boolean> {
    const revision = ++lifecycleRevision
    acquisitionRevision++
    const previousIdentity = {
      connectionId: connectionId.value,
      selectionGeneration: selectionGeneration.value,
      instanceId: instanceId.value,
      hostEpoch: hostEpoch.value,
      runtimeGeneration: runtimeGeneration.value,
    }
    const previousRequest = activeRequest.value
    const binding = controller.value
    const cursor = projection.cursor
    const sharedQuestions = projection.extensionUi.sharedQuestions === true
    // With shared questions this window keeps no operator connection, so others are not displaced.
    if (binding && (sharedQuestions || binding.connectionId !== connection.connectionId
      || binding.selectionGeneration !== connection.selectionGeneration
      || binding.instanceId !== cursor.instanceId
      || binding.hostEpoch !== cursor.hostEpoch
      || binding.runtimeGeneration !== cursor.runtimeGeneration)) {
      suspendController(binding.handle, false)
      // The new interaction's binding is installed synchronously. Releasing an
      // obsolete controller must not delay the new content or clear its request.
      void releaseController(binding.handle, 'detached', false).then((released) => {
        if (!released) controllerEnded(binding.handle, 'disconnected', false)
      })
    }
    if (revision !== lifecycleRevision) return false
    const sameGeneration = previousIdentity.connectionId === connection.connectionId
      && previousIdentity.selectionGeneration === connection.selectionGeneration
      && previousIdentity.instanceId === cursor.instanceId
      && previousIdentity.hostEpoch === cursor.hostEpoch
      && previousIdentity.runtimeGeneration === cursor.runtimeGeneration
    connectionId.value = connection.connectionId
    selectionGeneration.value = connection.selectionGeneration
    instanceId.value = cursor.instanceId
    hostEpoch.value = cursor.hostEpoch
    runtimeGeneration.value = cursor.runtimeGeneration
    subscriptionId.value = subscription
    shared.value = sharedQuestions
    if (!binding) controllerState.value = 'detached'
    status.value = { ...projection.extensionUi.status }
    toolsExpanded.value = projection.extensionUi.toolsExpanded
    toolsResetRevision.value++
    activeSummary.value = projection.extensionUi.activeInteraction
    activeRequest.value = sameGeneration
      && projection.extensionUi.activeInteraction?.id === previousRequest?.interactionId
      ? previousRequest
      : undefined
    aboveWidgets.value = {}
    belowWidgets.value = {}
    for (const event of projection.extensionUi.events) reduceEvent(event)
    lastSequence.value = cursor.sequence
    return true
  }

  function bindSubscription(
    connection: { connectionId: string; selectionGeneration: number },
    subscription: string,
    cursor: ConversationBootstrap['cursor'],
  ): boolean {
    if (connectionId.value !== connection.connectionId
      || selectionGeneration.value !== connection.selectionGeneration
      || instanceId.value !== cursor.instanceId
      || hostEpoch.value !== cursor.hostEpoch
      || runtimeGeneration.value !== cursor.runtimeGeneration
      || lastSequence.value !== cursor.sequence) return false
    lifecycleRevision++
    acquisitionRevision++
    subscriptionId.value = subscription
    if (!controller.value) controllerState.value = 'detached'
    return true
  }

  async function clear(): Promise<boolean> {
    const revision = ++lifecycleRevision
    acquisitionRevision++
    const handle = controller.value?.handle
    if (handle) {
      suspendController(handle, false)
      if (!await releaseController(handle, 'detached', false)) {
        controllerEnded(handle, 'disconnected', false)
        return false
      }
    }
    if (revision !== lifecycleRevision) return false
    connectionId.value = ''
    selectionGeneration.value = 0
    instanceId.value = ''
    hostEpoch.value = ''
    runtimeGeneration.value = 0
    subscriptionId.value = ''
    lastSequence.value = 0
    status.value = {}
    aboveWidgets.value = {}
    belowWidgets.value = {}
    toolsExpanded.value = false
    toolsResetRevision.value++
    activeSummary.value = undefined
    activeRequest.value = undefined
    controllerState.value = 'detached'
    shared.value = false
    directive.value = undefined
    return true
  }

  function bindingMatches(binding: ExtensionControllerBinding) {
    return binding.connectionId === connectionId.value
      && binding.selectionGeneration === selectionGeneration.value
      && binding.instanceId === instanceId.value
      && binding.hostEpoch === hostEpoch.value
      && binding.runtimeGeneration === runtimeGeneration.value
  }

  // The shared Work observation reducer has already authenticated generation and monotonic order.
  // Keep our own binding/cursor for resume, without a second event validator or
  // an unreachable session.replaced branch (that boundary always bootstraps).
  // `live` is false when cached updates are shown again (F5, switching back): the editor and
  // title text already took effect then and must not overwrite what the person typed since.
  function applyLive(instance: string, subscription: string, event: ProjectedEvent, live = true): boolean {
    if (instance !== instanceId.value || subscription !== subscriptionId.value) return false
    lastSequence.value = event.sequence
    reduceEvent(event)
    if (live && event.eventType === 'extension.title_set' && typeof event.data.title === 'string') {
      directive.value = { id: ++directiveId, title: event.data.title }
    }
    if (live && event.eventType === 'extension.editor_text_set' && typeof event.data.text === 'string') {
      directive.value = { id: ++directiveId, editorText: event.data.text }
    }
    return true
  }

  function reduceEvent(event: ProjectedEvent) {
    const data = event.data
    switch (event.eventType) {
      case 'extension.status_changed': {
        const key = stringValue(data.key)
        if (!key) return
        const next = { ...status.value }
        if (typeof data.text === 'string') next[key] = data.text
        else delete next[key]
        status.value = next
        break
      }
      case 'extension.widget_changed': {
        const key = stringValue(data.key)
        if (!key) return
        const above = { ...aboveWidgets.value }
        const below = { ...belowWidgets.value }
        delete above[key]
        delete below[key]
        if (Array.isArray(data.lines) && data.lines.every((line) => typeof line === 'string')
          && (data.placement === 'aboveEditor' || data.placement === 'belowEditor')) {
          const placement = data.placement
          const widget: ExtensionWidget = { key, lines: [...data.lines], placement }
          if (placement === 'aboveEditor') above[key] = widget
          else below[key] = widget
        }
        aboveWidgets.value = above
        belowWidgets.value = below
        break
      }
      case 'extension.tools_expanded_changed':
        if (typeof data.expanded === 'boolean') {
          toolsExpanded.value = data.expanded
          toolsResetRevision.value++ // Same-value events intentionally reset every per-tool override.
        }
        break
      case 'interaction.requested': {
        // Shared questions only; the operator connection delivers its own copy elsewhere.
        const request = parseRequest(data)
        if (!request) return
        if (activeRequest.value?.interactionId !== request.interactionId) activeRequest.value = request
        activeSummary.value = { id: request.interactionId, method: request.method, expiresAt: request.expiresAt }
        break
      }
      case 'interaction.resolved':
      case 'interaction.cancelled':
        if (data.interactionId === activeSummary.value?.id || data.interactionId === activeRequest.value?.interactionId) {
          activeSummary.value = undefined
          activeRequest.value = undefined
        }
        break
    }
  }

  function beginAcquire(): number {
    lifecycleRevision++
    const revision = ++acquisitionRevision
    controllerState.value = 'acquiring'
    return revision
  }
  function attachController(binding: ExtensionControllerBinding, revision: number) {
    if (revision !== acquisitionRevision || !bindingMatches(binding)) return false
    acquisitionRevision++
    lifecycleRevision++
    controller.value = binding
    controllerState.value = 'attached'
    return true
  }
  function failAcquire(revision: number, state: 'detached' | 'disconnected' = 'disconnected') {
    if (revision !== acquisitionRevision || controller.value) return false
    acquisitionRevision++
    controllerState.value = state
    return true
  }
  function suspendController(handle: string, markLifecycle = true): boolean {
    if (controller.value?.handle !== handle) return false
    if (markLifecycle) lifecycleRevision++
    controllerState.value = 'detached'
    return true
  }

  function controllerEnded(
    handle: string,
    state: 'detached' | 'disconnected' = 'disconnected',
    markLifecycle = true,
  ) {
    if (controller.value?.handle !== handle) return false
    if (markLifecycle) lifecycleRevision++
    controller.value = undefined
    controllerState.value = state
    return true
  }
  async function releaseController(
    handle = controller.value?.handle,
    state: 'detached' | 'disconnected' = 'detached',
    markLifecycle = true,
  ): Promise<boolean> {
    if (!handle) {
      if (!controller.value) controllerState.value = state
      return true
    }
    const binding = controller.value
    if (!binding || binding.handle !== handle) {
      controllerState.value = state
      return true
    }
    try {
      await releaseExtensionControl(handle, binding)
    } catch {
      return false
    }
    controllerEnded(handle, state, markLifecycle)
    return true
  }

  function applyControllerEvent(emission: ExtensionControllerEmission): { title?: string; editorText?: string } | null {
    if (controllerState.value !== 'attached' || !controller.value || emission.handle !== controller.value.handle || !bindingMatches(emission)) return null
    const data = emission.event.data
    if (emission.event.eventType === 'interaction.requested') {
      const request = parseRequest(data)
      if (!request) return null
      activeRequest.value = request
      activeSummary.value = { id: request.interactionId, method: request.method, expiresAt: request.expiresAt }
      return {}
    }
    if (emission.event.eventType === 'extension.title_set' && typeof data.title === 'string') return { title: data.title }
    if (emission.event.eventType === 'extension.editor_text_set' && typeof data.text === 'string') return { editorText: data.text }
    return null
  }

  function hideControllerRequest() { activeRequest.value = undefined }

  function resolveLocally(interactionId: string) {
    if (activeRequest.value?.interactionId === interactionId) activeRequest.value = undefined
    if (activeSummary.value?.id === interactionId) activeSummary.value = undefined
  }

  function applyAuthoritativeSnapshot(work: Work) {
    if (!isCurrent(work)) return
    status.value = { ...work.extensionStatus }
    toolsExpanded.value = work.toolsExpanded
    toolsResetRevision.value++
    activeSummary.value = work.activeInteraction
    if (!work.activeInteraction || work.activeInteraction.id !== activeRequest.value?.interactionId) {
      activeRequest.value = undefined
    }
  }

  return {
    connectionId, selectionGeneration, instanceId, hostEpoch, runtimeGeneration, subscriptionId, lastSequence,
    status, aboveWidgets, belowWidgets, toolsExpanded, toolsResetRevision,
    activeSummary, activeRequest, controller, controllerState, shared, directive,
    hasAttention, isCurrent, bootstrap, bindSubscription, clear, applyLive, beginAcquire,
    attachController, failAcquire, suspendController, controllerEnded, releaseController, applyControllerEvent,
    hideControllerRequest, resolveLocally,
    applyAuthoritativeSnapshot,
  }
})

function stringValue(value: unknown): string { return typeof value === 'string' ? value : '' }

function parseRequest(data: Record<string, unknown>): InteractionRequest | null {
  const method = data.method
  const base = {
    interactionId: stringValue(data.interactionId),
    title: stringValue(data.title),
    issuedAt: stringValue(data.issuedAt),
    expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : undefined,
  }
  if (!base.interactionId || !base.issuedAt) return null
  if (method === 'select' && Array.isArray(data.options) && data.options.every((value) => typeof value === 'string')) return { ...base, method, options: [...data.options] }
  if (method === 'confirm' && typeof data.message === 'string') return { ...base, method, message: data.message }
  if (method === 'input') return { ...base, method, placeholder: typeof data.placeholder === 'string' ? data.placeholder : undefined }
  if (method === 'editor') return { ...base, method, prefill: typeof data.prefill === 'string' ? data.prefill : undefined }
  return null
}
