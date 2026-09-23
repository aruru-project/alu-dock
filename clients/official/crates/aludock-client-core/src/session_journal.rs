//! Private append journal. Readers use an independently opened descriptor and
//! positional reads, never the append descriptor's shared seek position.
use crate::{
    Result, SessionCommit,
    private_fs::{set_private_directory_permissions, storage_error, write_new_private_file},
};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

// IPC/replay scheduling bounds, not content-size limits. A larger individual
// protocol commit travels alone; no accepted Agent content is truncated.
pub(crate) const BATCH_BYTES: usize = 256 * 1024;
pub(crate) const BATCH_COMMITS: usize = 64;

#[derive(Clone)]
enum Source {
    File(Arc<File>),
    Memory(Arc<[u8]>),
}
struct SegmentState {
    records: HashMap<String, Arc<crate::session_records::RecordFile>>,
    writer: Option<File>,
    reader: Option<Source>,
    end: u64,
    poisoned: bool,
    next: Option<Arc<Segment>>,
}
pub(crate) struct Segment {
    path: PathBuf,
    state: Mutex<SegmentState>,
}
impl Segment {
    pub fn new(root: &std::path::Path) -> Arc<Self> {
        Arc::new(Self {
            path: root.join(uuid::Uuid::new_v4().to_string()),
            state: Mutex::new(SegmentState {
                records: HashMap::new(),
                writer: None,
                reader: None,
                end: 0,
                poisoned: false,
                next: None,
            }),
        })
    }
    pub fn append(&self, commit: &SessionCommit) -> Result<u64> {
        self.append_many(std::slice::from_ref(commit))
    }
    /// A metadata transaction becomes readable only after every frame is on
    /// disk. Bodies live in record files; this never batches whole bodies.
    pub fn append_many(&self, commits: &[SessionCommit]) -> Result<u64> {
        let frames = commits
            .iter()
            .map(serde_json::to_vec)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut state = self.state.lock().unwrap();
        if state.poisoned || matches!(state.reader, Some(Source::Memory(_))) {
            return Err(storage_error(
                &self.path,
                io::Error::other("content checkpoint requires disk recovery"),
            ));
        }
        if state.writer.is_none() {
            let root = self.path.parent().unwrap();
            fs::create_dir_all(root).map_err(|e| storage_error(root, e))?;
            set_private_directory_permissions(root)?;
            let opened = (|| -> Result<(File, File)> {
                write_new_private_file(&self.path, &[])?;
                let writer = OpenOptions::new()
                    .append(true)
                    .open(&self.path)
                    .map_err(|e| storage_error(&self.path, e))?;
                // Independent open at publication, not a shared append offset
                // or a naked path reopened after bind releases its lock.
                let reader = File::open(&self.path).map_err(|e| storage_error(&self.path, e))?;
                Ok((writer, reader))
            })();
            let (writer, reader) = match opened {
                Ok(files) => files,
                Err(error) => {
                    let _ = fs::remove_file(&self.path);
                    return Err(error);
                }
            };
            state.writer = Some(writer);
            state.reader = Some(Source::File(Arc::new(reader)));
        }
        let end = state.end;
        let writer = state.writer.as_mut().unwrap();
        let written = frames.iter().try_fold(0u64, |count, bytes| {
            writer.write_all(&(bytes.len() as u64).to_le_bytes())?;
            writer.write_all(bytes)?;
            Ok::<_, io::Error>(count + 8 + bytes.len() as u64)
        });
        match written {
            Ok(count) => state.end += count,
            Err(error) => {
                if writer.set_len(end).is_err() {
                    state.poisoned = true;
                }
                return Err(storage_error(&self.path, error));
            }
        }
        for commit in commits {
            if let crate::SessionUpdate::Content {
                update:
                    crate::ContentUpdate::StoredRecord {
                        file,
                        lease: Some(lease),
                        ..
                    },
                ..
            } = &commit.update
            {
                state.records.insert(file.clone(), lease.clone());
            }
        }
        Ok(state.end)
    }
    // Only small authoritative target/status facts may use this emergency
    // path. A full disk must not turn a successful remote /new into a failure
    // or keep old messages under its new title. Agent reads/events still require
    // durable storage and fail visibly, without advancing their cursor.
    pub fn replacement_in_memory(
        root: &std::path::Path,
        commit: &SessionCommit,
    ) -> Result<(Arc<Self>, u64)> {
        assert!(matches!(commit.update, crate::SessionUpdate::Replaced(_)));
        let bytes = serde_json::to_vec(commit)?;
        let mut frame = Vec::with_capacity(bytes.len() + 8);
        frame.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        frame.extend_from_slice(&bytes);
        let end = frame.len() as u64;
        let segment = Arc::new(Self {
            path: root.join(uuid::Uuid::new_v4().to_string()),
            state: Mutex::new(SegmentState {
                records: HashMap::new(),
                writer: None,
                reader: Some(Source::Memory(frame.into())),
                end,
                poisoned: false,
                next: None,
            }),
        });
        Ok((segment, end))
    }
    pub fn end(&self) -> u64 {
        self.state.lock().unwrap().end
    }
    pub fn link(&self, next: Arc<Self>) {
        self.state.lock().unwrap().next = Some(next);
    }
    pub fn reader(self: &Arc<Self>, offset: u64) -> JournalReader {
        let state = self.state.lock().unwrap();
        JournalReader {
            segment: self.clone(),
            file: state.reader.clone(),
            watermark: state.end,
            offset,
        }
    }
}
impl Drop for Segment {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap();
        state.writer.take();
        state.reader.take();
        let _ = fs::remove_file(&self.path);
    }
}
pub(crate) struct JournalReader {
    segment: Arc<Segment>,
    file: Option<Source>,
    watermark: u64,
    offset: u64,
}
impl JournalReader {
    /// Locks only to copy an append waterline/descriptor or follow a checkpoint
    /// link. Disk reads, decoding and batch allocation all happen without it.
    pub fn try_batch(&mut self) -> Result<Vec<SessionCommit>> {
        let mut batch = Vec::new();
        let mut bytes = 0;
        loop {
            if self.offset == self.watermark {
                let (file, end, next) = {
                    let state = self.segment.state.lock().unwrap();
                    (state.reader.clone(), state.end, state.next.clone())
                };
                self.file = file;
                self.watermark = end;
                if self.offset == end {
                    if let Some(next) = next {
                        *self = next.reader(0);
                        continue;
                    }
                    break;
                }
            }
            let file = self
                .file
                .as_ref()
                .expect("published waterline has a reader");
            let mut header = [0; 8];
            read_exact_at(file, &mut header, self.offset)
                .map_err(|e| storage_error(&self.segment.path, e))?;
            let length = u64::from_le_bytes(header);
            if length > self.watermark.saturating_sub(self.offset + 8) {
                return Err(storage_error(
                    &self.segment.path,
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "incomplete committed journal frame",
                    ),
                ));
            }
            let length = usize::try_from(length).map_err(|_| {
                storage_error(
                    &self.segment.path,
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "journal frame does not fit address space",
                    ),
                )
            })?;
            if !batch.is_empty() && bytes + length > BATCH_BYTES {
                break;
            }
            let mut encoded = vec![0; length];
            read_exact_at(file, &mut encoded, self.offset + 8)
                .map_err(|e| storage_error(&self.segment.path, e))?;
            let mut commit: SessionCommit = serde_json::from_slice(&encoded).map_err(|e| {
                storage_error(
                    &self.segment.path,
                    io::Error::new(io::ErrorKind::InvalidData, e),
                )
            })?;
            if let crate::SessionUpdate::Content {
                update: crate::ContentUpdate::StoredRecord { file, lease, .. },
                ..
            } = &mut commit.update
            {
                *lease = self
                    .segment
                    .state
                    .lock()
                    .unwrap()
                    .records
                    .get(file)
                    .cloned();
            }
            self.offset += 8 + length as u64;
            bytes += length;
            batch.push(commit);
            if bytes >= BATCH_BYTES || batch.len() >= BATCH_COMMITS {
                break;
            }
        }
        Ok(batch)
    }
}
fn read_exact_at(source: &Source, mut buffer: &mut [u8], mut offset: u64) -> io::Result<()> {
    let file = match source {
        Source::File(file) => file,
        Source::Memory(bytes) => {
            let start = offset as usize;
            let range = bytes
                .get(start..start + buffer.len())
                .ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))?;
            buffer.copy_from_slice(range);
            return Ok(());
        }
    };
    while !buffer.is_empty() {
        #[cfg(unix)]
        let count = {
            use std::os::unix::fs::FileExt;
            file.read_at(buffer, offset)?
        };
        #[cfg(windows)]
        let count = {
            use std::os::windows::fs::FileExt;
            file.seek_read(buffer, offset)?
        };
        if count == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        offset += count as u64;
        buffer = &mut buffer[count..];
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::SessionUpdate;
    #[test]
    fn actual_enospc_is_storage_and_does_not_advance_the_read_waterline() {
        let root = std::env::temp_dir().join(format!("journal-full-{}", uuid::Uuid::new_v4()));
        let segment = Segment::new(&root);
        let commit = |revision| SessionCommit {
            revision,
            update: SessionUpdate::Status {
                state: "connected".into(),
                message: None,
            },
        };
        segment.append(&commit(1)).unwrap();
        let mut reader = segment.reader(0);
        // An actual ENOSPC writer; only this test's descriptor is replaced. No
        // filesystem mounts, process limits or production content are changed.
        segment.state.lock().unwrap().writer =
            Some(OpenOptions::new().write(true).open("/dev/full").unwrap());
        assert!(
            matches!(segment.append(&commit(2)),Err(crate::ClientError::Storage { source, .. }) if source.raw_os_error() == Some(28))
        );
        let accepted = reader.try_batch().unwrap();
        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].revision, 1);
        assert!(reader.try_batch().unwrap().is_empty());
        drop(reader);
        drop(segment);
        std::fs::remove_dir_all(root).unwrap();
    }
}
