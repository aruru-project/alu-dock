//! Real public-core history/rebinding gate; no model calls.
use aludock_client_core::{
    ConnectionRouter, ContentUpdate, DockClient, HistoryRecord, IdentityStore, LocalDockEndpoint,
    ReadReplay, SessionContent, SessionUpdate,
};
use std::{
    collections::{BTreeMap, HashSet},
    env,
    path::PathBuf,
    time::Duration,
};

async fn records(
    binding: &mut aludock_client_core::SessionBinding,
    count: usize,
) -> Result<Vec<HistoryRecord>, Box<dyn std::error::Error>> {
    let mut result = BTreeMap::new();
    let mut text = String::new();
    while result.len() < count {
        let batch = tokio::time::timeout(Duration::from_secs(10), binding.next_batch()).await??;
        for commit in batch {
            if let SessionUpdate::Content {
                update:
                    ContentUpdate::RecordChunk {
                        entry_id,
                        text: part,
                        first,
                        complete,
                        ..
                    },
                ..
            } = commit.update
            {
                if first {
                    text.clear();
                }
                text.push_str(&part);
                if complete {
                    let record = serde_json::from_str::<HistoryRecord>(&text)?;
                    report_fast(&record);
                    result.insert(entry_id, record);
                }
            }
        }
    }
    Ok(result.into_values().collect())
}
fn report_fast(record: &HistoryRecord) {
    if record.content.iter().any(|block| matches!(block, aludock_client_core::ContentBlock::Text { text } if text.starts_with("fast-body ") && text.len() == 40010)) {
        println!("{{\"kind\":\"fast-body.pass\"}}");
    }
}
fn complete_body(record: &HistoryRecord) -> bool {
    record.content.iter().any(|block| matches!(block, aludock_client_core::ContentBlock::Text { text } if text.starts_with("history-250 ") && text.len() == 150012))
}
fn phase(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::json!({"kind":name}));
    std::io::Write::flush(&mut std::io::stdout())?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    assert_eq!(line.trim(), "continue");
    Ok(())
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    let store = IdentityStore::new(PathBuf::from(&args[1]));
    let client = DockClient::new(ConnectionRouter::local(
        &store,
        LocalDockEndpoint::configured(&args[0])?,
        "content-gate".into(),
    )?);
    let read = client
        .read_instance(&args[2], None, ReadReplay::ConversationBootstrap)
        .await?;
    assert_eq!(read.recent_history.len(), 200);
    let anchor = read.recent_history.first().unwrap().entry_id.clone();
    let content = SessionContent::in_directory(PathBuf::from(&args[3]))?;
    let owner = content.claim("work");
    content.commit("work", owner, SessionUpdate::Read(read))?;
    let token = content.content_token("work").unwrap();
    let mut binding = content.bind("work")?;
    let initial = records(&mut binding, 200).await?;
    assert_eq!(initial.len(), 200);
    let known: HashSet<_> = initial
        .iter()
        .map(|record| record.entry_id.clone())
        .collect();
    let (service, client_copy, ticket) = (content.clone(), client.clone(), token.clone());
    let waiter =
        tokio::spawn(async move { service.load_earlier("work", &ticket, &client_copy).await });
    loop {
        let batch = tokio::time::timeout(Duration::from_secs(10), binding.next_batch()).await??;
        if batch.iter().any(|commit| {
            matches!(
                commit.update,
                SessionUpdate::Content {
                    update: ContentUpdate::State { loading: true, .. },
                    ..
                }
            )
        }) {
            break;
        }
    }
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    drop(binding);
    let mut binding = content.bind("work")?;
    println!("{{\"kind\":\"earlier-waiter-dropped\"}}");
    let expanded = records(&mut binding, 250).await?;
    let earlier: Vec<_> = expanded
        .iter()
        .filter(|record| !known.contains(&record.entry_id))
        .collect();
    assert_eq!(earlier.len(), 50);
    assert!(earlier.iter().all(|record| record.entry_id != anchor));
    let texts: Vec<_> = earlier
        .iter()
        .flat_map(|record| &record.content)
        .filter_map(|block| match block {
            aludock_client_core::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(texts.contains(&"history-12"), "earlier texts: {texts:?}");
    assert!(texts.contains(&"history-61"));
    let mut completed = expanded.iter().any(complete_body);
    let mut body = String::new();
    while !completed {
        for commit in tokio::time::timeout(Duration::from_secs(15), binding.next_batch()).await?? {
            if let SessionUpdate::Content {
                update:
                    ContentUpdate::RecordChunk {
                        text,
                        first,
                        complete,
                        ..
                    },
                ..
            } = commit.update
            {
                if first {
                    body.clear();
                }
                body.push_str(&text);
                if complete {
                    let record: HistoryRecord = serde_json::from_str(&body)?;
                    report_fast(&record);
                    completed |= complete_body(&record);
                }
            }
        }
    }
    drop(binding);
    let other_read = client
        .read_instance(&args[4], None, ReadReplay::ConversationBootstrap)
        .await?;
    let other_owner = content.claim("other-work");
    content.commit("other-work", other_owner, SessionUpdate::Read(other_read))?;
    let other_view = content.bind("other-work")?;
    assert_eq!(other_view.snapshot.target.as_ref().unwrap().id, args[4]);
    drop(other_view);
    content.claim("work");
    assert_eq!(
        content.content_token("work").as_deref(),
        Some(token.as_str())
    );
    // No client/network read participates in this rebuilt original Work view.
    let mut rebound = content.bind("work")?;
    let restored = records(&mut rebound, 250).await?;
    assert_eq!(restored.len(), 250);
    assert!(restored.iter().any(complete_body));
    let bad_id = restored
        .iter()
        .find(|record| complete_body(record))
        .unwrap()
        .entry_id
        .clone();
    drop(rebound);
    // Corrupt this gate's record bytes, not a fixture-filled cache. All versions
    // matching that one actual body are damaged so the test does not depend on
    // the owner's private file naming or version-reclamation policy.
    let mut damaged_files = 0;
    for run in std::fs::read_dir(&args[3])? {
        let run = run?.path();
        if !run.is_dir() {
            continue;
        }
        for file in std::fs::read_dir(run)? {
            let path = file?.path();
            if !path.is_file() {
                continue;
            }
            let Ok(mut bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(record) = serde_json::from_slice::<HistoryRecord>(&bytes) else {
                continue;
            };
            if record.entry_id == bad_id && complete_body(&record) {
                bytes[0] = b'x';
                std::fs::write(path, bytes)?;
                damaged_files += 1;
            }
        }
    }
    assert!(damaged_files > 0);
    let mut damaged = content.bind("work")?;
    let mut good = HashSet::new();
    let mut bad_seen = false;
    let mut fault_recorded = false;
    let mut encoded = String::new();
    while good.len() < 249 || !bad_seen || !fault_recorded {
        for commit in tokio::time::timeout(Duration::from_secs(15), damaged.next_batch()).await?? {
            match commit.update {
                SessionUpdate::Content {
                    update: ContentUpdate::RecordError { entry_id, .. },
                    ..
                } => {
                    assert_eq!(entry_id, bad_id);
                    bad_seen = true;
                    encoded.clear();
                }
                SessionUpdate::Content {
                    update:
                        ContentUpdate::EntryState {
                            entry_id,
                            error: Some(_),
                            ..
                        },
                    ..
                } if entry_id == bad_id => fault_recorded = true,
                SessionUpdate::Content {
                    update:
                        ContentUpdate::RecordChunk {
                            entry_id,
                            text,
                            first,
                            complete,
                            ..
                        },
                    ..
                } => {
                    if first {
                        encoded.clear();
                    }
                    encoded.push_str(&text);
                    if complete {
                        assert_ne!(entry_id, bad_id);
                        let _: HistoryRecord = serde_json::from_str(&encoded)?;
                        good.insert(entry_id);
                    }
                }
                _ => {}
            }
        }
    }
    phase("repair-offline")?;
    content
        .retry_content("work", &token, &client, vec![bad_id.clone()])
        .await?;
    let mut started = false;
    'unavailable: loop {
        for commit in tokio::time::timeout(Duration::from_secs(20), damaged.next_batch()).await?? {
            if let SessionUpdate::Content {
                update:
                    ContentUpdate::EntryState {
                        entry_id, error, ..
                    },
                ..
            } = commit.update
            {
                if entry_id == bad_id {
                    if error.is_none() {
                        started = true;
                    } else if started {
                        break 'unavailable;
                    }
                }
            }
        }
    }
    assert_eq!(
        good.len(),
        249,
        "unavailable source does not clear other records"
    );
    phase("repair-online")?;
    content
        .retry_content("work", &token, &client, vec![bad_id.clone()])
        .await?;
    let mut repaired = false;
    while !repaired {
        for commit in tokio::time::timeout(Duration::from_secs(20), damaged.next_batch()).await?? {
            if let SessionUpdate::Content {
                update:
                    ContentUpdate::RecordChunk {
                        entry_id,
                        text,
                        first,
                        complete,
                        ..
                    },
                ..
            } = commit.update
            {
                if first {
                    encoded.clear();
                }
                encoded.push_str(&text);
                if complete && entry_id == bad_id {
                    let record: HistoryRecord = serde_json::from_str(&encoded)?;
                    assert!(
                        complete_body(&record),
                        "repair never publishes a downgraded preview for an already complete record"
                    );
                    repaired = true;
                }
            }
        }
    }
    drop(damaged);
    let mut repaired_view = content.bind("work")?;
    assert!(
        records(&mut repaired_view, 250)
            .await?
            .iter()
            .any(complete_body)
    );
    let mut cursor = None;
    let semantic_group_entries = loop {
        let (page, _) = client
            .conversation_history(&args[2], cursor.as_deref(), 50)
            .await?;
        if page.entries.len() > 50 {
            let results = page
                .entries
                .iter()
                .flat_map(|item| &item.entry.content)
                .filter(|block| {
                    matches!(block, aludock_client_core::ContentBlock::ToolResult { .. })
                })
                .count();
            assert_eq!(results, 55);
            break page.entries.len();
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            return Err("real semantic tool group was not returned intact".into());
        }
    };
    println!(
        "{}",
        serde_json::json!({"kind":"content.pass","initial":200,"firstEarlier":50,"rebound":250,"completeBodyBytes":150012,"semanticGroupEntries":semantic_group_entries,"workSwitchRetained":true,"badRecordIsolatedAndRepaired":true,"beforeEntryId":anchor})
    );
    Ok(())
}
