import assert from 'node:assert/strict'
import { commandCatalogGenerationKey, generationSectionState, pendingGenerationCaches } from '../src/lib/generationCaches.ts'
import type { Work } from '../src/lib/types.ts'

const pending = pendingGenerationCaches()
assert.equal(generationSectionState('commands', pending), 'loading')
assert.equal(generationSectionState('resources', { ...pending, resources: 'ready' }), 'loading', 'resource.get alone is not enough before tool.list is restored')
assert.equal(generationSectionState('resources', { ...pending, resources: 'ready', tools: 'error' }), 'error', 'a failed refresh must not render local empty arrays as authoritative')
assert.equal(generationSectionState('resources', { ...pending, resources: 'ready', tools: 'ready' }), 'ready')
assert.equal(generationSectionState('settings', { ...pending, settings: 'ready' }), 'ready')

const context = { hostId: 'main-host', selectionGeneration: 4 }
const work = { id: 'work-a', hostId: 'subhost-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 1 } as Work
const oldKey = commandCatalogGenerationKey(work, context)
assert.notEqual(commandCatalogGenerationKey({ ...work, runtimeGeneration: 2 }, context), oldKey)
assert.notEqual(commandCatalogGenerationKey({ ...work, hostId: 'subhost-b' }, context), oldKey)
assert.notEqual(commandCatalogGenerationKey({ ...work, ownerHostEpoch: 'epoch-b' }, context), oldKey)
assert.notEqual(commandCatalogGenerationKey({ ...work, id: 'work-b' }, context), oldKey)
assert.notEqual(commandCatalogGenerationKey(work, { ...context, selectionGeneration: 5 }), oldKey)

console.log('generation cache tests passed')
