//! Verified App-lifetime media, separate from disposable display resources.
//! Only successful stream validation + fsync + atomic publication enters the index.
use crate::{
    AttachmentSource, ClientError, DockClient, Result,
    fs_publish::publish_new_file,
    private_fs::{set_private_directory_permissions, storage_error, sync_directory},
    run_cache::RunCache,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, watch};

// Existing attachment preview limit, shared with the platform import/display boundary.
pub const MAX_ATTACHMENT_PREVIEW_BYTES: u64 = 64 * 1_024 * 1_024;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MediaScope {
    /// Native-resolved authority (including the configured local endpoint).
    pub authority: String,
    pub instance_id: String,
    pub host_epoch: String,
    pub runtime_generation: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaHandle {
    pub handle: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ImageKey {
    scope: MediaScope,
    content_ref: String,
    mime_type: String,
}
struct StoredMedia {
    descriptor: MediaHandle,
    source: Arc<AttachmentSource>,
}
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ReceiptKey {
    pub authority: String,
    pub machine_host_id: String,
    pub file_id: String,
}
struct ImageFlight {
    transfer: AsyncMutex<()>,
    ready: watch::Sender<Option<MediaHandle>>,
    attachment: Mutex<Option<ReceiptKey>>,
}
impl Default for ImageFlight {
    fn default() -> Self {
        Self {
            transfer: AsyncMutex::new(()),
            ready: watch::channel(None).0,
            attachment: Mutex::new(None),
        }
    }
}
type Flight = Arc<ImageFlight>;
#[derive(Default)]
struct Index {
    images: HashMap<ImageKey, Flight>,
    published: HashMap<(MediaScope, crate::PublishedFileDto), Flight>,
    handles: HashMap<String, StoredMedia>,
    receipts: HashMap<ReceiptKey, MediaHandle>,
    sources: HashMap<(String, u64), Weak<AttachmentSource>>,
    inline: HashMap<(MediaScope, String, String), MediaHandle>,
    // Bytes outlive every request/Session domain. A new alias may use these only
    // after its independently verified SHA/length/MIME agrees, never by ref text.
    digests: HashMap<(String, u64, String), MediaHandle>,
}
pub(crate) struct SessionMedia {
    run: Arc<RunCache>,
    index: Mutex<Index>,
    // Each transfer decodes at most the existing 512 KiB protocol chunk; never
    // reserve the declared full image size. This limits network/sink work, not
    // decoded WebView pixels or retained disk bytes.
    transfers: Semaphore,
}
impl SessionMedia {
    pub fn new(run: Arc<RunCache>) -> Self {
        Self {
            run,
            index: Mutex::new(Index::default()),
            transfers: Semaphore::new(3),
        }
    }
    /// Import once into the same private run as downloaded media. Dropping an
    /// unaccepted result removes its file, including a cancelled blocking import.
    pub fn import_attachment(&self, mut reader: impl Read) -> Result<Arc<AttachmentSource>> {
        let mut provisional = Provisional::create(&self.run)?;
        let mut hash = Sha256::new();
        let mut size = 0;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > crate::MAX_ATTACHMENT_BYTES {
                return Err(ClientError::AttachmentTooLarge {
                    size_bytes: size,
                    maximum_bytes: crate::MAX_ATTACHMENT_BYTES,
                });
            }
            provisional
                .file
                .write_all(&buffer[..count])
                .map_err(|e| storage_error(&provisional.path, e))?;
            hash.update(&buffer[..count]);
        }
        provisional
            .file
            .sync_all()
            .map_err(|e| storage_error(&provisional.path, e))?;
        self.finish_source(provisional, size, hex::encode(hash.finalize()))
    }
    fn finish_source(
        &self,
        provisional: Provisional,
        size_bytes: u64,
        sha256: String,
    ) -> Result<Arc<AttachmentSource>> {
        let mut index = self.index.lock().unwrap();
        index.sources.retain(|_, source| source.strong_count() > 0);
        let key = (sha256.clone(), size_bytes);
        if let Some(source) = index.sources.get(&key).and_then(Weak::upgrade) {
            return Ok(source);
        }
        let mut header = [0_u8; 16];
        let count = File::open(&provisional.path)
            .and_then(|mut f| f.read(&mut header))
            .map_err(|e| storage_error(&provisional.path, e))?;
        let raster_mime = raster_mime_type(&header[..count]);
        let path = provisional.path.with_extension("file");
        if !publish_new_file(&provisional.path, &path).map_err(|e| storage_error(&path, e))? {
            return Err(ClientError::Protocol(
                "private source destination exists".into(),
            ));
        }
        let source = Arc::new(AttachmentSource {
            path,
            size_bytes,
            sha256,
            raster_mime,
            _run: self.run.clone(),
        });
        sync_directory(source.path.parent().unwrap())?;
        index.sources.insert(key, Arc::downgrade(&source));
        Ok(source)
    }
    pub fn attachment_preview(
        &self,
        source: Arc<AttachmentSource>,
        mime: &str,
    ) -> Result<MediaHandle> {
        if source.size_bytes > MAX_ATTACHMENT_PREVIEW_BYTES {
            return Err(ClientError::Protocol(
                "attachment preview exceeds size limit".into(),
            ));
        }
        self.register_source(source, mime.to_owned(), None)
    }
    pub fn register_receipt(
        &self,
        source: Arc<AttachmentSource>,
        key: ReceiptKey,
        receipt: &crate::AttachmentDto,
    ) -> Result<()> {
        if source.sha256 != receipt.sha256 || source.size_bytes != receipt.size_bytes {
            return Err(ClientError::AttachmentSourceChanged);
        }
        // Ordinary non-raster attachments remain uploadable, without a display handle.
        let Some(mime) = receipt
            .media_type
            .as_deref()
            .filter(|m| matches!(*m, "image/png" | "image/jpeg" | "image/gif" | "image/webp"))
        else {
            return Ok(());
        };
        let Ok(handle) = self.attachment_preview(source, mime) else {
            return Ok(());
        };
        let mut index = self.index.lock().unwrap();
        index.receipts.insert(key.clone(), handle.clone());
        for (image, flight) in &index.images {
            if image.mime_type == mime && flight.attachment.lock().unwrap().as_ref() == Some(&key) {
                flight.ready.send_replace(Some(handle.clone()));
            }
        }
        Ok(())
    }
    pub async fn conversation_image(
        &self,
        client: &DockClient,
        scope: MediaScope,
        content_ref: &str,
        mime_type: &str,
        attachment: Option<ReceiptKey>,
    ) -> Result<MediaHandle> {
        let key = ImageKey {
            scope: scope.clone(),
            content_ref: content_ref.into(),
            mime_type: mime_type.into(),
        };
        let flight = {
            let mut index = self.index.lock().unwrap();
            let flight = index.images.entry(key).or_default().clone();
            if let Some(key) = attachment {
                if let Some(handle) = index
                    .receipts
                    .get(&key)
                    .filter(|h| h.mime_type == mime_type)
                {
                    flight.ready.send_replace(Some(handle.clone()));
                }
                *flight.attachment.lock().unwrap() = Some(key);
            }
            flight
        };
        let mut ready = flight.ready.subscribe();
        if let Some(handle) = ready.borrow().clone() {
            return Ok(handle);
        }
        // Receipt readiness is not locked behind the network flight. A late
        // trusted source wakes every waiter; dropping this transfer cleans its
        // provisional sink. Bytes already received are not claimed as avoided.
        tokio::select! {
            biased;
            _ = ready.changed() => Ok(ready.borrow().clone().expect("only ready handles are published")),
            result = async {
                let _leader = flight.transfer.lock().await;
                if let Some(handle) = flight.ready.borrow().clone() { return Ok(handle); }
                let _permit = self.transfers.acquire().await.expect("media semaphore is never closed");
                let provisional = Provisional::create(&self.run)?;
                let mut sink = tokio::fs::File::from_std(provisional.file.try_clone().map_err(|e| storage_error(&provisional.path, e))?);
                let transfer = client.read_conversation_image(&scope.instance_id, content_ref, mime_type, &mut sink).await?;
                if transfer.host_epoch != scope.host_epoch {
                    return Err(ClientError::Protocol("media response belongs to another Host epoch".into()));
                }
                sink.sync_all().await.map_err(|e| storage_error(&provisional.path, e))?;
                drop(sink);
                let source = self.finish_source(provisional, transfer.size_bytes, transfer.sha256)?;
                self.register_source(source, transfer.mime_type, Some(&flight))
            } => result,
        }
    }
    pub async fn published_image(
        &self,
        client: &DockClient,
        scope: MediaScope,
        file: &crate::PublishedFileDto,
    ) -> Result<MediaHandle> {
        file.validate()?;
        if file.size_bytes > MAX_ATTACHMENT_PREVIEW_BYTES {
            return Err(ClientError::AttachmentTooLarge {
                size_bytes: file.size_bytes,
                maximum_bytes: MAX_ATTACHMENT_PREVIEW_BYTES,
            });
        }
        let flight = self
            .index
            .lock()
            .unwrap()
            .published
            .entry((scope.clone(), file.clone()))
            .or_default()
            .clone();
        let _leader = flight.transfer.lock().await;
        if let Some(handle) = flight.ready.borrow().clone() {
            return Ok(handle);
        }
        let _permit = self
            .transfers
            .acquire()
            .await
            .expect("media semaphore is never closed");
        let provisional = Provisional::create(&self.run)?;
        let mut sink = tokio::fs::File::from_std(
            provisional
                .file
                .try_clone()
                .map_err(|e| storage_error(&provisional.path, e))?,
        );
        let transfer = client
            .read_published_file(&scope.instance_id, file, &mut sink)
            .await?;
        if transfer.host_epoch != scope.host_epoch
            || transfer.runtime_generation != scope.runtime_generation
        {
            return Err(ClientError::Protocol(
                "published image belongs to another Work state".into(),
            ));
        }
        sink.sync_all()
            .await
            .map_err(|e| storage_error(&provisional.path, e))?;
        drop(sink);
        let source = self.finish_source(provisional, transfer.size_bytes, transfer.sha256)?;
        let mime = source.raster_mime.ok_or_else(|| {
            ClientError::Protocol("published image is not a supported raster".into())
        })?;
        if file
            .media_type
            .as_deref()
            .is_some_and(|declared| declared != mime)
        {
            return Err(ClientError::Protocol(
                "published image MIME differs from its signature".into(),
            ));
        }
        self.register_source(source, mime.into(), Some(&flight))
    }
    /// Save the indexed original, never a WebView URL or caller filesystem path.
    /// Verify the complete copy before the platform commits its destination.
    pub fn copy_to(&self, handle: &str, mut sink: impl Write) -> Result<MediaHandle> {
        let (descriptor, mut source) = self.open(handle)?;
        let mut buffer = [0_u8; 64 * 1024];
        let mut digest = Sha256::new();
        let mut size = 0_u64;
        loop {
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > descriptor.size_bytes {
                return Err(ClientError::AttachmentSourceChanged);
            }
            sink.write_all(&buffer[..count])?;
            digest.update(&buffer[..count]);
        }
        if size != descriptor.size_bytes || hex::encode(digest.finalize()) != descriptor.sha256 {
            return Err(ClientError::AttachmentSourceChanged);
        }
        Ok(descriptor)
    }
    pub fn inline_image(
        &self,
        scope: MediaScope,
        mime_type: &str,
        data: &str,
    ) -> Result<MediaHandle> {
        let bytes = crate::wire::decode_canonical_base64(
            data,
            crate::MAX_CONVERSATION_IMAGE_BYTES,
            "inline conversation image",
        )?;
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let key = (scope, sha256.clone(), mime_type.to_owned());
        // Inline data is already present locally, not a remote contentRef. Keep
        // its digest in a separate alias namespace; never fabricate server refs.
        if let Some(handle) = self.index.lock().unwrap().inline.get(&key) {
            return Ok(handle.clone());
        }
        let mut provisional = Provisional::create(&self.run)?;
        provisional
            .file
            .write_all(&bytes)
            .map_err(|e| storage_error(&provisional.path, e))?;
        provisional
            .file
            .sync_all()
            .map_err(|e| storage_error(&provisional.path, e))?;
        let handle = self.publish(provisional, mime_type.into(), bytes.len() as u64, sha256)?;
        self.index
            .lock()
            .unwrap()
            .inline
            .insert(key, handle.clone());
        Ok(handle)
    }
    fn publish(
        &self,
        provisional: Provisional,
        mime_type: String,
        size_bytes: u64,
        sha256: String,
    ) -> Result<MediaHandle> {
        let source = self.finish_source(provisional, size_bytes, sha256)?;
        self.register_source(source, mime_type, None)
    }
    fn register_source(
        &self,
        source: Arc<AttachmentSource>,
        mime_type: String,
        flight: Option<&Flight>,
    ) -> Result<MediaHandle> {
        if source.raster_mime != Some(mime_type.as_str()) {
            return Err(ClientError::Protocol(
                "media MIME differs from its raster signature".into(),
            ));
        }
        let digest_key = (source.sha256.clone(), source.size_bytes, mime_type.clone());
        let mut index = self.index.lock().unwrap();
        if let Some(handle) = flight.and_then(|f| f.ready.borrow().clone()) {
            return Ok(handle);
        }
        let descriptor = if let Some(existing) = index.digests.get(&digest_key) {
            existing.clone()
        } else {
            let descriptor = MediaHandle {
                handle: uuid::Uuid::new_v4().to_string(),
                mime_type,
                size_bytes: source.size_bytes,
                sha256: source.sha256.clone(),
            };
            index.handles.insert(
                descriptor.handle.clone(),
                StoredMedia {
                    descriptor: descriptor.clone(),
                    source,
                },
            );
            index.digests.insert(digest_key, descriptor.clone());
            descriptor
        };
        if let Some(flight) = flight {
            flight.ready.send_replace(Some(descriptor.clone()));
        }
        Ok(descriptor)
    }
    /// Opaque handle lookup is the only display-file access. Never joins a caller
    /// string onto a filesystem path and never accepts a source path from the UI.
    pub fn open(&self, handle: &str) -> Result<(MediaHandle, File)> {
        let index = self.index.lock().unwrap();
        let stored = index.handles.get(handle).ok_or_else(|| {
            ClientError::Protocol("media handle is not registered in this App".into())
        })?;
        let file =
            File::open(&stored.source.path).map_err(|e| storage_error(&stored.source.path, e))?;
        Ok((stored.descriptor.clone(), file))
    }
}
pub(crate) fn raster_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
struct Provisional {
    file: File,
    path: PathBuf,
}
impl Provisional {
    fn create(run: &RunCache) -> Result<Self> {
        let directory = run.path.join("media");
        fs::create_dir_all(&directory).map_err(|e| storage_error(&directory, e))?;
        set_private_directory_permissions(&directory)?;
        let path = directory.join(format!("{}.partial", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|e| storage_error(&path, e))?;
        Ok(Self { file, path })
    }
}
impl Drop for Provisional {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(all(test, unix, not(target_os = "android")))]
mod tests {
    use super::*;
    use crate::{
        AttachmentDto, ConnectionRouter, IdentityStore, LocalDockEndpoint,
        tls::{read_json_line, write_json_line},
    };
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use serde_json::{Value, json};
    use tokio::{
        io::BufReader,
        sync::oneshot,
        time::{Duration, timeout},
    };

    // #301/#302: a selected original must become visible even when the image
    // download started before its upload receipt and the network is still held.
    #[tokio::test]
    async fn late_receipt_releases_image_waiters_and_unrelated_images_stay_independent() {
        let directory = std::env::temp_dir().join(format!(
            "m{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        fs::create_dir(&directory).unwrap();
        let media = Arc::new(SessionMedia::new(Arc::new(
            RunCache::open(&directory.join("cache")).unwrap(),
        )));
        let source = media
            .import_attachment(&b"\x89PNG\r\n\x1a\noriginal"[..])
            .unwrap();
        let preview = media
            .attachment_preview(source.clone(), "image/png")
            .unwrap();
        let receipt = AttachmentDto {
            file_id: "uploaded-file".into(),
            name: "photo.png".into(),
            size_bytes: source.size_bytes,
            sha256: source.sha256.clone(),
            media_type: Some("image/png".into()),
            stored_at: "now".into(),
        };
        let key = ReceiptKey {
            authority: "native-endpoint".into(),
            machine_host_id: "actual-machine".into(),
            file_id: receipt.file_id.clone(),
        };
        let scope = MediaScope {
            authority: "native-observation".into(),
            instance_id: "work".into(),
            host_epoch: "epoch".into(),
            runtime_generation: 1,
        };
        let socket = directory.join("s");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let (started, reached) = oneshot::channel();
        let (release, held) = oneshot::channel();
        let peer = tokio::spawn(async move {
            {
                let (socket, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(socket);
                let hello: Value = read_json_line(&mut stream, 1048576).await.unwrap();
                write_json_line(&mut stream, &json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
                    "host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
                let request: Value = read_json_line(&mut stream, 1048576).await.unwrap();
                assert_eq!(request["type"], "conversation.image");
                assert_eq!(request["params"]["contentRef"], "original-ref");
                // Header proves the actual flight began, not only a queued lock.
                write_json_line(&mut stream, &json!({"kind":"conversation_image_ready","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","instanceId":"work","contentRef":"original-ref","mimeType":"image/png","sizeBytes":16,"sha256":"ac0197754200ad9424560d0717c214e04f5182173df1c68757fc949aae164413"})).await.unwrap();
                started.send(()).unwrap();
                held.await.unwrap();
            }
            // Only the independently transformed image is read over the wire.
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            let hello: Value = read_json_line(&mut stream, 1048576).await.unwrap();
            write_json_line(&mut stream, &json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
                "host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
            let request: Value = read_json_line(&mut stream, 1048576).await.unwrap();
            assert_eq!(request["params"]["contentRef"], "transformed-ref");
            let bytes = b"\x89PNG\r\n\x1a\nchanged";
            let sha = hex::encode(Sha256::digest(bytes));
            for frame in [
                json!({"kind":"conversation_image_ready","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","instanceId":"work","contentRef":"transformed-ref","mimeType":"image/png","sizeBytes":bytes.len(),"sha256":sha}),
                json!({"kind":"conversation_image_chunk","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","instanceId":"work","contentRef":"transformed-ref","index":0,"data":STANDARD.encode(bytes)}),
                json!({"kind":"conversation_image_complete","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","instanceId":"work","contentRef":"transformed-ref","chunks":1,"sizeBytes":bytes.len(),"sha256":sha}),
            ] {
                write_json_line(&mut stream, &frame).await.unwrap();
            }
        });
        let client = DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(directory.join("identity")),
                LocalDockEndpoint::configured(socket.to_str().unwrap()).unwrap(),
                "media-test".into(),
            )
            .unwrap(),
        );
        let request = |reference: &'static str, attachment: Option<ReceiptKey>| {
            let (media, client, scope) = (media.clone(), client.clone(), scope.clone());
            tokio::spawn(async move {
                media
                    .conversation_image(&client, scope, reference, "image/png", attachment)
                    .await
            })
        };
        let first = request("original-ref", Some(key.clone()));
        timeout(Duration::from_secs(3), reached)
            .await
            .unwrap()
            .unwrap();
        let second = request("original-ref", Some(key.clone()));
        // Synchronize arrival, not a product assertion: neither waiter may be
        // a new post-receipt lookup that would hide a missing late wakeup.
        timeout(Duration::from_secs(3), async {
            loop {
                let waiting = media
                    .index
                    .lock()
                    .unwrap()
                    .images
                    .values()
                    .next()
                    .unwrap()
                    .ready
                    .receiver_count();
                if waiting == 2 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut wrong = receipt.clone();
        wrong.sha256 = "0".repeat(64);
        assert!(
            media
                .register_receipt(source.clone(), key.clone(), &wrong)
                .is_err()
        );
        assert!(
            !first.is_finished(),
            "integrity failure must not register a ready image"
        );
        wrong = receipt.clone();
        wrong.media_type = Some("image/jpeg".into());
        media
            .register_receipt(source.clone(), key.clone(), &wrong)
            .unwrap();
        assert!(
            !first.is_finished(),
            "changed MIME must not reuse PNG bytes"
        );
        media
            .register_receipt(source.clone(), key.clone(), &receipt)
            .unwrap();
        for waiter in [first, second] {
            assert_eq!(
                timeout(Duration::from_secs(3), waiter)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .handle,
                preview.handle
            );
        }
        release.send(()).unwrap();
        let transformed = request("transformed-ref", None).await.unwrap().unwrap();
        assert_ne!(transformed.handle, preview.handle);
        let mut bytes = Vec::new();
        media
            .open(&transformed.handle)
            .unwrap()
            .1
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"\x89PNG\r\n\x1a\nchanged");
        peer.await.unwrap();
        client.router().close();
        // These are authority/Machine/receipt/MIME security boundaries, not a
        // guessed filename match. An unavailable transport cannot mask a hit.
        for (name, association, mime) in [
            (
                "other-authority",
                Some(ReceiptKey {
                    authority: "other".into(),
                    ..key.clone()
                }),
                "image/png",
            ),
            (
                "other-machine",
                Some(ReceiptKey {
                    machine_host_id: "other".into(),
                    ..key.clone()
                }),
                "image/png",
            ),
            (
                "other-file",
                Some(ReceiptKey {
                    file_id: "other".into(),
                    ..key.clone()
                }),
                "image/png",
            ),
            ("no-file", None, "image/png"),
            ("other-mime", Some(key.clone()), "image/jpeg"),
        ] {
            assert!(
                media
                    .conversation_image(&client, scope.clone(), name, mime, association)
                    .await
                    .is_err()
            );
        }
        assert_eq!(
            media
                .conversation_image(&client, scope, "original-ref", "image/png", None)
                .await
                .unwrap()
                .handle,
            preview.handle
        );
        assert!(
            fs::read_dir(media.run.path.join("media"))
                .unwrap()
                .all(|e| !e.unwrap().path().to_string_lossy().ends_with(".partial"))
        );
        drop(media);
        drop(source);
        fs::remove_dir_all(directory).unwrap();
    }

    // Import error/cancel safety is the boundary where a UI waiter can vanish
    // before a selection exists. This is distinct from the SDK receipt proof.
    #[tokio::test]
    async fn failed_or_abandoned_imports_remove_only_the_private_provisional_file() {
        struct Fails;
        impl Read for Fails {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("source disappeared"))
            }
        }
        let directory = std::env::temp_dir().join(format!("media-import-{}", uuid::Uuid::new_v4()));
        let media = Arc::new(SessionMedia::new(Arc::new(
            RunCache::open(&directory).unwrap(),
        )));
        assert!(media.import_attachment(Fails).is_err());
        assert_eq!(
            fs::read_dir(media.run.path.join("media")).unwrap().count(),
            0
        );
        let source = media
            .import_attachment(&b"ordinary text attachment"[..])
            .unwrap();
        let path = source.path.clone();
        assert!(
            media
                .attachment_preview(source.clone(), "image/png")
                .is_err()
        );
        drop(source);
        assert!(!path.exists());
        struct Held {
            started: Option<oneshot::Sender<()>>,
            release: std::sync::mpsc::Receiver<()>,
        }
        impl Read for Held {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if let Some(started) = self.started.take() {
                    let _ = started.send(());
                    self.release.recv().unwrap();
                    buffer[0] = 42;
                    Ok(1)
                } else {
                    Ok(0)
                }
            }
        }
        let (started, reached) = oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let importer = media.clone();
        let waiter = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                importer.import_attachment(Held {
                    started: Some(started),
                    release: held,
                })
            })
            .await
        });
        reached.await.unwrap();
        waiter.abort();
        let _ = waiter.await;
        release.send(()).unwrap();
        timeout(Duration::from_secs(3), async {
            while Arc::strong_count(&media) != 1 {
                tokio::task::yield_now().await;
            }
            while fs::read_dir(media.run.path.join("media")).unwrap().count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // A real storage failure, without modifying a system limit or mount.
        fs::remove_dir(media.run.path.join("media")).unwrap();
        fs::write(media.run.path.join("media"), b"not a directory").unwrap();
        assert!(media.import_attachment(&b"data"[..]).is_err());
        assert!(media.index.lock().unwrap().handles.is_empty());
        drop(media);
        fs::remove_dir_all(directory).unwrap();
    }
}
