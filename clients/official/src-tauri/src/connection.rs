use crate::connection_state::{
    ConnectionRuntimeState, ConnectionTarget, LOCAL_CONNECTION_SCOPE_ID, connection_profile,
    dock_client, mutate_selected_host, reconcile_selected_client, resolve_connection_store,
};
use crate::errors::{CommandError, lifecycle_error};
use crate::extension::ControllerStatusEmission;
use crate::observation::{FollowState, follow_state_error};
use aludock_client_core::{
    AttachmentState, ClientError, ConnectionRouter, DockClient, Endpoint, EndpointTestResult,
    ExtensionControlState, HostConnectionProfile, HostRegistrySnapshot, InstanceCatalog,
    InstanceSelector, InstanceSnapshot, LocalDockEndpoint, MAX_ATTACHMENTS_PER_MESSAGE,
    PairingProgress, RestoredImageState, SessionTokenState, delete_endpoint, probe_host_endpoint,
    record_endpoint_test, save_unverified_endpoint, save_verified_endpoint,
    saved_endpoint_for_test, set_endpoint_enabled, validate_device_name,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapPayload {
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) max_attachments_per_message: usize,
    pub(crate) host: HostSummary,
    pub(crate) works: Vec<InstanceSnapshot>,
    pub(crate) total: u64,
    pub(crate) hidden_stopped: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkCatalogPayload {
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) host_epoch: String,
    pub(crate) instances: Vec<InstanceSnapshot>,
    pub(crate) total: u64,
    pub(crate) hidden_stopped: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostCatalogEntry {
    pub(crate) host_id: String,
    pub(crate) display_name: String,
    pub(crate) device_name: String,
    pub(crate) endpoint_summary: String,
    pub(crate) added_at: String,
    pub(crate) profile: HostConnectionProfile,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostCatalog {
    pub(crate) schema_version: u32,
    pub(crate) revision: u64,
    pub(crate) active_target: Option<ConnectionTarget>,
    pub(crate) local_endpoint_override: Option<String>,
    pub(crate) local_endpoint_effective: Option<String>,
    pub(crate) selection_generation: u64,
    pub(crate) local_connection_supported: bool,
    pub(crate) hosts: Vec<HostCatalogEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSummary {
    pub(crate) state: String,
    pub(crate) host_epoch: String,
    pub(crate) dock_version: String,
    pub(crate) pi_sdk_version: String,
    pub(crate) started_at: String,
    pub(crate) profile: Option<HostConnectionProfile>,
    pub(crate) active_endpoint_id: String,
}

#[derive(Clone, Default)]
pub(crate) struct PairingTaskState {
    pub(crate) tasks: Arc<Mutex<HashMap<String, PairingTask>>>,
}

impl PairingTaskState {
    /// Page reload/destruction ends the visible authorization. The same task
    /// lock guards final saving, so an ended attempt cannot save afterwards.
    pub(crate) fn cancel_all(&self) {
        let mut tasks = self
            .tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, task) in tasks.drain() {
            task.cancelled.store(true, Ordering::Release);
            task.handle.abort();
        }
    }
}

pub(crate) struct PairingTask {
    pub(crate) handle: tauri::async_runtime::JoinHandle<()>,
    pub(crate) cancelled: Arc<AtomicBool>,
}

pub(crate) fn pairing_task_matches(entry: &PairingTask, token: &Arc<AtomicBool>) -> bool {
    Arc::ptr_eq(&entry.cancelled, token) && !entry.cancelled.load(Ordering::Acquire)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingEmission {
    pub(crate) request_id: String,
    pub(crate) stage: String,
    pub(crate) pin: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) error: Option<CommandError>,
    pub(crate) host_id: Option<String>,
    pub(crate) registry_revision: Option<u64>,
    pub(crate) selection_generation: Option<u64>,
}

pub(crate) fn catalog_from_snapshot(
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
            .ordered_verified_endpoints()
            .first()
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
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn invalidate_connection_lifecycle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    runtime: &ConnectionRuntimeState,
    follow: &FollowState,
    extension: &ExtensionControlState,
    sessions: &SessionTokenState,
    _attachments: &AttachmentState,
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
        follow.observation.pause(&task.content_key);
        task.handle.abort();
    }
    if let Some(binding) = extension.clear() {
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
    sessions.clear();
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
pub(crate) fn system_device_name() -> Option<String> {
    let name = hostname::get().ok()?.into_string().ok()?;
    let name = name.trim().to_owned();
    if name.eq_ignore_ascii_case("localhost") || name.eq_ignore_ascii_case("localhost.localdomain")
    {
        return None;
    }
    validate_device_name(&name).ok().map(|_| name)
}

pub(crate) fn local_connection_client(
    runtime: &ConnectionRuntimeState,
) -> Result<DockClient, CommandError> {
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

pub(crate) async fn verify_local_connection(client: &DockClient) -> Result<(), CommandError> {
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
pub(crate) fn get_host_catalog(
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
pub(crate) async fn connect_local_dock(
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
pub(crate) fn set_local_endpoint(
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
pub(crate) fn set_active_host(
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
pub(crate) fn remove_saved_host(
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
    attachments.revoke_connection(&host_id);
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

// Registration must complete in synchronous IPC dispatch before a later page
// load-start can cancel it. Only authentication runs in the spawned future.
#[tauri::command]
pub(crate) fn start_pairing<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, PairingTaskState>,
    request_id: String,
    host: String,
    port: u16,
    device_name: String,
) -> Result<(), CommandError> {
    let endpoint = Endpoint::new(host, port).map_err(CommandError::from)?;
    validate_device_name(&device_name).map_err(CommandError::from)?;
    uuid::Uuid::parse_str(&request_id).map_err(|_| lifecycle_error())?;
    let mut tasks = state.tasks.lock().map_err(|_| lifecycle_error())?;
    if tasks.contains_key(&request_id) {
        return Err(lifecycle_error());
    }
    let task_request = request_id.clone();
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
                    request_id: task_request.clone(),
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
        let outcome = registry
            .verify_pairing(endpoint, &device_name, report_progress)
            .await;

        match outcome {
            Ok(verified) => {
                // The task slot serializes cancellation with saving. Whichever acquires it
                // first wins, so cancellation can never be followed by a save.
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
                    .get(&task_request)
                    .is_some_and(|entry| pairing_task_matches(entry, &task_cancelled));
                if !still_current {
                    return;
                }
                let mut lifecycle = match runtime_state.lifecycle.lock() {
                    Ok(lifecycle) => lifecycle,
                    Err(_) => {
                        task_guard.remove(&task_request);
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
                let host_id = verified.host_id();
                let promoted = registry.save_pairing(verified);
                let registry_revision = match promoted.map_err(CommandError::from) {
                    Ok(revision) => revision,
                    Err(error) => {
                        task_guard.remove(&task_request);
                        emit("failed", None, None, Some(error), None, None, None);
                        return;
                    }
                };
                let generation = match lifecycle.transition_to_host(Some(host_id.clone())) {
                    Ok(generation) => generation,
                    Err(error) => {
                        task_guard.remove(&task_request);
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
                    Some(host_id.clone()),
                    old_generation,
                    generation,
                );
                emit(
                    "completed",
                    None,
                    Some("配对完成".into()),
                    None,
                    Some(host_id),
                    Some(registry_revision),
                    Some(generation),
                );
                task_guard.remove(&task_request);
            }
            Err(error) => {
                // Authentication has no local pending state. A dropped network
                // reply ends this attempt; it is not a local-storage recovery.
                let connection_failed = matches!(
                    &error,
                    ClientError::Io(_) | ClientError::Tls(_) | ClientError::Protocol(_)
                );
                let mut error = CommandError::from(error);
                if connection_failed {
                    error.code = "pairing_invalid".into();
                    error.message =
                        "配对没有完成。请确认电脑端配对窗口和网络，然后重新开始。".into();
                }
                let should_emit = task_state.tasks.lock().ok().is_some_and(|mut tasks| {
                    let current = tasks
                        .get(&task_request)
                        .is_some_and(|entry| pairing_task_matches(entry, &task_cancelled));
                    if current {
                        tasks.remove(&task_request);
                    }
                    current
                });
                if should_emit {
                    emit("failed", None, None, Some(error), None, None, None);
                }
            }
        }
    });
    tasks.insert(
        request_id.clone(),
        PairingTask {
            handle: task,
            cancelled,
        },
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, PairingTaskState>,
    request_id: String,
) -> Result<bool, CommandError> {
    if let Some(task) = state
        .tasks
        .lock()
        .map_err(|_| lifecycle_error())?
        .remove(&request_id)
    {
        task.cancelled.store(true, Ordering::Release);
        task.handle.abort();
        let _ = app.emit(
            "aludock://pairing-status",
            PairingEmission {
                request_id,
                stage: "cancelled".into(),
                pin: None,
                message: Some(
                    "配对已取消；需要连接时请重新开始。电脑上已授予的权限可在设备管理中移除。"
                        .into(),
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

// Route changes restart native observation tasks; dispatch inside Tauri's async
// runtime, not directly on the WebView IPC thread (Android otherwise aborts).
#[tauri::command]
pub(crate) async fn reselect_host_route(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    connection_id: String,
    selection_generation: u64,
) -> Result<bool, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let changed = client
        .router()
        .reselect_preferred_route()
        .map_err(CommandError::from)?;
    if let Some(task) = follow
        .task
        .lock()
        .map_err(|_| follow_state_error())?
        .as_ref()
    {
        if task.connection_id == connection_id && task.selection_generation == selection_generation
        {
            follow.observation.pause(&task.content_key);
            follow
                .observation
                .bind(
                    task.content_key.clone(),
                    client,
                    task.instance_id.clone(),
                    task.host_epoch.clone(),
                    false,
                )
                .map_err(CommandError::from)?;
        }
    }
    Ok(changed)
}

/// One settings-page look at which saved address the selected Host is using.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostRoutePayload {
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) route_generation: u64,
    pub(crate) active_endpoint_id: Option<String>,
}

/// An unchanged route is answered after this long, so a watch left behind by a
/// closed settings page ends on its own.
const HOST_ROUTE_WATCH_WAIT: std::time::Duration = std::time::Duration::from_secs(25);

/// Answers at once without `seen_route_generation`; otherwise when the route
/// differs from it, or unchanged after `HOST_ROUTE_WATCH_WAIT`.
#[tauri::command]
pub(crate) async fn watch_host_route(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    seen_route_generation: Option<u64>,
) -> Result<HostRoutePayload, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let router = client.router();
    let route = match seen_route_generation {
        None => router.snapshot(),
        Some(seen) => {
            match tokio::time::timeout(HOST_ROUTE_WATCH_WAIT, router.route_change(seen)).await {
                Ok(route) => route.map_err(CommandError::from)?,
                Err(_) => router.snapshot(),
            }
        }
    };
    Ok(HostRoutePayload {
        connection_id,
        selection_generation,
        route_generation: route.route_generation,
        active_endpoint_id: route.active_endpoint_id,
    })
}

#[tauri::command]
pub(crate) async fn bootstrap(
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
    let info = client.host_info().await.map_err(CommandError::from)?;
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
pub(crate) async fn work_catalog(
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

pub(crate) struct VerifiedEndpointMutation {
    pub(crate) endpoint: Endpoint,
    pub(crate) label: String,
    pub(crate) expected_revision: u64,
}

pub(crate) fn persist_verified_host_endpoint(
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
            mutation.expected_revision,
        )
    })?;
    reconcile_selected_client(runtime, connection_id, selection_generation, &profile)?;
    Ok(profile)
}

pub(crate) fn persist_host_endpoint_test(
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
pub(crate) async fn verify_host_endpoint(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    host: String,
    port: u16,
    label: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let endpoint = Endpoint::new(host, port).map_err(CommandError::from)?;
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
            expected_revision,
        },
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn save_unverified_host_endpoint(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    expected_revision: u64,
    host: String,
    port: u16,
    label: String,
) -> Result<HostConnectionProfile, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let endpoint = Endpoint::new(host, port).map_err(CommandError::from)?;
    let profile = save_unverified_endpoint(&store, endpoint, &label, expected_revision)
        .map_err(CommandError::from)?;
    reconcile_selected_client(&runtime, &connection_id, selection_generation, &profile)?;
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn test_host_endpoint(
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
pub(crate) fn rename_host_profile(
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
pub(crate) fn set_host_endpoint_enabled(
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
pub(crate) fn delete_host_endpoint(
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
