<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import { computed } from 'vue'
import { isTauri } from '../lib/bridge'
import AttachmentCard from './AttachmentCard.vue'
import OperationResults from './OperationResults.vue'
import type { useInputEditor } from '../lib/inputEditor'
import type { useWorkActions } from '../lib/workActions'
import type { useAttachmentUploads } from '../lib/attachmentUploads'
import type { usePageSurfaces } from '../lib/pageSurfaces'
import type { useWorkObservation } from '../lib/workObservation'
import type { useOperationResults } from '../lib/operationResults'
import ExtensionUiSurface from './ExtensionUiSurface.vue'
import { useAppStore } from '../stores/app'
import { useCommandCatalogStore } from '../stores/command-catalog'

const props = defineProps<{
  editor: ReadonlyRefs<Pick<ReturnType<typeof useInputEditor>, 'allowAnotherSubmit' | 'applyExtensionEditorText' | 'canSubmit' | 'completeSuggest' | 'composerArgumentLoading' | 'handleComposerKeydown' | 'queueItems' | 'queueNotice' | 'queueRestoring' | 'restoreQueue' | 'slashQuery' | 'submit' | 'submitAcknowledged' | 'submitExpanded' | 'submitOutcomeUnknown' | 'submitting' | 'suggestItems' | 'suggestOpen' | 'visibleComposerError'>> & Pick<ReturnType<typeof useInputEditor>, 'composerExpanded' | 'composerTextarea' | 'draft' | 'expandedTextarea' | 'suggestIndex'> & { composer: Pick<ReturnType<typeof useInputEditor>['composer'], 'remember' | 'composition'> }
  uploads: ReadonlyRefs<Pick<ReturnType<typeof useAttachmentUploads>, 'attachmentPicking' | 'attachmentPreviews' | 'cancelUpload' | 'clearQueueImages' | 'clearingRestoredImages' | 'draftAttachments' | 'handleComposerPaste' | 'launchAttachmentUpload' | 'openAttachmentPreview' | 'removeUpload' | 'removeUploaded' | 'restoredImageCount' | 'uploadDrafts'>>
  page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'bindSurface' | 'handleModalKeydown' | 'handleModalWheel' | 'modalOpen' | 'rememberModalTrigger'>>
  actions: ReadonlyRefs<Pick<ReturnType<typeof useWorkActions>, 'mutationOutcomeUnknown' | 'reconcileMutationOutcome' | 'reconcilingReopenWorkId'>>
  operations: ReadonlyRefs<Pick<ReturnType<typeof useOperationResults>, 'consumeNativeOperation' | 'restoreReturnedOperation' | 'returnedOperations' | 'returnedContentErrors' | 'workResults'>>
  observation: ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'load'>>
  away: boolean
}>()
const app = useAppStore()
const selected = computed(() => app.selectedWork)
const { composer, draft, composerTextarea, expandedTextarea, composerExpanded, queueRestoring, queueNotice, queueItems, submitting, submitOutcomeUnknown, submitAcknowledged, visibleComposerError, canSubmit, suggestIndex, slashQuery, suggestItems, suggestOpen, composerArgumentLoading, submit, submitExpanded, restoreQueue, allowAnotherSubmit, applyExtensionEditorText, completeSuggest, handleComposerKeydown } = props.editor
const { draftAttachments, attachmentPreviews, uploadDrafts, attachmentPicking, clearingRestoredImages, restoredImageCount, clearQueueImages, handleComposerPaste, launchAttachmentUpload, cancelUpload, removeUpload, removeUploaded, openAttachmentPreview } = props.uploads
const { modalOpen, rememberModalTrigger, handleModalKeydown, handleModalWheel } = props.page
const { mutationOutcomeUnknown, reconcilingReopenWorkId, reconcileMutationOutcome } = props.actions
const { returnedOperations, returnedContentErrors, workResults, consumeNativeOperation, restoreReturnedOperation } = props.operations
const { load: loadSelectedConversation } = props.observation
const commandCatalogStore = useCommandCatalogStore()
const reconcileExtensionInteraction = () => selected.value ? props.observation.load(selected.value.id, true) : Promise.resolve(false)
const applyExtensionTitle = (title: string) => { document.title = title }
const emit = defineEmits<{ latest: [] }>()
</script>

<template>
  <section v-if="selected && selected.lifecycle === 'active'" class="alu-input-section" aria-label="消息编辑器">
    <button v-if="props.away" type="button" class="alu-scroll-bottom" aria-label="滚动到最新消息" @click="emit('latest')"><span aria-hidden="true">↓</span>滚到底部</button>
    <ExtensionUiSurface :focus-suspended="modalOpen" :work="selected" :reconcile-interaction="reconcileExtensionInteraction" @editor-text="applyExtensionEditorText" @title="applyExtensionTitle">
      <div v-if="visibleComposerError" class="alu-composer-error"><span>{{ visibleComposerError }}</span><template v-if="submitOutcomeUnknown"><button @click="loadSelectedConversation(selected.id)">刷新查看</button><button v-if="!submitAcknowledged" @click="allowAnotherSubmit">允许再次发送</button></template><button v-else-if="mutationOutcomeUnknown && reconcilingReopenWorkId !== selected.id" @click="reconcileMutationOutcome()">刷新并确认</button></div>
      <div v-for="operation in returnedOperations" :key="operation.operationId" class="alu-composer-notice" role="status">
        <span>{{ returnedContentErrors[operation.operationId] ?? '操作已完成，返回内容已保留。' }}</span><button @click="restoreReturnedOperation(operation)">追加到编辑器</button>
      </div>
      <div v-if="queueNotice" class="alu-composer-notice" role="status">{{ queueNotice }}</div>
      <div v-if="selected.pending.total" class="alu-queue-tray">
        <span class="alu-queue-title">Queue · {{ selected.pending.total }}</span>
        <span class="alu-queue-preview">{{ queueItems.map(item => item.text.trim() || (item.imageCount || item.attachments.length ? '[附件]' : '')).filter(Boolean).join(' · ') }}</span>
        <button type="button" class="alu-queue-restore" title="取回 Queue（Alt+↑）" aria-keyshortcuts="Alt+ArrowUp" :disabled="!isTauri || attachmentPicking || queueRestoring || submitting" @click="restoreQueue">{{ queueRestoring ? '取回中…' : '取回' }}</button>
      </div>
      <div v-if="uploadDrafts.length || draftAttachments.length || restoredImageCount" class="alu-native-attachments" aria-label="已选附件">
        <div class="alu-attachment-selection-summary">已选择 {{ uploadDrafts.length + draftAttachments.length + restoredImageCount }} 个附件<span>点图片可放大查看</span></div>
        <AttachmentCard v-for="item in uploadDrafts" :key="item.token" :name="item.name" :size-bytes="item.sizeBytes" :media-type="item.mediaType" :state="item.state" :progress="item.progress" :message="item.error" :retryable="item.state === 'error' && item.retryable" :cancellable="item.state !== 'error'" :removable="true" :preview-url="attachmentPreviews[item.token]?.url" @preview="openAttachmentPreview(item.token, item.name)" @retry="launchAttachmentUpload(item)" @cancel="cancelUpload(item)" @remove="removeUpload(item)" />
        <AttachmentCard v-for="attachment in draftAttachments" :key="attachment.fileId" :name="attachment.name" :size-bytes="attachment.sizeBytes" :media-type="attachment.mediaType" :preview-url="attachmentPreviews[attachment.fileId]?.url" removable @preview="openAttachmentPreview(attachment.fileId, attachment.name)" @remove="removeUploaded(attachment.fileId)" />
        <div v-if="restoredImageCount" class="alu-restored-images"><span>已取回 {{ restoredImageCount }} 个附件</span><button type="button" :disabled="clearingRestoredImages" @click="clearQueueImages">{{ clearingRestoredImages ? '移除中…' : '移除' }}</button></div>
      </div>
      <form class="alu-input-wrap" @submit.prevent="submit">
        <div v-if="suggestOpen" class="cmd-suggest" role="listbox" aria-label="命令建议">
          <button v-for="(item, index) in suggestItems" :key="`${item.kind}:${item.name}:${index}`" :id="`cmd-suggest-${index}`" type="button" class="cmd-suggest-item" :class="{ selected: suggestIndex === index }" role="option" :aria-selected="suggestIndex === index" @mouseenter="suggestIndex = index" @mousedown.prevent @click="completeSuggest(item)">
            <span class="cmd-suggest-name">{{ item.kind === 'argument' ? item.name : `/${item.name}${item.kind === 'catalog' && item.argumentHint ? ` ${item.argumentHint}` : ''}` }}</span>
            <span class="cmd-suggest-desc">{{ item.description || 'Dock 未提供说明' }}</span>
            <span class="cmd-suggest-kind">{{ item.sourceLabel }}</span>
          </button>
          <div v-if="!suggestItems.length && composerArgumentLoading" class="cmd-suggest-hint">正在读取参数候选…</div>
          <div v-else-if="!suggestItems.length && commandCatalogStore.state === 'loading'" class="cmd-suggest-hint">正在读取命令…</div>
          <div v-else-if="!suggestItems.length && commandCatalogStore.state === 'failed'" class="cmd-suggest-hint">当前命令目录暂时不可用，请稍后重试。</div>
          <div v-else-if="!suggestItems.length && slashQuery" class="cmd-suggest-hint">无匹配命令</div>
        </div>
        <textarea ref="composerTextarea" v-model="draft" rows="1" placeholder="输入消息…" title="Enter 发送 · Shift+Enter / Ctrl+J 换行" aria-keyshortcuts="Control+J" @select="composer.remember" @blur="composer.remember" @compositionstart="composer.composition" @compositionend="composer.composition" @paste="handleComposerPaste" @keydown="handleComposerKeydown($event)" />
        <button type="button" class="alu-composer-expand" title="展开编辑" aria-label="展开编辑" @click="rememberModalTrigger(); composerExpanded = true">↗</button>
        <button class="alu-send-btn" type="submit" :disabled="!canSubmit">{{ submitting ? '发送中…' : '发送' }}</button>
      </form>
    </ExtensionUiSurface>

    <slot />
  </section>

  <Transition name="fade">
    <div v-if="composerExpanded" class="ui-dialog-overlay" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => props.page.bindSurface('expanded', element)" class="ui-dialog-box ui-dialog-box-composer ui-dialog-size-wide" role="dialog" aria-modal="true" aria-labelledby="expanded-composer-title" tabindex="-1" @wheel="handleModalWheel">
        <header class="ui-dialog-header"><div id="expanded-composer-title" class="ui-dialog-title">编辑消息</div></header>
        <button class="ui-dialog-close" aria-label="关闭" @click="composerExpanded = false">×</button>
        <textarea ref="expandedTextarea" v-model="draft" @select="composer.remember" @blur="composer.remember" @compositionstart="composer.composition" @compositionend="composer.composition" class="ui-dialog-composer-editor" rows="12" placeholder="输入多行消息…" title="Ctrl+J 换行" aria-keyshortcuts="Control+J" @paste="handleComposerPaste" @keydown="handleComposerKeydown($event, true)" />
        <OperationResults v-if="workResults.length" :operations="workResults" :acknowledge="consumeNativeOperation" />
        <footer class="ui-dialog-actions ui-dialog-composer-footer">
          <span class="ui-dialog-composer-attachments">{{ draftAttachments.length + restoredImageCount ? `已附加 ${draftAttachments.length + restoredImageCount} 个文件` : '未附加文件' }}</span>
          <span v-if="visibleComposerError" class="ui-dialog-composer-status">{{ visibleComposerError }}</span>
          <button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="!canSubmit" @click="submitExpanded">{{ submitting ? '发送中…' : '发送' }}</button>
        </footer>
      </section>
    </div>
  </Transition>

</template>
