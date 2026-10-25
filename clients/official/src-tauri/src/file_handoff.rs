//! Files the system hands to the window: dropped on it, or copied in a file
//! manager and pasted. Paths come only from the OS drop event or clipboard; the
//! WebView names a drop by number and never supplies a path. Both are staged
//! exactly like picked files.
use crate::attachment_import::{SelectedAttachment, attachment_command_error, stage_local_files};
use crate::connection_state::{ConnectionRuntimeState, resolve_connection_store};
use crate::errors::{CommandError, lifecycle_error};
use aludock_client_core::AttachmentState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{DragDropEvent, Emitter, Manager, Runtime, WindowEvent};

pub(crate) const FILE_DRAG_EVENT: &str = "aludock://file-drag";

const MSG_DROP_UNAVAILABLE: &str = "拖入的文件已失效，请重新拖入。";

/// The latest drop, kept until the WebView takes it. A newer drop replaces it.
#[derive(Default)]
pub(crate) struct DroppedFiles(Mutex<(u64, Option<Vec<PathBuf>>)>);

impl DroppedFiles {
    pub(crate) fn record(&self, paths: Vec<PathBuf>) -> Option<u64> {
        let mut latest = self.0.lock().ok()?;
        latest.0 += 1;
        latest.1 = Some(paths);
        Some(latest.0)
    }

    fn take(&self, drop_id: u64) -> Option<Vec<PathBuf>> {
        let mut latest = self.0.lock().ok()?;
        if latest.0 == drop_id {
            latest.1.take()
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum FileDrag {
    Over,
    Left,
    Dropped {
        #[serde(rename = "dropId")]
        drop_id: u64,
    },
}

/// Turns the window's file drag into `FILE_DRAG_EVENT`. Drags without files
/// (text from another app) are not offered as attachments.
pub(crate) fn file_drag<R: Runtime>(
    window: &tauri::Window<R>,
    event: &WindowEvent,
) -> Option<FileDrag> {
    let WindowEvent::DragDrop(event) = event else {
        return None;
    };
    Some(match event {
        DragDropEvent::Enter { paths, .. } if !paths.is_empty() => FileDrag::Over,
        DragDropEvent::Drop { paths, .. } if !paths.is_empty() => {
            match window.state::<DroppedFiles>().record(paths.clone()) {
                Some(drop_id) => FileDrag::Dropped { drop_id },
                None => FileDrag::Left,
            }
        }
        DragDropEvent::Leave | DragDropEvent::Drop { .. } => FileDrag::Left,
        _ => return None,
    })
}

pub(crate) fn handle_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if window.label() == "main"
        && let Some(drag) = file_drag(window, event)
    {
        let _ = window.emit(FILE_DRAG_EVENT, drag);
    }
}

#[tauri::command]
pub(crate) async fn stage_dropped_files(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    drops: tauri::State<'_, DroppedFiles>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
    drop_id: u64,
) -> Result<Vec<SelectedAttachment>, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let paths = drops.take(drop_id).ok_or_else(|| {
        attachment_command_error("attachment_drop_unavailable", MSG_DROP_UNAVAILABLE)
    })?;
    stage_local_files(
        &runtime,
        &state,
        connection_id,
        selection_generation,
        work_id,
        paths,
    )
    .await
}

/// `None` when the clipboard holds no copied files, so the WebView can use the
/// pasted image data instead.
#[tauri::command]
pub(crate) async fn stage_clipboard_files(
    runtime: tauri::State<'_, ConnectionRuntimeState>,
    state: tauri::State<'_, AttachmentState>,
    connection_id: String,
    selection_generation: u64,
    work_id: String,
) -> Result<Option<Vec<SelectedAttachment>>, CommandError> {
    drop(resolve_connection_store(
        &runtime,
        &connection_id,
        selection_generation,
    )?);
    let Some(paths) = tokio::task::spawn_blocking(copied_files)
        .await
        .map_err(|_| lifecycle_error())?
    else {
        return Ok(None);
    };
    stage_local_files(
        &runtime,
        &state,
        connection_id,
        selection_generation,
        work_id,
        paths,
    )
    .await
    .map(Some)
}

// An unreadable clipboard counts as "no files": a screenshot paste must still work.
#[cfg(desktop)]
fn copied_files() -> Option<Vec<PathBuf>> {
    let paths = arboard::Clipboard::new().ok()?.get().file_list().ok()?;
    (!paths.is_empty()).then_some(paths)
}

#[cfg(mobile)]
fn copied_files() -> Option<Vec<PathBuf>> {
    None
}
