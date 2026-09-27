//! App-run attachment sources and upload facts. A view is a subscriber, not an owner.
use crate::{
    AttachmentUploadCancellation, AttachmentUploadProgress, AttachmentUploadResult, ClientError,
    DockClient, SessionContent,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadScope {
    pub machine_host_id: String,
    pub owner_host_epoch: String,
    pub runtime_generation: u64,
}

/// The last reader, rather than removal from the selection, releases staging files.
pub struct AttachmentSource {
    pub(crate) path: PathBuf,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: String,
    pub(crate) raster_mime: Option<&'static str>,
    pub(crate) _run: Arc<crate::run_cache::RunCache>,
}
impl AttachmentSource {
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}
impl Drop for AttachmentSource {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Clone)]
pub struct NativeAttachment {
    pub source: Arc<AttachmentSource>,
    pub authority: String,
    pub connection_id: String,
    pub work_id: String,
    pub operation_id: String,
    pub name: String,
    pub size_bytes: u64,
    pub media_type: Option<String>,
    pub upload_scope: Option<AttachmentUploadScope>,
    cancellation: Option<AttachmentUploadCancellation>,
    revision: u64,
    state: &'static str,
    progress: Option<AttachmentUploadProgress>,
    result: Option<AttachmentUploadResult>,
    error: Option<AttachmentJobError>,
}
impl NativeAttachment {
    pub fn new(
        source: Arc<AttachmentSource>,
        connection_id: String,
        work_id: String,
        name: String,
        media_type: Option<String>,
    ) -> Self {
        Self {
            size_bytes: source.size_bytes,
            source,
            authority: String::new(),
            connection_id,
            work_id,
            operation_id: uuid::Uuid::new_v4().to_string(),
            name,
            media_type,
            upload_scope: None,
            cancellation: None,
            revision: 1,
            state: "selected",
            progress: None,
            result: None,
            error: None,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentJobError {
    pub message: String,
    pub outcome_unknown: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentJobSnapshot {
    pub token: String,
    pub revision: u64,
    pub connection_id: String,
    pub work_id: String,
    pub name: String,
    pub size_bytes: u64,
    pub media_type: Option<String>,
    pub target: Option<AttachmentUploadScope>,
    pub state: String,
    pub progress: Option<AttachmentUploadProgress>,
    pub result: Option<AttachmentUploadResult>,
    pub error: Option<AttachmentJobError>,
}
impl NativeAttachment {
    fn snapshot(&self, token: &str) -> AttachmentJobSnapshot {
        AttachmentJobSnapshot {
            token: token.into(),
            revision: self.revision,
            connection_id: self.connection_id.clone(),
            work_id: self.work_id.clone(),
            name: self.name.clone(),
            size_bytes: self.size_bytes,
            media_type: self.media_type.clone(),
            target: self.upload_scope.clone(),
            state: self.state.into(),
            progress: self.progress,
            result: self.result.clone(),
            error: self.error.clone(),
        }
    }
}
#[derive(Clone, Serialize)]
pub struct AttachmentSnapshot {
    pub revision: u64,
    pub jobs: Vec<AttachmentJobSnapshot>,
}
#[derive(Clone, Default)]
pub struct AttachmentState {
    entries: Arc<Mutex<HashMap<String, NativeAttachment>>>,
    revision: Arc<AtomicU64>,
    pub content: SessionContent,
}
impl AttachmentState {
    pub fn new(content: SessionContent) -> Self {
        Self {
            entries: Arc::default(),
            revision: Arc::default(),
            content,
        }
    }
    pub fn get(&self, token: &str) -> Option<NativeAttachment> {
        self.entries.lock().unwrap().get(token).cloned()
    }
    /// Freeze only completed jobs included in this send. New selections and
    /// unknown uploads stay owned by the draft even if the send finishes later.
    pub fn capture_submission(
        &self,
        authority: &str,
        work_id: &str,
        host_epoch: &str,
        generation: u64,
        file_ids: &[String],
    ) -> Vec<String> {
        self.snapshot(authority, work_id)
            .jobs
            .into_iter()
            .filter(|job| {
                job.state == "succeeded"
                    && job.target.as_ref().is_some_and(|target| {
                        target.owner_host_epoch == host_epoch
                            && target.runtime_generation == generation
                    })
                    && job
                        .result
                        .as_ref()
                        .is_some_and(|result| file_ids.contains(&result.attachment.file_id))
            })
            .map(|job| job.token)
            .collect()
    }
    pub fn finish_submission(&self, tokens: Vec<String>) {
        for token in tokens {
            self.remove(&token);
        }
    }
    pub fn insert(&self, token: String, entry: NativeAttachment) {
        let mut entries = self.entries.lock().unwrap();
        entries.insert(token, entry);
        self.revision.fetch_add(1, Ordering::Relaxed);
    }
    /// Pure in-memory query; never opens a transport or reads the source file.
    /// Revision and entries are read under one lock, including empty/removal cuts.
    pub fn snapshot(&self, authority: &str, work_id: &str) -> AttachmentSnapshot {
        let entries = self.entries.lock().unwrap();
        AttachmentSnapshot {
            revision: self.revision.load(Ordering::Relaxed),
            jobs: entries
                .iter()
                .filter(|(_, e)| e.authority == authority && e.work_id == work_id)
                .map(|(token, e)| e.snapshot(token))
                .collect(),
        }
    }
    pub fn revoke_connection(&self, connection_id: &str) {
        let mut entries = self.entries.lock().unwrap();
        self.revision.fetch_add(1, Ordering::Relaxed);
        entries.retain(|_, e| {
            if e.connection_id != connection_id {
                return true;
            }
            if let Some(c) = &e.cancellation {
                c.cancel();
            }
            false
        });
    }
    pub fn cancel(&self, token: &str) -> bool {
        let entries = self.entries.lock().unwrap();
        if let Some(c) = entries.get(token).and_then(|e| e.cancellation.as_ref()) {
            c.cancel();
            true
        } else {
            false
        }
    }
    pub fn remove(&self, token: &str) -> bool {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.remove(token) {
            self.revision.fetch_add(1, Ordering::Relaxed);
            if let Some(c) = &entry.cancellation {
                c.cancel();
            }
            true
        } else {
            false
        }
    }
    /// A single frozen intent. Even explicit starts cannot replay an unknown or
    /// completed upload. Reselecting a file is a separate user intent.
    pub fn start<F>(
        &self,
        token: &str,
        target: AttachmentUploadScope,
        client: DockClient,
        notify: F,
    ) -> crate::Result<()>
    where
        F: Fn(AttachmentJobSnapshot) + Send + Sync + 'static,
    {
        let (source, operation_id, work_id, name, media_type, selected_size, cancellation) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries
                .get_mut(token)
                .ok_or_else(|| ClientError::Protocol("attachment no longer exists".into()))?;
            if entry.state != "selected" && entry.state != "failed" {
                return Ok(());
            }
            if entry
                .upload_scope
                .as_ref()
                .is_some_and(|scope| scope != &target)
            {
                return Err(ClientError::Protocol(
                    "attachment target changed; select the source again".into(),
                ));
            }
            entry.upload_scope = Some(target);
            let cancellation = AttachmentUploadCancellation::new();
            entry.cancellation = Some(cancellation.clone());
            entry.state = "hashing";
            entry.error = None;
            entry.progress = None;
            entry.revision += 1;
            self.revision.fetch_add(1, Ordering::Relaxed);
            (
                entry.source.clone(),
                entry.operation_id.clone(),
                entry.work_id.clone(),
                entry.name.clone(),
                entry.media_type.clone(),
                entry.size_bytes,
                cancellation,
            )
        };
        let owner = self.clone();
        let token = token.to_owned();
        // Spawn before returning from IPC: dropping its waiter never drops this task/source.
        tokio::spawn(async move {
            let result = async {
                let metadata = tokio::fs::symlink_metadata(&source.path).await?;
                if !metadata.file_type().is_file() || metadata.len() != selected_size {
                    return Err(ClientError::AttachmentSourceChanged);
                }
                client
                    .upload_attachment_file(
                        &source.path,
                        &operation_id,
                        &work_id,
                        &name,
                        media_type.as_deref(),
                        &cancellation,
                        |progress| {
                            let snapshot = {
                                let mut entries = owner.entries.lock().unwrap();
                                entries.get_mut(&token).map(|entry| {
                                    entry.progress = Some(progress);
                                    entry.state = match progress.phase {
                                        crate::AttachmentUploadPhase::Hashing => "hashing",
                                        crate::AttachmentUploadPhase::Uploading => "uploading",
                                        crate::AttachmentUploadPhase::Finalizing => "finalizing",
                                    };
                                    entry.revision += 1;
                                    owner.revision.fetch_add(1, Ordering::Relaxed);
                                    entry.snapshot(&token)
                                })
                            };
                            if let Some(snapshot) = snapshot {
                                notify(snapshot);
                            }
                        },
                    )
                    .await
            }
            .await;
            let snapshot = {
                let mut entries = owner.entries.lock().unwrap();
                entries.get_mut(&token).map(|entry| {
                    entry.cancellation = None;
                    entry.revision += 1;
                    owner.revision.fetch_add(1, Ordering::Relaxed);
                    match result {
                        Ok(result) => {
                            // The receipt has already passed the upload transport checks.
                            // Alias installation also requires this exact imported source.
                            if result.attachment.media_type == entry.media_type {
                                let _ = owner.content.register_attachment_receipt(
                                    source.clone(),
                                    crate::session_media::ReceiptKey {
                                        authority: entry.authority.clone(),
                                        machine_host_id: entry
                                            .upload_scope
                                            .as_ref()
                                            .expect("started target")
                                            .machine_host_id
                                            .clone(),
                                        file_id: result.attachment.file_id.clone(),
                                    },
                                    &result.attachment,
                                );
                            }
                            entry.state = "succeeded";
                            entry.result = Some(result);
                        }
                        Err(error) => {
                            let unknown = matches!(error, ClientError::EffectUnknown { .. });
                            entry.state = if unknown { "unknown" } else { "failed" };
                            entry.error = Some(AttachmentJobError {
                                outcome_unknown: unknown,
                                message: match error {
                                    ClientError::AttachmentSourceChanged => {
                                        "附件源文件发生了变化，请移除后重新选择。"
                                    }
                                    ClientError::AttachmentUploadCancelled => {
                                        "附件上传已取消，可以重试或移除。"
                                    }
                                    _ if unknown => {
                                        "附件是否上传成功暂时无法确认，请保留此项，不要重复上传。"
                                    }
                                    _ => "附件上传未完成，请检查连接后重试或移除。",
                                }
                                .into(),
                            });
                        }
                    }
                    entry.snapshot(&token)
                })
            };
            if let Some(snapshot) = snapshot {
                notify(snapshot);
            }
        });
        Ok(())
    }
}

#[cfg(all(test, unix, not(target_os = "android")))]
mod tests {
    use super::*;
    use crate::{
        ConnectionRouter, IdentityStore, LocalDockEndpoint,
        tls::{read_json_line, write_json_line},
    };
    use serde_json::{Value, json};
    use tokio::{
        io::BufReader,
        sync::oneshot,
        time::{Duration, timeout},
    };

    // #301/#302: leaving/rebuilding the view must query the same native job,
    // including complete→cancel/router-close, and must never replay an unknown.
    #[tokio::test]
    async fn retained_upload_survives_view_loss_and_preserves_completion_boundary() {
        for scenario in ["receipt", "unknown", "remove", "revoke"] {
            let directory = std::env::temp_dir().join(format!(
                "j{}",
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            ));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("source");
            std::fs::write(&path, b"abc").unwrap();
            let socket = directory.join("s");
            let listener = tokio::net::UnixListener::bind(&socket).unwrap();
            let (reached_tx, reached) = oneshot::channel();
            let (release, released) = oneshot::channel();
            let peer = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let hello: Value = read_json_line(&mut stream, 1048576).await.unwrap();
                write_json_line(&mut stream, &json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
                    "host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
                let request: Value = read_json_line(&mut stream, 1048576).await.unwrap();
                assert_eq!(request["type"], "attachment.upload");
                if scenario == "remove" || scenario == "revoke" {
                    reached_tx.send(()).unwrap();
                    released.await.unwrap();
                    return;
                }
                write_json_line(&mut stream, &json!({"kind":"attachment_upload_ready","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","maxChunkBytes":524288})).await.unwrap();
                let chunk: Value = read_json_line(&mut stream, 1048576).await.unwrap();
                assert_eq!(chunk["data"], "YWJj");
                let complete: Value = read_json_line(&mut stream, 1048576).await.unwrap();
                assert_eq!(complete["kind"], "attachment_complete");
                reached_tx.send(()).unwrap();
                released.await.unwrap();
                if scenario == "receipt" {
                    write_json_line(&mut stream, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,
                        "result":{"status":"stored","attachment":{"fileId":"123e4567-e89b-42d3-a456-426614174000","name":"source","sizeBytes":3,
                        "sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","storedAt":"2026-09-22T00:00:00.000Z"}}})).await.unwrap();
                }
            });
            let client = DockClient::new(
                ConnectionRouter::local(
                    &IdentityStore::new(directory.join("identity")),
                    LocalDockEndpoint::configured(socket.to_str().unwrap()).unwrap(),
                    "fixture".into(),
                )
                .unwrap(),
            );
            let owner = AttachmentState::default();
            let mut entry = NativeAttachment::new(
                owner.content.import_attachment_file(&path).unwrap(),
                "host".into(),
                "A".into(),
                "source".into(),
                None,
            );
            entry.authority = "authority".into();
            let private_path = entry.source.path.clone();
            let weak_source = Arc::downgrade(&entry.source);
            let operation_id = entry.operation_id.clone();
            owner.entries.lock().unwrap().insert("job".into(), entry);
            let target = AttachmentUploadScope {
                machine_host_id: "machine".into(),
                owner_host_epoch: "epoch".into(),
                runtime_generation: 1,
            };
            let (events, mut changes) = tokio::sync::mpsc::unbounded_channel();
            owner
                .start("job", target.clone(), client.clone(), move |snapshot| {
                    let _ = events.send(snapshot);
                })
                .unwrap();
            timeout(Duration::from_secs(5), reached)
                .await
                .unwrap()
                .unwrap();
            let reconstructed_view = owner.clone();
            assert!(
                reconstructed_view
                    .snapshot("authority", "B")
                    .jobs
                    .is_empty()
            );
            assert!(
                reconstructed_view
                    .snapshot("other-authority", "A")
                    .jobs
                    .is_empty()
            );
            let cut = reconstructed_view.snapshot("authority", "A");
            assert_eq!(
                cut.revision,
                reconstructed_view.snapshot("authority", "A").revision
            );
            let before = cut.jobs[0].clone();
            assert!(before.revision > 1);
            assert_eq!(
                owner.entries.lock().unwrap()["job"].operation_id,
                operation_id
            );
            if scenario == "remove" || scenario == "revoke" {
                // Hold the actual source reader across explicit removal/revocation.
                let reader = weak_source.upgrade().unwrap();
                if scenario == "remove" {
                    owner.remove("job");
                } else {
                    owner.revoke_connection("host");
                }
                assert!(private_path.exists());
                release.send(()).unwrap();
                peer.await.unwrap();
                drop(reader);
                timeout(Duration::from_secs(5), async {
                    while private_path.exists() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                let removed = owner.snapshot("authority", "A");
                assert!(removed.jobs.is_empty());
                assert!(removed.revision > cut.revision);
            } else {
                // Complete was sent: cancellation is unknown, not a known failure.
                if scenario == "unknown" {
                    owner.cancel("job");
                }
                client.router().close();
                release.send(()).unwrap();
                peer.await.unwrap();
                let terminal = timeout(Duration::from_secs(5), async {
                    loop {
                        let update = changes.recv().await.unwrap();
                        if update.state == "succeeded" || update.state == "unknown" {
                            break update;
                        }
                    }
                })
                .await
                .unwrap();
                assert!(terminal.revision > before.revision);
                assert_eq!(
                    terminal.state,
                    if scenario == "receipt" {
                        "succeeded"
                    } else {
                        "unknown"
                    }
                );
                if scenario == "receipt" {
                    assert_eq!(terminal.result.unwrap().attachment.size_bytes, 3);
                }
                // The old transport is closed and peer is gone. Start/query must
                // retain the same result, not replace its ID or contact a catalog.
                owner
                    .start("job", target, client, |_| {
                        panic!("terminal upload replayed")
                    })
                    .unwrap();
                assert_eq!(
                    owner.entries.lock().unwrap()["job"].operation_id,
                    operation_id
                );
                assert_eq!(
                    owner.snapshot("authority", "A").jobs[0].state,
                    if scenario == "receipt" {
                        "succeeded"
                    } else {
                        "unknown"
                    }
                );
                assert!(!owner.cancel("job"), "terminal facts are not cancelled");
                owner.remove("job");
            }
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
