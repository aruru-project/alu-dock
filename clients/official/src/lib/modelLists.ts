import type { ModelInfo, ModelRef } from './types'

/** One row of the Host settings model lists. */
export interface ModelListRow {
  key: string
  provider: string
  id: string
  name: string
  /** Listed, but not among the models offered now (for example its sign-in was removed, or it is hidden). */
  unavailable: boolean
}

export function modelKey(model: ModelRef) {
  return `${model.provider}\u0000${model.id}`
}

function row(model: ModelRef, info?: ModelInfo): ModelListRow {
  return { key: modelKey(model), provider: model.provider, id: model.id, name: info?.name || model.id, unavailable: !info }
}

/** Splits the machine's models into the shown and hidden columns for one draft of the hidden list. */
export function modelVisibilityColumns(models: readonly ModelInfo[], hidden: readonly ModelRef[]) {
  const hiddenKeys = new Set(hidden.map(modelKey))
  const known = new Map(models.map(model => [modelKey(model), model]))
  const shown = models.filter(model => !hiddenKeys.has(modelKey(model))).map(model => row(model, model))
  const hiddenRows = [
    ...models.filter(model => hiddenKeys.has(modelKey(model))).map(model => row(model, model)),
    ...hidden.filter(model => !known.has(modelKey(model))).map(model => row(model)),
  ]
  return { shown, hidden: hiddenRows }
}

/** Main's models still to choose from, and one draft of the child Work list in its own order. */
export function childModelColumns(models: readonly ModelInfo[], listed: readonly ModelRef[]) {
  const listedKeys = new Set(listed.map(modelKey))
  const known = new Map(models.map(model => [modelKey(model), model]))
  return {
    available: models.filter(model => !listedKeys.has(modelKey(model))).map(model => row(model, model)),
    listed: listed.map(model => row(model, known.get(modelKey(model)))),
  }
}

/** Same matching as the model picker: provider/id and display name, case-insensitive. */
export function modelRowMatches(row: ModelListRow, query: string) {
  const needle = query.trim().toLowerCase()
  return !needle || `${row.provider}/${row.id} ${row.name}`.toLowerCase().includes(needle)
}

/** How many models the draft lists differently from what is saved. */
export function modelListChanges(saved: readonly ModelRef[], draft: readonly ModelRef[]) {
  const before = new Set(saved.map(modelKey))
  const after = new Set(draft.map(modelKey))
  let changes = 0
  for (const key of after) if (!before.has(key)) changes++
  for (const key of before) if (!after.has(key)) changes++
  return changes
}

/** For a list whose order is kept: a list with the same models in another order is one change. */
export function orderedListChanges(saved: readonly ModelRef[], draft: readonly ModelRef[]) {
  const changes = modelListChanges(saved, draft)
  if (changes > 0) return changes
  return saved.some((model, index) => modelKey(model) !== modelKey(draft[index]!)) ? 1 : 0
}

export function addModels(draft: readonly ModelRef[], rows: readonly ModelListRow[]): ModelRef[] {
  const keys = new Set(draft.map(modelKey))
  return [...draft, ...rows.filter(row => !keys.has(row.key)).map(row => ({ provider: row.provider, id: row.id }))]
}

export function removeModels(draft: readonly ModelRef[], rows: readonly ModelListRow[]): ModelRef[] {
  const keys = new Set(rows.map(row => row.key))
  return draft.filter(model => !keys.has(modelKey(model)))
}
