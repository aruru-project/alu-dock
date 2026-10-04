import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getModelVisibility } from '../lib/bridge'
import type { ConnectionContext, ModelRef, ModelVisibilityResult } from '../lib/types'

export interface MachineModelCatalog {
  state: 'loading' | 'ready' | 'unsupported' | 'failed'
  /** The last answer this Machine gave; kept while a refresh is in flight or fails. */
  result?: ModelVisibilityResult
  error?: unknown
}

/**
 * The models each Machine offers for a new Work, with that Machine's hidden list. Reading
 * them starts a Pi on the Machine, so the answer is kept for the app's lifetime and has no
 * expiry: the user refreshes after changing models or sign-ins there. The new-Work model
 * choice reads the cache; the hidden-model settings page always reads fresh and updates it.
 */
export const useModelCatalogStore = defineStore('model-catalog', () => {
  const catalogs = ref(new Map<string, MachineModelCatalog>())
  const inFlight = new Map<string, Promise<ModelVisibilityResult>>()
  const keyFor = (connectionId: string, targetHostId?: string) => JSON.stringify([connectionId, targetHostId ?? null])

  function forTarget(connectionId: string, targetHostId?: string) {
    return catalogs.value.get(keyFor(connectionId, targetHostId))
  }

  /** The cached answer, or one read; `fresh` always asks the Machine again and replaces the cache for every reader. */
  function read(context: ConnectionContext, targetHostId: string | undefined, fresh = false): Promise<ModelVisibilityResult> {
    const key = keyFor(context.connectionId, targetHostId)
    const existing = catalogs.value.get(key)
    if (!fresh && existing?.result) return Promise.resolve(existing.result)
    const pending = inFlight.get(key)
    if (pending) return pending
    catalogs.value.set(key, { state: 'loading', result: existing?.result })
    const request = getModelVisibility(context, targetHostId).then((result) => {
      catalogs.value.set(key, { state: 'ready', result })
      return result
    }, (cause: unknown) => {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : ''
      catalogs.value.set(key, { state: code === 'capability_missing' ? 'unsupported' : 'failed', result: existing?.result, error: cause })
      throw cause
    }).finally(() => { inFlight.delete(key) })
    inFlight.set(key, request)
    return request
  }

  /** A confirmed hidden-list save is the Machine's current setting; the cached list follows it. */
  function applyHidden(connectionId: string, targetHostId: string | undefined, hidden: ModelRef[]) {
    const key = keyFor(connectionId, targetHostId)
    const entry = catalogs.value.get(key)
    if (entry?.result) catalogs.value.set(key, { ...entry, result: { ...entry.result, hidden, fileProblem: undefined } })
  }

  return { catalogs, forTarget, read, applyHidden }
})
