#[cfg(target_os = "android")]
use crate::android_documents;
use crate::connection_state::{
    ConnectionRuntimeState, attachment_authority, dock_client, observation_key,
    resolve_connection_store,
};
use crate::errors::{CommandError, image_error, lifecycle_error};
use crate::file_delivery::{
    LocalSaveResult, commit_verified_file, create_delivery_staging_file, delivery_staging_path,
    describe_saved_location, pick_save_destination,
};
use crate::observation::FollowState;
use aludock_client_core::PublishedFileDto;
use std::fs;
#[cfg(target_os = "android")]
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
#[cfg(target_os = "android")]
use tauri_plugin_dialog::FilePath;

pub(crate) const MAX_RENDERABLE_IMAGE_BYTES: u64 =
    aludock_client_core::MAX_ATTACHMENT_PREVIEW_BYTES;

#[tauri::command]
pub(crate) async fn conversation_image(
    state: tauri::State<'_, FollowState>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    content_ref: String,
    mime_type: String,
    file_id: Option<String>,
) -> Result<aludock_client_core::MediaHandle, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let scope = aludock_client_core::MediaScope {
        authority: observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?,
        instance_id,
        host_epoch: expected_host_epoch,
        runtime_generation: expected_runtime_generation,
    };
    let image = state
        .observation
        .content
        .conversation_image(
            &client,
            scope,
            &content_ref,
            &mime_type,
            &attachment_authority(&runtime, &connection_id)?,
            file_id.as_deref(),
        )
        .await
        .map_err(CommandError::from)?;
    // The validated old-domain file remains reusable, but a late IPC response
    // cannot become a binding for a newly selected connection.
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    Ok(image)
}

#[tauri::command]
pub(crate) async fn inline_conversation_image(
    state: tauri::State<'_, FollowState>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    mime_type: String,
    data: String,
) -> Result<aludock_client_core::MediaHandle, CommandError> {
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let scope = aludock_client_core::MediaScope {
        authority: observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?,
        instance_id,
        host_epoch: expected_host_epoch,
        runtime_generation: expected_runtime_generation,
    };
    let content = state.observation.content.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        content.inline_image(scope, &mime_type, &data)
    })
    .await
    .map_err(|_| image_error("image_transfer_failed", "图片读取中断，请重试。"))?
    .map_err(CommandError::from)?;
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    Ok(result)
}

pub(crate) fn conversation_media_response(
    content: &aludock_client_core::SessionContent,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use std::io::Read;
    let missing = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap()
    };
    if request.method() != tauri::http::Method::GET && request.method() != tauri::http::Method::HEAD
    {
        return missing();
    }
    if request.uri().query().is_some() {
        return missing();
    }
    let handle = request.uri().path().strip_prefix('/').unwrap_or_default();
    let Ok((media, mut file)) = content.open_media(handle) else {
        return missing();
    };
    let mut bytes = Vec::new();
    if request.method() == tauri::http::Method::GET && file.read_to_end(&mut bytes).is_err() {
        return tauri::http::Response::builder()
            .status(500)
            .body(Vec::new())
            .unwrap();
    }
    let origin = request
        .headers()
        .get("Origin")
        .and_then(|value| value.to_str().ok());
    let trusted_origin = origin.filter(|origin| {
        matches!(
            *origin,
            "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
        ) || (cfg!(debug_assertions) && *origin == "http://127.0.0.1:1420")
    });
    let mut response = tauri::http::Response::builder().header("Vary", "Origin");
    if let Some(origin) = trusted_origin {
        response = response.header("Access-Control-Allow-Origin", origin);
    }
    response
        .header("Content-Type", media.mime_type)
        .header("Content-Length", media.size_bytes)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(bytes)
        .unwrap()
}

#[tauri::command]
pub(crate) async fn published_image(
    state: tauri::State<'_, FollowState>,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    expected_host_epoch: String,
    expected_runtime_generation: u64,
    file: PublishedFileDto,
) -> Result<aludock_client_core::MediaHandle, CommandError> {
    if file.size_bytes > MAX_RENDERABLE_IMAGE_BYTES {
        return Err(image_error(
            "image_too_large",
            "这张图片太大，当前设备无法安全预览。",
        ));
    }
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    let scope = aludock_client_core::MediaScope {
        authority: observation_key(&runtime, &connection_id, &instance_id, &expected_host_epoch)?,
        instance_id,
        host_epoch: expected_host_epoch,
        runtime_generation: expected_runtime_generation,
    };
    let media = state
        .observation
        .content
        .published_image(&client, scope, &file)
        .await
        .map_err(CommandError::from)?;
    resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    Ok(media)
}

pub(crate) fn validate_renderable_image(
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

pub(crate) fn raster_image_mime_type(bytes: &[u8]) -> Option<&'static str> {
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

pub(crate) fn preview_image_save_name(requested: &str, media_type: &str) -> String {
    let mut cleaned = requested
        .chars()
        .map(|character| {
            if character.is_control() || character == '/' || character == '\\' {
                '_'
            } else {
                character
            }
        })
        .take(180)
        .collect::<String>();
    cleaned = cleaned
        .trim_matches(|character: char| character.is_whitespace() || character == '.')
        .to_owned();
    if cleaned.is_empty() {
        cleaned = "aludock-image".into();
    }
    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "img",
    };
    let lowercase = cleaned.to_ascii_lowercase();
    let extension_matches = match media_type {
        "image/jpeg" => lowercase.ends_with(".jpg") || lowercase.ends_with(".jpeg"),
        _ => lowercase.ends_with(&format!(".{extension}")),
    };
    if extension_matches {
        return cleaned;
    }
    if [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|suffix| lowercase.ends_with(suffix))
    {
        if let Some((stem, _)) = cleaned.rsplit_once('.') {
            cleaned = stem.to_owned();
        }
    }
    format!("{cleaned}.{extension}")
}

// Only this save's staging file is removed on failure/cancel, never the media source.
pub(crate) struct PreviewSaveStaging(PathBuf);

impl Drop for PreviewSaveStaging {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[tauri::command]
pub(crate) async fn save_preview_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, FollowState>,
    handle: String,
    name: String,
) -> Result<LocalSaveResult, CommandError> {
    let content = state.observation.content.clone();
    // Once requested, losing the IPC waiter cannot interrupt a destination
    // commit or release staging under its active platform copy.
    tauri::async_runtime::spawn(async move { save_media_image(app, content, handle, name).await })
        .await
        .map_err(|_| lifecycle_error())?
}

pub(crate) async fn save_media_image(
    app: tauri::AppHandle,
    content: aludock_client_core::SessionContent,
    handle: String,
    requested_name: String,
) -> Result<LocalSaveResult, CommandError> {
    let (media, _) = content.open_media(&handle).map_err(CommandError::from)?;
    let name = preview_image_save_name(&requested_name, &media.mime_type);
    #[cfg(not(mobile))]
    let destination = pick_save_destination(&app, &name).await?;
    #[cfg(mobile)]
    let mut destination: Option<FilePath> = None;
    #[cfg(not(mobile))]
    if destination.is_none() {
        return Ok(LocalSaveResult::Cancelled);
    }
    let write_path = delivery_staging_path(&app, destination.as_ref())?;
    let staging =
        tokio::task::spawn_blocking(move || -> Result<PreviewSaveStaging, CommandError> {
            let mut target = create_delivery_staging_file(&write_path)?;
            let staging = PreviewSaveStaging(write_path);
            content.copy_media(&handle, &mut target).map_err(|_| {
                image_error(
                    "image_save_failed",
                    "图片未能完整保存。请检查存储空间并重新读取图片后重试。",
                )
            })?;
            target
                .flush()
                .and_then(|_| target.sync_all())
                .map_err(|_| {
                    image_error(
                        "image_save_failed",
                        "无法保存到所选位置。请检查可用空间和存储权限后重试。",
                    )
                })?;
            Ok(staging)
        })
        .await
        .map_err(|_| lifecycle_error())??;
    #[cfg(mobile)]
    {
        destination = pick_save_destination(&app, &name).await?;
        if destination.is_none() {
            return Ok(LocalSaveResult::Cancelled);
        }
    }
    let destination = destination.expect("save cancellation returned before commit");
    let saved_location = describe_saved_location(&destination, &name)?;
    commit_verified_file(&app, staging.0.clone(), destination.clone()).await?;
    #[cfg(target_os = "android")]
    if let FilePath::Url(url) = &destination {
        let _ = android_documents::retain_document_access(&app, url.as_str()).await;
    }
    Ok(LocalSaveResult::Saved {
        label: saved_location.label,
    })
}
