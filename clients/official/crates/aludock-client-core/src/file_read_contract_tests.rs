//! Public client boundary regressions for requested files and fixed-size deliveries.
use crate::{
    ConnectionRouter, DockClient, IdentityStore, LocalDockEndpoint,
    tls::{read_json_line, write_json_line},
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Clone)]
struct Case {
    name: &'static str,
    delivery: bool,
    legacy: bool,
    ready: Value,
    result: Value,
    early: bool,
    success: bool,
}

#[tokio::test]
async fn public_file_readers_keep_identity_and_length_checks_before_additional_policy() {
    let delivery = json!({"deliveryRef":"requested","name":"file.txt","sizeBytes":3});
    let entry =
        json!({"path":"file.txt","name":"file.txt","kind":"file","hidden":false,"sizeBytes":2});
    let mut wrong_delivery = delivery.clone();
    wrong_delivery["deliveryRef"] = json!("other");
    let mut short_delivery = delivery.clone();
    short_delivery["sizeBytes"] = json!(5);
    let mut changed_delivery = delivery.clone();
    changed_delivery["name"] = json!("other.txt");
    let mut cases = vec![
        Case {
            name: "delivery ready ref",
            delivery: true,
            legacy: false,
            ready: json!({"deliverable":wrong_delivery}),
            result: json!({"deliverable":delivery}),
            early: true,
            success: false,
        },
        Case {
            name: "short fixed delivery",
            delivery: true,
            legacy: false,
            ready: json!({"deliverable":short_delivery}),
            result: json!({"deliverable":short_delivery}),
            early: false,
            success: false,
        },
        Case {
            name: "changed delivery descriptor",
            delivery: true,
            legacy: false,
            ready: json!({"deliverable":delivery}),
            result: json!({"deliverable":changed_delivery}),
            early: false,
            success: false,
        },
    ];
    for legacy in [false, true] {
        for (name, ready, early, success) in [
            (
                "wrong workspace path",
                json!({"path":"other.txt","name":"other.txt","kind":"file","hidden":false,"sizeBytes":2}),
                true,
                false,
            ),
            (
                "directory is not a file",
                json!({"path":"file.txt","name":"folder","kind":"directory","hidden":false}),
                true,
                false,
            ),
            (
                "existing readiness size limit",
                json!({"path":"file.txt","name":"file.txt","kind":"file","hidden":false,"sizeBytes":104857601}),
                true,
                false,
            ),
            ("workspace can grow", entry.clone(), false, true),
        ] {
            cases.push(Case {
                name,
                delivery: false,
                legacy,
                ready: json!({"entry":ready}),
                result: json!({"entry":entry}),
                early,
                success,
            });
        }
    }
    cases.push(Case{name:"changed final workspace path",delivery:false,legacy:false,ready:json!({"entry":entry}),result:json!({"entry":{"path":"other.txt","name":"other.txt","kind":"file","hidden":false,"sizeBytes":2}}),early:false,success:false});

    let root = std::env::temp_dir().join(format!(
        "fc{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir(&root).unwrap();
    for (index, case) in cases.into_iter().enumerate() {
        let endpoint = root.join(format!("{index}.sock"));
        let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
        let fixture = case.clone();
        let peer = tokio::spawn(async move {
            let mut socket = loop {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = BufReader::new(socket);
                let hello: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                if fixture.legacy
                    && hello["requiredCapabilities"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|value| value == "file-transfer.v1")
                {
                    write_json_line(&mut socket,&json!({"kind":"hello_error","requestId":hello["requestId"],"error":{"code":"capability_missing","message":"older Host","missing":["file-transfer.v1"]}})).await.unwrap();
                    continue;
                }
                write_json_line(&mut socket,&json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,"host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
                break socket;
            };
            let request: Value = read_json_line(&mut socket, 1048576).await.unwrap();
            assert_eq!(
                request["type"],
                if fixture.delivery {
                    "deliverable.download"
                } else {
                    "workspace.file.read"
                }
            );
            if !fixture.delivery {
                assert_eq!(request["params"]["path"], "file.txt");
            }
            let summary = json!({"chunks":1,"sizeBytes":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"});
            let mut records = if fixture.legacy {
                vec![
                    json!({"kind":"workspace_file_read_ready","instanceId":"work","path":"file.txt","entry":fixture.ready["entry"]}),
                    json!({"kind":"workspace_file_read_chunk","instanceId":"work","path":"file.txt","index":0,"data":"YWJj"}),
                    json!({"kind":"workspace_file_read_complete","instanceId":"work","path":"file.txt"}),
                ]
            } else {
                let mut result = fixture.result.clone();
                result
                    .as_object_mut()
                    .unwrap()
                    .extend(summary.as_object().unwrap().clone());
                vec![
                    json!({"kind":"file_ready","direction":"download","maxChunkBytes":65536,"windowBytes":262144,"metadata":fixture.ready}),
                    json!({"kind":"file_chunk","index":0,"data":"YWJj"}),
                    json!({"kind":"file_complete"}),
                    json!({"kind":"response","ok":true,"result":result}),
                ]
            };
            records[2]
                .as_object_mut()
                .unwrap()
                .extend(summary.as_object().unwrap().clone());
            for record in &mut records {
                record["version"] = json!(2);
                record["requestId"] = request["requestId"].clone();
                record["hostEpoch"] = json!("epoch");
                if write_json_line(&mut socket, record).await.is_err() {
                    return;
                }
            }
            let _ = socket.shutdown().await;
            let _ = socket.read_to_end(&mut Vec::new()).await;
        });
        let client = DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(root.join(format!("identity-{index}"))),
                LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                "file-contracts".into(),
            )
            .unwrap(),
        );
        let mut sink = Vec::new();
        let mut policy_called = false;
        let result = if case.delivery {
            client
                .download_deliverable("work", "requested", &mut sink, |_| {})
                .await
                .map(|result| (result.size_bytes, 0))
        } else {
            client
                .read_workspace_file(
                    "work",
                    "./file.txt",
                    &mut sink,
                    |_| {
                        policy_called = true;
                        Ok(())
                    },
                    |_| {},
                )
                .await
                .map(|result| (result.size_bytes, result.entry.size_bytes.unwrap_or(0)))
        };
        if case.success {
            assert_eq!(result.unwrap(), (3, 2), "{}", case.name);
            assert_eq!(sink, b"abc");
        } else {
            assert!(result.is_err(), "{} must not be accepted", case.name);
        }
        if case.early {
            assert!(sink.is_empty(), "{} wrote the provisional sink", case.name);
            assert!(
                !policy_called,
                "base file checks must precede additional policy"
            );
        }
        client.router().close();
        peer.await.unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
}
