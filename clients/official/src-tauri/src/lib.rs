#[cfg(target_os = "android")]
mod android_documents;
mod desktop_shell;

#[cfg(any(target_os = "windows", test))]
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::time::Instant;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[cfg(target_os = "android")]
use std::io::Read;

#[cfg(any(target_os = "windows", test))]
use aludock_client_core::InstanceExecution;
use aludock_client_core::{
    AttachmentDto, AttachmentUploadCancellation, AttachmentUploadPhase, AttachmentUploadResult,
    ClientError, ClientPreferences, ClientPreferencesStore, CommandArgumentCompletion,
    CommandCompletionItems, CommandCompletionsResult, CommandContentResult, CommandInfo,
    CommandReference, CommandsResult, CompletedConversationEntry, ConnectionKind, ConnectionPolicy,
    ConnectionRouter, ControllerEventData, ConversationPreviewPage, DeliverableDownloadProgress,
    DeliverableDto, DeliveryMode, DiagnosticInfo, DockClient, Endpoint, EndpointState,
    EndpointTestResult, EventCursor, ExtensionControllerLease, ExtensionEvent, HistoryRecord,
    HostConnectionProfile, HostRegistry, HostRegistrySnapshot, IdentityStore, ImagePath,
    InstanceCatalog, InstanceSelector, InstanceSnapshot, InteractionMethod, InteractionRequest,
    InteractionResponse, LocalDockEndpoint, Machine, ModelsResult, NavigateOptions,
    PairingProgress, PendingMessage, ProjectTrustDecision, PublishedFileDto, QueueDequeueResult,
    ReadReplay, ResourceInfo, ResourcesResult, SessionCompactionResult, SessionForkResult,
    SessionNameResult, SessionNavigateResult, SessionReloadResult, SessionReplacementResult,
    SessionScope, SessionTree, SettingUpdate, SettingUpdateResult, SettingsResult, SourceInfo,
    StopResult, SubmitResult, ThinkingLevel, ToolInfo, ToolsResult, WindowsAwayDelay,
    WorkspaceCursor, WorkspaceFileCursor, WorkspaceFileEntry, WorkspaceFilePage,
    WorkspaceFileReadProgress, WorkspaceFileReadResult, WorkspacePage, delete_endpoint,
    probe_host_endpoint, record_endpoint_test, reorder_endpoints, save_unverified_endpoint,
    save_verified_endpoint, saved_endpoint_for_test,
    set_connection_policy as update_connection_policy, set_endpoint_enabled, validate_device_name,
    validate_host_id,
};
use aludock_client_core::{MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    Emitter, Manager,
    ipc::{Channel, InvokeBody, Request, Response},
};
#[cfg(not(target_os = "android"))]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::FilePath;
use tauri_plugin_fs::{FsExt, OpenOptions as PluginOpenOptions};
#[cfg(target_os = "windows")]
use tauri_plugin_notification::NotificationExt;
#[cfg(not(target_os = "android"))]
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Notify;

const MAX_RENDERABLE_IMAGE_BYTES: u64 = 64 * 1_024 * 1_024;
const RENDER_IMAGE_IPC_CHUNK_BYTES: usize = 256 * 1_024;
const WORKSPACE_LARGE_FILE_CONFIRM_BYTES: u64 = 10 * 1_024 * 1_024;
#[cfg(target_os = "windows")]
const AWAY_POLL_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    connection_id: String,
    selection_generation: u64,
    max_attachments_per_message: usize,
    host: HostSummary,
    works: Vec<InstanceSnapshot>,
    total: u64,
    hidden_stopped: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkCatalogPayload {
    connection_id: String,
    selection_generation: u64,
    host_epoch: String,
    instances: Vec<InstanceSnapshot>,
    total: u64,
    hidden_stopped: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCatalogEntry {
    host_id: String,
    display_name: String,
    device_name: String,
    endpoint_summary: String,
    added_at: String,
    profile: HostConnectionProfile,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCatalog {
    schema_version: u32,
    revision: u64,
    active_target: Option<ConnectionTarget>,
    local_endpoint_override: Option<String>,
    local_endpoint_effective: Option<String>,
    selection_generation: u64,
    local_connection_supported: bool,
    hosts: Vec<HostCatalogEntry>,
    pairing_transaction_ids: Vec<String>,
    pairing_transactions: Vec<RecoverablePairing>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverablePairing {
    transaction_id: String,
    host: Option<String>,
    port: Option<u16>,
    device_name: Option<String>,
    recoverable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSummary {
    state: String,
    host_epoch: String,
    dock_version: String,
    pi_sdk_version: String,
    started_at: String,
    profile: Option<HostConnectionProfile>,
    active_endpoint_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationBootstrap {
    instance: InstanceSnapshot,
    records: Vec<HistoryRecord>,
    active_events: Vec<ProjectedEvent>,
    extension_ui: ExtensionBootstrap,
    queue: Vec<ProjectedQueueItem>,
    cursor: EventCursor,
    history_revision: u64,
    history_truncated: bool,
    history_before_entry_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionBootstrap {
    status: std::collections::BTreeMap<String, String>,
    tools_expanded: bool,
    active_interaction: Option<aludock_client_core::ActiveInteraction>,
    events: Vec<ProjectedEvent>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectedEvent {
    sequence: u64,
    runtime_generation: u64,
    occurred_at: String,
    event_type: String,
    data: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectedQueueItem {
    queue_item_id: String,
    delivery: String,
    text: String,
    attachments: Vec<AttachmentDto>,
    image_count: usize,
    accepted_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeQueueDequeueReceipt {
    instance_id: String,
    restored: Vec<ProjectedQueueItem>,
    in_flight: Vec<ProjectedQueueItem>,
}

#[derive(Serialize)]
struct SafeQueueDequeueResult {
    receipt: SafeQueueDequeueReceipt,
    instance: InstanceSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoredImageCount {
    image_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedAttachment {
    token: String,
    name: String,
    size_bytes: u64,
    media_type: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentProgressEmission {
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    machine_host_id: String,
    owner_host_epoch: String,
    runtime_generation: u64,
    token: String,
    phase: String,
    bytes_processed: u64,
    total_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliverableProgressEmission {
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    delivery_ref: String,
    bytes_received: u64,
    total_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedDeliverableLocation {
    kind: String,
    value: String,
    label: String,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum DeliverableSaveResult {
    Cancelled,
    Saved {
        deliverable: DeliverableDto,
        location: SavedDeliverableLocation,
        sha256: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceReadProgressEmission {
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    read_id: String,
    path: String,
    bytes_received: u64,
    observed_size_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntryResult {
    entry: WorkspaceFileEntry,
    host_epoch: String,
    large_file_confirm_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCacheResult {
    cache_id: String,
    entry: WorkspaceFileEntry,
    size_bytes: u64,
    sha256: String,
    host_epoch: String,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum LocalSaveResult {
    Cancelled,
    Saved { label: String },
}

#[derive(Debug, Default)]
struct WorkspaceReadCancellation {
    cancelled: AtomicBool,
    notification: Notify,
}

impl WorkspaceReadCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notification.notify_waiters();
    }

    async fn cancelled(&self) {
        let notified = self.notification.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.cancelled.load(Ordering::Acquire) {
            notified.await;
        }
    }
}

#[derive(Clone)]
struct WorkspaceFileState {
    inner: Arc<Mutex<WorkspaceFileStateInner>>,
    cache_root: Arc<PathBuf>,
}

#[derive(Default)]
struct WorkspaceFileStateInner {
    active: Option<ActiveWorkspaceRead>,
    cache: Option<CachedWorkspaceFile>,
}

struct ActiveWorkspaceRead {
    read_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    cancellation: Arc<WorkspaceReadCancellation>,
}

#[derive(Clone)]
struct CachedWorkspaceFile {
    cache_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    runtime_generation: u64,
    path: String,
    file_path: PathBuf,
    result: WorkspaceFileReadResult,
}

impl WorkspaceFileState {
    fn open(cache_root: PathBuf) -> std::io::Result<Self> {
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

    fn begin(
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

    fn active_matches(&self, read_id: &str) -> Result<bool, CommandError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| workspace_state_error())?
            .active
            .as_ref()
            .is_some_and(|active| active.read_id == read_id))
    }

    fn finish(&self, read_id: &str, cache: CachedWorkspaceFile) -> Result<bool, CommandError> {
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

    fn finish_failed(&self, read_id: &str) {
        if let Ok(mut inner) = self.inner.lock()
            && inner
                .active
                .as_ref()
                .is_some_and(|active| active.read_id == read_id)
        {
            inner.active = None;
        }
    }

    fn cancel(
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

    fn cached(
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

    fn clear(&self) -> Result<(), CommandError> {
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

#[derive(Clone, Default)]
struct AttachmentState {
    entries: Arc<Mutex<HashMap<String, NativeAttachment>>>,
}

struct NativeAttachment {
    path: PathBuf,
    temporary: bool,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    operation_id: String,
    name: String,
    size_bytes: u64,
    media_type: Option<String>,
    upload_scope: Option<AttachmentUploadScope>,
    active_attempt: Option<AttachmentAttempt>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AttachmentUploadScope {
    machine_host_id: String,
    owner_host_epoch: String,
    runtime_generation: u64,
}

struct AttachmentAttempt {
    id: String,
    cancellation: AttachmentUploadCancellation,
}

impl Drop for NativeAttachment {
    fn drop(&mut self) {
        if self.temporary {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl AttachmentState {
    fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            for entry in entries.values() {
                if let Some(attempt) = &entry.active_attempt {
                    attempt.cancellation.cancel();
                }
            }
            entries.clear();
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RestoredImageScope {
    connection_id: String,
    selection_generation: u64,
    work_id: String,
}

#[derive(Clone)]
struct RestoredImageBatch {
    token: String,
    images: Vec<ImagePath>,
}

#[derive(Clone, Default)]
struct RestoredImageBucket {
    batches: Vec<RestoredImageBatch>,
}

#[derive(Clone)]
struct RestoredImageCapture {
    tokens: Vec<String>,
    images: Vec<ImagePath>,
}

#[derive(Clone, Default)]
struct RestoredImageState {
    buckets: Arc<Mutex<HashMap<RestoredImageScope, RestoredImageBucket>>>,
}

impl RestoredImageState {
    fn append(&self, scope: RestoredImageScope, images: Vec<ImagePath>) -> usize {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !images.is_empty() {
            buckets
                .entry(scope.clone())
                .or_default()
                .batches
                .push(RestoredImageBatch {
                    token: uuid::Uuid::new_v4().to_string(),
                    images,
                });
        }
        buckets.get(&scope).map_or(0, |bucket| {
            bucket.batches.iter().map(|batch| batch.images.len()).sum()
        })
    }

    fn capture(&self, scope: &RestoredImageScope) -> Option<RestoredImageCapture> {
        let buckets = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let bucket = buckets.get(scope)?;
        let capture = RestoredImageCapture {
            tokens: bucket
                .batches
                .iter()
                .map(|batch| batch.token.clone())
                .collect(),
            images: bucket
                .batches
                .iter()
                .flat_map(|batch| batch.images.iter().cloned())
                .collect(),
        };
        (!capture.images.is_empty()).then_some(capture)
    }

    fn clear_after_success(&self, scope: &RestoredImageScope, tokens: &[String]) {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let remove_bucket = if let Some(bucket) = buckets.get_mut(scope) {
            bucket
                .batches
                .retain(|batch| !tokens.iter().any(|token| token == &batch.token));
            bucket.batches.is_empty()
        } else {
            false
        };
        if remove_bucket {
            buckets.remove(scope);
        }
    }

    fn clear_scope(&self, scope: &RestoredImageScope) -> usize {
        self.buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(scope)
            .map_or(0, |bucket| {
                bucket.batches.iter().map(|batch| batch.images.len()).sum()
            })
    }

    fn rebind_generation(&self, connection_id: &str, old_generation: u64, new_generation: u64) {
        if old_generation == new_generation {
            return;
        }
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let preserved = buckets
            .drain()
            .filter(|(scope, _)| {
                scope.connection_id == connection_id && scope.selection_generation == old_generation
            })
            .collect::<Vec<_>>();
        for (old_scope, bucket) in preserved {
            buckets.insert(
                RestoredImageScope {
                    connection_id: old_scope.connection_id,
                    selection_generation: new_generation,
                    work_id: old_scope.work_id,
                },
                bucket,
            );
        }
    }

    fn clear(&self) {
        self.buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeSource {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    package: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeCommand {
    reference_id: String,
    name: String,
    description: Option<String>,
    source: SafeSource,
    argument_hint: Option<String>,
    argument_completions: bool,
    content_available: bool,
}

#[derive(Serialize)]
struct SafeCommandsResult {
    commands: Vec<SafeCommand>,
    total: u64,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeCommandContentResult {
    reference_id: String,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeCommandCompletionsResult {
    reference_id: String,
    items: Option<Vec<CommandArgumentCompletion>>,
    total: u64,
    truncated: bool,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct CommandReferenceScope {
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
}

#[derive(Default)]
struct CommandReferenceEntries {
    generations: HashMap<CommandReferenceScope, u64>,
    scopes: HashMap<CommandReferenceScope, HashMap<String, CommandReference>>,
}

#[derive(Default)]
struct CommandReferenceState {
    inner: Mutex<CommandReferenceEntries>,
}

impl CommandReferenceState {
    fn begin(&self, scope: &CommandReferenceScope) -> u64 {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.generations.retain(|candidate, _| {
            candidate.connection_id != scope.connection_id
                || candidate.selection_generation == scope.selection_generation
        });
        inner.scopes.retain(|candidate, _| {
            candidate.connection_id != scope.connection_id
                || candidate.selection_generation == scope.selection_generation
        });
        let generation = inner
            .generations
            .get(scope)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        inner.generations.insert(scope.clone(), generation);
        generation
    }

    fn replace(
        &self,
        scope: CommandReferenceScope,
        generation: u64,
        references: HashMap<String, CommandReference>,
    ) -> bool {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if inner.generations.get(&scope) != Some(&generation) {
            return false;
        }
        inner.scopes.insert(scope, references);
        true
    }

    fn resolve(
        &self,
        scope: &CommandReferenceScope,
        reference_id: &str,
    ) -> Result<CommandReference, CommandError> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .scopes
            .get(scope)
            .and_then(|references| references.get(reference_id))
            .cloned()
            .ok_or_else(command_reference_expired)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeTool {
    name: String,
    description: String,
    active: bool,
    source: Option<SafeSource>,
}

#[derive(Serialize)]
struct SafeToolsResult {
    tools: Vec<SafeTool>,
    instance: InstanceSnapshot,
    total: u64,
    truncated: bool,
}

#[derive(Serialize)]
struct SafeResource {
    kind: String,
    name: String,
    source: Option<SafeSource>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeResourcesResult {
    resources: Vec<SafeResource>,
    diagnostics: Vec<SafeDiagnostic>,
    resource_total: u64,
    resources_truncated: bool,
    diagnostic_total: u64,
    diagnostics_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeSessionReload {
    instance: InstanceSnapshot,
    resources: Vec<SafeResource>,
    diagnostics: Vec<SafeDiagnostic>,
    resource_total: u64,
    resources_truncated: bool,
    diagnostic_total: u64,
    diagnostics_truncated: bool,
}

#[derive(Serialize)]
struct SafeDiagnostic {
    severity: String,
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FollowEmission {
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    subscription_id: String,
    event: ProjectedEvent,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FollowStatus {
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    subscription_id: String,
    state: String,
    message: Option<String>,
}

#[derive(Clone, Default)]
struct FollowState {
    task: Arc<Mutex<Option<FollowTask>>>,
}

struct FollowTask {
    handle: tauri::async_runtime::JoinHandle<()>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    subscription_id: String,
}

impl FollowState {
    fn abort_matching(
        &self,
        connection_id: &str,
        selection_generation: u64,
        instance_id: &str,
        subscription_id: Option<&str>,
    ) -> Result<bool, CommandError> {
        let mut guard = self.task.lock().map_err(|_| follow_state_error())?;
        let matches = guard.as_ref().is_some_and(|task| {
            task.connection_id == connection_id
                && task.selection_generation == selection_generation
                && task.instance_id == instance_id
                && subscription_id.map_or(true, |value| task.subscription_id == value)
        });
        if !matches {
            return Ok(false);
        }
        if let Some(task) = guard.take() {
            task.handle.abort();
        }
        Ok(true)
    }
}

#[derive(Clone, Default)]
struct ExtensionControlState {
    inner: Arc<Mutex<ExtensionControlInner>>,
}

#[derive(Default)]
struct ExtensionControlInner {
    binding: Option<ExtensionBinding>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Clone)]
struct ExtensionBinding {
    handle: String,
    connection_id: String,
    selection_generation: u64,
    host_epoch: String,
    instance_id: String,
    runtime_generation: u64,
    lease: ExtensionControllerLease,
    pending: Option<InteractionRequest>,
    last_viewport: Option<(u16, u16)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeControllerBinding {
    handle: String,
    connection_id: String,
    selection_generation: u64,
    host_epoch: String,
    instance_id: String,
    runtime_generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControllerEmission {
    handle: String,
    connection_id: String,
    selection_generation: u64,
    host_epoch: String,
    instance_id: String,
    runtime_generation: u64,
    event: ProjectedEvent,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControllerStatusEmission {
    handle: String,
    connection_id: String,
    selection_generation: u64,
    host_epoch: String,
    instance_id: String,
    runtime_generation: u64,
    state: String,
    message: Option<String>,
}

#[derive(Clone, Default)]
struct PairingTaskState {
    tasks: Arc<Mutex<HashMap<String, PairingTask>>>,
}

struct PairingTask {
    handle: tauri::async_runtime::JoinHandle<()>,
    cancelled: Arc<AtomicBool>,
}

fn pairing_task_matches(entry: &PairingTask, token: &Arc<AtomicBool>) -> bool {
    Arc::ptr_eq(&entry.cancelled, token) && !entry.cancelled.load(Ordering::Acquire)
}

#[derive(Clone, Default)]
struct SessionTokenState {
    registry: Arc<Mutex<SessionTokenRegistry>>,
}

#[derive(Default)]
struct SessionTokenRegistry {
    next_request: u64,
    tokens: HashMap<String, SessionTokenBinding>,
}

struct SessionTokenBinding {
    request_id: u64,
    connection_id: String,
    selection_generation: u64,
    scope: SessionTokenScope,
    session_file: String,
}

#[derive(Clone)]
enum SessionTokenScope {
    Work {
        host_epoch: String,
        instance_id: String,
        runtime_generation: u64,
    },
    Machine {
        machine_host_id: String,
        host_epoch: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeSession {
    token: String,
    name: Option<String>,
    cwd: String,
    updated_at: Option<String>,
    identity: String,
    current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeSessionList {
    sessions: Vec<SafeSession>,
    total: u64,
    truncated: bool,
    connection_id: String,
    selection_generation: u64,
    host_epoch: String,
    runtime_generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeInventorySession {
    token: String,
    name: Option<String>,
    first_user_message: Option<String>,
    cwd: String,
    updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeSessionInventory {
    sessions: Vec<SafeInventorySession>,
    total: u64,
    truncated: bool,
    incomplete: bool,
    machine_host_id: String,
    connection_id: String,
    host_epoch: String,
    selection_generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: String,
    message: String,
    details: Option<Value>,
    outcome_unknown: bool,
    operation_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingEmission {
    transaction_id: String,
    stage: String,
    pin: Option<String>,
    message: Option<String>,
    error: Option<CommandError>,
    host_id: Option<String>,
    registry_revision: Option<u64>,
    selection_generation: Option<u64>,
}

const LOCAL_CONNECTION_SCOPE_ID: &str = "local";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum ConnectionTarget {
    Local,
    Host { host_id: String },
}

impl ConnectionTarget {
    fn scope_id(&self) -> &str {
        match self {
            Self::Local => LOCAL_CONNECTION_SCOPE_ID,
            Self::Host { host_id } => host_id,
        }
    }
}

#[derive(Default)]
struct RuntimeLifecycle {
    active_target: Option<ConnectionTarget>,
    selection_generation: u64,
}

#[derive(Clone)]
struct ConnectionRuntimeState {
    registry: HostRegistry,
    preferences: ClientPreferencesStore,
    local_identity: IdentityStore,
    lifecycle: Arc<Mutex<RuntimeLifecycle>>,
    selected_client: Arc<Mutex<Option<SelectedConnectionClient>>>,
}

struct SelectedConnectionClient {
    target: ConnectionTarget,
    selection_generation: u64,
    client: DockClient,
}

impl RuntimeLifecycle {
    fn transition_to_host(&mut self, host_id: Option<String>) -> Result<u64, CommandError> {
        self.transition_to(host_id.map(|host_id| ConnectionTarget::Host { host_id }))
    }

    fn transition_to_local(&mut self) -> Result<u64, CommandError> {
        self.transition_to(Some(ConnectionTarget::Local))
    }

    fn transition_to(&mut self, target: Option<ConnectionTarget>) -> Result<u64, CommandError> {
        self.selection_generation = self
            .selection_generation
            .checked_add(1)
            .ok_or_else(lifecycle_error)?;
        self.active_target = target;
        Ok(self.selection_generation)
    }

    fn connection_id(&self) -> Option<&str> {
        self.active_target.as_ref().map(ConnectionTarget::scope_id)
    }
}

impl ConnectionRuntimeState {
    fn open(
        application_data_dir: Option<PathBuf>,
        prefer_local: bool,
    ) -> Result<Self, ClientError> {
        let registry = if let Some(path) = std::env::var_os("ALUDOCK_CLIENT_IDENTITY_DIR") {
            HostRegistry::open(PathBuf::from(path))?
        } else if let Some(path) = application_data_dir {
            HostRegistry::open(path.join("identity"))?
        } else {
            HostRegistry::platform_default()?
        };
        let preferences = ClientPreferencesStore::open(registry.root().join("client-preferences"))?;
        let local_identity = IdentityStore::new(registry.root().join("local-client-identity"));
        let mut snapshot = registry.snapshot()?;
        if prefer_local
            && snapshot.active_host_id.is_none()
            && !snapshot.local_selected
            && snapshot.hosts.is_empty()
        {
            snapshot = registry.select_local(snapshot.revision)?;
        }
        let active_target = if snapshot.local_selected {
            Some(ConnectionTarget::Local)
        } else {
            snapshot
                .active_host_id
                .map(|host_id| ConnectionTarget::Host { host_id })
        };
        Ok(Self {
            registry,
            preferences,
            local_identity,
            lifecycle: Arc::new(Mutex::new(RuntimeLifecycle {
                active_target,
                selection_generation: 1,
            })),
            selected_client: Arc::new(Mutex::new(None)),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeClientPreferences {
    revision: u64,
    windows_away_delay: WindowsAwayDelay,
    windows_away_supported: bool,
}

impl From<ClientPreferences> for SafeClientPreferences {
    fn from(value: ClientPreferences) -> Self {
        Self {
            revision: value.revision,
            windows_away_delay: value.windows_away_delay,
            windows_away_supported: cfg!(target_os = "windows"),
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct AwayCatalogContext {
    connection_id: String,
    selection_generation: u64,
    host_epoch: String,
}

#[cfg(target_os = "windows")]
struct AwayCatalogSnapshot {
    context: AwayCatalogContext,
    instances: Vec<AwayInstanceState>,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct AwayInstanceState {
    instance_id: String,
    display_name: String,
    execution: InstanceExecution,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct AwayCompletion {
    instance_id: String,
    display_name: String,
}

#[cfg(any(target_os = "windows", test))]
struct AwayCompletionTracker {
    executions: HashMap<String, InstanceExecution>,
    pending: HashMap<String, String>,
}

#[cfg(any(target_os = "windows", test))]
impl AwayCompletionTracker {
    #[cfg_attr(test, allow(dead_code))]
    fn from_instances(instances: &[AwayInstanceState]) -> Self {
        Self {
            executions: instances
                .iter()
                .map(|instance| (instance.instance_id.clone(), instance.execution))
                .collect(),
            pending: HashMap::new(),
        }
    }

    fn from_running_instance_ids(instance_ids: &[String]) -> Self {
        Self {
            executions: instance_ids
                .iter()
                .map(|instance_id| (instance_id.clone(), InstanceExecution::Running))
                .collect(),
            pending: HashMap::new(),
        }
    }

    fn observe(&mut self, instances: &[AwayInstanceState]) {
        for instance in instances {
            let previous = self
                .executions
                .insert(instance.instance_id.clone(), instance.execution);
            if previous == Some(InstanceExecution::Running)
                && instance.execution == InstanceExecution::Idle
            {
                self.pending
                    .insert(instance.instance_id.clone(), instance.display_name.clone());
            }
        }
    }

    fn take_ready(&mut self, away_for: Duration, grace: Duration) -> Vec<AwayCompletion> {
        if away_for < grace {
            return Vec::new();
        }
        let mut completions = self
            .pending
            .drain()
            .map(|(instance_id, display_name)| AwayCompletion {
                instance_id,
                display_name,
            })
            .collect::<Vec<_>>();
        completions.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        completions
    }
}

#[derive(Clone, Default)]
struct AwayMonitorState {
    task: Arc<Mutex<Option<AwayMonitorTask>>>,
}

struct AwayMonitorTask {
    away_id: String,
    monitor_handle: tauri::async_runtime::JoinHandle<()>,
    grace_handle: tauri::async_runtime::JoinHandle<()>,
    cancelled: Arc<AtomicBool>,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsAwayElapsed {
    away_id: String,
}

impl AwayMonitorTask {
    fn cancel(self) {
        self.cancelled.store(true, Ordering::Release);
        self.monitor_handle.abort();
        self.grace_handle.abort();
    }
}

impl AwayMonitorState {
    #[cfg(target_os = "windows")]
    fn start(
        &self,
        app: tauri::AppHandle,
        runtime: ConnectionRuntimeState,
        away_id: String,
        grace: Duration,
        running_instance_ids: Vec<String>,
    ) -> Result<(), CommandError> {
        let mut guard = self.task.lock().map_err(|_| away_monitor_error())?;
        if let Some(previous) = guard.take() {
            previous.cancel();
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let monitor_cancelled = cancelled.clone();
        let monitor_app = app.clone();
        let monitor_handle = tauri::async_runtime::spawn(async move {
            monitor_while_away(
                monitor_app,
                runtime,
                monitor_cancelled,
                grace,
                running_instance_ids,
            )
            .await;
        });
        let grace_cancelled = cancelled.clone();
        let elapsed_away_id = away_id.clone();
        let grace_handle = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(grace).await;
            if !grace_cancelled.load(Ordering::Acquire) {
                let _ = app.emit(
                    "aludock://windows-away-elapsed",
                    WindowsAwayElapsed {
                        away_id: elapsed_away_id,
                    },
                );
            }
        });
        *guard = Some(AwayMonitorTask {
            away_id,
            monitor_handle,
            grace_handle,
            cancelled,
        });
        Ok(())
    }

    fn stop(&self, away_id: Option<&str>) -> Result<bool, CommandError> {
        let mut guard = self.task.lock().map_err(|_| away_monitor_error())?;
        if !guard
            .as_ref()
            .is_some_and(|task| away_id.is_none_or(|expected| task.away_id == expected))
        {
            return Ok(false);
        }
        if let Some(task) = guard.take() {
            task.cancel();
        }
        Ok(true)
    }
}

fn away_monitor_error() -> CommandError {
    CommandError {
        code: "away_monitor_unavailable".into(),
        message: "暂离状态暂时无法更新，请重新打开应用。".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

#[cfg(target_os = "windows")]
async fn read_away_catalog(
    runtime: &ConnectionRuntimeState,
) -> Result<Option<AwayCatalogSnapshot>, CommandError> {
    let (connection_id, selection_generation) = {
        let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
        let Some(connection_id) = lifecycle
            .active_target
            .as_ref()
            .map(|target| target.scope_id().to_owned())
        else {
            return Ok(None);
        };
        (connection_id, lifecycle.selection_generation)
    };
    let store = resolve_connection_store(runtime, &connection_id, selection_generation)?;
    let (catalog, host_epoch) =
        dock_client(&runtime, &connection_id, selection_generation, &store)?
            .list_instances_with_host_epoch(InstanceSelector::All)
            .await
            .map_err(CommandError::from)?;
    {
        let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
        ensure_connection_selection(&lifecycle, &connection_id, selection_generation)?;
    }
    Ok(Some(AwayCatalogSnapshot {
        context: AwayCatalogContext {
            connection_id,
            selection_generation,
            host_epoch,
        },
        instances: catalog
            .instances
            .into_iter()
            .map(|instance| AwayInstanceState {
                instance_id: instance.id,
                display_name: instance.display_name,
                execution: instance.execution,
            })
            .collect(),
    }))
}

#[cfg(target_os = "windows")]
async fn monitor_while_away(
    app: tauri::AppHandle,
    runtime: ConnectionRuntimeState,
    cancelled: Arc<AtomicBool>,
    grace: Duration,
    running_instance_ids: Vec<String>,
) {
    let started_at = Instant::now();
    let mut context: Option<AwayCatalogContext> = None;
    let mut tracker: Option<AwayCompletionTracker> = None;

    loop {
        if cancelled.load(Ordering::Acquire) {
            return;
        }
        if let Ok(snapshot) = read_away_catalog(&runtime).await {
            match snapshot {
                Some(snapshot) if context.as_ref() == Some(&snapshot.context) => {
                    if let Some(tracker) = tracker.as_mut() {
                        tracker.observe(&snapshot.instances);
                    }
                }
                Some(snapshot) => {
                    let mut next = if context.is_none() {
                        AwayCompletionTracker::from_running_instance_ids(&running_instance_ids)
                    } else {
                        AwayCompletionTracker::from_instances(&snapshot.instances)
                    };
                    if context.is_none() {
                        next.observe(&snapshot.instances);
                    }
                    tracker = Some(next);
                    context = Some(snapshot.context);
                }
                None => {
                    tracker = None;
                    context = None;
                }
            }
        }

        if !cancelled.load(Ordering::Acquire)
            && let Some(tracker) = tracker.as_mut()
        {
            show_away_completions(&app, tracker.take_ready(started_at.elapsed(), grace));
        }
        tokio::time::sleep(AWAY_POLL_INTERVAL).await;
    }
}

#[cfg(target_os = "windows")]
fn show_away_completions(app: &tauri::AppHandle, completions: Vec<AwayCompletion>) {
    if completions.is_empty() {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_focused().unwrap_or(false) {
        return;
    }
    for completion in completions {
        let display_name = completion.display_name.trim();
        let subject = if display_name.is_empty() {
            "一个 Work"
        } else {
            display_name
        };
        let _ = app
            .notification()
            .builder()
            .title("Work 正在等待你")
            .body(format!("“{subject}”本轮运行已结束，打开 AluDock 查看"))
            .show();
    }
    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
}

impl From<ClientError> for CommandError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::InvalidEndpoint(message) => Self {
                code: "invalid_endpoint".into(),
                message,
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::InvalidPairing(message) => {
                let (code, message) = if message.contains("timed out waiting") {
                    (
                        "pairing_timeout",
                        "等待电脑确认超时。请重新打开配对窗口后再试。",
                    )
                } else if message.contains("pending state was kept")
                    || message.contains("pairing finalization is pending")
                {
                    (
                        "finalization_pending",
                        "电脑可能已经接受配对，但最终连接尚未确认。请保持地址不变并再次尝试，客户端会安全恢复。",
                    )
                } else {
                    (
                        "pairing_invalid",
                        "配对状态无法继续。请确认电脑端配对窗口仍然打开，然后重试。",
                    )
                };
                Self {
                    code: code.into(),
                    message: message.into(),
                    details: None,
                    outcome_unknown: false,
                    operation_id: None,
                }
            }
            ClientError::PairingRejected { code, .. } => {
                let message = match code.as_str() {
                    "pairing_closed" => {
                        "电脑端配对窗口未打开或已经关闭。请在 AluDock 中重新打开五分钟配对窗口。"
                    }
                    "busy" => "电脑正在处理另一台设备的配对，请稍后再试。",
                    "wrong_pin" => "电脑端输入的配对码不正确。本次请求已结束，请重新开始。",
                    "expired" | "not_found" => {
                        "这次配对请求已经过期。请重新打开配对窗口并再次开始。"
                    }
                    "invalid_request" => "电脑无法识别这次配对请求，请检查客户端和 Dock 版本。",
                    _ => "电脑端没有完成配对，请查看 AluDock 的配对状态后重试。",
                };
                Self {
                    code,
                    message: message.into(),
                    details: None,
                    outcome_unknown: false,
                    operation_id: None,
                }
            }
            ClientError::HostCertificateMismatch => Self {
                code: "host_certificate_mismatch".into(),
                message: "这个地址不是当前配对的 AluDock，未保存任何更改。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Host {
                code,
                message,
                details,
                ..
            } => Self {
                code,
                message,
                details,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::EffectUnknown {
                operation_id,
                message,
            } => Self {
                code: "effect_unknown".into(),
                message,
                details: None,
                outcome_unknown: true,
                operation_id: Some(operation_id),
            },
            ClientError::AttachmentTooLarge {
                size_bytes,
                maximum_bytes,
            } => Self {
                code: "attachment_too_large".into(),
                message: msg_attachment_too_large(),
                details: Some(serde_json::json!({
                    "sizeBytes": size_bytes,
                    "maximumBytes": maximum_bytes,
                })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::AttachmentSourceChanged => Self {
                code: "attachment_source_changed".into(),
                message: "附件源文件在上传期间发生了变化，请重新选择。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::AttachmentUploadCancelled => Self {
                code: "attachment_upload_cancelled".into(),
                message: "附件上传已取消。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Tls(_) | ClientError::MissingHostCertificate => Self {
                code: "connection_failed".into(),
                message: "无法建立安全连接。请检查地址、端口、防火墙和电脑端 AluDock 状态。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::RegistryConflict { expected, actual } => Self {
                code: "registry_conflict".into(),
                message: "Host 列表已在其他操作中更新，请刷新后重试。".into(),
                details: Some(
                    serde_json::json!({ "expectedRevision": expected, "actualRevision": actual }),
                ),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::PreferencesConflict { expected, actual } => Self {
                code: "preferences_conflict".into(),
                message: "设置已在其他窗口中更新，请重新选择。".into(),
                details: Some(
                    serde_json::json!({ "expectedRevision": expected, "actualRevision": actual }),
                ),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::ProfileConflict { expected, actual } => Self {
                code: "profile_conflict".into(),
                message: "连接地址已在其他操作中更新，请刷新后重试。".into(),
                details: Some(
                    serde_json::json!({ "expectedRevision": expected, "actualRevision": actual }),
                ),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::HostNotFound(host_id) => Self {
                code: "host_not_found".into(),
                message: "这台 Host 已不在此设备的 Host 列表中。".into(),
                details: Some(serde_json::json!({ "hostId": host_id })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::HostAlreadySaved(host_id) => Self {
                code: "host_already_saved".into(),
                message: "这台 Host 已保存在此设备上，可以直接使用。".into(),
                details: Some(serde_json::json!({ "hostId": host_id })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Storage { .. } | ClientError::Io(_) => Self {
                code: "local_storage_unavailable".into(),
                message: "无法读取或保存这台设备上的数据。请检查应用存储权限和可用空间。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Protocol(reason) => Self {
                code: "protocol_error".into(),
                message: "收到的数据无法识别。请刷新当前内容后重试。".into(),
                details: Some(serde_json::json!({ "reason": reason })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Json(error) => Self {
                code: "client_error".into(),
                message: "客户端无法完成数据处理。请刷新当前内容后重试。".into(),
                details: Some(serde_json::json!({ "reason": error.to_string() })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Crypto(reason) => Self {
                code: "client_error".into(),
                message: "客户端无法完成数据处理。请刷新当前内容后重试。".into(),
                details: Some(serde_json::json!({ "reason": reason })),
                outcome_unknown: false,
                operation_id: None,
            },
        }
    }
}

fn lifecycle_error() -> CommandError {
    CommandError {
        code: "host_lifecycle_unavailable".into(),
        message: "暂时无法切换 Host。请稍后重试。".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn command_reference_expired() -> CommandError {
    CommandError {
        code: "command_reference_expired".into(),
        message: "命令目录已经更新，请重新选择这条命令。".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn ensure_connection_selection(
    lifecycle: &RuntimeLifecycle,
    connection_id: &str,
    selection_generation: u64,
) -> Result<(), CommandError> {
    if lifecycle.selection_generation != selection_generation {
        return Err(CommandError {
            code: "stale_connection_selection".into(),
            message: "当前连接已经改变；旧请求已丢弃。".into(),
            details: Some(serde_json::json!({
                "connectionId": connection_id,
                "selectionGeneration": selection_generation,
                "currentSelectionGeneration": lifecycle.selection_generation,
            })),
            outcome_unknown: false,
            operation_id: None,
        });
    }
    if lifecycle.connection_id() != Some(connection_id) {
        return Err(CommandError {
            code: "stale_connection_selection".into(),
            message: "当前连接已经改变；请求未发送。".into(),
            details: Some(serde_json::json!({ "connectionId": connection_id })),
            outcome_unknown: false,
            operation_id: None,
        });
    }
    Ok(())
}

fn resolve_connection_store(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
) -> Result<IdentityStore, CommandError> {
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    match lifecycle.active_target.as_ref() {
        Some(ConnectionTarget::Local) => Ok(runtime.local_identity.clone()),
        Some(ConnectionTarget::Host { host_id }) => runtime
            .registry
            .resolve_store(Some(host_id))
            .map_err(CommandError::from),
        None => Err(lifecycle_error()),
    }
}

fn mutate_selected_host<T>(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
    mutation: impl FnOnce(&IdentityStore) -> aludock_client_core::Result<T>,
) -> Result<T, CommandError> {
    validate_host_id(connection_id).map_err(CommandError::from)?;
    // Keep the lifecycle lock through the profile CAS. A Host transition can
    // therefore happen either before this revalidation or after persistence,
    // never between the generation check and the write.
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    if lifecycle.active_target
        != Some(ConnectionTarget::Host {
            host_id: connection_id.to_owned(),
        })
    {
        return Err(CommandError::from(ClientError::HostNotFound(
            connection_id.to_owned(),
        )));
    }
    let store = runtime
        .registry
        .resolve_store(Some(connection_id))
        .map_err(CommandError::from)?;
    mutation(&store).map_err(CommandError::from)
}

fn connection_profile(
    store: &IdentityStore,
    host_id: &str,
) -> Result<HostConnectionProfile, CommandError> {
    let profile = store
        .load_connection_profile()
        .map_err(CommandError::from)?
        .ok_or_else(|| CommandError {
            code: "not_paired".into(),
            message: "尚未连接 AluDock".into(),
            details: None,
            outcome_unknown: false,
            operation_id: None,
        })?;
    if profile.host_id != host_id {
        return Err(CommandError::from(ClientError::InvalidPairing(
            "saved Host profile identity does not match the selected Host".into(),
        )));
    }
    Ok(profile)
}

fn dock_client(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
    store: &IdentityStore,
) -> Result<DockClient, CommandError> {
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    let target = lifecycle
        .active_target
        .clone()
        .ok_or_else(lifecycle_error)?;
    let profile = match &target {
        ConnectionTarget::Local => None,
        ConnectionTarget::Host { host_id } => Some(connection_profile(store, host_id)?),
    };
    let mut selected = runtime
        .selected_client
        .lock()
        .map_err(|_| lifecycle_error())?;
    if let Some(current) = selected.as_ref()
        && current.target == target
        && current.selection_generation == selection_generation
    {
        if let Some(profile) = &profile {
            current
                .client
                .router()
                .reconcile(profile)
                .map_err(CommandError::from)?;
        }
        return Ok(current.client.clone());
    }
    if let Some(previous) = selected.take() {
        previous.client.router().close();
    }
    let router = match &target {
        ConnectionTarget::Host { .. } => {
            ConnectionRouter::from_store(store, profile.as_ref().ok_or_else(lifecycle_error)?)
                .map_err(CommandError::from)?
        }
        ConnectionTarget::Local => {
            let snapshot = runtime.registry.snapshot().map_err(CommandError::from)?;
            let endpoint = LocalDockEndpoint::resolve(snapshot.local_endpoint_override.as_deref())
                .map_err(CommandError::from)?;
            ConnectionRouter::local(
                &runtime.local_identity,
                endpoint,
                LOCAL_CONNECTION_SCOPE_ID.into(),
            )
            .map_err(CommandError::from)?
        }
    };
    let client = DockClient::new(router);
    *selected = Some(SelectedConnectionClient {
        target,
        selection_generation,
        client: client.clone(),
    });
    Ok(client)
}

fn reconcile_selected_client(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
    profile: &HostConnectionProfile,
) -> Result<(), CommandError> {
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    let selected = runtime
        .selected_client
        .lock()
        .map_err(|_| lifecycle_error())?;
    if let Some(current) = selected.as_ref()
        && current.target
            == (ConnectionTarget::Host {
                host_id: connection_id.to_owned(),
            })
        && current.selection_generation == selection_generation
    {
        current
            .client
            .router()
            .reconcile(profile)
            .map_err(CommandError::from)?;
    }
    Ok(())
}

fn catalog_from_snapshot(
    runtime: &ConnectionRuntimeState,
    snapshot: HostRegistrySnapshot,
    selection_generation: u64,
) -> Result<HostCatalog, CommandError> {
    let mut hosts = Vec::with_capacity(snapshot.hosts.len());
    for record in &snapshot.hosts {
        let store = runtime
            .registry
            .resolve_store(Some(&record.host_id))
            .map_err(CommandError::from)?;
        let profile = connection_profile(&store, &record.host_id)?;
        let endpoint_summary = profile
            .endpoints
            .iter()
            .find(|endpoint| {
                endpoint.state == EndpointState::Verified
                    && endpoint.id
                        == profile
                            .last_successful_endpoint_id
                            .as_deref()
                            .unwrap_or_default()
            })
            .or_else(|| {
                profile
                    .endpoints
                    .iter()
                    .find(|endpoint| endpoint.state == EndpointState::Verified)
            })
            .map(|endpoint| format!("{}:{}", endpoint.endpoint.host(), endpoint.endpoint.port()))
            .unwrap_or_else(|| "没有可用的 TLS 地址".into());
        let device_name = store
            .load_pairing()
            .map_err(CommandError::from)?
            .metadata
            .device_name;
        validate_device_name(&device_name).map_err(CommandError::from)?;
        hosts.push(HostCatalogEntry {
            host_id: record.host_id.clone(),
            display_name: profile.display_name.clone(),
            device_name,
            endpoint_summary,
            added_at: record.added_at.clone(),
            profile,
        });
    }
    let pairing_transactions = runtime
        .registry
        .pairing_transactions()
        .map_err(CommandError::from)?
        .into_iter()
        .map(|transaction| RecoverablePairing {
            transaction_id: transaction.transaction_id,
            host: transaction
                .endpoint
                .as_ref()
                .map(|endpoint| endpoint.host().to_owned()),
            port: transaction.endpoint.as_ref().map(Endpoint::port),
            device_name: transaction.device_name,
            recoverable: transaction.endpoint.is_some(),
        })
        .collect::<Vec<_>>();
    let pairing_transaction_ids = pairing_transactions
        .iter()
        .map(|transaction| transaction.transaction_id.clone())
        .collect();
    let local_connection_supported = cfg!(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "macos"
    ));
    let local_endpoint_effective = if local_connection_supported {
        LocalDockEndpoint::resolve(snapshot.local_endpoint_override.as_deref())
            .ok()
            .map(|endpoint| endpoint.display())
    } else {
        None
    };
    let active_target = if snapshot.local_selected {
        Some(ConnectionTarget::Local)
    } else {
        snapshot
            .active_host_id
            .map(|host_id| ConnectionTarget::Host { host_id })
    };
    Ok(HostCatalog {
        schema_version: snapshot.schema_version,
        revision: snapshot.revision,
        active_target,
        local_endpoint_override: snapshot.local_endpoint_override,
        local_endpoint_effective,
        selection_generation,
        local_connection_supported,
        hosts,
        pairing_transaction_ids,
        pairing_transactions,
    })
}

#[allow(clippy::too_many_arguments)]
fn invalidate_connection_lifecycle(
    app: &tauri::AppHandle,
    runtime: &ConnectionRuntimeState,
    follow: &FollowState,
    extension: &ExtensionControlState,
    sessions: &SessionTokenState,
    attachments: &AttachmentState,
    restored_images: &RestoredImageState,
    old_connection_id: Option<String>,
    new_connection_id: Option<String>,
    old_selection_generation: u64,
    selection_generation: u64,
) {
    if let Ok(mut selected) = runtime.selected_client.lock()
        && let Some(previous) = selected.take()
    {
        previous.client.router().close();
    }
    if let Ok(mut guard) = follow.task.lock()
        && let Some(task) = guard.take()
    {
        task.handle.abort();
    }
    if let Ok(mut guard) = extension.inner.lock() {
        let detached = guard.binding.take();
        if let Some(task) = guard.task.take() {
            task.abort();
        }
        if let Some(binding) = detached {
            let _ = app.emit(
                "aludock://extension-controller-status",
                ControllerStatusEmission {
                    handle: binding.handle,
                    connection_id: binding.connection_id,
                    selection_generation: binding.selection_generation,
                    host_epoch: binding.host_epoch,
                    instance_id: binding.instance_id,
                    runtime_generation: binding.runtime_generation,
                    state: "detached".into(),
                    message: Some("已切换连接。".into()),
                },
            );
        }
    }
    if let Ok(mut registry) = sessions.registry.lock() {
        registry.tokens.clear();
    }
    attachments.clear();
    match (old_connection_id.as_deref(), new_connection_id.as_deref()) {
        (Some(old_connection_id), Some(new_connection_id))
            if old_connection_id == new_connection_id =>
        {
            restored_images.rebind_generation(
                old_connection_id,
                old_selection_generation,
                selection_generation,
            );
        }
        _ => restored_images.clear(),
    }
}

#[tauri::command]
fn system_device_name() -> Option<String> {
    let name = hostname::get().ok()?.into_string().ok()?;
    let name = name.trim().to_owned();
    if name.eq_ignore_ascii_case("localhost") || name.eq_ignore_ascii_case("localhost.localdomain")
    {
        return None;
    }
    validate_device_name(&name).ok().map(|_| name)
}

#[tauri::command]
fn get_client_preferences(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
) -> Result<SafeClientPreferences, CommandError> {
    runtime
        .preferences
        .snapshot()
        .map(SafeClientPreferences::from)
        .map_err(CommandError::from)
}

#[tauri::command]
fn update_client_preferences(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    expected_revision: u64,
    windows_away_delay: WindowsAwayDelay,
) -> Result<SafeClientPreferences, CommandError> {
    runtime
        .preferences
        .update_windows_away_delay(expected_revision, windows_away_delay)
        .map(SafeClientPreferences::from)
        .map_err(CommandError::from)
}

#[tauri::command]
fn begin_windows_away(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    monitor: tauri::State<'_, AwayMonitorState>,
    running_instance_ids: Vec<String>,
) -> Result<Option<String>, CommandError> {
    #[cfg(target_os = "windows")]
    {
        let preferences = runtime.preferences.snapshot().map_err(CommandError::from)?;
        let Some(grace) = preferences.windows_away_delay.duration() else {
            monitor.stop(None)?;
            return Ok(None);
        };
        let away_id = uuid::Uuid::new_v4().to_string();
        monitor.start(
            app,
            runtime.inner().clone(),
            away_id.clone(),
            grace,
            running_instance_ids,
        )?;
        Ok(Some(away_id))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, runtime, monitor, running_instance_ids);
        Ok(None)
    }
}

#[tauri::command]
fn cancel_windows_away(
    monitor: tauri::State<'_, AwayMonitorState>,
    away_id: Option<String>,
) -> Result<bool, CommandError> {
    monitor.stop(away_id.as_deref())
}

fn local_connection_client(runtime: &ConnectionRuntimeState) -> Result<DockClient, CommandError> {
    let snapshot = runtime.registry.snapshot().map_err(CommandError::from)?;
    let endpoint = LocalDockEndpoint::resolve(snapshot.local_endpoint_override.as_deref())
        .map_err(CommandError::from)?;
    let router = ConnectionRouter::local(
        &runtime.local_identity,
        endpoint,
        LOCAL_CONNECTION_SCOPE_ID.into(),
    )
    .map_err(CommandError::from)?;
    Ok(DockClient::new(router))
}

async fn verify_local_connection(client: &DockClient) -> Result<(), CommandError> {
    client
        .host_info()
        .await
        .map(|_| ())
        .map_err(|error| CommandError {
            code: "local_dock_unavailable".into(),
            message: "没有连接到本机 AluDock。请确认 AluDock 已启动后重试。".into(),
            details: Some(serde_json::json!({ "cause": error.to_string() })),
            outcome_unknown: false,
            operation_id: None,
        })
}

#[tauri::command]
fn get_host_catalog(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
) -> Result<HostCatalog, CommandError> {
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    let snapshot = runtime.registry.snapshot().map_err(CommandError::from)?;
    let generation = lifecycle.selection_generation;
    drop(lifecycle);
    catalog_from_snapshot(&runtime, snapshot, generation)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn connect_local_dock(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    sessions: tauri::State<'_, SessionTokenState>,
    attachments: tauri::State<'_, AttachmentState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    expected_revision: u64,
) -> Result<HostCatalog, CommandError> {
    let client = local_connection_client(&runtime)?;
    verify_local_connection(&client).await?;

    let mut lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    let old_connection_id = lifecycle.connection_id().map(str::to_owned);
    let old_generation = lifecycle.selection_generation;
    let snapshot = runtime
        .registry
        .select_local(expected_revision)
        .map_err(CommandError::from)?;
    let generation = lifecycle.transition_to_local()?;
    let new_connection_id = Some(LOCAL_CONNECTION_SCOPE_ID.to_owned());
    invalidate_connection_lifecycle(
        &app,
        &runtime,
        &follow,
        &extension,
        &sessions,
        &attachments,
        &restored_images,
        old_connection_id,
        new_connection_id,
        old_generation,
        generation,
    );
    drop(lifecycle);
    catalog_from_snapshot(&runtime, snapshot, generation)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_local_endpoint(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    sessions: tauri::State<'_, SessionTokenState>,
    attachments: tauri::State<'_, AttachmentState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    expected_revision: u64,
    endpoint: Option<String>,
) -> Result<HostCatalog, CommandError> {
    let mut lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    let old_connection_id = lifecycle.connection_id().map(str::to_owned);
    let old_generation = lifecycle.selection_generation;
    let snapshot = runtime
        .registry
        .set_local_endpoint_override(expected_revision, endpoint.as_deref())
        .map_err(CommandError::from)?;
    let generation = if lifecycle.active_target == Some(ConnectionTarget::Local) {
        let generation = lifecycle.transition_to_local()?;
        invalidate_connection_lifecycle(
            &app,
            &runtime,
            &follow,
            &extension,
            &sessions,
            &attachments,
            &restored_images,
            old_connection_id,
            Some(LOCAL_CONNECTION_SCOPE_ID.into()),
            old_generation,
            generation,
        );
        generation
    } else {
        lifecycle.selection_generation
    };
    drop(lifecycle);
    catalog_from_snapshot(&runtime, snapshot, generation)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_active_host(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    sessions: tauri::State<'_, SessionTokenState>,
    attachments: tauri::State<'_, AttachmentState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    host_id: String,
    expected_revision: u64,
) -> Result<HostCatalog, CommandError> {
    let mut lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    let old_connection_id = lifecycle.connection_id().map(str::to_owned);
    let old_generation = lifecycle.selection_generation;
    let snapshot = runtime
        .registry
        .set_active_host(&host_id, expected_revision)
        .map_err(CommandError::from)?;
    let generation = lifecycle.transition_to_host(Some(host_id))?;
    let new_connection_id = lifecycle.connection_id().map(str::to_owned);
    invalidate_connection_lifecycle(
        &app,
        &runtime,
        &follow,
        &extension,
        &sessions,
        &attachments,
        &restored_images,
        old_connection_id,
        new_connection_id,
        old_generation,
        generation,
    );
    drop(lifecycle);
    catalog_from_snapshot(&runtime, snapshot, generation)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn remove_saved_host(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    sessions: tauri::State<'_, SessionTokenState>,
    attachments: tauri::State<'_, AttachmentState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    host_id: String,
    expected_revision: u64,
) -> Result<HostCatalog, CommandError> {
    let mut lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    let old_connection_id = lifecycle.connection_id().map(str::to_owned);
    let old_generation = lifecycle.selection_generation;
    let snapshot = runtime
        .registry
        .remove_host(&host_id, expected_revision)
        .map_err(CommandError::from)?;
    let new_connection_id = if snapshot.local_selected {
        Some(LOCAL_CONNECTION_SCOPE_ID.to_owned())
    } else {
        snapshot.active_host_id.clone()
    };
    let generation = if old_connection_id == new_connection_id {
        old_generation
    } else {
        let generation = if snapshot.local_selected {
            lifecycle.transition_to_local()?
        } else {
            lifecycle.transition_to_host(snapshot.active_host_id.clone())?
        };
        invalidate_connection_lifecycle(
            &app,
            &runtime,
            &follow,
            &extension,
            &sessions,
            &attachments,
            &restored_images,
            old_connection_id,
            new_connection_id,
            old_generation,
            generation,
        );
        generation
    };
    drop(lifecycle);
    catalog_from_snapshot(&runtime, snapshot, generation)
}

#[tauri::command]
async fn start_pairing(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, PairingTaskState>,
    host: String,
    port: u16,
    device_name: String,
    replacement_host_id: Option<String>,
) -> Result<String, CommandError> {
    let endpoint = Endpoint::new(host, port).map_err(CommandError::from)?;
    let transaction = {
        // Host removal holds this same lifecycle lock through its registry
        // mutation. A re-pair transaction is therefore either visible to
        // deletion and discarded, or starts only after deletion and fails.
        let _lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
        match replacement_host_id.as_deref() {
            Some(expected_host_id) => runtime.registry.start_repairing_transaction(
                endpoint.clone(),
                &device_name,
                expected_host_id,
            ),
            None => runtime
                .registry
                .start_pairing_transaction(endpoint.clone(), &device_name),
        }
        .map_err(CommandError::from)?
    };
    let transaction_id = transaction.transaction_id;
    let mut tasks = state.tasks.lock().map_err(|_| lifecycle_error())?;
    if tasks.contains_key(&transaction_id) {
        return Ok(transaction_id);
    }

    let task_transaction = transaction_id.clone();
    let task_replacement_host_id = transaction.replacement_host_id;
    let registry = runtime.registry.clone();
    let runtime_state = runtime.inner().clone();
    let task_app = app.clone();
    let task_state = state.inner().clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let task_cancelled = cancelled.clone();
    let task = tauri::async_runtime::spawn(async move {
        let emit = |stage: &str,
                    pin: Option<String>,
                    message: Option<String>,
                    error: Option<CommandError>,
                    host_id: Option<String>,
                    registry_revision: Option<u64>,
                    selection_generation: Option<u64>| {
            let _ = task_app.emit(
                "aludock://pairing-status",
                PairingEmission {
                    transaction_id: task_transaction.clone(),
                    stage: stage.to_owned(),
                    pin,
                    message,
                    error,
                    host_id,
                    registry_revision,
                    selection_generation,
                },
            );
        };
        emit(
            "connecting",
            None,
            Some("正在连接这台电脑…".into()),
            None,
            None,
            None,
            None,
        );
        let report_progress = |progress| match progress {
            PairingProgress::RecoveringPairing => emit(
                "confirming",
                None,
                Some("正在确认上次已经获准的配对…".into()),
                None,
                None,
                None,
                None,
            ),
            PairingProgress::PinGenerated { pin } => emit(
                "waiting_for_host",
                Some(pin),
                Some("请在电脑上的 AluDock 中输入此配对码".into()),
                None,
                None,
                None,
                None,
            ),
            PairingProgress::WaitingForHostApproval { .. } => {}
            PairingProgress::HostApproved => emit(
                "authenticating",
                None,
                Some("电脑已确认，正在安全验证…".into()),
                None,
                None,
                None,
                None,
            ),
            PairingProgress::VerifyingIdentities => emit(
                "verifying",
                None,
                Some("正在确认这是同一台 AluDock…".into()),
                None,
                None,
                None,
                None,
            ),
            PairingProgress::ConfirmingConnection => emit(
                "confirming",
                None,
                Some("正在确认最终安全连接…".into()),
                None,
                None,
                None,
                None,
            ),
            PairingProgress::SavingIdentity => emit(
                "saving",
                None,
                Some("正在保存这台 Host…".into()),
                None,
                None,
                None,
                None,
            ),
        };
        let outcome = match task_replacement_host_id.as_deref() {
            Some(expected_host_id) => {
                registry
                    .verify_repairing(endpoint, &device_name, expected_host_id, report_progress)
                    .await
            }
            None => {
                registry
                    .verify_pairing(endpoint, &device_name, report_progress)
                    .await
            }
        };

        match outcome {
            Ok(verified) => {
                // The task slot serializes cancellation with promotion. Whichever acquires it
                // first wins, so cancellation can never be followed by a promotion.
                let mut task_guard = match task_state.tasks.lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        emit(
                            "failed",
                            None,
                            None,
                            Some(lifecycle_error()),
                            None,
                            None,
                            None,
                        );
                        return;
                    }
                };
                let still_current = task_guard
                    .get(&task_transaction)
                    .is_some_and(|entry| pairing_task_matches(entry, &task_cancelled));
                if !still_current {
                    return;
                }
                let mut lifecycle = match runtime_state.lifecycle.lock() {
                    Ok(lifecycle) => lifecycle,
                    Err(_) => {
                        task_guard.remove(&task_transaction);
                        emit(
                            "failed",
                            None,
                            None,
                            Some(lifecycle_error()),
                            None,
                            None,
                            None,
                        );
                        return;
                    }
                };
                let old_connection_id = lifecycle.connection_id().map(str::to_owned);
                let old_generation = lifecycle.selection_generation;
                let promoted = match task_replacement_host_id.as_deref() {
                    Some(expected_host_id) => {
                        registry.promote_repairing(&verified.transaction_id, expected_host_id)
                    }
                    None => registry.promote_pairing(&verified.transaction_id, &verified.host_id),
                };
                let registry_revision = match promoted.map_err(CommandError::from) {
                    Ok(revision) => revision,
                    Err(error) => {
                        task_guard.remove(&task_transaction);
                        emit("failed", None, None, Some(error), None, None, None);
                        return;
                    }
                };
                let generation = match lifecycle.transition_to_host(Some(verified.host_id.clone()))
                {
                    Ok(generation) => generation,
                    Err(error) => {
                        task_guard.remove(&task_transaction);
                        emit("failed", None, None, Some(error), None, None, None);
                        return;
                    }
                };
                let follow = task_app.state::<FollowState>();
                let extension = task_app.state::<ExtensionControlState>();
                let sessions = task_app.state::<SessionTokenState>();
                let attachments = task_app.state::<AttachmentState>();
                let restored_images = task_app.state::<RestoredImageState>();
                invalidate_connection_lifecycle(
                    &task_app,
                    &runtime_state,
                    &follow,
                    &extension,
                    &sessions,
                    &attachments,
                    &restored_images,
                    old_connection_id,
                    Some(verified.host_id.clone()),
                    old_generation,
                    generation,
                );
                emit(
                    "completed",
                    None,
                    Some(if task_replacement_host_id.is_some() {
                        "重新配对完成".into()
                    } else {
                        "配对完成".into()
                    }),
                    None,
                    Some(verified.host_id),
                    Some(registry_revision),
                    Some(generation),
                );
                task_guard.remove(&task_transaction);
            }
            Err(error) => {
                let should_emit = task_state.tasks.lock().ok().is_some_and(|mut tasks| {
                    let current = tasks
                        .get(&task_transaction)
                        .is_some_and(|entry| pairing_task_matches(entry, &task_cancelled));
                    if current {
                        tasks.remove(&task_transaction);
                    }
                    current
                });
                if should_emit {
                    emit(
                        "failed",
                        None,
                        None,
                        Some(CommandError::from(error)),
                        None,
                        None,
                        None,
                    );
                }
            }
        }
    });
    tasks.insert(
        transaction_id.clone(),
        PairingTask {
            handle: task,
            cancelled,
        },
    );
    Ok(transaction_id)
}

#[tauri::command]
async fn resume_pairing(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, PairingTaskState>,
    transaction_id: String,
) -> Result<(), CommandError> {
    let transaction = runtime
        .registry
        .pairing_transactions()
        .map_err(CommandError::from)?
        .into_iter()
        .find(|transaction| transaction.transaction_id == transaction_id)
        .ok_or_else(|| {
            CommandError::from(ClientError::InvalidPairing(
                "pairing transaction was not found".into(),
            ))
        })?;
    let endpoint = transaction.endpoint.ok_or_else(|| {
        CommandError::from(ClientError::InvalidPairing(
            "pairing transaction does not have a recoverable address".into(),
        ))
    })?;
    let device_name = transaction.device_name.ok_or_else(|| {
        CommandError::from(ClientError::InvalidPairing(
            "pairing transaction does not have a device name".into(),
        ))
    })?;
    let replacement_host_id = transaction.replacement_host_id;
    let resumed = start_pairing(
        app,
        runtime,
        state,
        endpoint.host().to_owned(),
        endpoint.port(),
        device_name,
        replacement_host_id,
    )
    .await?;
    if resumed != transaction_id {
        return Err(CommandError::from(ClientError::InvalidPairing(
            "pairing resume selected a different transaction".into(),
        )));
    }
    Ok(())
}

#[tauri::command]
fn cancel_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, PairingTaskState>,
    transaction_id: String,
) -> Result<bool, CommandError> {
    if let Some(task) = state
        .tasks
        .lock()
        .map_err(|_| lifecycle_error())?
        .remove(&transaction_id)
    {
        task.cancelled.store(true, Ordering::Release);
        task.handle.abort();
        let _ = app.emit(
            "aludock://pairing-status",
            PairingEmission {
                transaction_id,
                stage: "cancelled".into(),
                pin: None,
                message: Some(
                    "已停止等待。若已在电脑上确认，请重新打开这台 Host 查看配对结果。".into(),
                ),
                error: None,
                host_id: None,
                registry_revision: None,
                selection_generation: None,
            },
        );
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
fn discard_pairing(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, PairingTaskState>,
    transaction_id: String,
) -> Result<(), CommandError> {
    let tasks = state.tasks.lock().map_err(|_| lifecycle_error())?;
    if tasks.contains_key(&transaction_id) {
        return Err(CommandError::from(ClientError::InvalidPairing(
            "cancel the running pairing before discarding it".into(),
        )));
    }
    runtime
        .registry
        .discard_pairing_transaction(&transaction_id)
        .map_err(CommandError::from)
}

#[tauri::command]
fn reselect_host_route(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
) -> Result<bool, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .router()
        .reselect_preferred_route()
        .map_err(CommandError::from)
}

#[tauri::command]
async fn bootstrap(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
) -> Result<BootstrapPayload, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let profile = if connection_id == LOCAL_CONNECTION_SCOPE_ID {
        None
    } else {
        Some(connection_profile(&store, &connection_id)?)
    };
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let connection_name = profile
        .as_ref()
        .map_or("本机 AluDock", |profile| profile.display_name.as_str());
    let info = client.host_info().await.map_err(|error| CommandError {
        code: "host_unreachable".into(),
        message: format!("无法连接“{connection_name}”；当前选择保持不变。"),
        details: Some(
            serde_json::json!({ "connectionId": connection_id, "cause": error.to_string() }),
        ),
        outcome_unknown: false,
        operation_id: None,
    })?;
    let (catalog, catalog_host_epoch) = client
        .list_instances_with_host_epoch(InstanceSelector::All)
        .await
        .map_err(CommandError::from)?;
    if catalog_host_epoch != info.host.host_epoch {
        return Err(CommandError::from(ClientError::Protocol(
            "Host epoch changed while bootstrapping the instance catalog".into(),
        )));
    }
    let active_endpoint_id = client
        .router()
        .snapshot()
        .active_endpoint_id
        .ok_or_else(|| {
            CommandError::from(ClientError::Protocol(
                "Host connection completed without an active address".into(),
            ))
        })?;
    let InstanceCatalog {
        instances,
        total,
        hidden_stopped,
    } = catalog;
    Ok(BootstrapPayload {
        connection_id,
        selection_generation,
        max_attachments_per_message: MAX_ATTACHMENTS_PER_MESSAGE,
        host: HostSummary {
            state: info.state,
            host_epoch: info.host.host_epoch,
            dock_version: info.host.dock_version,
            pi_sdk_version: info.host.pi_sdk_version,
            started_at: info.host.started_at,
            profile,
            active_endpoint_id,
        },
        works: instances,
        total,
        hidden_stopped,
    })
}

#[tauri::command]
async fn work_catalog(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
) -> Result<WorkCatalogPayload, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let (catalog, host_epoch) =
        dock_client(&runtime, &connection_id, selection_generation, &store)?
            .list_instances_with_host_epoch(InstanceSelector::All)
            .await
            .map_err(CommandError::from)?;
    Ok(WorkCatalogPayload {
        connection_id,
        selection_generation,
        host_epoch,
        instances: catalog.instances,
        total: catalog.total,
        hidden_stopped: catalog.hidden_stopped,
    })
}

#[tauri::command]
async fn conversation_bootstrap(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<ConversationBootstrap, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let read = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .read_instance(&instance_id, None, ReadReplay::ConversationBootstrap)
        .await
        .map_err(CommandError::from)?;
    let history_before_entry_id = if read.history_truncated {
        Some(
            read.recent_history
                .first()
                .ok_or_else(|| {
                    CommandError::from(ClientError::Protocol(
                        "truncated conversation bootstrap omitted its history anchor".into(),
                    ))
                })?
                .entry_id
                .clone(),
        )
    } else {
        None
    };
    let active_events = read
        .page
        .events
        .iter()
        .filter(|event| {
            matches!(
                event.event_type.as_str(),
                "message.submitted"
                    | "message.delta"
                    | "message.completed"
                    | "run.settled"
                    | "tool.started"
                    | "tool.args_updated"
                    | "tool.output_updated"
                    | "tool.completed"
            )
        })
        .cloned()
        .map(project_event)
        .collect::<Result<Vec<_>, _>>()
        .map_err(CommandError::from)?;
    let extension_events = read
        .page
        .events
        .iter()
        .map(project_extension_event)
        .collect::<Result<Vec<_>, _>>()
        .map_err(CommandError::from)?
        .into_iter()
        .flatten()
        .collect();
    let queue = read
        .pending_messages
        .into_iter()
        .map(project_pending_message)
        .collect();
    Ok(ConversationBootstrap {
        instance: read.instance.clone(),
        records: read.recent_history,
        active_events,
        extension_ui: ExtensionBootstrap {
            status: read.instance.extension_status,
            tools_expanded: read.instance.tools_expanded,
            active_interaction: read.instance.active_interaction,
            events: extension_events,
        },
        queue,
        cursor: read.page.latest,
        history_revision: read.history_revision,
        history_truncated: read.history_truncated,
        history_before_entry_id,
    })
}

const CONVERSATION_HISTORY_PAGE_LIMIT: u16 = 50;

#[tauri::command]
async fn conversation_history(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    cursor: Option<String>,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
) -> Result<ConversationPreviewPage, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let page = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .preview_conversation_page(
            &instance_id,
            cursor.as_deref(),
            CONVERSATION_HISTORY_PAGE_LIMIT,
        )
        .await
        .map_err(CommandError::from)?;
    if page.host_epoch != expected_host_epoch
        || page.instance.owner_host_epoch.as_deref() != Some(expected_host_epoch.as_str())
        || page.instance.runtime_generation != expected_runtime_generation
    {
        return Err(CommandError::from(ClientError::Protocol(
            "conversation history changed; refresh the current Work before loading records".into(),
        )));
    }
    Ok(page)
}

#[tauri::command]
async fn conversation_history_entry(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    cursor: Option<String>,
    entry_id: String,
    expected_revision: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
) -> Result<CompletedConversationEntry, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let completed = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .complete_conversation_entry(
            &instance_id,
            cursor.as_deref(),
            CONVERSATION_HISTORY_PAGE_LIMIT,
            &entry_id,
            &expected_revision,
        )
        .await
        .map_err(CommandError::from)?;
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    if completed.host_epoch != expected_host_epoch
        || completed.instance.id != instance_id
        || completed.instance.owner_host_epoch.as_deref() != Some(expected_host_epoch.as_str())
        || completed.instance.runtime_generation != expected_runtime_generation
        || completed.revision != expected_revision
        || completed.record.entry_id != entry_id
    {
        return Err(CommandError::from(ClientError::Protocol(
            "conversation content changed; refresh the current Work before loading records".into(),
        )));
    }
    Ok(completed)
}

#[tauri::command]
async fn conversation_image(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    content_ref: String,
    mime_type: String,
    on_chunk: Channel<Response>,
) -> Result<usize, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let image = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .read_conversation_image(&instance_id, &content_ref, &mime_type)
        .await
        .map_err(CommandError::from)?;
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    if image.host_epoch != expected_host_epoch || image.mime_type != mime_type {
        return Err(CommandError::from(ClientError::Protocol(
            "conversation image belonged to an obsolete Work state".into(),
        )));
    }
    validate_renderable_image(&image.bytes, Some(&mime_type))?;
    send_render_image_chunks(&image.bytes, |chunk| {
        on_chunk.send(Response::new(chunk.to_vec()))
    })
    .map_err(|_| image_error("image_transfer_failed", "图片传输中断，请重试。"))
}

#[tauri::command]
async fn published_image(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    file: PublishedFileDto,
    on_chunk: Channel<Response>,
) -> Result<usize, CommandError> {
    if file.size_bytes > MAX_RENDERABLE_IMAGE_BYTES {
        return Err(image_error(
            "image_too_large",
            "这张图片太大，当前设备无法安全预览。",
        ));
    }
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let image = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .read_published_file(&instance_id, &file)
        .await
        .map_err(CommandError::from)?;
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    if image.host_epoch != expected_host_epoch
        || image.runtime_generation != expected_runtime_generation
        || image.file != file
    {
        return Err(CommandError::from(ClientError::Protocol(
            "published image belonged to an obsolete Work state".into(),
        )));
    }
    validate_renderable_image(&image.bytes, file.media_type.as_deref())?;
    send_render_image_chunks(&image.bytes, |chunk| {
        on_chunk.send(Response::new(chunk.to_vec()))
    })
    .map_err(|_| image_error("image_transfer_failed", "图片传输中断，请重试。"))
}

fn send_render_image_chunks<E>(
    bytes: &[u8],
    mut send: impl FnMut(&[u8]) -> Result<(), E>,
) -> Result<usize, E> {
    for chunk in bytes.chunks(RENDER_IMAGE_IPC_CHUNK_BYTES) {
        send(chunk)?;
    }
    Ok(bytes.len())
}

fn validate_renderable_image(
    bytes: &[u8],
    declared_mime_type: Option<&str>,
) -> Result<(), CommandError> {
    let detected = raster_image_mime_type(bytes).ok_or_else(|| {
        image_error(
            "unsupported_image",
            "图片内容不是可安全显示的 PNG、JPEG、GIF 或 WebP 格式。",
        )
    })?;
    if declared_mime_type.is_some_and(|value| value != detected) {
        return Err(image_error(
            "unsupported_image",
            "图片标注的格式与实际内容不一致，未进行显示。",
        ));
    }
    Ok(())
}

fn raster_image_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn image_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn percent_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_image_name(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 2_048 {
        return None;
    }
    let input = value.as_bytes();
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' {
            let high = percent_hex(*input.get(index + 1)?)?;
            let low = percent_hex(*input.get(index + 2)?)?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            if !input[index].is_ascii() {
                return None;
            }
            output.push(input[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn preview_image_save_name(requested: &str, media_type: &str) -> String {
    let mut cleaned = requested
        .chars()
        .map(|character| {
            if character.is_control() || character == '/' || character == '\\' {
                '_'
            } else {
                character
            }
        })
        .take(180)
        .collect::<String>();
    cleaned = cleaned
        .trim_matches(|character: char| character.is_whitespace() || character == '.')
        .to_owned();
    if cleaned.is_empty() {
        cleaned = "aludock-image".into();
    }
    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "img",
    };
    let lowercase = cleaned.to_ascii_lowercase();
    let extension_matches = match media_type {
        "image/jpeg" => lowercase.ends_with(".jpg") || lowercase.ends_with(".jpeg"),
        _ => lowercase.ends_with(&format!(".{extension}")),
    };
    if extension_matches {
        return cleaned;
    }
    if [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|suffix| lowercase.ends_with(suffix))
    {
        if let Some((stem, _)) = cleaned.rsplit_once('.') {
            cleaned = stem.to_owned();
        }
    }
    format!("{cleaned}.{extension}")
}

#[tauri::command]
async fn save_preview_image(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<LocalSaveResult, CommandError> {
    let encoded_name = request
        .headers()
        .get("x-aludock-image-name")
        .and_then(|value| value.to_str().ok())
        .and_then(decode_image_name)
        .ok_or_else(|| image_error("image_save_invalid", "无法使用这个图片名称。"))?;
    let bytes = bounded_image_body(&request).map_err(|error| match error {
        BoundedImageBodyError::Invalid => image_error(
            "image_save_invalid",
            "图片内容无法读取，请重新打开后再保存。",
        ),
        BoundedImageBodyError::TooLarge => {
            image_error("image_save_too_large", "这张图片太大，当前设备无法保存。")
        }
    })?;
    let media_type = raster_image_mime_type(&bytes).ok_or_else(|| {
        image_error(
            "unsupported_image",
            "图片内容不是可保存的 PNG、JPEG、GIF 或 WebP 格式。",
        )
    })?;
    let name = preview_image_save_name(&encoded_name, media_type);
    #[cfg(not(mobile))]
    let destination = pick_save_destination(&app, &name).await?;
    #[cfg(mobile)]
    let mut destination: Option<FilePath> = None;
    #[cfg(not(mobile))]
    if destination.is_none() {
        return Ok(LocalSaveResult::Cancelled);
    }
    let staging_path = delivery_staging_path(&app, destination.as_ref())?;
    let write_path = staging_path.clone();
    let write_result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut target = create_delivery_staging_file(&write_path)
            .map_err(|error| std::io::Error::other(error.message))?;
        target.write_all(&bytes)?;
        target.flush()?;
        target.sync_all()
    })
    .await;
    let write_result = match write_result {
        Ok(result) => result,
        Err(_) => {
            let _ = fs::remove_file(&staging_path);
            return Err(lifecycle_error());
        }
    };
    if write_result.is_err() {
        let _ = fs::remove_file(&staging_path);
        return Err(image_error(
            "image_save_failed",
            "无法保存到所选位置。请检查可用空间和存储权限后重试。",
        ));
    }
    #[cfg(mobile)]
    {
        destination = match pick_save_destination(&app, &name).await {
            Ok(destination) => destination,
            Err(error) => {
                let _ = fs::remove_file(&staging_path);
                return Err(error);
            }
        };
        if destination.is_none() {
            let _ = fs::remove_file(&staging_path);
            return Ok(LocalSaveResult::Cancelled);
        }
    }
    let destination = destination.expect("save cancellation returned before commit");
    let saved_location = match describe_saved_location(&destination, &name) {
        Ok(location) => location,
        Err(error) => {
            let _ = fs::remove_file(&staging_path);
            return Err(error);
        }
    };
    commit_verified_file(&app, staging_path, destination.clone()).await?;
    #[cfg(target_os = "android")]
    if let FilePath::Url(url) = &destination {
        let _ = android_documents::retain_document_access(&app, url.as_str()).await;
    }
    Ok(LocalSaveResult::Saved {
        label: saved_location.label,
    })
}

fn project_pending_message(item: PendingMessage) -> ProjectedQueueItem {
    ProjectedQueueItem {
        queue_item_id: item.queue_item_id,
        delivery: item.delivery,
        text: item.text,
        attachments: item.attachments,
        image_count: item.images.len(),
        accepted_at: item.accepted_at,
    }
}

fn project_queue_dequeue(result: QueueDequeueResult) -> SafeQueueDequeueResult {
    SafeQueueDequeueResult {
        receipt: SafeQueueDequeueReceipt {
            instance_id: result.receipt.instance_id,
            restored: result
                .receipt
                .restored
                .into_iter()
                .map(project_pending_message)
                .collect(),
            in_flight: result
                .receipt
                .in_flight
                .into_iter()
                .map(project_pending_message)
                .collect(),
        },
        instance: result.instance,
    }
}

fn project_event(
    event: aludock_client_core::DockEvent,
) -> aludock_client_core::Result<ProjectedEvent> {
    let extension = ExtensionEvent::from_dock_event(&event)?;
    let data = match extension {
        Some(value) => serde_json::to_value(value)
            .map_err(ClientError::Json)?
            .get_mut("data")
            .map(Value::take)
            .ok_or_else(|| {
                ClientError::Protocol("Extension UI projection omitted event data".into())
            })?,
        None => strip_image_paths(event.data),
    };
    Ok(ProjectedEvent {
        sequence: event.sequence,
        runtime_generation: event.runtime_generation,
        occurred_at: event.occurred_at,
        event_type: event.event_type,
        data,
    })
}

fn project_extension_event(
    event: &aludock_client_core::DockEvent,
) -> aludock_client_core::Result<Option<ProjectedEvent>> {
    let Some(value) = ExtensionEvent::from_dock_event(event)? else {
        return Ok(None);
    };
    let mut encoded = serde_json::to_value(value).map_err(ClientError::Json)?;
    let data = encoded.get_mut("data").map(Value::take).ok_or_else(|| {
        ClientError::Protocol("Extension UI projection omitted event data".into())
    })?;
    Ok(Some(ProjectedEvent {
        sequence: event.sequence,
        runtime_generation: event.runtime_generation,
        occurred_at: event.occurred_at.clone(),
        event_type: event.event_type.clone(),
        data,
    }))
}

fn strip_image_paths(mut data: Value) -> Value {
    if let Some(images) = data.get_mut("images").and_then(Value::as_array_mut) {
        for image in images {
            if let Some(object) = image.as_object_mut() {
                object.remove("path");
            }
        }
    }
    data
}

fn follow_state_error() -> CommandError {
    CommandError {
        code: "follow_state_unavailable".into(),
        message: "实时连接状态暂时不可用".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

#[tauri::command]
fn stop_conversation_follow(
    state: tauri::State<'_, FollowState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    subscription_id: String,
) -> Result<bool, CommandError> {
    state.abort_matching(
        &connection_id,
        selection_generation,
        &instance_id,
        Some(&subscription_id),
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_conversation_follow(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    app: tauri::AppHandle,
    state: tauri::State<'_, FollowState>,
    instance_id: String,
    subscription_id: String,
    cursor: EventCursor,
) -> Result<(), CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, &connection_id, selection_generation)?;
    let mut guard = state.task.lock().map_err(|_| follow_state_error())?;
    if let Some(task) = guard.take() {
        task.handle.abort();
    }
    let followed_host = connection_id.clone();
    let followed_instance = instance_id.clone();
    let followed_subscription = subscription_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let status = |state: &str, message: Option<String>| FollowStatus {
            connection_id: followed_host.clone(),
            selection_generation,
            instance_id: followed_instance.clone(),
            subscription_id: followed_subscription.clone(),
            state: state.to_owned(),
            message,
        };
        let (initial, mut stream) = match client.follow_instance(&followed_instance, &cursor).await
        {
            Ok(value) => value,
            Err(error) => {
                let _ = app.emit(
                    "aludock://follow-status",
                    status("disconnected", Some(error.to_string())),
                );
                return;
            }
        };
        if initial.truncated || initial.epoch_changed || initial.generation_changed {
            let _ = app.emit("aludock://follow-status", status("resync_required", None));
            return;
        }
        let _ = app.emit("aludock://follow-status", status("connected", None));
        for event in initial.events {
            let projected = match project_event(event) {
                Ok(event) => event,
                Err(error) => {
                    let _ = app.emit(
                        "aludock://follow-status",
                        status("disconnected", Some(error.to_string())),
                    );
                    return;
                }
            };
            let _ = app.emit(
                "aludock://conversation-event",
                FollowEmission {
                    connection_id: followed_host.clone(),
                    selection_generation,
                    instance_id: followed_instance.clone(),
                    subscription_id: followed_subscription.clone(),
                    event: projected,
                },
            );
        }
        loop {
            match stream.next_event().await {
                Ok(event) => {
                    let replacement = event.event_type == "session.replaced";
                    let projected = match project_event(event) {
                        Ok(event) => event,
                        Err(error) => {
                            let _ = app.emit(
                                "aludock://follow-status",
                                status("disconnected", Some(error.to_string())),
                            );
                            return;
                        }
                    };
                    let _ = app.emit(
                        "aludock://conversation-event",
                        FollowEmission {
                            connection_id: followed_host.clone(),
                            selection_generation,
                            instance_id: followed_instance.clone(),
                            subscription_id: followed_subscription.clone(),
                            event: projected,
                        },
                    );
                    if replacement {
                        let _ =
                            app.emit("aludock://follow-status", status("resync_required", None));
                        return;
                    }
                }
                Err(error) => {
                    let _ = app.emit(
                        "aludock://follow-status",
                        status("disconnected", Some(error.to_string())),
                    );
                    return;
                }
            }
        }
    });
    *guard = Some(FollowTask {
        handle: task,
        connection_id,
        selection_generation,
        instance_id,
        subscription_id,
    });
    drop(lifecycle);
    Ok(())
}

fn extension_state_error() -> CommandError {
    CommandError {
        code: "extension_control_unavailable".into(),
        message: "Extension UI 控制状态暂时不可用".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn extension_scope_matches(
    binding_connection_id: &str,
    binding_selection_generation: u64,
    requested_connection_id: &str,
    requested_selection_generation: u64,
) -> bool {
    binding_connection_id == requested_connection_id
        && binding_selection_generation == requested_selection_generation
}

fn stale_extension_handle() -> CommandError {
    CommandError {
        code: "stale_extension_controller".into(),
        message: "这个 Extension UI 控制句柄已经失效，请重新取得控制权。".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn safe_controller_event(
    event: aludock_client_core::ControllerEvent,
) -> Result<ProjectedEvent, CommandError> {
    let (event_type, mut data) = match event.event {
        ControllerEventData::InteractionRequested(request) => {
            let mut value = serde_json::to_value(request)
                .map_err(ClientError::Json)
                .map_err(CommandError::from)?;
            value
                .as_object_mut()
                .ok_or_else(|| {
                    CommandError::from(ClientError::Protocol(
                        "invalid interaction projection".into(),
                    ))
                })?
                .remove("controllerId");
            ("interaction.requested".to_owned(), value)
        }
        ControllerEventData::TitleSet(value) => {
            let mut value = serde_json::to_value(value)
                .map_err(ClientError::Json)
                .map_err(CommandError::from)?;
            value
                .as_object_mut()
                .ok_or_else(|| {
                    CommandError::from(ClientError::Protocol("invalid title projection".into()))
                })?
                .remove("controllerId");
            ("extension.title_set".to_owned(), value)
        }
        ControllerEventData::EditorTextSet(value) => {
            let mut value = serde_json::to_value(value)
                .map_err(ClientError::Json)
                .map_err(CommandError::from)?;
            value
                .as_object_mut()
                .ok_or_else(|| {
                    CommandError::from(ClientError::Protocol("invalid editor projection".into()))
                })?
                .remove("controllerId");
            ("extension.editor_text_set".to_owned(), value)
        }
    };
    // Defense in depth: controller identifiers and lease material are never projected.
    if let Some(object) = data.as_object_mut() {
        object.remove("controllerId");
        object.remove("leaseToken");
    }
    Ok(ProjectedEvent {
        sequence: event.sequence,
        runtime_generation: event.runtime_generation,
        occurred_at: event.occurred_at,
        event_type,
        data,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn acquire_extension_control(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    app: tauri::AppHandle,
    state: tauri::State<'_, ExtensionControlState>,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
) -> Result<SafeControllerBinding, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let controller = client
        .control_extension_ui(&instance_id)
        .await
        .map_err(CommandError::from)?;
    if controller.host_epoch != expected_host_epoch
        || controller.runtime_generation != expected_runtime_generation
        || controller.instance_id != instance_id
    {
        return Err(CommandError::from(ClientError::Protocol(
            "interaction controller did not match the selected Work generation".into(),
        )));
    }
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, &connection_id, selection_generation)?;
    let handle = uuid::Uuid::new_v4().to_string();
    let safe = SafeControllerBinding {
        handle: handle.clone(),
        connection_id: connection_id.clone(),
        selection_generation,
        host_epoch: controller.host_epoch.clone(),
        instance_id: controller.instance_id.clone(),
        runtime_generation: controller.runtime_generation,
    };
    let mut stream = controller.stream;
    let binding = ExtensionBinding {
        handle: handle.clone(),
        connection_id: connection_id.clone(),
        selection_generation,
        host_epoch: controller.host_epoch.clone(),
        instance_id: controller.instance_id.clone(),
        runtime_generation: controller.runtime_generation,
        lease: controller.lease,
        pending: None,
        last_viewport: None,
    };
    let shared = state.inner.clone();
    let mut guard = state.inner.lock().map_err(|_| extension_state_error())?;
    if let Some(previous) = guard.task.take() {
        previous.abort();
    }
    guard.binding = Some(binding);
    let task_handle = handle.clone();
    let task_connection_id = connection_id;
    let task_host = controller.host_epoch;
    let task_instance = controller.instance_id;
    let task_generation = controller.runtime_generation;
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let event = match stream.next_event().await {
                Ok(event) => event,
                Err(_) => break,
            };
            let projected = match safe_controller_event(event.clone()) {
                Ok(event) => event,
                Err(_) => break,
            };
            let current = {
                let Ok(mut guard) = shared.lock() else { break };
                let Some(binding) = guard.binding.as_mut() else {
                    break;
                };
                if binding.handle != task_handle
                    || binding.connection_id != task_connection_id
                    || binding.selection_generation != selection_generation
                    || binding.host_epoch != task_host
                    || binding.instance_id != task_instance
                    || binding.runtime_generation != task_generation
                {
                    break;
                }
                if let ControllerEventData::InteractionRequested(request) = event.event {
                    binding.pending = Some(request);
                }
                true
            };
            if current {
                let _ = app.emit(
                    "aludock://extension-controller-event",
                    ControllerEmission {
                        handle: task_handle.clone(),
                        connection_id: task_connection_id.clone(),
                        selection_generation,
                        host_epoch: task_host.clone(),
                        instance_id: task_instance.clone(),
                        runtime_generation: task_generation,
                        event: projected,
                    },
                );
            }
        }
        if let Ok(mut guard) = shared.lock()
            && guard
                .binding
                .as_ref()
                .is_some_and(|binding| binding.handle == task_handle)
        {
            guard.binding = None;
            guard.task = None;
            let _ = app.emit(
                "aludock://extension-controller-status",
                ControllerStatusEmission {
                    handle: task_handle,
                    connection_id: task_connection_id,
                    selection_generation,
                    host_epoch: task_host,
                    instance_id: task_instance,
                    runtime_generation: task_generation,
                    state: "disconnected".into(),
                    message: Some("Extension UI 控制连接已结束；没有替你回答或取消问题。".into()),
                },
            );
        }
    });
    guard.task = Some(task);
    drop(lifecycle);
    Ok(safe)
}

#[tauri::command]
fn release_extension_control(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, ExtensionControlState>,
    handle: String,
) -> Result<(), CommandError> {
    let _store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let mut guard = state.inner.lock().map_err(|_| extension_state_error())?;
    if let Some(binding) = guard
        .binding
        .as_ref()
        .filter(|binding| binding.handle == handle)
    {
        if !extension_scope_matches(
            &binding.connection_id,
            binding.selection_generation,
            &connection_id,
            selection_generation,
        ) {
            return Err(stale_extension_handle());
        }
        guard.binding = None;
        if let Some(task) = guard.task.take() {
            task.abort();
        }
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn respond_extension_interaction(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, ExtensionControlState>,
    handle: String,
    interaction_id: String,
    method: InteractionMethod,
    value: Option<String>,
    confirmed: Option<bool>,
    cancelled: bool,
) -> Result<aludock_client_core::InteractionRespondResult, CommandError> {
    let binding = {
        let guard = state.inner.lock().map_err(|_| extension_state_error())?;
        let binding = guard
            .binding
            .as_ref()
            .filter(|binding| {
                binding.handle == handle
                    && extension_scope_matches(
                        &binding.connection_id,
                        binding.selection_generation,
                        &connection_id,
                        selection_generation,
                    )
            })
            .ok_or_else(stale_extension_handle)?;
        let pending = binding
            .pending
            .as_ref()
            .filter(|request| {
                request.interaction_id() == interaction_id && request.method() == method
            })
            .ok_or_else(stale_extension_handle)?;
        let response = match method {
            InteractionMethod::Select => {
                let value = value.ok_or_else(stale_extension_handle)?;
                if !cancelled
                    && !pending
                        .select_options()
                        .is_some_and(|options| options.iter().any(|option| option == &value))
                {
                    return Err(CommandError {
                        code: "invalid_interaction_response".into(),
                        message: "选择值已经不在当前选项中。".into(),
                        details: None,
                        outcome_unknown: false,
                        operation_id: None,
                    });
                }
                InteractionResponse::Select { value }
            }
            InteractionMethod::Confirm => InteractionResponse::Confirm {
                confirmed: confirmed.unwrap_or(false),
            },
            InteractionMethod::Input => InteractionResponse::Input {
                value: value.unwrap_or_default(),
            },
            InteractionMethod::Editor => InteractionResponse::Editor {
                value: value.unwrap_or_default(),
            },
        };
        (binding.clone(), response)
    };
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let result = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .respond_interaction(
            &binding.0.lease,
            &interaction_id,
            &binding.1,
            cancelled,
            None,
        )
        .await
        .map_err(CommandError::from)?;
    if let Ok(mut guard) = state.inner.lock()
        && let Some(current) = guard.binding.as_mut()
        && current.handle == handle
        && current
            .pending
            .as_ref()
            .is_some_and(|request| request.interaction_id() == interaction_id)
    {
        current.pending = None;
    }
    Ok(result)
}

#[tauri::command]
async fn set_extension_widget_viewport(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, ExtensionControlState>,
    handle: String,
    width: u16,
    height: u16,
) -> Result<aludock_client_core::WidgetViewportResult, CommandError> {
    if width == 0 || height == 0 || width > 10_000 || height > 10_000 {
        return Err(CommandError {
            code: "invalid_viewport".into(),
            message: "Extension viewport 必须是 1–10000 的字符格。".into(),
            details: None,
            outcome_unknown: false,
            operation_id: None,
        });
    }
    let binding = {
        let guard = state.inner.lock().map_err(|_| extension_state_error())?;
        let binding = guard
            .binding
            .as_ref()
            .filter(|binding| {
                binding.handle == handle
                    && extension_scope_matches(
                        &binding.connection_id,
                        binding.selection_generation,
                        &connection_id,
                        selection_generation,
                    )
            })
            .ok_or_else(stale_extension_handle)?;
        if binding.last_viewport == Some((width, height)) {
            return Ok(aludock_client_core::WidgetViewportResult { accepted: true });
        }
        binding.clone()
    };
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let result = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .set_extension_widget_viewport(&binding.lease, width, height)
        .await
        .map_err(CommandError::from)?;
    if let Ok(mut guard) = state.inner.lock()
        && let Some(current) = guard.binding.as_mut()
        && current.handle == handle
    {
        current.last_viewport = Some((width, height));
    }
    Ok(result)
}

#[tauri::command]
async fn set_extension_tools_expanded(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    expanded: bool,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let snapshot = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .set_tools_expanded(
            &instance_id,
            expected_runtime_generation,
            expanded,
            Some(&operation_id),
        )
        .await
        .map_err(CommandError::from)?;
    if snapshot.owner_host_epoch.as_deref() != Some(expected_host_epoch.as_str()) {
        return Err(CommandError::from(ClientError::EffectUnknown {
            operation_id,
            message: "tools-expanded result changed Host epoch".into(),
        }));
    }
    Ok(snapshot)
}

const MSG_ATTACHMENT_SOURCE_UNAVAILABLE: &str = "无法读取所选附件。";
#[cfg(target_os = "android")]
const MSG_ATTACHMENT_STAGE_FAILED: &str = "无法暂存所选附件。";
const MSG_ATTACHMENT_NOT_PLAIN_FILE: &str = "只能选择本机普通文件。";
fn msg_attachment_too_large() -> String {
    format!(
        "附件超过 {} MiB 大小限制。",
        MAX_ATTACHMENT_BYTES / 1024 / 1024
    )
}
fn msg_attachment_selection_full() -> String {
    format!(
        "每个工作最多选择 {} 个待上传附件。",
        MAX_ATTACHMENTS_PER_MESSAGE
    )
}
const MSG_PASTE_CONTEXT_LOST: &str = "无法读取粘贴图片的上下文，请重新粘贴。";
const MSG_CLIPBOARD_IMAGE_INVALID: &str = "剪贴板中的图片数据无效，请重新复制。";
const MSG_PASTE_STAGE_FAILED: &str = "无法暂存粘贴的图片，请重试或使用附件按钮。";
const MSG_ATTACHMENT_PREVIEW_LOST: &str = "这个附件已无法预览，请重新选择。";
const MSG_ATTACHMENT_SOURCE_CHANGED: &str = "附件源文件发生了变化，请重新选择。";

fn attachment_command_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn attachment_upload_error(error: ClientError) -> CommandError {
    let mut error = CommandError::from(error);
    // Upload operation IDs are native-only even for indeterminate outcomes.
    error.operation_id = None;
    error
}

fn attachment_target_matches(
    catalog_host_epoch: &str,
    owner_host_epoch: Option<&str>,
    runtime_generation: u64,
    machine_host_id: Option<&str>,
    lifecycle: &aludock_client_core::InstanceLifecycle,
    scope: &AttachmentUploadScope,
) -> bool {
    catalog_host_epoch == scope.owner_host_epoch
        && owner_host_epoch == Some(scope.owner_host_epoch.as_str())
        && runtime_generation == scope.runtime_generation
        && machine_host_id == Some(scope.machine_host_id.as_str())
        && matches!(lifecycle, aludock_client_core::InstanceLifecycle::Active)
}

async fn verify_attachment_target(
    client: &DockClient,
    instance_id: &str,
    scope: &AttachmentUploadScope,
) -> Result<(), CommandError> {
    let (catalog, host_epoch) = client
        .list_instances_with_host_epoch(InstanceSelector::Actionable)
        .await
        .map_err(attachment_upload_error)?;
    let current = catalog
        .instances
        .into_iter()
        .find(|instance| instance.id == instance_id)
        .ok_or_else(|| {
            attachment_command_error(
                "attachment_target_unavailable",
                "当前工作暂时不可用，附件选择已保留。",
            )
        })?;
    if !attachment_target_matches(
        &host_epoch,
        current.owner_host_epoch.as_deref(),
        current.runtime_generation,
        current.host_id.as_deref(),
        &current.lifecycle,
        scope,
    ) {
        return Err(attachment_command_error(
            "stale_attachment_target",
            "当前工作已更新，附件选择已保留并需要重新上传。",
        ));
    }
    Ok(())
}

fn attachment_scope_matches(
    entry: &NativeAttachment,
    connection_id: &str,
    selection_generation: u64,
    work_id: &str,
) -> bool {
    entry.connection_id == connection_id
        && entry.selection_generation == selection_generation
        && entry.work_id == work_id
}

fn ensure_attachment_scope(
    entry: &NativeAttachment,
    connection_id: &str,
    selection_generation: u64,
    work_id: &str,
) -> Result<(), CommandError> {
    if attachment_scope_matches(entry, connection_id, selection_generation, work_id) {
        Ok(())
    } else {
        Err(attachment_command_error(
            "stale_attachment_context",
            "附件不属于当前 Host 或工作。",
        ))
    }
}

type PreparedAttachment = (String, SelectedAttachment, NativeAttachment);

fn valid_attachment_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= 1_024 && !name.chars().any(char::is_control)
}

#[cfg(target_os = "android")]
fn normalized_media_type(value: Option<&str>) -> Option<String> {
    value
        .and_then(|value| value.parse::<mime_guess::Mime>().ok())
        .map(|value| value.essence_str().to_owned())
}

#[cfg(target_os = "android")]
fn fallback_attachment_name(media_type: Option<&str>) -> String {
    let extension = media_type
        .and_then(mime_guess::get_mime_extensions_str)
        .and_then(|extensions| extensions.first())
        .copied();
    match extension {
        Some(extension) => format!("附件-{}.{}", uuid::Uuid::new_v4(), extension),
        None => format!("附件-{}", uuid::Uuid::new_v4()),
    }
}

#[cfg(target_os = "android")]
fn copy_bounded_attachment(
    source: &mut impl Read,
    target: &mut impl Write,
    maximum_bytes: u64,
) -> std::io::Result<u64> {
    std::io::copy(&mut source.take(maximum_bytes.saturating_add(1)), target)
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidPickedFileMetadata {
    name: Option<String>,
    media_type: Option<String>,
}

#[cfg(target_os = "android")]
async fn describe_android_picked_file(
    app: &tauri::AppHandle,
    file: &FilePath,
) -> Result<AndroidPickedFileMetadata, CommandError> {
    use jni::objects::{JObject, JString, JValue};

    let FilePath::Url(url) = file else {
        return Err(attachment_command_error(
            "invalid_attachment_source",
            MSG_ATTACHMENT_NOT_PLAIN_FILE,
        ));
    };
    if url.scheme() != "content" {
        return Err(attachment_command_error(
            "invalid_attachment_source",
            MSG_ATTACHMENT_NOT_PLAIN_FILE,
        ));
    }
    let webview = app.get_webview_window("main").ok_or_else(|| {
        attachment_command_error(
            "attachment_source_unavailable",
            MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
        )
    })?;
    let uri = url.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            platform_webview
                .jni_handle()
                .exec(move |env, activity, _webview| {
                    let result = (|| -> jni::errors::Result<String> {
                        let uri = JObject::from(env.new_string(uri)?);
                        let description = env
                            .call_method(
                                activity,
                                "describePickedFile",
                                "(Ljava/lang/String;)Ljava/lang/String;",
                                &[JValue::Object(&uri)],
                            )?
                            .l()?;
                        Ok(env.get_string(&JString::from(description))?.into())
                    })();
                    let _ = sender.send(result.map_err(|error| error.to_string()));
                });
        })
        .map_err(|_| {
            attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
            )
        })?;
    let description = tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| {
            attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
            )
        })?
        .map_err(|_| {
            attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
            )
        })?
        .map_err(|_| {
            attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
            )
        })?;
    serde_json::from_str(&description).map_err(|_| {
        attachment_command_error(
            "attachment_source_unavailable",
            MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
        )
    })
}

#[cfg(target_os = "android")]
async fn stage_android_picked_file(
    app: &tauri::AppHandle,
    file: FilePath,
) -> Result<(PathBuf, String, u64, Option<String>), CommandError> {
    let description = describe_android_picked_file(app, &file).await?;
    let media_type = normalized_media_type(description.media_type.as_deref());
    let name = description
        .name
        .as_deref()
        .filter(|name| valid_attachment_name(name))
        .map(str::to_owned)
        .unwrap_or_else(|| fallback_attachment_name(media_type.as_deref()));
    let media_type =
        media_type.or_else(|| mime_guess::from_path(&name).first_raw().map(str::to_owned));
    let staging_directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| {
            attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
            )
        })?
        .join("attachment-staging");
    let staging_path =
        staging_directory.join(format!("aludock-selection-{}.part", uuid::Uuid::new_v4()));
    let staging_app = app.clone();
    let copied_path = staging_path.clone();
    let size_bytes = tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&staging_directory).map_err(|_| {
            attachment_command_error("attachment_source_unavailable", MSG_ATTACHMENT_STAGE_FAILED)
        })?;
        let mut source_options = PluginOpenOptions::new();
        source_options.read(true);
        let mut source = staging_app.fs().open(file, source_options).map_err(|_| {
            attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
            )
        })?;
        let mut target_options = OpenOptions::new();
        target_options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            target_options.mode(0o600);
        }
        let mut target = target_options.open(&copied_path).map_err(|_| {
            attachment_command_error("attachment_source_unavailable", MSG_ATTACHMENT_STAGE_FAILED)
        })?;
        let copied = match copy_bounded_attachment(&mut source, &mut target, MAX_ATTACHMENT_BYTES) {
            Ok(copied) => copied,
            Err(_) => {
                drop(target);
                let _ = fs::remove_file(&copied_path);
                return Err(attachment_command_error(
                    "attachment_source_unavailable",
                    MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
                ));
            }
        };
        if copied > MAX_ATTACHMENT_BYTES {
            drop(target);
            let _ = fs::remove_file(&copied_path);
            return Err(attachment_command_error(
                "attachment_too_large",
                &msg_attachment_too_large(),
            ));
        }
        if target.flush().is_err() {
            drop(target);
            let _ = fs::remove_file(&copied_path);
            return Err(attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_STAGE_FAILED,
            ));
        }
        Ok(copied)
    })
    .await
    .map_err(|_| lifecycle_error())??;
    Ok((staging_path, name, size_bytes, media_type))
}

#[allow(clippy::too_many_arguments)]
fn prepare_native_attachment(
    path: PathBuf,
    temporary: bool,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    name: String,
    size_bytes: u64,
    media_type: Option<String>,
) -> PreparedAttachment {
    let token = uuid::Uuid::new_v4().to_string();
    (
        token.clone(),
        SelectedAttachment {
            token,
            name: name.clone(),
            size_bytes,
            media_type: media_type.clone(),
        },
        NativeAttachment {
            path,
            temporary,
            connection_id,
            selection_generation,
            work_id,
            operation_id: uuid::Uuid::new_v4().to_string(),
            name,
            size_bytes,
            media_type,
            upload_scope: None,
            active_attempt: None,
        },
    )
}

fn request_header(request: &Request<'_>, name: &str) -> Result<String, CommandError> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| attachment_command_error("invalid_clipboard_image", MSG_PASTE_CONTEXT_LOST))
}

enum BoundedImageBodyError {
    Invalid,
    TooLarge,
}

fn bounded_image_body(request: &Request<'_>) -> Result<Vec<u8>, BoundedImageBodyError> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .filter(|value| *value <= u8::MAX as u64)
                    .map(|value| value as u8)
                    .ok_or(BoundedImageBodyError::Invalid)
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(BoundedImageBodyError::Invalid),
    };
    if bytes.is_empty() || bytes.len() as u64 > MAX_RENDERABLE_IMAGE_BYTES {
        return Err(BoundedImageBodyError::TooLarge);
    }
    Ok(bytes)
}

fn request_image_bytes(request: &Request<'_>) -> Result<Vec<u8>, CommandError> {
    bounded_image_body(request).map_err(|error| match error {
        BoundedImageBodyError::Invalid => {
            attachment_command_error("invalid_clipboard_image", MSG_CLIPBOARD_IMAGE_INVALID)
        }
        BoundedImageBodyError::TooLarge => attachment_command_error(
            "clipboard_image_too_large",
            "粘贴的图片过大，无法作为附件。请改用附件按钮选择原文件。",
        ),
    })
}

fn prepare_clipboard_image(
    bytes: Vec<u8>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    image_index: usize,
) -> Result<PreparedAttachment, CommandError> {
    let media_type = raster_image_mime_type(&bytes).ok_or_else(|| {
        attachment_command_error(
            "unsupported_clipboard_image",
            "剪贴板图片不是可用的 PNG、JPEG、GIF 或 WebP 格式。",
        )
    })?;
    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => unreachable!(),
    };
    let name = if image_index <= 1 {
        format!("粘贴的图片.{extension}")
    } else {
        format!("粘贴的图片-{image_index}.{extension}")
    };
    let path = std::env::temp_dir().join(format!(
        "aludock-client-clipboard-{}.{}",
        uuid::Uuid::new_v4(),
        extension
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| {
        attachment_command_error("clipboard_image_unavailable", MSG_PASTE_STAGE_FAILED)
    })?;
    if file.write_all(&bytes).and_then(|_| file.flush()).is_err() {
        let _ = fs::remove_file(&path);
        return Err(attachment_command_error(
            "clipboard_image_unavailable",
            MSG_PASTE_STAGE_FAILED,
        ));
    }
    drop(file);
    Ok(prepare_native_attachment(
        path,
        true,
        connection_id,
        selection_generation,
        work_id,
        name,
        bytes.len() as u64,
        Some(media_type.to_owned()),
    ))
}

fn publish_selected_attachments(
    lifecycle: &Mutex<RuntimeLifecycle>,
    state: &AttachmentState,
    connection_id: &str,
    selection_generation: u64,
    work_id: &str,
    prepared: Vec<PreparedAttachment>,
) -> Result<Vec<SelectedAttachment>, CommandError> {
    // Match set_active_host's lock order so generation validation and native-path
    // publication form one atomic lifecycle operation.
    let lifecycle = lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    let mut entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let current = entries
        .values()
        .filter(|entry| {
            attachment_scope_matches(entry, connection_id, selection_generation, work_id)
        })
        .count();
    if prepared.len() > MAX_ATTACHMENTS_PER_MESSAGE.saturating_sub(current) {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            &msg_attachment_selection_full(),
        ));
    }
    let mut selected = Vec::with_capacity(prepared.len());
    for (token, item, entry) in prepared {
        entries.insert(token, entry);
        selected.push(item);
    }
    Ok(selected)
}

const DELIVERABLE_SAVE_FAILED_MESSAGE: &str =
    "无法保存到所选位置。请检查可用空间和存储权限后重试。";
const SAVED_FILE_UNAVAILABLE_MESSAGE: &str =
    "找不到已保存的文件，或当前无法打开。请在设备的文件管理器中查找。";

fn deliverable_command_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn deliverable_list_error(error: ClientError) -> CommandError {
    match error {
        ClientError::Tls(_) | ClientError::MissingHostCertificate | ClientError::Io(_) => {
            deliverable_command_error(
                "deliverable_connection_failed",
                "无法加载文件列表。请检查连接后重试。",
            )
        }
        ClientError::Protocol(_) | ClientError::Json(_) => deliverable_command_error(
            "deliverable_list_failed",
            "无法加载文件列表。请更新电脑端 AluDock 后重试。",
        ),
        other => CommandError::from(other),
    }
}

fn deliverable_client_error(error: ClientError) -> CommandError {
    match error {
        ClientError::Host { code, .. } if code == "file_unavailable" => deliverable_command_error(
            "file_unavailable",
            "这个文件已无法下载。请让 Agent 重新发送。",
        ),
        ClientError::Tls(_) | ClientError::MissingHostCertificate => deliverable_command_error(
            "deliverable_connection_failed",
            "下载中断了。请检查网络后重试。",
        ),
        ClientError::Protocol(_) | ClientError::Json(_) => deliverable_command_error(
            "deliverable_verification_failed",
            "文件没有完整下载。请重试。",
        ),
        ClientError::Io(_) => deliverable_command_error(
            "deliverable_write_failed",
            "下载没有完成。请检查网络和设备存储后重试。",
        ),
        other => CommandError::from(other),
    }
}

fn workspace_command_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn workspace_state_error() -> CommandError {
    workspace_command_error(
        "workspace_state_unavailable",
        "工作区浏览状态暂时不可用。请关闭后重新打开。",
    )
}

fn workspace_cache_missing() -> CommandError {
    workspace_command_error(
        "workspace_cache_unavailable",
        "这个文件的预览已结束。请重新打开文件后再试。",
    )
}

fn workspace_read_cancelled() -> CommandError {
    workspace_command_error("workspace_read_cancelled", "已停止读取这个文件。")
}

fn workspace_client_error(error: ClientError) -> CommandError {
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

fn describe_saved_location(
    destination: &FilePath,
    name: &str,
) -> Result<SavedDeliverableLocation, CommandError> {
    match destination {
        FilePath::Path(path) => {
            let value = path.to_str().ok_or_else(|| {
                deliverable_command_error(
                    "deliverable_location_unsupported",
                    "无法使用这个保存位置。请选择其他位置。",
                )
            })?;
            Ok(SavedDeliverableLocation {
                kind: "path".into(),
                value: value.into(),
                label: value.into(),
            })
        }
        FilePath::Url(url) => Ok(SavedDeliverableLocation {
            kind: "uri".into(),
            value: url.to_string(),
            label: name.into(),
        }),
    }
}

fn delivery_staging_path(
    app: &tauri::AppHandle,
    destination: Option<&FilePath>,
) -> Result<PathBuf, CommandError> {
    let directory = match destination {
        Some(FilePath::Path(path)) => path.parent().map(PathBuf::from).ok_or_else(|| {
            deliverable_command_error(
                "deliverable_location_unavailable",
                "所选保存位置不可用。请选择其他位置。",
            )
        })?,
        Some(FilePath::Url(_)) | None => app.path().app_cache_dir().map_err(|_| {
            deliverable_command_error(
                "deliverable_location_unavailable",
                "暂时无法开始下载。请检查设备存储空间后重试。",
            )
        })?,
    };
    fs::create_dir_all(&directory).map_err(|_| {
        deliverable_command_error(
            "deliverable_location_unavailable",
            "无法使用这个保存位置。请检查存储权限后重试。",
        )
    })?;
    Ok(directory.join(format!(".aludock-download-{}.part", uuid::Uuid::new_v4())))
}

fn create_delivery_staging_file(path: &PathBuf) -> Result<std::fs::File, CommandError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| {
        deliverable_command_error(
            "deliverable_location_unavailable",
            "暂时无法开始下载。请检查设备存储空间和权限后重试。",
        )
    })
}

#[cfg(target_os = "android")]
async fn pick_save_destination(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<Option<FilePath>, CommandError> {
    // The dialog plugin maps Android errors to cancellation; preserve the distinction.
    android_documents::save_document(app, name)
        .await
        .map_err(|_| {
            deliverable_command_error("deliverable_picker_failed", "无法选择保存位置。请重试。")
        })
}

#[cfg(not(target_os = "android"))]
async fn pick_save_destination(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<Option<FilePath>, CommandError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(name.to_owned())
        .save_file(move |destination| {
            let _ = sender.send(destination);
        });
    receiver.await.map_err(|_| {
        deliverable_command_error("deliverable_picker_failed", "无法选择保存位置。请重试。")
    })
}

#[cfg(windows)]
fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

fn commit_staged_to_path(
    staging_path: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    if staging_path.parent() == destination.parent() {
        return replace_file_atomically(staging_path, destination);
    }
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination has no parent",
        )
    })?;
    let sibling = parent.join(format!(".aludock-download-{}.part", uuid::Uuid::new_v4()));
    let copy_result = (|| {
        let mut source = std::fs::File::open(staging_path)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut target = options.open(&sibling)?;
        std::io::copy(&mut source, &mut target)?;
        target.flush()?;
        target.sync_all()?;
        replace_file_atomically(&sibling, destination)
    })();
    if copy_result.is_err() {
        let _ = fs::remove_file(&sibling);
    }
    copy_result
}

fn copy_staged_to_uri(
    app: &tauri::AppHandle,
    staging_path: &std::path::Path,
    destination: FilePath,
) -> std::io::Result<()> {
    let mut source = std::fs::File::open(staging_path)?;
    let mut options = PluginOpenOptions::new();
    options.write(true).truncate(true);
    let mut target = app.fs().open(destination.clone(), options)?;
    let copied = std::io::copy(&mut source, &mut target)?;
    if copied != source.metadata()?.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "saved byte count did not match the verified download",
        ));
    }
    target.flush()?;
    target.sync_all()?;
    Ok(())
}

#[cfg(target_os = "android")]
async fn discard_partial_uri(app: &tauri::AppHandle, destination: &FilePath) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    let FilePath::Url(url) = destination else {
        return Err("the Android save target was not a document URI".into());
    };
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "the Android application view was unavailable".to_string())?;
    let uri = url.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            platform_webview
                .jni_handle()
                .exec(move |env, activity, _webview| {
                    let result = (|| -> jni::errors::Result<bool> {
                        let resolver = env
                            .call_method(
                                activity,
                                "getContentResolver",
                                "()Landroid/content/ContentResolver;",
                                &[],
                            )?
                            .l()?;
                        let uri_text = JObject::from(env.new_string(uri)?);
                        let uri = env
                            .call_static_method(
                                "android/net/Uri",
                                "parse",
                                "(Ljava/lang/String;)Landroid/net/Uri;",
                                &[JValue::Object(&uri_text)],
                            )?
                            .l()?;
                        env.call_static_method(
                            "android/provider/DocumentsContract",
                            "deleteDocument",
                            "(Landroid/content/ContentResolver;Landroid/net/Uri;)Z",
                            &[JValue::Object(&resolver), JValue::Object(&uri)],
                        )?
                        .z()
                    })();
                    let outcome = match result {
                        Ok(true) => Ok(()),
                        Ok(false) => {
                            Err("the document provider did not remove the partial file".into())
                        }
                        Err(error) => Err(error.to_string()),
                    };
                    let _ = sender.send(outcome);
                });
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "timed out removing the partial document".to_string())?
        .map_err(|_| "the partial-document cleanup task ended unexpectedly".to_string())?
}

#[cfg(not(target_os = "android"))]
async fn discard_partial_uri(
    _app: &tauri::AppHandle,
    destination: &FilePath,
) -> Result<(), String> {
    let FilePath::Url(url) = destination else {
        return Err("the save target was not a URL".into());
    };
    let path = url
        .to_file_path()
        .map_err(|_| "the save URL cannot be removed as a local file".to_string())?;
    fs::remove_file(path).map_err(|error| error.to_string())
}

async fn commit_verified_file(
    app: &tauri::AppHandle,
    staging_path: PathBuf,
    destination: FilePath,
) -> Result<(), CommandError> {
    let commit_app = app.clone();
    let commit_staging = staging_path.clone();
    let commit_destination = destination.clone();
    let result = tokio::task::spawn_blocking(move || match &commit_destination {
        FilePath::Path(path) => commit_staged_to_path(&commit_staging, path),
        FilePath::Url(_) => copy_staged_to_uri(&commit_app, &commit_staging, commit_destination),
    })
    .await
    .map_err(|_| lifecycle_error())?;
    if let Err(error) = result {
        let cleanup_error = if matches!(destination, FilePath::Url(_)) {
            discard_partial_uri(app, &destination).await.err()
        } else {
            None
        };
        let _ = fs::remove_file(staging_path);
        return Err(CommandError {
            code: if cleanup_error.is_some() {
                "deliverable_cleanup_failed".into()
            } else {
                "deliverable_commit_failed".into()
            },
            message: if cleanup_error.is_some() {
                "文件未能完整保存，所选位置可能留有未完成的文件。请删除该文件后重试。".into()
            } else {
                DELIVERABLE_SAVE_FAILED_MESSAGE.into()
            },
            details: Some(serde_json::json!({
                "reason": error.to_string(),
                "cleanupError": cleanup_error,
            })),
            outcome_unknown: false,
            operation_id: None,
        });
    }
    if staging_path.exists() {
        let _ = fs::remove_file(staging_path);
    }
    Ok(())
}

#[tauri::command]
async fn list_deliverables(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<Vec<DeliverableDto>, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .list_deliverables(&instance_id)
        .await
        .map_err(deliverable_list_error)
}

#[tauri::command]
async fn download_deliverable(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    deliverable: DeliverableDto,
) -> Result<DeliverableSaveResult, CommandError> {
    deliverable.validate().map_err(deliverable_client_error)?;
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    #[cfg(not(mobile))]
    let destination = pick_save_destination(&app, &deliverable.name).await?;
    // The mobile dialog uses the platform create-document flow. Download and
    // verify in app-private storage first, then create the user-visible target.
    #[cfg(mobile)]
    let mut destination: Option<FilePath> = None;
    #[cfg(not(mobile))]
    if destination.is_none() {
        return Ok(DeliverableSaveResult::Cancelled);
    }
    let staging_path = delivery_staging_path(&app, destination.as_ref())?;
    let staging_file = create_delivery_staging_file(&staging_path)?;
    let mut staging_file = tokio::fs::File::from_std(staging_file);

    let progress_app = app.clone();
    let progress_host = connection_id.clone();
    let progress_instance = instance_id.clone();
    let progress_ref = deliverable.delivery_ref.clone();
    let result = client
        .download_deliverable(
            &instance_id,
            &deliverable.delivery_ref,
            &mut staging_file,
            move |DeliverableDownloadProgress {
                      bytes_received,
                      total_bytes,
                  }| {
                let _ = progress_app.emit(
                    "aludock://deliverable-progress",
                    DeliverableProgressEmission {
                        connection_id: progress_host.clone(),
                        selection_generation,
                        instance_id: progress_instance.clone(),
                        delivery_ref: progress_ref.clone(),
                        bytes_received,
                        total_bytes,
                    },
                );
            },
        )
        .await;
    let result = match result {
        Ok(result) if result.deliverable == deliverable => result,
        Ok(_) => {
            drop(staging_file);
            let _ = fs::remove_file(&staging_path);
            return Err(deliverable_command_error(
                "deliverable_verification_failed",
                "下载的文件与列表中的信息不一致。请刷新列表后重试。",
            ));
        }
        Err(error) => {
            drop(staging_file);
            let _ = fs::remove_file(&staging_path);
            return Err(deliverable_client_error(error));
        }
    };
    if staging_file.sync_all().await.is_err() {
        drop(staging_file);
        let _ = fs::remove_file(&staging_path);
        return Err(deliverable_command_error(
            "deliverable_write_failed",
            DELIVERABLE_SAVE_FAILED_MESSAGE,
        ));
    }
    drop(staging_file);
    #[cfg(mobile)]
    {
        destination = match pick_save_destination(&app, &deliverable.name).await {
            Ok(destination) => destination,
            Err(error) => {
                let _ = fs::remove_file(&staging_path);
                return Err(error);
            }
        };
        if destination.is_none() {
            let _ = fs::remove_file(&staging_path);
            return Ok(DeliverableSaveResult::Cancelled);
        }
    }
    let destination = destination.expect("save cancellation returned before commit");
    let saved_location = match describe_saved_location(&destination, &deliverable.name) {
        Ok(location) => location,
        Err(error) => {
            let _ = fs::remove_file(&staging_path);
            return Err(error);
        }
    };
    commit_verified_file(&app, staging_path, destination.clone()).await?;
    #[cfg(target_os = "android")]
    if let FilePath::Url(url) = &destination {
        // Providers may revoke transient grants after the Activity is gone. Keep the
        // document readable across app restarts when the provider supports it.
        let _ = android_documents::retain_document_access(&app, url.as_str()).await;
    }

    Ok(DeliverableSaveResult::Saved {
        deliverable: result.deliverable,
        location: saved_location,
        sha256: result.sha256,
    })
}

#[tauri::command]
async fn open_saved_deliverable(
    app: tauri::AppHandle,
    location: SavedDeliverableLocation,
) -> Result<(), CommandError> {
    if location.value.is_empty() {
        return Err(deliverable_command_error(
            "saved_file_unavailable",
            SAVED_FILE_UNAVAILABLE_MESSAGE,
        ));
    }
    match location.kind.as_str() {
        "path" => {
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            {
                let path = PathBuf::from(&location.value);
                let directory =
                    path.parent()
                        .filter(|parent| parent.is_dir())
                        .ok_or_else(|| {
                            deliverable_command_error(
                                "saved_location_unavailable",
                                "保存位置已不可用。请重新下载文件并选择保存位置。",
                            )
                        })?;
                let directory = directory.to_str().ok_or_else(|| {
                    deliverable_command_error(
                        "saved_location_unsupported",
                        "无法使用这个保存位置。请重新下载文件并选择其他位置。",
                    )
                })?;
                app.opener()
                    .open_path(directory, None::<&str>)
                    .map_err(|_| {
                        deliverable_command_error(
                            "saved_location_open_failed",
                            "暂时无法打开保存位置。请稍后重试。",
                        )
                    })?;
            }
            #[cfg(target_os = "ios")]
            app.opener()
                .open_path(location.value, None::<&str>)
                .map_err(|_| {
                    deliverable_command_error(
                        "saved_file_open_failed",
                        SAVED_FILE_UNAVAILABLE_MESSAGE,
                    )
                })?;
            #[cfg(target_os = "android")]
            {
                Err(deliverable_command_error(
                    "saved_file_unavailable",
                    "文件已不在保存位置。请重新下载。",
                ))
            }
            #[cfg(not(target_os = "android"))]
            {
                Ok(())
            }
        }
        "uri" => {
            #[cfg(target_os = "android")]
            {
                let media_type = mime_guess::from_path(&location.label).first_raw();
                return match android_documents::open_document(&app, &location.value, media_type)
                    .await
                    .map_err(|_| {
                        deliverable_command_error(
                            "saved_file_open_failed",
                            "暂时无法打开这个文件。请稍后重试。",
                        )
                    })? {
                    android_documents::OpenDocumentOutcome::Opened => Ok(()),
                    android_documents::OpenDocumentOutcome::Unavailable => {
                        Err(deliverable_command_error(
                            "saved_file_unavailable",
                            "文件已不在保存位置。请重新下载。",
                        ))
                    }
                    android_documents::OpenDocumentOutcome::NoHandler => {
                        Err(deliverable_command_error(
                            "saved_file_no_handler",
                            "没有可用的应用打开这个文件。",
                        ))
                    }
                    android_documents::OpenDocumentOutcome::Failed => {
                        Err(deliverable_command_error(
                            "saved_file_open_failed",
                            "暂时无法打开这个文件。请稍后重试。",
                        ))
                    }
                };
            }
            #[cfg(not(target_os = "android"))]
            app.opener()
                .open_url(location.value, None::<&str>)
                .map_err(|_| {
                    deliverable_command_error(
                        "saved_file_unavailable",
                        SAVED_FILE_UNAVAILABLE_MESSAGE,
                    )
                })
        }
        _ => Err(deliverable_command_error(
            "saved_file_unavailable",
            SAVED_FILE_UNAVAILABLE_MESSAGE,
        )),
    }
}

#[tauri::command]
async fn pick_attachments(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
) -> Result<Vec<SelectedAttachment>, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let existing = state
        .entries
        .lock()
        .map_err(|_| lifecycle_error())?
        .values()
        .filter(|entry| {
            attachment_scope_matches(entry, &connection_id, selection_generation, &work_id)
        })
        .count();
    if existing >= MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            &msg_attachment_selection_full(),
        ));
    }

    #[cfg(target_os = "android")]
    let files = android_documents::pick_recent_files(&app)
        .await
        .map_err(|_| attachment_command_error("attachment_picker_failed", "无法完成附件选择。"))?;
    #[cfg(not(target_os = "android"))]
    let files = {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_files(move |files| {
            let _ = sender.send(files);
        });
        let Some(files) = receiver.await.map_err(|_| {
            attachment_command_error("attachment_picker_failed", "无法完成附件选择。")
        })?
        else {
            return Ok(Vec::new());
        };
        files
    };
    if files.len() > MAX_ATTACHMENTS_PER_MESSAGE - existing {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            &msg_attachment_selection_full(),
        ));
    }

    let mut prepared = Vec::with_capacity(files.len());
    for file in files {
        let local_path = file.clone().into_path();
        let (path, temporary, name, size_bytes, media_type) = match local_path {
            Ok(path) => {
                let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
                    attachment_command_error(
                        "attachment_source_unavailable",
                        MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
                    )
                })?;
                if !metadata.file_type().is_file() {
                    return Err(attachment_command_error(
                        "invalid_attachment_source",
                        MSG_ATTACHMENT_NOT_PLAIN_FILE,
                    ));
                }
                if metadata.len() > MAX_ATTACHMENT_BYTES {
                    return Err(attachment_command_error(
                        "attachment_too_large",
                        &msg_attachment_too_large(),
                    ));
                }
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| valid_attachment_name(name))
                    .ok_or_else(|| {
                        attachment_command_error("invalid_attachment_name", "附件名称无效。")
                    })?
                    .to_owned();
                let media_type = mime_guess::from_path(&path).first_raw().map(str::to_owned);
                (path, false, name, metadata.len(), media_type)
            }
            Err(_) => {
                #[cfg(target_os = "android")]
                {
                    let (path, name, size_bytes, media_type) =
                        stage_android_picked_file(&app, file).await?;
                    (path, true, name, size_bytes, media_type)
                }
                #[cfg(not(target_os = "android"))]
                {
                    return Err(attachment_command_error(
                        "invalid_attachment_source",
                        MSG_ATTACHMENT_NOT_PLAIN_FILE,
                    ));
                }
            }
        };
        prepared.push(prepare_native_attachment(
            path,
            temporary,
            connection_id.clone(),
            selection_generation,
            work_id.clone(),
            name,
            size_bytes,
            media_type,
        ));
    }

    publish_selected_attachments(
        runtime.lifecycle.as_ref(),
        &state,
        &connection_id,
        selection_generation,
        &work_id,
        prepared,
    )
}

#[tauri::command]
async fn stage_clipboard_image(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    request: Request<'_>,
) -> Result<SelectedAttachment, CommandError> {
    let connection_id = request_header(&request, "x-aludock-connection-id")?;
    let selection_generation = request_header(&request, "x-aludock-selection-generation")?
        .parse::<u64>()
        .map_err(|_| attachment_command_error("invalid_clipboard_image", MSG_PASTE_CONTEXT_LOST))?;
    let work_id = request_header(&request, "x-aludock-work-id")?;
    let image_index = request_header(&request, "x-aludock-image-index")?
        .parse::<usize>()
        .ok()
        .filter(|index| (1..=MAX_ATTACHMENTS_PER_MESSAGE).contains(index))
        .ok_or_else(|| {
            attachment_command_error("invalid_clipboard_image", MSG_PASTE_CONTEXT_LOST)
        })?;
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let bytes = request_image_bytes(&request)?;
    let prepared_connection = connection_id.clone();
    let prepared_work = work_id.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        prepare_clipboard_image(
            bytes,
            prepared_connection,
            selection_generation,
            prepared_work,
            image_index,
        )
    })
    .await
    .map_err(|_| lifecycle_error())??;
    publish_selected_attachments(
        runtime.lifecycle.as_ref(),
        &state,
        &connection_id,
        selection_generation,
        &work_id,
        vec![prepared],
    )?
    .into_iter()
    .next()
    .ok_or_else(lifecycle_error)
}

#[tauri::command]
async fn attachment_preview(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
) -> Result<Response, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let (path, operation_id, size_bytes, media_type) = {
        let entries = state.entries.lock().map_err(|_| lifecycle_error())?;
        let entry = entries.get(&token).ok_or_else(|| {
            attachment_command_error(
                "attachment_preview_unavailable",
                MSG_ATTACHMENT_PREVIEW_LOST,
            )
        })?;
        ensure_attachment_scope(entry, &connection_id, selection_generation, &work_id)?;
        if entry.size_bytes > MAX_RENDERABLE_IMAGE_BYTES {
            return Err(attachment_command_error(
                "attachment_preview_too_large",
                "这个图片附件太大，无法预览，但仍可发送。",
            ));
        }
        (
            entry.path.clone(),
            entry.operation_id.clone(),
            entry.size_bytes,
            entry.media_type.clone(),
        )
    };
    let bytes = tokio::task::spawn_blocking(move || fs::read(path))
        .await
        .map_err(|_| lifecycle_error())?
        .map_err(|_| {
            attachment_command_error(
                "attachment_preview_unavailable",
                "无法读取这个图片附件，但仍可发送。",
            )
        })?;
    if bytes.len() as u64 != size_bytes {
        return Err(attachment_command_error(
            "attachment_source_changed",
            MSG_ATTACHMENT_SOURCE_CHANGED,
        ));
    }
    validate_renderable_image(&bytes, media_type.as_deref())?;
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let entry = entries.get(&token).ok_or_else(|| {
        attachment_command_error(
            "attachment_preview_unavailable",
            MSG_ATTACHMENT_PREVIEW_LOST,
        )
    })?;
    ensure_attachment_scope(entry, &connection_id, selection_generation, &work_id)?;
    if entry.operation_id != operation_id {
        return Err(attachment_command_error(
            "attachment_preview_unavailable",
            MSG_ATTACHMENT_PREVIEW_LOST,
        ));
    }
    drop(entries);
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn upload_attachment(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    target_machine_host_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    token: String,
) -> Result<AttachmentUploadResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let upload_scope = AttachmentUploadScope {
        machine_host_id: target_machine_host_id,
        owner_host_epoch: expected_host_epoch,
        runtime_generation: expected_runtime_generation,
    };
    verify_attachment_target(&client, &work_id, &upload_scope).await?;
    let (path, operation_id, name, media_type, cancellation, attempt_id) = {
        let mut entries = state.entries.lock().map_err(|_| lifecycle_error())?;
        let entry = entries.get_mut(&token).ok_or_else(|| {
            attachment_command_error("attachment_not_found", "附件选择已失效，请重新选择。")
        })?;
        ensure_attachment_scope(entry, &connection_id, selection_generation, &work_id)?;
        if entry.active_attempt.is_some() {
            return Err(attachment_command_error(
                "attachment_upload_in_progress",
                "此附件正在上传。",
            ));
        }
        if entry.upload_scope.as_ref() != Some(&upload_scope) {
            entry.operation_id = uuid::Uuid::new_v4().to_string();
            entry.upload_scope = Some(upload_scope.clone());
        }
        let metadata = std::fs::symlink_metadata(&entry.path).map_err(|_| {
            attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
            )
        })?;
        if !metadata.file_type().is_file() || metadata.len() != entry.size_bytes {
            return Err(attachment_command_error(
                "attachment_source_changed",
                MSG_ATTACHMENT_SOURCE_CHANGED,
            ));
        }
        let cancellation = AttachmentUploadCancellation::new();
        let attempt_id = uuid::Uuid::new_v4().to_string();
        entry.active_attempt = Some(AttachmentAttempt {
            id: attempt_id.clone(),
            cancellation: cancellation.clone(),
        });
        (
            entry.path.clone(),
            entry.operation_id.clone(),
            entry.name.clone(),
            entry.media_type.clone(),
            cancellation,
            attempt_id,
        )
    };

    let progress_app = app.clone();
    let progress_host = connection_id.clone();
    let progress_work = work_id.clone();
    let progress_token = token.clone();
    let progress_scope = upload_scope.clone();
    let result = client
        .upload_attachment_file(
            path,
            &operation_id,
            &work_id,
            &name,
            media_type.as_deref(),
            &cancellation,
            move |progress| {
                let phase = match progress.phase {
                    AttachmentUploadPhase::Hashing => "hashing",
                    AttachmentUploadPhase::Uploading => "uploading",
                    AttachmentUploadPhase::Finalizing => "finalizing",
                };
                let _ = progress_app.emit(
                    "aludock://attachment-progress",
                    AttachmentProgressEmission {
                        connection_id: progress_host.clone(),
                        selection_generation,
                        work_id: progress_work.clone(),
                        machine_host_id: progress_scope.machine_host_id.clone(),
                        owner_host_epoch: progress_scope.owner_host_epoch.clone(),
                        runtime_generation: progress_scope.runtime_generation,
                        token: progress_token.clone(),
                        phase: phase.into(),
                        bytes_processed: progress.bytes_processed,
                        total_bytes: progress.total_bytes,
                    },
                );
            },
        )
        .await;
    let result = match result {
        Ok(result) => verify_attachment_target(&client, &work_id, &upload_scope)
            .await
            .map(|()| result),
        Err(error) => Err(attachment_upload_error(error)),
    };

    let mut entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let still_current = entries.get(&token).is_some_and(|entry| {
        attachment_scope_matches(entry, &connection_id, selection_generation, &work_id)
            && entry.operation_id == operation_id
            && entry.upload_scope.as_ref() == Some(&upload_scope)
            && entry
                .active_attempt
                .as_ref()
                .is_some_and(|attempt| attempt.id == attempt_id)
    });
    if !still_current {
        return Err(attachment_command_error(
            "stale_attachment_context",
            "附件上下文已失效。",
        ));
    }
    match result {
        Ok(result) => {
            if let Some(entry) = entries.get_mut(&token) {
                entry.active_attempt = None;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(entry) = entries.get_mut(&token) {
                entry.active_attempt = None;
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn cancel_attachment_upload(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
) -> Result<bool, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let Some(entry) = entries.get(&token) else {
        return Ok(false);
    };
    ensure_attachment_scope(entry, &connection_id, selection_generation, &work_id)?;
    if let Some(attempt) = &entry.active_attempt {
        attempt.cancellation.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn remove_attachment(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
) -> Result<bool, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let mut entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let Some(entry) = entries.get(&token) else {
        return Ok(false);
    };
    ensure_attachment_scope(entry, &connection_id, selection_generation, &work_id)?;
    if let Some(attempt) = &entry.active_attempt {
        attempt.cancellation.cancel();
    }
    entries.remove(&token);
    Ok(true)
}

fn restored_image_scope(
    connection_id: &str,
    selection_generation: u64,
    work_id: &str,
) -> RestoredImageScope {
    RestoredImageScope {
        connection_id: connection_id.to_owned(),
        selection_generation,
        work_id: work_id.to_owned(),
    }
}

#[tauri::command]
async fn submit_message(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    message: String,
    attachment_file_ids: Option<Vec<String>>,
) -> Result<SubmitResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let scope = restored_image_scope(&connection_id, selection_generation, &instance_id);
    let captured = restored_images.capture(&scope);
    let attachment_file_ids = attachment_file_ids.unwrap_or_default();
    let images = captured
        .as_ref()
        .map_or(&[][..], |bucket| bucket.images.as_slice());
    let result = client
        .submit_message_with_attachments_and_images(
            &instance_id,
            &message,
            &attachment_file_ids,
            images,
            DeliveryMode::Auto,
            None,
        )
        .await
        .map_err(CommandError::from)?;
    if let Some(bucket) = captured {
        restored_images.clear_after_success(&scope, &bucket.tokens);
    }
    Ok(result)
}

#[tauri::command]
async fn dequeue_messages(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeQueueDequeueResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let result = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .dequeue_messages(&instance_id, None)
        .await
        .map_err(CommandError::from)?;
    let images = result
        .receipt
        .restored
        .iter()
        .flat_map(|item| item.images.iter().cloned())
        .collect();
    restored_images.append(
        restored_image_scope(&connection_id, selection_generation, &instance_id),
        images,
    );
    Ok(project_queue_dequeue(result))
}

#[tauri::command]
fn clear_restored_images(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<RestoredImageCount, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    Ok(RestoredImageCount {
        image_count: restored_images.clear_scope(&restored_image_scope(
            &connection_id,
            selection_generation,
            &instance_id,
        )),
    })
}

#[tauri::command]
async fn abort_run(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    client
        .abort_run(&instance_id, None)
        .await
        .map_err(CommandError::from)
}

fn detach_work_runtime(
    follow: &FollowState,
    extension: &ExtensionControlState,
    connection_id: &str,
    selection_generation: u64,
    instance_id: &str,
) {
    let _ = follow.abort_matching(connection_id, selection_generation, instance_id, None);
    if let Ok(mut guard) = extension.inner.lock()
        && guard.binding.as_ref().is_some_and(|binding| {
            binding.connection_id == connection_id
                && binding.selection_generation == selection_generation
                && binding.instance_id == instance_id
        })
    {
        guard.binding = None;
        if let Some(task) = guard.task.take() {
            task.abort();
        }
    }
}

#[tauri::command]
async fn stop_work(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<StopResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let result = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .stop_instance(&instance_id, None)
        .await
        .map_err(CommandError::from)?;
    detach_work_runtime(
        &follow,
        &extension,
        &connection_id,
        selection_generation,
        &instance_id,
    );
    Ok(result)
}

#[tauri::command]
async fn command_catalog(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    references: tauri::State<'_, CommandReferenceState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeCommandsResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let scope = CommandReferenceScope {
        connection_id,
        selection_generation,
        instance_id,
    };
    let reference_generation = references.begin(&scope);
    let result = client
        .commands(&scope.instance_id, None)
        .await
        .map_err(CommandError::from)?;
    project_commands(result, &references, scope, reference_generation)
}

#[tauri::command]
async fn command_content(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    references: tauri::State<'_, CommandReferenceState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    reference_id: String,
    cursor: Option<String>,
) -> Result<SafeCommandContentResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let scope = CommandReferenceScope {
        connection_id: connection_id.clone(),
        selection_generation,
        instance_id: instance_id.clone(),
    };
    let command = references.resolve(&scope, &reference_id)?;
    let result: CommandContentResult =
        dock_client(&runtime, &connection_id, selection_generation, &store)?
            .command_content(&instance_id, &command, cursor.as_deref())
            .await
            .map_err(CommandError::from)?;
    Ok(SafeCommandContentResult {
        reference_id,
        available: result.available,
        format: result.format,
        revision: result.revision,
        text: result.text,
        complete: result.complete,
        next_cursor: result.next_cursor,
    })
}

#[tauri::command]
async fn command_completions(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    references: tauri::State<'_, CommandReferenceState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    reference_id: String,
    argument_prefix: String,
) -> Result<SafeCommandCompletionsResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let scope = CommandReferenceScope {
        connection_id: connection_id.clone(),
        selection_generation,
        instance_id: instance_id.clone(),
    };
    let command = references.resolve(&scope, &reference_id)?;
    let result: CommandCompletionsResult =
        dock_client(&runtime, &connection_id, selection_generation, &store)?
            .command_completions(&instance_id, &command, &argument_prefix)
            .await
            .map_err(CommandError::from)?;
    Ok(SafeCommandCompletionsResult {
        reference_id,
        items: match result.items {
            CommandCompletionItems::Available(items) => Some(items),
            CommandCompletionItems::Unavailable(()) => None,
        },
        total: result.total,
        truncated: result.truncated,
    })
}

#[tauri::command]
async fn run_catalog_command(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    name: String,
    arguments: String,
    operation_id: String,
) -> Result<SubmitResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let catalog = client
        .commands(&instance_id, None)
        .await
        .map_err(CommandError::from)?;
    let valid_name = !name.is_empty()
        && !name.contains('/')
        && !name
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && catalog.commands.iter().any(|command| command.name == name);
    if !valid_name {
        return Err(CommandError {
            code: "command_not_in_catalog".into(),
            message: "所选命令已不在当前 Dock 命令目录中，请刷新后重新选择。".into(),
            details: None,
            outcome_unknown: false,
            operation_id: None,
        });
    }
    let arguments = arguments.trim();
    let message = if arguments.is_empty() {
        format!("/{name}")
    } else {
        format!("/{name} {arguments}")
    };
    client
        .submit_message(
            &instance_id,
            &message,
            DeliveryMode::Auto,
            Some(&operation_id),
        )
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn list_models(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<ModelsResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .models(&instance_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn set_model(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    provider: String,
    model_id: String,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .set_model(&instance_id, &provider, &model_id, None)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn set_thinking(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    level: ThinkingLevel,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .set_thinking(&instance_id, level, None)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn list_tools(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeToolsResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .tools(&instance_id)
        .await
        .map(project_tools)
        .map_err(CommandError::from)
}

#[tauri::command]
async fn set_active_tools(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    names: Vec<String>,
) -> Result<SafeToolsResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .set_active_tools(&instance_id, &names, None)
        .await
        .map(project_tools)
        .map_err(CommandError::from)
}

#[tauri::command]
async fn get_settings(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SettingsResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .settings(&instance_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn update_setting(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    update: SettingUpdate,
) -> Result<SettingUpdateResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .update_setting(&instance_id, &update, None)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn get_resources(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeResourcesResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .resources(&instance_id)
        .await
        .map(project_resources)
        .map_err(CommandError::from)
}

fn project_source(source: SourceInfo) -> SafeSource {
    SafeSource {
        kind: format!("{:?}", source.kind)
            .to_lowercase()
            .replace("builtin", "built-in"),
        package: source.package,
    }
}

fn project_commands(
    result: CommandsResult,
    state: &CommandReferenceState,
    scope: CommandReferenceScope,
    reference_generation: u64,
) -> Result<SafeCommandsResult, CommandError> {
    let mut references = HashMap::new();
    let commands = result
        .commands
        .into_iter()
        .map(|command: CommandInfo| {
            let reference_id = uuid::Uuid::new_v4().to_string();
            references.insert(reference_id.clone(), CommandReference::from(&command));
            SafeCommand {
                reference_id,
                name: command.name,
                description: command.description,
                source: project_source(command.source),
                argument_hint: command.argument_hint,
                argument_completions: command.argument_completions,
                content_available: command.content_available == Some(true),
            }
        })
        .collect();
    if !state.replace(scope, reference_generation, references) {
        return Err(command_reference_expired());
    }
    Ok(SafeCommandsResult {
        commands,
        total: result.total,
        truncated: result.truncated,
    })
}

fn project_tools(result: ToolsResult) -> SafeToolsResult {
    SafeToolsResult {
        tools: result
            .tools
            .into_iter()
            .map(|tool: ToolInfo| SafeTool {
                name: tool.name,
                description: tool.description,
                active: tool.active,
                source: tool.source.map(project_source),
            })
            .collect(),
        instance: result.instance,
        total: result.total,
        truncated: result.truncated,
    }
}

fn project_resources(result: ResourcesResult) -> SafeResourcesResult {
    SafeResourcesResult {
        resources: result
            .resources
            .into_iter()
            .map(|resource: ResourceInfo| SafeResource {
                kind: format!("{:?}", resource.kind).to_lowercase(),
                name: resource.name,
                source: resource.source.map(project_source),
            })
            .collect(),
        diagnostics: result
            .diagnostics
            .into_iter()
            .map(|diagnostic: DiagnosticInfo| SafeDiagnostic {
                severity: format!("{:?}", diagnostic.severity).to_lowercase(),
                message: diagnostic.message,
            })
            .collect(),
        resource_total: result.resource_total,
        resources_truncated: result.resources_truncated,
        diagnostic_total: result.diagnostic_total,
        diagnostics_truncated: result.diagnostics_truncated,
    }
}

#[tauri::command]
async fn reopen_work(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    operation_id: Option<String>,
    trust_challenge_id: Option<String>,
    project_trust_decision: Option<String>,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let continuation = parse_trust_continuation(
        trust_challenge_id.as_deref(),
        project_trust_decision.as_deref(),
        operation_id.clone(),
    )?;
    let result = client
        .reopen_instance(&instance_id, continuation, operation_id.as_deref())
        .await
        .map_err(CommandError::from)?;
    Ok(result.instance)
}

#[tauri::command]
async fn forget_work(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<(), CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    client
        .forget_instance(&instance_id, None)
        .await
        .map_err(CommandError::from)?;
    Ok(())
}

fn parse_connection_kind(kind: &str) -> Result<ConnectionKind, CommandError> {
    match kind {
        "local" => Ok(ConnectionKind::Local),
        "remote" => Ok(ConnectionKind::Remote),
        "vpn" => Ok(ConnectionKind::Vpn),
        "manual" => Ok(ConnectionKind::Manual),
        _ => Err(CommandError {
            code: "invalid_endpoint_kind".into(),
            message: "未知的连接地址类型".into(),
            details: None,
            outcome_unknown: false,
            operation_id: None,
        }),
    }
}

struct VerifiedEndpointMutation {
    endpoint: Endpoint,
    label: String,
    kind: ConnectionKind,
    expected_revision: u64,
}

fn persist_verified_host_endpoint(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
    mutation: VerifiedEndpointMutation,
) -> Result<HostConnectionProfile, CommandError> {
    let profile = mutate_selected_host(runtime, connection_id, selection_generation, |store| {
        save_verified_endpoint(
            store,
            mutation.endpoint,
            &mutation.label,
            mutation.kind,
            mutation.expected_revision,
        )
    })?;
    reconcile_selected_client(runtime, connection_id, selection_generation, &profile)?;
    Ok(profile)
}

fn persist_host_endpoint_test(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
    endpoint_id: &str,
    expected_revision: u64,
    probe: aludock_client_core::Result<()>,
) -> Result<EndpointTestResult, CommandError> {
    let result = mutate_selected_host(runtime, connection_id, selection_generation, |store| {
        record_endpoint_test(store, endpoint_id, expected_revision, probe)
    })?;
    reconcile_selected_client(
        runtime,
        connection_id,
        selection_generation,
        &result.profile,
    )?;
    Ok(result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn verify_host_endpoint(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    host: String,
    port: u16,
    label: String,
    kind: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let endpoint = Endpoint::new(host, port).map_err(CommandError::from)?;
    let kind = parse_connection_kind(&kind)?;
    probe_host_endpoint(&store, &endpoint)
        .await
        .map_err(CommandError::from)?;
    persist_verified_host_endpoint(
        &runtime,
        &connection_id,
        selection_generation,
        VerifiedEndpointMutation {
            endpoint,
            label,
            kind,
            expected_revision,
        },
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn save_unverified_host_endpoint(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    host: String,
    port: u16,
    label: String,
    kind: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let endpoint = Endpoint::new(host, port).map_err(CommandError::from)?;
    let profile = save_unverified_endpoint(
        &store,
        endpoint,
        &label,
        parse_connection_kind(&kind)?,
        expected_revision,
    )
    .map_err(CommandError::from)?;
    reconcile_selected_client(&runtime, &connection_id, selection_generation, &profile)?;
    Ok(profile)
}

#[tauri::command]
async fn test_host_endpoint(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    endpoint_id: String,
) -> Result<EndpointTestResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let endpoint = saved_endpoint_for_test(&store, &endpoint_id, expected_revision)
        .map_err(CommandError::from)?;
    let probe = probe_host_endpoint(&store, &endpoint).await;
    persist_host_endpoint_test(
        &runtime,
        &connection_id,
        selection_generation,
        &endpoint_id,
        expected_revision,
        probe,
    )
}

#[tauri::command]
fn rename_host_profile(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    display_name: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let profile = store
        .update_connection_profile_at(expected_revision, |profile| {
            profile.display_name = display_name;
            Ok(())
        })
        .map_err(CommandError::from)?;
    reconcile_selected_client(&runtime, &connection_id, selection_generation, &profile)?;
    Ok(profile)
}

#[tauri::command]
fn set_connection_policy(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    mode: String,
    endpoint_id: Option<String>,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let policy = match (mode.as_str(), endpoint_id) {
        ("automatic", _) => ConnectionPolicy::Automatic,
        ("fixed", Some(endpoint_id)) => ConnectionPolicy::Fixed { endpoint_id },
        _ => {
            return Err(ClientError::InvalidEndpoint("connection policy is invalid".into()).into());
        }
    };
    let profile =
        update_connection_policy(&store, policy, expected_revision).map_err(CommandError::from)?;
    reconcile_selected_client(&runtime, &connection_id, selection_generation, &profile)?;
    Ok(profile)
}

#[tauri::command]
fn set_host_endpoint_enabled(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    endpoint_id: String,
    enabled: bool,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let profile = set_endpoint_enabled(&store, &endpoint_id, enabled, expected_revision)
        .map_err(CommandError::from)?;
    reconcile_selected_client(&runtime, &connection_id, selection_generation, &profile)?;
    Ok(profile)
}

#[tauri::command]
fn reorder_host_endpoints(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    endpoint_ids: Vec<String>,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let profile =
        reorder_endpoints(&store, &endpoint_ids, expected_revision).map_err(CommandError::from)?;
    reconcile_selected_client(&runtime, &connection_id, selection_generation, &profile)?;
    Ok(profile)
}

#[tauri::command]
fn delete_host_endpoint(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    endpoint_id: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let profile =
        delete_endpoint(&store, &endpoint_id, expected_revision).map_err(CommandError::from)?;
    reconcile_selected_client(&runtime, &connection_id, selection_generation, &profile)?;
    Ok(profile)
}

async fn verify_workspace_scope(
    client: &DockClient,
    instance_id: &str,
    expected_host_epoch: &str,
    expected_runtime_generation: u64,
) -> Result<(), CommandError> {
    let (catalog, host_epoch) = client
        .list_instances_with_host_epoch(InstanceSelector::Actionable)
        .await
        .map_err(workspace_client_error)?;
    let current = catalog
        .instances
        .into_iter()
        .find(|instance| instance.id == instance_id)
        .ok_or_else(|| {
            workspace_command_error(
                "workspace_context_changed",
                "这个 Work 已经结束，请重新打开工作区。",
            )
        })?;
    if host_epoch != expected_host_epoch
        || current.owner_host_epoch.as_deref() != Some(expected_host_epoch)
        || current.runtime_generation != expected_runtime_generation
        || !matches!(
            current.lifecycle,
            aludock_client_core::InstanceLifecycle::Active
        )
    {
        return Err(workspace_command_error(
            "workspace_context_changed",
            "这个 Work 的状态已经变化，请重新打开工作区。",
        ));
    }
    Ok(())
}

fn workspace_entry_identity_matches(left: &WorkspaceFileEntry, right: &WorkspaceFileEntry) -> bool {
    left.path == right.path
        && left.name == right.name
        && left.kind == right.kind
        && left.hidden == right.hidden
        && left.target_kind == right.target_kind
}

fn workspace_cache_staging_path(
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

fn create_workspace_cache_file(path: &PathBuf) -> Result<std::fs::File, CommandError> {
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
async fn workspace_entries(
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
    verify_workspace_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let page = client
        .list_workspace_entries(&instance_id, &path, cursor.as_ref())
        .await
        .map_err(workspace_client_error)?;
    verify_workspace_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
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
async fn workspace_entry_metadata(
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
    verify_workspace_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let (entry, host_epoch) = client
        .get_workspace_entry(&instance_id, &path)
        .await
        .map_err(workspace_client_error)?;
    verify_workspace_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
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
async fn read_workspace_file(
    app: tauri::AppHandle,
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
    verify_workspace_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
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
    if let Err(error) = verify_workspace_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await
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
fn cancel_workspace_file_read(
    state: tauri::State<'_, WorkspaceFileState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    read_id: String,
) -> Result<bool, CommandError> {
    state.cancel(&connection_id, selection_generation, &instance_id, &read_id)
}

#[tauri::command]
fn clear_workspace_file_state(
    state: tauri::State<'_, WorkspaceFileState>,
) -> Result<(), CommandError> {
    state.clear()
}

fn cached_workspace_file(
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
async fn workspace_cached_text(
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
async fn workspace_cached_image(
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
async fn save_workspace_cached_file(
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

#[tauri::command]
async fn list_machines(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
) -> Result<Vec<Machine>, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .list_machines()
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn list_workspace(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    path: String,
    target_host_id: Option<String>,
    cursor: Option<WorkspaceCursor>,
) -> Result<WorkspacePage, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    client
        .list_workspace_for_machine(&path, cursor.as_ref(), target_host_id.as_deref())
        .await
        .map_err(CommandError::from)
}

async fn verify_session_scope(
    client: &DockClient,
    instance_id: &str,
    expected_host_epoch: &str,
    expected_runtime_generation: u64,
) -> Result<InstanceSnapshot, CommandError> {
    let read = client
        .read_instance(instance_id, None, ReadReplay::ConversationBootstrap)
        .await
        .map_err(CommandError::from)?;
    if read.page.latest.host_epoch != expected_host_epoch
        || read.instance.runtime_generation != expected_runtime_generation
    {
        return Err(CommandError::from(ClientError::Protocol(
            "the Session action belongs to a stale Work generation or Host connection".into(),
        )));
    }
    Ok(read.instance)
}

fn validate_session_mutation_scope(
    instance: &InstanceSnapshot,
    expected_host_epoch: &str,
    expected_runtime_generation: u64,
    replacement_completed: bool,
    operation_id: &str,
) -> Result<(), CommandError> {
    let expected_generation = expected_runtime_generation
        .checked_add(u64::from(replacement_completed))
        .ok_or_else(|| {
            CommandError::from(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "Session runtime generation overflowed".into(),
            })
        })?;
    if instance.owner_host_epoch.as_deref() != Some(expected_host_epoch)
        || instance.runtime_generation != expected_generation
    {
        return Err(CommandError::from(ClientError::EffectUnknown {
            operation_id: operation_id.to_owned(),
            message: "the Session mutation did not return the expected Host and runtime generation"
                .into(),
        }));
    }
    Ok(())
}

fn begin_session_token_request(state: &SessionTokenState) -> Result<u64, CommandError> {
    let mut registry = state.registry.lock().map_err(|_| {
        CommandError::from(ClientError::Protocol(
            "Session token registry is unavailable".into(),
        ))
    })?;
    registry.next_request = registry.next_request.checked_add(1).ok_or_else(|| {
        CommandError::from(ClientError::Protocol(
            "Session token request counter overflowed".into(),
        ))
    })?;
    Ok(registry.next_request)
}

#[allow(clippy::too_many_arguments)]
fn publish_session_tokens(
    state: &SessionTokenState,
    request_id: u64,
    connection_id: &str,
    selection_generation: u64,
    scope: SessionTokenScope,
    tokens: HashMap<String, String>,
) -> Result<(), CommandError> {
    let mut registry = state.registry.lock().map_err(|_| {
        CommandError::from(ClientError::Protocol(
            "Session token registry is unavailable".into(),
        ))
    })?;
    for (token, session_file) in tokens {
        registry.tokens.insert(
            token,
            SessionTokenBinding {
                request_id,
                connection_id: connection_id.to_owned(),
                selection_generation,
                scope: scope.clone(),
                session_file,
            },
        );
    }
    let oldest_retained = registry.next_request.saturating_sub(63);
    registry
        .tokens
        .retain(|_, binding| binding.request_id >= oldest_retained);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn list_sessions(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, SessionTokenState>,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    scope: String,
) -> Result<SafeSessionList, CommandError> {
    let request_id = begin_session_token_request(&state)?;
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let current = verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let scope_value = match scope.as_str() {
        "cwd" => SessionScope::Cwd,
        "all" => SessionScope::All,
        _ => {
            return Err(CommandError::from(ClientError::Protocol(
                "invalid Session scope".into(),
            )));
        }
    };
    let result = client
        .list_sessions(&instance_id, scope_value)
        .await
        .map_err(CommandError::from)?;
    if result.host_epoch != expected_host_epoch {
        return Err(CommandError::from(ClientError::Protocol(
            "stale Session list was discarded".into(),
        )));
    }
    let mut tokens = HashMap::new();
    let sessions = result
        .sessions
        .into_iter()
        .map(|session| {
            let token = uuid::Uuid::new_v4().to_string();
            tokens.insert(token.clone(), session.session_file);
            let identity = session
                .session_id
                .chars()
                .rev()
                .take(12)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            SafeSession {
                token,
                name: session.name,
                cwd: session.cwd,
                updated_at: session.updated_at,
                identity,
                current: session.session_id == current.executor.pi_session_id,
            }
        })
        .collect();
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, &connection_id, selection_generation)?;
    publish_session_tokens(
        &state,
        request_id,
        &connection_id,
        selection_generation,
        SessionTokenScope::Work {
            host_epoch: expected_host_epoch.clone(),
            instance_id: instance_id.clone(),
            runtime_generation: expected_runtime_generation,
        },
        tokens,
    )?;
    drop(lifecycle);
    Ok(SafeSessionList {
        sessions,
        total: result.total,
        truncated: result.truncated,
        connection_id,
        selection_generation,
        host_epoch: expected_host_epoch,
        runtime_generation: expected_runtime_generation,
    })
}

#[tauri::command]
async fn session_inventory(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, SessionTokenState>,
    machine_host_id: String,
    cwd: String,
) -> Result<SafeSessionInventory, CommandError> {
    let request_id = begin_session_token_request(&state)?;
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let result = client
        .session_inventory(&cwd, SessionScope::All, Some(&machine_host_id))
        .await
        .map_err(CommandError::from)?;
    let mut tokens = HashMap::new();
    let sessions = result
        .sessions
        .into_iter()
        .map(|session| {
            let token = uuid::Uuid::new_v4().to_string();
            tokens.insert(token.clone(), session.session_file);
            SafeInventorySession {
                token,
                name: session.name,
                first_user_message: session.first_user_message,
                cwd: session.cwd,
                updated_at: session.updated_at,
            }
        })
        .collect();
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, &connection_id, selection_generation)?;
    publish_session_tokens(
        &state,
        request_id,
        &connection_id,
        selection_generation,
        SessionTokenScope::Machine {
            machine_host_id: machine_host_id.clone(),
            host_epoch: result.host_epoch.clone(),
        },
        tokens,
    )?;
    drop(lifecycle);
    Ok(SafeSessionInventory {
        sessions,
        total: result.total,
        truncated: result.truncated,
        incomplete: result.incomplete,
        machine_host_id,
        connection_id,
        host_epoch: result.host_epoch,
        selection_generation,
    })
}

fn resolve_work_session_token(
    state: &SessionTokenState,
    connection_id: &str,
    selection_generation: u64,
    instance_id: &str,
    host_epoch: &str,
    runtime_generation: u64,
    token: &str,
) -> Result<String, CommandError> {
    let registry = state.registry.lock().map_err(|_| {
        CommandError::from(ClientError::Protocol(
            "Session token registry is unavailable".into(),
        ))
    })?;
    let binding = registry.tokens.get(token).ok_or_else(|| {
        CommandError::from(ClientError::Protocol(
            "Session token is invalid or expired".into(),
        ))
    })?;
    let scope_matches = matches!(
        &binding.scope,
        SessionTokenScope::Work {
            host_epoch: bound_epoch,
            instance_id: bound_instance,
            runtime_generation: bound_generation,
        } if bound_epoch == host_epoch
            && bound_instance == instance_id
            && *bound_generation == runtime_generation
    );
    if binding.connection_id != connection_id
        || binding.selection_generation != selection_generation
        || !scope_matches
    {
        return Err(CommandError::from(ClientError::Protocol(
            "Session token belongs to a stale list result".into(),
        )));
    }
    Ok(binding.session_file.clone())
}

fn resolve_machine_session_token(
    state: &SessionTokenState,
    connection_id: &str,
    selection_generation: u64,
    machine_host_id: &str,
    token: &str,
) -> Result<(String, String), CommandError> {
    let registry = state.registry.lock().map_err(|_| {
        CommandError::from(ClientError::Protocol(
            "Session token registry is unavailable".into(),
        ))
    })?;
    let binding = registry.tokens.get(token).ok_or_else(|| {
        CommandError::from(ClientError::Protocol(
            "Session token is invalid or expired".into(),
        ))
    })?;
    let bound_host_epoch = match &binding.scope {
        SessionTokenScope::Machine {
            machine_host_id: bound_machine,
            host_epoch,
        } if bound_machine == machine_host_id => Some(host_epoch),
        _ => None,
    };
    if binding.connection_id != connection_id
        || binding.selection_generation != selection_generation
        || bound_host_epoch.is_none()
    {
        return Err(CommandError::from(ClientError::Protocol(
            "Session token belongs to another Host or Machine".into(),
        )));
    }
    Ok((
        binding.session_file.clone(),
        bound_host_epoch.expect("scope was checked").clone(),
    ))
}

#[tauri::command]
async fn new_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
) -> Result<SessionReplacementResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let result = client
        .new_session(&instance_id, None, Some(&operation_id))
        .await
        .map_err(CommandError::from)?;
    validate_session_mutation_scope(
        &result.instance,
        &expected_host_epoch,
        expected_runtime_generation,
        !result.cancelled,
        &operation_id,
    )?;
    Ok(result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn switch_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, SessionTokenState>,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    session_token: String,
    operation_id: String,
    trust_challenge_id: Option<String>,
    project_trust_decision: Option<String>,
) -> Result<SessionReplacementResult, CommandError> {
    let session_file = resolve_work_session_token(
        &state,
        &connection_id,
        selection_generation,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        &session_token,
    )?;
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let continuation = parse_trust_continuation(
        trust_challenge_id.as_deref(),
        project_trust_decision.as_deref(),
        Some(operation_id.clone()),
    )?;
    let result = client
        .switch_session(&instance_id, &session_file, continuation, &operation_id)
        .await
        .map_err(CommandError::from)?;
    validate_session_mutation_scope(
        &result.instance,
        &expected_host_epoch,
        expected_runtime_generation,
        !result.cancelled,
        &operation_id,
    )?;
    Ok(result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn name_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    name: String,
) -> Result<SessionNameResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let result = client
        .name_session(&instance_id, &name, Some(&operation_id))
        .await
        .map_err(CommandError::from)?;
    validate_session_mutation_scope(
        &result.instance,
        &expected_host_epoch,
        expected_runtime_generation,
        false,
        &operation_id,
    )?;
    Ok(result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn compact_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    custom_instructions: Option<String>,
) -> Result<SessionCompactionResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let result = client
        .compact_session(
            &instance_id,
            custom_instructions.as_deref(),
            Some(&operation_id),
        )
        .await
        .map_err(CommandError::from)?;
    validate_session_mutation_scope(
        &result.instance,
        &expected_host_epoch,
        expected_runtime_generation,
        false,
        &operation_id,
    )?;
    Ok(result)
}

#[tauri::command]
async fn reload_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
) -> Result<SafeSessionReload, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let result = client
        .reload_session(&instance_id, Some(&operation_id))
        .await
        .map_err(CommandError::from)?;
    validate_session_mutation_scope(
        &result.instance,
        &expected_host_epoch,
        expected_runtime_generation,
        true,
        &operation_id,
    )?;
    Ok(project_session_reload(result))
}

fn project_session_reload(result: SessionReloadResult) -> SafeSessionReload {
    SafeSessionReload {
        instance: result.instance,
        resources: result
            .resources
            .into_iter()
            .map(|resource| SafeResource {
                kind: format!("{:?}", resource.kind).to_lowercase(),
                name: resource.name,
                source: resource.source.map(project_source),
            })
            .collect(),
        diagnostics: result
            .diagnostics
            .into_iter()
            .map(|diagnostic| SafeDiagnostic {
                severity: format!("{:?}", diagnostic.severity).to_lowercase(),
                message: diagnostic.message,
            })
            .collect(),
        resource_total: result.resource_total,
        resources_truncated: result.resources_truncated,
        diagnostic_total: result.diagnostic_total,
        diagnostics_truncated: result.diagnostics_truncated,
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn session_tree(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
) -> Result<SessionTree, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let (tree, host_epoch) = client
        .session_tree(&instance_id)
        .await
        .map_err(CommandError::from)?;
    if host_epoch != expected_host_epoch {
        return Err(CommandError::from(ClientError::Protocol(
            "stale Session Tree was discarded".into(),
        )));
    }
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    Ok(tree)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn navigate_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    target_id: String,
    summarize: bool,
    custom_instructions: Option<String>,
) -> Result<SessionNavigateResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let result = client
        .navigate_session(
            &instance_id,
            &target_id,
            NavigateOptions {
                summarize,
                custom_instructions: custom_instructions.as_deref(),
                replace_instructions: false,
                label: None,
            },
            Some(&operation_id),
        )
        .await
        .map_err(CommandError::from)?;
    validate_session_mutation_scope(
        &result.instance,
        &expected_host_epoch,
        expected_runtime_generation,
        false,
        &operation_id,
    )?;
    Ok(result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn fork_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    entry_id: String,
) -> Result<SessionForkResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let result = client
        .fork_session(&instance_id, &entry_id, Some(&operation_id))
        .await
        .map_err(CommandError::from)?;
    validate_session_mutation_scope(
        &result.instance,
        &expected_host_epoch,
        expected_runtime_generation,
        !result.cancelled,
        &operation_id,
    )?;
    Ok(result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn clone_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    entry_id: String,
) -> Result<SessionReplacementResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    verify_session_scope(
        &client,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    )
    .await?;
    let result = client
        .clone_session(&instance_id, &entry_id, Some(&operation_id))
        .await
        .map_err(CommandError::from)?;
    validate_session_mutation_scope(
        &result.instance,
        &expected_host_epoch,
        expected_runtime_generation,
        !result.cancelled,
        &operation_id,
    )?;
    Ok(result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn adopt_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, SessionTokenState>,
    machine_host_id: String,
    session_token: String,
    name: Option<String>,
    operation_id: Option<String>,
    trust_challenge_id: Option<String>,
    project_trust_decision: Option<String>,
) -> Result<InstanceSnapshot, CommandError> {
    let (session_file, inventory_host_epoch) = resolve_machine_session_token(
        &state,
        &connection_id,
        selection_generation,
        &machine_host_id,
        &session_token,
    )?;
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let continuation = parse_trust_continuation(
        trust_challenge_id.as_deref(),
        project_trust_decision.as_deref(),
        operation_id.clone(),
    )?;
    client
        .adopt_instance_for_machine(
            &session_file,
            name.as_deref(),
            continuation,
            operation_id.as_deref(),
            Some(&machine_host_id),
            &inventory_host_epoch,
        )
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn create_work(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    cwd: String,
    name: Option<String>,
    target_host_id: Option<String>,
    operation_id: Option<String>,
    trust_challenge_id: Option<String>,
    project_trust_decision: Option<String>,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let continuation = parse_trust_continuation(
        trust_challenge_id.as_deref(),
        project_trust_decision.as_deref(),
        operation_id.clone(),
    )?;
    client
        .create_instance_for_machine(
            &cwd,
            name.as_deref(),
            continuation,
            operation_id.as_deref(),
            target_host_id.as_deref(),
        )
        .await
        .map_err(CommandError::from)
}

fn parse_trust_continuation<'a>(
    trust_challenge_id: Option<&'a str>,
    project_trust_decision: Option<&str>,
    operation_id: Option<String>,
) -> Result<Option<(&'a str, ProjectTrustDecision)>, CommandError> {
    match (trust_challenge_id, project_trust_decision) {
        (None, None) => Ok(None),
        (Some(challenge), Some(decision)) => Ok(Some((challenge, parse_trust_decision(decision)?))),
        _ => Err(CommandError {
            code: "invalid_trust_continuation".into(),
            message: "信任确认缺少必要信息".into(),
            details: None,
            outcome_unknown: false,
            operation_id,
        }),
    }
}

fn parse_trust_decision(value: &str) -> Result<ProjectTrustDecision, CommandError> {
    match value {
        "trust_once" => Ok(ProjectTrustDecision::TrustOnce),
        "trust_and_remember" => Ok(ProjectTrustDecision::TrustAndRemember),
        "deny_once" => Ok(ProjectTrustDecision::DenyOnce),
        "deny_and_remember" => Ok(ProjectTrustDecision::DenyAndRemember),
        _ => Err(CommandError {
            code: "invalid_trust_decision".into(),
            message: "未知的项目信任选择".into(),
            details: None,
            outcome_unknown: false,
            operation_id: None,
        }),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(AwayMonitorState::default());
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if args.iter().any(|argument| argument == "--background") {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_documents::init());
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "windows")]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--background"])
                .build(),
        )
        .on_window_event(|window, event| {
            desktop_shell::handle_window_event(window, event);
            if window.label() == "main"
                && let tauri::WindowEvent::Focused(focused) = event
            {
                let monitor = window.state::<AwayMonitorState>();
                if *focused {
                    let _ = monitor.stop(None);
                    let _ = window.request_user_attention(None);
                }
            }
        });

    builder
        .setup(|app| {
            #[cfg(mobile)]
            let application_data_dir = Some(app.path().app_local_data_dir()?);
            #[cfg(not(mobile))]
            let application_data_dir = None;
            let desktop_shell = desktop_shell::DesktopShellState::initialize(app);
            let prefer_local = desktop_shell.prefer_local_connection();
            app.manage(desktop_shell);
            app.manage(ConnectionRuntimeState::open(
                application_data_dir,
                prefer_local,
            )?);
            app.manage(WorkspaceFileState::open(
                app.path().app_cache_dir()?.join("workspace-preview"),
            )?);
            desktop_shell::finish_setup(app)?;
            Ok(())
        })
        .manage(FollowState::default())
        .manage(ExtensionControlState::default())
        .manage(PairingTaskState::default())
        .manage(SessionTokenState::default())
        .manage(AttachmentState::default())
        .manage(RestoredImageState::default())
        .manage(CommandReferenceState::default())
        .invoke_handler(tauri::generate_handler![
            system_device_name,
            desktop_shell::desktop_shell_status,
            desktop_shell::start_desktop_host,
            desktop_shell::open_desktop_host_log,
            desktop_shell::open_desktop_tui,
            get_client_preferences,
            update_client_preferences,
            begin_windows_away,
            cancel_windows_away,
            get_host_catalog,
            connect_local_dock,
            set_local_endpoint,
            set_active_host,
            remove_saved_host,
            start_pairing,
            resume_pairing,
            cancel_pairing,
            discard_pairing,
            reselect_host_route,
            bootstrap,
            work_catalog,
            conversation_bootstrap,
            conversation_history,
            conversation_history_entry,
            conversation_image,
            published_image,
            save_preview_image,
            list_deliverables,
            download_deliverable,
            open_saved_deliverable,
            start_conversation_follow,
            stop_conversation_follow,
            acquire_extension_control,
            release_extension_control,
            respond_extension_interaction,
            set_extension_widget_viewport,
            set_extension_tools_expanded,
            pick_attachments,
            stage_clipboard_image,
            attachment_preview,
            upload_attachment,
            cancel_attachment_upload,
            remove_attachment,
            submit_message,
            dequeue_messages,
            clear_restored_images,
            abort_run,
            stop_work,
            command_catalog,
            command_content,
            command_completions,
            run_catalog_command,
            list_models,
            set_model,
            set_thinking,
            list_tools,
            set_active_tools,
            get_settings,
            update_setting,
            get_resources,
            reopen_work,
            forget_work,
            verify_host_endpoint,
            save_unverified_host_endpoint,
            test_host_endpoint,
            rename_host_profile,
            set_connection_policy,
            set_host_endpoint_enabled,
            reorder_host_endpoints,
            delete_host_endpoint,
            workspace_entries,
            workspace_entry_metadata,
            read_workspace_file,
            cancel_workspace_file_read,
            clear_workspace_file_state,
            workspace_cached_text,
            workspace_cached_image,
            save_workspace_cached_file,
            list_machines,
            list_workspace,
            list_sessions,
            session_inventory,
            adopt_session,
            new_session,
            switch_session,
            name_session,
            compact_session,
            reload_session,
            session_tree,
            navigate_session,
            fork_session,
            clone_session,
            create_work
        ])
        .run(tauri::generate_context!())
        .expect("error while running AluDock Client");
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn command_errors_keep_safe_decoding_reason_for_diagnostics() {
        let parsing_error = serde_json::from_str::<Value>("{").unwrap_err();
        let command_error = CommandError::from(ClientError::Json(parsing_error));
        let serialized = serde_json::to_value(&command_error).unwrap();
        let reason = serialized["details"]["reason"].as_str().unwrap();

        assert_eq!(serialized["code"], "client_error");
        assert!(reason.contains("EOF"));
        assert!(!command_error.message.contains(reason));

        let protocol_error = CommandError::from(ClientError::Protocol("missing version".into()));
        assert_eq!(
            protocol_error.details,
            Some(serde_json::json!({ "reason": "missing version" }))
        );
    }

    #[test]
    fn command_projection_keeps_owner_path_behind_an_opaque_reference() {
        let state = CommandReferenceState::default();
        let scope = CommandReferenceScope {
            connection_id: "host-1".into(),
            selection_generation: 7,
            instance_id: "work-1".into(),
        };
        let reference_generation = state.begin(&scope);
        let projected = project_commands(
            CommandsResult {
                commands: vec![CommandInfo {
                    name: "idea".into(),
                    description: Some("Generate ideas".into()),
                    source: SourceInfo {
                        kind: aludock_client_core::SourceKind::Prompt,
                        path: Some("/worker/private/prompts/idea.md".into()),
                        package: None,
                    },
                    argument_hint: Some("[topic]".into()),
                    argument_completions: false,
                    content_available: Some(true),
                }],
                total: 1,
                truncated: false,
            },
            &state,
            scope.clone(),
            reference_generation,
        )
        .expect("project current command catalog");

        let json = serde_json::to_string(&projected).expect("serialize projected commands");
        assert!(!json.contains("/worker/private"));
        assert!(json.contains("referenceId"));
        let reference_id = &projected.commands[0].reference_id;
        let resolved = state
            .resolve(&scope, reference_id)
            .expect("resolve opaque reference");
        assert_eq!(resolved.name, "idea");
        assert_eq!(
            resolved.source.path.as_deref(),
            Some("/worker/private/prompts/idea.md")
        );

        let stale_generation = state.begin(&scope);
        let _current_generation = state.begin(&scope);
        let stale = project_commands(
            CommandsResult {
                commands: Vec::new(),
                total: 0,
                truncated: false,
            },
            &state,
            scope,
            stale_generation,
        );
        assert!(
            stale.is_err(),
            "a superseded catalog must not return unresolved references"
        );
    }

    #[test]
    fn only_a_complete_staged_download_replaces_the_saved_file() {
        let root = std::env::temp_dir().join(format!(
            "aludock-deliverable-commit-{}",
            uuid::Uuid::new_v4()
        ));
        let cache = root.join("cache");
        let downloads = root.join("downloads");
        fs::create_dir_all(&cache).unwrap();
        fs::create_dir_all(&downloads).unwrap();
        let destination = downloads.join("result.bin");
        fs::write(&destination, b"existing").unwrap();

        assert!(commit_staged_to_path(&cache.join("missing.part"), &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing");

        let completed = cache.join("complete.part");
        fs::write(&completed, b"verified").unwrap();
        commit_staged_to_path(&completed, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"verified");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_cache_is_bound_to_the_current_work_context_and_replaced_on_new_read() {
        let root =
            std::env::temp_dir().join(format!("aludock-workspace-cache-{}", uuid::Uuid::new_v4()));
        let state = WorkspaceFileState::open(root.clone()).unwrap();
        let cache_path = root.join("verified.cache");
        fs::write(&cache_path, b"source").unwrap();
        let entry = WorkspaceFileEntry {
            path: "src/main.rs".into(),
            name: "main.rs".into(),
            kind: aludock_client_core::WorkspaceFileKind::File,
            hidden: false,
            target_kind: None,
            size_bytes: Some(6),
        };
        let read_id = uuid::Uuid::new_v4().to_string();
        state
            .begin(read_id.clone(), "host".into(), 4, "work".into())
            .unwrap();
        assert!(
            state
                .finish(
                    &read_id,
                    CachedWorkspaceFile {
                        cache_id: read_id.clone(),
                        connection_id: "host".into(),
                        selection_generation: 4,
                        instance_id: "work".into(),
                        runtime_generation: 9,
                        path: entry.path.clone(),
                        file_path: cache_path.clone(),
                        result: WorkspaceFileReadResult {
                            entry,
                            chunks: 1,
                            size_bytes: 6,
                            sha256:
                                "41cf6794ba4200b839c472f85a30fa47fef75a7640bdda405950b887ad1e2d58"
                                    .into(),
                            host_epoch: "epoch".into(),
                        },
                    },
                )
                .unwrap()
        );
        assert!(
            state
                .cached("host", 4, "work", "epoch", 9, &read_id)
                .is_ok()
        );
        assert!(
            state
                .cached("host", 4, "work", "new-epoch", 9, &read_id)
                .is_err()
        );

        state
            .begin(
                uuid::Uuid::new_v4().to_string(),
                "host".into(),
                4,
                "work".into(),
            )
            .unwrap();
        assert!(!cache_path.exists());
        assert!(
            state
                .cached("host", 4, "work", "epoch", 9, &read_id)
                .is_err()
        );
        state.clear().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn work_finishing_before_the_first_away_read_notifies_at_the_chosen_time() {
        let mut tracker = AwayCompletionTracker::from_running_instance_ids(&["work-a".into()]);
        tracker.observe(&[AwayInstanceState {
            instance_id: "work-a".into(),
            display_name: "Windows 客户端".into(),
            execution: InstanceExecution::Idle,
        }]);

        let grace = WindowsAwayDelay::FiveMinutes.duration().unwrap();
        assert!(
            tracker
                .take_ready(Duration::from_secs(299), grace)
                .is_empty()
        );
        assert_eq!(
            tracker.take_ready(Duration::from_secs(300), grace),
            vec![AwayCompletion {
                instance_id: "work-a".into(),
                display_name: "Windows 客户端".into(),
            }]
        );
    }

    #[test]
    fn remote_media_must_be_a_matching_safe_raster_image() {
        assert!(validate_renderable_image(b"\x89PNG\r\n\x1a\nbody", Some("image/png")).is_ok());
        assert!(
            validate_renderable_image(
                b"<svg xmlns='http://www.w3.org/2000/svg'/>",
                Some("image/svg+xml")
            )
            .is_err()
        );
        assert!(validate_renderable_image(b"GIF89abody", Some("image/png")).is_err());
    }

    #[test]
    fn render_image_ipc_reassembles_images_larger_than_the_reported_failure() {
        let bytes = vec![42_u8; 6 * 1_024 * 1_024 + 17];
        let mut received = Vec::new();
        let mut chunks = 0;
        let size = send_render_image_chunks(&bytes, |chunk| {
            assert!(chunk.len() <= RENDER_IMAGE_IPC_CHUNK_BYTES);
            received.extend_from_slice(chunk);
            chunks += 1;
            Ok::<_, ()>(())
        })
        .unwrap();
        assert!(chunks > 1);
        assert_eq!(size, bytes.len());
        assert_eq!(received, bytes);
    }

    #[test]
    fn saving_a_preview_uses_its_visible_name_and_actual_image_format() {
        let decoded = decode_image_name("%E7%BB%93%E6%9E%9C%20%E5%9B%BE.png").unwrap();
        assert_eq!(
            preview_image_save_name(&decoded, "image/png"),
            "结果 图.png"
        );
        assert_eq!(
            preview_image_save_name("result.png", "image/jpeg"),
            "result.jpg"
        );
        assert_eq!(
            preview_image_save_name("aludock-image", "image/webp"),
            "aludock-image.webp"
        );
    }

    fn endpoint_runtime(name: &str) -> (PathBuf, ConnectionRuntimeState, String) {
        let path = std::env::temp_dir().join(format!(
            "aludock-tauri-endpoint-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        let legacy_store = IdentityStore::new(&path);
        let identity = legacy_store.load_or_create_identity().unwrap();
        let host = aludock_client_core::ClientIdentity::generate().unwrap();
        let endpoint: Endpoint = "192.168.1.8:33781".parse().unwrap();
        let client_id = legacy_store.client_id().unwrap();
        legacy_store
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "Test device",
                &client_id,
            )
            .unwrap();
        let host_id = aludock_client_core::host_id(host.certificate_der());
        let registry = HostRegistry::open(&path).unwrap();
        let preferences =
            ClientPreferencesStore::open(registry.root().join("client-preferences")).unwrap();
        let runtime = ConnectionRuntimeState {
            registry,
            preferences,
            local_identity: IdentityStore::new(path.join("local-client-identity")),
            lifecycle: Arc::new(Mutex::new(RuntimeLifecycle {
                active_target: Some(ConnectionTarget::Host {
                    host_id: host_id.clone(),
                }),
                selection_generation: 1,
            })),
            selected_client: Arc::new(Mutex::new(None)),
        };
        (path, runtime, host_id)
    }

    #[test]
    fn selected_host_commands_share_one_router_instance() {
        let (path, runtime, host_id) = endpoint_runtime("shared-router");
        let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
        let first = dock_client(&runtime, &host_id, 1, &store).unwrap();
        let second = dock_client(&runtime, &host_id, 1, &store).unwrap();

        first.router().close();

        assert!(second.router().snapshot().closed);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn first_packaged_main_launch_selects_the_local_dock_without_pairing() {
        let root = std::env::temp_dir().join(format!(
            "aludock-desktop-first-main-{}",
            uuid::Uuid::new_v4()
        ));
        let runtime = ConnectionRuntimeState::open(Some(root.clone()), true).unwrap();
        let snapshot = runtime.registry.snapshot().unwrap();

        assert!(snapshot.local_selected);
        assert!(snapshot.active_host_id.is_none());
        assert_eq!(
            runtime.lifecycle.lock().unwrap().active_target,
            Some(ConnectionTarget::Local)
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn choosing_local_or_a_host_keeps_exactly_one_current_connection() {
        let host_b = "b".repeat(64);
        let mut lifecycle = RuntimeLifecycle {
            active_target: Some(ConnectionTarget::Host {
                host_id: "a".repeat(64),
            }),
            selection_generation: 4,
        };
        assert_eq!(lifecycle.transition_to_local().unwrap(), 5);
        assert_eq!(lifecycle.connection_id(), Some(LOCAL_CONNECTION_SCOPE_ID));
        assert_eq!(
            lifecycle.transition_to_host(Some(host_b.clone())).unwrap(),
            6
        );
        assert_eq!(lifecycle.connection_id(), Some(host_b.as_str()));
        assert_eq!(
            lifecycle.active_target,
            Some(ConnectionTarget::Host { host_id: host_b })
        );
    }

    #[test]
    fn stale_selection_is_rejected_before_long_lived_registration() {
        let mut lifecycle = RuntimeLifecycle {
            active_target: Some(ConnectionTarget::Host {
                host_id: "a".repeat(64),
            }),
            selection_generation: 9,
        };
        assert!(ensure_connection_selection(&lifecycle, &"a".repeat(64), 9).is_ok());
        lifecycle.transition_to_host(Some("b".repeat(64))).unwrap();
        assert!(ensure_connection_selection(&lifecycle, &"a".repeat(64), 9).is_err());
        assert!(ensure_connection_selection(&lifecycle, &"b".repeat(64), 9).is_err());
    }

    #[test]
    fn restored_images_are_retained_until_matching_submit_success_or_explicit_clear() {
        let state = RestoredImageState::default();
        let scope = restored_image_scope("host", 3, "work");
        let first = ImagePath {
            path: "/native/first.png".into(),
            mime_type: "image/png".into(),
        };
        assert_eq!(state.append(scope.clone(), vec![first]), 1);
        let captured = state.capture(&scope).expect("captured restored image");

        // A failed submit performs no clear, so the same batch remains available.
        assert_eq!(state.capture(&scope).unwrap().tokens, captured.tokens);

        // A later dequeue appends instead of discarding the earlier restored draft.
        // Success for the older submit clears only what that submit captured.
        let second = ImagePath {
            path: "/native/second.jpg".into(),
            mime_type: "image/jpeg".into(),
        };
        assert_eq!(state.append(scope.clone(), vec![second]), 2);
        state.clear_after_success(&scope, &captured.tokens);
        let replacement = state.capture(&scope).expect("newer batch retained");
        assert_eq!(replacement.images.len(), 1);
        assert_eq!(replacement.images[0].path, "/native/second.jpg");

        state.clear_after_success(&scope, &replacement.tokens);
        assert!(state.capture(&scope).is_none());
        state.append(
            scope.clone(),
            vec![ImagePath {
                path: "/native/third.webp".into(),
                mime_type: "image/webp".into(),
            }],
        );
        assert_eq!(state.append(scope.clone(), Vec::new()), 1);
        assert_eq!(state.clear_scope(&scope), 1);
        assert!(state.capture(&scope).is_none());
    }

    #[test]
    fn same_host_generation_rebind_preserves_only_that_hosts_restored_images() {
        let state = RestoredImageState::default();
        let old_scope = restored_image_scope("host-a", 3, "work");
        let new_scope = restored_image_scope("host-a", 4, "work");
        let other_scope = restored_image_scope("host-b", 3, "work");
        state.append(
            old_scope.clone(),
            vec![ImagePath {
                path: "/native/restored.png".into(),
                mime_type: "image/png".into(),
            }],
        );
        state.append(
            other_scope.clone(),
            vec![ImagePath {
                path: "/native/other.png".into(),
                mime_type: "image/png".into(),
            }],
        );

        state.rebind_generation("host-a", 3, 4);

        assert!(state.capture(&old_scope).is_none());
        assert_eq!(state.capture(&new_scope).unwrap().images.len(), 1);
        assert!(state.capture(&other_scope).is_none());
    }

    #[test]
    fn safe_dequeue_receipt_serializes_no_operation_id_or_image_path() {
        let receipt = SafeQueueDequeueReceipt {
            instance_id: "work".into(),
            restored: vec![ProjectedQueueItem {
                queue_item_id: "queue-item".into(),
                delivery: "followUp".into(),
                text: "restored".into(),
                attachments: Vec::new(),
                image_count: 1,
                accepted_at: "now".into(),
            }],
            in_flight: Vec::new(),
        };
        let value = serde_json::to_value(receipt).unwrap();
        assert!(value.get("operationId").is_none());
        assert_eq!(value["restored"][0]["imageCount"], 1);
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(!encoded.contains("/native/"));
        assert!(!encoded.contains("operationId"));
    }

    #[test]
    fn stale_picker_completion_cannot_publish_native_paths() {
        let host_id = "a".repeat(64);
        let lifecycle = Mutex::new(RuntimeLifecycle {
            active_target: Some(ConnectionTarget::Host {
                host_id: host_id.clone(),
            }),
            selection_generation: 7,
        });
        lifecycle
            .lock()
            .unwrap()
            .transition_to_host(Some("b".repeat(64)))
            .unwrap();
        let state = AttachmentState::default();
        let prepared = vec![(
            "token".into(),
            SelectedAttachment {
                token: "token".into(),
                name: "stale.png".into(),
                size_bytes: 1,
                media_type: Some("image/png".into()),
            },
            NativeAttachment {
                path: PathBuf::from("/native/stale.png"),
                temporary: false,
                connection_id: host_id.clone(),
                selection_generation: 7,
                work_id: "work".into(),
                operation_id: "native-operation".into(),
                name: "stale.png".into(),
                size_bytes: 1,
                media_type: Some("image/png".into()),
                upload_scope: None,
                active_attempt: None,
            },
        )];

        let error = publish_selected_attachments(&lifecycle, &state, &host_id, 7, "work", prepared)
            .unwrap_err();
        assert_eq!(error.code, "stale_connection_selection");
        assert!(state.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn verified_endpoint_probe_cannot_persist_after_selection_generation_changes() {
        let (path, runtime, host_id) = endpoint_runtime("verify-selection-race");
        let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
        let before = store.load_connection_profile().unwrap().unwrap();
        runtime
            .lifecycle
            .lock()
            .unwrap()
            .transition_to_local()
            .unwrap();

        let result = persist_verified_host_endpoint(
            &runtime,
            &host_id,
            1,
            VerifiedEndpointMutation {
                endpoint: "dock.example:443".parse().unwrap(),
                label: "WAN".into(),
                kind: ConnectionKind::Remote,
                expected_revision: before.revision,
            },
        );
        assert!(result.is_err());
        assert_eq!(store.load_connection_profile().unwrap().unwrap(), before);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn saved_endpoint_test_cannot_record_after_selection_generation_changes() {
        let (path, runtime, host_id) = endpoint_runtime("test-selection-race");
        let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
        let before = store.load_connection_profile().unwrap().unwrap();
        let endpoint_id = before.endpoints[0].id.clone();
        runtime
            .lifecycle
            .lock()
            .unwrap()
            .transition_to_local()
            .unwrap();

        let result = persist_host_endpoint_test(
            &runtime,
            &host_id,
            1,
            &endpoint_id,
            before.revision,
            Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(store.load_connection_profile().unwrap().unwrap(), before);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn saved_endpoint_test_revalidates_profile_revision_before_cas() {
        let (path, runtime, host_id) = endpoint_runtime("test-revision-race");
        let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
        let before = store.load_connection_profile().unwrap().unwrap();
        let endpoint_id = before.endpoints[0].id.clone();
        let concurrent = store
            .update_connection_profile_at(before.revision, |profile| {
                profile.display_name = "Concurrent rename".into();
                Ok(())
            })
            .unwrap();

        let result = persist_host_endpoint_test(
            &runtime,
            &host_id,
            1,
            &endpoint_id,
            before.revision,
            Ok(()),
        );
        assert!(matches!(
            result,
            Err(CommandError { ref code, .. }) if code == "profile_conflict"
        ));
        assert_eq!(
            store.load_connection_profile().unwrap().unwrap(),
            concurrent
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn verified_endpoint_probe_revalidates_profile_revision_before_cas() {
        let (path, runtime, host_id) = endpoint_runtime("verify-revision-race");
        let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
        let before = store.load_connection_profile().unwrap().unwrap();
        let concurrent = store
            .update_connection_profile_at(before.revision, |profile| {
                profile.display_name = "Concurrent rename".into();
                Ok(())
            })
            .unwrap();

        let result = persist_verified_host_endpoint(
            &runtime,
            &host_id,
            1,
            VerifiedEndpointMutation {
                endpoint: "dock.example:443".parse().unwrap(),
                label: "WAN".into(),
                kind: ConnectionKind::Remote,
                expected_revision: before.revision,
            },
        );
        assert!(matches!(
            result,
            Err(CommandError { ref code, .. }) if code == "profile_conflict"
        ));
        assert_eq!(
            store.load_connection_profile().unwrap().unwrap(),
            concurrent
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn stale_background_detach_keeps_the_new_foreground_follow() {
        let state = FollowState::default();
        *state.task.lock().unwrap() = Some(FollowTask {
            handle: tauri::async_runtime::spawn(std::future::pending()),
            connection_id: "host-a".into(),
            selection_generation: 3,
            instance_id: "work-a".into(),
            subscription_id: "foreground-new".into(),
        });

        assert!(
            !state
                .abort_matching("host-a", 3, "work-a", Some("background-old"))
                .unwrap()
        );
        assert!(state.task.lock().unwrap().is_some());
        assert!(
            state
                .abort_matching("host-a", 3, "work-a", Some("foreground-new"))
                .unwrap()
        );
        assert!(state.task.lock().unwrap().is_none());
    }

    #[test]
    fn extension_handle_scope_rejects_other_host_or_selection_generation() {
        assert!(extension_scope_matches("host-a", 3, "host-a", 3));
        assert!(!extension_scope_matches("host-a", 3, "host-b", 3));
        assert!(!extension_scope_matches("host-a", 3, "host-a", 4));
    }

    #[test]
    fn pasted_image_becomes_a_path_free_attachment_and_removes_its_temporary_file() {
        let prepared = prepare_clipboard_image(
            b"\x89PNG\r\n\x1a\npasted".to_vec(),
            "host-a".into(),
            7,
            "work-a".into(),
            1,
        )
        .unwrap();
        let path = prepared.2.path.clone();
        assert!(path.is_file());
        assert_eq!(prepared.1.name, "粘贴的图片.png");
        assert_eq!(prepared.1.media_type.as_deref(), Some("image/png"));
        let json = serde_json::to_string(&prepared.1).unwrap();
        assert!(!json.contains(&path.to_string_lossy().to_string()));
        drop(prepared);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn desktop_attachment_names_keep_legal_backslashes() {
        assert!(valid_attachment_name(r"report\final.txt"));
    }

    #[test]
    fn attachment_tokens_are_context_scoped_and_serialization_is_path_free() {
        let entry = NativeAttachment {
            path: PathBuf::from("/home/private/secret.txt"),
            temporary: false,
            connection_id: "host-a".into(),
            selection_generation: 7,
            work_id: "work-a".into(),
            operation_id: "native-operation".into(),
            name: "secret.txt".into(),
            size_bytes: 12,
            media_type: Some("text/plain".into()),
            upload_scope: None,
            active_attempt: None,
        };
        assert!(attachment_scope_matches(&entry, "host-a", 7, "work-a"));
        assert!(!attachment_scope_matches(&entry, "host-b", 7, "work-a"));
        assert!(!attachment_scope_matches(&entry, "host-a", 8, "work-a"));
        assert!(!attachment_scope_matches(&entry, "host-a", 7, "work-b"));

        let target = AttachmentUploadScope {
            machine_host_id: "machine-a".into(),
            owner_host_epoch: "epoch-a".into(),
            runtime_generation: 9,
        };
        assert!(attachment_target_matches(
            "epoch-a",
            Some("epoch-a"),
            9,
            Some("machine-a"),
            &aludock_client_core::InstanceLifecycle::Active,
            &target,
        ));
        assert!(!attachment_target_matches(
            "epoch-a",
            Some("epoch-a"),
            10,
            Some("machine-a"),
            &aludock_client_core::InstanceLifecycle::Active,
            &target,
        ));
        assert!(!attachment_target_matches(
            "epoch-a",
            Some("epoch-a"),
            9,
            Some("machine-b"),
            &aludock_client_core::InstanceLifecycle::Active,
            &target,
        ));

        let selected = SelectedAttachment {
            token: "b9d7a4a6-8968-4cbd-a285-ff487d28bc3b".into(),
            name: entry.name.clone(),
            size_bytes: entry.size_bytes,
            media_type: entry.media_type.clone(),
        };
        let json = serde_json::to_string(&selected).unwrap();
        assert!(!json.contains("/home/private"));
        assert!(!json.contains("native-operation"));
        assert!(!json.contains("host-a"));
        assert_eq!(
            serde_json::from_str::<Value>(&json).unwrap()["name"],
            "secret.txt"
        );
    }

    #[test]
    fn queue_item_projection_keeps_attachments_and_removes_image_paths() {
        let projected = project_pending_message(PendingMessage {
            queue_item_id: "queue-1".into(),
            operation_id: "operation-1".into(),
            delivery: "followUp".into(),
            text: "queued".into(),
            images: vec![aludock_client_core::ImagePath {
                path: "/home/private/image.png".into(),
                mime_type: "image/png".into(),
            }],
            attachments: vec![AttachmentDto {
                file_id: "9b0cb41e-6398-4b54-b5d0-f673de0f86fc".into(),
                name: "report.txt".into(),
                size_bytes: 10,
                media_type: Some("text/plain".into()),
                sha256: "a".repeat(64),
                stored_at: "2026-01-01T00:00:00.000Z".into(),
            }],
            accepted_at: "2026-01-01T00:00:00.000Z".into(),
        });
        let json = serde_json::to_value(projected).unwrap();
        assert_eq!(json["imageCount"], 1);
        assert_eq!(json["attachments"][0]["name"], "report.txt");
        assert!(json.get("images").is_none());
        assert!(!json.to_string().contains("/home/private"));
        assert!(!json.to_string().contains("operation-1"));
    }

    #[test]
    fn inventory_session_token_is_bound_to_main_host_generation_and_machine() {
        let state = SessionTokenState::default();
        let request = begin_session_token_request(&state).unwrap();
        publish_session_tokens(
            &state,
            request,
            "main-host",
            4,
            SessionTokenScope::Machine {
                machine_host_id: "windows-subhost".into(),
                host_epoch: "main-epoch".into(),
            },
            HashMap::from([("safe-token".into(), "C:\\sessions\\private.jsonl".into())]),
        )
        .unwrap();
        assert_eq!(
            resolve_machine_session_token(&state, "main-host", 4, "windows-subhost", "safe-token",)
                .unwrap(),
            ("C:\\sessions\\private.jsonl".into(), "main-epoch".into(),)
        );
        assert!(
            resolve_machine_session_token(&state, "main-host", 4, "another-machine", "safe-token",)
                .is_err()
        );
        assert!(
            resolve_machine_session_token(
                &state,
                "another-main",
                4,
                "windows-subhost",
                "safe-token",
            )
            .is_err()
        );
        assert!(
            resolve_machine_session_token(&state, "main-host", 5, "windows-subhost", "safe-token",)
                .is_err()
        );
        assert!(
            resolve_work_session_token(&state, "main-host", 4, "work", "epoch", 1, "safe-token",)
                .is_err()
        );
    }

    #[test]
    fn older_session_list_completion_does_not_invalidate_newer_tokens() {
        let state = SessionTokenState::default();
        let older = begin_session_token_request(&state).unwrap();
        let newer = begin_session_token_request(&state).unwrap();
        let scope = SessionTokenScope::Work {
            host_epoch: "epoch".into(),
            instance_id: "work".into(),
            runtime_generation: 2,
        };
        publish_session_tokens(
            &state,
            newer,
            "host-a",
            7,
            scope.clone(),
            HashMap::from([("new-token".into(), "C:\\sessions\\new.jsonl".into())]),
        )
        .unwrap();
        publish_session_tokens(
            &state,
            older,
            "host-a",
            7,
            scope,
            HashMap::from([("old-token".into(), "/sessions/old.jsonl".into())]),
        )
        .unwrap();
        assert_eq!(
            resolve_work_session_token(&state, "host-a", 7, "work", "epoch", 2, "new-token",)
                .unwrap(),
            "C:\\sessions\\new.jsonl"
        );
        assert!(
            resolve_work_session_token(&state, "host-b", 7, "work", "epoch", 2, "new-token",)
                .is_err()
        );
        assert!(
            resolve_work_session_token(&state, "host-a", 8, "work", "epoch", 2, "new-token",)
                .is_err()
        );
    }
}
