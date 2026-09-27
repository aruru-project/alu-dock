use crate::connection_state::{ConnectionRuntimeState, dock_client, resolve_connection_store};
use crate::errors::CommandError;
use aludock_client_core::{
    CommandCompletionItems, CommandCompletionsResult, CommandContentResult, CommandReferenceScope,
    CommandReferenceState, InstanceSnapshot, ModelsResult, ResourceContentResult,
    SafeCommandCompletionsResult, SafeCommandContentResult, SafeCommandsResult,
    SafeResourcesResult, SafeToolsResult, SettingUpdate, SettingUpdateResult, SettingsResult,
    SubmitResult, ThinkingLevel, operation_association, project_commands, project_resources,
    project_tools,
};
use serde_json::Value;

#[tauri::command]
pub(crate) async fn command_catalog(
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
    project_commands(result, &references, scope, reference_generation).map_err(CommandError::from)
}

#[tauri::command]
pub(crate) async fn command_content(
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
pub(crate) async fn command_completions(
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
pub(crate) async fn run_catalog_command(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    name: String,
    arguments: String,
    operation_id: String,
) -> Result<SubmitResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let association = operation_association(
        &operation_id,
        "run_catalog_command",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            client
                .run_catalog_command(&instance_id, &name, &arguments, &operation_id)
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn list_models(
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
pub(crate) async fn set_model(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    provider: String,
    model_id: String,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let association = operation_association(
        &operation_id,
        "set_model",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            client
                .set_model(&instance_id, &provider, &model_id, Some(&operation_id))
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn set_thinking(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    level: ThinkingLevel,
) -> Result<InstanceSnapshot, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let association = operation_association(
        &operation_id,
        "set_thinking",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            client
                .set_thinking(&instance_id, level, Some(&operation_id))
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn list_tools(
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
pub(crate) async fn set_active_tools(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    names: Vec<String>,
) -> Result<SafeToolsResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let association = operation_association(
        &operation_id,
        "set_active_tools",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            client
                .set_active_tools(&instance_id, &names, Some(&operation_id))
                .await
                .map(project_tools)
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn get_settings(
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
pub(crate) async fn update_setting(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    operations: tauri::State<'_, aludock_client_core::OperationAssociations>,
    operation_editor: Value,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    operation_id: String,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    update: SettingUpdate,
) -> Result<SettingUpdateResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let association = operation_association(
        &operation_id,
        "update_setting",
        &connection_id,
        &instance_id,
        &expected_host_epoch,
        expected_runtime_generation,
        operation_editor,
    );
    operations
        .execute(association, async move {
            client
                .update_setting(&instance_id, &update, Some(&operation_id))
                .await
                .map_err(CommandError::from)
        })
        .await
        .map_err(CommandError::from)?
}

#[tauri::command]
pub(crate) async fn resource_content(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    content_ref: String,
    offset: Option<u64>,
    revision: Option<String>,
) -> Result<ResourceContentResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .resource_content(&instance_id, &content_ref, offset, revision.as_deref())
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) async fn get_resources(
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
