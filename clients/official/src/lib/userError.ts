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
  'workspace_storage_unavailable', 'workspace_verification_failed', 'workspace_state_unavailable',
  'workspace_cache_unavailable', 'workspace_read_cancelled', 'workspace_read_invalid',
  'workspace_large_file_confirmation_required', 'workspace_preview_unsupported',
  'workspace_save_failed',
])

export function userErrorMessage(cause: unknown, fallback = '操作没有完成。请刷新状态后重试。') {
  if (cause && typeof cause === 'object') {
    const code = 'code' in cause ? String(cause.code || '') : ''
    if (code === 'protocol_error' || code === 'client_error') return '收到的数据有问题，刚才的更改未生效。请刷新状态后重试。'
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
