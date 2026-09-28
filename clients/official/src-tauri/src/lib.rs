use crate::away::AwayMonitorState;
use crate::connection::PairingTaskState;
use crate::connection_state::ConnectionRuntimeState;
use crate::media::conversation_media_response;
use crate::observation::FollowState;
use crate::workspace_files::WorkspaceFileState;
use aludock_client_core::{
    AttachmentState, CommandReferenceState, ExtensionControlState, SessionTokenState,
};
use tauri::{Emitter, Manager};

#[cfg(target_os = "android")]
mod android_documents;
mod attachment_import;
mod away;
mod configuration;
mod connection;
mod connection_state;
mod desktop_shell;
mod errors;
mod extension;
mod file_delivery;
mod media;
#[cfg(test)]
mod native_tests;
mod observation;
mod sessions;
mod work;
mod workspace_files;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(AwayMonitorState::default());
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if args.iter().any(|argument| argument == "--background") {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_documents::init());
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "windows")]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--background"])
                .build(),
        )
        .on_window_event(|window, event| {
            desktop_shell::handle_window_event(window, event);
            if window.label() == "main"
                && let tauri::WindowEvent::Focused(focused) = event
            {
                let monitor = window.state::<AwayMonitorState>();
                if *focused {
                    let _ = monitor.stop(None);
                    let _ = window.request_user_attention(None);
                }
            }
        });

    builder
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                webview.state::<PairingTaskState>().cancel_all();
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<PairingTaskState>().cancel_all();
            }
        })
        .register_asynchronous_uri_scheme_protocol(
            "aludock-media",
            |context, request, responder| {
                let content = context
                    .app_handle()
                    .state::<FollowState>()
                    .observation
                    .content
                    .clone();
                // File delivery is off the WebView/UI thread, bypasses binary IPC,
                // and resolves only this App's opaque, verified index entries.
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(conversation_media_response(&content, request))
                });
            },
        )
        .setup(|app| {
            #[cfg(mobile)]
            let application_data_dir = Some(app.path().app_local_data_dir()?);
            #[cfg(not(mobile))]
            let application_data_dir = None;
            app.manage(ConnectionRuntimeState::open(application_data_dir)?);
            let content = aludock_client_core::SessionContent::in_directory(
                app.path().app_cache_dir()?.join("conversation-observation"),
            )?;
            app.manage(content.restored_images());
            app.manage(content.clone());
            app.manage(AttachmentState::new(content.clone()));
            app.manage(FollowState {
                observation: aludock_client_core::ConversationObservation::new(content),
                ..Default::default()
            });
            let desktop_shell = desktop_shell::DesktopShellState::initialize(app);
            app.manage(desktop_shell);
            app.manage(WorkspaceFileState::open(
                app.path().app_cache_dir()?.join("workspace-preview"),
            )?);
            let operations = aludock_client_core::OperationAssociations::default();
            let mut updates = operations.subscribe();
            let handle = app.handle().clone();
            let retained = operations.clone();
            app.manage(operations);
            tauri::async_runtime::spawn(async move {
                loop {
                    match updates.recv().await {
                        Ok(operation) => {
                            let _ = handle.emit("aludock://operation", operation);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            for operation in retained.pending() {
                                let _ = handle.emit("aludock://operation", operation);
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            desktop_shell::finish_setup(app)?;
            Ok(())
        })
        .manage(ExtensionControlState::default())
        .manage(PairingTaskState::default())
        .manage(SessionTokenState::default())
        .manage(CommandReferenceState::default())
        .invoke_handler(tauri::generate_handler![
            connection::system_device_name,
            desktop_shell::desktop_shell_status,
            desktop_shell::start_desktop_host,
            desktop_shell::open_desktop_host_log,
            desktop_shell::open_desktop_tui,
            away::get_client_preferences,
            away::update_client_preferences,
            away::begin_windows_away,
            away::cancel_windows_away,
            connection::get_host_catalog,
            connection::connect_local_dock,
            connection::set_local_endpoint,
            connection::set_active_host,
            connection::remove_saved_host,
            connection::start_pairing,
            connection::cancel_pairing,
            connection::reselect_host_route,
            connection::bootstrap,
            connection::work_catalog,
            observation::read_conversation_content,
            media::conversation_image,
            media::inline_conversation_image,
            media::published_image,
            media::save_preview_image,
            file_delivery::list_deliverables,
            file_delivery::download_deliverable,
            file_delivery::open_saved_deliverable,
            observation::start_conversation_follow,
            observation::acknowledge_conversation_follow,
            observation::stop_conversation_follow,
            extension::acquire_extension_control,
            extension::release_extension_control,
            extension::respond_extension_interaction,
            extension::set_extension_widget_viewport,
            attachment_import::pick_attachments,
            attachment_import::stage_clipboard_image,
            attachment_import::attachment_preview,
            attachment_import::upload_attachment,
            attachment_import::attachment_snapshot,
            attachment_import::cancel_attachment_upload,
            attachment_import::remove_attachment,
            work::submit_message,
            work::pending_operations,
            work::consume_operation,
            work::dequeue_messages,
            work::clear_restored_images,
            work::restored_image_count,
            work::abort_run,
            work::stop_work,
            configuration::command_catalog,
            configuration::command_content,
            configuration::command_completions,
            configuration::run_catalog_command,
            configuration::list_models,
            configuration::set_model,
            configuration::set_thinking,
            configuration::list_tools,
            configuration::set_active_tools,
            configuration::get_settings,
            configuration::update_setting,
            configuration::get_resources,
            configuration::resource_content,
            work::reopen_work,
            work::forget_work,
            connection::verify_host_endpoint,
            connection::save_unverified_host_endpoint,
            connection::test_host_endpoint,
            connection::rename_host_profile,
            connection::set_connection_policy,
            connection::set_host_endpoint_enabled,
            connection::reorder_host_endpoints,
            connection::delete_host_endpoint,
            workspace_files::workspace_entries,
            workspace_files::workspace_entry_metadata,
            workspace_files::read_workspace_file,
            workspace_files::cancel_workspace_file_read,
            workspace_files::clear_workspace_file_state,
            workspace_files::workspace_cached_text,
            workspace_files::workspace_cached_image,
            workspace_files::save_workspace_cached_file,
            work::list_machines,
            work::list_workspace,
            work::system_catalog,
            work::system_content,
            work::set_system_default,
            sessions::list_sessions,
            sessions::session_inventory,
            work::adopt_session,
            sessions::new_session,
            sessions::switch_session,
            sessions::name_session,
            sessions::compaction_prompts,
            sessions::compact_session,
            sessions::reload_session,
            sessions::session_tree,
            sessions::navigate_session,
            sessions::fork_session,
            sessions::clone_session,
            work::create_work
        ])
        .run(tauri::generate_context!())
        .expect("error while running AluDock Client");
}
