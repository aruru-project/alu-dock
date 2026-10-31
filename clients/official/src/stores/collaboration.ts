import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { submitText } from '../lib/bridge'
import { requireConnectionContext } from '../lib/hostResult'
import { userErrorMessage } from '../lib/userError'
import { useAppStore } from './app'

/** Collaboration messages are independent text sends, never another Work's editor draft. */
export const useCollaborationStore = defineStore('collaboration', () => {
  const app = useAppStore()
  const drafts = ref<Record<string, { targetId: string; text: string; feedback: string; pending: boolean }>>({})
  const key = computed(() => JSON.stringify([app.connectionContext?.connectionId, app.selectedWorkId]))
  const draft = computed(() => drafts.value[key.value] ??= { targetId: '', text: '', feedback: '', pending: false })
  const parent = computed(() => app.works.find(work => work.id === app.selectedWork?.parentId))
  const children = computed(() => app.works.filter(work => work.parentId === app.selectedWork?.id))
  const peers = computed(() => app.works.filter(work => work.id !== app.selectedWork?.id && work.lifecycle === 'active'))
  async function send() {
    const state = draft.value
    if (state.pending || !state.text.trim()) return
    const target = app.works.find(work => work.id === state.targetId && work.lifecycle === 'active')
    if (!target) { state.feedback = '请选择正在运行的任务。'; return }
    state.pending = true
    state.feedback = ''
    const text = state.text
    try {
      const context = requireConnectionContext(app)
      const result = await submitText(target.id, text, target.executor.piSessionId, app.captureOperationTarget(context, target.id), true)
      if (state.text === text) state.text = ''
      state.feedback = result.receipt.queued ? `已排入 ${target.displayName} 的后续队列。` : `已发送给 ${target.displayName}。`
      if (app.contextMatches(context)) void app.refreshWorksQuietly()
    } catch (cause) {
      state.feedback = userErrorMessage(cause)
      app.failureShown(cause)
    } finally { state.pending = false }
  }
  return { draft, parent, children, peers, send }
})
