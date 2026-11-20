<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { getHostSystemDefault } from '../lib/bridge'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import { machineDisplayLabel } from '../lib/machines'
import type { HostSystemDefaultResult, HostSystemRef } from '../lib/types'
import { errorCode, userErrorMessage } from '../lib/userError'
import { useAppStore } from '../stores/app'
import { useModelListsStore } from '../stores/model-lists'
import { useSurfacesStore } from '../stores/surfaces'
import { useWorkActionsStore } from '../stores/work-actions'
import AluSelect from './AluSelect.vue'
import MachineSettingsResults from './MachineSettingsResults.vue'

const props = defineProps<{ shown: boolean }>()
const emit = defineEmits<{ dirty: [boolean] }>()
const app = useAppStore(), submissions = useModelListsStore(), machines = useWorkActionsStore()
const target = ref(useSurfacesStore().machineSettingsTarget ?? '') // Main needs no target ID.
const connection = computed(() => app.connectionContext?.connectionId ?? '')
const identity = computed(() => JSON.stringify([connection.value, target.value]))
const submission = computed(() => submissions.forSystem(connection.value, target.value || undefined))
const machineOptions = computed(() => machines.hostMachines.map(machine => ({
  value: machine.kind === 'main' ? '' : machine.hostId, label: machineDisplayLabel(machine), disabled: !machine.available,
  ...(!machine.available ? { description: '暂不可用' } : {}),
})))
const machineLabel = computed(() => machineOptions.value.find(m => m.value === target.value)?.label ?? (target.value ? 'SubHost' : 'Main'))
const result = ref<HostSystemDefaultResult>()
const drafts = ref(new Map<string, HostSystemRef | null>())
const loading = ref(false), error = ref('')
const selectionKey = (item: HostSystemRef | null) => item?.kind === 'dock-template' ? `template:${item.name}` : item?.kind ?? ''
const selectionLabel = (item: HostSystemRef | null) => item?.kind === 'dock-template' ? item.name : item?.kind === 'global-system' ? '全局 SYSTEM.md' : '不指定（由 Pi 决定）'
const draft = computed(() => drafts.value.has(identity.value) ? drafts.value.get(identity.value)! :
  submission.value && submission.value.state !== 'succeeded' ? submission.value.selection : result.value?.selection ?? null)
const options = computed(() => [
  { value: '', label: selectionLabel(null) },
  ...(result.value?.options ?? []).map(o => ({ value: selectionKey(o.selection), label: selectionLabel(o.selection), disabled: !!o.warning, description: o.warning })),
])
const saving = computed(() => submission.value?.state === 'pending')
const canSave = computed(() => result.value && !saving.value && (drafts.value.has(identity.value) || result.value.warnings.length
  || submission.value?.state === 'unknown' || submission.value?.state === 'failed'))
const feedback = computed(() => drafts.value.has(identity.value) ? '尚未保存' : submission.value?.message)
watch(() => drafts.value.size > 0, dirty => emit('dirty', dirty), { immediate: true })
let epoch = 0
onScopeDispose(() => { ++epoch })
watch([connection, () => app.connectionContext?.selectionGeneration], ([id], previous) => {
  if (previous?.[0] && previous[0] !== id) target.value = ''
  void machines.refreshHostMachinesQuietly()
}, { immediate: true })
watch([identity, () => app.connectionContext?.selectionGeneration], () => { void load() }, { immediate: true, flush: 'sync' })
watch(() => submission.value?.state, state => {
  if (state === 'succeeded' && result.value && submission.value) result.value = { ...result.value, selection: submission.value.selection, warnings: [] }
})
watch([submission, () => submission.value?.state, loading, result, () => props.shown], () => {
  if (props.shown && !loading.value && result.value && submission.value?.state === 'succeeded') submissions.markSuccessSeen(submission.value.key)
}, { flush: 'post' })

async function load() {
  const reading = ++epoch, machine = target.value || undefined, started = submission.value, pending = saving.value
  loading.value = true; error.value = ''; result.value = undefined
  try {
    const page = await currentConnectionCall(app, async context => {
      const first = await getHostSystemDefault(context, machine)
      let cursor = first.nextCursor
      while (cursor && reading === epoch) {
        const more = await getHostSystemDefault(context, machine, cursor)
        first.options.push(...more.options); cursor = more.nextCursor
      }
      return first
    })
    if (epoch !== reading) return
    if (started && started === submission.value && pending && started.state === 'succeeded') {
      page.selection = started.selection; page.warnings = []
    } else if (started?.state === 'unknown' && started === submission.value && !page.warnings.length && selectionKey(started.selection) === selectionKey(page.selection)) {
      submissions.discard(started.key)
    }
    result.value = page
  } catch (cause) {
    if (epoch === reading) error.value = errorCode(cause) === 'capability_missing' ? '这台机器的 Dock 还不支持设置默认 system。请更新这台机器的 Dock。' : userErrorMessage(cause, '暂时读不到这台机器的默认 system。请稍后重试。')
  } finally { if (epoch === reading) loading.value = false }
}
function choose(value: string) {
  const selected = value === '' ? null : result.value?.options.find(o => selectionKey(o.selection) === value)?.selection
  if (selected === undefined) return
  if (selectionKey(selected) === selectionKey(result.value?.selection ?? null) && submission.value?.state !== 'unknown') discard()
  else drafts.value.set(identity.value, selected)
}
function discard() {
  drafts.value.delete(identity.value)
  if (submission.value) submissions.discard(submission.value.key)
}
function save() {
  if (!canSave.value) return
  const selected = draft.value
  drafts.value.delete(identity.value)
  void submissions.saveSystem(requireConnectionContext(app), target.value || undefined, `${machineLabel.value} · 默认 system`, selected)
}
</script>

<template>
  <main class="system-settings">
    <div class="system-settings-body">
      <h3>新建 Work 的默认 system</h3>
      <p>在这台机器上，Agent 派出的子 Work，以及用 dock_create 新建但没有指定 system 的 Work，都会使用这里的选择。工作目录保存了默认 system 时，以目录为准；创建时明确指定的优先。</p>
      <MachineSettingsResults embedded :exclude-key="submission?.key" />
      <label class="system-field"><span>机器</span><AluSelect v-if="machineOptions.length > 1" :value="target" :options="machineOptions" label="机器" @select="target = $event" /><strong v-else>{{ machineLabel }}</strong></label>
      <div v-if="machines.machineListError" class="system-problem" role="alert">{{ machines.machineListError }} <button class="button secondary" @click="machines.refreshHostMachinesQuietly">重试</button></div>
      <p v-if="loading" role="status">正在读取默认 system…</p>
      <div v-else-if="error" class="system-problem" role="alert">{{ error }} <button class="button secondary" @click="load">重试</button></div>
      <template v-else-if="result">
        <label class="system-field"><span>默认 system</span><AluSelect :value="selectionKey(draft)" :options="options" :placeholder="selectionLabel(draft)" :disabled="saving" label="选择默认 system" @select="choose" /></label>
        <p v-for="warning in result.warnings" :key="warning" class="system-problem" role="alert">{{ warning }}</p>
      </template>
    </div>
    <footer class="system-actions"><span role="status">{{ feedback }}</span><button class="button secondary" :disabled="saving || (!drafts.has(identity) && submission?.state !== 'unknown' && submission?.state !== 'failed')" @click="discard">放弃改动</button><button class="button primary" :disabled="!canSave" @click="save">{{ saving ? '正在保存…' : '保存' }}</button></footer>
  </main>
</template>

<style scoped>
.system-settings { display: flex; min-width: 0; min-height: 0; flex-direction: column; }
.system-settings-body { flex: 1; min-height: 0; overflow: auto; padding: 22px 24px; }
.system-settings-body h3 { margin: 0 0 6px; color: var(--alu-text); font-size: 18px; font-weight: 650; }
.system-settings-body p { margin: 0 0 14px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.system-field { display: grid; gap: 7px; margin-top: 18px; font-size: var(--alu-ui-size); color: var(--alu-text); }
.system-field > span { color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.system-problem, p.system-problem { margin-top: 12px; color: var(--alu-warning); overflow-wrap: anywhere; }
.system-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--alu-border); }
.system-actions span { flex: 1; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
@media (max-width: 640px) { .system-settings-body { padding: 16px 14px; } .system-actions { padding: 10px 14px; } }
</style>
