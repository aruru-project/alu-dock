//! Isolated cross-language gate for the personal assistant (card #295); invoked by the root
//! `test:client-protocol` against a production CLI Host, never a managed Host.
use std::{env, path::PathBuf};

use aludock_client_core::{
    AssistantDocumentName, AssistantEntryKind, ClientError, ConnectionRouter, DockClient,
    IdentityStore, LocalDockEndpoint, MachineKind,
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

    // Her workspace opens new Works as her from the start.
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
    println!(
        "assistant gate: workspace={} hits={} context={} day={}",
        info.workspace_path,
        found.hits.len(),
        around.entries.len(),
        day.hits.len()
    );
    Ok(())
}
