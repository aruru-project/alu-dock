import { defineStore } from 'pinia'
import { ref } from 'vue'
import { setModelVisibility } from '../lib/bridge'
import type { ConnectionContext, ModelRef } from '../lib/types'
import { userErrorMessage } from '../lib/userError'

interface ModelVisibilitySave {
  key: string
  connectionId: string
  targetHostId?: string
  label: string
  hidden: ModelRef[]
  state: 'pending' | 'succeeded' | 'failed' | 'unknown'
  message: string
  acknowledged: boolean
}

/** Submitted Host settings outlive the editor, but are not Work operations or a notification history. */
export const useModelVisibilityStore = defineStore('model-visibility', () => {
  const saves = ref(new Map<string, ModelVisibilitySave>())
  const keyFor = (connectionId: string, targetHostId?: string) => JSON.stringify([connectionId, targetHostId ?? null])
  function forTarget(connectionId: string, targetHostId?: string) {
    return saves.value.get(keyFor(connectionId, targetHostId))
  }

  async function save(context: ConnectionContext, targetHostId: string | undefined, label: string, hidden: readonly ModelRef[]) {
    const key = keyFor(context.connectionId, targetHostId)
    if (saves.value.get(key)?.state === 'pending') return
    saves.value.set(key, {
      key, connectionId: context.connectionId, targetHostId, label,
      hidden: hidden.map(model => ({ provider: model.provider, id: model.id })),
      state: 'pending', message: '正在保存，关闭设置不会取消保存。', acknowledged: false,
    })
    const submission = saves.value.get(key)!
    try {
      // Capture the destination once. Changing the visible connection cannot turn a
      // successful response for the old machine into a failure for the new one.
      const result = await setModelVisibility(submission.hidden, { ...context }, targetHostId)
      submission.hidden = result.hidden
      submission.state = 'succeeded'
      submission.message = '已保存，下次打开模型选择时生效。'
    } catch (cause) {
      const unknown = !!cause && typeof cause === 'object'
        && (('code' in cause && cause.code === 'effect_unknown') || ('outcomeUnknown' in cause && cause.outcomeUnknown === true))
      submission.state = unknown ? 'unknown' : 'failed'
      submission.message = unknown
        ? '还无法确认是否已保存。改动已保留，可打开 Host 设置查看或再次保存。'
        : `${userErrorMessage(cause, '隐藏列表没有保存成功，请稍后重试。')} 改动已保留，可打开 Host 设置重试。`
    }
  }

  function dismiss(key: string) {
    const entry = saves.value.get(key)
    if (!entry || entry.state === 'pending') return
    if (entry.state === 'succeeded') saves.value.delete(key)
    else entry.acknowledged = true // Keep the submitted draft for reopening the original machine.
  }
  function discard(key: string) {
    if (saves.value.get(key)?.state !== 'pending') saves.value.delete(key)
  }
  return { saves, forTarget, save, dismiss, discard }
})
