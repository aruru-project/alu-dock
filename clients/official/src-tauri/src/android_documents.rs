use serde::Deserialize;
use tauri::{
    AppHandle, Manager, Runtime, Wry,
    plugin::{Builder, PluginHandle, TauriPlugin},
};
use tauri_plugin_dialog::FilePath;

const PLUGIN_IDENTIFIER: &str = "moe.aruru.aludock.client";

#[derive(Debug)]
struct AndroidDocuments<R: Runtime>(PluginHandle<R>);

#[derive(Deserialize)]
struct PickFilesResponse {
    files: Vec<FilePath>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum SaveDocumentResponse {
    Cancelled,
    Selected { file: FilePath },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenDocumentResponse {
    outcome: String,
}

#[derive(Deserialize)]
struct RetainDocumentResponse {
    retained: bool,
}

pub enum OpenDocumentOutcome {
    Opened,
    Unavailable,
    NoHandler,
    Failed,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-documents")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin(PLUGIN_IDENTIFIER, "AndroidDocumentsPlugin")?;
            app.manage(AndroidDocuments(handle));
            Ok(())
        })
        .build()
}

pub async fn pick_recent_files(app: &AppHandle<Wry>) -> Result<Vec<FilePath>, String> {
    app.state::<AndroidDocuments<Wry>>()
        .0
        .run_mobile_plugin_async::<PickFilesResponse>("pickRecentFiles", ())
        .await
        .map(|response| response.files)
        .map_err(|error| error.to_string())
}

pub async fn save_document(app: &AppHandle<Wry>, name: &str) -> Result<Option<FilePath>, String> {
    app.state::<AndroidDocuments<Wry>>()
        .0
        .run_mobile_plugin_async::<SaveDocumentResponse>(
            "saveDocument",
            serde_json::json!({ "name": name }),
        )
        .await
        .map(|response| match response {
            SaveDocumentResponse::Cancelled => None,
            SaveDocumentResponse::Selected { file } => Some(file),
        })
        .map_err(|error| error.to_string())
}

pub async fn retain_document_access(app: &AppHandle<Wry>, uri: &str) -> bool {
    app.state::<AndroidDocuments<Wry>>()
        .0
        .run_mobile_plugin_async::<RetainDocumentResponse>(
            "retainDocumentAccess",
            serde_json::json!({ "uri": uri }),
        )
        .await
        .map(|response| response.retained)
        .unwrap_or(false)
}

pub async fn open_document(
    app: &AppHandle<Wry>,
    uri: &str,
    media_type: Option<&str>,
) -> Result<OpenDocumentOutcome, String> {
    let response = app
        .state::<AndroidDocuments<Wry>>()
        .0
        .run_mobile_plugin_async::<OpenDocumentResponse>(
            "openDocument",
            serde_json::json!({ "uri": uri, "mediaType": media_type }),
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(match response.outcome.as_str() {
        "opened" => OpenDocumentOutcome::Opened,
        "unavailable" => OpenDocumentOutcome::Unavailable,
        "noHandler" => OpenDocumentOutcome::NoHandler,
        _ => OpenDocumentOutcome::Failed,
    })
}
