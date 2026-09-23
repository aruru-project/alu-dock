//! SessionContent's disk-backed record versions. This is storage, not another
//! content owner: membership and publication remain under SessionContent's lock.
use crate::{
    HistoryRecord, Result,
    private_fs::{storage_error, write_new_private_file},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

/// The file name is generated locally, never supplied by a client or a Host.
#[derive(Clone, Debug)]
pub(crate) struct RecordVersion {
    pub entry_id: String,
    pub file: String,
    pub complete: bool,
    pub size_bytes: u64,
    pub sha256: String,
    pub lease: Arc<RecordFile>,
}
/// Local lifetime only; never serialized into the journal or IPC. Current
/// membership, checkpoint seeds and actual replay readers pin their versions.
#[derive(Debug)]
pub struct RecordFile(PathBuf);
impl Drop for RecordFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
impl RecordVersion {
    pub fn write(root: &Path, record: &HistoryRecord, complete: bool) -> Result<Self> {
        Self::write_value(
            root,
            &record.entry_id,
            &serde_json::to_value(record)?,
            complete,
        )
    }
    pub fn write_value(
        root: &Path,
        entry_id: &str,
        record: &serde_json::Value,
        complete: bool,
    ) -> Result<Self> {
        fs::create_dir_all(root).map_err(|error| storage_error(root, error))?;
        crate::private_fs::set_private_directory_permissions(root)?;
        let file = uuid::Uuid::new_v4().to_string();
        let path = root.join(&file);
        let bytes = serde_json::to_vec(record)?;
        let size_bytes = bytes.len() as u64;
        let sha256 = hex::encode(Sha256::digest(&bytes));
        if let Err(error) = write_new_private_file(&path, &bytes) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok(Self {
            entry_id: entry_id.into(),
            file,
            complete,
            size_bytes,
            sha256,
            lease: Arc::new(RecordFile(path)),
        })
    }
    pub fn read(&self, root: &Path) -> Result<HistoryRecord> {
        let path = root.join(&self.file);
        let bytes = fs::read(&path).map_err(|error| storage_error(&path, error))?;
        if bytes.len() as u64 != self.size_bytes
            || hex::encode(Sha256::digest(&bytes)) != self.sha256
        {
            return Err(storage_error(
                &path,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "local record integrity changed",
                ),
            ));
        }
        serde_json::from_slice(&bytes).map_err(|error| {
            storage_error(
                &path,
                std::io::Error::new(std::io::ErrorKind::InvalidData, error),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContentUpdate, SessionCommit, SessionUpdate, session_journal::Segment};

    #[test]
    fn replaced_record_files_live_until_the_last_actual_replay_releases_them() {
        let root = std::env::temp_dir().join(format!("record-lease-{}", uuid::Uuid::new_v4()));
        let version = RecordVersion::write_value(
            &root,
            "entry",
            &serde_json::json!({"text":"accepted"}),
            true,
        )
        .unwrap();
        let path = root.join(&version.file);
        let segment = Segment::new(&root);
        let commit = SessionCommit {
            revision: 1,
            update: SessionUpdate::Content {
                token: "scope".into(),
                update: ContentUpdate::StoredRecord {
                    entry_id: version.entry_id.clone(),
                    file: version.file.clone(),
                    size_bytes: version.size_bytes,
                    sha256: version.sha256.clone(),
                    before_entry_id: None,
                    lease: Some(version.lease.clone()),
                },
            },
        };
        segment.append(&commit).unwrap();
        let mut reader = segment.reader(0);
        drop(commit);
        drop(version);
        let replay = reader.try_batch().unwrap();
        drop(segment);
        drop(reader);
        assert!(path.exists(), "a queued replay still needs its old version");
        drop(replay);
        assert!(
            !path.exists(),
            "an unreferenced version is not retained until App exit"
        );
        let abandoned =
            RecordVersion::write_value(&root, "unaccepted", &serde_json::json!({}), true).unwrap();
        let path = root.join(&abandoned.file);
        drop(abandoned);
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
