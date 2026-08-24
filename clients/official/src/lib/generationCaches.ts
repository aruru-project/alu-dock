import type { ControlSection } from './localCommands'
import type { HostContext, Work } from './types'

export type GenerationCache = 'commands' | 'resources' | 'tools' | 'settings'
export type GenerationCacheState = 'idle' | 'loading' | 'ready' | 'error'
export type GenerationCacheStates = Record<GenerationCache, GenerationCacheState>

export function commandCatalogGenerationKey(work: Work, context: HostContext): string {
  return `${context.hostId}:${context.selectionGeneration}:${work.id}:${work.hostId ?? ''}:${work.ownerHostEpoch ?? ''}:${work.runtimeGeneration}`
}

export function pendingGenerationCaches(): GenerationCacheStates {
  return { commands: 'loading', resources: 'loading', tools: 'loading', settings: 'loading' }
}

export function generationSectionState(section: ControlSection, caches: GenerationCacheStates): GenerationCacheState {
  const required: GenerationCache[] = section === 'commands'
    ? ['commands']
    : section === 'resources'
      ? ['resources', 'tools']
      : section === 'tools'
        ? ['tools']
        : section === 'settings'
          ? ['settings']
          : []
  if (required.some((key) => caches[key] === 'idle' || caches[key] === 'loading')) return 'loading'
  if (required.some((key) => caches[key] === 'error')) return 'error'
  return 'ready'
}
