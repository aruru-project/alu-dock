import type { ModelInfo, ModelRef } from './types'

/** One row of the Host settings model lists. */
export interface ModelVisibilityRow {
  key: string
  provider: string
  id: string
  name: string
  /** Hidden on this machine, but the machine cannot select it right now (for example its sign-in was removed). */
  unavailable: boolean
}

export function modelKey(model: ModelRef) {
  return `${model.provider}\u0000${model.id}`
}

/** Splits the machine's models into the shown and hidden columns for one draft of the hidden list. */
export function modelVisibilityColumns(models: readonly ModelInfo[], hidden: readonly ModelRef[]) {
  const hiddenKeys = new Set(hidden.map(modelKey))
  const known = new Map(models.map(model => [modelKey(model), model]))
  const row = (model: ModelRef, info?: ModelInfo): ModelVisibilityRow => ({
    key: modelKey(model), provider: model.provider, id: model.id, name: info?.name || model.id, unavailable: !info,
  })
  const shown = models.filter(model => !hiddenKeys.has(modelKey(model))).map(model => row(model, model))
  const hiddenRows = [
    ...models.filter(model => hiddenKeys.has(modelKey(model))).map(model => row(model, model)),
    ...hidden.filter(model => !known.has(modelKey(model))).map(model => row(model)),
  ]
  return { shown, hidden: hiddenRows }
}

/** Same matching as the model picker: provider/id and display name, case-insensitive. */
export function modelRowMatches(row: ModelVisibilityRow, query: string) {
  const needle = query.trim().toLowerCase()
  return !needle || `${row.provider}/${row.id} ${row.name}`.toLowerCase().includes(needle)
}

/** How many models the draft shows or hides differently from what is saved. */
export function modelVisibilityChanges(saved: readonly ModelRef[], draft: readonly ModelRef[]) {
  const before = new Set(saved.map(modelKey))
  const after = new Set(draft.map(modelKey))
  let changes = 0
  for (const key of after) if (!before.has(key)) changes++
  for (const key of before) if (!after.has(key)) changes++
  return changes
}

export function hideModels(draft: readonly ModelRef[], rows: readonly ModelVisibilityRow[]): ModelRef[] {
  const keys = new Set(draft.map(modelKey))
  return [...draft, ...rows.filter(row => !keys.has(row.key)).map(row => ({ provider: row.provider, id: row.id }))]
}

export function showModels(draft: readonly ModelRef[], rows: readonly ModelVisibilityRow[]): ModelRef[] {
  const keys = new Set(rows.map(row => row.key))
  return draft.filter(model => !keys.has(modelKey(model)))
}
