//! Real public-core history/rebinding gate; no model calls.
use aludock_client_core::{
    ConnectionRouter, ContentBlock, ContentUpdate, DockClient, HistoryRecord, IdentityStore, LocalDockEndpoint, MediaScope,
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
    let complete = record.content.iter().any(|block| matches!(block, ContentBlock::Text { text } if text.starts_with("history-250 ") && text.len() == 500012));
    if complete {
        assert!(matches!(&record.content[0], ContentBlock::Text { text } if text == &format!("history-250 {}", "x😀".repeat(100000))));
        assert!(matches!(record.content.as_slice(), [ContentBlock::Text { .. }, ContentBlock::Image { content_ref: Some(_), data: None, .. }, ContentBlock::Text { text }] if text == "long-after-image"));
    }
    complete
}
fn cache_files(root: &std::path::Path) -> std::io::Result<std::collections::BTreeSet<PathBuf>> {
    let mut files = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "media") { continue; }
            files.extend(cache_files(&path)?);
        } else {
            files.insert(path);
        }
    }
    Ok(files)
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
    let initial_files = cache_files(&PathBuf::from(&args[3]))?;
    let owner = content.claim("work");
    content.commit("work", owner, SessionUpdate::Read(read))?;
    let token = content.content_token("work").unwrap();
    let mut binding = content.bind("work")?;
    let initial = records(&mut binding, 200).await?;
    assert_eq!(initial.len(), 200);
    assert_eq!(
        cache_files(&PathBuf::from(&args[3]))?,
        initial_files,
        "Host history is displayable without creating body or journal files"
    );
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
    // The real ConversationView supplies interest; a public-core gate must
    // request these visible long records too, not rely on scanning all bodies.
    let interest = expanded.iter().filter(|record| record.content.iter().any(|block|
        matches!(block, aludock_client_core::ContentBlock::Text { text } if text.starts_with("history-250 ") || text.starts_with("fast-body ") || text == "history-239")
    )).map(|record| record.entry_id.clone()).collect();
    content.set_read_interest("work", &token, client.clone(), interest, false);
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
    phase("cache-offline")?;
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
    drop(rebound);
    assert_eq!(
        cache_files(&PathBuf::from(&args[3]))?,
        initial_files,
        "cold read, body completion and Work rebinding add no body or journal files"
    );
    phase("cache-online")?;
    let mut cursor = None;
    let mut history_context = Default::default();
    let semantic_group_entries = loop {
        let (page, _) = client
            .conversation_history(&args[2], cursor.as_deref(), 50, &mut history_context)
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
    // The same descriptor survives full-body assembly and is read by the existing media owner.
    let mixed = restored.iter().find(|record| complete_body(record)).unwrap();
    let ContentBlock::Image { content_ref: Some(reference), mime_type, .. } = &mixed.content[1] else { unreachable!() };
    let target = content.bind("work")?.snapshot.target.unwrap();
    let image = content.conversation_image(&client, MediaScope {
        authority: args[0].clone(), instance_id: args[2].clone(),
        host_epoch: target.owner_host_epoch.unwrap(), runtime_generation: target.runtime_generation,
    }, reference, mime_type, "", None).await?;
    assert_eq!(image.sha256, args[5]);
    assert_eq!(image.size_bytes, 2_097_152);
    println!(
        "{}",
        serde_json::json!({"kind":"content.pass","initial":200,"firstEarlier":50,"rebound":250,"completeBodyBytes":500012,"semanticGroupEntries":semantic_group_entries,"workSwitchRetained":true,"offlineRebindComplete":true,"noBodyOrJournalFiles":true,"beforeEntryId":anchor})
    );
    Ok(())
}
