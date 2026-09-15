// Execute the actual App entrypoints (not reimplementations) with held native
// boundaries. This is a handler/control-flow regression, not a native IME probe.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { computed, ref, nextTick, reactive, watch } from 'vue'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { createConversationRecovery } from '../src/lib/conversationRecovery.ts'
import { submittedLocalControl } from '../src/lib/localCommands.ts'
import { captureConnectionResult, hostResultMatches } from '../src/lib/hostResult.ts'

const source = (await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')).split('<script setup lang="ts">')[1].split('</script>')[0]
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
function bindApp(names, scope) {
  const statements = ast.statements.filter(node => names.includes(node.name?.text)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.text))))
  assert.equal(statements.length, names.length, 'Every tested entrypoint must exist in the actual App')
  const code = ts.transpileModule(statements.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function('scope', `with(scope) { ${code}; return {${names.join(',')}} }`)(scope)
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const work = { id: 'A', lifecycle: 'active', runtimeGeneration: 1, ownerHostEpoch: 'epoch', executor: { piSessionId: 'session' } }
const calls = []
const scope = { computed, nextTick, selected: ref(work), draft: ref('continue'), draftAttachments: ref([]), maxMessageAttachments: ref(10), restoredImageCount: ref(0), isTauri: true,
  conversationLoading: ref(true), followConnected: ref(false), composerExpanded: ref(true), composerExpansionRevision: 1, submitViewRevision: 1, submitAttemptSequence: 0,
  submitAttempts: ref(new Map()), restoredImageCounts: ref({}), restoredImageRevisions: new Map(), submittedLocalControl,
  app: { connectionContext: { connectionId: 'host', selectionGeneration: 1 }, captureSubmitDraft() {} },
  attachmentUploadTarget() {}, requireConnectionContext: app => app.connectionContext, submitScopeKey: () => 'scope', restoredImageKey: () => 'image',
  submitMessage: async () => { calls.push('submit_message'); throw { outcomeUnknown: false } },
  executeLocalControl: async command => { calls.push(command.action ?? command.section); return true },
  composer: { composing: ref(false) }, modalOpen: ref(true), confirmDialog: ref(null), closeModal: () => { scope.composerExpanded.value = false },
}
for (const name of ['workMutating', 'pairingInProgress', 'clearingRestoredImages', 'submitBlocked', 'mutationOutcomeUnknown', 'queueRestoring', 'attachmentPicking', 'suggestOpen']) scope[name] = ref(false)
scope.uploadDrafts = ref([]); scope.submissionError = ref(null)
const handlers = bindApp(['canSubmit', 'submit', 'submitExpanded', 'handleComposerKeydown', 'handleGlobalModalKeydown', 'handleModalKeydown'], scope)
const event = (key, isComposing = false) => ({ key, isComposing, prevented: false, stopped: false, currentTarget: { selectionStart: 2, selectionEnd: 4 }, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } })
handlers.handleComposerKeydown(event('Enter'))
await handlers.submitExpanded()
await handlers.submit()
await tick()
assert.equal(handlers.canSubmit.value, false)
assert.deepEqual(calls, [], 'Enter, form submit and expanded submit cannot reach native send during recovery')
assert.equal(scope.draft.value, 'continue', 'recovery does not consume the editable draft')
const composingEscape = event('Escape', true)
handlers.handleGlobalModalKeydown(composingEscape) // window capture happens first
if (!composingEscape.stopped) handlers.handleComposerKeydown(composingEscape, true)
if (!composingEscape.stopped) handlers.handleModalKeydown(composingEscape) // real expanded overlay bubble listener
assert.equal(scope.composerExpanded.value, true)
assert.equal(composingEscape.prevented, false)
assert.deepEqual([composingEscape.currentTarget.selectionStart, composingEscape.currentTarget.selectionEnd], [2, 4])
scope.composer.composing.value = true
const ownerEscape = event('Escape')
handlers.handleGlobalModalKeydown(ownerEscape)
if (!ownerEscape.stopped) handlers.handleComposerKeydown(ownerEscape, true)
if (!ownerEscape.stopped) handlers.handleModalKeydown(ownerEscape)
assert.equal(scope.composerExpanded.value, true, 'owner composition covers WebViews that omit the event flag')
scope.composer.composing.value = false
handlers.handleGlobalModalKeydown(event('Escape'))
assert.equal(scope.composerExpanded.value, false, 'ordinary Escape still closes the modal')
scope.conversationLoading.value = false; scope.followConnected.value = true
assert.equal(handlers.canSubmit.value, true)
await handlers.submit()
assert.deepEqual(calls, ['submit_message'], 'native send remains available after recovery')
scope.followConnected.value = false; scope.draft.value = '/stop'
await handlers.submit()
assert.deepEqual(calls, ['submit_message', 'stop'], 'local/Stop dispatch remains before remote admission')

scope.app = reactive({ ...scope.app, activeConnectionId: 'host-b' })
scope.unresolvedMutations = ref(new Map([[JSON.stringify(['host-a', 'A', 'sessions']), 'original-operation']]))
const mutationGate = bindApp(['unresolvedDomain'], scope)
assert.equal(mutationGate.unresolvedDomain.value, null, 'unknown from another Host never gates this Host')
scope.app.activeConnectionId = 'host-a'; scope.selected.value = { ...work, id: 'B' }
assert.equal(mutationGate.unresolvedDomain.value, null, 'old Work A unknown does not gate Work B')
scope.selected.value = work
assert.equal(mutationGate.unresolvedDomain.value, 'sessions', 'returning to A still requires explicit reconciliation')

function recoveryFixture(realDetach = false) {
  const starts = [], loads = [], handshakes = []
  const context = { connectionId: 'host', selectionGeneration: 1 }
  const state = { instance: work, cursor: { instanceId: 'A', hostEpoch: 'epoch', runtimeGeneration: 1, sequence: 3 } }
  const s = { selected: ref(work), app: { connectionContext: context, payload: { host: { hostEpoch: 'epoch' } }, contextMatches: c => c.connectionId === context.connectionId && c.selectionGeneration === context.selectionGeneration },
    conversationSelectionRevision: 0, windowFocusEpoch: 0, conversationLoadEpoch: 0, windowFocused: ref(true), recovery: createConversationRecovery(),
    activeFollow: ref(null), activeFollowSubscription: computed(() => s.activeFollow.value?.subscriptionId), conversationState: ref(state), historyReloadRequiredWorkId: null,
    followConnected: ref(false), conversationError: ref(null), pendingFollowEvents: new Map(), requireConnectionContext: () => ({ ...context }), crypto: globalThis.crypto,
    waitForFollowConnection: () => { const held = deferred(); handshakes.push(held); return held.promise },
    startConversationFollow: async (_work, subscription) => { starts.push(subscription) }, stopConversationFollow: async () => {},
    clearFollowConnectionTimer() {}, followActivation: { cancel() {}, activate() {} }, extensionUi: { resumeFollow: () => true }, activeFollowCanContinue: () => true,
    performConversationLoad: async () => { loads.push('bootstrap'); return true }, errorMessage: () => 'failed',
    window: { clearTimeout }, reconnectTimer: 0, followConnectionTimers: new Map(), resetHistoryHydration() {},
    conversationLoading: ref(false), historyLoading: ref(false), historyHydrating: ref(false), historyError: ref(null),
  }
  s.followActivation.cancelAll = () => { for (const held of handshakes) held.reject(new Error('detached')) }
  s.detachConversationFollow = async () => { s.activeFollow.value = null; s.conversationLoadEpoch++ }
  const app = bindApp(['recoverConversation', 'reattachConversationFollow', 'performConversationReattach', 'resumeConversationFollow', ...(realDetach ? ['detachConversationFollow'] : [])], s)
  return { s, app, starts, loads, handshakes }
}
const resumed = recoveryFixture()
const old = resumed.app.reattachConversationFollow('A'); await tick()
resumed.s.windowFocused.value = false; resumed.s.windowFocusEpoch++; resumed.s.conversationLoadEpoch++
resumed.s.windowFocused.value = true; resumed.s.windowFocusEpoch++
const current = resumed.app.reattachConversationFollow('A'); await tick()
resumed.handshakes[0].reject(new Error('old transport ended')); await old
assert.equal(resumed.starts.length, 2)
assert.deepEqual(resumed.loads, [], 'old resume cannot fallback over the newer foreground recovery')
resumed.handshakes[1].reject(new Error('current transport failed')); await current
assert.deepEqual(resumed.loads, ['bootstrap'], 'only current transport failure may bootstrap')
const detached = recoveryFixture(); const holdDetach = deferred()
detached.s.activeFollow.value = { subscriptionId: 'old' }
detached.s.detachConversationFollow = async () => { detached.s.activeFollow.value = null; await holdDetach.promise }
const beforeSwitch = detached.app.reattachConversationFollow('A'); await tick()
detached.s.selected.value = { ...work, id: 'B' }; detached.s.conversationSelectionRevision++
detached.s.selected.value = work; detached.s.conversationSelectionRevision++
const afterSwitch = detached.app.reattachConversationFollow('A'); await tick()
holdDetach.resolve(); await beforeSwitch
assert.equal(detached.starts.length, 1, 'A→B→A cannot let old detach continuation start a second native Follow')
detached.handshakes[0].resolve(); await afterSwitch
const changedHost = recoveryFixture()
const oldHost = changedHost.app.reattachConversationFollow('A'); await tick()
changedHost.s.app.connectionContext.connectionId = 'other-host'
changedHost.s.app.connectionContext.selectionGeneration++
changedHost.s.app.payload.host.hostEpoch = 'other-epoch'
await changedHost.app.reattachConversationFollow('A')
assert.deepEqual(changedHost.loads, ['bootstrap'])
changedHost.handshakes[0].reject(new Error('old Host connection ended')); await oldHost
assert.deepEqual(changedHost.loads, ['bootstrap'], 'old Host continuation cannot bootstrap over the selected Host')
// A network route reconnect can keep every identity unchanged. Old native cleanup
// is held after detach; that obsolete task must not absorb the new reattach.
const network = recoveryFixture(true)
const cleanup = deferred(); let cleanupStarted = false
network.s.stopConversationFollow = async () => { if (!cleanupStarted) { cleanupStarted = true; await cleanup.promise } }
const retired = network.app.reattachConversationFollow('A'); await tick()
await network.app.detachConversationFollow(); await tick()
assert.equal(cleanupStarted, true)
const replacement = network.app.reattachConversationFollow('A'); await tick()
assert.equal(network.starts.length, 2, 'same-domain network reattach has a new owner even while old native cleanup waits')
network.handshakes[1].resolve(); await replacement
cleanup.resolve(); await retired

// Use the actual app store/native bootstrap path: app.load temporarily removes
// selection, whereas an authoritative refresh of the active target must not.
const previousWindow = globalThis.window
const nativeCatalog = { revision: 1, activeTarget: { kind: 'host', hostId: 'host-a' }, selectionGeneration: 1, hosts: [] }
let bootstrapGate = null
const storage = new Map()
globalThis.window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === 'get_host_catalog') return structuredClone(nativeCatalog)
    if (command === 'bootstrap') {
      if (bootstrapGate) await bootstrapGate.promise
      return { ...args, host: { hostEpoch: 'epoch' }, works: [work, { ...work, id: 'B' }], total: 2 }
    }
    throw new Error(`Unexpected native command: ${command}`)
  } },
}
const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { useAppStore, mutationScopeKey } = await server.ssrLoadModule('/src/stores/app.ts')
  setActivePinia(createPinia()); const app = useAppStore()
  await app.load(); app.selectWork('A')
  const unknown = { outcomeUnknown: true, operationId: 'unknown-session' }
  const original = { connectionId: 'host-a', instanceId: 'A' }
  const key = mutationScopeKey('host-a', 'A', 'sessions')
  const r = { app, selected: computed(() => app.selectedWork), conversationSelectionRevision: 0, nextTick, mutationScopeKey,
    unresolvedMutations: computed({ get: () => app.unresolvedMutations, set: value => { app.unresolvedMutations = value } }),
    unresolvedDomain: ref('sessions'), submissionError: ref(null), setCompactionError() {}, errorMessage: String,
    reconcileControlProjection: async () => true, loadSelectedConversation: async () => true,
  }
  const stopWatching = watch(() => [app.activeConnectionId, app.connectionContext?.selectionGeneration, app.selectedWork?.id], () => { r.conversationSelectionRevision++ }, { flush: 'sync' })
  const reconcile = bindApp(['mutationKey', 'reconcileMutationOutcome'], r)
  app.recordMutationUnknown(original, 'sessions', unknown)
  await reconcile.reconcileMutationOutcome('sessions')
  assert.equal(app.unresolvedMutations.has(key), false, 'same-target authoritative refresh can finish confirmation')
  app.recordMutationUnknown(original, 'sessions', unknown)
  bootstrapGate = deferred()
  const oldConfirmation = reconcile.reconcileMutationOutcome('sessions'); await tick()
  app.selectWork('B'); app.selectWork('A')
  bootstrapGate.resolve(); await oldConfirmation; bootstrapGate = null
  assert.equal(app.unresolvedMutations.has(key), true, 'returning to A does not let an obsolete confirmation clear its unknown')
  const compactReply = deferred()
  const c = { ...r, isTauri: true, mutationOutcomeUnknown: ref(false), compactionWorkIds: ref(new Set()), compactionErrors: ref({}),
    closeModal() {}, compactSession: () => compactReply.promise, requireConnectionContext: () => ({ ...app.connectionContext }),
    followConnected: ref(false), activeFollow: ref(null), crypto: globalThis.crypto, captureConnectionResult, hostResultMatches,
  }
  const compact = bindApp(['startCompaction', 'setCompactionPending', 'setCompactionError', 'compactionErrorKey', 'markUnknownOutcome', 'markControlUnknown'], c)
  app.unresolvedMutations = new Map()
  const compacting = compact.startCompaction(); await tick()
  app.catalog = { ...nativeCatalog, activeTarget: { kind: 'host', hostId: 'host-b' }, selectionGeneration: 2 }
  compactReply.reject(unknown); await compacting
  assert.equal(app.unresolvedMutations.has(key), true, 'App-owned compact retains the initiating Host, even after changing Host')
  assert.equal(app.unresolvedMutations.has(mutationScopeKey('host-b', 'A', 'sessions')), false)
  stopWatching(); app.flushLocalState()
} finally { await server.close(); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow }
console.log('PASS: App send and full Escape path, scoped recovery restart, actual-store confirmation and Compact failure ownership')
