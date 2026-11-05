import { defineStore } from 'pinia'
import { ref } from 'vue'
import { setChildModels, setModelVisibility } from '../lib/bridge'
import type { ConnectionContext, ModelRef } from '../lib/types'
import { userErrorMessage } from '../lib/userError'
import { useModelCatalogStore } from './model-catalog'

/** Which Host settings list a save replaces: one machine's hidden list, or Main's child Work list. */
export type ModelListKind = 'hidden' | 'children'

export interface ModelListSave {
  key: string
  list: ModelListKind
  connectionId: string
  /** The machine whose hidden list this is; the child Work list has none. */
  targetHostId?: string
  label: string
  models: ModelRef[]
  state: 'pending' | 'succeeded' | 'failed' | 'unknown'
  message: string
  acknowledged: boolean
}

const outcomes: Record<ModelListKind, { saved: string; failed: string }> = {
  hidden: { saved: '已保存，下次打开模型选择时生效。', failed: '隐藏列表没有保存成功，请稍后重试。' },
  children: { saved: '已保存，Agent 下次查找模型时生效。', failed: '子 Work 模型名单没有保存成功，请稍后重试。' },
}

/** Submitted Host settings outlive the editor, but are not Work operations or a notification history. */
export const useModelListsStore = defineStore('model-lists', () => {
  const catalog = useModelCatalogStore()
  const saves = ref(new Map<string, ModelListSave>())
  const hiddenKey = (connectionId: string, targetHostId?: string) => JSON.stringify([connectionId, targetHostId ?? null])
  const childrenKey = (connectionId: string) => JSON.stringify([connectionId, null, 'children'])
  function forTarget(connectionId: string, targetHostId?: string) {
    return saves.value.get(hiddenKey(connectionId, targetHostId))
  }
  function forChildren(connectionId: string) {
    return saves.value.get(childrenKey(connectionId))
  }

  function save(context: ConnectionContext, targetHostId: string | undefined, label: string, hidden: readonly ModelRef[]) {
    // Capture the destination once. Changing the visible connection cannot turn a
    // successful response for the old machine into a failure for the new one.
    const destination = { ...context }
    return submit({ key: hiddenKey(context.connectionId, targetHostId), list: 'hidden', connectionId: context.connectionId, targetHostId, label }, hidden, async (models) => {
      const result = await setModelVisibility(models, destination, targetHostId)
      catalog.applyHidden(context.connectionId, targetHostId, result.hidden)
      return result.hidden
    })
  }

  /** The child Work list exists only on Main; the connected Host saves it. */
  function saveChildren(context: ConnectionContext, label: string, models: readonly ModelRef[]) {
    const destination = { ...context }
    return submit({ key: childrenKey(context.connectionId), list: 'children', connectionId: context.connectionId, label }, models,
      async (list) => (await setChildModels(list, destination)).listed)
  }

  async function submit(
    identity: Pick<ModelListSave, 'key' | 'list' | 'connectionId' | 'targetHostId' | 'label'>,
    models: readonly ModelRef[],
    run: (models: ModelRef[]) => Promise<ModelRef[]>,
  ) {
    if (saves.value.get(identity.key)?.state === 'pending') return
    saves.value.set(identity.key, {
      ...identity,
      models: models.map(model => ({ provider: model.provider, id: model.id })),
      state: 'pending', message: '正在保存，关闭设置不会取消保存。', acknowledged: false,
    })
    const submission = saves.value.get(identity.key)!
    try {
      submission.models = await run(submission.models)
      submission.state = 'succeeded'
      submission.message = outcomes[identity.list].saved
    } catch (cause) {
      const unknown = !!cause && typeof cause === 'object'
        && (('code' in cause && cause.code === 'effect_unknown') || ('outcomeUnknown' in cause && cause.outcomeUnknown === true))
      submission.state = unknown ? 'unknown' : 'failed'
      submission.message = unknown
        ? '连接中断，没收到保存结果。'
        : userErrorMessage(cause, outcomes[identity.list].failed)
    }
  }

  function markSuccessSeen(key: string) {
    const entry = saves.value.get(key)
    if (entry?.state === 'succeeded') entry.acknowledged = true
  }

  function dismiss(key: string) {
    const entry = saves.value.get(key)
    if (!entry || entry.state === 'pending') return
    if (entry.state === 'succeeded') saves.value.delete(key)
    else entry.acknowledged = true // Keep the submitted draft for reopening the original list.
  }
  function discard(key: string) {
    if (saves.value.get(key)?.state !== 'pending') saves.value.delete(key)
  }
  return { saves, forTarget, forChildren, save, saveChildren, markSuccessSeen, dismiss, discard }
})
