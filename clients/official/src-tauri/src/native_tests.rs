use crate::attachment_import::*;
use crate::away::*;
use crate::connection::*;
use crate::connection_state::*;
use crate::errors::*;
use crate::file_delivery::*;
use crate::media::*;
use crate::observation::*;
use crate::workspace_files::*;
use aludock_client_core::*;
use serde_json::Value;
use std::time::Duration;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicU64},
};

use std::fs;

#[test]
fn media_uri_serves_only_verified_opaque_handles_not_paths() {
    let root = std::env::temp_dir().join(format!("aludock-media-uri-{}", uuid::Uuid::new_v4()));
    let content = aludock_client_core::SessionContent::in_directory(root.clone()).unwrap();
    let scope = aludock_client_core::MediaScope {
        authority: "local:test".into(),
        instance_id: "work".into(),
        host_epoch: "epoch".into(),
        runtime_generation: 1,
    };
    let data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let media = content
        .inline_image(scope.clone(), "image/png", data)
        .unwrap();
    let other_domain = aludock_client_core::MediaScope {
        host_epoch: "later-epoch".into(),
        ..scope
    };
    assert_eq!(
        content
            .inline_image(other_domain, "image/png", data)
            .unwrap()
            .handle,
        media.handle,
        "verified bytes outlive request domains"
    );
    let response = conversation_media_response(
        &content,
        tauri::http::Request::builder()
            .uri(format!("aludock-media://localhost/{}", media.handle))
            .body(Vec::new())
            .unwrap(),
    );
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.body().len(), 68);
    assert!(response.body().starts_with(b"\x89PNG\r\n\x1a\n"));
    // Frozen-media regression: <img> worked but save's fetch lacked both
    // connect-src permission and an exact App-origin CORS response.
    for origin in [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ] {
        let response = conversation_media_response(
            &content,
            tauri::http::Request::builder()
                .uri(format!("aludock-media://localhost/{}", media.handle))
                .header("Origin", origin)
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(response.headers()["access-control-allow-origin"], origin);
        assert_eq!(response.headers()["vary"], "Origin");
        assert_eq!(response.body().len(), 68);
    }
    let untrusted = conversation_media_response(
        &content,
        tauri::http::Request::builder()
            .uri(format!("aludock-media://localhost/{}", media.handle))
            .header("Origin", "https://untrusted.example")
            .body(Vec::new())
            .unwrap(),
    );
    assert!(
        !untrusted
            .headers()
            .contains_key("access-control-allow-origin"),
        "a web page cannot read App-private media"
    );
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let connect = config["app"]["security"]["csp"]
        .as_str()
        .unwrap()
        .split(';')
        .find(|rule| rule.trim().starts_with("connect-src "))
        .unwrap();
    for source in [
        "aludock-media:",
        "http://aludock-media.localhost",
        "https://aludock-media.localhost",
    ] {
        assert!(connect.split_whitespace().any(|allowed| allowed == source));
    }
    // Arbitrary file access is a security boundary, not a path sanitiser.
    for path in ["/etc/passwd", "/../owner", "/unknown-handle"] {
        let response = conversation_media_response(
            &content,
            tauri::http::Request::builder()
                .uri(path)
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(response.status(), 404);
        assert!(response.body().is_empty());
    }
    drop(content);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn command_errors_keep_safe_decoding_reason_for_diagnostics() {
    let parsing_error = serde_json::from_str::<Value>("{").unwrap_err();
    let command_error = CommandError::from(ClientError::Json(parsing_error));
    let serialized = serde_json::to_value(&command_error).unwrap();
    let reason = serialized["details"]["reason"].as_str().unwrap();

    assert_eq!(serialized["code"], "client_error");
    assert!(reason.contains("EOF"));
    assert!(!command_error.message.contains(reason));

    let protocol_error = CommandError::from(ClientError::Protocol("missing version".into()));
    assert_eq!(
        protocol_error.details,
        Some(serde_json::json!({ "reason": "missing version" }))
    );
}

#[test]
fn command_projection_keeps_owner_path_behind_an_opaque_reference() {
    let state = CommandReferenceState::default();
    let scope = CommandReferenceScope {
        connection_id: "host-1".into(),
        selection_generation: 7,
        instance_id: "work-1".into(),
    };
    let reference_generation = state.begin(&scope);
    let projected = project_commands(
        CommandsResult {
            commands: vec![CommandInfo {
                name: "idea".into(),
                description: Some("Generate ideas".into()),
                source: SourceInfo {
                    kind: aludock_client_core::SourceKind::Prompt,
                    path: Some("/worker/private/prompts/idea.md".into()),
                    package: None,
                },
                argument_hint: Some("[topic]".into()),
                argument_completions: false,
                content_available: Some(true),
            }],
            total: 1,
            truncated: false,
        },
        &state,
        scope.clone(),
        reference_generation,
    )
    .expect("project current command catalog");

    let json = serde_json::to_string(&projected).expect("serialize projected commands");
    assert!(!json.contains("/worker/private"));
    assert!(json.contains("referenceId"));
    let reference_id = &projected.commands[0].reference_id;
    let resolved = state
        .resolve(&scope, reference_id)
        .expect("resolve opaque reference");
    assert_eq!(resolved.name, "idea");
    assert_eq!(
        resolved.source.path.as_deref(),
        Some("/worker/private/prompts/idea.md")
    );

    let stale_generation = state.begin(&scope);
    let _current_generation = state.begin(&scope);
    let stale = project_commands(
        CommandsResult {
            commands: Vec::new(),
            total: 0,
            truncated: false,
        },
        &state,
        scope,
        stale_generation,
    );
    assert!(
        stale.is_err(),
        "a superseded catalog must not return unresolved references"
    );
}

#[test]
fn only_a_complete_staged_download_replaces_the_saved_file() {
    let root = std::env::temp_dir().join(format!(
        "aludock-deliverable-commit-{}",
        uuid::Uuid::new_v4()
    ));
    let cache = root.join("cache");
    let downloads = root.join("downloads");
    fs::create_dir_all(&cache).unwrap();
    fs::create_dir_all(&downloads).unwrap();
    let destination = downloads.join("result.bin");
    fs::write(&destination, b"existing").unwrap();

    assert!(commit_staged_to_path(&cache.join("missing.part"), &destination).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"existing");

    let completed = cache.join("complete.part");
    fs::write(&completed, b"verified").unwrap();
    commit_staged_to_path(&completed, &destination).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"verified");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_cache_is_bound_to_the_current_work_context_and_replaced_on_new_read() {
    let root =
        std::env::temp_dir().join(format!("aludock-workspace-cache-{}", uuid::Uuid::new_v4()));
    let state = WorkspaceFileState::open(root.clone()).unwrap();
    let cache_path = root.join("verified.cache");
    fs::write(&cache_path, b"source").unwrap();
    let entry = WorkspaceFileEntry {
        path: "src/main.rs".into(),
        name: "main.rs".into(),
        kind: aludock_client_core::WorkspaceFileKind::File,
        hidden: false,
        target_kind: None,
        size_bytes: Some(6),
    };
    let read_id = uuid::Uuid::new_v4().to_string();
    state
        .begin(read_id.clone(), "host".into(), 4, "work".into())
        .unwrap();
    assert!(
        state
            .finish(
                &read_id,
                CachedWorkspaceFile {
                    cache_id: read_id.clone(),
                    connection_id: "host".into(),
                    selection_generation: 4,
                    instance_id: "work".into(),
                    runtime_generation: 9,
                    path: entry.path.clone(),
                    file_path: cache_path.clone(),
                    result: WorkspaceFileReadResult {
                        entry,
                        chunks: 1,
                        size_bytes: 6,
                        sha256: "41cf6794ba4200b839c472f85a30fa47fef75a7640bdda405950b887ad1e2d58"
                            .into(),
                        host_epoch: "epoch".into(),
                    },
                },
            )
            .unwrap()
    );
    assert!(
        state
            .cached("host", 4, "work", "epoch", 9, &read_id)
            .is_ok()
    );
    assert!(
        state
            .cached("host", 4, "work", "new-epoch", 9, &read_id)
            .is_err()
    );

    state
        .begin(
            uuid::Uuid::new_v4().to_string(),
            "host".into(),
            4,
            "work".into(),
        )
        .unwrap();
    assert!(!cache_path.exists());
    assert!(
        state
            .cached("host", 4, "work", "epoch", 9, &read_id)
            .is_err()
    );
    state.clear().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn work_finishing_before_the_first_away_read_notifies_at_the_chosen_time() {
    let mut tracker = AwayCompletionTracker::from_running_instance_ids(&["work-a".into()]);
    tracker.observe(&[AwayInstanceState {
        instance_id: "work-a".into(),
        display_name: "Windows 客户端".into(),
        execution: InstanceExecution::Idle,
    }]);

    let grace = WindowsAwayDelay::FiveMinutes.duration().unwrap();
    assert!(
        tracker
            .take_ready(Duration::from_secs(299), grace)
            .is_empty()
    );
    assert_eq!(
        tracker.take_ready(Duration::from_secs(300), grace),
        vec![AwayCompletion {
            instance_id: "work-a".into(),
            display_name: "Windows 客户端".into(),
        }]
    );
}

#[test]
fn remote_media_must_be_a_matching_safe_raster_image() {
    assert!(validate_renderable_image(b"\x89PNG\r\n\x1a\nbody", Some("image/png")).is_ok());
    assert!(
        validate_renderable_image(
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            Some("image/svg+xml")
        )
        .is_err()
    );
    assert!(validate_renderable_image(b"GIF89abody", Some("image/png")).is_err());
}

#[test]
fn saving_a_preview_uses_its_visible_name_and_actual_image_format() {
    let decoded = "结果 图.png";
    assert_eq!(
        preview_image_save_name(&decoded, "image/png"),
        "结果 图.png"
    );
    assert_eq!(
        preview_image_save_name("result.png", "image/jpeg"),
        "result.jpg"
    );
    assert_eq!(
        preview_image_save_name("aludock-image", "image/webp"),
        "aludock-image.webp"
    );
}

fn endpoint_runtime(name: &str) -> (PathBuf, ConnectionRuntimeState, String) {
    let path = std::env::temp_dir().join(format!(
        "aludock-tauri-endpoint-{name}-{}",
        uuid::Uuid::new_v4()
    ));
    let host = aludock_client_core::ClientIdentity::generate().unwrap();
    let host_id = aludock_client_core::host_id(host.certificate_der());
    let registry = HostRegistry::open(&path).unwrap();
    let identity = aludock_client_core::ClientIdentity::generate().unwrap();
    let home = path.join("hosts").join(&host_id);
    let ig = "identity-11111111-1111-4111-8111-111111111111";
    let pg = "pairing-22222222-2222-4222-8222-222222222222";
    let write = |path: PathBuf, bytes: &[u8]| {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
        }
    };
    // Hand-written current successful layout; no test-only production save API.
    write(
        home.join("state").join(ig).join("client-certificate.der"),
        identity.certificate_der(),
    );
    write(
        home.join("state").join(ig).join("client-private-key.der"),
        identity.private_key_der(),
    );
    write(
        home.join("state").join(pg).join("host-certificate.der"),
        host.certificate_der(),
    );
    write(home.join("client-identity-manifest.json"), serde_json::json!({"schemaVersion":1,"generation":ig,"clientFingerprint":identity.fingerprint()}).to_string().as_bytes());
    write(
        home.join("pairing-manifest.json"),
        serde_json::json!({"schemaVersion":1,"generation":pg})
            .to_string()
            .as_bytes(),
    );
    write(
        home.join("client-id"),
        b"33333333-3333-4333-8333-333333333333\n",
    );
    write(home.join("state").join(pg).join("pairing-metadata.json"), serde_json::json!({"schemaVersion":1,"endpoint":{"host":"192.168.1.8","port":33781},"deviceName":"Test device","clientId":"33333333-3333-4333-8333-333333333333","clientFingerprint":identity.fingerprint()}).to_string().as_bytes());
    write(path.join("host-registry/registry-00000000000000000001.json"),
        serde_json::json!({"schemaVersion": 2, "revision": 1, "activeHostId": host_id, "localSelected": false,
            "hosts": [{"hostId": host_id, "addedAt": "2026-09-01T00:00:00Z"}]}).to_string().as_bytes());
    let preferences =
        ClientPreferencesStore::open(registry.root().join("client-preferences")).unwrap();
    let runtime = ConnectionRuntimeState {
        registry,
        preferences,
        local_identity: IdentityStore::new(path.join("local-client-identity")),
        lifecycle: Arc::new(Mutex::new(RuntimeLifecycle {
            active_target: Some(ConnectionTarget::Host {
                host_id: host_id.clone(),
            }),
            selection_generation: 1,
        })),
        selected_client: Arc::new(Mutex::new(None)),
    };
    (path, runtime, host_id)
}

// Android staging regression: network notifications invoke this command from a
// thread without an entered Tokio runtime. Do not use #[tokio::test], which
// would hide the crashing IPC boundary.
#[test]
fn switching_host_addresses_through_ipc_rebinds_without_crashing() {
    assert!(tokio::runtime::Handle::try_current().is_err());
    let (path, runtime, host_id) = endpoint_runtime("route-ipc");
    let lan = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let wan = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
    let original = store.load_connection_profile().unwrap().unwrap();
    store
        .update_connection_profile_at(original.revision, |profile| {
            profile.endpoints[0].endpoint = lan.local_addr().unwrap().to_string().parse().unwrap();
            let mut remote = profile.endpoints[0].clone();
            remote.id = uuid::Uuid::new_v4().to_string();
            remote.endpoint = wan.local_addr().unwrap().to_string().parse().unwrap();
            profile.endpoints.push(remote);
            Ok(())
        })
        .unwrap();
    let content = aludock_client_core::SessionContent::in_directory(path.join("content")).unwrap();
    let key = observation_key(&runtime, &host_id, "work", "epoch").unwrap();
    let follow = FollowState {
        observation: aludock_client_core::ConversationObservation::new(content),
        ..Default::default()
    };
    *follow.task.lock().unwrap() = Some(FollowTask {
        delivery: Arc::new(AtomicU64::new(0)),
        acknowledge: tokio::sync::watch::channel(0).0,
        content_key: key.clone(),
        host_epoch: "epoch".into(),
        handle: tauri::async_runtime::spawn(std::future::pending()),
        connection_id: host_id.clone(),
        selection_generation: 1,
        instance_id: "work".into(),
        subscription_id: "view".into(),
    });
    let app = tauri::test::mock_builder()
        .manage(runtime)
        .manage(follow.clone())
        .invoke_handler(tauri::generate_handler![
            crate::connection::reselect_host_route
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |command: &str, body: Value| {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .unwrap()
    };
    // Repeated network changes. Only loopback listeners owned by this test can
    // receive connection attempts.
    for _ in 0..3 {
        let _: bool = invoke(
            "reselect_host_route",
            serde_json::json!({
                "connectionId": host_id, "selectionGeneration": 1,
            }),
        )
        .deserialize()
        .unwrap();
        assert!(follow.task.lock().unwrap().is_some());
        assert!(follow.observation.content.bind(&key).is_ok());
        assert!(tokio::runtime::Handle::try_current().is_err());
    }
    follow.abort_matching(&host_id, 1, "work", None).unwrap();
    drop(webview);
    drop(app);
    drop(follow);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn selected_host_commands_share_one_router_instance() {
    let (path, runtime, host_id) = endpoint_runtime("shared-router");
    let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
    let first = dock_client(&runtime, &host_id, 1, &store).unwrap();
    let second = dock_client(&runtime, &host_id, 1, &store).unwrap();

    first.router().close();

    assert!(second.router().snapshot().closed);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn first_packaged_main_launch_selects_the_local_dock_without_pairing() {
    let root = std::env::temp_dir().join(format!(
        "aludock-desktop-first-main-{}",
        uuid::Uuid::new_v4()
    ));
    let runtime = ConnectionRuntimeState::open(Some(root.clone())).unwrap();
    runtime.select_initial_local().unwrap();
    let snapshot = runtime.registry.snapshot().unwrap();

    assert!(snapshot.local_selected);
    assert!(snapshot.active_host_id.is_none());
    assert_eq!(
        runtime.lifecycle.lock().unwrap().active_target,
        Some(ConnectionTarget::Local)
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn choosing_local_or_a_host_keeps_exactly_one_current_connection() {
    let host_b = "b".repeat(64);
    let mut lifecycle = RuntimeLifecycle {
        active_target: Some(ConnectionTarget::Host {
            host_id: "a".repeat(64),
        }),
        selection_generation: 4,
    };
    assert_eq!(lifecycle.transition_to_local().unwrap(), 5);
    assert_eq!(lifecycle.connection_id(), Some(LOCAL_CONNECTION_SCOPE_ID));
    assert_eq!(
        lifecycle.transition_to_host(Some(host_b.clone())).unwrap(),
        6
    );
    assert_eq!(lifecycle.connection_id(), Some(host_b.as_str()));
    assert_eq!(
        lifecycle.active_target,
        Some(ConnectionTarget::Host { host_id: host_b })
    );
}

#[test]
fn stale_selection_is_rejected_before_long_lived_registration() {
    let mut lifecycle = RuntimeLifecycle {
        active_target: Some(ConnectionTarget::Host {
            host_id: "a".repeat(64),
        }),
        selection_generation: 9,
    };
    assert!(ensure_connection_selection(&lifecycle, &"a".repeat(64), 9).is_ok());
    lifecycle.transition_to_host(Some("b".repeat(64))).unwrap();
    assert!(ensure_connection_selection(&lifecycle, &"a".repeat(64), 9).is_err());
    assert!(ensure_connection_selection(&lifecycle, &"b".repeat(64), 9).is_err());
}

#[test]
fn safe_dequeue_receipt_serializes_no_operation_id_or_image_path() {
    let receipt = SafeQueueDequeueReceipt {
        instance_id: "work".into(),
        restored: vec![ProjectedQueueItem {
            queue_item_id: "queue-item".into(),
            delivery: "followUp".into(),
            text: "restored".into(),
            attachments: Vec::new(),
            image_count: 1,
            accepted_at: "now".into(),
        }],
        in_flight: Vec::new(),
    };
    let value = serde_json::to_value(receipt).unwrap();
    assert!(value.get("operationId").is_none());
    assert_eq!(value["restored"][0]["imageCount"], 1);
    let encoded = serde_json::to_string(&value).unwrap();
    assert!(!encoded.contains("/native/"));
    assert!(!encoded.contains("operationId"));
}

#[test]
fn stale_picker_completion_cannot_publish_native_paths() {
    let host_id = "a".repeat(64);
    let lifecycle = Mutex::new(RuntimeLifecycle {
        active_target: Some(ConnectionTarget::Host {
            host_id: host_id.clone(),
        }),
        selection_generation: 7,
    });
    lifecycle
        .lock()
        .unwrap()
        .transition_to_host(Some("b".repeat(64)))
        .unwrap();
    let state = AttachmentState::default();
    let prepared = vec![(
        "token".into(),
        SelectedAttachment {
            token: "token".into(),
            name: "stale.png".into(),
            size_bytes: 1,
            media_type: Some("image/png".into()),
        },
        NativeAttachment::new(
            state.content.import_attachment(&b"x"[..]).unwrap(),
            host_id.clone(),
            "work".into(),
            "stale.png".into(),
            Some("image/png".into()),
        ),
    )];

    let private_path = prepared[0].2.source.path().to_owned();
    let error =
        publish_selected_attachments(&lifecycle, &state, &host_id, 7, prepared, "authority")
            .unwrap_err();
    assert_eq!(error.code, "stale_connection_selection");
    assert!(state.snapshot("authority", "work").jobs.is_empty());
    assert!(
        !private_path.exists(),
        "an obsolete picker must release its unaccepted import"
    );
}

#[test]
fn verified_endpoint_probe_cannot_persist_after_selection_generation_changes() {
    let (path, runtime, host_id) = endpoint_runtime("verify-selection-race");
    let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
    let before = store.load_connection_profile().unwrap().unwrap();
    runtime
        .lifecycle
        .lock()
        .unwrap()
        .transition_to_local()
        .unwrap();

    let result = persist_verified_host_endpoint(
        &runtime,
        &host_id,
        1,
        VerifiedEndpointMutation {
            endpoint: "dock.example:443".parse().unwrap(),
            label: "WAN".into(),
            expected_revision: before.revision,
        },
    );
    assert!(result.is_err());
    assert_eq!(store.load_connection_profile().unwrap().unwrap(), before);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn saved_endpoint_test_cannot_record_after_selection_generation_changes() {
    let (path, runtime, host_id) = endpoint_runtime("test-selection-race");
    let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
    let before = store.load_connection_profile().unwrap().unwrap();
    let endpoint_id = before.endpoints[0].id.clone();
    runtime
        .lifecycle
        .lock()
        .unwrap()
        .transition_to_local()
        .unwrap();

    let result =
        persist_host_endpoint_test(&runtime, &host_id, 1, &endpoint_id, before.revision, Ok(()));
    assert!(result.is_err());
    assert_eq!(store.load_connection_profile().unwrap().unwrap(), before);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn saved_endpoint_test_revalidates_profile_revision_before_cas() {
    let (path, runtime, host_id) = endpoint_runtime("test-revision-race");
    let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
    let before = store.load_connection_profile().unwrap().unwrap();
    let endpoint_id = before.endpoints[0].id.clone();
    let concurrent = store
        .update_connection_profile_at(before.revision, |profile| {
            profile.display_name = "Concurrent rename".into();
            Ok(())
        })
        .unwrap();

    let result =
        persist_host_endpoint_test(&runtime, &host_id, 1, &endpoint_id, before.revision, Ok(()));
    assert!(matches!(
        result,
        Err(CommandError { ref code, .. }) if code == "profile_conflict"
    ));
    assert_eq!(
        store.load_connection_profile().unwrap().unwrap(),
        concurrent
    );
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn verified_endpoint_probe_revalidates_profile_revision_before_cas() {
    let (path, runtime, host_id) = endpoint_runtime("verify-revision-race");
    let store = runtime.registry.resolve_store(Some(&host_id)).unwrap();
    let before = store.load_connection_profile().unwrap().unwrap();
    let concurrent = store
        .update_connection_profile_at(before.revision, |profile| {
            profile.display_name = "Concurrent rename".into();
            Ok(())
        })
        .unwrap();

    let result = persist_verified_host_endpoint(
        &runtime,
        &host_id,
        1,
        VerifiedEndpointMutation {
            endpoint: "dock.example:443".parse().unwrap(),
            label: "WAN".into(),
            expected_revision: before.revision,
        },
    );
    assert!(matches!(
        result,
        Err(CommandError { ref code, .. }) if code == "profile_conflict"
    ));
    assert_eq!(
        store.load_connection_profile().unwrap().unwrap(),
        concurrent
    );
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn stale_background_detach_keeps_the_new_foreground_follow() {
    let state = FollowState::default();
    *state.task.lock().unwrap() = Some(FollowTask {
        delivery: Arc::new(AtomicU64::new(0)),
        acknowledge: tokio::sync::watch::channel(0).0,
        content_key: "test".into(),
        host_epoch: "epoch".into(),
        handle: tauri::async_runtime::spawn(std::future::pending()),
        connection_id: "host-a".into(),
        selection_generation: 3,
        instance_id: "work-a".into(),
        subscription_id: "foreground-new".into(),
    });

    assert!(
        !state
            .abort_matching("host-a", 3, "work-a", Some("background-old"))
            .unwrap()
    );
    assert!(state.task.lock().unwrap().is_some());
    assert!(
        state
            .abort_matching("host-a", 3, "work-a", Some("foreground-new"))
            .unwrap()
    );
    assert!(state.task.lock().unwrap().is_none());
}

#[test]
fn pasted_image_becomes_a_path_free_attachment_and_removes_its_temporary_file() {
    let content = aludock_client_core::SessionContent::default();
    let prepared = prepare_clipboard_image(
        &content,
        b"\x89PNG\r\n\x1a\npasted".to_vec(),
        "host-a".into(),
        "work-a".into(),
        1,
    )
    .unwrap();
    let path = prepared.2.source.path().to_owned();
    assert!(path.is_file());
    assert_eq!(prepared.1.name, "粘贴的图片.png");
    assert_eq!(prepared.1.media_type.as_deref(), Some("image/png"));
    let json = serde_json::to_string(&prepared.1).unwrap();
    assert!(!json.contains(&path.to_string_lossy().to_string()));
    drop(prepared);
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn desktop_attachment_names_keep_legal_backslashes() {
    assert!(valid_attachment_name(r"report\final.txt"));
}

#[test]
fn attachment_tokens_are_context_scoped_and_serialization_is_path_free() {
    let entry = NativeAttachment::new(
        aludock_client_core::SessionContent::default()
            .import_attachment(&b"private text"[..])
            .unwrap(),
        "host-a".into(),
        "work-a".into(),
        "secret.txt".into(),
        Some("text/plain".into()),
    );
    assert!(attachment_scope_matches(&entry, "host-a", "", "work-a"));
    assert!(!attachment_scope_matches(&entry, "host-b", "", "work-a"));
    assert!(!attachment_scope_matches(
        &entry,
        "host-a",
        "other-authority",
        "work-a"
    ));
    assert!(!attachment_scope_matches(&entry, "host-a", "", "work-b"));

    let selected = SelectedAttachment {
        token: "b9d7a4a6-8968-4cbd-a285-ff487d28bc3b".into(),
        name: entry.name.clone(),
        size_bytes: entry.size_bytes,
        media_type: entry.media_type.clone(),
    };
    let json = serde_json::to_string(&selected).unwrap();
    assert!(!json.contains("/home/private"));
    assert!(!json.contains("native-operation"));
    assert!(!json.contains("host-a"));
    assert_eq!(
        serde_json::from_str::<Value>(&json).unwrap()["name"],
        "secret.txt"
    );
}

#[test]
fn queue_item_projection_keeps_attachments_and_removes_image_paths() {
    let projected = project_pending_message(PendingMessage {
        queue_item_id: "queue-1".into(),
        operation_id: "operation-1".into(),
        delivery: "followUp".into(),
        text: "queued".into(),
        images: vec![aludock_client_core::ImagePath {
            path: "/home/private/image.png".into(),
            mime_type: "image/png".into(),
        }],
        attachments: vec![AttachmentDto {
            file_id: "9b0cb41e-6398-4b54-b5d0-f673de0f86fc".into(),
            name: "report.txt".into(),
            size_bytes: 10,
            media_type: Some("text/plain".into()),
            sha256: "a".repeat(64),
            stored_at: "2026-01-01T00:00:00.000Z".into(),
        }],
        accepted_at: "2026-01-01T00:00:00.000Z".into(),
    });
    let json = serde_json::to_value(projected).unwrap();
    assert_eq!(json["imageCount"], 1);
    assert_eq!(json["attachments"][0]["name"], "report.txt");
    assert!(json.get("images").is_none());
    assert!(!json.to_string().contains("/home/private"));
    assert!(!json.to_string().contains("operation-1"));
}

#[tokio::test]
async fn leaving_the_main_page_stops_pairing_before_it_can_save() {
    use std::sync::atomic::AtomicBool;
    let state = PairingTaskState::default();
    let directory =
        std::env::temp_dir().join(format!("aludock-page-pairing-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let saved = directory.join("saved-host");
    let destination = saved.clone();
    let (arrived, waiting) = tokio::sync::oneshot::channel();
    let (release, response) = tokio::sync::oneshot::channel();
    let (completed, completion) = tokio::sync::oneshot::channel();
    let handle = tauri::async_runtime::spawn(async move {
        let _ = arrived.send(());
        let _ = response.await; // Held authentication response at the external boundary.
        fs::write(destination, b"successful pairing").unwrap();
        let _ = completed.send(());
    });
    state.tasks.lock().unwrap().insert(
        "old-page-request".into(),
        PairingTask {
            handle,
            cancelled: Arc::new(AtomicBool::new(false)),
        },
    );
    waiting.await.unwrap();
    // The real main-webview load-start and window-destroy hooks call this owner.
    // Unlike Vue unmount, these boundaries also run for a native page reload.
    state.cancel_all();
    let _ = release.send(());
    assert!(completion.await.is_err());
    assert!(
        !saved.exists(),
        "the old page's waiting authorization cannot publish a later save"
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn start_dispatch_registers_pairing_before_the_next_page_exit() {
    use tauri::Manager;
    let (path, runtime, _) = endpoint_runtime("pairing-dispatch");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let state = PairingTaskState::default();
    let app = tauri::test::mock_builder()
        .manage(runtime)
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![crate::connection::start_pairing])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let webview: &tauri::Webview<_> = window.as_ref();
    let (responded, response) = std::sync::mpsc::channel();
    let request_id = uuid::Uuid::new_v4().to_string();
    // Invoke the actual generated command wrapper, not get_ipc_response (which
    // waits and would hide an async command scheduled after a page-exit cut).
    webview.clone().on_message(tauri::webview::InvokeRequest {
        cmd: "start_pairing".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
        url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
        body: tauri::ipc::InvokeBody::Json(serde_json::json!({
            "requestId": request_id, "host": "127.0.0.1", "port": listener.local_addr().unwrap().port(), "deviceName": "This page"
        })), headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
    }, Box::new(move |_, _, result, _, _| { let _ = responded.send(result); }));
    // This is the next platform event after dispatch returns. No async work is
    // awaited before the cut; all accepted attempts must already be cancellable.
    app.state::<PairingTaskState>().cancel_all();
    assert!(
        matches!(response.try_recv(), Ok(tauri::ipc::InvokeResponse::Ok(_))),
        "start acceptance must not remain queued beyond the page exit"
    );
    fs::remove_dir_all(path).unwrap();
}
