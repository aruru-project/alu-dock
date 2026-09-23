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
