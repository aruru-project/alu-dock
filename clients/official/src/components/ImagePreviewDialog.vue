<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import { FileDown } from '@lucide/vue'
import { isTauri, savePreviewImage } from '../lib/bridge'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { useConversationRegion } from '../lib/conversationRegion'
import type { useAttachmentUploads } from '../lib/attachmentUploads'
import type { usePageSurfaces } from '../lib/pageSurfaces'
import ImageZoomSurface from './ImageZoomSurface.vue'

const props = defineProps<{
  page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'bindSurface' | 'closeModal' | 'handleModalKeydown' | 'handleModalWheel'>> & Pick<ReturnType<typeof usePageSurfaces>, 'imagePreview' | 'imageSaveStatus' | 'imageSaving'>
  conversationOwner: ReadonlyRefs<Pick<ReturnType<typeof useConversationRegion>, 'failPreview'>>
  uploads: ReadonlyRefs<Pick<ReturnType<typeof useAttachmentUploads>, 'previewFailed' | 'removeAttachmentPreview'>>
}>()
const { imagePreview, imageSaving, imageSaveStatus, closeModal, handleModalKeydown, handleModalWheel } = props.page
const { removeAttachmentPreview } = props.uploads
function markPreviewImageFailed() {
  const preview = imagePreview.value
  if (!preview) return
  if (preview.kind === 'conversation') {
    props.conversationOwner.failPreview(preview.imageKey)
  } else {
    removeAttachmentPreview(preview.attachmentKey)
    props.uploads.previewFailed()
  }
  imagePreview.value = null
}

async function saveOpenImage() {
  const preview = imagePreview.value
  if (!preview || imageSaving.value) return
  imageSaving.value = true
  imageSaveStatus.value = null
  try {
    if (!isTauri) {
      const link = document.createElement('a')
      link.href = preview.url
      link.download = preview.name
      link.click()
      return
    }
    if (!preview.handle) throw new Error('图片内容无法读取，请重新打开后再保存。')
    const result = await savePreviewImage(preview.name, preview.handle)
    if (imagePreview.value?.url !== preview.url || result.status === 'cancelled') return
    imageSaveStatus.value = { tone: 'success', text: '图片已保存到所选位置。' }
  } catch (cause) {
    if (imagePreview.value?.url === preview.url) {
      imageSaveStatus.value = { tone: 'error', text: errorMessage(cause, '图片没有保存完成，请重试。') }
    }
  } finally {
    if (imagePreview.value?.url === preview.url) imageSaving.value = false
  }
}

</script>

<template>
  <Transition name="fade">
    <div v-if="imagePreview" class="alu-image-preview-overlay" role="presentation" @click.self="closeModal" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => props.page.bindSurface('image', element)" class="alu-image-preview" role="dialog" aria-modal="true" aria-label="图片预览" tabindex="-1" @wheel="handleModalWheel">
        <button type="button" class="alu-image-preview-save" :disabled="imageSaving" @click="saveOpenImage"><FileDown :size="17" />{{ imageSaving ? '保存中…' : '保存图片' }}</button>
        <button type="button" class="alu-image-preview-close" aria-label="关闭图片预览" data-modal-initial @click="closeModal">×</button>
        <ImageZoomSurface :url="imagePreview.url" :name="imagePreview.name" @failed="markPreviewImageFailed" />
        <footer>
          <span>{{ imagePreview.name }}</span>
          <strong v-if="imageSaveStatus" :class="`is-${imageSaveStatus.tone}`" role="status">{{ imageSaveStatus.text }}</strong>
        </footer>
      </section>
    </div>
  </Transition>

</template>

<style scoped>
.alu-image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: grid;
  place-items: center;
  padding: clamp(10px, 2.5vw, 30px);
  background: rgba(2, 4, 10, .94);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  animation: dialogFadeIn .14s ease-out;
}
.alu-image-preview {
  position: relative;
  display: grid;
  width: min(1180px, 100%);
  height: min(92vh, 900px);
  height: min(92dvh, 900px);
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--alu-border-light);
  border-radius: 14px;
  outline: none;
  background: #070910;
  box-shadow: 0 30px 100px rgba(0, 0, 0, .8);
}
.alu-image-preview-save {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 3;
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: 7px;
  padding: 0 13px;
  cursor: pointer;
  border: 1px solid rgba(126, 200, 224, .45);
  border-radius: 999px;
  color: white;
  background: rgba(38, 126, 164, .9);
  box-shadow: 0 6px 20px rgba(0, 0, 0, .45);
  font: 600 11px var(--font-reading);
}
.alu-image-preview-save:disabled { cursor: wait; opacity: .65; }
.alu-image-preview-close {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1;
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 999px;
  color: white;
  background: rgba(5, 7, 12, .72);
  font-size: 22px;
  line-height: 1;
}
.alu-image-preview footer {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 13px;
  border-top: 1px solid var(--alu-border);
  color: var(--alu-text-muted);
  background: var(--alu-bg-raised);
  font-size: 10px;
}
.alu-image-preview footer span { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alu-image-preview footer strong { flex: 0 0 auto; font-weight: 600; }
.alu-image-preview footer strong.is-success { color: #82d7b5; }
.alu-image-preview footer strong.is-error { color: #f8a0a0; }
@media (max-width: 720px) {
  .alu-image-preview-overlay { padding: 0; }
  .alu-image-preview { width: 100%; height: 100vh; height: 100dvh; border: 0; border-radius: 0; }
  .alu-image-preview-save { min-height: 44px; padding-inline: 15px; }
  .alu-image-preview footer { gap: 10px; padding-bottom: max(10px, var(--aludock-inset-bottom)); }
}
.alu-image-preview-overlay {
  top: var(--aludock-inset-top);
  right: var(--aludock-inset-right);
  bottom: max(var(--aludock-inset-bottom), var(--aludock-ime-bottom));
  left: var(--aludock-inset-left);
}
</style>
