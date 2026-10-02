import { defineStore } from 'pinia'
import { computed, markRaw, onScopeDispose, reactive, watch } from 'vue'
import { createTurnSpeedMeter, turnsHandedOff, type TurnSpeedChange } from '../lib/turnSpeed'
import type { Work } from '../lib/types'
import { useAppStore } from './app'
import { useConversationStore } from './conversation'
import { useObservationStore, type AppliedEvent } from './observation'

/** Output speed of the turns this client watched, for reference only. It sits
 * beside the conversation: it reads followed events and the displayed turn ids,
 * and nothing else waits on it. Values live as long as this page; a turn that was
 * not watched from its start, or whose events were skipped, shows none. */
export const useTurnSpeedStore = defineStore('turn-speed', () => {
  const app = useAppStore()
  const observation = useObservationStore()
  const conversation = useConversationStore()
  type Scope = { meter: ReturnType<typeof createTurnSpeedMeter>; speeds: Map<string, number>; handedOff: Map<string, string> }
  const scopes = reactive(new Map<string, Scope>())

  // One Session in one Worker run of one Work: live turn ids restart with it.
  const scopeKey = (connectionId: string, hostEpoch: string, instance: Work) =>
    JSON.stringify([connectionId, hostEpoch, instance.id, instance.runtimeGeneration, instance.executor.piSessionId ?? ''])

  function scope(key: string): Scope {
    let current = scopes.get(key)
    if (!current) {
      scopes.set(key, { meter: markRaw(createTurnSpeedMeter()), speeds: new Map(), handedOff: markRaw(new Map()) })
      current = scopes.get(key)!
    }
    return current
  }

  function record(target: Scope, change: TurnSpeedChange) {
    const turnId = target.handedOff.get(change.turnId) ?? change.turnId
    if (change.tokensPerSecond === undefined) target.speeds.delete(turnId)
    else target.speeds.set(turnId, change.tokensPerSecond)
  }

  let followed: Scope | undefined
  const stopListening = observation.onEventApplied((applied: AppliedEvent) => {
    try {
      const target = scope(scopeKey(applied.connectionId, applied.hostEpoch, applied.instance))
      followed = target
      const change = target.meter.apply(applied.event, applied.previousSequence, applied.instance.metrics?.tokens?.output)
      if (change) record(target, change)
    } catch (cause) {
      console.error('Turn speed could not be measured.', cause)
    }
  })

  // Switching away, pausing or refreshing ends this follow; a running turn would
  // go on unseen, so its partial value is withdrawn now rather than at a later event.
  watch(() => observation.active?.subscriptionId, () => {
    const target = followed
    followed = undefined
    const change = target?.meter.interrupt()
    if (target && change) record(target, change)
  }, { flush: 'sync' })

  const shownKey = computed(() => {
    const state = conversation.conversationState
    const connectionId = app.activeConnectionId
    return state && connectionId ? scopeKey(connectionId, state.cursor.hostEpoch, state.instance) : ''
  })
  const shownTurnIds = computed(() => conversation.conversation.flatMap((item) => item.kind === 'turn' ? [item.turnId] : []))
  // When history takes over a finished live turn, its value follows to the new id.
  watch([shownKey, shownTurnIds], ([key, after], [previousKey, before]) => {
    if (!key || key !== previousKey) return
    const target = scopes.get(key)
    if (!target) return
    for (const [live, history] of turnsHandedOff(before, after)) {
      target.handedOff.set(live, history)
      const value = target.speeds.get(live)
      if (value === undefined) continue
      target.speeds.delete(live)
      target.speeds.set(history, value)
    }
  })

  function speedOf(turnId: string): number | undefined {
    return shownKey.value ? scopes.get(shownKey.value)?.speeds.get(turnId) : undefined
  }

  onScopeDispose(stopListening)
  return { speedOf }
})
