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

interface Flight {
  request: Promise<ModelVisibilityResult>
  /** A hidden list saved while this read was in flight is newer than what the read returns. */
  savedHidden?: ModelRef[]
}

/**
 * The models each Machine offers for a new Work, with that Machine's hidden list. Reading
 * them starts a Pi on the Machine, so the answer is kept for the app's lifetime and has no
 * expiry: the user refreshes after changing models or sign-ins there. The new-Work model
 * choice reads the cache; the hidden-model settings page always reads fresh and updates it.
 */
export const useModelCatalogStore = defineStore('model-catalog', () => {
  const catalogs = ref(new Map<string, MachineModelCatalog>())
  const flights = new Map<string, Flight>()
  const keyFor = (connectionId: string, targetHostId?: string) => JSON.stringify([connectionId, targetHostId ?? null])

  function forTarget(connectionId: string, targetHostId?: string) {
    return catalogs.value.get(keyFor(connectionId, targetHostId))
  }

  /** The cached answer, or one read; `fresh` always asks the Machine again and replaces the cache for every reader. */
  function read(context: ConnectionContext, targetHostId: string | undefined, fresh = false): Promise<ModelVisibilityResult> {
    const key = keyFor(context.connectionId, targetHostId)
    const current = catalogs.value.get(key)
    if (!fresh && current?.result) return Promise.resolve(current.result)
    const pending = flights.get(key)
    if (pending) return pending.request
    const flight: Flight = { request: undefined as unknown as Promise<ModelVisibilityResult> }
    catalogs.value.set(key, { state: 'loading', result: current?.result })
    flight.request = getModelVisibility(context, targetHostId).then((answer) => {
      // A save confirmed during this read is the Machine's newer hidden list; the models still come from the read.
      const result = flight.savedHidden ? { ...answer, hidden: flight.savedHidden, fileProblem: undefined } : answer
      catalogs.value.set(key, { state: 'ready', result })
      return result
    }, (cause: unknown) => {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : ''
      // Keep what the cache holds now (including saves applied meanwhile), not a snapshot from before the read.
      catalogs.value.set(key, { state: code === 'capability_missing' ? 'unsupported' : 'failed', result: catalogs.value.get(key)?.result, error: cause })
      throw cause
    }).finally(() => { flights.delete(key) })
    flights.set(key, flight)
    return flight.request
  }

  /** A confirmed hidden-list save is the Machine's current setting; the cached list follows it, and so does a read still in flight. */
  function applyHidden(connectionId: string, targetHostId: string | undefined, hidden: ModelRef[]) {
    const key = keyFor(connectionId, targetHostId)
    const flight = flights.get(key)
    if (flight) flight.savedHidden = hidden
    const entry = catalogs.value.get(key)
    if (entry?.result) catalogs.value.set(key, { ...entry, result: { ...entry.result, hidden, fileProblem: undefined } })
  }

  return { catalogs, forTarget, read, applyHidden }
})
