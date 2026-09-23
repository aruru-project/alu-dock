import type { AttachmentDto, ConnectionContext, LocalAttachmentUpload, QueueItem, Work } from './types'

export function attachmentUploadTarget(work: Work, context: ConnectionContext): LocalAttachmentUpload {
  return {
    ...context,
    instanceId: work.id,
    machineHostId: work.hostId ?? context.connectionId,
    ownerHostEpoch: work.ownerHostEpoch ?? '',
    runtimeGeneration: work.runtimeGeneration,
  }
}

export function attachmentUploadMatches(left: LocalAttachmentUpload | undefined, right: LocalAttachmentUpload): boolean {
  return !!left
    && left.connectionId === right.connectionId
    && left.instanceId === right.instanceId
    && left.machineHostId === right.machineHostId
    && left.ownerHostEpoch === right.ownerHostEpoch
    && left.runtimeGeneration === right.runtimeGeneration
}

export function bindLocalAttachment(attachment: AttachmentDto, jobId: string, target: LocalAttachmentUpload): AttachmentDto {
  return { ...attachment, localUpload: { ...target, jobId } }
}

export function attachmentsAfterSubmit(
  current: AttachmentDto[],
  capturedFileIds: readonly string[],
  succeeded: boolean,
): AttachmentDto[] {
  if (!succeeded) return current
  const captured = new Set(capturedFileIds)
  return current.filter((item) => !captured.has(item.fileId))
}

export function moveAttachmentPreviewResource<T extends { url: string }>(
  current: Record<string, T>,
  from: string,
  to: string,
): { resources: Record<string, T>; moved?: T } {
  const moved = current[from]
  if (!moved || from === to) return { resources: current }
  const resources = { ...current }
  delete resources[from]
  resources[to] = moved
  return { resources, moved }
}

export function prependRestoredQueue(
  currentText: string,
  currentAttachments: AttachmentDto[],
  restored: QueueItem[],
) {
  const restoredText = restored.map((item) => item.text).filter((text) => text.length > 0).join('\n\n')
  const text = restoredText ? [restoredText, currentText].filter(Boolean).join('\n\n') : currentText
  const attachments = [...currentAttachments]
  const seen = new Set(attachments.map((item) => item.fileId))
  for (const item of restored) {
    for (const attachment of item.attachments) {
      if (!seen.has(attachment.fileId)) {
        attachments.push(attachment)
        seen.add(attachment.fileId)
      }
    }
  }
  return {
    text,
    attachments,
  }
}
