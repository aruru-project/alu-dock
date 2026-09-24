//! Pinned, bounded display replay of SessionContent's record versions and raw
//! journal. It owns no membership or remote-reading decisions.
use super::{
    ContentUpdate, Entry, SessionCommit, SessionSnapshot, SessionUpdate, Signal, content_states,
};
use crate::{
    Result,
    session_journal::{BATCH_BYTES, BATCH_COMMITS, JournalReader},
    session_records::RecordVersion,
};
use std::{collections::VecDeque, sync::Arc};
use tokio::sync::watch;
/// A pinned checkpoint plus forward-only shared replay. A slow display never
/// forces another snapshot or copies a whole-session backlog.
pub struct SessionBinding {
    pub snapshot: SessionSnapshot,
    reader: JournalReader,
    signal: watch::Receiver<Signal>,
    revision: u64,
    bound_revision: u64,
    content_waterline: u64,
    replacement_revision: u64,
    seed: VecDeque<SessionCommit>,
    pending: VecDeque<SessionCommit>,
    record: Option<RecordReplay>,
    ready: Option<SessionCommit>,
    seed_end: Option<SessionCommit>,
}
struct RecordReplay {
    revision: u64,
    token: String,
    entry_id: String,
    before_entry_id: Option<String>,
    body: Arc<str>,
    offset: usize,
}
impl RecordReplay {
    fn next(&mut self) -> SessionCommit {
        let first = self.offset == 0;
        let mut end = (self.offset + BATCH_BYTES / 8).min(self.body.len());
        while !self.body.is_char_boundary(end) {
            end -= 1;
        }
        let text = self.body[self.offset..end].to_owned();
        self.offset = end;
        SessionCommit {
            revision: self.revision,
            update: SessionUpdate::Content {
                token: self.token.clone(),
                update: ContentUpdate::RecordChunk {
                    entry_id: self.entry_id.clone(),
                    text,
                    first,
                    complete: end == self.body.len(),
                    before_entry_id: self.before_entry_id.clone(),
                },
            },
        }
    }
}
impl SessionBinding {
    pub(super) fn new(entry: &Entry) -> Self {
        let mut snapshot = entry.checkpoint.clone();
        snapshot.state = entry.snapshot.state.clone();
        snapshot.message = entry.snapshot.message.clone();
        snapshot.content_token = entry.snapshot.content_token.clone();
        snapshot.can_load_earlier = entry.snapshot.can_load_earlier;
        let seed = record_seed(&snapshot, &entry.records, &content_states(entry));
        let seed_end = snapshot
            .read
            .as_ref()
            .map(|_| seed_end(&snapshot.content_token, entry.snapshot.revision));
        Self {
            snapshot,
            seed_end,
            revision: entry.checkpoint_journal_revision,
            bound_revision: entry.snapshot.revision,
            content_waterline: entry.snapshot.revision,
            replacement_revision: entry.replacement_revision,
            reader: entry.checkpoint_segment.reader(entry.checkpoint_offset),
            signal: entry.signal.subscribe(),
            seed,
            pending: VecDeque::new(),
            record: None,
            ready: None,
        }
    }

    /// Replacement is a priority control fact, not the last item of an old
    /// Session's potentially long display backlog. Only a real target/branch
    /// replacement may skip that obsolete tail; ordinary lag never starts over.
    pub fn take_replacement(&mut self) -> Option<SessionSnapshot> {
        let signal = self.signal.borrow().clone();
        let cut = signal
            .replacement
            .filter(|cut| cut.revision > self.replacement_revision)?;
        self.replacement_revision = cut.revision;
        self.revision = cut.journal_revision;
        self.bound_revision = signal.revision;
        self.content_waterline = cut.waterline;
        self.reader = cut.segment.reader(cut.offset);
        self.seed = record_seed(&cut.snapshot, &cut.records, &cut.states);
        self.seed_end = cut
            .snapshot
            .read
            .as_ref()
            .map(|_| seed_end(&cut.snapshot.content_token, signal.revision));
        self.pending.clear();
        self.record = None;
        self.ready = None;
        self.snapshot = cut.snapshot.clone();
        self.snapshot.state = signal.status.0;
        self.snapshot.message = signal.status.1;
        Some(self.snapshot.clone())
    }
    pub async fn replacement_changed(&mut self) -> bool {
        loop {
            if self
                .signal
                .borrow_and_update()
                .replacement
                .as_ref()
                .is_some_and(|cut| cut.revision > self.replacement_revision)
            {
                return true;
            }
            if self.signal.changed().await.is_err() {
                return false;
            }
        }
    }
    pub async fn next_batch(&mut self) -> Result<Vec<SessionCommit>> {
        let mut output = Vec::new();
        let mut bytes = 0;
        loop {
            if let Some(commit) = self.ready.take() {
                if push_batch(&mut output, &mut bytes, commit, &mut self.ready)? {
                    return Ok(output);
                }
                continue;
            }
            if let Some(record) = &mut self.record {
                let commit = record.next();
                if matches!(
                    &commit.update,
                    SessionUpdate::Content {
                        update: ContentUpdate::RecordChunk { complete: true, .. },
                        ..
                    }
                ) {
                    self.record = None;
                }
                if push_batch(&mut output, &mut bytes, commit, &mut self.ready)? {
                    return Ok(output);
                }
                continue;
            }
            if self.seed.is_empty()
                && self.seed_end.is_some()
                && (self
                    .pending
                    .front()
                    .is_some_and(|commit| commit.revision > self.bound_revision)
                    || (self.pending.is_empty() && self.revision >= self.bound_revision))
            {
                let commit = self.seed_end.take().unwrap();
                if push_batch(&mut output, &mut bytes, commit, &mut self.ready)? {
                    return Ok(output);
                }
                continue;
            }
            if let Some(commit) = self.seed.pop_front().or_else(|| self.pending.pop_front()) {
                if let SessionUpdate::Content {
                    token,
                    update:
                        ContentUpdate::MemoryRecord {
                            body,
                            entry_id,
                            before_entry_id,
                        },
                } = commit.update
                {
                    self.record = Some(RecordReplay {
                        revision: commit.revision,
                        token,
                        entry_id,
                        before_entry_id,
                        body,
                        offset: 0,
                    });
                    continue;
                }
                if push_batch(&mut output, &mut bytes, commit, &mut self.ready)? {
                    return Ok(output);
                }
                continue;
            }
            let mut batch = self.reader.try_batch();
            if let Some(last) = batch.last() {
                self.revision = last.revision;
                // Transport history is not current connection status. The bind
                // header already carries the last confirmed status at its waterline.
                batch.retain(|commit| match commit.update {
                    SessionUpdate::Status { .. } => commit.revision > self.bound_revision,
                    SessionUpdate::Content { .. } => commit.revision > self.content_waterline,
                    _ => true,
                });
                if !batch.is_empty() {
                    for commit in &mut batch {
                        if commit.revision <= self.bound_revision {
                            if let SessionUpdate::Event(event) = &commit.update {
                                commit.update = SessionUpdate::ReplayEvent {
                                    token: self.snapshot.content_token.clone(),
                                    event: event.clone(),
                                };
                            }
                        }
                    }
                    self.pending.extend(batch);
                    continue;
                }
                tokio::task::yield_now().await;
                continue;
            }
            if !output.is_empty() {
                return Ok(output);
            }
            let signal = self.signal.borrow_and_update().clone();
            // A commit may have completed between reading the waterline and
            // observing its notification; retry that waterline, not the snapshot.
            if signal.revision > self.revision {
                continue;
            }
            if self.signal.changed().await.is_err() {
                return Ok(Vec::new());
            }
        }
    }
}
fn push_batch(
    output: &mut Vec<SessionCommit>,
    bytes: &mut usize,
    commit: SessionCommit,
    ready: &mut Option<SessionCommit>,
) -> Result<bool> {
    let size = serde_json::to_vec(&commit)?.len();
    if !output.is_empty() && *bytes + size > BATCH_BYTES {
        *ready = Some(commit);
        return Ok(true);
    }
    *bytes += size;
    output.push(commit);
    Ok(*bytes >= BATCH_BYTES || output.len() >= BATCH_COMMITS)
}
fn record_seed(
    snapshot: &SessionSnapshot,
    records: &[RecordVersion],
    states: &[ContentUpdate],
) -> VecDeque<SessionCommit> {
    let token = &snapshot.content_token;
    let mut seed: VecDeque<_> = records
        .iter()
        .map(|record| SessionCommit {
            revision: snapshot.revision,
            update: SessionUpdate::Content {
                token: token.clone(),
                update: ContentUpdate::MemoryRecord {
                    body: record.body.clone(),
                    entry_id: record.entry_id.clone(),
                    before_entry_id: None,
                },
            },
        })
        .collect();
    let mut state_seed: VecDeque<_> = states
        .iter()
        .cloned()
        .map(|update| SessionCommit {
            revision: snapshot.revision,
            update: SessionUpdate::Content {
                token: token.clone(),
                update,
            },
        })
        .collect();
    state_seed.append(&mut seed);
    let seed = state_seed;
    seed
}

fn seed_end(token: &str, revision: u64) -> SessionCommit {
    SessionCommit {
        revision,
        update: SessionUpdate::Content {
            token: token.into(),
            update: ContentUpdate::CheckpointEnd,
        },
    }
}
