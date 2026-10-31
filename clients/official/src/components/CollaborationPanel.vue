<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import AluSelect from './AluSelect.vue'
import { useAppStore } from '../stores/app'
import { useCollaborationStore } from '../stores/collaboration'
import { useWorkActionsStore } from '../stores/work-actions'
import { useSurfacesStore } from '../stores/surfaces'
import { workPresence } from '../lib/uiBoundaries'
const expanded = ref(false)
const app = useAppStore()
const collaboration = useCollaborationStore()
const { parent, children, peers, draft } = storeToRefs(collaboration)
const { openChildDirectory, selectWork } = useWorkActionsStore()
const surfaces = useSurfacesStore()
</script>

<template>
  <details v-if="app.selectedWork" class="collaboration-panel" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary>协作 <span v-if="parent">· {{ parent.displayName }}</span><span v-if="children.length"> · {{ children.length }} 个子任务</span></summary>
    <div v-if="expanded" class="collaboration-body">
      <div class="collaboration-actions">
        <button v-if="app.selectedWork.lifecycle === 'active'" type="button" @click="openChildDirectory">＋ 创建子任务</button>
        <button type="button" @click="surfaces.openControlCenter('tools')">查看当前工具</button>
        <button v-if="parent" type="button" @click="selectWork(parent.id)">↑ {{ parent.displayName }}</button>
      </div>
      <ul v-if="children.length" aria-label="子任务">
        <li v-for="child in children" :key="child.id"><button type="button" @click="selectWork(child.id)">{{ child.displayName }} · {{ workPresence(child).label }}</button><small>{{ child.executor.model?.id || '模型待定' }} · {{ child.executor.thinkingLevel || '默认思考强度' }}</small></li>
      </ul>
      <form class="collaboration-message" @submit.prevent="collaboration.send">
        <label>发送给 <AluSelect :value="draft.targetId" :options="[{ value: '', label: '选择任务' }, ...peers.map(peer => ({ value: peer.id, label: peer.displayName }))]" label="接收任务" :disabled="draft.pending" @select="draft.targetId = $event" /></label>
        <textarea v-model="draft.text" aria-label="协作消息" placeholder="补充任务或反馈；不会打断对方当前工作" :disabled="draft.pending" rows="2" />
        <button type="submit" :disabled="draft.pending || !draft.targetId || !draft.text.trim()">{{ draft.pending ? '正在发送…' : '发送后续消息' }}</button>
        <p v-if="draft.feedback" role="status">{{ draft.feedback }}</p>
      </form>
    </div>
  </details>
</template>

<style scoped>
.collaboration-panel { flex: 0 0 auto; border-bottom: 1px solid var(--alu-border); color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
summary { padding: 8px 16px; cursor: pointer; }
.collaboration-body { max-height: 42vh; overflow-y: auto; padding: 0 16px 12px; }
.collaboration-actions { display: flex; gap: 8px; flex-wrap: wrap; }
button, select, textarea { color: var(--alu-text); background: var(--alu-bg); border: 1px solid var(--alu-border); border-radius: 6px; padding: 6px 8px; }
button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
ul { list-style: none; padding: 0; } li { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
.collaboration-message { display: flex; gap: 8px; flex-direction: column; margin-top: 12px; }
.collaboration-message textarea { resize: vertical; min-height: 50px; }
.collaboration-message button { align-self: flex-end; } p { margin: 0; }
</style>
