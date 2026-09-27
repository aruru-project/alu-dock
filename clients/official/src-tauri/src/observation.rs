use crate::connection_state::{
    ConnectionRuntimeState, dock_client, ensure_connection_selection, observation_key,
    resolve_connection_store,
};
use crate::errors::{CommandError, lifecycle_error};
use aludock_client_core::{ClientError, project_session_snapshot, project_session_update};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

#[derive(Clone, Default)]
pub(crate) struct FollowState {
    pub(crate) observation: aludock_client_core::ConversationObservation,
    pub(crate) task: Arc<Mutex<Option<FollowTask>>>,
}

pub(crate) struct FollowTask {
    pub(crate) delivery: Arc<AtomicU64>,
    pub(crate) acknowledge: tokio::sync::watch::Sender<u64>,
    pub(crate) content_key: String,
    pub(crate) host_epoch: String,
    pub(crate) handle: tauri::async_runtime::JoinHandle<()>,
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) instance_id: String,
    pub(crate) subscription_id: String,
}

impl FollowState {
    pub(crate) fn abort_matching(
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
            self.observation.pause(&task.content_key);
        }
        Ok(true)
    }
}

#[tauri::command]
pub(crate) async fn read_conversation_content(
    state: tauri::State<'_, FollowState>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    token: String,
    intent: String,
    entry_ids: Vec<String>,
) -> Result<(), CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let content = &state.observation.content;
    match intent.as_str() {
        "earlier" => content
            .load_earlier(&key, &token, &client)
            .await
            .map_err(CommandError::from),
        "retry" => content
            .retry_content(&key, &token, &client, entry_ids)
            .await
            .map_err(CommandError::from),
        "interest" => {
            content.set_read_interest(&key, &token, client, entry_ids, false);
            Ok(())
        }
        _ => Err(CommandError::from(ClientError::Protocol(
            "unknown local content intent".into(),
        ))),
    }
}

pub(crate) fn follow_state_error() -> CommandError {
    CommandError {
        code: "follow_state_unavailable".into(),
        message: "实时连接状态暂时不可用".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

#[tauri::command]
pub(crate) fn stop_conversation_follow(
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
pub(crate) async fn start_conversation_follow(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    app: tauri::AppHandle,
    state: tauri::State<'_, FollowState>,
    instance_id: String,
    subscription_id: String,
    host_epoch: String,
    refresh: bool,
) -> Result<(), CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let key = observation_key(&runtime, &connection_id, &instance_id, &host_epoch)?;
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, &connection_id, selection_generation)?;
    let mut guard = state.task.lock().map_err(|_| follow_state_error())?;
    if let Some(task) = guard.take() {
        task.handle.abort();
    }
    let observation = state.observation.clone();
    let mut binding = match observation.bind(
        key.clone(),
        client,
        instance_id.clone(),
        host_epoch.clone(),
        refresh,
    ) {
        Ok(binding) => binding,
        Err(error) => {
            let state = "disconnected";
            let _ = app.emit("aludock://observation", serde_json::json!({"connectionId": connection_id,
                "selectionGeneration": selection_generation, "instanceId": instance_id, "subscriptionId": subscription_id,
                "revision": 0, "update": {"kind":"binding_error", "state":state, "message":"对话暂时无法恢复，请重试。"}}));
            return Err(CommandError::from(error));
        }
    };
    let followed_host = connection_id.clone();
    let followed_instance = instance_id.clone();
    let followed_subscription = subscription_id.clone();
    let content_key = key.clone();
    let (acknowledge, mut acknowledged) = tokio::sync::watch::channel(0u64);
    let delivery = Arc::new(AtomicU64::new(0));
    let issued_delivery = delivery.clone();
    let task = tauri::async_runtime::spawn(async move {
        let emit = |delivery: u64, revision: u64, update: Result<Value, ClientError>| {
            issued_delivery.store(delivery, Ordering::Release);
            let valid = update.is_ok();
            let update = update.unwrap_or_else(|error| serde_json::json!({"kind":"binding_error", "state":"content_error", "message":CommandError::from(error).message}));
            let _ = app.emit(
                "aludock://observation",
                serde_json::json!({
                    "connectionId": followed_host, "selectionGeneration": selection_generation,
                    "instanceId": followed_instance, "subscriptionId": followed_subscription,
                    "revision": revision, "deliveryId": delivery, "update": update,
                }),
            );
            valid
        };
        let mut delivery = 1;
        let mut replay_failed = !emit(
            delivery,
            binding.snapshot.revision,
            project_session_snapshot(binding.snapshot.clone(), false),
        );
        let mut priority_in_flight = false;
        loop {
            if replay_failed {
                // A bad local body stream remains visibly failed, but cannot
                // hide a later authoritative /new behind that broken stream.
                // Wait for an actual replacement, never retry/rebind the same tail.
                if !binding.replacement_changed().await {
                    return;
                }
                if let Some(snapshot) = binding.take_replacement() {
                    delivery += 1;
                    priority_in_flight = true;
                    replay_failed = !emit(
                        delivery,
                        snapshot.revision,
                        project_session_snapshot(snapshot, true),
                    );
                }
                continue;
            }
            // One data batch in flight. A new Session/branch may preempt that
            // obsolete batch with one priority checkpoint; further replacements
            // coalesce until its ACK. Ordinary lag never restarts replay.
            while *acknowledged.borrow_and_update() < delivery {
                if priority_in_flight {
                    if acknowledged.changed().await.is_err() {
                        return;
                    }
                } else {
                    tokio::select! {
                        result = acknowledged.changed() => { if result.is_err() { return; } }
                        ready = binding.replacement_changed() => {
                            if !ready { return; }
                            if let Some(snapshot) = binding.take_replacement() {
                                delivery += 1; priority_in_flight = true;
                                if !emit(delivery, snapshot.revision, project_session_snapshot(snapshot, true)) { return; }
                            }
                        }
                    }
                }
            }
            priority_in_flight = false;
            if let Some(snapshot) = binding.take_replacement() {
                delivery += 1;
                priority_in_flight = true;
                if !emit(
                    delivery,
                    snapshot.revision,
                    project_session_snapshot(snapshot, true),
                ) {
                    return;
                }
                continue;
            }
            let replay = binding.next_batch().await;
            // A replacement can arrive while this one bounded batch is being
            // read. It supersedes both obsolete data and an obsolete read error.
            if let Some(snapshot) = binding.take_replacement() {
                delivery += 1;
                priority_in_flight = true;
                replay_failed = !emit(
                    delivery,
                    snapshot.revision,
                    project_session_snapshot(snapshot, true),
                );
                continue;
            }
            match replay {
                Ok(commits) if commits.is_empty() => break,
                Ok(commits) => {
                    let revision = commits.last().unwrap().revision;
                    let updates = commits.into_iter().map(|commit| {
                        Ok(serde_json::json!({"revision":commit.revision,"update":project_session_update(commit.update)?}))
                    }).collect::<Result<Vec<Value>, ClientError>>();
                    delivery += 1;
                    replay_failed = !emit(
                        delivery,
                        revision,
                        updates
                            .map(|updates| serde_json::json!({"kind":"batch","updates":updates})),
                    );
                }
                Err(_) => {
                    let state = "content_error";
                    // Display-binding failure is separate from accepted content
                    // revision: never invent a revision that could hide a commit.
                    let _ = app.emit("aludock://observation", serde_json::json!({"connectionId":followed_host,
                        "selectionGeneration":selection_generation,"instanceId":followed_instance,"subscriptionId":followed_subscription,
                        "revision":0,"update":{"kind":"binding_error","state":state,"message":"对话暂时无法显示，请重新打开这项工作。"}}));
                    replay_failed = true;
                }
            }
        }
    });
    *guard = Some(FollowTask {
        delivery,
        acknowledge,
        content_key,
        host_epoch,
        handle: task,
        connection_id,
        selection_generation,
        instance_id,
        subscription_id,
    });
    drop(lifecycle);
    Ok(())
}

#[tauri::command]
pub(crate) fn acknowledge_conversation_follow(
    state: tauri::State<'_, FollowState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    subscription_id: String,
    delivery_id: u64,
) -> Result<(), CommandError> {
    let guard = state.task.lock().map_err(|_| follow_state_error())?;
    if let Some(task) = guard.as_ref().filter(|task| {
        task.connection_id == connection_id
            && task.selection_generation == selection_generation
            && task.instance_id == instance_id
            && task.subscription_id == subscription_id
            && task.delivery.load(Ordering::Acquire) == delivery_id
    }) {
        task.acknowledge.send_if_modified(|accepted| {
            if delivery_id > *accepted {
                *accepted = delivery_id;
                true
            } else {
                false
            }
        });
    }
    Ok(())
}
