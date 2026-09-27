use crate::connection_state::{
    ConnectionRuntimeState, dock_client, observation_key, resolve_connection_store,
};
use crate::errors::CommandError;
use crate::file_delivery::{
    LocalSaveResult, commit_verified_file, delivery_staging_path, describe_saved_location,
    pick_save_destination,
};
use crate::media::validate_renderable_image;
use aludock_client_core::{
    ClientError, WorkspaceFileCursor, WorkspaceFileEntry, WorkspaceFilePage,
    WorkspaceFileReadProgress, WorkspaceFileReadResult,
};
use serde::Serialize;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tauri::ipc::Response;
use tokio::sync::Notify;

pub(crate) const WORKSPACE_LARGE_FILE_CONFIRM_BYTES: u64 = 10 * 1_024 * 1_024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceReadProgressEmission {
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) instance_id: String,
    pub(crate) read_id: String,
    pub(crate) path: String,
    pub(crate) bytes_received: u64,
    pub(crate) observed_size_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEntryResult {
    pub(crate) entry: WorkspaceFileEntry,
    pub(crate) host_epoch: String,
    pub(crate) large_file_confirm_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCacheResult {
    pub(crate) cache_id: String,
    pub(crate) entry: WorkspaceFileEntry,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: String,
    pub(crate) host_epoch: String,
}

#[derive(Debug, Default)]
pub(crate) struct WorkspaceReadCancellation {
    pub(crate) cancelled: AtomicBool,
    pub(crate) notification: Notify,
}

impl WorkspaceReadCancellation {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notification.notify_waiters();
    }

    pub(crate) async fn cancelled(&self) {
        let notified = self.notification.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.cancelled.load(Ordering::Acquire) {
            notified.await;
        }
    }
}

#[derive(Clone)]
pub(crate) struct WorkspaceFileState {
    pub(crate) inner: Arc<Mutex<WorkspaceFileStateInner>>,
    pub(crate) cache_root: Arc<PathBuf>,
}

#[derive(Default)]
pub(crate) struct WorkspaceFileStateInner {
    pub(crate) active: Option<ActiveWorkspaceRead>,
    pub(crate) cache: Option<CachedWorkspaceFile>,
}

pub(crate) struct ActiveWorkspaceRead {
    pub(crate) read_id: String,
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) instance_id: String,
    pub(crate) cancellation: Arc<WorkspaceReadCancellation>,
}

#[derive(Clone)]
pub(crate) struct CachedWorkspaceFile {
    pub(crate) cache_id: String,
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) instance_id: String,
    pub(crate) runtime_generation: u64,
    pub(crate) path: String,
    pub(crate) file_path: PathBuf,
    pub(crate) result: WorkspaceFileReadResult,
}

impl WorkspaceFileState {
    pub(crate) fn open(cache_root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&cache_root)?;
        for entry in fs::read_dir(&cache_root)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(WorkspaceFileStateInner::default())),
            cache_root: Arc::new(cache_root),
        })
    }

    pub(crate) fn begin(
        &self,
        read_id: String,
        connection_id: String,
        selection_generation: u64,
        instance_id: String,
    ) -> Result<Arc<WorkspaceReadCancellation>, CommandError> {
        let cancellation = Arc::new(WorkspaceReadCancellation::default());
        let mut inner = self.inner.lock().map_err(|_| workspace_state_error())?;
        if let Some(active) = inner.active.take() {
            active.cancellation.cancel();
        }
        if let Some(cache) = inner.cache.take() {
            let _ = fs::remove_file(cache.file_path);
        }
        inner.active = Some(ActiveWorkspaceRead {
            read_id: read_id.clone(),
            connection_id,
            selection_generation,
            instance_id,
            cancellation: cancellation.clone(),
        });
        Ok(cancellation)
    }

    pub(crate) fn active_matches(&self, read_id: &str) -> Result<bool, CommandError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| workspace_state_error())?
            .active
            .as_ref()
            .is_some_and(|active| active.read_id == read_id))
    }

    pub(crate) fn finish(
        &self,
        read_id: &str,
        cache: CachedWorkspaceFile,
    ) -> Result<bool, CommandError> {
        let mut inner = self.inner.lock().map_err(|_| workspace_state_error())?;
        if !inner
            .active
            .as_ref()
            .is_some_and(|active| active.read_id == read_id)
        {
            return Ok(false);
        }
        inner.active = None;
        inner.cache = Some(cache);
        Ok(true)
    }

    pub(crate) fn finish_failed(&self, read_id: &str) {
        if let Ok(mut inner) = self.inner.lock()
            && inner
                .active
                .as_ref()
                .is_some_and(|active| active.read_id == read_id)
        {
            inner.active = None;
        }
    }

    pub(crate) fn cancel(
        &self,
        connection_id: &str,
        selection_generation: u64,
        instance_id: &str,
        read_id: &str,
    ) -> Result<bool, CommandError> {
        let inner = self.inner.lock().map_err(|_| workspace_state_error())?;
        let Some(active) = inner.active.as_ref() else {
            return Ok(false);
        };
        if active.read_id != read_id
            || active.connection_id != connection_id
            || active.selection_generation != selection_generation
            || active.instance_id != instance_id
        {
            return Ok(false);
        }
        active.cancellation.cancel();
        Ok(true)
    }

    pub(crate) fn cached(
        &self,
        connection_id: &str,
        selection_generation: u64,
        instance_id: &str,
        host_epoch: &str,
        runtime_generation: u64,
        cache_id: &str,
    ) -> Result<CachedWorkspaceFile, CommandError> {
        let inner = self.inner.lock().map_err(|_| workspace_state_error())?;
        let cache = inner.cache.as_ref().ok_or_else(workspace_cache_missing)?;
        if cache.cache_id != cache_id
            || cache.connection_id != connection_id
            || cache.selection_generation != selection_generation
            || cache.instance_id != instance_id
            || cache.result.host_epoch != host_epoch
            || cache.runtime_generation != runtime_generation
        {
            return Err(workspace_cache_missing());
        }
        Ok(cache.clone())
    }

    pub(crate) fn clear(&self) -> Result<(), CommandError> {
        let mut inner = self.inner.lock().map_err(|_| workspace_state_error())?;
        if let Some(active) = inner.active.take() {
            active.cancellation.cancel();
        }
        if let Some(cache) = inner.cache.take() {
            let _ = fs::remove_file(cache.file_path);
        }
        Ok(())
    }
}

pub(crate) fn workspace_command_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

pub(crate) fn workspace_state_error() -> CommandError {
    workspace_command_error(
        "workspace_state_unavailable",
        "工作区浏览状态暂时不可用。请关闭后重新打开。",
    )
}

pub(crate) fn workspace_cache_missing() -> CommandError {
    workspace_command_error(
        "workspace_cache_unavailable",
        "这个文件的预览已结束。请重新打开文件后再试。",
    )
}

pub(crate) fn workspace_read_cancelled() -> CommandError {
    workspace_command_error("workspace_read_cancelled", "已停止读取这个文件。")
}

pub(crate) fn workspace_client_error(error: ClientError) -> CommandError {
    match error {
        ClientError::Host { code, .. } => match code.as_str() {
            "instance_not_active" => workspace_command_error(
                "workspace_not_active",
                "这个 Work 已经结束，当前工作区无法继续浏览。",
            ),
            "workspace_entry_not_found" => workspace_command_error(
                "workspace_entry_not_found",
                "这个文件已不在工作区。请刷新所在目录。",
            ),
            "workspace_entry_not_directory" => workspace_command_error(
                "workspace_entry_not_directory",
                "这里已不再是文件夹。请返回并刷新目录。",
            ),
            "workspace_entry_not_file" => workspace_command_error(
                "workspace_entry_not_file",
                "这里已不再是可预览的文件。请返回并刷新目录。",
            ),
            "workspace_file_too_large" => workspace_command_error(
                "workspace_file_too_large",
                "这个文件超过了工作区读取上限，当前无法打开或另存为。",
            ),
            "workspace_large_file_confirmation_required" => workspace_command_error(
                "workspace_large_file_confirmation_required",
                "这个文件在读取前变大了，请确认后再继续。",
            ),
            "workspace_changed" => workspace_command_error(
                "workspace_changed",
                "这个目录刚刚发生了变化，请刷新后继续。",
            ),
            _ => workspace_command_error(
                "workspace_entry_unavailable",
                "这个工作区项目当前无法读取。请刷新或稍后重试。",
            ),
        },
        ClientError::Tls(_) | ClientError::MissingHostCertificate => workspace_command_error(
            "workspace_connection_failed",
            "读取工作区时连接中断了。请检查连接后重试。",
        ),
        ClientError::Io(_) => workspace_command_error(
            "workspace_read_interrupted",
            "没有完整读取这个文件。请检查连接和设备可用空间后重试。",
        ),
        ClientError::Protocol(_) | ClientError::Json(_) => workspace_command_error(
            "workspace_verification_failed",
            "没有完整取得这个文件。请刷新目录后重试。",
        ),
        other => CommandError::from(other),
    }
}

pub(crate) fn workspace_entry_identity_matches(
    left: &WorkspaceFileEntry,
    right: &WorkspaceFileEntry,
) -> bool {
    left.path == right.path
        && left.name == right.name
        && left.kind == right.kind
        && left.hidden == right.hidden
        && left.target_kind == right.target_kind
}

pub(crate) fn workspace_cache_staging_path(
    state: &WorkspaceFileState,
    read_id: &str,
) -> Result<PathBuf, CommandError> {
    let path = state
        .cache_root
        .join(format!(".aludock-workspace-{read_id}.part"));
    if path.exists() {
        return Err(workspace_state_error());
    }
    Ok(path)
}

pub(crate) fn create_workspace_cache_file(path: &PathBuf) -> Result<std::fs::File, CommandError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| {
        workspace_command_error(
            "workspace_storage_unavailable",
            "暂时无法读取这个文件。请检查设备可用空间后重试。",
        )
    })
}

#[tauri::command]
pub(crate) async fn workspace_entries(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    path: String,
    cursor: Option<WorkspaceFileCursor>,
) -> Result<WorkspaceFilePage, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)?;
    let page = client
        .list_workspace_entries(&instance_id, &path, cursor.as_ref())
        .await
        .map_err(workspace_client_error)?;
    content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)?;
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    if page.host_epoch.as_deref() != Some(expected_host_epoch.as_str()) {
        return Err(workspace_command_error(
            "workspace_context_changed",
            "Host 已重新连接，请重新打开工作区。",
        ));
    }
    Ok(page)
}

#[tauri::command]
pub(crate) async fn workspace_entry_metadata(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    path: String,
) -> Result<WorkspaceEntryResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)?;
    let (entry, host_epoch) = client
        .get_workspace_entry(&instance_id, &path)
        .await
        .map_err(workspace_client_error)?;
    content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)?;
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    if host_epoch != expected_host_epoch {
        return Err(workspace_command_error(
            "workspace_context_changed",
            "Host 已重新连接，请重新打开工作区。",
        ));
    }
    Ok(WorkspaceEntryResult {
        entry,
        host_epoch,
        large_file_confirm_bytes: WORKSPACE_LARGE_FILE_CONFIRM_BYTES,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn read_workspace_file(
    app: tauri::AppHandle,
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, WorkspaceFileState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    read_id: String,
    expected_entry: WorkspaceFileEntry,
    large_file_confirmed: bool,
) -> Result<WorkspaceCacheResult, CommandError> {
    if uuid::Uuid::parse_str(&read_id).is_err() {
        return Err(workspace_command_error(
            "workspace_read_invalid",
            "无法开始读取这个文件。请重新选择。",
        ));
    }
    expected_entry.validate().map_err(workspace_client_error)?;
    if !expected_entry.is_file() {
        return Err(workspace_command_error(
            "workspace_entry_not_file",
            "请选择一个可以读取的文件。",
        ));
    }
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)?;
    let (current_entry, metadata_epoch) = client
        .get_workspace_entry(&instance_id, &expected_entry.path)
        .await
        .map_err(workspace_client_error)?;
    if metadata_epoch != expected_host_epoch || current_entry != expected_entry {
        return Err(workspace_command_error(
            "workspace_changed",
            "这个文件刚刚发生了变化，请重新打开。",
        ));
    }
    if current_entry.size_bytes.unwrap_or_default() > WORKSPACE_LARGE_FILE_CONFIRM_BYTES
        && !large_file_confirmed
    {
        return Err(workspace_command_error(
            "workspace_large_file_confirmation_required",
            "这个文件较大，请确认后再读取。",
        ));
    }

    let cancellation = state.begin(
        read_id.clone(),
        connection_id.clone(),
        selection_generation,
        instance_id.clone(),
    )?;
    let staging_path = match workspace_cache_staging_path(&state, &read_id) {
        Ok(path) => path,
        Err(error) => {
            state.finish_failed(&read_id);
            return Err(error);
        }
    };
    let staging_file = match create_workspace_cache_file(&staging_path) {
        Ok(file) => file,
        Err(error) => {
            state.finish_failed(&read_id);
            return Err(error);
        }
    };
    let mut staging_file = tokio::fs::File::from_std(staging_file);
    let progress_app = app.clone();
    let progress_host = connection_id.clone();
    let progress_instance = instance_id.clone();
    let progress_path = expected_entry.path.clone();
    let progress_read_id = read_id.clone();
    let read = client.read_workspace_file(
        &instance_id,
        &expected_entry.path,
        &mut staging_file,
        move |ready| {
            if ready.size_bytes.unwrap_or_default() > WORKSPACE_LARGE_FILE_CONFIRM_BYTES
                && !large_file_confirmed
            {
                return Err(ClientError::Host {
                    code: "workspace_large_file_confirmation_required".into(),
                    message: "workspace file grew beyond the confirmed preview size".into(),
                    retryable: false,
                    details: None,
                });
            }
            Ok(())
        },
        move |WorkspaceFileReadProgress {
                  bytes_received,
                  observed_size_bytes,
              }| {
            let _ = progress_app.emit(
                "aludock://workspace-read-progress",
                WorkspaceReadProgressEmission {
                    connection_id: progress_host.clone(),
                    selection_generation,
                    instance_id: progress_instance.clone(),
                    read_id: progress_read_id.clone(),
                    path: progress_path.clone(),
                    bytes_received,
                    observed_size_bytes,
                },
            );
        },
    );
    let result = tokio::select! {
        result = read => result.map_err(workspace_client_error),
        _ = cancellation.cancelled() => Err(workspace_read_cancelled()),
    };
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            drop(staging_file);
            let _ = fs::remove_file(&staging_path);
            state.finish_failed(&read_id);
            return Err(error);
        }
    };
    if let Err(error) = content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)
    {
        drop(staging_file);
        let _ = fs::remove_file(&staging_path);
        state.finish_failed(&read_id);
        return Err(error);
    }
    if cancellation.cancelled.load(Ordering::Acquire)
        || !state.active_matches(&read_id)?
        || result.host_epoch != expected_host_epoch
        || !workspace_entry_identity_matches(&result.entry, &expected_entry)
        || result.size_bytes > aludock_client_core::MAX_WORKSPACE_FILE_BYTES
    {
        drop(staging_file);
        let _ = fs::remove_file(&staging_path);
        state.finish_failed(&read_id);
        return Err(workspace_read_cancelled());
    }
    if staging_file.sync_all().await.is_err() {
        drop(staging_file);
        let _ = fs::remove_file(&staging_path);
        state.finish_failed(&read_id);
        return Err(workspace_command_error(
            "workspace_storage_unavailable",
            "没有完整保存预览缓存。请检查设备可用空间后重试。",
        ));
    }
    drop(staging_file);
    if let Err(error) = resolve_connection_store(&runtime, &connection_id, selection_generation) {
        let _ = fs::remove_file(&staging_path);
        state.finish_failed(&read_id);
        return Err(error);
    }
    let cache_path = state
        .cache_root
        .join(format!(".aludock-workspace-{read_id}.cache"));
    if tokio::fs::rename(&staging_path, &cache_path).await.is_err() {
        let _ = fs::remove_file(&staging_path);
        state.finish_failed(&read_id);
        return Err(workspace_command_error(
            "workspace_storage_unavailable",
            "没有完整保存预览缓存。请检查设备可用空间后重试。",
        ));
    }
    let cache = CachedWorkspaceFile {
        cache_id: read_id.clone(),
        connection_id,
        selection_generation,
        instance_id,
        runtime_generation: expected_runtime_generation,
        path: result.entry.path.clone(),
        file_path: cache_path.clone(),
        result: result.clone(),
    };
    if !state.finish(&read_id, cache)? {
        let _ = fs::remove_file(cache_path);
        return Err(workspace_read_cancelled());
    }
    Ok(WorkspaceCacheResult {
        cache_id: read_id,
        entry: result.entry,
        size_bytes: result.size_bytes,
        sha256: result.sha256,
        host_epoch: result.host_epoch,
    })
}

#[tauri::command]
pub(crate) fn cancel_workspace_file_read(
    state: tauri::State<'_, WorkspaceFileState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    read_id: String,
) -> Result<bool, CommandError> {
    state.cancel(&connection_id, selection_generation, &instance_id, &read_id)
}

#[tauri::command]
pub(crate) fn clear_workspace_file_state(
    state: tauri::State<'_, WorkspaceFileState>,
) -> Result<(), CommandError> {
    state.clear()
}

pub(crate) fn cached_workspace_file(
    state: &WorkspaceFileState,
    connection_id: &str,
    selection_generation: u64,
    instance_id: &str,
    expected_host_epoch: &str,
    expected_runtime_generation: u64,
    cache_id: &str,
) -> Result<CachedWorkspaceFile, CommandError> {
    let cache = state.cached(
        connection_id,
        selection_generation,
        instance_id,
        expected_host_epoch,
        expected_runtime_generation,
        cache_id,
    )?;
    if !cache.file_path.is_file() || cache.path != cache.result.entry.path {
        return Err(workspace_cache_missing());
    }
    Ok(cache)
}

#[tauri::command]
pub(crate) async fn workspace_cached_text(
    state: tauri::State<'_, WorkspaceFileState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    cache_id: String,
) -> Result<String, CommandError> {
    let cache = cached_workspace_file(
        &state,
        &connection_id,
        selection_generation,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        &cache_id,
    )?;
    let mut bytes = tokio::fs::read(cache.file_path)
        .await
        .map_err(|_| workspace_cache_missing())?;
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        bytes.drain(..3);
    }
    if bytes.contains(&0) {
        return Err(workspace_command_error(
            "workspace_preview_unsupported",
            "这个文件不是可显示的 UTF-8 文本，可以将原文件另存到设备。",
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        workspace_command_error(
            "workspace_preview_unsupported",
            "这个文件不是可显示的 UTF-8 文本，可以将原文件另存到设备。",
        )
    })
}

#[tauri::command]
pub(crate) async fn workspace_cached_image(
    state: tauri::State<'_, WorkspaceFileState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    cache_id: String,
) -> Result<Response, CommandError> {
    let cache = cached_workspace_file(
        &state,
        &connection_id,
        selection_generation,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        &cache_id,
    )?;
    let bytes = tokio::fs::read(cache.file_path)
        .await
        .map_err(|_| workspace_cache_missing())?;
    validate_renderable_image(&bytes, None)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub(crate) async fn save_workspace_cached_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceFileState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    cache_id: String,
) -> Result<LocalSaveResult, CommandError> {
    let cache = cached_workspace_file(
        &state,
        &connection_id,
        selection_generation,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        &cache_id,
    )?;
    let Some(destination) = pick_save_destination(&app, &cache.result.entry.name).await? else {
        return Ok(LocalSaveResult::Cancelled);
    };
    let saved_location = describe_saved_location(&destination, &cache.result.entry.name)?;
    let staging_path = delivery_staging_path(&app, Some(&destination))?;
    let source_path = cache.file_path.clone();
    let expected_size = cache.result.size_bytes;
    let copy_path = staging_path.clone();
    let copied = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut source = std::fs::File::open(source_path)?;
        let mut target = create_workspace_cache_file(&copy_path)
            .map_err(|error| std::io::Error::other(error.message))?;
        let bytes = std::io::copy(&mut source, &mut target)?;
        if bytes != expected_size {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "cached workspace byte count changed",
            ));
        }
        target.flush()?;
        target.sync_all()
    })
    .await
    .map_err(|_| workspace_state_error())?;
    if copied.is_err() {
        let _ = fs::remove_file(&staging_path);
        return Err(workspace_command_error(
            "workspace_save_failed",
            "无法保存到所选位置。请检查可用空间和存储权限后重试。",
        ));
    }
    commit_verified_file(&app, staging_path, destination).await?;
    Ok(LocalSaveResult::Saved {
        label: saved_location.label,
    })
}
