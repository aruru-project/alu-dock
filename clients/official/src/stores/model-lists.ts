import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { setChildModels, setHostSystemDefault, setModelVisibility } from '../lib/bridge'
import type { ConnectionContext, HostSystemRef, ModelRef } from '../lib/types'
import { userErrorMessage } from '../lib/userError'
import { useModelCatalogStore } from './model-catalog'

/** Which of Main's lists a save replaces: the hidden models, or the child Work models. */
export type ModelListKind = 'hidden' | 'children'

interface HostSettingSave {
  connectionId: string
  label: string
  key: string
  state: 'pending' | 'succeeded' | 'failed' | 'unknown'
  message: string
  acknowledged: boolean
}

type ModelListSave = HostSettingSave & { list: ModelListKind; models: ModelRef[] }
type SystemSave = HostSettingSave & { list: 'system'; targetHostId?: string; selection: HostSystemRef | null }
type SettingSave = ModelListSave | SystemSave

const outcomes: Record<SettingSave['list'], { saved: string; failed: string }> = {
  system: { saved: '已保存，只对之后新建的 Work 生效。', failed: '默认 system 没有保存成功，请稍后重试。' },
  hidden: { saved: '已保存，下次打开模型选择时生效。', failed: '隐藏列表没有保存成功，请稍后重试。' },
  children: { saved: '已保存，Agent 下次查找模型时生效。', failed: '子 Work 模型名单没有保存成功，请稍后重试。' },
}

/** Submitted Host settings outlive the editor, but are not Work operations or a notification history. */
export const useModelListsStore = defineStore('model-lists', () => {
  const catalog = useModelCatalogStore()
  const saves = ref(new Map<string, SettingSave>())
  /** Confirmed hidden-list saves per connection; Main's other lists offer models by that list. */
  const hiddenSaved = ref(new Map<string, number>())
  const keyFor = (connectionId: string, list: ModelListKind) => JSON.stringify([connectionId, list])
  function forHidden(connectionId: string) {
    const save = saves.value.get(keyFor(connectionId, 'hidden')); return save?.list === 'hidden' ? save : undefined
  }
  function forChildren(connectionId: string) {
    const save = saves.value.get(keyFor(connectionId, 'children')); return save?.list === 'children' ? save : undefined
  }
  const systemKey = (connectionId: string, targetHostId?: string) => JSON.stringify([connectionId, 'system', targetHostId ?? null])
  function forSystem(connectionId: string, targetHostId?: string) {
    const save = saves.value.get(systemKey(connectionId, targetHostId)); return save?.list === 'system' ? save : undefined
  }
  function saveSystem(context: ConnectionContext, targetHostId: string | undefined, label: string, selection: HostSystemRef | null) {
    return runSave({ key: systemKey(context.connectionId, targetHostId), connectionId: context.connectionId, label, list: 'system', targetHostId, selection },
      async save => { save.selection = (await setHostSystemDefault(selection, context, targetHostId)).selection })
  }

  /** Both lists exist only on Main (card #303), so the connected Host saves them. */
  function saveHidden(context: ConnectionContext, label: string, hidden: readonly ModelRef[]) {
    // Capture the destination once. Changing the visible connection cannot turn a
    // successful response for the old Dock into a failure for the new one.
    const destination = { ...context }
    return submit({ key: keyFor(context.connectionId, 'hidden'), list: 'hidden', connectionId: context.connectionId, label }, hidden, async (models) => {
      const result = await setModelVisibility(models, destination)
      catalog.applyHidden(context.connectionId, result.hidden)
      hiddenSaved.value.set(context.connectionId, (hiddenSaved.value.get(context.connectionId) ?? 0) + 1)
      return result.hidden
    })
  }

  function saveChildren(context: ConnectionContext, label: string, models: readonly ModelRef[]) {
    const destination = { ...context }
    return submit({ key: keyFor(context.connectionId, 'children'), list: 'children', connectionId: context.connectionId, label }, models,
      async (list) => (await setChildModels(list, destination)).listed)
  }

  async function submit(
    identity: Pick<ModelListSave, 'key' | 'list' | 'connectionId' | 'label'>,
    models: readonly ModelRef[],
    run: (models: ModelRef[]) => Promise<ModelRef[]>,
  ) {
    return runSave({ ...identity, models: models.map(model => ({ ...model })) }, async save => { save.models = await run(save.models) })
  }

  async function runSave<T extends Omit<SystemSave, 'state' | 'message' | 'acknowledged'> | Omit<ModelListSave, 'state' | 'message' | 'acknowledged'>>(
    identity: T, run: (submission: T) => Promise<void>,
  ) {
    if (saves.value.get(identity.key)?.state === 'pending') return
    const submission = reactive({ ...identity, state: 'pending', message: '正在保存，关闭设置不会取消保存。', acknowledged: false }) as T & HostSettingSave
    saves.value.set(identity.key, submission)
    try {
      await run(submission)
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
    else entry.acknowledged = true // Keep the submitted draft for reopening the list.
  }
  function discard(key: string) {
    if (saves.value.get(key)?.state !== 'pending') saves.value.delete(key)
  }
  return { saves, hiddenSaved, forHidden, forChildren, forSystem, saveSystem, saveHidden, saveChildren, markSuccessSeen, dismiss, discard }
})
