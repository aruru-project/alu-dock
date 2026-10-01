<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import { useModelVisibilityStore } from '../stores/model-visibility'
import { useSurfacesStore } from '../stores/surfaces'
import { useWorkActionsStore } from '../stores/work-actions'

const props = defineProps<{ embedded?: boolean; excludeKey?: string }>()
const app = useAppStore()
const saves = useModelVisibilityStore()
const surfaces = useSurfacesStore()
const actions = useWorkActionsStore()
const results = computed(() => [...saves.saves.values()].filter(save => !save.acknowledged && save.key !== props.excludeKey))
</script>

<template>
  <section v-if="results.length && (embedded || !surfaces.machineSettingsOpen)" class="machine-save-results" :class="{ 'is-embedded': embedded }" aria-label="Host 设置保存结果">
    <div v-for="save in results" :key="save.key" class="machine-save-result" :class="{ 'is-error': save.state === 'failed' }" :role="save.state === 'failed' ? 'alert' : 'status'">
      <span><strong>{{ save.label }}</strong>：{{ save.message }}<template v-if="save.state === 'failed'"> 改动已保留，可打开 Host 设置重试。</template><template v-else-if="save.state === 'unknown'"> 改动已保留，可打开 Host 设置查看或再次保存。</template><template v-if="save.connectionId !== app.activeConnectionId"> 切回对应的 Host 后可查看设置。</template></span>
      <button v-if="!embedded && save.connectionId === app.activeConnectionId" class="button secondary" @click="actions.openMachineSettings(save.targetHostId)">查看设置</button>
      <button v-if="save.state !== 'pending'" class="button secondary" @click="saves.dismiss(save.key)">知道了</button>
    </div>
  </section>
</template>

<style scoped>
.machine-save-results { flex: none; width: min(calc(100% - 32px), 760px); max-height: 20vh; overflow: auto; margin: 6px auto; }
.machine-save-result { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 10px; border: 1px solid var(--alu-border); border-radius: 8px; background: var(--alu-surface); color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.machine-save-result span { flex: 1; min-width: 160px; }
.machine-save-result.is-error { color: var(--alu-rose); }
.machine-save-results.is-embedded { width: 100%; margin: 0; }
</style>
