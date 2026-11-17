<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { modelSpeedOptions, settingValueLabel } from '../lib/settingLabels'
import type { ModelSpeedSelection, ModelSpeedTier, SettingInfo } from '../lib/types'
import AluSelect from './AluSelect.vue'

const props = defineProps<{ setting: SettingInfo; child: boolean; pending: boolean }>()
const emit = defineEmits<{ save: [value: ModelSpeedSelection | null] }>()
const tier = ref<ModelSpeedTier>('standard')
const scope = ref<ModelSpeedSelection['scope']>('work')
const edited = ref(false)
const selection = computed(() => {
  const value = props.setting.value
  return value && typeof value === 'object' && 'tier' in value ? value : null
})
watch(selection, value => {
  if (edited.value) return
  tier.value = value?.tier ?? 'standard'
  scope.value = value?.scope ?? 'work'
}, { immediate: true })
const supported = computed(() => props.setting.allowedValues?.includes(tier.value))
const supportLabel = computed(() => modelSpeedOptions.filter(option => props.setting.allowedValues?.includes(option.value)).map(option => option.label).join('、'))
const chosenLabel = computed(() => selection.value ? settingValueLabel('modelSpeed', selection.value) : props.child ? '跟随父 Work' : '标准（默认）')
</script>

<template>
  <section class="model-speed-setting" aria-label="模型速度设置">
    <div class="speed-body">
      <p class="speed-note">已选：{{ chosenLabel }}</p>
      <label class="speed-field">速度档位
        <AluSelect :value="tier" :options="modelSpeedOptions" label="模型速度档位" :disabled="pending || !setting.writable" @select="tier = $event as ModelSpeedTier; edited = true" />
      </label>
      <p class="speed-note">当前模型列出的档位：{{ supportLabel }}。</p>
      <p v-if="!supported" class="speed-note">当前模型不采用所选档位，选择会保留；共享给子 Work 时，各自按支持情况使用。</p>
      <label class="speed-field">作用范围
        <AluSelect :value="scope" :options="[{ value: 'work', label: '只当前 Work' }, { value: 'all', label: '当前及子 Work' }]" label="速度作用范围" :disabled="pending || !setting.writable" @select="scope = $event as ModelSpeedSelection['scope']; edited = true" />
      </label>
      <p class="speed-note">“当前及子 Work”也用于已经运行和以后新建、尚未单独设置的子 Work。子 Work 单独设置的档位优先。</p>
      <p class="speed-note">从下一次请求生效，不打断已有请求。标准不请求加速；Fast / Ultrafast 可能增加费用，实际速度由模型服务决定。</p>
      <p v-if="child" class="speed-note">跟随父 Work 的共享档位；父 Work 未共享时使用标准。</p>
    </div>
    <div class="speed-actions">
      <button type="button" class="button primary" :disabled="pending || !setting.writable" @click="emit('save', { tier, scope })">{{ pending ? '正在保存…' : '保存速度设置' }}</button>
      <button v-if="child" type="button" class="button secondary" :disabled="pending || !setting.writable" @click="emit('save', null)">恢复跟随父 Work</button>
    </div>
  </section>
</template>

<style scoped>
.model-speed-setting { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden; }
.speed-body { display: grid; gap: 12px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px; }
.speed-field { display: grid; gap: 6px; font-size: var(--alu-meta-size); color: var(--alu-text); }
.speed-note { margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.speed-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 8px; padding: 14px 16px; border-top: 1px solid var(--alu-border); }
</style>
