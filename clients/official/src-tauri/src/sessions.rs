use crate::connection_state::{
    ConnectionRuntimeState, dock_client, ensure_connection_selection, observation_key,
    resolve_connection_store,
};
use crate::errors::{CommandError, lifecycle_error};
use crate::observation::FollowState;
use aludock_client_core::{
    ClientError, NavigateOptions, ProjectTrustDecision, SafeSessionReload, SessionCompactionResult,
    SessionForkResult, SessionNameResult, SessionNavigateResult, SessionReplacementResult,
    SessionScope, SessionTokenScope, SessionTokenState, SessionTree, begin_session_token_request,
    operation_association, project_session_reload, publish_session_tokens,
    resolve_work_session_token,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeSession {
    pub(crate) token: String,
    pub(crate) name: Option<String>,
    pub(crate) cwd: String,
    pub(crate) updated_at: Option<String>,
    pub(crate) identity: String,
    pub(crate) current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeSessionList {
    pub(crate) sessions: Vec<SafeSession>,
    pub(crate) total: u64,
    pub(crate) truncated: bool,
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) host_epoch: String,
    pub(crate) runtime_generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeInventorySession {
    pub(crate) token: String,
    pub(crate) name: Option<String>,
    pub(crate) first_user_message: Option<String>,
    pub(crate) cwd: String,
    pub(crate) updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeSessionInventory {
    pub(crate) sessions: Vec<SafeInventorySession>,
    pub(crate) total: u64,
    pub(crate) truncated: bool,
    pub(crate) incomplete: bool,
    pub(crate) machine_host_id: String,
    pub(crate) connection_id: String,
    pub(crate) host_epoch: String,
    pub(crate) selection_generation: u64,
}

#[allow(clippy::too_many_arguments)]
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
    scope: String,
) -> Result<SafeSessionList, CommandError> {
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
                current: current
                    .as_ref()
                    .is_some_and(|current| session.session_id == current.executor.pi_session_id),
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
pub(crate) async fn session_inventory(
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
