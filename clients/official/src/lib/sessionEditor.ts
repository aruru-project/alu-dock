import type { AttachmentDto } from './types'

export interface SessionEditorState {
  text: string
  attachments: AttachmentDto[]
  restoredImageCount: number
}

/** Session 成功替换或重载后，旧 Session 的编辑器内容不进入新上下文。 */
export function editorAfterSessionReplacement(returnedText?: string): SessionEditorState {
  return {
    text: returnedText ?? '',
    attachments: [],
    restoredImageCount: 0,
  }
}
