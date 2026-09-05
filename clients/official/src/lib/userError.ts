const SAFE_ERROR_CODES = new Set([
  'invalid_endpoint', 'pairing_timeout', 'finalization_pending', 'pairing_invalid',
  'pairing_closed', 'busy', 'wrong_pin', 'expired', 'not_found', 'invalid_request',
  'host_certificate_mismatch', 'attachment_too_large', 'attachment_source_changed',
  'attachment_upload_cancelled', 'attachment_picker_failed', 'attachment_limit_exceeded',
  'attachment_source_unavailable', 'invalid_attachment_source', 'invalid_attachment_name',
  'connection_failed', 'registry_conflict', 'profile_conflict',
  'host_not_found', 'host_already_saved', 'local_storage_unavailable', 'host_lifecycle_unavailable',
  'file_unavailable', 'deliverable_connection_failed', 'deliverable_list_failed', 'deliverable_verification_failed',
  'deliverable_write_failed', 'deliverable_commit_failed', 'deliverable_cleanup_failed', 'deliverable_picker_failed',
  'deliverable_location_unsupported', 'deliverable_location_unavailable',
  'saved_file_unavailable', 'saved_file_open_failed',
  'workspace_context_changed', 'workspace_not_active', 'workspace_entry_not_found',
  'workspace_entry_not_directory', 'workspace_entry_not_file', 'workspace_entry_unavailable',
  'workspace_file_too_large', 'workspace_changed', 'workspace_connection_failed',
  'workspace_storage_unavailable', 'workspace_read_interrupted', 'workspace_verification_failed', 'workspace_state_unavailable',
  'workspace_cache_unavailable', 'workspace_read_cancelled', 'workspace_read_invalid',
  'workspace_large_file_confirmation_required', 'workspace_preview_unsupported',
  'workspace_save_failed',
])

export interface UserErrorPresentation {
  message: string
  diagnostic?: string
}

interface DiagnosticContext {
  action: string
  request: string
}

function errorCode(cause: unknown): string {
  return cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
}

function decodingReason(cause: unknown): string {
  if (!cause || typeof cause !== 'object') return ''
  if ('details' in cause && cause.details && typeof cause.details === 'object' && 'reason' in cause.details) {
    const reason = String(cause.details.reason || '').trim()
    if (reason) return reason
  }
  return 'message' in cause ? String(cause.message || '').trim() : ''
}

export function userErrorMessage(cause: unknown, fallback = '操作没有完成。请刷新状态后重试。') {
  if (cause && typeof cause === 'object') {
    const code = errorCode(cause)
    if (code === 'protocol_error') return '收到的数据无法识别。请刷新当前内容后重试。'
    if (code === 'client_error') return '客户端无法完成数据处理。请刷新当前内容后重试。'
    if (code === 'effect_unknown' || ('outcomeUnknown' in cause && cause.outcomeUnknown === true)) return '还无法确认刚才的操作是否完成。请刷新状态后确认，不要重复提交。'
    if (code === 'instance_host_lost') return '这个 Work 的运行连接已经中断。请从工作列表继续，或刷新状态。'
    if (code === 'invalid_tree_target') return '这个节点已不在当前 Session 中。请重新打开 Session Tree 后再选择。'
    if (code === 'host_unreachable') return '无法连接这台 AluDock。请检查电脑状态、网络和保存的地址，然后重试。'
    if ('message' in cause && (!code || SAFE_ERROR_CODES.has(code))) {
      const message = String(cause.message || '').trim()
      if (message) return message
    }
    return fallback
  }
  return fallback
}

export function userErrorPresentation(
  cause: unknown,
  fallback?: string,
  diagnosticContext?: DiagnosticContext,
): UserErrorPresentation {
  const code = errorCode(cause)
  if (!diagnosticContext || (code !== 'protocol_error' && code !== 'client_error')) {
    return { message: userErrorMessage(cause, fallback) }
  }

  const message = code === 'protocol_error'
    ? `${diagnosticContext.action}时，收到的数据无法识别。请重试。`
    : `${diagnosticContext.action}时，客户端无法完成数据处理。请重试。`
  const reason = decodingReason(cause)
  if (!reason) return { message }
  return {
    message,
    diagnostic: [
      `操作：${diagnosticContext.action}`,
      `请求：${diagnosticContext.request}`,
      `错误代码：${code}`,
      `原因：${reason}`,
    ].join('\n'),
  }
}
