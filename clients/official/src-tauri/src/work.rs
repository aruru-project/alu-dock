use crate::connection_state::{
    ConnectionRuntimeState, attachment_authority, dock_client, observation_key,
    resolve_connection_store,
};
use crate::errors::CommandError;
use crate::observation::FollowState;
use crate::sessions::parse_trust_continuation;
use aludock_client_core::{
    AttachmentState, BashRunResult, ExtensionControlState, InstanceSnapshot, Machine, ModelRef,
    ModelVisibilityResult, ModelVisibilitySetResult, ResourceContentResult, RestoredImageState,
    SafeQueueDequeueResult, SessionTokenState, StopResult, SubmitResult, SystemCatalogCursor,
    SystemCatalogResult, SystemDefaultSetResult, WorkspaceCursor, WorkspacePage,
    operation_association, project_queue_dequeue, resolve_machine_session_token,
    restored_image_scope,
};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoredImageCount {
    pub(crate) image_count: usize,
}

#[tauri::command]
pub(crate) fn pending_operations(
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
) -> Vec<aludock_client_core::OperationAssociation> {
    operations.pending()
}

#[tauri::command]
pub(crate) fn consume_operation(
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_id: String,
) {
    operations.consume(&operation_id);
}

#[tauri::command]
pub(crate) async fn submit_message(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_id: String,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    restored_images: tauri::State<'_, RestoredImageState>,
    attachments: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    message: String,
    attachment_file_ids: Option<Vec<String>>,
) -> Result<SubmitResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let scope = restored_image_scope(
        &connection_id,
        selection_generation,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
    );
    let attachment_file_ids = attachment_file_ids.unwrap_or_default();
    let authority = attachment_authority(&runtime, &connection_id)?;
    let attachments = attachments.inner().clone();
    let restored_images = restored_images.inner().clone();
    let association = operation_association(
        &operation_id,
        "submit_message",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            restored_images
                .submit(
                    &client,
                    &attachments,
                    &scope,
                    &authority,
                    &message,
                    &attachment_file_ids,
                    &operation_id,
                )
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn dequeue_messages(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    restored_images: tauri::State<'_, RestoredImageState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeQueueDequeueResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let restored_images = restored_images.inner().clone();
    let association = operation_association(
        &operation_id,
        "dequeue_messages",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            let result = restored_images
                .dequeue(
                    &client,
                    restored_image_scope(
                        &connection_id,
                        selection_generation,
                        &instance_id,
                        &expected_host_epoch,
                        expected_runtime_generation,
                    ),
                    &operation_id,
                )
                .await
                .map_err(CommandError::from)?;
            Ok(project_queue_dequeue(result))
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) fn restored_image_count(
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    restored_images: tauri::State<'_, RestoredImageState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> usize {
    restored_images
        .capture(&restored_image_scope(
            &connection_id,
            selection_generation,
            &instance_id,
            &expected_host_epoch,
            expected_runtime_generation,
        ))
        .map_or(0, |bucket| bucket.images.len())
}

#[tauri::command]
pub(crate) fn clear_restored_images(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    restored_images: tauri::State<'_, RestoredImageState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
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
            &expected_host_epoch,
            expected_runtime_generation,
        )),
    })
}

#[tauri::command]
pub(crate) async fn abort_run(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    restored_images: tauri::State<'_, RestoredImageState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<SafeQueueDequeueResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let restored_images = restored_images.inner().clone();
    let association = operation_association(
        &operation_id,
        "abort_run",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            let result = restored_images
                .abort_run(
                    &client,
                    restored_image_scope(
                        &connection_id,
                        selection_generation,
                        &instance_id,
                        &expected_host_epoch,
                        expected_runtime_generation,
                    ),
                    &operation_id,
                )
                .await
                .map_err(CommandError::from)?;
            Ok(project_queue_dequeue(result))
        })
        .await
        .map_err(CommandError::from)?
}

/// Pi's `!` / `!!` from the workspace command area; output follows as `bash.*` events.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_shell_command(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    command: String,
    exclude_from_context: bool,
) -> Result<BashRunResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    // The command runs in the Work directory of the Session this page is showing: a
    // Session replaced by another entry point since then gets no command from here.
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let content = content.inner().clone();
    let association = operation_association(
        &operation_id,
        "run_shell_command",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            client
                .run_bash(
                    &instance_id,
                    &command,
                    exclude_from_context,
                    Some(&operation_id),
                )
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn abort_shell_commands(
    content: tauri::State<'_, aludock_client_core::SessionContent>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?
        .with_host_epoch(&expected_host_epoch);
    let target_key = observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?;
    let content = content.inner().clone();
    let association = operation_association(
        &operation_id,
        "abort_shell_commands",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            content
                .check_target(
                    &target_key,
                    &expected_host_epoch,
                    expected_runtime_generation,
                )
                .map_err(CommandError::from)?;
            client
                .abort_bash(&instance_id, Some(&operation_id))
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

pub(crate) fn detach_work_runtime(
    follow: &FollowState,
    extension: &ExtensionControlState,
    connection_id: &str,
    selection_generation: u64,
    instance_id: &str,
) {
    let _ = follow.abort_matching(connection_id, selection_generation, instance_id, None);
    extension.detach_work(connection_id, selection_generation, instance_id);
}

#[tauri::command]
pub(crate) async fn stop_work(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    follow: tauri::State<'_, FollowState>,
    extension: tauri::State<'_, ExtensionControlState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<StopResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let follow = follow.inner().clone();
    let extension = extension.inner().clone();
    let association = operation_association(
        &operation_id,
        "stop_work",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            let result = client
                .stop_instance(&instance_id, Some(&operation_id))
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
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn reopen_work(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    operation_id: String,
    trust_challenge_id: Option<String>,
    project_trust_decision: Option<String>,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let association = operation_association(
        &operation_id,
        "reopen_work",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            let continuation = parse_trust_continuation(
                trust_challenge_id.as_deref(),
                project_trust_decision.as_deref(),
                Some(operation_id.clone()),
            )?;
            let result = client
                .reopen_instance(&instance_id, continuation, Some(operation_id.as_str()))
                .await
                .map_err(CommandError::from)?;
            Ok(result.instance)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn forget_work(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<(), CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let association = operation_association(
        &operation_id,
        "forget_work",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            client
                .forget_instance(&instance_id, Some(&operation_id))
                .await
                .map_err(CommandError::from)?;
            Ok(())
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn list_machines(
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
pub(crate) async fn model_visibility(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    target_host_id: Option<String>,
) -> Result<ModelVisibilityResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .model_visibility(target_host_id.as_deref())
        .await
        .map_err(CommandError::from)
}

/// A whole-list replace: an unknown outcome is settled by reading the list again, not by
/// an operation record, so it does not join the Work operation results.
#[tauri::command]
pub(crate) async fn set_model_visibility(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    target_host_id: Option<String>,
    hidden: Vec<ModelRef>,
) -> Result<ModelVisibilitySetResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .set_model_visibility(&hidden, target_host_id.as_deref(), None)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) async fn system_catalog(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    cwd: String,
    target_host_id: Option<String>,
    cursor: Option<SystemCatalogCursor>,
) -> Result<SystemCatalogResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .system_catalog(&cwd, target_host_id.as_deref(), cursor.as_ref())
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) async fn system_content(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    cwd: String,
    id: String,
    target_host_id: Option<String>,
    offset: Option<u64>,
    revision: Option<String>,
) -> Result<ResourceContentResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    if offset.is_none() && revision.is_none() {
        client
            .system_content_all(&cwd, &id, target_host_id.as_deref())
            .await
    } else {
        client
            .system_content(
                &cwd,
                &id,
                target_host_id.as_deref(),
                offset,
                revision.as_deref(),
            )
            .await
    }
    .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) async fn set_system_default(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    connection_id: String,
    expected_host_epoch: String,
    selection_generation: u64,
    cwd: String,
    id: String,
    target_host_id: Option<String>,
) -> Result<SystemDefaultSetResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let association = operation_association(
        &operation_id,
        "set_system_default",
        &connection_id,
        "global",
        &expected_host_epoch,
        0,
        Value::Null,
    );
    operations
        .execute(association, async move {
            client
                .set_system_default(&cwd, &id, target_host_id.as_deref(), Some(&operation_id))
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn list_workspace(
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn adopt_session(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    connection_id: String,
    expected_host_epoch: String,
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
    let operation_id = Some(operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
    let association = operation_association(
        operation_id.as_deref().unwrap(),
        "adopt_session",
        &connection_id,
        "global",
        &expected_host_epoch,
        0,
        Value::Null,
    );
    operations
        .execute(association, async move {
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
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_work(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    connection_id: String,
    expected_host_epoch: String,
    selection_generation: u64,
    cwd: String,
    name: Option<String>,
    target_host_id: Option<String>,
    worker_config: Option<serde_json::Map<String, Value>>,
    operation_id: Option<String>,
    trust_challenge_id: Option<String>,
    project_trust_decision: Option<String>,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let operation_id = Some(operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
    let association = operation_association(
        operation_id.as_deref().unwrap(),
        "create_work",
        &connection_id,
        "global",
        &expected_host_epoch,
        0,
        Value::Null,
    );
    operations
        .execute(association, async move {
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
                    worker_config.as_ref(),
                )
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}
