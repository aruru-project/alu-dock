//! The single App-lifetime canonical holding point. Replacement acceptance,
//! owner revocation and publication share one commit lock. Display replay does not.
mod binding;
pub use binding::SessionBinding;

use crate::{
    ClientError, DockEvent, EventCursor, InstanceExecution, InstanceLifecycle, InstanceReadResult,
    InstanceSnapshot, Result,
    run_cache::RunCache,
    session_journal::Segment,
    session_media::{MediaHandle, MediaScope, SessionMedia},
    session_records::RecordVersion,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

pub(crate) const RECORD_READ_ERROR: &str = "这条对话的本地副本无法读取，请重试这一条。";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ContentUpdate {
    StoredRecord {
        #[serde(skip)]
        lease: Option<Arc<crate::session_records::RecordFile>>,
        entry_id: String,
        file: String,
        size_bytes: u64,
        sha256: String,
        before_entry_id: Option<String>,
    },
    RecordChunk {
        entry_id: String,
        text: String,
        first: bool,
        complete: bool,
        before_entry_id: Option<String>,
    },
    CheckpointBegin {
        read: InstanceReadResult,
    },
    CheckpointEnd,
    RecordError {
        entry_id: String,
        before_entry_id: Option<String>,
        error: String,
    },
    EntryState {
        entry_id: String,
        loading: bool,
        error: Option<String>,
    },
    State {
        can_load_earlier: bool,
        loading: bool,
        error: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum SessionUpdate {
    Read(InstanceReadResult),
    ObservationCut(InstanceReadResult),
    Content {
        token: String,
        update: ContentUpdate,
    },
    Event(DockEvent),
    ReplayEvent {
        token: String,
        event: DockEvent,
    },
    Replaced(InstanceSnapshot),
    Status {
        state: String,
        message: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionCommit {
    pub revision: u64,
    pub update: SessionUpdate,
}
#[derive(Clone, Default)]
pub struct SessionSnapshot {
    pub revision: u64,
    pub read: Option<Arc<InstanceReadResult>>,
    pub target: Option<InstanceSnapshot>,
    pub cursor: Option<EventCursor>,
    pub state: String,
    pub message: Option<String>,
    pub content_token: String,
    pub can_load_earlier: bool,
    terminal: bool,
}
#[derive(Clone)]
struct ReplacementCut {
    revision: u64,
    snapshot: SessionSnapshot,
    segment: Arc<Segment>,
    offset: u64,
    records: Vec<RecordVersion>,
    states: Vec<ContentUpdate>,
    records_revision: u64,
    waterline: u64,
    journal_revision: u64,
    unavailable: HashMap<String, String>,
}
#[derive(Clone, Default)]
struct Signal {
    replacement: Option<Arc<ReplacementCut>>,
    revision: u64,
    fault: Option<SessionCommit>,
    status: (String, Option<String>),
}
#[derive(Clone, Copy, Eq, PartialEq, Hash)]
pub(crate) enum ReadArea {
    Earlier,
    Coverage,
    Descriptors,
}
pub(crate) enum ReadFailure {
    Earlier,
    Coverage(u64),
    Descriptors(u64),
}
struct Entry {
    snapshot: SessionSnapshot,
    checkpoint: SessionSnapshot,
    checkpoint_offset: u64,
    checkpoint_segment: Arc<Segment>,
    checkpoint_journal_revision: u64,
    replacement_revision: u64,
    owner: u64,
    records: Vec<RecordVersion>,
    records_revision: u64,
    earlier_loading: bool,
    read_errors: HashMap<ReadArea, String>,
    reads: crate::session_content_reader::BodyReads,
    pending_checkpoint: Option<PendingCheckpoint>,
    coverage_running: bool,
    signal: watch::Sender<Signal>,
    segment: Arc<Segment>,
}
#[derive(Clone)]
pub(crate) struct PendingCheckpoint {
    pub read: InstanceReadResult,
    pub offset: u64,
    pub revision: u64,
    pub segment: Arc<Segment>,
    pub records: Vec<RecordVersion>,
}
struct Inner {
    entries: HashMap<String, Entry>,
    owner: u64,
    root: Arc<RunCache>,
}
#[derive(Clone)]
pub struct SessionContent(Arc<Mutex<Inner>>, Arc<SessionMedia>);
impl Default for SessionContent {
    fn default() -> Self {
        Self::with_root(
            std::env::temp_dir().join(format!("aludock-observation-{}", uuid::Uuid::new_v4())),
        )
    }
}
impl SessionContent {
    fn with_root(root: PathBuf) -> Self {
        Self::with_run(RunCache::lazy(root))
    }
    fn with_run(run: RunCache) -> Self {
        let root = Arc::new(run);
        let media = Arc::new(SessionMedia::new(root.clone()));
        Self(
            Arc::new(Mutex::new(Inner {
                entries: HashMap::new(),
                owner: 0,
                root,
            })),
            media,
        )
    }
    pub fn in_directory(root: PathBuf) -> Result<Self> {
        Ok(Self::with_run(RunCache::open(&root)?))
    }
    pub async fn conversation_image(
        &self,
        client: &crate::DockClient,
        scope: MediaScope,
        content_ref: &str,
        mime_type: &str,
        attachment_authority: &str,
        file_id: Option<&str>,
    ) -> Result<MediaHandle> {
        // The WebView supplies only the standard fileId, not Machine identity.
        // Resolve that identity from the accepted native observation, separately
        // from the stable connection authority supplied by the local caller.
        let attachment = file_id.and_then(|file_id| {
            let inner = self.0.lock().unwrap();
            let snapshot = &inner.entries.get(&scope.authority)?.snapshot;
            let target = snapshot.target.as_ref()?;
            let cursor = snapshot.cursor.as_ref()?;
            if target.id != scope.instance_id
                || cursor.host_epoch != scope.host_epoch
                || target.runtime_generation != scope.runtime_generation
                || cursor.runtime_generation != scope.runtime_generation
            {
                return None;
            }
            Some(crate::session_media::ReceiptKey {
                authority: attachment_authority.into(),
                machine_host_id: target.host_id.clone()?,
                file_id: file_id.into(),
            })
        });
        self.1
            .conversation_image(client, scope, content_ref, mime_type, attachment)
            .await
    }
    pub fn import_attachment_file(
        &self,
        path: &std::path::Path,
    ) -> Result<Arc<crate::AttachmentSource>> {
        if !std::fs::symlink_metadata(path)?.file_type().is_file() {
            return Err(ClientError::AttachmentSourceChanged);
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let reader = options.open(path)?;
        if !reader.metadata()?.is_file() {
            return Err(ClientError::AttachmentSourceChanged);
        }
        self.import_attachment(reader)
    }
    pub fn import_attachment(
        &self,
        reader: impl std::io::Read,
    ) -> Result<Arc<crate::AttachmentSource>> {
        self.1.import_attachment(reader)
    }
    pub fn attachment_preview(
        &self,
        source: Arc<crate::AttachmentSource>,
        mime_type: &str,
    ) -> Result<MediaHandle> {
        self.1.attachment_preview(source, mime_type)
    }
    pub(crate) fn register_attachment_receipt(
        &self,
        source: Arc<crate::AttachmentSource>,
        key: crate::session_media::ReceiptKey,
        receipt: &crate::AttachmentDto,
    ) -> Result<()> {
        self.1.register_receipt(source, key, receipt)
    }
    pub async fn published_image(
        &self,
        client: &crate::DockClient,
        scope: MediaScope,
        file: &crate::PublishedFileDto,
    ) -> Result<MediaHandle> {
        self.1.published_image(client, scope, file).await
    }
    pub fn copy_media(&self, handle: &str, sink: impl std::io::Write) -> Result<MediaHandle> {
        self.1.copy_to(handle, sink)
    }
    pub fn inline_image(
        &self,
        scope: MediaScope,
        mime_type: &str,
        data: &str,
    ) -> Result<MediaHandle> {
        self.1.inline_image(scope, mime_type, data)
    }
    pub fn open_media(&self, handle: &str) -> Result<(MediaHandle, std::fs::File)> {
        self.1.open(handle)
    }
    pub fn claim(&self, key: &str) -> u64 {
        let mut inner = self.0.lock().unwrap();
        inner.owner += 1;
        let owner = inner.owner;
        let root = inner.root.clone();
        let entry = inner.entries.entry(key.into()).or_insert_with(|| {
            let segment = Segment::new(&root.path);
            Entry {
                snapshot: SessionSnapshot {
                    content_token: uuid::Uuid::new_v4().to_string(),
                    ..Default::default()
                },
                checkpoint: SessionSnapshot::default(),
                checkpoint_offset: 0,
                checkpoint_segment: segment.clone(),
                checkpoint_journal_revision: 0,
                replacement_revision: 0,
                owner,
                records: Vec::new(),
                records_revision: 0,
                earlier_loading: false,
                read_errors: HashMap::new(),
                reads: Default::default(),
                pending_checkpoint: None,
                coverage_running: false,
                signal: watch::channel(Signal::default()).0,
                segment,
            }
        });
        entry.owner = owner;
        owner
    }
    pub fn owns(&self, key: &str, owner: u64) -> bool {
        self.0
            .lock()
            .unwrap()
            .entries
            .get(key)
            .is_some_and(|e| e.owner == owner)
    }
    pub fn contains(&self, key: &str) -> bool {
        self.0.lock().unwrap().entries.contains_key(key)
    }
    pub fn needs_read(&self, key: &str, owner: u64) -> bool {
        self.0
            .lock()
            .unwrap()
            .entries
            .get(key)
            .filter(|e| e.owner == owner)
            .is_none_or(|e| e.snapshot.read.is_none())
    }
    pub fn terminal(&self, key: &str, owner: u64) -> bool {
        self.0
            .lock()
            .unwrap()
            .entries
            .get(key)
            .filter(|entry| entry.owner == owner)
            .is_some_and(|entry| entry.snapshot.terminal)
    }
    pub fn cursor(&self, key: &str, owner: u64) -> Option<EventCursor> {
        self.0
            .lock()
            .unwrap()
            .entries
            .get(key)
            .filter(|e| e.owner == owner)
            .and_then(|e| e.snapshot.cursor.clone())
    }
    /// Short critical section: Arc checkpoint, independent descriptor/length
    /// waterline and notification subscription. No disk reading or decoding here.
    pub fn bind(&self, key: &str) -> Result<SessionBinding> {
        let mut inner = self.0.lock().unwrap();
        let root = inner.root.clone();
        let entry = inner
            .entries
            .get_mut(key)
            .ok_or_else(|| ClientError::Protocol("observation target is not accepted".into()))?;
        entry.reads.paused = false;
        Ok(SessionBinding::new(entry, root, self.clone(), key.into()))
    }

    pub fn commit(&self, key: &str, owner: u64, mut update: SessionUpdate) -> Result<bool> {
        // Recovery Read can be the first proof of a new Session. Admit only
        // its small identity fact before any fallible body storage, under the
        // same owner/domain/order fence used for the later read publication.
        if let SessionUpdate::Read(read) = &update {
            let mut inner = self.0.lock().unwrap();
            let root = inner.root.clone();
            let Some(entry) = inner.entries.get_mut(key).filter(|e| e.owner == owner) else {
                return Ok(false);
            };
            let cursor = &read.page.latest;
            if cursor.instance_id != read.instance.id
                || cursor.runtime_generation != read.instance.runtime_generation
                || read.instance.owner_host_epoch.as_deref().is_some_and(|epoch| epoch != cursor.host_epoch)
                || entry.snapshot.cursor.as_ref().is_some_and(|current| {
                    current.instance_id != cursor.instance_id
                        || current.host_epoch != cursor.host_epoch
                        || current.runtime_generation > cursor.runtime_generation
                        || (current.runtime_generation == cursor.runtime_generation
                            && current.sequence > cursor.sequence)
                })
            {
                return Ok(false);
            }
            if entry.snapshot.target.as_ref().is_some_and(|previous| {
                previous.runtime_generation != read.instance.runtime_generation
                    || previous.executor.pi_session_id != read.instance.executor.pi_session_id
            }) {
                let mut next = entry.snapshot.clone();
                let mut target = read.instance.clone();
                target.event_cursor = cursor.clone();
                replace_snapshot(&mut next, target.clone());
                publish(entry, next, SessionUpdate::Replaced(target), &root.path)?;
            }
        } else if !self.owns(key, owner) {
            return Ok(false);
        }
        // Body/file preparation never holds the canonical commit lock. A late
        // prepared version still has to pass the owner/domain checks below.
        let prepared = if let SessionUpdate::Read(read) = &update {
            let root = self.content_root();
            match read
                .recent_history
                .iter()
                .map(|record| RecordVersion::write(&root, record, false))
                .collect::<Result<Vec<_>>>()
            {
                Ok(records) => records,
                Err(error) => {
                    let _ = self.commit(
                        key,
                        owner,
                        SessionUpdate::Status {
                            state: "storage_error".into(),
                            message: Some("本地对话暂时无法保存，请检查可用空间后重试。".into()),
                        },
                    );
                    return Err(error);
                }
            }
        } else {
            Vec::new()
        };
        let mut inner = self.0.lock().unwrap();
        let root = inner.root.clone();
        let Some(entry) = inner.entries.get_mut(key).filter(|e| e.owner == owner) else {
            return Ok(false);
        };
        let mut next = entry.snapshot.clone();
        let mut incoming_records = None;
        match &mut update {
            SessionUpdate::Read(read) => {
                if next.cursor.as_ref().is_some_and(|cursor| {
                    cursor.host_epoch != read.page.latest.host_epoch
                        || cursor.runtime_generation > read.page.latest.runtime_generation
                        || (cursor.runtime_generation == read.page.latest.runtime_generation
                            && cursor.sequence > read.page.latest.sequence)
                }) {
                    return Ok(false);
                }
                let same_domain = next.read.as_ref().is_some_and(|previous| {
                    previous.instance.runtime_generation == read.instance.runtime_generation
                        && previous.instance.executor.pi_session_id
                            == read.instance.executor.pi_session_id
                        && previous.page.latest.host_epoch == read.page.latest.host_epoch
                });
                if same_domain {
                    // Accept the observation cut immediately, but keep the last
                    // proven content checkpoint and its raw tail until coverage
                    // is established by the content reader.
                    next.cursor = Some(read.page.latest.clone());
                    next.target = Some(read.instance.clone());
                    let mut facts = read.clone();
                    facts.recent_history.clear();
                    publish(
                        entry,
                        next,
                        SessionUpdate::ObservationCut(facts),
                        &root.path,
                    )?;
                    entry.read_errors.remove(&ReadArea::Coverage);
                    entry.pending_checkpoint = Some(PendingCheckpoint {
                        read: read.clone(),
                        offset: entry.segment.end(),
                        revision: entry.snapshot.revision,
                        segment: entry.segment.clone(),
                        records: prepared.clone(),
                    });
                    if !read.history_truncated {
                        finish_checkpoint_entry(entry, prepared, false, &root.path)?;
                    }
                    return Ok(true);
                }
                next.content_token = uuid::Uuid::new_v4().to_string();
                next.can_load_earlier = read.history_truncated;
                incoming_records = Some(prepared);
                read.recent_history.clear();
                next.terminal = terminal_lifecycle(read.instance.lifecycle);
                if !next.terminal && entry.snapshot.terminal {
                    next.state = "connecting".into();
                    next.message = None;
                }
                next.read = Some(Arc::new(read.clone()));
                next.target = Some(read.instance.clone());
                next.cursor = Some(read.page.latest.clone());
            }
            SessionUpdate::Event(event) => {
                let Some(cursor) = &next.cursor else {
                    return Ok(false);
                };
                if event.instance_id != cursor.instance_id
                    || event.runtime_generation < cursor.runtime_generation
                    || (event.runtime_generation == cursor.runtime_generation
                        && event.sequence <= cursor.sequence)
                {
                    return Ok(false);
                }
                if matches!(
                    event.event_type.as_str(),
                    "session.replaced" | "session.navigated"
                ) {
                    let Some(mut target) = next.target.clone() else {
                        return Ok(false);
                    };
                    target.runtime_generation = event.runtime_generation;
                    if event.event_type == "session.replaced" {
                        if let Some(id) = event.data["piSessionId"].as_str() {
                            target.executor.pi_session_id = id.into();
                        }
                        target.name = event.data["name"].as_str().map(str::to_owned);
                        target.pending = crate::PendingCounts {
                            steering: 0,
                            follow_up: 0,
                            total: 0,
                        };
                        if let Some(name) = event.data["displayName"].as_str() {
                            target.display_name = name.into();
                        }
                    }
                    target.event_cursor.runtime_generation = event.runtime_generation;
                    target.event_cursor.sequence = event.sequence;
                    replace_snapshot(&mut next, target.clone());
                    update = SessionUpdate::Replaced(target);
                } else {
                    let terminal = match event.event_type.as_str() {
                        "instance.stopped" => Some(InstanceLifecycle::Stopped),
                        "instance.runtime_error" => Some(InstanceLifecycle::RuntimeError),
                        "instance.state_changed" => match event.data["lifecycle"].as_str() {
                            Some("stopped") => Some(InstanceLifecycle::Stopped),
                            Some("host_lost") => Some(InstanceLifecycle::HostLost),
                            Some("runtime_error") => Some(InstanceLifecycle::RuntimeError),
                            _ => None,
                        },
                        _ => None,
                    };
                    if let Some(lifecycle) = terminal {
                        next.terminal = true;
                        if let Some(target) = &mut next.target {
                            target.lifecycle = lifecycle;
                            target.execution = InstanceExecution::Unavailable;
                            target.owner_host_epoch = None;
                        }
                    }
                    if let Some(cursor) = &mut next.cursor {
                        cursor.runtime_generation = event.runtime_generation;
                        cursor.sequence = event.sequence;
                    }
                }
            }
            // Receipt replacements must use replace(), which checks freshness
            // and revokes the old owner in the same critical section.
            SessionUpdate::Replaced(_) => {
                return Err(ClientError::Protocol(
                    "receipt requires atomic replacement entrance".into(),
                ));
            }
            SessionUpdate::Content { .. }
            | SessionUpdate::ObservationCut(_)
            | SessionUpdate::ReplayEvent { .. } => {
                return Err(ClientError::Protocol(
                    "content updates require the content entrance".into(),
                ));
            }
            SessionUpdate::Status { state, message } => {
                if next.terminal
                    && matches!(
                        state.as_str(),
                        "paused" | "connecting" | "connected" | "disconnected"
                    )
                {
                    return Ok(false);
                }
                if matches!(state.as_str(), "stopped" | "unavailable") {
                    next.terminal = true;
                }
                next.state = state.clone();
                next.message = message.clone();
            }
        }
        let initial_read = matches!(update, SessionUpdate::Read(_));
        publish_with_checkpoint(entry, next, update, &root.path, None, incoming_records)?;
        if initial_read {
            let read = (**entry.snapshot.read.as_ref().unwrap()).clone();
            let mut updates = vec![ContentUpdate::CheckpointBegin { read }];
            updates.extend(
                entry
                    .records
                    .iter()
                    .map(|record| record_update(record, None, &entry.reads.unavailable)),
            );
            updates.push(ContentUpdate::CheckpointEnd);
            updates.push(ContentUpdate::State {
                can_load_earlier: entry.snapshot.can_load_earlier,
                loading: false,
                error: None,
            });
            content_transaction(entry, updates, |_| {})?;
        }
        Ok(true)
    }
    /// Local content identity survives observation ownership and WebView rebinding.
    pub fn content_token(&self, key: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .entries
            .get(key)
            .map(|entry| entry.snapshot.content_token.clone())
    }
    pub(crate) fn owned_content_token(&self, key: &str, owner: u64) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .entries
            .get(key)
            .filter(|entry| entry.owner == owner)
            .map(|entry| entry.snapshot.content_token.clone())
    }
    pub(crate) fn content_root(&self) -> PathBuf {
        self.0.lock().unwrap().root.path.clone()
    }
    pub(crate) fn begin_coverage(&self, key: &str) -> Option<String> {
        let mut inner = self.0.lock().unwrap();
        let entry = inner.entries.get_mut(key)?;
        if entry.coverage_running || entry.pending_checkpoint.is_none() {
            return None;
        }
        entry.coverage_running = true;
        Some(entry.snapshot.content_token.clone())
    }
    pub(crate) fn end_coverage(&self, key: &str, token: &str, successful: bool) -> bool {
        let mut inner = self.0.lock().unwrap();
        let Some(entry) = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)
        else {
            return false;
        };
        if entry.pending_checkpoint.is_some()
            && (successful || !entry.read_errors.contains_key(&ReadArea::Coverage))
        {
            return true;
        }
        entry.coverage_running = false;
        false
    }
    pub(crate) fn checkpoint_request(
        &self,
        key: &str,
    ) -> Option<(String, PendingCheckpoint, Vec<RecordVersion>, bool)> {
        let inner = self.0.lock().unwrap();
        let entry = inner.entries.get(key)?;
        Some((
            entry.snapshot.content_token.clone(),
            entry.pending_checkpoint.clone()?,
            entry.records.clone(),
            entry.snapshot.can_load_earlier,
        ))
    }
    pub(crate) fn finish_checkpoint(
        &self,
        key: &str,
        token: &str,
        revision: u64,
        oldest: Option<&str>,
        records: Vec<RecordVersion>,
        has_earlier: bool,
    ) -> Result<Option<String>> {
        let mut inner = self.0.lock().unwrap();
        let root = inner.root.path.clone();
        let Some(entry) = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)
        else {
            return Ok(None);
        };
        let Some(pending) = entry
            .pending_checkpoint
            .clone()
            .filter(|pending| pending.revision == revision)
        else {
            return Ok(None);
        };
        let _ = pending;
        if entry.records.first().map(|record| record.entry_id.as_str()) != oldest {
            return Ok(None);
        }
        finish_checkpoint_entry(entry, records, has_earlier, &root)?;
        Ok(Some(entry.snapshot.content_token.clone()))
    }
    pub(crate) fn earlier_request(
        &self,
        key: &str,
        token: &str,
    ) -> Result<Option<(InstanceSnapshot, String)>> {
        let mut inner = self.0.lock().unwrap();
        let Some(entry) = inner.entries.get_mut(key).filter(|entry| {
            entry.snapshot.content_token == token
                && !entry.earlier_loading
                && entry.snapshot.can_load_earlier
        }) else {
            return Ok(None);
        };
        let Some(first) = entry.records.first() else {
            return Ok(None);
        };
        let request = (
            entry.snapshot.target.clone().unwrap(),
            first.entry_id.clone(),
        );
        let error = [ReadArea::Coverage, ReadArea::Descriptors]
            .into_iter()
            .find_map(|area| entry.read_errors.get(&area).cloned());
        content_transaction(
            entry,
            vec![ContentUpdate::State {
                can_load_earlier: true,
                loading: true,
                error,
            }],
            |entry| {
                entry.read_errors.remove(&ReadArea::Earlier);
                entry.earlier_loading = true;
            },
        )?;
        Ok(Some(request))
    }
    pub(crate) fn finish_earlier(
        &self,
        key: &str,
        token: &str,
        anchor: &str,
        records: Vec<RecordVersion>,
        has_earlier: bool,
    ) -> Result<bool> {
        let mut inner = self.0.lock().unwrap();
        let Some(entry) = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)
        else {
            return Ok(false);
        };
        if entry
            .records
            .first()
            .is_none_or(|first| first.entry_id != anchor)
        {
            let update = ContentUpdate::State {
                can_load_earlier: entry.snapshot.can_load_earlier,
                loading: false,
                error: read_error(entry),
            };
            content_transaction(entry, vec![update], |entry| entry.earlier_loading = false)?;
            return Ok(false);
        }
        let mut updates: Vec<_> = records
            .iter()
            .map(|record| record_update(record, Some(anchor.into()), &entry.reads.unavailable))
            .collect();
        updates.push(ContentUpdate::State {
            can_load_earlier: has_earlier,
            loading: false,
            error: read_error(entry),
        });
        content_transaction(entry, updates, |entry| {
            let existing = std::mem::take(&mut entry.records);
            entry.records = records;
            entry.records.extend(existing);
            entry.records_revision += 1;
            entry.snapshot.can_load_earlier = has_earlier;
            entry.earlier_loading = false;
        })?;
        Ok(true)
    }
    pub(crate) fn content_failure(
        &self,
        key: &str,
        token: &str,
        failure: ReadFailure,
        error: &ClientError,
    ) -> Result<bool> {
        let mut inner = self.0.lock().unwrap();
        let root = inner.root.path.clone();
        let Some(entry) = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)
        else {
            return Ok(false);
        };
        let area = match failure {
            ReadFailure::Earlier => {
                entry.earlier_loading = false;
                ReadArea::Earlier
            }
            ReadFailure::Coverage(revision) => {
                if entry
                    .pending_checkpoint
                    .as_ref()
                    .is_none_or(|pending| pending.revision != revision)
                {
                    return Ok(false);
                }
                ReadArea::Coverage
            }
            ReadFailure::Descriptors(generation) => {
                if !entry.reads.locator_matches(generation) {
                    return Ok(false);
                }
                ReadArea::Descriptors
            }
        };
        if area == ReadArea::Earlier && !entry.snapshot.can_load_earlier {
            publish_read_state(entry, &root)?;
            return Ok(false);
        }
        let message = if matches!(error, ClientError::Storage { .. }) {
            "本地对话暂时无法保存，请检查可用空间后重试。"
        } else {
            "这部分对话暂时无法读取，请重试。"
        };
        entry.read_errors.insert(area, message.into());
        publish_read_state(entry, &root)?;
        Ok(true)
    }
    pub(crate) fn clear_content_error(
        &self,
        key: &str,
        token: &str,
        area: Option<ReadArea>,
    ) -> Result<()> {
        let mut inner = self.0.lock().unwrap();
        let root = inner.root.path.clone();
        let Some(entry) = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)
        else {
            return Ok(());
        };
        if let Some(area) = area {
            if entry.read_errors.remove(&area).is_none() {
                return Ok(());
            }
        } else {
            entry.read_errors.clear();
        }
        publish_read_state(entry, &root)
    }
    pub(crate) fn should_retry_earlier(&self, key: &str, token: &str) -> bool {
        self.0
            .lock()
            .unwrap()
            .entries
            .get(key)
            .is_some_and(|entry| {
                entry.snapshot.content_token == token
                    && entry.read_errors.contains_key(&ReadArea::Earlier)
            })
    }
    pub(crate) fn pause_content_reads(&self, key: &str) {
        if let Some(entry) = self.0.lock().unwrap().entries.get_mut(key) {
            entry.reads.paused = true;
        }
    }
    pub(crate) fn body_access<T>(
        &self,
        key: &str,
        token: &str,
        action: impl FnOnce(&mut crate::session_content_reader::BodyReads, &[RecordVersion]) -> T,
    ) -> Option<T> {
        let mut inner = self.0.lock().unwrap();
        let entry = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)?;
        Some(action(&mut entry.reads, &entry.records))
    }
    pub(crate) fn body_target(&self, key: &str, token: &str) -> Option<InstanceSnapshot> {
        self.0
            .lock()
            .unwrap()
            .entries
            .get(key)
            .filter(|entry| entry.snapshot.content_token == token)?
            .snapshot
            .target
            .clone()
    }
    pub(crate) fn publish_body(
        &self,
        key: &str,
        token: &str,
        record: RecordVersion,
    ) -> Result<bool> {
        let mut inner = self.0.lock().unwrap();
        let Some(entry) = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)
        else {
            return Ok(false);
        };
        let Some(index) = entry
            .records
            .iter()
            .position(|item| item.entry_id == record.entry_id)
        else {
            return Ok(false);
        };
        if entry.records[index].complete
            && (!entry.reads.unavailable.contains_key(&record.entry_id) || !record.complete)
        {
            return Ok(true);
        }
        content_transaction(
            entry,
            vec![record_update(&record, None, &entry.reads.unavailable)],
            |entry| {
                entry.reads.unavailable.remove(&record.entry_id);
                entry.reads.errors_remove(&record.entry_id, record.complete);
                entry.records[index] = record;
                entry.records_revision += 1;
            },
        )?;
        Ok(true)
    }
    pub(crate) fn record_read_failed(&self, key: &str, token: &str, entry_id: &str, file: &str) {
        let mut inner = self.0.lock().unwrap();
        let root = inner.root.path.clone();
        let Some(entry) = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)
        else {
            return;
        };
        if !entry
            .records
            .iter()
            .any(|record| record.entry_id == entry_id && record.file == file)
        {
            return;
        }
        entry.reads.unavailable.insert(entry_id.into(), file.into());
        entry.reads.file_error(entry_id);
        entry.records_revision += 1;
        let _ = publish(
            entry,
            entry.snapshot.clone(),
            SessionUpdate::Content {
                token: token.into(),
                update: ContentUpdate::EntryState {
                    entry_id: entry_id.into(),
                    loading: false,
                    error: Some(RECORD_READ_ERROR.into()),
                },
            },
            &root,
        );
    }
    pub(crate) fn body_status(
        &self,
        key: &str,
        token: &str,
        entry_id: &str,
        loading: bool,
        error: Option<String>,
    ) -> Result<()> {
        let mut inner = self.0.lock().unwrap();
        let root = inner.root.path.clone();
        let Some(entry) = inner
            .entries
            .get_mut(key)
            .filter(|entry| entry.snapshot.content_token == token)
        else {
            return Ok(());
        };
        publish(
            entry,
            entry.snapshot.clone(),
            SessionUpdate::Content {
                token: token.into(),
                update: ContentUpdate::EntryState {
                    entry_id: entry_id.into(),
                    loading,
                    error,
                },
            },
            &root,
        )
    }
    pub fn replace(
        &self,
        key: &str,
        target: InstanceSnapshot,
        branch_changed: bool,
    ) -> Result<bool> {
        let mut inner = self.0.lock().unwrap();
        let Some(entry) = inner.entries.get(key) else {
            return Ok(false);
        };
        let result = &target.event_cursor;
        if result.instance_id != target.id
            || result.runtime_generation != target.runtime_generation
            || target.owner_host_epoch.as_deref() != Some(result.host_epoch.as_str())
        {
            return Ok(false);
        }
        if let Some(current) = &entry.snapshot.cursor {
            if current.host_epoch != result.host_epoch
                || current.instance_id != result.instance_id
                || current.runtime_generation > result.runtime_generation
            {
                return Ok(false);
            }
            if current.runtime_generation == result.runtime_generation {
                // Host appends session.navigated before returning its snapshot.
                // Its authoritative journal position orders same-domain branches;
                // equal positions are event-before-reply / duplicate receipts.
                if !branch_changed
                    || result.sequence <= current.sequence
                    || entry.snapshot.target.as_ref().is_some_and(|current| {
                        current.executor.pi_session_id != target.executor.pi_session_id
                    })
                {
                    return Ok(false);
                }
            }
        }
        let root = inner.root.clone();
        inner.owner += 1;
        let owner = inner.owner;
        let entry = inner.entries.get_mut(key).unwrap();
        let mut next = entry.snapshot.clone();
        replace_snapshot(&mut next, target.clone());
        // Publishing can fail without accepting the target or revoking its reader.
        publish(entry, next, SessionUpdate::Replaced(target), &root.path)?;
        entry.owner = owner;
        Ok(true)
    }
}
fn replace_snapshot(snapshot: &mut SessionSnapshot, target: InstanceSnapshot) {
    snapshot.content_token = uuid::Uuid::new_v4().to_string();
    snapshot.can_load_earlier = false;
    snapshot.terminal = terminal_lifecycle(target.lifecycle);
    snapshot.read = None;
    snapshot.cursor = Some(target.event_cursor.clone());
    snapshot.target = Some(target);
}
fn publish(
    entry: &mut Entry,
    next: SessionSnapshot,
    update: SessionUpdate,
    root: &std::path::Path,
) -> Result<()> {
    publish_with_checkpoint(entry, next, update, root, None, None)
}
fn publish_with_checkpoint(
    entry: &mut Entry,
    mut next: SessionSnapshot,
    update: SessionUpdate,
    root: &std::path::Path,
    replay: Option<(&Arc<Segment>, u64, &EventCursor, u64)>,
    records: Option<Vec<RecordVersion>>,
) -> Result<()> {
    next.revision = entry.snapshot.revision + 1;
    // Recovery can discover a replacement without observing its event (for
    // example generation_changed while disconnected). Keep the complete Read,
    // but grant that accepted identity change the same priority cut as receipts.
    let replacement = matches!(update, SessionUpdate::Replaced(_))
        || matches!(&update, SessionUpdate::Read(read) if entry.snapshot.target.as_ref().is_some_and(|previous|
            previous.runtime_generation != read.instance.runtime_generation
                || previous.executor.pi_session_id != read.instance.executor.pi_session_id));
    let checkpoint = matches!(update, SessionUpdate::Read(_) | SessionUpdate::Replaced(_));
    let rotate = checkpoint || matches!(update, SessionUpdate::ObservationCut(_));
    let commit = SessionCommit {
        revision: next.revision,
        update,
    };
    let segment = if rotate {
        Segment::new(root)
    } else {
        entry.segment.clone()
    };
    let offset = match segment.append(&commit) {
        Ok(offset) => offset,
        Err(error) => {
            if matches!(commit.update, SessionUpdate::Replaced(_)) {
                let (memory, offset) = Segment::replacement_in_memory(root, &commit)?;
                entry.segment.link(memory.clone());
                entry.segment = memory;
                install_records(entry, &next, records);
                next.state = "storage_error".into();
                next.message =
                    Some("会话已切换，但本地内容无法保存，请检查可用空间后重试。".into());
                entry.replacement_revision = commit.revision;
                checkpoint_at(entry, &next, offset, replay);
                next.revision += 1;
                let fault = SessionCommit {
                    revision: next.revision,
                    update: SessionUpdate::Status {
                        state: next.state.clone(),
                        message: next.message.clone(),
                    },
                };
                entry.snapshot = next;
                entry
                    .signal
                    .send_replace(current_signal(entry, Some(fault)));
                return Ok(());
            }
            storage_fault(entry, next.revision);
            return Err(error);
        }
    };
    if replacement || records.is_some() {
        install_records(entry, &next, records);
    }
    if replacement {
        entry.replacement_revision = commit.revision;
    }
    if rotate {
        entry.segment.link(segment.clone());
        entry.segment = segment;
    }
    if checkpoint {
        checkpoint_at(entry, &next, offset, replay);
    }
    entry.snapshot = next;
    entry.signal.send_replace(current_signal(entry, None));
    Ok(())
}

fn install_records(entry: &mut Entry, next: &SessionSnapshot, records: Option<Vec<RecordVersion>>) {
    if let Some(records) = records {
        entry.records = records;
    } else if next.read.is_none() {
        entry.records.clear();
    }
    entry.records_revision += 1;
    let paused = entry.reads.paused;
    let unavailable: HashMap<_, _> = entry
        .reads
        .unavailable
        .iter()
        .filter(|(id, file)| {
            entry
                .records
                .iter()
                .any(|record| &record.entry_id == *id && &record.file == *file)
        })
        .map(|(id, file)| (id.clone(), file.clone()))
        .collect();
    entry.reads = Default::default();
    for id in unavailable.keys() {
        entry.reads.file_error(id);
    }
    entry.reads.unavailable = unavailable;
    entry.reads.paused = paused;
    entry.read_errors.clear();
    entry.pending_checkpoint = None;
    entry.coverage_running = false;
    entry.earlier_loading = false;
}
fn checkpoint_at(
    entry: &mut Entry,
    snapshot: &SessionSnapshot,
    offset: u64,
    replay: Option<(&Arc<Segment>, u64, &EventCursor, u64)>,
) {
    entry.checkpoint = snapshot.clone();
    entry.checkpoint_segment = entry.segment.clone();
    entry.checkpoint_offset = offset;
    entry.checkpoint_journal_revision = snapshot.revision;
    if let Some((segment, offset, cursor, revision)) = replay {
        entry.checkpoint_segment = segment.clone();
        entry.checkpoint_offset = offset;
        entry.checkpoint.cursor = Some(cursor.clone());
        entry.checkpoint_journal_revision = revision;
    }
}

fn finish_checkpoint_entry(
    entry: &mut Entry,
    mut records: Vec<RecordVersion>,
    has_earlier: bool,
    root: &std::path::Path,
) -> Result<()> {
    let pending = entry
        .pending_checkpoint
        .clone()
        .expect("accepted candidate");
    let membership: std::collections::HashSet<_> = records
        .iter()
        .map(|record| record.entry_id.as_str())
        .collect();
    let branch_changed = entry
        .records
        .iter()
        .any(|old| !membership.contains(old.entry_id.as_str()));
    let complete: HashMap<_, _> = entry
        .records
        .iter()
        .filter(|record| record.complete)
        .map(|record| (&record.entry_id, record))
        .collect();
    for record in &mut records {
        if let Some(previous) = complete.get(&record.entry_id) {
            *record = (*previous).clone();
        }
    }
    let mut read = pending.read;
    read.recent_history.clear();
    read.history_truncated = has_earlier;
    if branch_changed {
        let mut next = entry.snapshot.clone();
        next.content_token = uuid::Uuid::new_v4().to_string();
        next.read = Some(Arc::new(read.clone()));
        next.can_load_earlier = has_earlier;
        return publish_with_checkpoint(
            entry,
            next,
            SessionUpdate::Replaced(read.instance.clone()),
            root,
            Some((
                &pending.segment,
                pending.offset,
                &read.page.latest,
                pending.revision,
            )),
            Some(records),
        );
    }
    let mut updates = vec![ContentUpdate::CheckpointBegin { read: read.clone() }];
    updates.extend(
        records
            .iter()
            .map(|record| record_update(record, None, &entry.reads.unavailable)),
    );
    updates.push(ContentUpdate::CheckpointEnd);
    let remaining_error = [ReadArea::Earlier, ReadArea::Descriptors]
        .into_iter()
        .filter(|area| has_earlier || *area != ReadArea::Earlier)
        .find_map(|area| entry.read_errors.get(&area).cloned());
    updates.push(ContentUpdate::State {
        can_load_earlier: has_earlier,
        loading: entry.earlier_loading,
        error: remaining_error,
    });
    content_transaction(entry, updates, |entry| {
        entry.records = records;
        entry.records_revision += 1;
        entry.read_errors.remove(&ReadArea::Coverage);
        if !has_earlier {
            entry.read_errors.remove(&ReadArea::Earlier);
        }
        entry.snapshot.read = Some(Arc::new(read.clone()));
        entry.snapshot.can_load_earlier = has_earlier;
        entry.checkpoint = entry.snapshot.clone();
        entry.checkpoint.cursor = Some(read.page.latest);
        entry.checkpoint.revision = pending.revision;
        entry.checkpoint_offset = pending.offset;
        entry.checkpoint_journal_revision = pending.revision;
        entry.checkpoint_segment = pending.segment;
        entry.pending_checkpoint = None;
    })?;
    Ok(())
}

fn read_error(entry: &Entry) -> Option<String> {
    [ReadArea::Earlier, ReadArea::Coverage, ReadArea::Descriptors]
        .into_iter()
        .find_map(|area| entry.read_errors.get(&area).cloned())
}
fn publish_read_state(entry: &mut Entry, root: &std::path::Path) -> Result<()> {
    publish(
        entry,
        entry.snapshot.clone(),
        SessionUpdate::Content {
            token: entry.snapshot.content_token.clone(),
            update: ContentUpdate::State {
                can_load_earlier: entry.snapshot.can_load_earlier,
                loading: entry.earlier_loading,
                error: read_error(entry),
            },
        },
        root,
    )
}
fn content_states(entry: &Entry) -> Vec<ContentUpdate> {
    if entry.snapshot.target.is_none() {
        return Vec::new();
    }
    let mut states = entry.reads.states();
    if !entry.records.is_empty() || entry.earlier_loading || !entry.read_errors.is_empty() {
        states.push(ContentUpdate::State {
            can_load_earlier: entry.snapshot.can_load_earlier,
            loading: entry.earlier_loading,
            error: read_error(entry),
        });
    }
    states
}

fn record_update(
    record: &RecordVersion,
    before_entry_id: Option<String>,
    unavailable: &HashMap<String, String>,
) -> ContentUpdate {
    if unavailable.get(&record.entry_id) == Some(&record.file) {
        return ContentUpdate::RecordError {
            entry_id: record.entry_id.clone(),
            before_entry_id,
            error: RECORD_READ_ERROR.into(),
        };
    }
    ContentUpdate::StoredRecord {
        lease: Some(record.lease.clone()),
        entry_id: record.entry_id.clone(),
        file: record.file.clone(),
        size_bytes: record.size_bytes,
        sha256: record.sha256.clone(),
        before_entry_id,
    }
}
fn content_transaction(
    entry: &mut Entry,
    updates: Vec<ContentUpdate>,
    apply: impl FnOnce(&mut Entry),
) -> Result<()> {
    let revision = entry.snapshot.revision;
    let commits: Vec<_> = updates
        .into_iter()
        .enumerate()
        .map(|(index, update)| SessionCommit {
            revision: revision + index as u64 + 1,
            update: SessionUpdate::Content {
                token: entry.snapshot.content_token.clone(),
                update,
            },
        })
        .collect();
    if let Err(error) = entry.segment.append_many(&commits) {
        storage_fault(entry, revision + 1);
        return Err(error);
    }
    entry.snapshot.revision = commits.last().map_or(revision, |commit| commit.revision);
    apply(entry);
    entry.signal.send_replace(current_signal(entry, None));
    Ok(())
}
fn storage_fault(entry: &mut Entry, revision: u64) {
    // Storage failure remains visible even when its own journal cannot write.
    // Neither a remote cursor nor an uncommitted record index advances here.
    entry.snapshot.revision = revision;
    entry.snapshot.state = "storage_error".into();
    entry.snapshot.message = Some("本地对话内容无法保存，请检查可用空间后重试。".into());
    let fault = SessionCommit {
        revision,
        update: SessionUpdate::Status {
            state: entry.snapshot.state.clone(),
            message: entry.snapshot.message.clone(),
        },
    };
    entry
        .signal
        .send_replace(current_signal(entry, Some(fault)));
}

fn terminal_lifecycle(lifecycle: InstanceLifecycle) -> bool {
    matches!(
        lifecycle,
        InstanceLifecycle::Stopped | InstanceLifecycle::HostLost | InstanceLifecycle::RuntimeError
    )
}

fn current_signal(entry: &Entry, fault: Option<SessionCommit>) -> Signal {
    Signal {
        replacement: replacement_cut(entry),
        revision: entry.snapshot.revision,
        fault,
        status: (entry.snapshot.state.clone(), entry.snapshot.message.clone()),
    }
}
fn replacement_cut(entry: &Entry) -> Option<Arc<ReplacementCut>> {
    if entry.replacement_revision == 0 {
        return None;
    }
    if let Some(cut) = entry.signal.borrow().replacement.as_ref().filter(|cut| {
        cut.revision == entry.replacement_revision
            && cut.records_revision == entry.records_revision
            && cut.snapshot.revision == entry.checkpoint.revision
    }) {
        return Some(cut.clone());
    }
    let mut snapshot = entry.checkpoint.clone();
    snapshot.state = entry.snapshot.state.clone();
    snapshot.message = entry.snapshot.message.clone();
    Some(Arc::new(ReplacementCut {
        revision: entry.replacement_revision,
        snapshot,
        segment: entry.checkpoint_segment.clone(),
        offset: entry.checkpoint_offset,
        records: entry.records.clone(),
        states: content_states(entry),
        records_revision: entry.records_revision,
        waterline: entry.snapshot.revision,
        journal_revision: entry.checkpoint_journal_revision,
        unavailable: entry.reads.unavailable.clone(),
    }))
}
