#![cfg(unix)]

use aludock_client_core::{
    AttachmentState, AttachmentUploadScope, ClientError, ConnectionRouter, DockClient,
    IdentityStore, LocalDockEndpoint, NativeAttachment, RestoredImageScope, SessionContent,
    SettingKey, SettingUpdate, SettingValue,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// #319: the client used a copied setting table and directory preflights to
// overrule the Host. This peer supplies authoritative results, not a second Host.
#[tokio::test]
async fn host_settings_and_command_results_are_usable_without_a_catalog_preflight() {
    let directory = std::env::temp_dir().join(format!(
        "ca-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    std::fs::create_dir(&directory).unwrap();
    let endpoint = directory.join("s");
    let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
    let (send_received, send_wait) = tokio::sync::oneshot::channel();
    let (finish_send, finish_wait) = tokio::sync::oneshot::channel();
    let (late_received, mut late_wait) = tokio::sync::mpsc::unbounded_channel();
    let (finish_late, mut late_release) = tokio::sync::mpsc::unbounded_channel();
    let peer = tokio::spawn(async move {
        let instance = json!({
            "id":"work", "creationOperationId":"create", "displayName":"Work", "cwd":"/isolated",
            "lifecycle":"active", "execution":"running", "compacting":false, "lastRun":"never",
            "reopenable":false, "runtimeGeneration":7, "ownerHostEpoch":"epoch",
            "pending":{"steering":1,"followUp":0,"total":1}, "executor":{"kind":"pi","piSessionId":"session"},
            "toolsExpanded":false, "createdAt":"now", "updatedAt":"now", "executionChangedAt":"now",
            "eventCursor":{"hostEpoch":"epoch","instanceId":"work","runtimeGeneration":7,"sequence":20}
        });
        let setting = json!({"key":"transport","value":"auto","source":"effective","writable":true,
            "valueType":"enum","allowedValues":["auto","sse"],"reloadRequired":true,"hostRestartRequired":false});
        let queued = json!({"queueItemId":"queued","operationId":"original","delivery":"steer","text":"hello",
            "images":[{"path":"/host/image.png","mimeType":"image/png"}],"acceptedAt":"now"});
        let mut newer_branch = instance.clone();
        newer_branch["eventCursor"]["sequence"] = json!(32);
        let mut receipt_first = instance.clone();
        receipt_first["eventCursor"]["sequence"] = json!(42);
        // #356: a newer Host lists a setting this build has never heard of, with a value shape
        // this build cannot even parse; the page must still open with the known settings.
        let newer_setting = json!({"key":"somethingFromAFutureHost","value":[1.5,"x"],"source":"global","writable":true,
            "valueType":"list","allowedValues":null,"reloadRequired":false,"hostRestartRequired":false});
        let replies = [
            ("attachment.upload", json!({})),
            (
                "settings.get",
                json!({"settings":[newer_setting, setting.clone()]}),
            ),
            (
                "settings.update",
                json!({"setting":setting,"instance":instance,"reloadRequired":true,"hostRestartRequired":false}),
            ),
            (
                "command.submit",
                json!({"receipt":{"accepted":true,"operationId":"command","instanceId":"work","kind":"prompt","delivery":"prompt","queued":false,"acceptedAt":"now"},"instance":instance}),
            ),
            (
                "queue.dequeue",
                json!({"receipt":{"operationId":"dequeue","instanceId":"work","restored":[queued],"inFlight":[]},"instance":instance}),
            ),
            ("command.submit", json!({"failure":"rejected"})),
            ("command.submit", json!({"failure":"unknown"})),
            (
                "command.submit",
                json!({"receipt":{"accepted":true,"operationId":"send","instanceId":"work","kind":"prompt","delivery":"prompt","queued":false,"acceptedAt":"now"},"instance":instance}),
            ),
            (
                "command.abort_restore_queue",
                json!({"receipt":{"operationId":"abort","instanceId":"work","restored":[],"inFlight":[]},"instance":instance}),
            ),
            // #326: an older Host without one-step abort gets its Queue taken first.
            (
                "queue.dequeue",
                json!({"receipt":{"operationId":"echo","instanceId":"work","restored":[],"inFlight":[]},"instance":instance}),
            ),
            ("command.abort", json!({"instance":instance})),
            ("extension.tools_expanded.set", json!({"instance":instance})),
            (
                "queue.dequeue",
                json!({"receipt":{"operationId":"late","instanceId":"work","restored":[queued],"inFlight":[]},"instance":instance}),
            ),
            (
                "queue.dequeue",
                json!({"receipt":{"operationId":"new-branch","instanceId":"work","restored":[queued],"inFlight":[]},"instance":newer_branch}),
            ),
            (
                "queue.dequeue",
                json!({"receipt":{"operationId":"receipt-first","instanceId":"work","restored":[queued],"inFlight":[]},"instance":receipt_first}),
            ),
            (
                "queue.dequeue",
                json!({"receipt":{"operationId":"cleared","instanceId":"work","restored":[queued],"inFlight":[]},"instance":receipt_first}),
            ),
            (
                "queue.dequeue",
                json!({"receipt":{"operationId":"switched","instanceId":"work","restored":[queued],"inFlight":[]},"instance":receipt_first}),
            ),
            (
                "queue.dequeue",
                json!({"receipt":{"operationId":"old-runtime","instanceId":"work","restored":[queued],"inFlight":[]},"instance":receipt_first}),
            ),
        ];
        let mut send_received = Some(send_received);
        let mut finish_wait = Some(finish_wait);
        let mut abort_restore_hellos = 0;
        for (method, mut result) in replies {
            let (mut socket, hello) = loop {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = BufReader::new(socket);
                let mut line = String::new();
                socket.read_line(&mut line).await.unwrap();
                let hello: Value = serde_json::from_str(&line).unwrap();
                let requires = |capability: &str| {
                    hello["requiredCapabilities"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item == capability)
                };
                let older_abort = requires("run.abort-restore-queue.v1") && {
                    abort_restore_hellos += 1;
                    abort_restore_hellos == 2
                };
                if older_abort || requires("file-transfer.v1") {
                    let missing = if older_abort {
                        "run.abort-restore-queue.v1"
                    } else {
                        "file-transfer.v1"
                    };
                    let refusal = json!({"kind":"hello_error","requestId":hello["requestId"],"error":{"code":"capability_missing","message":"older Host","missing":[missing]}});
                    socket
                        .get_mut()
                        .write_all(format!("{refusal}\n").as_bytes())
                        .await
                        .unwrap();
                    continue;
                }
                break (socket, hello);
            };
            let mut line = String::new();
            let ack = json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
                "host":{"hostEpoch":"epoch"},"limits":{"maxLineBytes":65536},
                "capabilities":["core.v2","extension_ui.tools-expanded.v1","git.branch-footer.v1","instance.keys.v1","instance.display-name.v1","attachments.v1","settings.v1","session.core","command.images.path.v1","queue.control.v1","run.abort.v1","run.abort-restore-queue.v1"]});
            socket
                .get_mut()
                .write_all(format!("{ack}\n").as_bytes())
                .await
                .unwrap();
            line.clear();
            socket.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["type"], method);
            if method == "attachment.upload" {
                let ready = json!({"kind":"attachment_upload_ready","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","maxChunkBytes":524288});
                socket
                    .get_mut()
                    .write_all(format!("{ready}\n").as_bytes())
                    .await
                    .unwrap();
                line.clear();
                socket.read_line(&mut line).await.unwrap();
                let chunk: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(chunk["data"], "YWJj");
                line.clear();
                socket.read_line(&mut line).await.unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&line).unwrap()["kind"],
                    "attachment_complete"
                );
                let receipt = json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,
                    "result":{"status":"stored","attachment":{"fileId":"123e4567-e89b-42d3-a456-426614174000","name":"source","sizeBytes":3,
                    "sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","storedAt":"2026-09-22T00:00:00.000Z"}}});
                socket
                    .get_mut()
                    .write_all(format!("{receipt}\n").as_bytes())
                    .await
                    .unwrap();
                continue;
            }
            if result["failure"] == "unknown" {
                continue;
            }
            if result["failure"] == "rejected" {
                let rejected = json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":false,
                    "error":{"code":"rejected","message":"not accepted","retryable":false}});
                socket
                    .get_mut()
                    .write_all(format!("{rejected}\n").as_bytes())
                    .await
                    .unwrap();
                continue;
            }
            if method == "command.submit" && request["params"]["operationId"] == "command" {
                assert_eq!(request["params"]["message"], "/example argument");
            }
            if method == "command.submit" && request["params"]["operationId"] == "send" {
                assert_eq!(request["params"]["images"][0]["path"], "/host/image.png");
                assert_eq!(
                    request["params"]["attachments"],
                    json!(["123e4567-e89b-42d3-a456-426614174000"])
                );
                send_received.take().unwrap().send(()).unwrap();
                finish_wait.take().unwrap().await.unwrap();
            }
            if result["receipt"]["operationId"] == "echo" {
                result["receipt"]["operationId"] = request["params"]["operationId"].clone();
            } else if method == "queue.dequeue" && request["params"]["operationId"] != "dequeue" {
                late_received.send(()).unwrap();
                late_release.recv().await.unwrap();
            }
            let response = json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":result});
            socket
                .get_mut()
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        }
    });
    let client = DockClient::new(
        ConnectionRouter::local(
            &IdentityStore::new(directory.join("identity")),
            LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
            "test".into(),
        )
        .unwrap(),
    );
    let content = SessionContent::default();
    let attachments = AttachmentState::new(content.clone());
    let source = content.import_attachment(&b"abc"[..]).unwrap();
    let mut entry = NativeAttachment::new(
        source.clone(),
        "test".into(),
        "work".into(),
        "source".into(),
        None,
    );
    entry.authority = "test".into();
    attachments.insert("uploaded".into(), entry);
    let (progress, mut uploads) = tokio::sync::mpsc::unbounded_channel();
    attachments
        .start(
            "uploaded",
            AttachmentUploadScope {
                machine_host_id: "machine".into(),
                owner_host_epoch: "epoch".into(),
                runtime_generation: 7,
            },
            client.clone(),
            move |update| {
                let _ = progress.send(update);
            },
        )
        .unwrap();
    loop {
        let update = uploads.recv().await.unwrap();
        if update.state == "succeeded" {
            break;
        }
        assert_ne!(update.state, "failed");
        assert_ne!(update.state, "unknown");
    }
    let settings = client.settings("work").await.unwrap();
    assert_eq!(settings.settings.len(), 1);
    assert_eq!(settings.settings[0].key, SettingKey::Transport);
    assert_eq!(
        settings.settings[0].allowed_values,
        Some(vec![json!("auto"), json!("sse")])
    );
    let updated = client
        .update_setting(
            "work",
            &SettingUpdate {
                key: SettingKey::Transport,
                value: SettingValue::Enum("sse".into()),
            },
            Some("setting"),
        )
        .await
        .unwrap();
    assert_eq!(updated.setting.value, SettingValue::Enum("auto".into()));
    assert!(updated.reload_required);
    assert!(
        client
            .run_catalog_command("work", "example", " argument ", "command")
            .await
            .unwrap()
            .receipt
            .accepted
    );
    let images = content.restored_images();
    let scope = RestoredImageScope {
        host_epoch: "epoch".into(),
        runtime_generation: 7,
        connection_id: "test".into(),
        selection_generation: 1,
        work_id: "work".into(),
    };
    let restored = images
        .dequeue(&client, scope.clone(), "dequeue")
        .await
        .unwrap();
    assert_eq!(restored.receipt.restored[0].text, "hello");
    assert_eq!(images.capture(&scope).unwrap().images.len(), 1);
    let ids = vec!["123e4567-e89b-42d3-a456-426614174000".to_owned()];
    assert!(matches!(
        images
            .submit(&client, &attachments, &scope, "test", "", &ids, "rejected")
            .await,
        Err(ClientError::Host { .. })
    ));
    assert_eq!(
        attachments.snapshot("test", "work").jobs[0].state,
        "succeeded"
    );
    assert!(images.capture(&scope).is_some());
    assert!(matches!(
        images
            .submit(&client, &attachments, &scope, "test", "", &ids, "unknown")
            .await,
        Err(ClientError::EffectUnknown { .. })
    ));
    assert_eq!(
        attachments.snapshot("test", "work").jobs[0].token,
        "uploaded"
    );
    assert!(images.capture(&scope).is_some());
    let sending = {
        let client = client.clone();
        let attachments = attachments.clone();
        let images = images.clone();
        let scope = scope.clone();
        tokio::spawn(async move {
            images
                .submit(&client, &attachments, &scope, "test", "", &ids, "send")
                .await
        })
    };
    send_wait.await.unwrap();
    let mut newer = NativeAttachment::new(
        source,
        "test".into(),
        "work".into(),
        "new selection".into(),
        None,
    );
    newer.authority = "test".into();
    attachments.insert("newer".into(), newer);
    finish_send.send(()).unwrap();
    assert!(sending.await.unwrap().unwrap().receipt.accepted);
    let remaining = attachments.snapshot("test", "work").jobs;
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].token, "newer");
    assert!(images.capture(&scope).is_none());
    let mut running = client
        .abort_run("work", Some("abort"))
        .await
        .unwrap()
        .instance;
    assert_eq!(running.runtime_generation, 7);
    let older = client.abort_run("work", Some("older-abort")).await.unwrap();
    assert_eq!(older.receipt.operation_id, "older-abort");
    assert!(
        !client
            .set_tools_expanded("work", 7, true, Some("expand"))
            .await
            .unwrap()
            .tools_expanded
    );
    content.claim("work");
    assert!(content.replace("work", running.clone(), false).unwrap());
    // #319 review regression: the accepted navigation position, not delivery
    // order, decides which branch owns a returned image. Explicit user clears
    // and connection/runtime changes still invalidate in-flight take-backs.
    for operation in [
        "late",
        "new-branch",
        "receipt-first",
        "cleared",
        "switched",
        "old-runtime",
    ] {
        let pending = {
            let images = images.clone();
            let scope = scope.clone();
            let client = client.clone();
            tokio::spawn(async move { images.dequeue(&client, scope, operation).await })
        };
        late_wait.recv().await.unwrap();
        match operation {
            "late" | "new-branch" => {
                running.event_cursor.sequence = if operation == "late" { 21 } else { 31 };
                assert!(content.replace("work", running.clone(), true).unwrap());
            }
            "cleared" => {
                images.clear_scope(&scope);
            }
            "switched" => images.clear(),
            "old-runtime" => {
                running.runtime_generation = 8;
                running.event_cursor.runtime_generation = 8;
                running.event_cursor.sequence = 1;
                assert!(content.replace("work", running.clone(), false).unwrap());
            }
            "receipt-first" => {}
            _ => unreachable!(),
        }
        finish_late.send(()).unwrap();
        assert_eq!(
            pending.await.unwrap().unwrap().receipt.restored[0].text,
            "hello"
        );
        if operation == "receipt-first" {
            running.event_cursor.sequence = 41;
            assert!(content.replace("work", running.clone(), true).unwrap());
        }
        if matches!(operation, "new-branch" | "receipt-first") {
            assert_eq!(
                images
                    .capture(&scope)
                    .expect("new-branch images survive either delivery order")
                    .images
                    .len(),
                1
            );
        } else {
            assert!(
                images.capture(&scope).is_none(),
                "old or explicitly discarded images stay discarded: {operation}"
            );
        }
    }
    peer.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
