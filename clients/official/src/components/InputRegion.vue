<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { isTauri } from '../lib/bridge'
import AttachmentCard from './AttachmentCard.vue'
import OperationResults from './OperationResults.vue'
import ExtensionUiSurface from './ExtensionUiSurface.vue'
import { useAppStore } from '../stores/app'
import { useAttachmentsStore } from '../stores/attachments'
import { useCommandCatalogStore } from '../stores/command-catalog'
import { useConversationStore } from '../stores/conversation'
import { useInputStore } from '../stores/input'
import { useObservationStore } from '../stores/observation'
import { useOperationsStore } from '../stores/operations'
import { useSurfacesStore } from '../stores/surfaces'
import { useWorkActionsStore } from '../stores/work-actions'

const app = useAppStore()
const selected = computed(() => app.selectedWork)
const input = useInputStore()
const { draft, composerTextarea, expandedTextarea, queueRestoring, queueNotice, queueItems, submitting, submitOutcomeUnknown, submitAcknowledged, visibleComposerError, canSubmit, suggestIndex, slashQuery, suggestItems, suggestOpen, composerArgumentLoading } = storeToRefs(input)
const { rememberSelection, trackComposition, submit, submitExpanded, restoreQueue, allowAnotherSubmit, applyExtensionEditorText, completeSuggest, handleComposerKeydown, clearQueueImages } = input
const attachments = useAttachmentsStore()
const { draftAttachments, attachmentPreviews, uploadDrafts, attachmentPicking, clearingRestoredImages, restoredImageCount } = storeToRefs(attachments)
const { handleComposerPaste, launchAttachmentUpload, cancelUpload, removeUpload, removeUploaded, openAttachmentPreview } = attachments
const surfaces = useSurfacesStore()
const { modalOpen, composerExpanded } = storeToRefs(surfaces)
const { rememberModalTrigger, handleModalKeydown, handleModalWheel, bindSurface } = surfaces
const workActions = useWorkActionsStore()
const { actionNotice, mutationOutcomeUnknown, reconcilingReopenWorkId } = storeToRefs(workActions)
const { reconcileMutationOutcome } = workActions
// An unconfirmed result stays visible with a refresh action; other actions remain usable.
const canConfirmOutcome = computed(() => !!selected.value && mutationOutcomeUnknown.value && reconcilingReopenWorkId.value !== selected.value.id)
const operations = useOperationsStore()
const { returnedOperations, returnedContentErrors, workResults } = storeToRefs(operations)
const { consumeNativeOperation, restoreReturnedOperation } = operations
const observation = useObservationStore()
const { load: loadSelectedConversation } = observation
const conversation = useConversationStore()
const { outputAwayFromBottom: away } = storeToRefs(conversation)
const commandCatalogStore = useCommandCatalogStore()
const reconcileExtensionInteraction = () => selected.value ? observation.load(selected.value.id, true) : Promise.resolve(false)
const applyExtensionTitle = (title: string) => { document.title = title }
</script>

<template>
  <section v-if="selected && selected.lifecycle === 'active'" class="alu-input-section" aria-label="消息编辑器">
    <button v-if="away" type="button" class="alu-scroll-bottom" aria-label="滚动到最新消息" @click="conversation.scrollOutputToBottom(true)"><span aria-hidden="true">↓</span>滚到底部</button>
    <ExtensionUiSurface :focus-suspended="modalOpen" :work="selected" :reconcile-interaction="reconcileExtensionInteraction" @editor-text="applyExtensionEditorText" @title="applyExtensionTitle">
      <div v-if="visibleComposerError" :class="submitOutcomeUnknown ? 'alu-composer-notice' : 'alu-composer-error'" :role="submitOutcomeUnknown ? 'status' : undefined"><span>{{ visibleComposerError }}</span><template v-if="submitOutcomeUnknown"><button @click="loadSelectedConversation(selected.id)">刷新查看</button><button v-if="!submitAcknowledged" @click="allowAnotherSubmit">允许再次发送</button></template></div>
      <div v-if="actionNotice || canConfirmOutcome" class="alu-composer-notice" role="status"><span>{{ actionNotice ?? '上一次操作的结果还没有确认。可以刷新查看，其他操作照常可用。' }}</span><button v-if="canConfirmOutcome" @click="reconcileMutationOutcome()">刷新并确认</button></div>
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
        <textarea ref="composerTextarea" v-model="draft" rows="1" placeholder="输入消息…" title="Enter 发送 · Shift+Enter / Ctrl+J 换行" aria-keyshortcuts="Control+J" @select="rememberSelection" @blur="rememberSelection" @compositionstart="trackComposition" @compositionend="trackComposition" @paste="handleComposerPaste" @keydown="handleComposerKeydown($event)" />
        <button type="button" class="alu-composer-expand" title="展开编辑" aria-label="展开编辑" @click="rememberModalTrigger(); composerExpanded = true">↗</button>
        <button class="alu-send-btn" type="submit" :disabled="!canSubmit">{{ submitting ? '发送中…' : '发送' }}</button>
      </form>
    </ExtensionUiSurface>

    <slot />
  </section>

  <Transition name="fade">
    <div v-if="composerExpanded" class="ui-dialog-overlay" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => bindSurface('expanded', element)" class="ui-dialog-box ui-dialog-box-composer ui-dialog-size-wide" role="dialog" aria-modal="true" aria-labelledby="expanded-composer-title" tabindex="-1" @wheel="handleModalWheel">
        <header class="ui-dialog-header"><div id="expanded-composer-title" class="ui-dialog-title">编辑消息</div></header>
        <button class="ui-dialog-close" aria-label="关闭" @click="composerExpanded = false">×</button>
        <textarea ref="expandedTextarea" v-model="draft" @select="rememberSelection" @blur="rememberSelection" @compositionstart="trackComposition" @compositionend="trackComposition" class="ui-dialog-composer-editor" rows="12" placeholder="输入多行消息…" title="Ctrl+J 换行" aria-keyshortcuts="Control+J" @paste="handleComposerPaste" @keydown="handleComposerKeydown($event, true)" />
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

<style scoped>
/* ═══════════════════════════════════════════════════════
   输入区
   ═══════════════════════════════════════════════════════ */
.alu-input-section {
  position: relative;
  z-index: 10;
  background: var(--alu-nav-bg);
  border-top: 1px solid var(--alu-nav-border);
  flex-shrink: 0;
  padding: 0 16px;
}
.alu-composer-expand {
  display: inline-grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--alu-border);
  border-radius: 10px;
  color: var(--alu-text-muted);
  font-size: 15px;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.alu-composer-expand:hover,
.alu-composer-expand:focus-visible {
  outline: none;
  color: var(--alu-blue);
  background: var(--alu-blue-bg);
  border-color: var(--alu-blue-border);
}
.alu-composer-expand:disabled { opacity: 0.35; cursor: not-allowed; }
/* 发送按钮 */
.alu-send-btn {
  flex-shrink: 0;
  padding: 10px 24px;
  background: linear-gradient(135deg, #c8386e 0%, #a02858 100%);
  border: none;
  color: #fce8f0;
  border-radius: 13px;
  font-size: 14px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  letter-spacing: 0.03em;
  box-shadow: 0 2px 14px rgba(200, 56, 110, 0.40);
}
.alu-send-btn:focus-visible { box-shadow: var(--focus-ring); }
.alu-send-btn:hover {
  background: linear-gradient(135deg, #dc4880 0%, #b83468 100%);
  box-shadow: 0 4px 24px rgba(220, 72, 128, 0.50);
  transform: translateY(-1px);
}
.alu-send-btn:active {
  transform: translateY(0);
  box-shadow: 0 2px 10px rgba(200, 56, 110, 0.32);
}
.ui-dialog-composer-editor {
  min-height: 0;
  flex: 1 1 auto;
  resize: none;
  margin: 14px 16px 0;
  padding: 14px 16px;
  outline: none;
  border: 1px solid var(--alu-border-light);
  border-radius: 10px;
  background: var(--alu-bg);
  color: var(--alu-text);
  font: inherit;
  font-size: 14px;
  line-height: 1.7;
  box-shadow: inset 0 1px 14px rgba(0, 0, 0, 0.2);
}
.ui-dialog-composer-editor:focus {
  border-color: var(--alu-pink-border);
  box-shadow: 0 0 0 3px rgba(244, 114, 182, 0.08), inset 0 1px 14px rgba(0, 0, 0, 0.2);
}
.ui-dialog-composer-footer { align-items: center; }
.ui-dialog-composer-attachments { min-width: 0; flex: 1; color: var(--alu-text-muted); font-size: 10px; }
.ui-dialog-composer-status { flex: 0 1 auto; color: var(--alu-amber); font-size: 10px; }
.ui-dialog-composer-status[hidden] { display: none; }
/* ── 输入框斜杠命令建议（锚在 .alu-input-wrap 上，贴着输入框浮出） ── */
.cmd-suggest {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 40;
  max-height: min(320px, 46vh);
  max-height: min(320px, 46dvh);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 5px;
  background: var(--alu-bg-raised);
  border: 1px solid var(--alu-border-light);
  border-radius: 12px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.62);
}
.cmd-suggest-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
.cmd-suggest-item.selected { background: var(--alu-hover); border-color: var(--alu-border); }
.cmd-suggest-name { max-width: 48%; flex: 0 1 auto; overflow: hidden; color: var(--alu-amber); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.cmd-suggest-desc { flex: 1 1 auto; overflow: hidden; color: var(--alu-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.cmd-suggest-kind { flex: 0 0 auto; padding: 1px 5px; border: 1px solid var(--alu-border); border-radius: 999px; color: var(--alu-text-faint); font-size: 8px; }
.cmd-suggest-hint { padding: 10px 12px; color: var(--alu-text-muted); font-size: 11px; }
@media (max-width: 1000px) {
  .alu-input-section { padding: 0 clamp(10px, 3vw, 24px); }
  .alu-composer-expand {
    min-width: 44px;
    width: 44px;
    height: 44px;
    padding: 0;
    border-radius: 11px;
  }
  .alu-send-btn {
    min-width: 64px;
    height: 44px;
    padding: 0 14px;
    border-radius: 11px;
    font-size: 13px;
  }
}
@media (max-width: 640px) {
  .alu-input-section { padding-inline: 8px; }
  .ui-dialog-composer-editor { margin: 12px 10px 0; padding: 13px; font-size: 14px; }
  .ui-dialog-composer-footer { padding: 10px; }
  .cmd-suggest-item { min-height: 44px; }
}
.alu-send-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.alu-queue-tray {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 0;
  padding: 8px 12px;
  border: 1px solid var(--alu-blue-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--alu-blue-bg) 82%, transparent);
  color: var(--alu-text-dim);
  font-size: 11px;
}
.alu-queue-tray[hidden] { display: none; }
.alu-queue-title { color: var(--alu-blue); font-weight: 700; white-space: nowrap; }
.alu-queue-preview { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alu-queue-restore {
  color: var(--alu-blue);
  border: 1px solid var(--alu-blue-border);
  border-radius: 7px;
  padding: 3px 8px;
  flex-shrink: 0;
}
.alu-queue-restore:hover { background: var(--alu-blue-bg); color: var(--alu-text); }
@media (max-width: 640px) {
  .alu-queue-preview { max-width: 48vw; }
}
@media (min-width: 1200px) {
  .alu-send-btn {
    font-size: var(--alu-control-size);
  }
}
.alu-composer-error, .alu-composer-notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 7px; padding: 7px 10px; border-radius: 8px; font-size: 10px; }
.alu-composer-error { color: var(--alu-rose); border: 1px solid var(--alu-rose-border); background: var(--alu-rose-bg); }
.alu-composer-notice { color: var(--alu-amber); border: 1px solid color-mix(in srgb, var(--alu-amber) 22%, transparent); background: color-mix(in srgb, var(--alu-amber) 7%, transparent); }
.alu-composer-error button, .alu-composer-notice button { color: inherit; }
.alu-native-attachments { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 6px; max-height: 228px; margin-top: 8px; padding: 7px; overflow-y: auto; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); }
.alu-attachment-selection-summary { display: flex; grid-column: 1 / -1; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 3px; color: var(--alu-text-dim); font-size: 10px; }
.alu-attachment-selection-summary span { color: var(--alu-text-muted); }
.alu-restored-images { display: flex; min-height: 48px; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border: 1px solid var(--alu-blue-border); border-radius: 8px; color: var(--alu-text-muted); font-size: 10px; }
.alu-restored-images button { color: var(--alu-blue); }
/* The overlay already excludes the keyboard; fit that space instead of moving above it. */
.ui-dialog-box-composer { height: min(76dvh, 680px); max-height: 100%; }
@media (max-width: 640px) {
  .alu-native-attachments { max-height: 140px; }
}
.alu-scroll-bottom {
  position: absolute;
  z-index: 3;
  top: -44px;
  right: 24px;
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  border: 1px solid var(--alu-blue-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--alu-bg-raised) 92%, transparent);
  box-shadow: 0 8px 24px rgba(2, 6, 18, .34);
  color: var(--alu-text-dim);
  font-size: 10px;
  font-weight: 650;
  cursor: pointer;
  backdrop-filter: blur(10px);
}
.alu-scroll-bottom > span { color: var(--alu-blue); font-size: 14px; line-height: 1; }
.alu-scroll-bottom:hover { border-color: var(--alu-blue); color: var(--alu-text); transform: translateY(-1px); }
.alu-scroll-bottom:focus-visible { outline: 2px solid var(--alu-blue); outline-offset: 2px; box-shadow: var(--focus-ring); }
@media (max-width: 640px) {
  .alu-scroll-bottom { top: -42px; right: 12px; min-height: 30px; padding: 0 10px; }
}
</style>
