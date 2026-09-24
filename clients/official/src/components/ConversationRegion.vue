<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import { computed } from 'vue'
import { isTauri } from '../lib/bridge'
import ConversationView from './ConversationView.vue'
import type { useConversationRegion } from '../lib/conversationRegion'
import type { useAttachmentUploads } from '../lib/attachmentUploads'
import type { usePageSurfaces } from '../lib/pageSurfaces'
import type { useWorkObservation } from '../lib/workObservation'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  conversationOwner: ReadonlyRefs<Pick<ReturnType<typeof useConversationRegion>, 'readingError' | 'contentSeeding' | 'conversation' | 'conversationState' | 'conversationSwitching' | 'handleOutputMediaLoad' | 'handleOutputScroll' | 'historyError' | 'historyHydrating' | 'historyLoading' | 'historyTruncated' | 'imageResource' | 'loadEarlierHistory' | 'markConversationImageFailed' | 'openImagePreview' | 'rememberToolDetail' | 'requestConversationImage' | 'retryConversationHydration' | 'streamingPartIds' | 'toolDetailOpen'>> & Pick<ReturnType<typeof useConversationRegion>, 'output'> & { conversationSession: Pick<ReturnType<typeof useConversationRegion>['conversationSession'], 'setInterest' | 'retry'> }
  observation: ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'error' | 'load' | 'loading'>>
  uploads: ReadonlyRefs<Pick<ReturnType<typeof useAttachmentUploads>, 'attachmentPreviews' | 'openAttachmentPreview'>>
  page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'openMessageText'>>
}>()
const app = useAppStore()
const selected = computed(() => app.selectedWork)
const { readingError, output, conversationState, conversation, conversationSwitching, streamingPartIds, historyTruncated, contentSeeding, historyLoading, historyHydrating, historyError, conversationSession, handleOutputScroll, handleOutputMediaLoad, imageResource, requestConversationImage, markConversationImageFailed, openImagePreview, toolDetailOpen, rememberToolDetail, loadEarlierHistory, retryConversationHydration } = props.conversationOwner
const { loading: conversationLoading, error: conversationError, load: loadSelectedConversation } = props.observation
const { attachmentPreviews, openAttachmentPreview } = props.uploads
const { openMessageText } = props.page
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
      @read-interest="conversationSession.setInterest"
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
