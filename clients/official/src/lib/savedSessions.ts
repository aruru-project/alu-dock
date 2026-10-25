import { ref } from 'vue'
import type { SavedSession, SavedSessionPage } from './types'
import { userErrorMessage } from './userError'

/** The name when there is one; otherwise the first user message identifies the Session. */
export function savedSessionTitle(session: SavedSession): string {
  return session.name || session.firstUserMessage || '未命名 Session'
}

export function savedSessionSearchText(session: SavedSession): string {
  return `${session.name ?? ''} ${session.firstUserMessage ?? ''} ${session.cwd}`.toLocaleLowerCase()
}

/** Compact local time: the year is shown only when it is not the current one. */
export function savedSessionTime(value: string | null | undefined, now = new Date()): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getFullYear()}年${day}`
}

/** A locating aid, not billing: `-$` means the Session recorded no cost. */
export function savedSessionCost(cost: number | null | undefined): string {
  if (cost == null) return '-$'
  if (cost > 0 && cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

export type SavedSessionPageReader = (cursor?: string) => Promise<SavedSessionPage>

/**
 * Shows the first page as soon as it arrives, then keeps reading the rest so
 * the list (and its search) eventually covers every saved Session.
 */
export function useSavedSessionPages() {
  const sessions = ref<SavedSession[]>([])
  const total = ref(0)
  const incomplete = ref(false)
  const loaded = ref(false)
  const loading = ref(false)
  const loadingMore = ref(false)
  const moreFailed = ref('')
  let epoch = 0
  let reader: SavedSessionPageReader | undefined
  let nextCursor: string | undefined

  function reset() {
    epoch++
    reader = undefined
    nextCursor = undefined
    sessions.value = []
    total.value = 0
    incomplete.value = false
    loaded.value = false
    loading.value = false
    loadingMore.value = false
    moreFailed.value = ''
  }

  function accept(page: SavedSessionPage) {
    sessions.value = loaded.value ? [...sessions.value, ...page.sessions] : page.sessions
    total.value = page.total
    incomplete.value ||= page.incomplete
    nextCursor = page.nextCursor
    loaded.value = true
  }

  /** A failed first page is thrown to the caller; later pages report through `moreFailed`. */
  async function load(read: SavedSessionPageReader): Promise<boolean> {
    reset()
    const current = epoch
    reader = read
    loading.value = true
    try {
      const page = await read()
      if (current !== epoch) return false
      accept(page)
    } finally {
      if (current === epoch) loading.value = false
    }
    void readRest(current)
    return true
  }

  async function readRest(current: number) {
    while (current === epoch && reader && nextCursor) {
      loadingMore.value = true
      moreFailed.value = ''
      try {
        const page = await reader(nextCursor)
        if (current !== epoch) return
        accept(page)
      } catch (cause) {
        if (current === epoch) moreFailed.value = userErrorMessage(cause)
        return
      } finally {
        if (current === epoch) loadingMore.value = false
      }
    }
  }

  function retryMore() {
    if (!loadingMore.value && nextCursor) void readRest(epoch)
  }

  return { sessions, total, incomplete, loaded, loading, loadingMore, moreFailed, load, reset, retryMore }
}
