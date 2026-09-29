use crate::connection_state::{
    ConnectionRuntimeState, dock_client, ensure_connection_selection, observation_key,
    resolve_connection_store,
};
use crate::errors::{CommandError, lifecycle_error};
use crate::observation::FollowState;
use aludock_client_core::{
    ClientError, NavigateOptions, ProjectTrustDecision, SafeSessionReload, SessionCompactionResult,
    SessionForkResult, SessionInfo, SessionInventoryResult, SessionNameResult,
    SessionNavigateResult, SessionReplacementResult, SessionScope, SessionTokenScope,
    SessionTokenState, SessionTree, begin_session_token_request, operation_association,
    project_session_reload, publish_session_tokens, resolve_work_session_token,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

/// One row of the saved-session list shared by Resume and "new Work from a saved Session".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeSavedSession {
    pub(crate) token: String,
    pub(crate) name: Option<String>,
    pub(crate) first_user_message: Option<String>,
    pub(crate) cwd: String,
    pub(crate) last_activity_at: Option<String>,
    pub(crate) cost_total: Option<f64>,
    pub(crate) current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeSavedSessionPage {
    pub(crate) sessions: Vec<SafeSavedSession>,
    pub(crate) total: u64,
    pub(crate) incomplete: bool,
    pub(crate) next_cursor: Option<String>,
    pub(crate) machine_host_id: Option<String>,
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) host_epoch: String,
}

/// Replaces private session paths with list-scoped tokens for the WebView.
fn saved_session_rows(
    sessions: Vec<SessionInfo>,
    current_session_id: Option<&str>,
) -> (Vec<SafeSavedSession>, HashMap<String, String>) {
    let mut tokens = HashMap::new();
    let rows = sessions
        .into_iter()
        .map(|session| {
            let token = uuid::Uuid::new_v4().to_string();
            let current = current_session_id == Some(session.session_id.as_str());
            tokens.insert(token.clone(), session.session_file);
            SafeSavedSession {
                token,
                name: session.name,
                first_user_message: session.first_user_message,
                cwd: session.cwd,
                last_activity_at: session.last_activity_at.or(session.updated_at),
                cost_total: session.cost_total,
                current,
            }
        })
        .collect();
    (rows, tokens)
}

fn saved_session_page(
    result: SessionInventoryResult,
    sessions: Vec<SafeSavedSession>,
    machine_host_id: Option<String>,
    connection_id: String,
    selection_generation: u64,
) -> SafeSavedSessionPage {
    SafeSavedSessionPage {
        sessions,
        total: result.total,
        incomplete: result.incomplete,
        next_cursor: result.next_cursor,
        machine_host_id,
        connection_id,
        selection_generation,
        host_epoch: result.host_epoch,
    }
}

/// Resume: saved sessions in the Work's own directory on the Work's machine.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn list_sessions(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, SessionTokenState>,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    machine_host_id: Option<String>,
    cwd: String,
    cursor: Option<String>,
) -> Result<SafeSavedSessionPage, CommandError> {
    let request_id = begin_session_token_request(&state)?;
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let current = content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)?;
    let mut result = client
        .session_inventory(
            &cwd,
            SessionScope::Cwd,
            machine_host_id.as_deref(),
            cursor.as_deref(),
        )
        .await
        .map_err(CommandError::from)?;
    if result.host_epoch != expected_host_epoch {
        return Err(CommandError::from(ClientError::Protocol(
            "stale Session list was discarded".into(),
        )));
    }
    let (sessions, tokens) = saved_session_rows(
        std::mem::take(&mut result.sessions),
        current
            .as_ref()
            .map(|current| current.executor.pi_session_id.as_str()),
    );
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
    Ok(saved_session_page(
        result,
        sessions,
        machine_host_id,
        connection_id,
        selection_generation,
    ))
}

/// New Work: every saved session on the selected machine.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn session_inventory(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, SessionTokenState>,
    machine_host_id: String,
    cwd: String,
    cursor: Option<String>,
) -> Result<SafeSavedSessionPage, CommandError> {
    let request_id = begin_session_token_request(&state)?;
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let mut result = client
        .session_inventory(
            &cwd,
            SessionScope::All,
            Some(&machine_host_id),
            cursor.as_deref(),
        )
        .await
        .map_err(CommandError::from)?;
    let (sessions, tokens) = saved_session_rows(std::mem::take(&mut result.sessions), None);
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
    Ok(saved_session_page(
        result,
        sessions,
        Some(machine_host_id),
        connection_id,
        selection_generation,
    ))
}

#[tauri::command]
pub(crate) async fn new_session(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
) -> Result<SessionReplacementResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let association = operation_association(
        &operation_id,
        "new_session",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    let observation = follow.observation.clone();
    let content = content.inner().clone();
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            let result = client
                .new_session(&instance_id, None, Some(&operation_id))
                .await
                .map_err(CommandError::from)?;
            observation.accept_session_result(&target_key, client.clone(), &result);
            Ok(result)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn switch_session(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
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
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let association = operation_association(
        &operation_id,
        "switch_session",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    let observation = follow.observation.clone();
    let content = content.inner().clone();
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            let continuation = parse_trust_continuation(
                trust_challenge_id.as_deref(),
                project_trust_decision.as_deref(),
                Some(operation_id.clone()),
            )?;
            let result = client
                .switch_session(&instance_id, &session_file, continuation, &operation_id)
                .await
                .map_err(CommandError::from)?;
            observation.accept_session_result(&target_key, client.clone(), &result);
            Ok(result)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn name_session(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    name: String,
) -> Result<SessionNameResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let association = operation_association(
        &operation_id,
        "name_session",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    let content = content.inner().clone();
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            let result = client
                .name_session(&instance_id, &name, Some(&operation_id))
                .await
                .map_err(CommandError::from)?;
            Ok(result)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn compaction_prompts(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
) -> Result<aludock_client_core::CompactionPromptTemplatesResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)?;
    client
        .compaction_prompts(&instance_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn compact_session(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    custom_instructions: Option<String>,
) -> Result<SessionCompactionResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let association = operation_association(
        &operation_id,
        "compact_session",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    let content = content.inner().clone();
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            let result = client
                .compact_session(
                    &instance_id,
                    custom_instructions.as_deref(),
                    Some(&operation_id),
                )
                .await
                .map_err(CommandError::from)?;
            Ok(result)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn reload_session(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
) -> Result<SafeSessionReload, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let association = operation_association(
        &operation_id,
        "reload_session",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    let observation = follow.observation.clone();
    let content = content.inner().clone();
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            let result = client
                .reload_session(&instance_id, Some(&operation_id))
                .await
                .map_err(CommandError::from)?;
            observation.accept_session_result(&target_key, client.clone(), &result);
            Ok(project_session_reload(result))
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn session_tree(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
) -> Result<SessionTree, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let (tree, host_epoch) = client
        .session_tree(&instance_id)
        .await
        .map_err(CommandError::from)?;
    if host_epoch != expected_host_epoch {
        return Err(CommandError::from(ClientError::Protocol(
            "stale Session Tree was discarded".into(),
        )));
    }
    content
        .check_target(
            &target_key,
            &expected_host_epoch,
            expected_runtime_generation,
        )
        .map_err(CommandError::from)?;
    Ok(tree)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn navigate_session(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
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
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let association = operation_association(
        &operation_id,
        "navigate_session",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    let observation = follow.observation.clone();
    let content = content.inner().clone();
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
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
            observation.accept_session_result(&target_key, client.clone(), &result);
            Ok(result)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fork_session(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    entry_id: String,
) -> Result<SessionForkResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let association = operation_association(
        &operation_id,
        "fork_session",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    let observation = follow.observation.clone();
    let content = content.inner().clone();
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            let result = client
                .fork_session(&instance_id, &entry_id, Some(&operation_id))
                .await
                .map_err(CommandError::from)?;
            observation.accept_session_result(&target_key, client.clone(), &result);
            Ok(result)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn clone_session(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    follow: tauri::State<'_, FollowState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    entry_id: String,
) -> Result<SessionReplacementResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let association = operation_association(
        &operation_id,
        "clone_session",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    let observation = follow.observation.clone();
    let content = content.inner().clone();
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            let result = client
                .clone_session(&instance_id, &entry_id, Some(&operation_id))
                .await
                .map_err(CommandError::from)?;
            observation.accept_session_result(&target_key, client.clone(), &result);
            Ok(result)
        })
        .await
        .map_err(CommandError::from)?
}

pub(crate) fn parse_trust_continuation<'a>(
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

pub(crate) fn parse_trust_decision(value: &str) -> Result<ProjectTrustDecision, CommandError> {
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
