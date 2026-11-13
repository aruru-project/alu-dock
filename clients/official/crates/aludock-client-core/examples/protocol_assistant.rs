//! Isolated cross-language gate for the personal assistant (card #295); invoked by the root
//! `test:client-protocol` against a production CLI Host, never a managed Host.
use std::{env, path::PathBuf};

use aludock_client_core::{
    AssistantDocumentName, AssistantEntryKind, AssistantEntryRef, AssistantEpisodeEdit,
    AssistantEpisodeState, AssistantExtractionState, AssistantMemoryAction, AssistantMemoryAuthor,
    AssistantMemoryEdit, AssistantMemoryFilter, AssistantMemoryState, AssistantMemoryTopic,
    AssistantTimelineFilter, ClientError, ConnectionRouter, DockClient, IdentityStore,
    LocalDockEndpoint, MachineKind, ModelRef,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("expected socket, isolated identity, recorded session ID".into());
    }
    let store = IdentityStore::new(PathBuf::from(&args[1]));
    let client = DockClient::new(ConnectionRouter::local(
        &store,
        LocalDockEndpoint::configured(&args[0])?,
        "assistant-protocol-gate".into(),
    )?);

    // Her workspace opens new Works as her from the start, and this Host takes that choice.
    let info = client.assistant_info().await?;
    let main = client
        .list_machines()
        .await?
        .into_iter()
        .find(|item| item.kind == MachineKind::Main)
        .ok_or("missing Main")?;
    let workspace = client
        .system_catalog(&info.workspace_path, Some(&main.host_id), None)
        .await?;
    assert!(workspace.default_assistant);
    assert!(workspace.assistant_choice);

    // The shipped persona, and notes saved against the version they were edited from.
    assert!(
        client
            .assistant_preview()
            .await?
            .text
            .contains("你是**阿露**")
    );
    let notes = client
        .assistant_document(AssistantDocumentName::Notes)
        .await?;
    let saved = client
        .set_assistant_document(
            AssistantDocumentName::Notes,
            "主人的猫叫团子。",
            &notes.revision,
            None,
        )
        .await?;
    assert!(
        client
            .assistant_preview()
            .await?
            .text
            .contains("主人的猫叫团子。")
    );
    match client
        .set_assistant_document(
            AssistantDocumentName::Notes,
            "旧版本上的改动",
            &notes.revision,
            None,
        )
        .await
    {
        Err(ClientError::Host { code, .. }) if code == "assistant_document_changed" => {}
        other => {
            return Err(format!("a save from an old version was not refused: {other:?}").into());
        }
    }
    assert_eq!(
        client
            .assistant_document(AssistantDocumentName::Notes)
            .await?
            .revision,
        saved.revision
    );

    // Her recorded conversation: found by a two-character word, read around, and listed by day.
    let found = client
        .assistant_search(Some("团子"), None, None, None, 10)
        .await?;
    let hit = found.hits.first().ok_or("no hit")?;
    assert_eq!(hit.session.session_id, args[2]);
    assert_eq!(hit.kind, AssistantEntryKind::Assistant);
    let around = client
        .assistant_context(&hit.session.session_id, &hit.entry_id, 5, 5)
        .await?;
    assert_eq!(around.entries.len(), 2);
    let day = client
        .assistant_search(
            None,
            Some("2026-11-01T00:00:00.000Z"),
            Some("2026-11-01T23:59:59.000Z"),
            None,
            10,
        )
        .await?;
    assert_eq!(day.hits.len(), 2);

    // Her memories: the owner writes one where it was said; sending it again with the same
    // operation adds nothing more, as a retry after a lost reply does.
    let in_use = AssistantMemoryFilter::default();
    assert!(
        client
            .assistant_memories(&in_use, None, 20)
            .await?
            .memories
            .is_empty()
    );
    let source = AssistantEntryRef {
        session_id: hit.session.session_id.clone(),
        entry_id: hit.entry_id.clone(),
    };
    let write = |operation| {
        client.add_assistant_memory(
            AssistantMemoryTopic::Owner,
            "主人的猫叫团子。",
            false,
            std::slice::from_ref(&source),
            Some(operation),
        )
    };
    let added = write("gate-add").await?;
    assert_eq!(write("gate-add").await?.id, added.id);
    assert_eq!(
        (added.author, added.state, added.source_count),
        (
            AssistantMemoryAuthor::Owner,
            AssistantMemoryState::Active,
            1
        )
    );
    let listed = client.assistant_memories(&in_use, None, 20).await?;
    assert_eq!(listed.memories.len(), 1);
    // A memory is dated by when it was said, not by when it was written.
    assert_eq!(added.said_at, hit.at);

    // Her timeline: the one line the background wrote of that conversation, from its first entry.
    let lines_in_use = AssistantTimelineFilter::default();
    let timeline = client.assistant_timeline(&lines_in_use, None, 20).await?;
    assert_eq!(timeline.episodes.len(), 1);
    let line = &timeline.episodes[0];
    assert_eq!(line.entry_id, "e1");
    let read = client.assistant_episode(&line.id).await?;
    assert_eq!(
        (read.id.as_str(), read.text.as_str(), read.revision),
        (line.id.as_str(), line.text.as_str(), line.revision)
    );
    // The owner rewrites it; a change from the version before is refused.
    let line_edit = |state| AssistantEpisodeEdit {
        state: Some(state),
        ..AssistantEpisodeEdit::default()
    };
    let line_rewritten = client
        .update_assistant_episode(
            &line.id,
            line.revision,
            &AssistantEpisodeEdit {
                text: Some("下午闲聊，聊到家里的猫。".into()),
                ..AssistantEpisodeEdit::default()
            },
            None,
        )
        .await?;
    assert_eq!(
        (
            line_rewritten.text.as_str(),
            line_rewritten.revision,
            line_rewritten.author
        ),
        (
            "下午闲聊，聊到家里的猫。",
            line.revision + 1,
            AssistantMemoryAuthor::Owner
        )
    );
    match client
        .update_assistant_episode(
            &line.id,
            line.revision,
            &line_edit(AssistantEpisodeState::Forgotten),
            None,
        )
        .await
    {
        Err(ClientError::Host { code, .. }) if code == "assistant_episode_changed" => {}
        other => {
            return Err(
                format!("a line change from an old version was not refused: {other:?}").into(),
            );
        }
    }
    // Forgotten, it leaves the lines in use and is listed among those forgotten; restored, it is back.
    let line_forgotten = client
        .update_assistant_episode(
            &line.id,
            line_rewritten.revision,
            &line_edit(AssistantEpisodeState::Forgotten),
            None,
        )
        .await?;
    assert!(
        client
            .assistant_timeline(&lines_in_use, None, 20)
            .await?
            .episodes
            .is_empty()
    );
    let lines_forgotten = AssistantTimelineFilter {
        state: Some(AssistantEpisodeState::Forgotten),
        ..AssistantTimelineFilter::default()
    };
    assert_eq!(
        client
            .assistant_timeline(&lines_forgotten, None, 20)
            .await?
            .episodes[0]
            .id,
        line.id
    );
    client
        .update_assistant_episode(
            &line.id,
            line_forgotten.revision,
            &line_edit(AssistantEpisodeState::Active),
            None,
        )
        .await?;
    assert_eq!(
        client
            .assistant_timeline(&lines_in_use, None, 20)
            .await?
            .episodes[0]
            .id,
        line.id
    );
    // A line that does not exist is refused by its own code.
    match client.assistant_episode("999").await {
        Err(ClientError::Host { code, .. }) if code == "assistant_episode_not_found" => {}
        other => return Err(format!("expected no timeline line, got {other:?}").into()),
    }

    // Rewritten and loaded every session; a change from the version before is refused.
    let edit = |state| AssistantMemoryEdit {
        state: Some(state),
        ..AssistantMemoryEdit::default()
    };
    let rewritten = client
        .update_assistant_memory(
            &added.id,
            added.revision,
            &AssistantMemoryEdit {
                text: Some("主人的猫叫团子，是只橘猫。".into()),
                resident: Some(true),
                ..AssistantMemoryEdit::default()
            },
            None,
        )
        .await?;
    match client
        .update_assistant_memory(
            &added.id,
            added.revision,
            &edit(AssistantMemoryState::Retired),
            None,
        )
        .await
    {
        Err(ClientError::Host { code, .. }) if code == "assistant_memory_changed" => {}
        other => {
            return Err(format!("a change from an old version was not refused: {other:?}").into());
        }
    }
    assert!(
        client
            .assistant_preview()
            .await?
            .text
            .contains("主人的猫叫团子，是只橘猫。")
    );

    // Deleted: she forgets it, and the words it came from are not found or read either.
    let forgotten = client
        .update_assistant_memory(
            &rewritten.id,
            rewritten.revision,
            &edit(AssistantMemoryState::Forgotten),
            None,
        )
        .await?;
    assert!(
        client
            .assistant_memories(&in_use, None, 20)
            .await?
            .memories
            .is_empty()
    );
    let deleted = AssistantMemoryFilter {
        state: Some(AssistantMemoryState::Forgotten),
        ..AssistantMemoryFilter::default()
    };
    assert_eq!(
        client
            .assistant_memories(&deleted, None, 20)
            .await?
            .memories[0]
            .id,
        added.id
    );
    assert!(!client.assistant_preview().await?.text.contains("橘猫"));
    let unsaid = client
        .assistant_search(Some("团子"), None, None, None, 10)
        .await?;
    assert!(unsaid.hits.is_empty());
    let where_said = client
        .assistant_context(&source.session_id, &source.entry_id, 0, 0)
        .await?;
    assert!(!where_said.entries[0].text.contains("团子"));

    // Restored: in use again under its topic, and the words are found again.
    let restored = client
        .update_assistant_memory(
            &forgotten.id,
            forgotten.revision,
            &edit(AssistantMemoryState::Active),
            None,
        )
        .await?;
    let owner = AssistantMemoryFilter {
        topic: Some(AssistantMemoryTopic::Owner),
        ..AssistantMemoryFilter::default()
    };
    assert_eq!(
        client.assistant_memories(&owner, None, 20).await?.memories[0].id,
        added.id
    );
    assert_eq!(
        client
            .assistant_search(Some("团子"), None, None, None, 10)
            .await?
            .hits
            .len(),
        1
    );
    // The line covering those words was put away with the memory and came back with it, still
    // as the owner rewrote it.
    let lines_back = client.assistant_timeline(&lines_in_use, None, 20).await?;
    assert_eq!(lines_back.episodes.len(), 1);
    assert_eq!(
        (
            lines_back.episodes[0].id.as_str(),
            lines_back.episodes[0].author
        ),
        (line.id.as_str(), AssistantMemoryAuthor::Owner)
    );
    let detail = client.assistant_memory(&restored.id).await?;
    let history: Vec<_> = detail.history.iter().map(|change| change.action).collect();
    assert_eq!(
        history,
        [
            AssistantMemoryAction::Restored,
            AssistantMemoryAction::Forgotten,
            AssistantMemoryAction::Resident,
            AssistantMemoryAction::Rewritten,
            AssistantMemoryAction::Added,
        ]
    );

    // Settings: without a model nothing is made into memories, and the conversation waits.
    assert!(
        client
            .assistant_settings()
            .await?
            .extraction_model
            .is_none()
    );
    let off = client
        .assistant_info()
        .await?
        .extraction
        .ok_or("no status")?;
    assert_eq!(
        (off.state, off.waiting_sessions),
        (AssistantExtractionState::Off, 1)
    );
    let model = ModelRef {
        provider: "gate-provider".into(),
        id: "gate-model".into(),
    };
    let chosen = client
        .set_assistant_settings(
            &aludock_client_core::AssistantSettingsEdit {
                extraction_model: Some(Some(model.clone())),
                ..Default::default()
            },
            None,
        )
        .await?;
    assert_eq!(chosen.extraction_model.as_ref(), Some(&model));
    assert_eq!(
        client.assistant_settings().await?.extraction_model.as_ref(),
        Some(&model)
    );
    let on = client
        .assistant_info()
        .await?
        .extraction
        .ok_or("no status")?;
    assert_ne!(on.state, AssistantExtractionState::Off);
    // Starting over keeps what the owner wrote or rewrote and reads every conversation again with
    // the model.
    let again = client.reorganize_assistant(&model, None).await?;
    assert_eq!(
        (
            again.extraction_model,
            again.retired_memories,
            again.removed_lines
        ),
        (model.clone(), 0, 0)
    );
    assert!(
        client
            .set_assistant_settings(
                &aludock_client_core::AssistantSettingsEdit {
                    extraction_model: Some(None),
                    ..Default::default()
                },
                None
            )
            .await?
            .extraction_model
            .is_none()
    );
    assert!(
        client
            .assistant_settings()
            .await?
            .extraction_model
            .is_none()
    );
    println!(
        "assistant gate: workspace={} hits={} context={} day={} history={} waiting={} lines={}",
        info.workspace_path,
        found.hits.len(),
        around.entries.len(),
        day.hits.len(),
        detail.history.len(),
        off.waiting_sessions,
        timeline.episodes.len()
    );
    Ok(())
}
