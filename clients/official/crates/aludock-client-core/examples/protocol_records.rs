//! #325: actual observation owner across the real Host/Main/SubHost protocol gate.
use aludock_client_core::{
    ConnectionRouter, ConversationObservation, DockClient, IdentityStore, LocalDockEndpoint,
    SessionContent, SessionUpdate,
};
use std::{env, io::Write, path::PathBuf, time::Duration};

fn report(kind: &str) {
    println!("{}", serde_json::json!({"kind":kind}));
    std::io::stdout().flush().unwrap();
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    let client = DockClient::new(ConnectionRouter::local(
        &IdentityStore::new(PathBuf::from(&args[1])),
        LocalDockEndpoint::configured(&args[0])?,
        "records gate".into(),
    )?);
    let legacy = args.get(10).is_some_and(|value| value == "legacy");
    let content = SessionContent::in_directory(PathBuf::from(&args[2]))?;
    let service = ConversationObservation::new(content);
    if !legacy {
        let _uncommitted = service.bind(
            "cancelled".into(),
            client.clone(),
            args[3].clone(),
            args[4].clone(),
            false,
        )?;
        tokio::task::spawn_blocking(|| {
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            assert_eq!(line.trim(), "replace");
        })
        .await?;
        assert!(
            service.content.bind("cancelled")?.snapshot.read.is_none(),
            "partial bootstrap must not commit"
        );
    }
    let mut binding = service.bind(
        "records".into(),
        client,
        args[3].clone(),
        args[4].clone(),
        false,
    )?;
    report("records.owner-replaced");
    let mut initial = false;
    let mut live = 0;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            for commit in binding.next_batch().await? {
                match commit.update {
                    SessionUpdate::Read(read) => {
                        assert!(!initial, "a healthy record stream must not rebuild");
                        assert_eq!(read.instance.id, args[3]);
                        assert_eq!(read.page.latest.host_epoch, args[4]);
                        assert_eq!(
                            read.instance.host_id.as_deref(),
                            if args[5] == "-" {
                                None
                            } else {
                                Some(args[5].as_str())
                            }
                        );
                        assert_eq!(read.page.events.len(), if legacy { 3 } else { 1002 });
                        assert_eq!(
                            read.page.events[0].data["error"],
                            if legacy {
                                "legacy diagnostic".into()
                            } else {
                                format!("{}|{}|{}", args[6], args[7], "雪".repeat(370000))
                            }
                        );
                        assert!(
                            read.page
                                .events
                                .iter()
                                .all(|event| event.instance_id == args[3])
                        );
                        assert_eq!(read.page.truncated, args[8] == "true");
                        assert_eq!(read.page.latest.sequence, args[9].parse::<u64>().unwrap());
                        initial = true;
                        report("records.initial");
                    }
                    SessionUpdate::Event(event) => {
                        assert!(initial);
                        assert_eq!(event.instance_id, args[3]);
                        if event.event_type == "message.completed" {
                            let expected = match live {
                                0 => {
                                    if legacy {
                                        "first".into()
                                    } else {
                                        "a".repeat(5 * 1024 * 1024)
                                    }
                                }
                                1 => {
                                    if legacy {
                                        "second".into()
                                    } else {
                                        "b".repeat(5 * 1024 * 1024)
                                    }
                                }
                                2 => "small tail".into(),
                                _ => panic!("unexpected live event"),
                            };
                            assert_eq!(event.data["error"], expected);
                            live += 1;
                            if live == 1 {
                                report("records.first-live");
                            }
                            if live == 3 {
                                service.pause("records");
                                if !legacy {
                                    assert!(
                                        service.content.bind("cancelled")?.snapshot.read.is_none(),
                                        "late old-owner records must not commit"
                                    );
                                }
                                report("records.pass");
                                return Ok::<_, aludock_client_core::ClientError>(());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    })
    .await??;
    Ok(())
}
