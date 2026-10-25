#[cfg(target_os = "android")]
use crate::android_documents;
use crate::connection_state::{
    ConnectionRuntimeState, RuntimeLifecycle, attachment_authority, dock_client,
    ensure_connection_selection, resolve_connection_store,
};
use crate::errors::{CommandError, lifecycle_error, msg_attachment_too_large};
use crate::media::{MAX_RENDERABLE_IMAGE_BYTES, raster_image_mime_type};
use aludock_client_core::{
    AttachmentSnapshot, AttachmentSource, AttachmentState, AttachmentUploadScope, ClientError,
    MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, NativeAttachment,
};
#[cfg(target_os = "android")]
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
#[cfg(target_os = "android")]
use std::fs;
#[cfg(target_os = "android")]
use std::io::Read;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::ipc::{InvokeBody, Request};
#[cfg(not(target_os = "android"))]
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "android")]
use tauri_plugin_dialog::FilePath;
#[cfg(target_os = "android")]
use tauri_plugin_fs::FsExt;
#[cfg(target_os = "android")]
use tauri_plugin_fs::OpenOptions as PluginOpenOptions;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedAttachment {
    pub(crate) token: String,
    pub(crate) name: String,
    pub(crate) size_bytes: u64,
    pub(crate) media_type: Option<String>,
}

pub(crate) const MSG_ATTACHMENT_SOURCE_UNAVAILABLE: &str = "无法读取所选附件。";

pub(crate) const MSG_ATTACHMENT_NOT_PLAIN_FILE: &str = "只能选择本机普通文件。";

pub(crate) fn msg_attachment_selection_full() -> String {
    format!(
        "本次最多选择 {} 个附件，请减少选择后重试。",
        MAX_ATTACHMENTS_PER_MESSAGE
    )
}

pub(crate) const MSG_PASTE_CONTEXT_LOST: &str = "无法读取粘贴图片的上下文，请重新粘贴。";

pub(crate) const MSG_CLIPBOARD_IMAGE_INVALID: &str = "剪贴板中的图片数据无效，请重新复制。";

pub(crate) const MSG_PASTE_STAGE_FAILED: &str = "无法暂存粘贴的图片，请重试或使用附件按钮。";

pub(crate) const MSG_ATTACHMENT_PREVIEW_LOST: &str = "这个附件已无法预览，请重新选择。";

pub(crate) fn attachment_command_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

pub(crate) fn attachment_upload_error(error: ClientError) -> CommandError {
    let mut error = CommandError::from(error);
    // Upload operation IDs are native-only even for indeterminate outcomes.
    error.operation_id = None;
    error
}

pub(crate) fn attachment_scope_matches(
    entry: &NativeAttachment,
    connection_id: &str,
    authority: &str,
    work_id: &str,
) -> bool {
    entry.connection_id == connection_id && entry.authority == authority && entry.work_id == work_id
}

pub(crate) fn ensure_attachment_scope(
    entry: &NativeAttachment,
    connection_id: &str,
    authority: &str,
    work_id: &str,
) -> Result<(), CommandError> {
    if attachment_scope_matches(entry, connection_id, authority, work_id) {
        Ok(())
    } else {
        Err(attachment_command_error(
            "stale_attachment_context",
            "附件不属于当前 Host 或工作。",
        ))
    }
}

pub(crate) type PreparedAttachment = (String, SelectedAttachment, NativeAttachment);

pub(crate) fn valid_attachment_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= 1_024 && !name.chars().any(char::is_control)
}

#[cfg(target_os = "android")]
pub(crate) fn normalized_media_type(value: Option<&str>) -> Option<String> {
    value
        .and_then(|value| value.parse::<mime_guess::Mime>().ok())
        .map(|value| value.essence_str().to_owned())
}

#[cfg(target_os = "android")]
pub(crate) fn fallback_attachment_name(media_type: Option<&str>) -> String {
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidPickedFileMetadata {
    pub(crate) name: Option<String>,
    pub(crate) media_type: Option<String>,
}

#[cfg(target_os = "android")]
pub(crate) async fn describe_android_picked_file(
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
pub(crate) async fn stage_android_picked_file(
    app: &tauri::AppHandle,
    file: FilePath,
    content: aludock_client_core::SessionContent,
) -> Result<(Arc<AttachmentSource>, String, Option<String>), CommandError> {
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
    let staging_app = app.clone();
    let source = tokio::task::spawn_blocking(move || {
        let mut options = PluginOpenOptions::new();
        options.read(true);
        let reader = staging_app.fs().open(file, options).map_err(|_| {
            attachment_command_error(
                "attachment_source_unavailable",
                MSG_ATTACHMENT_SOURCE_UNAVAILABLE,
            )
        })?;
        // The blocking task returns a lease, not a naked staging path. If its
        // IPC waiter disappears, dropping the result cleans this private source.
        content
            .import_attachment(reader)
            .map_err(CommandError::from)
    })
    .await
    .map_err(|_| lifecycle_error())??;
    Ok((source, name, media_type))
}

pub(crate) fn prepare_native_attachment(
    source: Arc<AttachmentSource>,
    connection_id: String,
    work_id: String,
    name: String,
    media_type: Option<String>,
) -> PreparedAttachment {
    let token = uuid::Uuid::new_v4().to_string();
    (
        token.clone(),
        SelectedAttachment {
            token,
            name: name.clone(),
            size_bytes: source.size_bytes(),
            media_type: media_type.clone(),
        },
        NativeAttachment::new(source, connection_id, work_id, name, media_type),
    )
}

pub(crate) fn request_header(request: &Request<'_>, name: &str) -> Result<String, CommandError> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| attachment_command_error("invalid_clipboard_image", MSG_PASTE_CONTEXT_LOST))
}

pub(crate) enum BoundedImageBodyError {
    Invalid,
    TooLarge,
}

pub(crate) fn bounded_image_body(request: &Request<'_>) -> Result<Vec<u8>, BoundedImageBodyError> {
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

pub(crate) fn request_image_bytes(request: &Request<'_>) -> Result<Vec<u8>, CommandError> {
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

pub(crate) fn prepare_clipboard_image(
    content: &aludock_client_core::SessionContent,
    bytes: Vec<u8>,
    connection_id: String,
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
    let source = content.import_attachment(bytes.as_slice()).map_err(|_| {
        attachment_command_error("clipboard_image_unavailable", MSG_PASTE_STAGE_FAILED)
    })?;
    Ok(prepare_native_attachment(
        source,
        connection_id,
        work_id,
        name,
        Some(media_type.to_owned()),
    ))
}

pub(crate) fn publish_selected_attachments(
    lifecycle: &Mutex<RuntimeLifecycle>,
    state: &AttachmentState,
    connection_id: &str,
    selection_generation: u64,
    prepared: Vec<PreparedAttachment>,
    authority: &str,
) -> Result<Vec<SelectedAttachment>, CommandError> {
    // Match set_active_host's lock order so generation validation and native-path
    // publication form one atomic lifecycle operation.
    let lifecycle = lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    if prepared.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            &msg_attachment_selection_full(),
        ));
    }
    let mut selected = Vec::with_capacity(prepared.len());
    for (token, item, mut entry) in prepared {
        entry.authority = authority.to_owned();
        state.insert(token, entry);
        selected.push(item);
    }
    Ok(selected)
}

#[tauri::command]
pub(crate) async fn pick_attachments(
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
    if files.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            &msg_attachment_selection_full(),
        ));
    }

    let mut prepared = Vec::with_capacity(files.len());
    for file in files {
        let local_path = file.clone().into_path();
        let (source, name, media_type) = match local_path {
            Ok(path) => import_local_file(&state, path).await?,
            Err(_) => {
                #[cfg(target_os = "android")]
                {
                    stage_android_picked_file(&app, file, state.content.clone()).await?
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
            source,
            connection_id.clone(),
            work_id.clone(),
            name,
            media_type,
        ));
    }

    publish_selected_attachments(
        runtime.lifecycle.as_ref(),
        &state,
        &connection_id,
        selection_generation,
        prepared,
        &attachment_authority(&runtime, &connection_id)?,
    )
}

/// Copies one local file into private staging under the picker's checks.
pub(crate) async fn import_local_file(
    state: &AttachmentState,
    path: std::path::PathBuf,
) -> Result<(Arc<AttachmentSource>, String, Option<String>), CommandError> {
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
        .ok_or_else(|| attachment_command_error("invalid_attachment_name", "附件名称无效。"))?
        .to_owned();
    let media_type = mime_guess::from_path(&path).first_raw().map(str::to_owned);
    let content = state.content.clone();
    let source = tokio::task::spawn_blocking(move || {
        content
            .import_attachment_file(&path)
            .map_err(CommandError::from)
    })
    .await
    .map_err(|_| lifecycle_error())??;
    Ok((source, name, media_type))
}

/// Stages local files that the system handed over (a drop or a copied file list)
/// exactly as if they had been picked.
pub(crate) async fn stage_local_files(
    runtime: &ConnectionRuntimeState,
    state: &AttachmentState,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    paths: Vec<std::path::PathBuf>,
) -> Result<Vec<SelectedAttachment>, CommandError> {
    if paths.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(attachment_command_error(
            "attachment_limit_exceeded",
            &msg_attachment_selection_full(),
        ));
    }
    let mut prepared = Vec::with_capacity(paths.len());
    for path in paths {
        let (source, name, media_type) = import_local_file(state, path).await?;
        prepared.push(prepare_native_attachment(
            source,
            connection_id.clone(),
            work_id.clone(),
            name,
            media_type,
        ));
    }
    publish_selected_attachments(
        runtime.lifecycle.as_ref(),
        state,
        &connection_id,
        selection_generation,
        prepared,
        &attachment_authority(runtime, &connection_id)?,
    )
}

#[tauri::command]
pub(crate) async fn stage_clipboard_image(
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
    let content = state.content.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        prepare_clipboard_image(
            &content,
            bytes,
            prepared_connection,
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
        vec![prepared],
        &attachment_authority(&runtime, &connection_id)?,
    )?
    .into_iter()
    .next()
    .ok_or_else(lifecycle_error)
}

#[tauri::command]
pub(crate) async fn attachment_preview(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    token: String,
) -> Result<aludock_client_core::MediaHandle, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let (source, operation_id, media_type) = {
        let entry = state.get(&token).ok_or_else(|| {
            attachment_command_error(
                "attachment_preview_unavailable",
                MSG_ATTACHMENT_PREVIEW_LOST,
            )
        })?;
        ensure_attachment_scope(
            &entry,
            &connection_id,
            &attachment_authority(&runtime, &connection_id)?,
            &work_id,
        )?;
        if entry.size_bytes > MAX_RENDERABLE_IMAGE_BYTES {
            return Err(attachment_command_error(
                "attachment_preview_too_large",
                "这个图片附件太大，无法预览，但仍可发送。",
            ));
        }
        (
            entry.source.clone(),
            entry.operation_id.clone(),
            entry.media_type.clone(),
        )
    };
    let content = state.content.clone();
    let media = tokio::task::spawn_blocking(move || {
        content.attachment_preview(source, media_type.as_deref().unwrap_or_default())
    })
    .await
    .map_err(|_| lifecycle_error())?
    .map_err(|_| {
        attachment_command_error(
            "attachment_preview_unavailable",
            "无法预览这个图片附件，但仍可发送。",
        )
    })?;
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let entry = state.get(&token).ok_or_else(|| {
        attachment_command_error(
            "attachment_preview_unavailable",
            MSG_ATTACHMENT_PREVIEW_LOST,
        )
    })?;
    ensure_attachment_scope(
        &entry,
        &connection_id,
        &attachment_authority(&runtime, &connection_id)?,
        &work_id,
    )?;
    if entry.operation_id != operation_id {
        return Err(attachment_command_error(
            "attachment_preview_unavailable",
            MSG_ATTACHMENT_PREVIEW_LOST,
        ));
    }
    Ok(media)
}

#[tauri::command]
pub(crate) fn attachment_snapshot(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
) -> Result<AttachmentSnapshot, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    Ok(state.snapshot(&attachment_authority(&runtime, &connection_id)?, &work_id))
}

#[tauri::command]
pub(crate) async fn upload_attachment(
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
) -> Result<(), CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let upload_scope = AttachmentUploadScope {
        machine_host_id: target_machine_host_id,
        owner_host_epoch: expected_host_epoch,
        runtime_generation: expected_runtime_generation,
    };
    // Keep lifecycle validation and starting the owned task in the same admission window.
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, &connection_id, selection_generation)?;
    {
        let entry = state.get(&token).ok_or_else(|| {
            attachment_command_error("attachment_not_found", "附件选择已失效，请重新选择。")
        })?;
        ensure_attachment_scope(
            &entry,
            &connection_id,
            &attachment_authority(&runtime, &connection_id)?,
            &work_id,
        )?;
    }
    state
        .start(&token, upload_scope, client, move |snapshot| {
            let _ = app.emit("aludock://attachment-progress", snapshot);
        })
        .map_err(attachment_upload_error)
}

#[tauri::command]
pub(crate) fn cancel_attachment_upload(
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
    {
        let Some(entry) = state.get(&token) else {
            return Ok(false);
        };
        ensure_attachment_scope(
            &entry,
            &connection_id,
            &attachment_authority(&runtime, &connection_id)?,
            &work_id,
        )?;
    }
    Ok(state.cancel(&token))
}

#[tauri::command]
pub(crate) fn remove_attachment(
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
    {
        let Some(entry) = state.get(&token) else {
            return Ok(false);
        };
        ensure_attachment_scope(
            &entry,
            &connection_id,
            &attachment_authority(&runtime, &connection_id)?,
            &work_id,
        )?;
    }
    Ok(state.remove(&token))
}
