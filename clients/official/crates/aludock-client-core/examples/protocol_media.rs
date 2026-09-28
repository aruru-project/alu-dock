//! Real Host/Worker media gate. See tests/mediaProtocol.test.mjs for isolation.
use aludock_client_core::{
    ConnectionRouter, ContentBlock, DockClient, IdentityStore, LocalDockEndpoint, MediaScope,
    ReadReplay, SessionContent, SessionUpdate,
};
use sha2::{Digest, Sha256};
use std::{env, io::Read, path::PathBuf, time::Instant};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() != 6 {
        return Err("expected socket, identity, Work, cache root, expected SHA, fault mode".into());
    }
    let store = IdentityStore::new(PathBuf::from(&args[1]));
    let client = DockClient::new(ConnectionRouter::local(
        &store,
        LocalDockEndpoint::configured(&args[0])?,
        "media-gate".into(),
    )?);
    let content = SessionContent::in_directory(PathBuf::from(&args[3]))?;
    let started = Instant::now();
    let read = client
        .read_instance(&args[2], None, ReadReplay::ConversationBootstrap)
        .await
        .map_err(|e| format!("instance.read: {e}"))?;
    let owner = content.claim("work");
    content.commit("work", owner, SessionUpdate::Read(read))?;
    let (page, host_epoch) = client
        .conversation_history(&args[2], None, 50, &mut Default::default())
        .await
        .map_err(|e| format!("conversation.history: {e}"))?;
    let descriptor_ms = started.elapsed().as_secs_f64() * 1000.0;
    let (content_ref, mime_type) = page
        .entries
        .iter()
        .flat_map(|entry| &entry.entry.content)
        .find_map(|block| {
            if let ContentBlock::Image {
                content_ref: Some(reference),
                mime_type,
                ..
            } = block
            {
                Some((reference, mime_type))
            } else {
                None
            }
        })
        .ok_or("real Worker did not expose the source image descriptor")?;
    let scope = MediaScope {
        authority: args[0].clone(),
        instance_id: args[2].clone(),
        host_epoch,
        runtime_generation: page.instance.runtime_generation,
    };
    if args[5] == "sha" {
        let error = content
            .conversation_image(&client, scope.clone(), content_ref, mime_type, "", None)
            .await
            .unwrap_err();
        eprintln!("Rejected media: {error}");
        // Transmission integrity boundary: neither an indexed file nor a partial
        // may survive a failed terminal SHA check.
        for run in std::fs::read_dir(&args[3])? {
            let media = run?.path().join("media");
            if media.is_dir() {
                assert_eq!(std::fs::read_dir(media)?.count(), 0);
            }
        }
    }
    let cold = Instant::now();
    let (one, two) = tokio::join!(
        content.conversation_image(&client, scope.clone(), content_ref, mime_type, "", None),
        content.conversation_image(&client, scope.clone(), content_ref, mime_type, "", None)
    );
    let one = one.map_err(|e| format!("conversation.image: {e}"))?;
    let two = two?;
    let cold_ms = cold.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(one.handle, two.handle);
    assert_eq!(one.sha256, args[4]);
    let read_started = Instant::now();
    let (_, mut file) = content.open_media(&one.handle)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    drop(file);
    let disk_ms = read_started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(hex::encode(Sha256::digest(&bytes)), args[4]);
    assert_eq!(bytes.len() as u64, one.size_bytes);
    std::fs::write(
        PathBuf::from(&args[3])
            .parent()
            .unwrap()
            .join("verified.png"),
        &bytes,
    )?;
    let original_handle = one.handle.clone();
    #[cfg(unix)]
    let original_inode = {
        use std::os::unix::fs::MetadataExt;
        content.open_media(&one.handle)?.1.metadata()?.ino()
    };
    drop(bytes);
    drop(one);
    drop(two);
    // A rebuilt display retains no decoded/native image buffer. Even with a
    // completely unavailable transport, the same trusted request finds disk.
    drop(content.bind("work")?);
    let offline = DockClient::new(ConnectionRouter::local(
        &store,
        LocalDockEndpoint::configured(&format!("{}.missing", args[0]))?,
        "offline-display".into(),
    )?);
    let hot = Instant::now();
    let cached = content
        .conversation_image(&offline, scope.clone(), content_ref, mime_type, "", None)
        .await?;
    let hot_ms = hot.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(cached.sha256, args[4]);
    assert_eq!(cached.handle, original_handle);
    let (_, file) = content.open_media(&cached.handle)?;
    assert_eq!(file.metadata()?.len(), cached.size_bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(file.metadata()?.ino(), original_inode);
        assert_eq!(file.metadata()?.mode() & 0o777, 0o600);
    }
    println!(
        "{}",
        serde_json::json!({"kind":"media.pass", "descriptorMs":descriptor_ms, "coldDownloadCommitMs":cold_ms, "diskReadMs":disk_ms, "hotLookupMs":hot_ms, "sizeBytes":cached.size_bytes, "sha256":cached.sha256, "handle":cached.handle, "sameFileOffline":true, "contentRef":content_ref, "mimeType":mime_type, "hostEpoch":scope.host_epoch, "runtimeGeneration":scope.runtime_generation, "ipcImageBytes":null, "displayDecodeMs":null})
    );
    Ok(())
}
