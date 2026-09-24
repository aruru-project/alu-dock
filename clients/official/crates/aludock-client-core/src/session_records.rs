//! Immutable in-memory record versions. Membership and publication remain
//! under SessionContent's lock; checkpoints and actual readers share the body.
use crate::{HistoryRecord, Result};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub(crate) struct RecordVersion {
    pub entry_id: String,
    pub complete: bool,
    pub body: Arc<str>,
}
impl RecordVersion {
    pub fn new(record: &HistoryRecord, complete: bool) -> Result<Self> {
        Ok(Self {
            entry_id: record.entry_id.clone(),
            complete,
            body: serde_json::to_string(record)?.into(),
        })
    }
    pub fn from_value(entry_id: &str, record: &serde_json::Value, complete: bool) -> Result<Self> {
        Ok(Self {
            entry_id: entry_id.into(),
            complete,
            body: serde_json::to_string(record)?.into(),
        })
    }
    pub fn read(&self) -> Result<HistoryRecord> {
        Ok(serde_json::from_str(&self.body)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContentUpdate, SessionCommit, SessionUpdate, session_journal::Segment};

    #[test]
    fn superseded_body_remains_shared_until_its_actual_replay_releases_it() {
        let version =
            RecordVersion::from_value("entry", &serde_json::json!({"text":"accepted"}), true)
                .unwrap();
        let body = Arc::downgrade(&version.body);
        let segment = Segment::new();
        segment
            .append(&SessionCommit {
                revision: 1,
                update: SessionUpdate::Content {
                    token: "scope".into(),
                    update: ContentUpdate::MemoryRecord {
                        body: version.body.clone(),
                        entry_id: version.entry_id.clone(),
                        before_entry_id: None,
                    },
                },
            })
            .unwrap();
        let mut reader = segment.reader(0);
        drop(version);
        let replay = reader.try_batch();
        drop(segment);
        drop(reader);
        assert_eq!(body.upgrade().as_deref(), Some("{\"text\":\"accepted\"}"));
        drop(replay);
        assert!(
            body.upgrade().is_none(),
            "no App-lifetime side map retains an obsolete body"
        );
    }
}
