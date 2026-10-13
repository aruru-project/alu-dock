use crate::connection_state::{
    ConnectionRuntimeState, dock_client, ensure_connection_selection, resolve_connection_store,
};
use crate::errors::{CommandError, lifecycle_error};
use aludock_client_core::{
    ClientError, ExtensionControlState, ExtensionControlUpdate, InteractionMethod,
    InteractionResponse, ProjectedEvent, safe_controller_event,
};
use serde::Serialize;
use tauri::Emitter;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeControllerBinding {
    pub(crate) handle: String,
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) host_epoch: String,
    pub(crate) instance_id: String,
    pub(crate) runtime_generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControllerEmission {
    pub(crate) handle: String,
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) host_epoch: String,
    pub(crate) instance_id: String,
    pub(crate) runtime_generation: u64,
    pub(crate) event: ProjectedEvent,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControllerStatusEmission {
    pub(crate) handle: String,
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) host_epoch: String,
    pub(crate) instance_id: String,
    pub(crate) runtime_generation: u64,
    pub(crate) state: String,
    pub(crate) message: Option<String>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn acquire_extension_control(
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
    let binding = state.install(
        controller,
        connection_id,
        selection_generation,
        move |update| match update {
            ExtensionControlUpdate::Event(binding, event) => {
                if let Ok(event) = safe_controller_event(event) {
                    let _ = app.emit(
                        "aludock://extension-controller-event",
                        ControllerEmission {
                            handle: binding.handle,
                            connection_id: binding.connection_id,
                            selection_generation: binding.selection_generation,
                            host_epoch: binding.host_epoch,
                            instance_id: binding.instance_id,
                            runtime_generation: binding.runtime_generation,
                            event,
                        },
                    );
                }
            }
            ExtensionControlUpdate::Disconnected(binding) => {
                let _ = app.emit(
                    "aludock://extension-controller-status",
                    ControllerStatusEmission {
                        handle: binding.handle,
                        connection_id: binding.connection_id,
                        selection_generation: binding.selection_generation,
                        host_epoch: binding.host_epoch,
                        instance_id: binding.instance_id,
                        runtime_generation: binding.runtime_generation,
                        state: "disconnected".into(),
                        message: Some(
                            "Extension UI 控制连接已结束；没有替你回答或取消问题。".into(),
                        ),
                    },
                );
            }
        },
    );
    drop(lifecycle);
    Ok(SafeControllerBinding {
        handle: binding.handle,
        connection_id: binding.connection_id,
        selection_generation: binding.selection_generation,
        host_epoch: binding.host_epoch,
        instance_id: binding.instance_id,
        runtime_generation: binding.runtime_generation,
    })
}

#[tauri::command]
pub(crate) fn release_extension_control(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, ExtensionControlState>,
    handle: String,
) -> Result<(), CommandError> {
    let _store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    state
        .release(&handle, &connection_id, selection_generation)
        .map_err(CommandError::from)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn respond_extension_interaction(
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
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    state
        .respond(
            &client,
            &handle,
            &connection_id,
            selection_generation,
            &interaction_id,
            method,
            value,
            confirmed,
            cancelled,
        )
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) async fn set_extension_widget_viewport(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    state: tauri::State<'_, ExtensionControlState>,
    handle: String,
    width: u16,
    height: u16,
) -> Result<aludock_client_core::WidgetViewportResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    state
        .viewport(
            &client,
            &handle,
            &connection_id,
            selection_generation,
            width,
            height,
        )
        .await
        .map_err(CommandError::from)
}

/// Answer the Work's question without the operator connection (shared questions).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn respond_shared_interaction(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    interaction_id: String,
    method: InteractionMethod,
    value: Option<String>,
    confirmed: Option<bool>,
    cancelled: bool,
) -> Result<aludock_client_core::InteractionRespondResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let response = InteractionResponse::from_answer(method, value, confirmed, cancelled, None)
        .map_err(CommandError::from)?;
    client
        .respond_shared_interaction(&instance_id, &interaction_id, &response, cancelled, None)
        .await
        .map_err(CommandError::from)
}

/// Report this window's width for extension widgets without the operator connection.
#[tauri::command]
pub(crate) async fn set_shared_widget_viewport(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_runtime_generation: u64,
    width: u16,
    height: u16,
) -> Result<aludock_client_core::WidgetViewportResult, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    client
        .set_shared_widget_viewport(&instance_id, expected_runtime_generation, width, height)
        .await
        .map_err(CommandError::from)
}
