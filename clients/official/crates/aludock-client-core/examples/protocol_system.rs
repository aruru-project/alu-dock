//! Isolated cross-language gate; invoked by tests/systemProtocol.test.mjs, never a managed Host.
use std::{env, path::PathBuf};

use aludock_client_core::{
    ClientError, ConnectionRouter, DockClient, IdentityStore, LocalDockEndpoint, MachineKind,
    ProjectTrustDecision,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("expected socket, isolated identity, workspace".into());
    }
    let store = IdentityStore::new(PathBuf::from(&args[1]));
    let client = DockClient::new(ConnectionRouter::local(
        &store,
        LocalDockEndpoint::configured(&args[0])?,
        "system-protocol-gate".into(),
    )?);
    let main = client
        .list_machines()
        .await?
        .into_iter()
        .find(|item| item.kind == MachineKind::Main)
        .ok_or("missing Main")?;
    let host_id = Some(main.host_id.as_str());
    let cwd = &args[2];
    let mut page = client.system_catalog(cwd, host_id, None).await?;
    assert!(page.default_selection.is_none());
    let mut candidates = page.candidates;
    while let Some(cursor) = page.next_cursor {
        page = client.system_catalog(cwd, host_id, Some(&cursor)).await?;
        candidates.extend(page.candidates);
    }
    assert_eq!(candidates.first().unwrap().name, "SYSTEM.md");
    let chosen = candidates
        .iter()
        .find(|item| item.path.ends_with("chosen.json"))
        .ok_or("missing chosen template")?;
    assert!(chosen.warning.is_none());
    let mut text = String::new();
    let mut offset = None;
    let mut revision = None;
    let mut pages = 0;
    loop {
        let content = client
            .system_content(cwd, &chosen.id, host_id, offset, revision.as_deref())
            .await?;
        text.push_str(&content.text);
        pages += 1;
        offset = content.next_offset;
        revision = Some(content.revision);
        if offset.is_none() {
            break;
        }
    }
    assert!(text.starts_with('\u{feff}'));
    assert!(text.contains("RUST HOST SYSTEM"));
    assert!(pages > 1, "read the complete original through continuation");
    assert!(
        client
            .system_catalog(cwd, host_id, None)
            .await?
            .default_selection
            .is_none()
    );
    let saved = client
        .set_system_default(cwd, &chosen.id, host_id, Some("system-save-gate"))
        .await?;
    assert_eq!(saved.selection.id, chosen.id);
    let default = client
        .system_catalog(cwd, host_id, None)
        .await?
        .default_selection
        .unwrap();
    assert_eq!(default.worker_config, chosen.worker_config);
    let operation = "system-create-gate";
    let first = client
        .create_instance_for_machine(
            cwd,
            None,
            None,
            Some(operation),
            host_id,
            Some(&chosen.worker_config),
        )
        .await;
    let challenge = match first {
        Err(ClientError::Host {
            code,
            details: Some(details),
            ..
        }) if code == "project_trust_required" => {
            assert_eq!(details["operationId"], operation);
            details["challengeId"]
                .as_str()
                .ok_or("missing trust challenge")?
                .to_owned()
        }
        other => return Err(format!("expected explicit trust request, got {other:?}").into()),
    };
    let work = client
        .create_instance_for_machine(
            cwd,
            None,
            Some((&challenge, ProjectTrustDecision::TrustOnce)),
            Some(operation),
            host_id,
            Some(&chosen.worker_config),
        )
        .await?;
    let resources = client.resources(&work.id).await?;
    let mut matched = false;
    for resource in resources.resources {
        if let Some(reference) = resource.content_ref {
            let mut actual = String::new();
            let mut offset = None;
            let mut revision = None;
            loop {
                let content = client
                    .resource_content(&work.id, &reference, offset, revision.as_deref())
                    .await?;
                actual.push_str(&content.text);
                offset = content.next_offset;
                revision = Some(content.revision);
                if offset.is_none() {
                    break;
                }
            }
            if actual == text {
                matched = true;
            }
        }
    }
    assert!(
        matched,
        "created Work must expose the chosen template's original, not project SYSTEM"
    );
    client.stop_instance(&work.id, None).await?;
    println!(
        "PASS Rust→Host→Pi: target catalog, paged BOM original, explicit save, trust continuation with chosen config, Work actual source, stop (no model)"
    );
    Ok(())
}
