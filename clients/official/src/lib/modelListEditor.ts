import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { modelListChanges } from './modelLists'
import type { ModelInfo, ModelRef } from './types'
import { userErrorMessage } from './userError'

/** What a settings list read returns: the models to choose from, its list, and a broken-file notice. */
export interface ModelListRead {
  models: ModelInfo[]
  total: number
  truncated: boolean
  fileProblem?: string
}

/** The submitted save of this list, kept by the store after the editor closes. */
export interface ModelListSubmission {
  key: string
  state: 'pending' | 'succeeded' | 'failed' | 'unknown'
  message: string
  models: ModelRef[]
}

/**
 * One Host settings list being edited: the Host's current list, the user's unsaved draft,
 * and how both relate to a save submitted earlier. Each open reads the Host again; that
 * read is also what settles a save whose outcome was unknown.
 */
export function useModelListEditor<R extends ModelListRead>(options: {
  submission: () => ModelListSubmission | undefined
  read: () => Promise<R>
  listOf: (result: R) => ModelRef[]
  /** The read with the list a save confirmed; a confirmed save also replaces a broken file. */
  confirmed: (result: R, list: ModelRef[]) => R
  /** The user can see this editor's own success, so it needs no acknowledgement elsewhere. */
  shown: () => boolean
  markSuccessSeen: (key: string) => void
  discardSubmission: (key: string) => void
  loadFailure: string
}) {
  const submission = computed(options.submission)
  const result = ref(null) as Ref<R | null>
  const saved = ref<ModelRef[]>([])
  const draft = ref<ModelRef[]>([])
  const loading = ref(false)
  const loadError = ref('')
  const currentNotice = ref('')
  let loadEpoch = 0

  const saving = computed(() => submission.value?.state === 'pending')
  const changes = computed(() => modelListChanges(saved.value, draft.value))
  const retained = computed(() => !!submission.value && submission.value.state !== 'succeeded'
    && modelListChanges(submission.value.models, draft.value) === 0)
  const dirty = computed(() => !!result.value && !retained.value && (changes.value > 0 || submission.value?.state === 'unknown'))
  const canSave = computed(() => !!result.value && !saving.value && (changes.value > 0 || !!result.value.fileProblem || submission.value?.state === 'unknown'))
  const status = computed(() => {
    const entry = submission.value
    if (saving.value) return entry?.message
    if (dirty.value) return changes.value ? `已改动 ${changes.value} 项，尚未保存` : '已改回上次读取的列表，点保存确认这份设置。'
    if (result.value && (entry?.state === 'failed' || entry?.state === 'unknown')) return `${entry.message} 改动已保留，可以再点保存。`
    return entry?.message ?? currentNotice.value
  })

  watch(() => submission.value?.state, (state) => {
    if (state !== 'succeeded' || !result.value || !submission.value) return
    saved.value = submission.value.models
    draft.value = [...saved.value]
    result.value = options.confirmed(result.value, saved.value)
  })
  // A success rendered in its own editor needs no second acknowledgement outside.
  // Keep its receipt while the editor reads, so an older read cannot undo it.
  watch([submission, () => submission.value?.state, loading, result], () => {
    if (options.shown() && !loading.value && result.value && submission.value?.state === 'succeeded') {
      options.markSuccessSeen(submission.value.key)
    }
  }, { flush: 'post' })
  onScopeDispose(() => { loadEpoch++ })

  async function load() {
    const epoch = ++loadEpoch
    const pendingAtStart = saving.value ? submission.value : undefined
    const unknownAtStart = submission.value?.state === 'unknown' ? submission.value : undefined
    loading.value = true
    loadError.value = ''
    currentNotice.value = ''
    result.value = null
    saved.value = []
    draft.value = []
    try {
      const value = await options.read()
      if (epoch !== loadEpoch) return
      // A save can finish while the read is in flight. Its confirmed response wins
      // over that older read; reopening later still reads current Host settings.
      const completedDuringRead = pendingAtStart && pendingAtStart === submission.value && pendingAtStart.state === 'succeeded'
      const list = completedDuringRead ? pendingAtStart.models : options.listOf(value)
      result.value = completedDuringRead ? options.confirmed(value, list) : value
      saved.value = list
      if (unknownAtStart && unknownAtStart === submission.value && !value.fileProblem
        && modelListChanges(options.listOf(value), unknownAtStart.models) === 0) {
        // This fresh read confirms the desired settings, not the old request's outcome.
        // Retire only that submission's reminder; do not manufacture a success receipt.
        options.discardSubmission(unknownAtStart.key)
        currentNotice.value = '当前设置已与你提交的列表一致。'
      }
      draft.value = [...(submission.value && submission.value.state !== 'succeeded' ? submission.value.models : list)]
    } catch (cause) {
      if (epoch === loadEpoch) loadError.value = userErrorMessage(cause, options.loadFailure)
    } finally {
      if (epoch === loadEpoch) loading.value = false
    }
  }

  function edit(next: ModelRef[]) {
    currentNotice.value = ''
    draft.value = next
    // Explicitly undoing a failed submission retires its retained draft. An unknown
    // save is different: the user can still save this desired list to confirm it.
    if (submission.value?.state === 'failed' && modelListChanges(saved.value, next) === 0) {
      options.discardSubmission(submission.value.key)
    }
  }

  function discard() {
    if (submission.value) options.discardSubmission(submission.value.key)
    edit([...saved.value])
  }

  return { submission, result, saved, draft, loading, loadError, currentNotice, saving, changes, dirty, canSave, status, load, edit, discard }
}
