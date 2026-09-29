<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { isTauri } from '../lib/bridge'
import ConversationView from './ConversationView.vue'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'
import { useAttachmentsStore } from '../stores/attachments'
import { useConversationStore } from '../stores/conversation'
import { useObservationStore } from '../stores/observation'
import { useSurfacesStore } from '../stores/surfaces'

const app = useAppStore()
const selected = computed(() => app.selectedWork)
const conversationStore = useConversationStore()
const { readingError, output, conversationState, conversation, conversationSwitching, streamingPartIds, historyTruncated, contentSeeding, historyLoading, historyHydrating, historyError } = storeToRefs(conversationStore)
const { setReadInterest, handleOutputScroll, handleOutputMediaLoad, imageResource, requestConversationImage, markConversationImageFailed, openImagePreview, toolDetailOpen, rememberToolDetail, loadEarlierHistory, retryConversationHydration } = conversationStore
const observation = useObservationStore()
const { loading: conversationLoading, error: conversationError } = storeToRefs(observation)
const { load: loadSelectedConversation } = observation
const attachments = useAttachmentsStore()
const { attachmentPreviews } = storeToRefs(attachments)
const { openAttachmentPreview } = attachments
const { openMessageText } = useSurfacesStore()
</script>

<template>
  <main ref="output" class="alu-output" aria-label="当前 Session 对话" @scroll.passive="handleOutputScroll" @load.capture="handleOutputMediaLoad">
    <div v-if="!isTauri" class="alu-preview-notice">
      浏览器预览 · 仅作演示
    </div>
    <div v-if="readingError" class="alu-preview-notice" role="status">{{ readingError }}</div>
    <div v-if="conversationSwitching && selected" class="alu-conversation-switching" role="status">正在打开 {{ selected.displayName }}…</div>

    <slot v-if="!selected || selected.lifecycle !== 'active'" />

    <div v-else-if="(conversationLoading || contentSeeding) && !conversation.length" class="alu-welcome" aria-live="polite">
      <img :src="dockIconUrl" alt="Alu Dock" />
      <div class="alu-welcome-text">{{ conversationState ? '正在读取对话…' : `正在连接 ${selected.displayName}…` }}</div>
    </div>

    <div v-else-if="conversationError && !conversation.length" class="alu-welcome alu-welcome-error">
      <img :src="dockIconUrl" alt="Alu Dock" />
      <div class="alu-welcome-text">对话暂时没有载入。当前 Work 继续运行。</div>
      <button v-if="selected" class="ui-dialog-btn" @click="loadSelectedConversation(selected.id)">重新载入</button>
    </div>

    <ConversationView
      v-else-if="conversation.length"
      :items="conversation"
      :switching="conversationSwitching"
      :streaming-parts="streamingPartIds"
      :history-loading="historyLoading"
      :history-hydrating="historyHydrating"
      :history-truncated="historyTruncated"
      :history-error="historyError"
      :attachment-previews="attachmentPreviews"
      :tool-open="toolDetailOpen"
      :image-resource="imageResource"
      @read-interest="setReadInterest"
      @load-earlier="loadEarlierHistory"
      @retry-history="retryConversationHydration"
      @tool-toggle="rememberToolDetail"
      @image-request="requestConversationImage"
      @image-preview="openImagePreview"
      @image-failed="markConversationImageFailed"
      @attachment-preview="openAttachmentPreview"
      @open-text="openMessageText"
    />

    <div v-else class="alu-welcome">
      <img :src="dockIconUrl" alt="Alu Dock" />
      <div class="alu-welcome-text">「{{ selected.name || 'New session' }}」准备好了。</div>
    </div>
  </main>

</template>

<style scoped>
.alu-conversation-switching { color: var(--alu-blue); border-color: var(--alu-blue-border); }
.alu-welcome-error { gap: 10px; }
.alu-welcome-error .ui-dialog-btn { margin-top: 4px; }
</style>
