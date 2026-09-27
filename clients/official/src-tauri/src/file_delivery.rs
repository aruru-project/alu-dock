#[cfg(target_os = "android")]
use crate::android_documents;
use crate::connection_state::{ConnectionRuntimeState, dock_client, resolve_connection_store};
use crate::errors::{CommandError, lifecycle_error};
use aludock_client_core::{ClientError, DeliverableDownloadProgress, DeliverableDto};
use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use tauri::{Emitter, Manager};
#[cfg(not(target_os = "android"))]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::FilePath;
use tauri_plugin_fs::{FsExt, OpenOptions as PluginOpenOptions};
#[cfg(not(target_os = "android"))]
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliverableProgressEmission {
    pub(crate) connection_id: String,
    pub(crate) selection_generation: u64,
    pub(crate) instance_id: String,
    pub(crate) delivery_ref: String,
    pub(crate) bytes_received: u64,
    pub(crate) total_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedDeliverableLocation {
    pub(crate) kind: String,
    pub(crate) value: String,
    pub(crate) label: String,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DeliverableSaveResult {
    Cancelled,
    Saved {
        deliverable: DeliverableDto,
        location: SavedDeliverableLocation,
        sha256: String,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum LocalSaveResult {
    Cancelled,
    Saved { label: String },
}

pub(crate) const DELIVERABLE_SAVE_FAILED_MESSAGE: &str =
    "无法保存到所选位置。请检查可用空间和存储权限后重试。";

pub(crate) const SAVED_FILE_UNAVAILABLE_MESSAGE: &str =
    "找不到已保存的文件，或当前无法打开。请在设备的文件管理器中查找。";

pub(crate) fn deliverable_command_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

pub(crate) fn deliverable_list_error(error: ClientError) -> CommandError {
    match error {
        ClientError::Tls(_) | ClientError::MissingHostCertificate | ClientError::Io(_) => {
            deliverable_command_error(
                "deliverable_connection_failed",
                "无法加载文件列表。请检查连接后重试。",
            )
        }
        ClientError::Protocol(_) | ClientError::Json(_) => deliverable_command_error(
            "deliverable_list_failed",
            "无法加载文件列表。请更新电脑端 AluDock 后重试。",
        ),
        other => CommandError::from(other),
    }
}

pub(crate) fn deliverable_client_error(error: ClientError) -> CommandError {
    match error {
        ClientError::Host { code, .. } if code == "file_unavailable" => deliverable_command_error(
            "file_unavailable",
            "这个文件已无法下载。请让 Agent 重新发送。",
        ),
        ClientError::Tls(_) | ClientError::MissingHostCertificate => deliverable_command_error(
            "deliverable_connection_failed",
            "下载中断了。请检查网络后重试。",
        ),
        ClientError::Protocol(_) | ClientError::Json(_) => deliverable_command_error(
            "deliverable_verification_failed",
            "文件没有完整下载。请重试。",
        ),
        ClientError::Io(_) => deliverable_command_error(
            "deliverable_write_failed",
            "下载没有完成。请检查网络和设备存储后重试。",
        ),
        other => CommandError::from(other),
    }
}

pub(crate) fn describe_saved_location(
    destination: &FilePath,
    name: &str,
) -> Result<SavedDeliverableLocation, CommandError> {
    match destination {
        FilePath::Path(path) => {
            let value = path.to_str().ok_or_else(|| {
                deliverable_command_error(
                    "deliverable_location_unsupported",
                    "无法使用这个保存位置。请选择其他位置。",
                )
            })?;
            Ok(SavedDeliverableLocation {
                kind: "path".into(),
                value: value.into(),
                label: value.into(),
            })
        }
        FilePath::Url(url) => Ok(SavedDeliverableLocation {
            kind: "uri".into(),
            value: url.to_string(),
            label: name.into(),
        }),
    }
}

pub(crate) fn delivery_staging_path(
    app: &tauri::AppHandle,
    destination: Option<&FilePath>,
) -> Result<PathBuf, CommandError> {
    let directory = match destination {
        Some(FilePath::Path(path)) => path.parent().map(PathBuf::from).ok_or_else(|| {
            deliverable_command_error(
                "deliverable_location_unavailable",
                "所选保存位置不可用。请选择其他位置。",
            )
        })?,
        Some(FilePath::Url(_)) | None => app.path().app_cache_dir().map_err(|_| {
            deliverable_command_error(
                "deliverable_location_unavailable",
                "暂时无法开始下载。请检查设备存储空间后重试。",
            )
        })?,
    };
    fs::create_dir_all(&directory).map_err(|_| {
        deliverable_command_error(
            "deliverable_location_unavailable",
            "无法使用这个保存位置。请检查存储权限后重试。",
        )
    })?;
    Ok(directory.join(format!(".aludock-download-{}.part", uuid::Uuid::new_v4())))
}

pub(crate) fn create_delivery_staging_file(path: &PathBuf) -> Result<std::fs::File, CommandError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| {
        deliverable_command_error(
            "deliverable_location_unavailable",
            "暂时无法开始下载。请检查设备存储空间和权限后重试。",
        )
    })
}

#[cfg(target_os = "android")]
pub(crate) async fn pick_save_destination(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<Option<FilePath>, CommandError> {
    // The dialog plugin maps Android errors to cancellation; preserve the distinction.
    android_documents::save_document(app, name)
        .await
        .map_err(|_| {
            deliverable_command_error("deliverable_picker_failed", "无法选择保存位置。请重试。")
        })
}

#[cfg(not(target_os = "android"))]
pub(crate) async fn pick_save_destination(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<Option<FilePath>, CommandError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(name.to_owned())
        .save_file(move |destination| {
            let _ = sender.send(destination);
        });
    receiver.await.map_err(|_| {
        deliverable_command_error("deliverable_picker_failed", "无法选择保存位置。请重试。")
    })
}

#[cfg(windows)]
pub(crate) fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

pub(crate) fn commit_staged_to_path(
    staging_path: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    if staging_path.parent() == destination.parent() {
        return replace_file_atomically(staging_path, destination);
    }
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination has no parent",
        )
    })?;
    let sibling = parent.join(format!(".aludock-download-{}.part", uuid::Uuid::new_v4()));
    let copy_result = (|| {
        let mut source = std::fs::File::open(staging_path)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut target = options.open(&sibling)?;
        std::io::copy(&mut source, &mut target)?;
        target.flush()?;
        target.sync_all()?;
        replace_file_atomically(&sibling, destination)
    })();
    if copy_result.is_err() {
        let _ = fs::remove_file(&sibling);
    }
    copy_result
}

pub(crate) fn copy_staged_to_uri(
    app: &tauri::AppHandle,
    staging_path: &std::path::Path,
    destination: FilePath,
) -> std::io::Result<()> {
    let mut source = std::fs::File::open(staging_path)?;
    let mut options = PluginOpenOptions::new();
    options.write(true).truncate(true);
    let mut target = app.fs().open(destination.clone(), options)?;
    let copied = std::io::copy(&mut source, &mut target)?;
    if copied != source.metadata()?.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "saved byte count did not match the verified download",
        ));
    }
    target.flush()?;
    target.sync_all()?;
    Ok(())
}

#[cfg(target_os = "android")]
pub(crate) async fn discard_partial_uri(
    app: &tauri::AppHandle,
    destination: &FilePath,
) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    let FilePath::Url(url) = destination else {
        return Err("the Android save target was not a document URI".into());
    };
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "the Android application view was unavailable".to_string())?;
    let uri = url.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            platform_webview
                .jni_handle()
                .exec(move |env, activity, _webview| {
                    let result = (|| -> jni::errors::Result<bool> {
                        let resolver = env
                            .call_method(
                                activity,
                                "getContentResolver",
                                "()Landroid/content/ContentResolver;",
                                &[],
                            )?
                            .l()?;
                        let uri_text = JObject::from(env.new_string(uri)?);
                        let uri = env
                            .call_static_method(
                                "android/net/Uri",
                                "parse",
                                "(Ljava/lang/String;)Landroid/net/Uri;",
                                &[JValue::Object(&uri_text)],
                            )?
                            .l()?;
                        env.call_static_method(
                            "android/provider/DocumentsContract",
                            "deleteDocument",
                            "(Landroid/content/ContentResolver;Landroid/net/Uri;)Z",
                            &[JValue::Object(&resolver), JValue::Object(&uri)],
                        )?
                        .z()
                    })();
                    let outcome = match result {
                        Ok(true) => Ok(()),
                        Ok(false) => {
                            Err("the document provider did not remove the partial file".into())
                        }
                        Err(error) => Err(error.to_string()),
                    };
                    let _ = sender.send(outcome);
                });
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "timed out removing the partial document".to_string())?
        .map_err(|_| "the partial-document cleanup task ended unexpectedly".to_string())?
}

#[cfg(not(target_os = "android"))]
pub(crate) async fn discard_partial_uri(
    _app: &tauri::AppHandle,
    destination: &FilePath,
) -> Result<(), String> {
    let FilePath::Url(url) = destination else {
        return Err("the save target was not a URL".into());
    };
    let path = url
        .to_file_path()
        .map_err(|_| "the save URL cannot be removed as a local file".to_string())?;
    fs::remove_file(path).map_err(|error| error.to_string())
}

pub(crate) async fn commit_verified_file(
    app: &tauri::AppHandle,
    staging_path: PathBuf,
    destination: FilePath,
) -> Result<(), CommandError> {
    let commit_app = app.clone();
    let commit_staging = staging_path.clone();
    let commit_destination = destination.clone();
    let result = tokio::task::spawn_blocking(move || match &commit_destination {
        FilePath::Path(path) => commit_staged_to_path(&commit_staging, path),
        FilePath::Url(_) => copy_staged_to_uri(&commit_app, &commit_staging, commit_destination),
    })
    .await
    .map_err(|_| lifecycle_error())?;
    if let Err(error) = result {
        let cleanup_error = if matches!(destination, FilePath::Url(_)) {
            discard_partial_uri(app, &destination).await.err()
        } else {
            None
        };
        let _ = fs::remove_file(staging_path);
        return Err(CommandError {
            code: if cleanup_error.is_some() {
                "deliverable_cleanup_failed".into()
            } else {
                "deliverable_commit_failed".into()
            },
            message: if cleanup_error.is_some() {
                "文件未能完整保存，所选位置可能留有未完成的文件。请删除该文件后重试。".into()
            } else {
                DELIVERABLE_SAVE_FAILED_MESSAGE.into()
            },
            details: Some(serde_json::json!({
                "reason": error.to_string(),
                "cleanupError": cleanup_error,
            })),
            outcome_unknown: false,
            operation_id: None,
        });
    }
    if staging_path.exists() {
        let _ = fs::remove_file(staging_path);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_deliverables(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
) -> Result<Vec<DeliverableDto>, CommandError> {
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    dock_client(&runtime, &connection_id, selection_generation, &store)?
        .list_deliverables(&instance_id)
        .await
        .map_err(deliverable_list_error)
}

#[tauri::command]
pub(crate) async fn download_deliverable(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    connection_id: String,
    selection_generation: u64,
    instance_id: String,
    deliverable: DeliverableDto,
) -> Result<DeliverableSaveResult, CommandError> {
    deliverable.validate().map_err(deliverable_client_error)?;
    let store = resolve_connection_store(&runtime, &connection_id, selection_generation)?;
    let client = dock_client(&runtime, &connection_id, selection_generation, &store)?;
    #[cfg(not(mobile))]
    let destination = pick_save_destination(&app, &deliverable.name).await?;
    // The mobile dialog uses the platform create-document flow. Download and
    // verify in app-private storage first, then create the user-visible target.
    #[cfg(mobile)]
    let mut destination: Option<FilePath> = None;
    #[cfg(not(mobile))]
    if destination.is_none() {
        return Ok(DeliverableSaveResult::Cancelled);
    }
    let staging_path = delivery_staging_path(&app, destination.as_ref())?;
    let staging_file = create_delivery_staging_file(&staging_path)?;
    let mut staging_file = tokio::fs::File::from_std(staging_file);

    let progress_app = app.clone();
    let progress_host = connection_id.clone();
    let progress_instance = instance_id.clone();
    let progress_ref = deliverable.delivery_ref.clone();
    let result = client
        .download_deliverable(
            &instance_id,
            &deliverable.delivery_ref,
            &mut staging_file,
            move |DeliverableDownloadProgress {
                      bytes_received,
                      total_bytes,
                  }| {
                let _ = progress_app.emit(
                    "aludock://deliverable-progress",
                    DeliverableProgressEmission {
                        connection_id: progress_host.clone(),
                        selection_generation,
                        instance_id: progress_instance.clone(),
                        delivery_ref: progress_ref.clone(),
                        bytes_received,
                        total_bytes,
                    },
                );
            },
        )
        .await;
    let result = match result {
        Ok(result) if result.deliverable == deliverable => result,
        Ok(_) => {
            drop(staging_file);
            let _ = fs::remove_file(&staging_path);
            return Err(deliverable_command_error(
                "deliverable_verification_failed",
                "下载的文件与列表中的信息不一致。请刷新列表后重试。",
            ));
        }
        Err(error) => {
            drop(staging_file);
            let _ = fs::remove_file(&staging_path);
            return Err(deliverable_client_error(error));
        }
    };
    if staging_file.sync_all().await.is_err() {
        drop(staging_file);
        let _ = fs::remove_file(&staging_path);
        return Err(deliverable_command_error(
            "deliverable_write_failed",
            DELIVERABLE_SAVE_FAILED_MESSAGE,
        ));
    }
    drop(staging_file);
    #[cfg(mobile)]
    {
        destination = match pick_save_destination(&app, &deliverable.name).await {
            Ok(destination) => destination,
            Err(error) => {
                let _ = fs::remove_file(&staging_path);
                return Err(error);
            }
        };
        if destination.is_none() {
            let _ = fs::remove_file(&staging_path);
            return Ok(DeliverableSaveResult::Cancelled);
        }
    }
    let destination = destination.expect("save cancellation returned before commit");
    let saved_location = match describe_saved_location(&destination, &deliverable.name) {
        Ok(location) => location,
        Err(error) => {
            let _ = fs::remove_file(&staging_path);
            return Err(error);
        }
    };
    commit_verified_file(&app, staging_path, destination.clone()).await?;
    #[cfg(target_os = "android")]
    if let FilePath::Url(url) = &destination {
        // Providers may revoke transient grants after the Activity is gone. Keep the
        // document readable across app restarts when the provider supports it.
        let _ = android_documents::retain_document_access(&app, url.as_str()).await;
    }

    Ok(DeliverableSaveResult::Saved {
        deliverable: result.deliverable,
        location: saved_location,
        sha256: result.sha256,
    })
}

#[tauri::command]
pub(crate) async fn open_saved_deliverable(
    app: tauri::AppHandle,
    location: SavedDeliverableLocation,
) -> Result<(), CommandError> {
    if location.value.is_empty() {
        return Err(deliverable_command_error(
            "saved_file_unavailable",
            SAVED_FILE_UNAVAILABLE_MESSAGE,
        ));
    }
    match location.kind.as_str() {
        "path" => {
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            {
                let path = PathBuf::from(&location.value);
                let directory =
                    path.parent()
                        .filter(|parent| parent.is_dir())
                        .ok_or_else(|| {
                            deliverable_command_error(
                                "saved_location_unavailable",
                                "保存位置已不可用。请重新下载文件并选择保存位置。",
                            )
                        })?;
                let directory = directory.to_str().ok_or_else(|| {
                    deliverable_command_error(
                        "saved_location_unsupported",
                        "无法使用这个保存位置。请重新下载文件并选择其他位置。",
                    )
                })?;
                app.opener()
                    .open_path(directory, None::<&str>)
                    .map_err(|_| {
                        deliverable_command_error(
                            "saved_location_open_failed",
                            "暂时无法打开保存位置。请稍后重试。",
                        )
                    })?;
            }
            #[cfg(target_os = "ios")]
            app.opener()
                .open_path(location.value, None::<&str>)
                .map_err(|_| {
                    deliverable_command_error(
                        "saved_file_open_failed",
                        SAVED_FILE_UNAVAILABLE_MESSAGE,
                    )
                })?;
            #[cfg(target_os = "android")]
            {
                Err(deliverable_command_error(
                    "saved_file_unavailable",
                    "文件已不在保存位置。请重新下载。",
                ))
            }
            #[cfg(not(target_os = "android"))]
            {
                Ok(())
            }
        }
        "uri" => {
            #[cfg(target_os = "android")]
            {
                let media_type = mime_guess::from_path(&location.label).first_raw();
                return match android_documents::open_document(&app, &location.value, media_type)
                    .await
                    .map_err(|_| {
                        deliverable_command_error(
                            "saved_file_open_failed",
                            "暂时无法打开这个文件。请稍后重试。",
                        )
                    })? {
                    android_documents::OpenDocumentOutcome::Opened => Ok(()),
                    android_documents::OpenDocumentOutcome::Unavailable => {
                        Err(deliverable_command_error(
                            "saved_file_unavailable",
                            "文件已不在保存位置。请重新下载。",
                        ))
                    }
                    android_documents::OpenDocumentOutcome::NoHandler => {
                        Err(deliverable_command_error(
                            "saved_file_no_handler",
                            "没有可用的应用打开这个文件。",
                        ))
                    }
                    android_documents::OpenDocumentOutcome::Failed => {
                        Err(deliverable_command_error(
                            "saved_file_open_failed",
                            "暂时无法打开这个文件。请稍后重试。",
                        ))
                    }
                };
            }
            #[cfg(not(target_os = "android"))]
            app.opener()
                .open_url(location.value, None::<&str>)
                .map_err(|_| {
                    deliverable_command_error(
                        "saved_file_unavailable",
                        SAVED_FILE_UNAVAILABLE_MESSAGE,
                    )
                })
        }
        _ => Err(deliverable_command_error(
            "saved_file_unavailable",
            SAVED_FILE_UNAVAILABLE_MESSAGE,
        )),
    }
}
