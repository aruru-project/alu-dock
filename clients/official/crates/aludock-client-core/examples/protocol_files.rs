//! Real Host boundary gate: all file calls use the public Rust client and provisional sinks.
use aludock_client_core::{
    AttachmentUploadCancellation, ConnectionRouter, DockClient, IdentityStore, LocalDockEndpoint,
    PublishedFileDto,
};
use std::{env, path::PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let descriptor: serde_json::Value = serde_json::from_slice(&tokio::fs::read(&args[2]).await?)?;
    let get = |key: &str| descriptor[key].as_str().unwrap();
    let store = IdentityStore::new(PathBuf::from(get("identity")));
    let router = ConnectionRouter::local(
        &store,
        LocalDockEndpoint::configured(&args[1])?,
        "file-protocol-gate".into(),
    )?;
    let client = DockClient::new(router);
    let instance = get("instanceId");
    let expected = tokio::fs::read(get("source")).await?;
    let mut sink = tokio::fs::File::create(get("output")).await?;
    let workspace = client
        .read_workspace_file(instance, "file.png", &mut sink, |_| Ok(()), |_| {})
        .await?;
    assert_eq!(workspace.size_bytes, expected.len() as u64);
    drop(sink);
    assert_eq!(tokio::fs::read(get("output")).await?, expected);
    let file: PublishedFileDto = serde_json::from_value(descriptor["published"].clone())?;
    let mut bytes = Vec::new();
    let published = client
        .read_published_file(instance, &file, &mut bytes)
        .await?;
    assert_eq!(bytes, expected);
    assert_eq!(published.sha256, workspace.sha256);
    bytes.clear();
    let delivery = client
        .download_deliverable(instance, get("deliveryRef"), &mut bytes, |_| {})
        .await?;
    assert_eq!(bytes, expected);
    assert_eq!(delivery.sha256, workspace.sha256);
    let resource = client
        .resource_content_all(instance, "resource-fixture")
        .await?;
    assert_eq!(resource.text, String::from_utf8(expected.clone())?);
    let system = client
        .system_content_all(get("cwd"), get("systemId"), None)
        .await?;
    assert_eq!(system.text, resource.text);
    let receipt = client
        .upload_attachment_file(
            get("source"),
            "rust-file-upload",
            instance,
            "upload.bin",
            None,
            &AttachmentUploadCancellation::default(),
            |_| {},
        )
        .await?;
    assert_eq!(receipt.attachment.sha256, workspace.sha256);
    assert_eq!(receipt.attachment.size_bytes, expected.len() as u64);
    // A retained published descriptor is the caller's identity, not a display hint.
    let mut wrong = file.clone();
    wrong.name = "different-file.png".into();
    let mut rejected_sink = Vec::new();
    assert!(
        client
            .read_published_file(instance, &wrong, &mut rejected_sink)
            .await
            .is_err()
    );
    assert!(
        rejected_sink.is_empty(),
        "wrong readiness must not write the provisional sink"
    );
    // Ensure the real output sink remains usable after protocol completion.
    let mut saved = tokio::fs::File::open(get("output")).await?;
    saved.rewind().await?;
    let mut first = [0];
    saved.read_exact(&mut first).await?;
    assert_eq!(first[0], b'a');
    println!(
        "Rust file upload and five continuous reads verified {} bytes",
        expected.len()
    );
    Ok(())
}
