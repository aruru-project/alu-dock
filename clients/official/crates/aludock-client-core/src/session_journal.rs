//! Forward-only in-memory commits. Checkpoints link segments; only actual
//! readers keep superseded segments and their immutable record bodies alive.
use crate::{Result, SessionCommit};
use std::sync::{Arc, Mutex};

// IPC/replay scheduling bounds, not content-size limits. A larger individual
// protocol commit travels alone; no accepted Agent content is truncated.
pub(crate) const BATCH_BYTES: usize = 256 * 1024;
pub(crate) const BATCH_COMMITS: usize = 64;

struct Frame {
    commit: Arc<SessionCommit>,
    bytes: usize,
}
#[derive(Default)]
struct SegmentState {
    commits: Vec<Frame>,
    next: Option<Arc<Segment>>,
}
pub(crate) struct Segment {
    state: Mutex<SegmentState>,
}
impl Segment {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SegmentState::default()),
        })
    }
    pub fn append(&self, commit: &SessionCommit) -> Result<u64> {
        self.append_many(std::slice::from_ref(commit))
    }
    /// Prepare outside the segment lock, then publish a metadata transaction
    /// atomically. Record bodies are shared references, not encoded again.
    pub fn append_many(&self, commits: &[SessionCommit]) -> Result<u64> {
        let frames = commits
            .iter()
            .map(|commit| {
                Ok(Frame {
                    bytes: serde_json::to_vec(commit)?.len(),
                    commit: Arc::new(commit.clone()),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut state = self.state.lock().unwrap();
        state.commits.extend(frames);
        Ok(state.commits.len() as u64)
    }
    pub fn end(&self) -> u64 {
        self.state.lock().unwrap().commits.len() as u64
    }
    pub fn link(&self, next: Arc<Self>) {
        self.state.lock().unwrap().next = Some(next);
    }
    pub fn reader(self: &Arc<Self>, offset: u64) -> JournalReader {
        JournalReader {
            segment: self.clone(),
            offset: offset as usize,
        }
    }
}
pub(crate) struct JournalReader {
    segment: Arc<Segment>,
    offset: usize,
}
impl JournalReader {
    /// The lock only copies bounded shared references. Potentially large
    /// source-event clones happen after releasing it.
    pub fn try_batch(&mut self) -> Vec<SessionCommit> {
        let mut batch = Vec::with_capacity(BATCH_COMMITS);
        let mut bytes = 0;
        loop {
            let (next, at_end) = {
                let state = self.segment.state.lock().unwrap();
                for frame in &state.commits[self.offset..] {
                    if !batch.is_empty() && bytes + frame.bytes > BATCH_BYTES {
                        break;
                    }
                    bytes += frame.bytes;
                    batch.push(frame.commit.clone());
                    self.offset += 1;
                    if bytes >= BATCH_BYTES || batch.len() >= BATCH_COMMITS {
                        break;
                    }
                }
                (state.next.clone(), self.offset == state.commits.len())
            };
            if bytes >= BATCH_BYTES || batch.len() >= BATCH_COMMITS || !at_end {
                break;
            }
            if let Some(next) = next {
                *self = next.reader(0);
            } else {
                break;
            }
        }
        batch.into_iter().map(|commit| (*commit).clone()).collect()
    }
}
