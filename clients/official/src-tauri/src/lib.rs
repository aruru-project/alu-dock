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
    ClientError, CommandInfo, CommandsResult, ConnectionKind, ConnectionPolicy,
    ControllerEventData, DeliverableDownloadProgress, DeliverableDto, DeliveryMode, DiagnosticInfo,
    DockClient, Endpoint, EndpointState, EndpointTestResult, EventCursor, ExtensionControllerLease,
    ExtensionEvent, HistoryRecord, HostConnectionProfile, HostRegistry, HostRegistrySnapshot,
    IdentityStore, ImagePath, InstanceCatalog, InstanceSelector, InstanceSnapshot,
    InteractionMethod, InteractionRequest, InteractionResponse, ModelsResult, NavigateOptions,
    PairingProgress, PendingMessage, ProjectTrustDecision, PublishedFileDto, QueueDequeueResult,
    ReadReplay, ResourceInfo, ResourcesResult, SessionCompactionResult, SessionForkResult,
    SessionHistoryPage, SessionNameResult, SessionNavigateResult, SessionReloadResult,
    SessionReplacementResult, SessionScope, SessionTree, SettingUpdate, SettingUpdateResult,
    SettingsResult, SourceInfo, StopResult, SubmitResult, ThinkingLevel, ToolInfo, ToolsResult,
    WorkspacePage, delete_endpoint, host_info_for_profile, probe_host_endpoint,
    record_endpoint_test, reorder_endpoints, save_unverified_endpoint, save_verified_endpoint,
    saved_endpoint_for_test, set_connection_policy as update_connection_policy,
    set_endpoint_enabled, validate_device_name, validate_host_id,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    Emitter, Manager,
    ipc::{InvokeBody, Request, Response},
};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_fs::{FsExt, OpenOptions as PluginOpenOptions};
#[cfg(target_os = "windows")]
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const MAX_RENDERABLE_IMAGE_BYTES: u64 = 64 * 1_024 * 1_024;
#[cfg(any(target_os = "windows", test))]
const AWAY_NOTIFICATION_GRACE: Duration = Duration::from_secs(60);
#[cfg(target_os = "windows")]
const AWAY_POLL_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    host_id: String,
    selection_generation: u64,
    host: HostSummary,
    works: Vec<InstanceSnapshot>,
    total: u64,
    hidden_stopped: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkCatalogPayload {
    host_id: String,
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
    active_host_id: Option<String>,
    selection_generation: u64,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveHostChanged {
    old_host_id: Option<String>,
    new_host_id: Option<String>,
    selection_generation: u64,
    registry_revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSummary {
    state: String,
    host_epoch: String,
    dock_version: String,
    pi_sdk_version: String,
    started_at: String,
    profile: HostConnectionProfile,
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
struct EarlierConversationPage {
    records: Vec<HistoryRecord>,
    history_revision: u64,
    has_earlier: bool,
    next_before_entry_id: Option<String>,
    instance: InstanceSnapshot,
    host_epoch: String,
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
    host_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
    phase: String,
    bytes_processed: u64,
    total_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliverableProgressEmission {
    host_id: String,
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

#[derive(Clone, Default)]
struct AttachmentState {
    entries: Arc<Mutex<HashMap<String, NativeAttachment>>>,
}

struct NativeAttachment {
    path: PathBuf,
    temporary: bool,
    host_id: String,
    selection_generation: u64,
    work_id: String,
    operation_id: String,
    name: String,
    size_bytes: u64,
    media_type: Option<String>,
    active_attempt: Option<AttachmentAttempt>,
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
    host_id: String,
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

    fn rebind_generation(&self, host_id: &str, old_generation: u64, new_generation: u64) {
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
                scope.host_id == host_id && scope.selection_generation == old_generation
            })
            .collect::<Vec<_>>();
        for (old_scope, bucket) in preserved {
            buckets.insert(
                RestoredImageScope {
                    host_id: old_scope.host_id,
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
    package: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeCommand {
    name: String,
    description: Option<String>,
    source: SafeSource,
    argument_completions: bool,
}

#[derive(Serialize)]
struct SafeCommandsResult {
    commands: Vec<SafeCommand>,
    total: u64,
    truncated: bool,
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
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    subscription_id: String,
    event: ProjectedEvent,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FollowStatus {
    host_id: String,
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
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    subscription_id: String,
}

impl FollowState {
    fn abort_matching(
        &self,
        host_id: &str,
        selection_generation: u64,
        instance_id: &str,
        subscription_id: Option<&str>,
    ) -> Result<bool, CommandError> {
        let mut guard = self.task.lock().map_err(|_| follow_state_error())?;
        let matches = guard.as_ref().is_some_and(|task| {
            task.host_id == host_id
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
    host_id: String,
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
    host_id: String,
    selection_generation: u64,
    host_epoch: String,
    instance_id: String,
    runtime_generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControllerEmission {
    handle: String,
    host_id: String,
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
    host_id: String,
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
    host_id: String,
    selection_generation: u64,
    host_epoch: String,
    instance_id: String,
    runtime_generation: u64,
    session_file: String,
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
    host_id: String,
    selection_generation: u64,
    host_epoch: String,
    runtime_generation: u64,
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

#[derive(Default)]
struct RuntimeLifecycle {
    active_host_id: Option<String>,
    selection_generation: u64,
}

#[derive(Clone)]
struct HostRuntimeState {
    registry: HostRegistry,
    lifecycle: Arc<Mutex<RuntimeLifecycle>>,
}

impl RuntimeLifecycle {
    fn transition_to(&mut self, host_id: Option<String>) -> Result<u64, CommandError> {
        self.selection_generation = self
            .selection_generation
            .checked_add(1)
            .ok_or_else(lifecycle_error)?;
        self.active_host_id = host_id;
        Ok(self.selection_generation)
    }
}

impl HostRuntimeState {
    fn open(application_data_dir: Option<PathBuf>) -> Result<Self, ClientError> {
        let registry = if let Some(path) = std::env::var_os("ALUDOCK_CLIENT_IDENTITY_DIR") {
            HostRegistry::open(PathBuf::from(path))?
        } else if let Some(path) = application_data_dir {
            HostRegistry::open(path.join("identity"))?
        } else {
            HostRegistry::platform_default()?
        };
        let active_host_id = registry.snapshot()?.active_host_id;
        Ok(Self {
            registry,
            lifecycle: Arc::new(Mutex::new(RuntimeLifecycle {
                active_host_id,
                selection_generation: 1,
            })),
        })
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct AwayCatalogContext {
    host_id: String,
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
    fn from_instances(instances: &[AwayInstanceState]) -> Self {
        Self {
            executions: instances
                .iter()
                .map(|instance| (instance.instance_id.clone(), instance.execution))
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

    fn take_ready(&mut self, away_for: Duration) -> Vec<AwayCompletion> {
        if away_for < AWAY_NOTIFICATION_GRACE {
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

#[cfg(target_os = "windows")]
#[derive(Clone, Default)]
struct AwayMonitorState {
    task: Arc<Mutex<Option<AwayMonitorTask>>>,
}

#[cfg(target_os = "windows")]
struct AwayMonitorTask {
    handle: tauri::async_runtime::JoinHandle<()>,
    cancelled: Arc<AtomicBool>,
}

#[cfg(target_os = "windows")]
impl AwayMonitorState {
    fn start(&self, app: tauri::AppHandle, runtime: HostRuntimeState) {
        let Ok(mut guard) = self.task.lock() else {
            return;
        };
        if let Some(previous) = guard.take() {
            previous.cancelled.store(true, Ordering::Release);
            previous.handle.abort();
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let task_cancelled = cancelled.clone();
        let handle = tauri::async_runtime::spawn(async move {
            monitor_while_away(app, runtime, task_cancelled).await;
        });
        *guard = Some(AwayMonitorTask { handle, cancelled });
    }

    fn stop(&self) {
        let Ok(mut guard) = self.task.lock() else {
            return;
        };
        if let Some(task) = guard.take() {
            task.cancelled.store(true, Ordering::Release);
            task.handle.abort();
        }
    }
}

#[cfg(target_os = "windows")]
async fn read_away_catalog(
    runtime: &HostRuntimeState,
) -> Result<Option<AwayCatalogSnapshot>, CommandError> {
    let (host_id, selection_generation) = {
        let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
        let Some(host_id) = lifecycle.active_host_id.clone() else {
            return Ok(None);
        };
        (host_id, lifecycle.selection_generation)
    };
    let store = resolve_host(runtime, &host_id, selection_generation)?;
    let (catalog, host_epoch) = dock_client(&store)?
        .list_instances_with_host_epoch(InstanceSelector::All)
        .await
        .map_err(CommandError::from)?;
    {
        let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
        ensure_host_selection(&lifecycle, &host_id, selection_generation)?;
    }
    Ok(Some(AwayCatalogSnapshot {
        context: AwayCatalogContext {
            host_id,
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
    runtime: HostRuntimeState,
    cancelled: Arc<AtomicBool>,
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
                    tracker = Some(AwayCompletionTracker::from_instances(&snapshot.instances));
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
            show_away_completions(&app, tracker.take_ready(started_at.elapsed()));
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
                message: "附件超过 512 MiB 大小限制。".into(),
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
                message: "这台 Host 已保存在此设备上；原有配对凭据未被覆盖。".into(),
                details: Some(serde_json::json!({ "hostId": host_id })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Storage { .. } | ClientError::Io(_) => Self {
                code: "local_storage_unavailable".into(),
                message: "无法安全读取或保存本机配对信息。请检查应用存储权限和可用空间。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Protocol(message) => Self {
                code: "protocol_error".into(),
                message,
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Json(_) | ClientError::Crypto(_) => Self {
                code: "client_error".into(),
                message: "客户端无法验证收到的数据。没有保存不可信的更改。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
        }
    }
}

fn lifecycle_error() -> CommandError {
    CommandError {
        code: "host_lifecycle_unavailable".into(),
        message: "Host 切换状态暂时不可用。".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

fn ensure_host_selection(
    lifecycle: &RuntimeLifecycle,
    host_id: &str,
    selection_generation: u64,
) -> Result<(), CommandError> {
    if lifecycle.selection_generation != selection_generation {
        return Err(CommandError {
            code: "stale_host_selection".into(),
            message: "Host 选择已经改变；旧请求已丢弃。".into(),
            details: Some(serde_json::json!({
                "hostId": host_id,
                "selectionGeneration": selection_generation,
                "currentSelectionGeneration": lifecycle.selection_generation,
            })),
            outcome_unknown: false,
            operation_id: None,
        });
    }
    if lifecycle.active_host_id.as_deref() != Some(host_id) {
        return Err(CommandError {
            code: "stale_host_selection".into(),
            message: "这不是当前选择的 Host；请求未发送。".into(),
            details: Some(serde_json::json!({ "hostId": host_id })),
            outcome_unknown: false,
            operation_id: None,
        });
    }
    Ok(())
}

fn resolve_host(
    runtime: &HostRuntimeState,
    host_id: &str,
    selection_generation: u64,
) -> Result<IdentityStore, CommandError> {
    validate_host_id(host_id).map_err(CommandError::from)?;
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_host_selection(&lifecycle, host_id, selection_generation)?;
    runtime
        .registry
        .resolve_store(Some(host_id))
        .map_err(CommandError::from)
}

fn mutate_selected_host<T>(
    runtime: &HostRuntimeState,
    host_id: &str,
    selection_generation: u64,
    mutation: impl FnOnce(&IdentityStore) -> aludock_client_core::Result<T>,
) -> Result<T, CommandError> {
    validate_host_id(host_id).map_err(CommandError::from)?;
    // Keep the lifecycle lock through the profile CAS. A Host transition can
    // therefore happen either before this revalidation or after persistence,
    // never between the generation check and the write.
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_host_selection(&lifecycle, host_id, selection_generation)?;
    let store = runtime
        .registry
        .resolve_store(Some(host_id))
        .map_err(CommandError::from)?;
    mutation(&store).map_err(CommandError::from)
}

fn connection_profile(store: &IdentityStore) -> Result<HostConnectionProfile, CommandError> {
    store
        .load_connection_profile()
        .map_err(CommandError::from)?
        .ok_or_else(|| CommandError {
            code: "not_paired".into(),
            message: "尚未连接 AluDock".into(),
            details: None,
            outcome_unknown: false,
            operation_id: None,
        })
}

fn dock_client(store: &IdentityStore) -> Result<DockClient, CommandError> {
    let profile = connection_profile(store)?;
    DockClient::from_connection_profile(store, &profile).map_err(CommandError::from)
}

fn catalog_from_snapshot(
    runtime: &HostRuntimeState,
    snapshot: HostRegistrySnapshot,
    selection_generation: u64,
) -> Result<HostCatalog, CommandError> {
    let mut hosts = Vec::with_capacity(snapshot.hosts.len());
    for record in &snapshot.hosts {
        let store = runtime
            .registry
            .resolve_store(Some(&record.host_id))
            .map_err(CommandError::from)?;
        let profile = connection_profile(&store)?;
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
            .unwrap_or_else(|| "没有已保存地址".into());
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
    Ok(HostCatalog {
        schema_version: snapshot.schema_version,
        revision: snapshot.revision,
        active_host_id: snapshot.active_host_id,
        selection_generation,
        hosts,
        pairing_transaction_ids,
        pairing_transactions,
    })
}

#[allow(clippy::too_many_arguments)]
fn invalidate_host_lifecycle(
    app: &tauri::AppHandle,
    follow: &FollowState,
    extension: &ExtensionControlState,
    sessions: &SessionTokenState,
    attachments: &AttachmentState,
    restored_images: &RestoredImageState,
    old_host_id: Option<String>,
    new_host_id: Option<String>,
    old_selection_generation: u64,
    selection_generation: u64,
    registry_revision: u64,
) {
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
                    host_id: binding.host_id,
                    selection_generation: binding.selection_generation,
                    host_epoch: binding.host_epoch,
                    instance_id: binding.instance_id,
                    runtime_generation: binding.runtime_generation,
                    state: "detached".into(),
                    message: Some("Host 已切换；旧控制权已释放。".into()),
                },
            );
        }
    }
    if let Ok(mut registry) = sessions.registry.lock() {
        registry.tokens.clear();
    }
    attachments.clear();
    match (old_host_id.as_deref(), new_host_id.as_deref()) {
        (Some(old_host_id), Some(new_host_id)) if old_host_id == new_host_id => {
            restored_images.rebind_generation(
                old_host_id,
                old_selection_generation,
                selection_generation,
            );
        }
        _ => restored_images.clear(),
    }
    let _ = app.emit(
        "aludock://active-host-changed",
        ActiveHostChanged {
            old_host_id,
            new_host_id,
            selection_generation,
            registry_revision,
        },
    );
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
fn get_host_catalog(
    runtime: tauri::State<'_, HostRuntimeState>,
) -> Result<HostCatalog, CommandError> {
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    let snapshot = runtime.registry.snapshot().map_err(CommandError::from)?;
    let generation = lifecycle.selection_generation;
    drop(lifecycle);
    catalog_from_snapshot(&runtime, snapshot, generation)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_active_host(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, HostRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    sessions: tauri::State<'_, SessionTokenState>,
    attachments: tauri::State<'_, AttachmentState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    host_id: String,
    expected_revision: u64,
) -> Result<HostCatalog, CommandError> {
    let mut lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    let old_host_id = lifecycle.active_host_id.clone();
    let old_generation = lifecycle.selection_generation;
    let snapshot = runtime
        .registry
        .set_active_host(&host_id, expected_revision)
        .map_err(CommandError::from)?;
    let generation = lifecycle.transition_to(Some(host_id))?;
    let new_host_id = lifecycle.active_host_id.clone();
    invalidate_host_lifecycle(
        &app,
        &follow,
        &extension,
        &sessions,
        &attachments,
        &restored_images,
        old_host_id,
        new_host_id,
        old_generation,
        generation,
        snapshot.revision,
    );
    drop(lifecycle);
    catalog_from_snapshot(&runtime, snapshot, generation)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn remove_local_host(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, HostRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    sessions: tauri::State<'_, SessionTokenState>,
    attachments: tauri::State<'_, AttachmentState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    host_id: String,
    expected_revision: u64,
) -> Result<HostCatalog, CommandError> {
    let mut lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    let old_host_id = lifecycle.active_host_id.clone();
    let old_generation = lifecycle.selection_generation;
    let snapshot = runtime
        .registry
        .remove_local_host(&host_id, expected_revision)
        .map_err(CommandError::from)?;
    let generation = lifecycle.transition_to(snapshot.active_host_id.clone())?;
    invalidate_host_lifecycle(
        &app,
        &follow,
        &extension,
        &sessions,
        &attachments,
        &restored_images,
        old_host_id,
        snapshot.active_host_id.clone(),
        old_generation,
        generation,
        snapshot.revision,
    );
    drop(lifecycle);
    catalog_from_snapshot(&runtime, snapshot, generation)
}

#[tauri::command]
async fn start_pairing(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, HostRuntimeState>,
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
                let old_host_id = lifecycle.active_host_id.clone();
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
                let generation = match lifecycle.transition_to(Some(verified.host_id.clone())) {
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
                invalidate_host_lifecycle(
                    &task_app,
                    &follow,
                    &extension,
                    &sessions,
                    &attachments,
                    &restored_images,
                    old_host_id,
                    Some(verified.host_id.clone()),
                    old_generation,
                    generation,
                    registry_revision,
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
    runtime: tauri::State<'_, HostRuntimeState>,
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
                message: Some("已停止等待；如果电脑已经确认，配对状态会保留以便安全恢复。".into()),
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
    runtime: tauri::State<'_, HostRuntimeState>,
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
async fn bootstrap(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
) -> Result<BootstrapPayload, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let mut profile = connection_profile(&store)?;
    let (info, active_endpoint_id) =
        host_info_for_profile(&store, &profile)
            .await
            .map_err(|error| CommandError {
                code: "host_unreachable".into(),
                message: format!(
                    "无法连接“{}”；已保留选择，没有自动切换其他 Host。",
                    profile.display_name
                ),
                details: Some(serde_json::json!({ "hostId": host_id, "cause": error.to_string() })),
                outcome_unknown: false,
                operation_id: None,
            })?;
    if profile.last_successful_endpoint_id.as_deref() != Some(active_endpoint_id.as_str()) {
        profile = store
            .update_connection_profile(|current| {
                current.last_successful_endpoint_id = Some(active_endpoint_id.clone());
                Ok(())
            })
            .map_err(CommandError::from)?;
    }
    let client =
        DockClient::from_connection_profile_preferred(&store, &profile, &active_endpoint_id)
            .map_err(CommandError::from)?;
    let (catalog, catalog_host_epoch) = client
        .list_instances_with_host_epoch(InstanceSelector::All)
        .await
        .map_err(CommandError::from)?;
    if catalog_host_epoch != info.host.host_epoch {
        return Err(CommandError::from(ClientError::Protocol(
            "Host epoch changed while bootstrapping the instance catalog".into(),
        )));
    }
    let InstanceCatalog {
        instances,
        total,
        hidden_stopped,
    } = catalog;
    Ok(BootstrapPayload {
        host_id,
        selection_generation,
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
) -> Result<WorkCatalogPayload, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let (catalog, host_epoch) = dock_client(&store)?
        .list_instances_with_host_epoch(InstanceSelector::All)
        .await
        .map_err(CommandError::from)?;
    Ok(WorkCatalogPayload {
        host_id,
        selection_generation,
        host_epoch,
        instances: catalog.instances,
        total: catalog.total,
        hidden_stopped: catalog.hidden_stopped,
    })
}

#[tauri::command]
async fn conversation_bootstrap(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<ConversationBootstrap, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let read = dock_client(&store)?
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

#[tauri::command]
async fn conversation_history(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    before_entry_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    expected_history_revision: u64,
) -> Result<EarlierConversationPage, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let (page, host_epoch): (SessionHistoryPage, String) = dock_client(&store)?
        .session_history(&instance_id, Some(&before_entry_id), 50)
        .await
        .map_err(CommandError::from)?;
    if host_epoch != expected_host_epoch
        || page.instance.owner_host_epoch.as_deref() != Some(expected_host_epoch.as_str())
        || page.instance.runtime_generation != expected_runtime_generation
        || page.history_revision != expected_history_revision
    {
        return Err(CommandError::from(ClientError::Protocol(
            "conversation history changed; refresh the current Work before loading older records"
                .into(),
        )));
    }
    Ok(EarlierConversationPage {
        records: page.entries,
        history_revision: page.history_revision,
        has_earlier: page.has_earlier,
        next_before_entry_id: page.next_before_entry_id,
        instance: page.instance,
        host_epoch,
    })
}

#[tauri::command]
async fn conversation_image(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    content_ref: String,
    mime_type: String,
) -> Result<Response, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let image = dock_client(&store)?
        .read_conversation_image(&instance_id, &content_ref, &mime_type)
        .await
        .map_err(CommandError::from)?;
    resolve_host(&runtime, &host_id, selection_generation)?;
    if image.host_epoch != expected_host_epoch
        || image.runtime_generation != expected_runtime_generation
        || image.mime_type != mime_type
    {
        return Err(CommandError::from(ClientError::Protocol(
            "conversation image belonged to an obsolete Work state".into(),
        )));
    }
    validate_renderable_image(&image.bytes, Some(&mime_type))?;
    Ok(Response::new(image.bytes))
}

#[tauri::command]
async fn published_image(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    file: PublishedFileDto,
) -> Result<Response, CommandError> {
    if file.size_bytes > MAX_RENDERABLE_IMAGE_BYTES {
        return Err(image_error(
            "image_too_large",
            "这张图片太大，当前设备无法安全预览。",
        ));
    }
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let image = dock_client(&store)?
        .read_published_file(&instance_id, &file)
        .await
        .map_err(CommandError::from)?;
    resolve_host(&runtime, &host_id, selection_generation)?;
    if image.host_epoch != expected_host_epoch
        || image.runtime_generation != expected_runtime_generation
        || image.file != file
    {
        return Err(CommandError::from(ClientError::Protocol(
            "published image belonged to an obsolete Work state".into(),
        )));
    }
    validate_renderable_image(&image.bytes, file.media_type.as_deref())?;
    Ok(Response::new(image.bytes))
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
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    subscription_id: String,
) -> Result<bool, CommandError> {
    state.abort_matching(
        &host_id,
        selection_generation,
        &instance_id,
        Some(&subscription_id),
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_conversation_follow(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    app: tauri::AppHandle,
    state: tauri::State<'_, FollowState>,
    instance_id: String,
    subscription_id: String,
    cursor: EventCursor,
) -> Result<(), CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_host_selection(&lifecycle, &host_id, selection_generation)?;
    let mut guard = state.task.lock().map_err(|_| follow_state_error())?;
    if let Some(task) = guard.take() {
        task.handle.abort();
    }
    let followed_host = host_id.clone();
    let followed_instance = instance_id.clone();
    let followed_subscription = subscription_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let status = |state: &str, message: Option<String>| FollowStatus {
            host_id: followed_host.clone(),
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
                    host_id: followed_host.clone(),
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
                            host_id: followed_host.clone(),
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
        host_id,
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
    binding_host_id: &str,
    binding_selection_generation: u64,
    requested_host_id: &str,
    requested_selection_generation: u64,
) -> bool {
    binding_host_id == requested_host_id
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    app: tauri::AppHandle,
    state: tauri::State<'_, ExtensionControlState>,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
) -> Result<SafeControllerBinding, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    ensure_host_selection(&lifecycle, &host_id, selection_generation)?;
    let handle = uuid::Uuid::new_v4().to_string();
    let safe = SafeControllerBinding {
        handle: handle.clone(),
        host_id: host_id.clone(),
        selection_generation,
        host_epoch: controller.host_epoch.clone(),
        instance_id: controller.instance_id.clone(),
        runtime_generation: controller.runtime_generation,
    };
    let mut stream = controller.stream;
    let binding = ExtensionBinding {
        handle: handle.clone(),
        host_id: host_id.clone(),
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
    let task_host_id = host_id;
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
                    || binding.host_id != task_host_id
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
                        host_id: task_host_id.clone(),
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
                    host_id: task_host_id,
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    state: tauri::State<'_, ExtensionControlState>,
    handle: String,
) -> Result<(), CommandError> {
    let _store = resolve_host(&runtime, &host_id, selection_generation)?;
    let mut guard = state.inner.lock().map_err(|_| extension_state_error())?;
    if let Some(binding) = guard
        .binding
        .as_ref()
        .filter(|binding| binding.handle == handle)
    {
        if !extension_scope_matches(
            &binding.host_id,
            binding.selection_generation,
            &host_id,
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
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
                        &binding.host_id,
                        binding.selection_generation,
                        &host_id,
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
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let result = dock_client(&store)?
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
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
                        &binding.host_id,
                        binding.selection_generation,
                        &host_id,
                        selection_generation,
                    )
            })
            .ok_or_else(stale_extension_handle)?;
        if binding.last_viewport == Some((width, height)) {
            return Ok(aludock_client_core::WidgetViewportResult { accepted: true });
        }
        binding.clone()
    };
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let result = dock_client(&store)?
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    expanded: bool,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let snapshot = dock_client(&store)?
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

const MAX_SELECTED_ATTACHMENTS: usize = 32;
const MAX_SELECTED_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;

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

fn attachment_scope_matches(
    entry: &NativeAttachment,
    host_id: &str,
    selection_generation: u64,
    work_id: &str,
) -> bool {
    entry.host_id == host_id
        && entry.selection_generation == selection_generation
        && entry.work_id == work_id
}

fn ensure_attachment_scope(
    entry: &NativeAttachment,
    host_id: &str,
    selection_generation: u64,
    work_id: &str,
) -> Result<(), CommandError> {
    if attachment_scope_matches(entry, host_id, selection_generation, work_id) {
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
            "只能选择本机普通文件。",
        ));
    };
    if url.scheme() != "content" {
        return Err(attachment_command_error(
            "invalid_attachment_source",
            "只能选择本机普通文件。",
        ));
    }
    let webview = app.get_webview_window("main").ok_or_else(|| {
        attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
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
            attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
        })?;
    let description = tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| {
            attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
        })?
        .map_err(|_| {
            attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
        })?
        .map_err(|_| {
            attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
        })?;
    serde_json::from_str(&description).map_err(|_| {
        attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
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
            attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
        })?
        .join("attachment-staging");
    let staging_path =
        staging_directory.join(format!("aludock-selection-{}.part", uuid::Uuid::new_v4()));
    let staging_app = app.clone();
    let copied_path = staging_path.clone();
    let size_bytes = tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&staging_directory).map_err(|_| {
            attachment_command_error("attachment_source_unavailable", "无法暂存所选附件。")
        })?;
        let mut source_options = PluginOpenOptions::new();
        source_options.read(true);
        let mut source = staging_app.fs().open(file, source_options).map_err(|_| {
            attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
        })?;
        let mut target_options = OpenOptions::new();
        target_options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            target_options.mode(0o600);
        }
        let mut target = target_options.open(&copied_path).map_err(|_| {
            attachment_command_error("attachment_source_unavailable", "无法暂存所选附件。")
        })?;
        let copied = match copy_bounded_attachment(
            &mut source,
            &mut target,
            MAX_SELECTED_ATTACHMENT_BYTES,
        ) {
            Ok(copied) => copied,
            Err(_) => {
                drop(target);
                let _ = fs::remove_file(&copied_path);
                return Err(attachment_command_error(
                    "attachment_source_unavailable",
                    "无法读取所选附件。",
                ));
            }
        };
        if copied > MAX_SELECTED_ATTACHMENT_BYTES {
            drop(target);
            let _ = fs::remove_file(&copied_path);
            return Err(attachment_command_error(
                "attachment_too_large",
                "附件超过 512 MiB 大小限制。",
            ));
        }
        if target.flush().is_err() {
            drop(target);
            let _ = fs::remove_file(&copied_path);
            return Err(attachment_command_error(
                "attachment_source_unavailable",
                "无法暂存所选附件。",
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
    host_id: String,
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
            host_id,
            selection_generation,
            work_id,
            operation_id: uuid::Uuid::new_v4().to_string(),
            name,
            size_bytes,
            media_type,
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
        .ok_or_else(|| {
            attachment_command_error(
                "invalid_clipboard_image",
                "无法读取粘贴图片的上下文，请重新粘贴。",
            )
        })
}

fn request_image_bytes(request: &Request<'_>) -> Result<Vec<u8>, CommandError> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .filter(|value| *value <= u8::MAX as u64)
                    .map(|value| value as u8)
                    .ok_or_else(|| {
                        attachment_command_error(
                            "invalid_clipboard_image",
                            "剪贴板中的图片数据无效，请重新复制。",
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(attachment_command_error(
                "invalid_clipboard_image",
                "剪贴板中的图片数据无效，请重新复制。",
            ));
        }
    };
    if bytes.is_empty() || bytes.len() as u64 > MAX_RENDERABLE_IMAGE_BYTES {
        return Err(attachment_command_error(
            "clipboard_image_too_large",
            "粘贴的图片过大，无法作为附件。请改用附件按钮选择原文件。",
        ));
    }
    Ok(bytes)
}

fn prepare_clipboard_image(
    bytes: Vec<u8>,
    host_id: String,
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
        attachment_command_error(
            "clipboard_image_unavailable",
            "无法暂存粘贴的图片，请重试或使用附件按钮。",
        )
    })?;
    if file.write_all(&bytes).and_then(|_| file.flush()).is_err() {
        let _ = fs::remove_file(&path);
        return Err(attachment_command_error(
            "clipboard_image_unavailable",
            "无法暂存粘贴的图片，请重试或使用附件按钮。",
        ));
    }
    drop(file);
    Ok(prepare_native_attachment(
        path,
        true,
        host_id,
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
    host_id: &str,
    selection_generation: u64,
    work_id: &str,
    prepared: Vec<PreparedAttachment>,
) -> Result<Vec<SelectedAttachment>, CommandError> {
    // Match set_active_host's lock order so generation validation and native-path
    // publication form one atomic lifecycle operation.
    let lifecycle = lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_host_selection(&lifecycle, host_id, selection_generation)?;
    let mut entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let current = entries
        .values()
        .filter(|entry| attachment_scope_matches(entry, host_id, selection_generation, work_id))
        .count();
    if prepared.len() > MAX_SELECTED_ATTACHMENTS.saturating_sub(current) {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            "每个工作最多选择 32 个待上传附件。",
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
        ClientError::Host { code, .. } if code == "file_unavailable" => {
            deliverable_command_error("file_unavailable", "这个文件已无法下载。请让阿露重新发送。")
        }
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

async fn pick_deliverable_destination(
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

async fn commit_deliverable(
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<Vec<DeliverableDto>, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
        .list_deliverables(&instance_id)
        .await
        .map_err(deliverable_list_error)
}

#[tauri::command]
async fn download_deliverable(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    deliverable: DeliverableDto,
) -> Result<DeliverableSaveResult, CommandError> {
    deliverable.validate().map_err(deliverable_client_error)?;
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    #[cfg(not(mobile))]
    let destination = pick_deliverable_destination(&app, &deliverable.name).await?;
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
    let progress_host = host_id.clone();
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
                        host_id: progress_host.clone(),
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
        destination = match pick_deliverable_destination(&app, &deliverable.name).await {
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
    commit_deliverable(&app, staging_path, destination).await?;

    Ok(DeliverableSaveResult::Saved {
        deliverable: result.deliverable,
        location: saved_location,
        sha256: result.sha256,
    })
}

#[tauri::command]
fn open_saved_deliverable(
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
            let path = PathBuf::from(&location.value);
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            {
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
            #[cfg(any(target_os = "android", target_os = "ios"))]
            app.opener()
                .open_path(location.value, None::<&str>)
                .map_err(|_| {
                    deliverable_command_error(
                        "saved_file_open_failed",
                        SAVED_FILE_UNAVAILABLE_MESSAGE,
                    )
                })?;
            Ok(())
        }
        "uri" => app
            .opener()
            .open_url(location.value, None::<&str>)
            .map_err(|_| {
                deliverable_command_error("saved_file_unavailable", SAVED_FILE_UNAVAILABLE_MESSAGE)
            }),
        _ => Err(deliverable_command_error(
            "saved_file_unavailable",
            SAVED_FILE_UNAVAILABLE_MESSAGE,
        )),
    }
}

#[tauri::command]
async fn pick_attachments(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, HostRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    host_id: String,
    selection_generation: u64,
    work_id: String,
) -> Result<Vec<SelectedAttachment>, CommandError> {
    drop(resolve_host(&runtime, &host_id, selection_generation)?);
    let existing = state
        .entries
        .lock()
        .map_err(|_| lifecycle_error())?
        .values()
        .filter(|entry| attachment_scope_matches(entry, &host_id, selection_generation, &work_id))
        .count();
    if existing >= MAX_SELECTED_ATTACHMENTS {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            "每个工作最多选择 32 个待上传附件。",
        ));
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |files| {
        let _ = sender.send(files);
    });
    let Some(files) = receiver
        .await
        .map_err(|_| attachment_command_error("attachment_picker_failed", "无法完成附件选择。"))?
    else {
        return Ok(Vec::new());
    };
    if files.len() > MAX_SELECTED_ATTACHMENTS - existing {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            "每个工作最多选择 32 个待上传附件。",
        ));
    }

    let mut prepared = Vec::with_capacity(files.len());
    for file in files {
        let local_path = file.clone().into_path();
        let (path, temporary, name, size_bytes, media_type) = match local_path {
            Ok(path) => {
                let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
                    attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
                })?;
                if !metadata.file_type().is_file() {
                    return Err(attachment_command_error(
                        "invalid_attachment_source",
                        "只能选择本机普通文件。",
                    ));
                }
                if metadata.len() > MAX_SELECTED_ATTACHMENT_BYTES {
                    return Err(attachment_command_error(
                        "attachment_too_large",
                        "附件超过 512 MiB 大小限制。",
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
                        "只能选择本机普通文件。",
                    ));
                }
            }
        };
        prepared.push(prepare_native_attachment(
            path,
            temporary,
            host_id.clone(),
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
        &host_id,
        selection_generation,
        &work_id,
        prepared,
    )
}

#[tauri::command]
async fn stage_clipboard_image(
    runtime: tauri::State<'_, HostRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    request: Request<'_>,
) -> Result<SelectedAttachment, CommandError> {
    let host_id = request_header(&request, "x-aludock-host-id")?;
    let selection_generation = request_header(&request, "x-aludock-selection-generation")?
        .parse::<u64>()
        .map_err(|_| {
            attachment_command_error(
                "invalid_clipboard_image",
                "无法读取粘贴图片的上下文，请重新粘贴。",
            )
        })?;
    let work_id = request_header(&request, "x-aludock-work-id")?;
    let image_index = request_header(&request, "x-aludock-image-index")?
        .parse::<usize>()
        .ok()
        .filter(|index| (1..=MAX_SELECTED_ATTACHMENTS).contains(index))
        .ok_or_else(|| {
            attachment_command_error(
                "invalid_clipboard_image",
                "无法读取粘贴图片的上下文，请重新粘贴。",
            )
        })?;
    drop(resolve_host(&runtime, &host_id, selection_generation)?);
    let bytes = request_image_bytes(&request)?;
    let prepared_host = host_id.clone();
    let prepared_work = work_id.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        prepare_clipboard_image(
            bytes,
            prepared_host,
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
        &host_id,
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
    runtime: tauri::State<'_, HostRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    host_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
) -> Result<Response, CommandError> {
    drop(resolve_host(&runtime, &host_id, selection_generation)?);
    let (path, operation_id, size_bytes, media_type) = {
        let entries = state.entries.lock().map_err(|_| lifecycle_error())?;
        let entry = entries.get(&token).ok_or_else(|| {
            attachment_command_error(
                "attachment_preview_unavailable",
                "这个附件已无法预览，请重新选择。",
            )
        })?;
        ensure_attachment_scope(entry, &host_id, selection_generation, &work_id)?;
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
            "附件源文件发生了变化，请重新选择。",
        ));
    }
    validate_renderable_image(&bytes, media_type.as_deref())?;
    drop(resolve_host(&runtime, &host_id, selection_generation)?);
    let entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let entry = entries.get(&token).ok_or_else(|| {
        attachment_command_error(
            "attachment_preview_unavailable",
            "这个附件已无法预览，请重新选择。",
        )
    })?;
    ensure_attachment_scope(entry, &host_id, selection_generation, &work_id)?;
    if entry.operation_id != operation_id {
        return Err(attachment_command_error(
            "attachment_preview_unavailable",
            "这个附件已无法预览，请重新选择。",
        ));
    }
    drop(entries);
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn upload_attachment(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, HostRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    host_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
) -> Result<AttachmentUploadResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    let (path, operation_id, name, media_type, cancellation, attempt_id) = {
        let mut entries = state.entries.lock().map_err(|_| lifecycle_error())?;
        let entry = entries.get_mut(&token).ok_or_else(|| {
            attachment_command_error("attachment_not_found", "附件选择已失效，请重新选择。")
        })?;
        ensure_attachment_scope(entry, &host_id, selection_generation, &work_id)?;
        if entry.active_attempt.is_some() {
            return Err(attachment_command_error(
                "attachment_upload_in_progress",
                "此附件正在上传。",
            ));
        }
        let metadata = std::fs::symlink_metadata(&entry.path).map_err(|_| {
            attachment_command_error("attachment_source_unavailable", "无法读取所选附件。")
        })?;
        if !metadata.file_type().is_file() || metadata.len() != entry.size_bytes {
            return Err(attachment_command_error(
                "attachment_source_changed",
                "附件源文件发生了变化，请重新选择。",
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
    let progress_host = host_id.clone();
    let progress_work = work_id.clone();
    let progress_token = token.clone();
    let result = client
        .upload_attachment_file(
            path,
            &operation_id,
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
                        host_id: progress_host.clone(),
                        selection_generation,
                        work_id: progress_work.clone(),
                        token: progress_token.clone(),
                        phase: phase.into(),
                        bytes_processed: progress.bytes_processed,
                        total_bytes: progress.total_bytes,
                    },
                );
            },
        )
        .await;

    let mut entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let still_current = entries.get(&token).is_some_and(|entry| {
        attachment_scope_matches(entry, &host_id, selection_generation, &work_id)
            && entry.operation_id == operation_id
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
            entries.remove(&token);
            Ok(result)
        }
        Err(error) => {
            if let Some(entry) = entries.get_mut(&token) {
                entry.active_attempt = None;
            }
            Err(attachment_upload_error(error))
        }
    }
}

#[tauri::command]
fn cancel_attachment_upload(
    runtime: tauri::State<'_, HostRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    host_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
) -> Result<bool, CommandError> {
    drop(resolve_host(&runtime, &host_id, selection_generation)?);
    let entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let Some(entry) = entries.get(&token) else {
        return Ok(false);
    };
    ensure_attachment_scope(entry, &host_id, selection_generation, &work_id)?;
    if let Some(attempt) = &entry.active_attempt {
        attempt.cancellation.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn remove_attachment(
    runtime: tauri::State<'_, HostRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    host_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
) -> Result<bool, CommandError> {
    drop(resolve_host(&runtime, &host_id, selection_generation)?);
    let mut entries = state.entries.lock().map_err(|_| lifecycle_error())?;
    let Some(entry) = entries.get(&token) else {
        return Ok(false);
    };
    ensure_attachment_scope(entry, &host_id, selection_generation, &work_id)?;
    if let Some(attempt) = &entry.active_attempt {
        attempt.cancellation.cancel();
    }
    entries.remove(&token);
    Ok(true)
}

fn restored_image_scope(
    host_id: &str,
    selection_generation: u64,
    work_id: &str,
) -> RestoredImageScope {
    RestoredImageScope {
        host_id: host_id.to_owned(),
        selection_generation,
        work_id: work_id.to_owned(),
    }
}

#[tauri::command]
async fn submit_message(
    runtime: tauri::State<'_, HostRuntimeState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    message: String,
    attachment_file_ids: Option<Vec<String>>,
) -> Result<SubmitResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    let scope = restored_image_scope(&host_id, selection_generation, &instance_id);
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
    runtime: tauri::State<'_, HostRuntimeState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeQueueDequeueResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let result = dock_client(&store)?
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
        restored_image_scope(&host_id, selection_generation, &instance_id),
        images,
    );
    Ok(project_queue_dequeue(result))
}

#[tauri::command]
fn clear_restored_images(
    runtime: tauri::State<'_, HostRuntimeState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<RestoredImageCount, CommandError> {
    drop(resolve_host(&runtime, &host_id, selection_generation)?);
    Ok(RestoredImageCount {
        image_count: restored_images.clear_scope(&restored_image_scope(
            &host_id,
            selection_generation,
            &instance_id,
        )),
    })
}

#[tauri::command]
async fn abort_run(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    client
        .abort_run(&instance_id, None)
        .await
        .map_err(CommandError::from)
}

fn detach_work_runtime(
    follow: &FollowState,
    extension: &ExtensionControlState,
    host_id: &str,
    selection_generation: u64,
    instance_id: &str,
) {
    let _ = follow.abort_matching(host_id, selection_generation, instance_id, None);
    if let Ok(mut guard) = extension.inner.lock()
        && guard.binding.as_ref().is_some_and(|binding| {
            binding.host_id == host_id
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
    runtime: tauri::State<'_, HostRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<StopResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let result = dock_client(&store)?
        .stop_instance(&instance_id, None)
        .await
        .map_err(CommandError::from)?;
    detach_work_runtime(
        &follow,
        &extension,
        &host_id,
        selection_generation,
        &instance_id,
    );
    Ok(result)
}

#[tauri::command]
async fn command_catalog(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeCommandsResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    client
        .commands(&instance_id, None)
        .await
        .map(project_commands)
        .map_err(CommandError::from)
}

#[tauri::command]
async fn run_catalog_command(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    name: String,
    arguments: String,
    operation_id: String,
) -> Result<SubmitResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<ModelsResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
        .models(&instance_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn set_model(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    provider: String,
    model_id: String,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
        .set_model(&instance_id, &provider, &model_id, None)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn set_thinking(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    level: ThinkingLevel,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
        .set_thinking(&instance_id, level, None)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn list_tools(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeToolsResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
        .tools(&instance_id)
        .await
        .map(project_tools)
        .map_err(CommandError::from)
}

#[tauri::command]
async fn set_active_tools(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    names: Vec<String>,
) -> Result<SafeToolsResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
        .set_active_tools(&instance_id, &names, None)
        .await
        .map(project_tools)
        .map_err(CommandError::from)
}

#[tauri::command]
async fn get_settings(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SettingsResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
        .settings(&instance_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn update_setting(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    update: SettingUpdate,
) -> Result<SettingUpdateResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
        .update_setting(&instance_id, &update, None)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn get_resources(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeResourcesResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    dock_client(&store)?
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

fn project_commands(result: CommandsResult) -> SafeCommandsResult {
    SafeCommandsResult {
        commands: result
            .commands
            .into_iter()
            .map(|command: CommandInfo| SafeCommand {
                name: command.name,
                description: command.description,
                source: project_source(command.source),
                argument_completions: command.argument_completions,
            })
            .collect(),
        total: result.total,
        truncated: result.truncated,
    }
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    operation_id: Option<String>,
    trust_challenge_id: Option<String>,
    project_trust_decision: Option<String>,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<(), CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    client
        .forget_instance(&instance_id, None)
        .await
        .map_err(CommandError::from)?;
    Ok(())
}

#[tauri::command]
fn get_connection_profile(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    connection_profile(&store)
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
    runtime: &HostRuntimeState,
    host_id: &str,
    selection_generation: u64,
    mutation: VerifiedEndpointMutation,
) -> Result<HostConnectionProfile, CommandError> {
    mutate_selected_host(runtime, host_id, selection_generation, |store| {
        save_verified_endpoint(
            store,
            mutation.endpoint,
            &mutation.label,
            mutation.kind,
            mutation.expected_revision,
        )
    })
}

fn persist_host_endpoint_test(
    runtime: &HostRuntimeState,
    host_id: &str,
    selection_generation: u64,
    endpoint_id: &str,
    expected_revision: u64,
    probe: aludock_client_core::Result<()>,
) -> Result<EndpointTestResult, CommandError> {
    mutate_selected_host(runtime, host_id, selection_generation, |store| {
        record_endpoint_test(store, endpoint_id, expected_revision, probe)
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn verify_host_endpoint(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    expected_revision: u64,
    host: String,
    port: u16,
    label: String,
    kind: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let endpoint = Endpoint::new(host, port).map_err(CommandError::from)?;
    let kind = parse_connection_kind(&kind)?;
    probe_host_endpoint(&store, &endpoint)
        .await
        .map_err(CommandError::from)?;
    persist_verified_host_endpoint(
        &runtime,
        &host_id,
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    expected_revision: u64,
    host: String,
    port: u16,
    label: String,
    kind: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let endpoint = Endpoint::new(host, port).map_err(CommandError::from)?;
    save_unverified_endpoint(
        &store,
        endpoint,
        &label,
        parse_connection_kind(&kind)?,
        expected_revision,
    )
    .map_err(CommandError::from)
}

#[tauri::command]
async fn test_host_endpoint(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    expected_revision: u64,
    endpoint_id: String,
) -> Result<EndpointTestResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let endpoint = saved_endpoint_for_test(&store, &endpoint_id, expected_revision)
        .map_err(CommandError::from)?;
    let probe = probe_host_endpoint(&store, &endpoint).await;
    persist_host_endpoint_test(
        &runtime,
        &host_id,
        selection_generation,
        &endpoint_id,
        expected_revision,
        probe,
    )
}

#[tauri::command]
fn rename_host_profile(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    expected_revision: u64,
    display_name: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    store
        .update_connection_profile_at(expected_revision, |profile| {
            profile.display_name = display_name;
            Ok(())
        })
        .map_err(CommandError::from)
}

#[tauri::command]
fn set_connection_policy(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    expected_revision: u64,
    mode: String,
    endpoint_id: Option<String>,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let policy = match (mode.as_str(), endpoint_id) {
        ("automatic", _) => ConnectionPolicy::Automatic,
        ("fixed", Some(endpoint_id)) => ConnectionPolicy::Fixed { endpoint_id },
        _ => {
            return Err(ClientError::InvalidEndpoint("connection policy is invalid".into()).into());
        }
    };
    update_connection_policy(&store, policy, expected_revision).map_err(CommandError::from)
}

#[tauri::command]
fn set_host_endpoint_enabled(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    expected_revision: u64,
    endpoint_id: String,
    enabled: bool,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    set_endpoint_enabled(&store, &endpoint_id, enabled, expected_revision)
        .map_err(CommandError::from)
}

#[tauri::command]
fn reorder_host_endpoints(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    expected_revision: u64,
    endpoint_ids: Vec<String>,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    reorder_endpoints(&store, &endpoint_ids, expected_revision).map_err(CommandError::from)
}

#[tauri::command]
fn delete_host_endpoint(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    expected_revision: u64,
    endpoint_id: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    delete_endpoint(&store, &endpoint_id, expected_revision).map_err(CommandError::from)
}

#[tauri::command]
async fn list_workspace(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    path: String,
) -> Result<WorkspacePage, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    client
        .list_workspace(&path, None)
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
    host_id: &str,
    selection_generation: u64,
    host_epoch: &str,
    instance_id: &str,
    runtime_generation: u64,
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
                host_id: host_id.to_owned(),
                selection_generation,
                host_epoch: host_epoch.to_owned(),
                instance_id: instance_id.to_owned(),
                runtime_generation,
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    state: tauri::State<'_, SessionTokenState>,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    scope: String,
) -> Result<SafeSessionList, CommandError> {
    let request_id = begin_session_token_request(&state)?;
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    ensure_host_selection(&lifecycle, &host_id, selection_generation)?;
    publish_session_tokens(
        &state,
        request_id,
        &host_id,
        selection_generation,
        &expected_host_epoch,
        &instance_id,
        expected_runtime_generation,
        tokens,
    )?;
    drop(lifecycle);
    Ok(SafeSessionList {
        sessions,
        total: result.total,
        truncated: result.truncated,
        host_id,
        selection_generation,
        host_epoch: expected_host_epoch,
        runtime_generation: expected_runtime_generation,
    })
}

fn resolve_session_token(
    state: &SessionTokenState,
    host_id: &str,
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
    if binding.host_id != host_id
        || binding.selection_generation != selection_generation
        || binding.host_epoch != host_epoch
        || binding.instance_id != instance_id
        || binding.runtime_generation != runtime_generation
    {
        return Err(CommandError::from(ClientError::Protocol(
            "Session token belongs to a stale list result".into(),
        )));
    }
    Ok(binding.session_file.clone())
}

#[tauri::command]
async fn new_session(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
) -> Result<SessionReplacementResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
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
    let session_file = resolve_session_token(
        &state,
        &host_id,
        selection_generation,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        &session_token,
    )?;
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    name: String,
) -> Result<SessionNameResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    custom_instructions: Option<String>,
) -> Result<SessionCompactionResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
) -> Result<SafeSessionReload, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
) -> Result<SessionTree, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    target_id: String,
    summarize: bool,
    custom_instructions: Option<String>,
) -> Result<SessionNavigateResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    entry_id: String,
) -> Result<SessionForkResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    entry_id: String,
) -> Result<SessionReplacementResult, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
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
async fn create_work(
    runtime: tauri::State<'_, HostRuntimeState>,
    host_id: String,
    selection_generation: u64,
    cwd: String,
    name: Option<String>,
    operation_id: Option<String>,
    trust_challenge_id: Option<String>,
    project_trust_decision: Option<String>,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_host(&runtime, &host_id, selection_generation)?;
    let client = dock_client(&store)?;
    let continuation = parse_trust_continuation(
        trust_challenge_id.as_deref(),
        project_trust_decision.as_deref(),
        operation_id.clone(),
    )?;
    client
        .create_instance(&cwd, name.as_deref(), continuation, operation_id.as_deref())
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "windows")]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .manage(AwayMonitorState::default())
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::Focused(focused) = event
            {
                let monitor = window.state::<AwayMonitorState>();
                if *focused {
                    monitor.stop();
                    let _ = window.request_user_attention(None);
                } else {
                    let runtime = window.state::<HostRuntimeState>().inner().clone();
                    monitor.start(window.app_handle().clone(), runtime);
                }
            }
        });

    builder
        .setup(|app| {
            #[cfg(mobile)]
            let application_data_dir = Some(app.path().app_local_data_dir()?);
            #[cfg(not(mobile))]
            let application_data_dir = None;
            app.manage(HostRuntimeState::open(application_data_dir)?);
            Ok(())
        })
        .manage(FollowState::default())
        .manage(ExtensionControlState::default())
        .manage(PairingTaskState::default())
        .manage(SessionTokenState::default())
        .manage(AttachmentState::default())
        .manage(RestoredImageState::default())
        .invoke_handler(tauri::generate_handler![
            system_device_name,
            get_host_catalog,
            set_active_host,
            remove_local_host,
            start_pairing,
            resume_pairing,
            cancel_pairing,
            discard_pairing,
            bootstrap,
            work_catalog,
            conversation_bootstrap,
            conversation_history,
            conversation_image,
            published_image,
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
            get_connection_profile,
            verify_host_endpoint,
            save_unverified_host_endpoint,
            test_host_endpoint,
            rename_host_profile,
            set_connection_policy,
            set_host_endpoint_enabled,
            reorder_host_endpoints,
            delete_host_endpoint,
            list_workspace,
            list_sessions,
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
    fn work_finishing_during_the_first_away_minute_notifies_after_the_grace_period() {
        let mut tracker = AwayCompletionTracker::from_instances(&[AwayInstanceState {
            instance_id: "work-a".into(),
            display_name: "Windows 客户端".into(),
            execution: InstanceExecution::Running,
        }]);

        tracker.observe(&[AwayInstanceState {
            instance_id: "work-a".into(),
            display_name: "Windows 客户端".into(),
            execution: InstanceExecution::Idle,
        }]);

        assert!(tracker.take_ready(Duration::from_secs(59)).is_empty());
        assert_eq!(
            tracker.take_ready(Duration::from_secs(60)),
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

    fn endpoint_runtime(name: &str) -> (PathBuf, HostRuntimeState, String) {
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
        let runtime = HostRuntimeState {
            registry,
            lifecycle: Arc::new(Mutex::new(RuntimeLifecycle {
                active_host_id: Some(host_id.clone()),
                selection_generation: 1,
            })),
        };
        (path, runtime, host_id)
    }

    #[test]
    fn host_transition_increments_generation_even_for_offline_selection() {
        let mut lifecycle = RuntimeLifecycle {
            active_host_id: Some("a".repeat(64)),
            selection_generation: 4,
        };
        assert_eq!(lifecycle.transition_to(Some("b".repeat(64))).unwrap(), 5);
        assert_eq!(lifecycle.active_host_id, Some("b".repeat(64)));
        assert_eq!(lifecycle.transition_to(None).unwrap(), 6);
        assert_eq!(lifecycle.active_host_id, None);
    }

    #[test]
    fn stale_selection_is_rejected_before_long_lived_registration() {
        let mut lifecycle = RuntimeLifecycle {
            active_host_id: Some("a".repeat(64)),
            selection_generation: 9,
        };
        assert!(ensure_host_selection(&lifecycle, &"a".repeat(64), 9).is_ok());
        lifecycle.transition_to(Some("b".repeat(64))).unwrap();
        assert!(ensure_host_selection(&lifecycle, &"a".repeat(64), 9).is_err());
        assert!(ensure_host_selection(&lifecycle, &"b".repeat(64), 9).is_err());
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
            active_host_id: Some(host_id.clone()),
            selection_generation: 7,
        });
        lifecycle
            .lock()
            .unwrap()
            .transition_to(Some("b".repeat(64)))
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
                host_id: host_id.clone(),
                selection_generation: 7,
                work_id: "work".into(),
                operation_id: "native-operation".into(),
                name: "stale.png".into(),
                size_bytes: 1,
                media_type: Some("image/png".into()),
                active_attempt: None,
            },
        )];

        let error = publish_selected_attachments(&lifecycle, &state, &host_id, 7, "work", prepared)
            .unwrap_err();
        assert_eq!(error.code, "stale_host_selection");
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
            .transition_to(None)
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
            .transition_to(None)
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
            host_id: "host-a".into(),
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
    fn pairing_task_slot_rejects_duplicate_and_cancel_blocks_promotion() {
        let transaction_id = "transaction".to_owned();
        let state = PairingTaskState::default();
        let first_token = Arc::new(AtomicBool::new(false));
        let first = PairingTask {
            handle: tauri::async_runtime::spawn(std::future::pending()),
            cancelled: first_token.clone(),
        };
        state
            .tasks
            .lock()
            .unwrap()
            .insert(transaction_id.clone(), first);

        let duplicate = PairingTask {
            handle: tauri::async_runtime::spawn(std::future::pending()),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let mut tasks = state.tasks.lock().unwrap();
        if tasks.contains_key(&transaction_id) {
            duplicate.handle.abort();
        } else {
            tasks.insert(transaction_id.clone(), duplicate);
        }
        assert!(pairing_task_matches(
            tasks.get(&transaction_id).unwrap(),
            &first_token
        ));

        let cancelled = tasks.remove(&transaction_id).unwrap();
        cancelled.cancelled.store(true, Ordering::Release);
        cancelled.handle.abort();
        assert!(!pairing_task_matches(&cancelled, &first_token));
        assert!(!tasks.contains_key(&transaction_id));
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
            host_id: "host-a".into(),
            selection_generation: 7,
            work_id: "work-a".into(),
            operation_id: "native-operation".into(),
            name: "secret.txt".into(),
            size_bytes: 12,
            media_type: Some("text/plain".into()),
            active_attempt: None,
        };
        assert!(attachment_scope_matches(&entry, "host-a", 7, "work-a"));
        assert!(!attachment_scope_matches(&entry, "host-b", 7, "work-a"));
        assert!(!attachment_scope_matches(&entry, "host-a", 8, "work-a"));
        assert!(!attachment_scope_matches(&entry, "host-a", 7, "work-b"));

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
    fn canonical_host_validation_happens_before_runtime_resolution() {
        assert!(validate_host_id("../host").is_err());
        assert!(validate_host_id(&"A".repeat(64)).is_err());
        assert!(validate_host_id(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn older_session_list_completion_does_not_invalidate_newer_tokens() {
        let state = SessionTokenState::default();
        let older = begin_session_token_request(&state).unwrap();
        let newer = begin_session_token_request(&state).unwrap();
        publish_session_tokens(
            &state,
            newer,
            "host-a",
            7,
            "epoch",
            "work",
            2,
            HashMap::from([("new-token".into(), "C:\\sessions\\new.jsonl".into())]),
        )
        .unwrap();
        publish_session_tokens(
            &state,
            older,
            "host-a",
            7,
            "epoch",
            "work",
            2,
            HashMap::from([("old-token".into(), "/sessions/old.jsonl".into())]),
        )
        .unwrap();
        assert_eq!(
            resolve_session_token(&state, "host-a", 7, "work", "epoch", 2, "new-token").unwrap(),
            "C:\\sessions\\new.jsonl"
        );
        assert!(
            resolve_session_token(&state, "host-b", 7, "work", "epoch", 2, "new-token").is_err()
        );
        assert!(
            resolve_session_token(&state, "host-a", 8, "work", "epoch", 2, "new-token").is_err()
        );
    }
}
