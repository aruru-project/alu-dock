import { reactive } from 'vue'
import { userErrorMessage } from './userError'

/**
 * Reading the next page of a list that is read again from its start now and then (a refresh, a
 * new search). When the list starts over, a page still on its way is dropped and the 「更多」
 * button reads again at once.
 */
export function useNextPage(failure: string) {
  const state = reactive({ loading: false, error: '' })
  let round = 0

  /** The list is being read from its start again. */
  function startOver() {
    round++
    state.loading = false
    state.error = ''
  }

  /** `join` adds the page to the list, unless the list started over meanwhile. */
  async function read<T>(load: () => Promise<T>, join: (page: T) => void) {
    if (state.loading) return
    const current = round
    state.loading = true
    state.error = ''
    try {
      const page = await load()
      if (current === round) join(page)
    } catch (cause) {
      if (current === round) state.error = userErrorMessage(cause, failure)
    } finally {
      if (current === round) state.loading = false
    }
  }

  return { state, startOver, read }
}
