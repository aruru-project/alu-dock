use crate::connection_state::ConnectionRuntimeState;
#[cfg(target_os = "windows")]
use crate::connection_state::dock_client;
#[cfg(target_os = "windows")]
use crate::connection_state::ensure_connection_selection;
#[cfg(target_os = "windows")]
use crate::connection_state::resolve_connection_store;
use crate::errors::CommandError;
#[cfg(target_os = "windows")]
use crate::errors::lifecycle_error;
use aludock_client_core::ClientPreferences;
#[cfg(any(target_os = "windows", test))]
use aludock_client_core::InstanceExecution;
#[cfg(target_os = "windows")]
use aludock_client_core::InstanceSelector;
use aludock_client_core::WindowsAwayDelay;
use serde::Serialize;
#[cfg(any(target_os = "windows", test))]
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(any(target_os = "windows", test))]
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::time::Instant;
#[cfg(target_os = "windows")]
use tauri::Emitter;
#[cfg(target_os = "windows")]
use tauri::Manager;
#[cfg(target_os = "windows")]
use tauri_plugin_notification::NotificationExt;
#[cfg(target_os = "windows")]
pub(crate) const AWAY_POLL_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeClientPreferences {
    pub(crate) revision: u64,
    pub(crate) windows_away_delay: WindowsAwayDelay,
    pub(crate) windows_away_supported: bool,
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
pub(crate) struct AwayCatalogContext {
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) host_epoch: String,
}

#[cfg(target_os = "windows")]
pub(crate) struct AwayCatalogSnapshot {
    pub(crate) context: AwayCatalogContext,
    pub(crate) instances: Vec<AwayInstanceState>,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AwayInstanceState {
    pub(crate) instance_id: String,
    pub(crate) display_name: String,
    pub(crate) execution: InstanceExecution,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AwayCompletion {
    pub(crate) instance_id: String,
    pub(crate) display_name: String,
}

#[cfg(any(target_os = "windows", test))]
pub(crate) struct AwayCompletionTracker {
    pub(crate) executions: HashMap<String, InstanceExecution>,
    pub(crate) pending: HashMap<String, String>,
}

#[cfg(any(target_os = "windows", test))]
impl AwayCompletionTracker {
    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn from_instances(instances: &[AwayInstanceState]) -> Self {
        Self {
            executions: instances
                .iter()
                .map(|instance| (instance.instance_id.clone(), instance.execution))
                .collect(),
            pending: HashMap::new(),
        }
    }

    pub(crate) fn from_running_instance_ids(instance_ids: &[String]) -> Self {
        Self {
            executions: instance_ids
                .iter()
                .map(|instance_id| (instance_id.clone(), InstanceExecution::Running))
                .collect(),
            pending: HashMap::new(),
        }
    }

    pub(crate) fn observe(&mut self, instances: &[AwayInstanceState]) {
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

    pub(crate) fn take_ready(
        &mut self,
        away_for: Duration,
        grace: Duration,
    ) -> Vec<AwayCompletion> {
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
pub(crate) struct AwayMonitorState {
    pub(crate) task: Arc<Mutex<Option<AwayMonitorTask>>>,
}

pub(crate) struct AwayMonitorTask {
    pub(crate) away_id: String,
    pub(crate) monitor_handle: tauri::async_runtime::JoinHandle<()>,
    pub(crate) grace_handle: tauri::async_runtime::JoinHandle<()>,
    pub(crate) cancelled: Arc<AtomicBool>,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsAwayElapsed {
    pub(crate) away_id: String,
}

impl AwayMonitorTask {
    pub(crate) fn cancel(self) {
        self.cancelled.store(true, Ordering::Release);
        self.monitor_handle.abort();
        self.grace_handle.abort();
    }
}

impl AwayMonitorState {
    #[cfg(target_os = "windows")]
    pub(crate) fn start(
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

    pub(crate) fn stop(&self, away_id: Option<&str>) -> Result<bool, CommandError> {
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

pub(crate) fn away_monitor_error() -> CommandError {
    CommandError {
        code: "away_monitor_unavailable".into(),
        message: "暂离状态暂时无法更新，请重新打开应用。".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

#[cfg(target_os = "windows")]
pub(crate) async fn read_away_catalog(
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
pub(crate) async fn monitor_while_away(
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
pub(crate) fn show_away_completions(app: &tauri::AppHandle, completions: Vec<AwayCompletion>) {
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

#[tauri::command]
pub(crate) fn get_client_preferences(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
) -> Result<SafeClientPreferences, CommandError> {
    runtime
        .preferences
        .snapshot()
        .map(SafeClientPreferences::from)
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) fn update_client_preferences(
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
pub(crate) fn begin_windows_away(
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
pub(crate) fn cancel_windows_away(
    monitor: tauri::State<'_, AwayMonitorState>,
    away_id: Option<String>,
) -> Result<bool, CommandError> {
    monitor.stop(away_id.as_deref())
}
