#![cfg(unix)]
use aludock_client_core::{
    ConnectionRouter, DockClient, ExtensionControlState, ExtensionControlUpdate, IdentityStore,
    InteractionMethod, LocalDockEndpoint,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};

type Socket = BufReader<UnixStream>;
async fn send(socket: &mut Socket, value: Value) {
    socket
        .get_mut()
        .write_all(format!("{value}\n").as_bytes())
        .await
        .unwrap();
}
async fn accept(listener: &UnixListener) -> (Socket, Value) {
    let mut socket = BufReader::new(listener.accept().await.unwrap().0);
    let mut line = String::new();
    socket.read_line(&mut line).await.unwrap();
    let hello: Value = serde_json::from_str(&line).unwrap();
    send(&mut socket, json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
        "host":{"hostEpoch":"epoch"},"limits":{"maxLineBytes":65536},
        "capabilities":["core.v2","extension_ui.v1","extension_ui.control.v1","extension_ui.persistent-interactions.v1","extension_ui.widgets.v1"]})).await;
    line.clear();
    socket.read_line(&mut line).await.unwrap();
    (socket, serde_json::from_str(&line).unwrap())
}
async fn response(socket: &mut Socket, request: &Value, result: Value) {
    send(socket, json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":result})).await;
}
async fn question(socket: &mut Socket, request: &Value, id: &str, sequence: u64) {
    send(socket, json!({"kind":"event","version":2,"requestId":request["requestId"],"hostEpoch":"epoch",
        "event":{"scope":"instance","instanceId":"work","runtimeGeneration":1,"sequence":sequence,
        "occurredAt":"2026-09-27T00:00:00Z","type":"interaction.requested",
        "data":{"method":"input","controllerId":"controller","interactionId":id,"title":"Question","placeholder":null,"issuedAt":"2026-09-27T00:00:00Z","expiresAt":null}}})).await;
}

// #319: a late answer receipt must not erase the next question; disconnects
// release only this native binding, without answering anything automatically.
#[tokio::test]
async fn answering_keeps_a_newer_question_and_disconnect_releases_control() {
    let directory = std::env::temp_dir().join(format!(
        "ec-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    std::fs::create_dir(&directory).unwrap();
    let endpoint = directory.join("s");
    let listener = UnixListener::bind(&endpoint).unwrap();
    let (release, wait) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let (mut control, request) = accept(&listener).await;
        assert_eq!(request["type"], "interaction.control");
        response(&mut control, &request, json!({"instanceId":"work","runtimeGeneration":1,"leaseToken":"private-lease","controllerId":"controller"})).await;
        question(&mut control, &request, "first", 1).await;
        for _ in 0..2 {
            let (mut viewport, request) = accept(&listener).await;
            assert_eq!(request["type"], "extension.widget_viewport.set");
            response(&mut viewport, &request, json!({"accepted":false})).await;
        }
        let (mut refused, answer) = accept(&listener).await;
        send(&mut refused, json!({"kind":"response","version":2,"requestId":answer["requestId"],"hostEpoch":"epoch","ok":false,
            "error":{"code":"temporarily_unavailable","message":"try again","retryable":true}})).await;
        let (mut first, answer) = accept(&listener).await;
        assert_eq!(answer["params"]["interactionId"], "first");
        assert_eq!(answer["params"]["response"]["value"], "one");
        question(&mut control, &request, "second", 2).await;
        wait.await.unwrap();
        response(
            &mut first,
            &answer,
            json!({"interactionId":"first","state":"resolved"}),
        )
        .await;
        let (mut second, answer) = accept(&listener).await;
        assert_eq!(answer["params"]["interactionId"], "second");
        response(
            &mut second,
            &answer,
            json!({"interactionId":"second","state":"resolved"}),
        )
        .await;
        // Closing the control stream is the only disconnect action.
    });
    let client = DockClient::new(
        ConnectionRouter::local(
            &IdentityStore::new(directory.join("identity")),
            LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
            "test".into(),
        )
        .unwrap(),
    );
    let state = ExtensionControlState::default();
    let (send_update, mut updates) = tokio::sync::mpsc::unbounded_channel();
    let binding = state.install(
        client.control_extension_ui("work").await.unwrap(),
        "test".into(),
        1,
        move |update| {
            send_update.send(update).unwrap();
        },
    );
    assert!(matches!(
        updates.recv().await,
        Some(ExtensionControlUpdate::Event(_, _))
    ));
    for _ in 0..2 {
        assert!(
            !state
                .viewport(&client, &binding.handle, "test", 1, 80, 24)
                .await
                .unwrap()
                .accepted
        );
    }
    let refused = state
        .respond(
            &client,
            &binding.handle,
            "test",
            1,
            "first",
            InteractionMethod::Input,
            Some("one".into()),
            None,
            false,
        )
        .await;
    assert!(matches!(
        refused,
        Err(aludock_client_core::ClientError::Host { .. })
    ));
    let answer = {
        let state = state.clone();
        let client = client.clone();
        let handle = binding.handle.clone();
        tokio::spawn(async move {
            state
                .respond(
                    &client,
                    &handle,
                    "test",
                    1,
                    "first",
                    InteractionMethod::Input,
                    Some("one".into()),
                    None,
                    false,
                )
                .await
        })
    };
    assert!(matches!(
        updates.recv().await,
        Some(ExtensionControlUpdate::Event(_, _))
    ));
    release.send(()).unwrap();
    assert_eq!(answer.await.unwrap().unwrap().interaction_id, "first");
    assert_eq!(
        state
            .respond(
                &client,
                &binding.handle,
                "test",
                1,
                "second",
                InteractionMethod::Input,
                Some("two".into()),
                None,
                false
            )
            .await
            .unwrap()
            .interaction_id,
        "second"
    );
    assert!(matches!(
        updates.recv().await,
        Some(ExtensionControlUpdate::Disconnected(_))
    ));
    assert!(state.clear().is_none());
    peer.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
