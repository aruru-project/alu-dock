import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { commandCatalog } from '../lib/bridge'
import type { CommandsResult, ConnectionContext, Work } from '../lib/types'
import { commandCatalogGenerationKey } from '../lib/generationCaches'

export type CommandCatalogState = 'idle' | 'loading' | 'ready' | 'truncated' | 'failed'

/**
 * 当前 Work 的 Pi 命令目录（Extension/Skill/Prompt），供命令面板与输入框建议共用。
 * 按 host + selection + work + runtime 世代作缓存键；资源重载或 Work 切换后由调用方触发重新 ensure。
 */
export const useCommandCatalogStore = defineStore('command-catalog', () => {
  const key = ref('')
  const result = ref<CommandsResult | null>(null)
  const state = ref<CommandCatalogState>('idle')
  let epoch = 0

  const commands = computed(() => result.value?.commands ?? [])

  async function ensure(work: Work, context: ConnectionContext, force = false): Promise<boolean> {
    const nextKey = commandCatalogGenerationKey(work, context)
    if (!force && key.value === nextKey && state.value !== 'idle' && state.value !== 'failed') return true
    const current = ++epoch
    if (key.value !== nextKey) result.value = null
    key.value = nextKey
    state.value = 'loading'
    try {
      const loaded = await commandCatalog(work.id, context)
      if (current !== epoch || key.value !== nextKey) return false
      result.value = loaded
      state.value = loaded.truncated ? 'truncated' : 'ready'
      return true
    } catch {
      if (current === epoch && key.value === nextKey) {
        result.value = { commands: [], total: 0, truncated: false }
        state.value = 'failed'
      }
      return false
    }
  }

  function invalidate() {
    epoch += 1
    key.value = ''
    state.value = 'idle'
  }

  return { key, result, state, commands, ensure, invalidate }
})
