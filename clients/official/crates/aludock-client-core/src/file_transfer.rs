//! Integrity bookkeeping for streamed files, not a wire-protocol receiver.
//! Readiness, identity, sink errors and protocol-specific completion stay with callers.
use sha2::{Digest, Sha256};

use crate::{ClientError, Result, wire::decode_canonical_base64};

// Mirrors src/core/source-file.ts: only workspace reads and temporary deliveries
// share this producer. Conversation images and published files have other bounds.
pub const MAX_SOURCE_FILE_TRANSFER_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES: usize = 512 * 1024;

pub(crate) struct FileTransfer {
    subject: &'static str,
    maximum_bytes: u64,
    chunks: u64,
    size_bytes: u64,
    digest: Sha256,
}

pub(crate) struct FileTransferSummary {
    pub chunks: u64,
    pub size_bytes: u64,
    pub sha256: String,
}

impl FileTransfer {
    pub fn new(maximum_bytes: u64, subject: &'static str) -> Self {
        Self {
            subject,
            maximum_bytes,
            chunks: 0,
            size_bytes: 0,
            digest: Sha256::new(),
        }
    }

    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    /// Validate before handing the chunk to a provisional sink. Any later sink
    /// failure aborts the caller's transfer; these counters are never published.
    pub fn decode_chunk(
        &mut self,
        index: u64,
        data: &str,
        maximum_chunk: usize,
    ) -> Result<Vec<u8>> {
        if index != self.chunks {
            return Err(self.error("chunks arrived out of order"));
        }
        let bytes =
            decode_canonical_base64(data, maximum_chunk, &format!("{} data", self.subject))?;
        let size_bytes = self
            .size_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| self.error("size overflowed"))?;
        if size_bytes > self.maximum_bytes {
            return Err(self.error("bytes exceeded the transfer size"));
        }
        self.digest.update(&bytes);
        self.size_bytes = size_bytes;
        self.chunks += 1;
        Ok(bytes)
    }

    pub fn finish(self, chunks: u64, size_bytes: u64, sha256: &str) -> Result<FileTransferSummary> {
        if chunks != self.chunks || size_bytes != self.size_bytes || !lowercase_sha256(sha256) {
            return Err(self.error("completion counts or digest were invalid"));
        }
        let actual = hex::encode(self.digest.finalize());
        if actual != sha256 {
            return Err(ClientError::Protocol(format!(
                "{} SHA-256 verification failed",
                self.subject
            )));
        }
        Ok(FileTransferSummary {
            chunks,
            size_bytes,
            sha256: actual,
        })
    }

    fn error(&self, detail: &str) -> ClientError {
        ClientError::Protocol(format!("{} {detail}", self.subject))
    }
}

pub(crate) fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
