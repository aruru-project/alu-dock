//! Upload a photo and send its real receipt; observe the normal SDK user record
//! live, in history, and after reload. Driver: tests/attachmentMediaProtocol.test.mjs.
//! The public native owner imports the source, records the receipt and resolves media.
use aludock_client_core::{
    AttachmentDto, AttachmentState, AttachmentUploadScope, ConnectionRouter, ContentBlock,
    DeliveryMode, DockClient, HistoryRecord, IdentityStore, InstanceSelector, LocalDockEndpoint,
    MediaHandle, MediaScope, NativeAttachment, ReadReplay, SessionContent, SessionUpdate,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::Path,
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    path: String,
    sha256: String,
    size_bytes: u64,
}

fn save(root: &Path, name: &str, value: &impl serde::Serialize) -> Result<()> {
    fs::write(root.join(name), serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

struct Media {
    content: SessionContent,
    authority: String,
    previews: HashMap<String, MediaHandle>,
}
impl Media {
    async fn scope(&self, client: &DockClient, work: &str) -> Result<MediaScope> {
        let read = client
            .read_instance(work, None, ReadReplay::ConversationBootstrap)
            .await?;
        let scope = MediaScope {
            authority: serde_json::to_string(&(
                &self.authority,
                work,
                &read.page.latest.host_epoch,
            ))?,
            instance_id: work.into(),
            host_epoch: read.page.latest.host_epoch.clone(),
            runtime_generation: read.instance.runtime_generation,
        };
        let read_machine = read.instance.host_id.clone();
        let owner = self.content.claim(&scope.authority);
        assert!(
            self.content
                .commit(&scope.authority, owner, SessionUpdate::Read(read))?
        );
        let (catalog, epoch) = client
            .list_instances_with_host_epoch(InstanceSelector::Actionable)
            .await?;
        let selected = catalog
            .instances
            .iter()
            .find(|i| i.id == work)
            .ok_or("Work absent from real catalog")?;
        assert_eq!(epoch, scope.host_epoch);
        assert_eq!(selected.runtime_generation, scope.runtime_generation);
        assert_eq!(
            read_machine, selected.host_id,
            "full Main read must carry the catalog Machine"
        );
        Ok(scope)
    }
}

// Expected fileIds come only from actual upload receipts. Matching by SHA of
// bytes read through the public API catches a swapped image/fileId association,
// including the same-name, different-original pair in the second turn.
async fn check_user(
    client: &DockClient,
    media: &Media,
    work: &str,
    content: &[ContentBlock],
    attachments: &[AttachmentDto],
    expected: &[AttachmentDto],
) -> Result<Vec<Value>> {
    assert_eq!(attachments.len(), expected.len(), "user lost attachments");
    for receipt in expected {
        assert_eq!(
            attachments.iter().find(|a| a.file_id == receipt.file_id),
            Some(receipt),
            "user attachment must be the actual upload receipt"
        );
    }
    let images: Vec<_> = content
        .iter()
        .filter(|block| matches!(block, ContentBlock::Image { .. }))
        .collect();
    assert_eq!(
        images.len(),
        expected.len(),
        "normal user record lost images"
    );
    let scope = media.scope(client, work).await?;
    let mut proofs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for image in images {
        let ContentBlock::Image {
            mime_type,
            content_ref,
            file_id,
            ..
        } = image
        else {
            unreachable!()
        };
        let file_id = file_id.as_ref().ok_or("user image lacks uploaded fileId")?;
        let receipt = expected
            .iter()
            .find(|a| &a.file_id == file_id)
            .ok_or("user image refers to a different attachment")?;
        assert!(
            seen.insert(file_id),
            "user images duplicated one attachment"
        );
        assert_eq!(mime_type, "image/png");
        let reference = content_ref
            .as_ref()
            .ok_or("user image lacks readable contentRef")?;
        // Rebound views and later runtime generations use the real standard
        // fileId; no attachment DTO or opaque contentRef is synthesized.
        let rebound = media.content.clone();
        let handle = rebound
            .conversation_image(
                client,
                scope.clone(),
                reference,
                mime_type,
                &media.authority,
                Some(file_id),
            )
            .await?;
        let preview = &media.previews[file_id];
        assert_eq!(
            handle.handle, preview.handle,
            "live/history must use the imported preview file"
        );
        let mut bytes = Vec::new();
        rebound
            .open_media(&handle.handle)?
            .1
            .read_to_end(&mut bytes)?;
        let sha = hex::encode(Sha256::digest(&bytes));
        assert_eq!(
            sha, receipt.sha256,
            "image bytes/fileId paired to wrong original"
        );
        assert_eq!(bytes.len() as u64, receipt.size_bytes);
        assert_eq!(handle.sha256, sha);
        proofs.push(
            json!({"fileId":file_id, "contentRef":reference, "sha256":sha,
            "sizeBytes":bytes.len(), "mimeType":mime_type, "handle":handle.handle, "previewHandle":preview.handle}),
        );
    }
    Ok(proofs)
}

fn is_turn(record: &HistoryRecord, prompt: &str) -> bool {
    record.source == "user"
        && record
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Text { text } if text == prompt))
}

async fn check_history(
    client: &DockClient,
    media: &Media,
    work: &str,
    root: &Path,
    label: &str,
    prompt: &str,
    expected: &[AttachmentDto],
) -> Result<Value> {
    let (page, epoch) = client.conversation_history(work, None, 50).await?;
    // Preserve the actual DTO before assertions, including on a producer failure.
    save(root, &format!("{label}.json"), &page)?;
    let users: Vec<_> = page
        .entries
        .iter()
        .filter(|e| is_turn(&e.entry, prompt))
        .collect();
    assert_eq!(
        users.len(),
        1,
        "normal SDK history must contain this user turn"
    );
    let record = &users[0].entry;
    let images = check_user(
        client,
        media,
        work,
        &record.content,
        &record.attachments,
        expected,
    )
    .await?;
    Ok(
        json!({"entryId":record.entry_id, "recordId":record.record_id,
        "runtimeGeneration":page.instance.runtime_generation, "hostEpoch":epoch, "images":images}),
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() != 5 {
        return Err(
            "expected socket, identity directory, Work, source manifest, evidence directory".into(),
        );
    }
    let root = Path::new(&args[4]);
    let store = IdentityStore::new(&args[1]);
    let client = DockClient::new(ConnectionRouter::local(
        &store,
        LocalDockEndpoint::configured(&args[0])?,
        "attachment-media-gate".into(),
    )?);
    let sources: Vec<Source> = serde_json::from_slice(&fs::read(&args[3])?)?;
    assert_eq!(sources.len(), 2);
    assert_ne!(sources[0].sha256, sources[1].sha256);
    let content = SessionContent::in_directory(root.join("native-cache"))?;
    let jobs = AttachmentState::new(content.clone());
    let mut media = Media {
        content,
        authority: serde_json::to_string(&("local", &args[0]))?,
        previews: HashMap::new(),
    };
    let mut receipts = Vec::new();
    let mut imports = Vec::new();
    let mut turns = Vec::new();
    let mut events = fs::File::create(root.join("live.jsonl"))?;
    for (index, source) in sources.iter().enumerate() {
        // The driver hashes generated source bytes independently in Node. Check
        // the fixture on disk too; no digest comes from a Dock helper/response.
        let bytes = fs::read(&source.path)?;
        assert_eq!(hex::encode(Sha256::digest(&bytes)), source.sha256);
        assert_eq!(bytes.len() as u64, source.size_bytes);
        let imported = media
            .content
            .import_attachment_file(Path::new(&source.path))?;
        assert_ne!(imported.path(), Path::new(&source.path));
        assert_eq!(imported.sha256(), source.sha256);
        let preview = media
            .content
            .attachment_preview(imported.clone(), "image/png")?;
        let (_, mut preview_file) = media.content.open_media(&preview.handle)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let source_stat = fs::metadata(&imported.path())?;
            assert_eq!(
                (
                    preview_file.metadata()?.dev(),
                    preview_file.metadata()?.ino()
                ),
                (source_stat.dev(), source_stat.ino())
            );
        }
        // Source changes happen AFTER import, BEFORE both preview read and upload.
        if index == 0 {
            fs::write(&source.path, vec![b'x'; bytes.len()])?;
        } else {
            fs::remove_file(&source.path)?;
        }
        let mut shown = Vec::new();
        preview_file.read_to_end(&mut shown)?;
        assert_eq!(hex::encode(Sha256::digest(&shown)), source.sha256);
        let read = client
            .read_instance(&args[2], None, ReadReplay::ConversationBootstrap)
            .await?;
        let (catalog, epoch) = client
            .list_instances_with_host_epoch(InstanceSelector::Actionable)
            .await?;
        let actual = catalog
            .instances
            .iter()
            .find(|i| i.id == args[2])
            .ok_or("missing actual Work")?;
        assert_eq!(epoch, read.page.latest.host_epoch);
        assert_eq!(actual.runtime_generation, read.instance.runtime_generation);
        save(
            root,
            &format!("native-target-{index}.json"),
            &json!({"readInstance": read.instance, "catalogInstance":actual}),
        )?;
        assert_eq!(
            read.instance.host_id, actual.host_id,
            "full Main read must carry the catalog Machine"
        );
        let target = AttachmentUploadScope {
            machine_host_id: actual.host_id.clone().ok_or("missing actual Machine")?,
            owner_host_epoch: read.page.latest.host_epoch.clone(),
            runtime_generation: read.instance.runtime_generation,
        };
        let token = format!("source-{index}");
        let mut entry = NativeAttachment::new(
            imported.clone(),
            "local".into(),
            args[2].clone(),
            "photo.png".into(),
            Some("image/png".into()),
        );
        entry.authority = media.authority.clone();
        jobs.insert(token.clone(), entry);
        let (send, mut changes) = tokio::sync::mpsc::unbounded_channel();
        jobs.start(&token, target, client.clone(), move |cut| {
            let _ = send.send(cut);
        })?;
        let uploaded = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let cut = changes
                    .recv()
                    .await
                    .ok_or("native upload ended without result")?;
                if let Some(result) = cut.result {
                    break Ok::<_, Box<dyn std::error::Error>>(result);
                }
                if let Some(error) = cut.error {
                    return Err(error.message.into());
                }
            }
        })
        .await??;
        save(root, &format!("receipt-{index}.json"), &uploaded)?;
        assert_eq!(uploaded.attachment.sha256, source.sha256);
        assert_eq!(uploaded.attachment.size_bytes, source.size_bytes);
        assert_eq!(uploaded.attachment.media_type.as_deref(), Some("image/png"));
        media
            .previews
            .insert(uploaded.attachment.file_id.clone(), preview.clone());
        imports.push(json!({"sourceSha256":source.sha256,"privatePath":imported.path(),"preview":preview,
            "fileId":uploaded.attachment.file_id,"sourceChange":if index == 0 {"same-length-overwrite"} else {"delete"}}));
        receipts.push(uploaded.attachment);

        // First prove one original. Only then add one same-name/different-byte
        // pairing branch, reversing the order of the two actual receipts.
        let expected: Vec<_> = receipts.iter().rev().cloned().collect();
        let ids: Vec<_> = expected.iter().map(|r| r.file_id.clone()).collect();
        let prompt = format!("attachment gate turn {index}: these are the original photos");
        let operation = format!("attachment-submit-{index}");
        let read = client
            .read_instance(&args[2], None, ReadReplay::ConversationBootstrap)
            .await?;
        let (_, mut follow) = client.follow_instance(&args[2], &read.page.latest).await?;
        let submitted = client
            .submit_message_with_attachments(
                &args[2],
                &prompt,
                &ids,
                DeliveryMode::Prompt,
                Some(&operation),
            )
            .await?;
        save(root, &format!("submit-{index}.json"), &submitted)?;
        assert!(submitted.receipt.accepted);
        assert!(!submitted.receipt.queued);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut users = Vec::new();
        loop {
            let event = tokio::time::timeout_at(deadline, follow.next_event()).await??;
            writeln!(events, "{}", serde_json::to_string(&event)?)?;
            events.flush()?;
            if event.event_type == "message.completed" && event.data["role"] == "user" {
                users.push(event.data.clone());
            }
            if event.event_type == "run.settled" && event.data["operationId"] == operation {
                assert_eq!(
                    event.data["result"], "succeeded",
                    "loopback SDK turn failed"
                );
                break;
            }
        }
        drop(follow);
        assert_eq!(
            users.len(),
            1,
            "must observe a real live user completion, not only input"
        );
        let content: Vec<ContentBlock> = serde_json::from_value(users[0]["content"].clone())?;
        let attachments: Vec<AttachmentDto> =
            serde_json::from_value(users[0]["attachments"].clone())?;
        assert!(
            content
                .iter()
                .any(|b| matches!(b, ContentBlock::Text { text } if text == &prompt))
        );
        let live = check_user(&client, &media, &args[2], &content, &attachments, &expected).await?;
        let history = check_history(
            &client,
            &media,
            &args[2],
            root,
            &format!("history-{index}"),
            &prompt,
            &expected,
        )
        .await?;
        let reload = client
            .reload_session(&args[2], Some(&format!("attachment-reload-{index}")))
            .await?;
        save(root, &format!("reload-{index}.json"), &reload)?;
        let persisted = check_history(
            &client,
            &media,
            &args[2],
            root,
            &format!("persisted-{index}"),
            &prompt,
            &expected,
        )
        .await?;
        assert_eq!(
            history["entryId"], persisted["entryId"],
            "reload must read the same SDK record"
        );
        assert!(persisted["runtimeGeneration"].as_u64() > history["runtimeGeneration"].as_u64());
        turns.push(json!({"prompt":prompt, "expectedFileIds":ids, "live":live,
            "history":history, "afterReload":persisted}));
    }
    assert_eq!(
        fs::read(&sources[0].path)?,
        vec![b'x'; sources[0].size_bytes as usize],
        "private cleanup must not delete the user original"
    );
    let report = json!({"imports": imports, "kind":"attachment-media.pass", "receipts":receipts, "turns":turns});
    save(root, "rust-result.json", &report)?;
    println!("{report}");
    Ok(())
}
