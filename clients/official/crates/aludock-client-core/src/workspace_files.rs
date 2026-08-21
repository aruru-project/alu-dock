use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    ClientError, DockClient, Result,
    client::{ResponseEnvelope, maximum_line_bytes, response_result, validate_response_envelope},
    tls::{read_json_line, write_json_line},
    wire::decode_canonical_base64,
};

pub const MAX_WORKSPACE_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_WORKSPACE_FILE_CHUNK_BYTES: usize = 512 * 1024;
pub const MAX_WORKSPACE_ENTRY_LIST_ITEMS: usize = 200;
const MAX_WORKSPACE_PATH_CHARS: usize = 4_096;
const MAX_WORKSPACE_ENTRY_NAME_CHARS: usize = 1_024;
const MAX_WORKSPACE_REVISION_CHARS: usize = 128;
const MAX_INSTANCE_ID_CHARS: usize = 128;
const MAX_ERROR_MESSAGE_CHARS: usize = 2_048;
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const REQUIRED_CAPABILITIES: &[&str] = &["core.v2", "workspace.files.v1"];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceFileKind {
    File,
    Directory,
    Symlink,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceTargetKind {
    File,
    Directory,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileEntry {
    pub path: String,
    pub name: String,
    pub kind: WorkspaceFileKind,
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_kind: Option<WorkspaceTargetKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

impl WorkspaceFileEntry {
    pub fn validate(&self) -> Result<()> {
        let normalized = normalize_workspace_path(&self.path)?;
        if normalized != self.path
            || !safe_text(&self.name, MAX_WORKSPACE_ENTRY_NAME_CHARS)
            || self.name.contains('/')
            || self.name.contains('\\')
        {
            return Err(protocol("workspace file metadata was invalid"));
        }
        match (self.kind, self.target_kind, self.size_bytes) {
            (WorkspaceFileKind::File, None, Some(_)) => {}
            (WorkspaceFileKind::Directory, None, None) => {}
            (WorkspaceFileKind::Symlink, Some(WorkspaceTargetKind::File), Some(_)) => {}
            (
                WorkspaceFileKind::Symlink,
                Some(WorkspaceTargetKind::Directory | WorkspaceTargetKind::Unavailable),
                None,
            ) => {}
            _ => return Err(protocol("workspace file metadata shape was invalid")),
        }
        Ok(())
    }

    pub fn is_file(&self) -> bool {
        self.kind == WorkspaceFileKind::File || self.target_kind == Some(WorkspaceTargetKind::File)
    }

    pub fn is_directory(&self) -> bool {
        self.kind == WorkspaceFileKind::Directory
            || self.target_kind == Some(WorkspaceTargetKind::Directory)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileCursor {
    pub revision: String,
    pub offset: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFilePage {
    pub instance_id: String,
    pub path: String,
    pub revision: String,
    pub entries: Vec<WorkspaceFileEntry>,
    pub total: u64,
    pub truncated: bool,
    pub next_cursor: Option<WorkspaceFileCursor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_epoch: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileReadResult {
    pub entry: WorkspaceFileEntry,
    pub chunks: u64,
    pub size_bytes: u64,
    pub sha256: String,
    pub host_epoch: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkspaceFileReadProgress {
    pub bytes_received: u64,
    pub observed_size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntryListParams<'a> {
    instance_id: &'a str,
    path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a WorkspaceFileCursor>,
    limit: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntryParams<'a> {
    instance_id: &'a str,
    path: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileReadRequest<'a> {
    kind: &'static str,
    version: u8,
    request_id: &'a str,
    #[serde(rename = "type")]
    request_type: &'static str,
    params: WorkspaceEntryParams<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceEntryResult {
    instance_id: String,
    entry: WorkspaceFileEntry,
}

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum WorkspaceFileReadFrame {
    #[serde(rename = "workspace_file_read_ready")]
    Ready {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        path: String,
        entry: WorkspaceFileEntry,
    },
    #[serde(rename = "workspace_file_read_chunk")]
    Chunk {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        path: String,
        index: u64,
        data: String,
    },
    #[serde(rename = "workspace_file_read_complete")]
    Complete {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        path: String,
        chunks: u64,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        sha256: String,
    },
    #[serde(rename = "workspace_file_read_error")]
    Error {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        path: String,
        error: WorkspaceFileReadError,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceFileReadError {
    code: String,
    message: String,
}

impl DockClient {
    pub async fn list_workspace_entries(
        &self,
        instance_id: &str,
        path: &str,
        cursor: Option<&WorkspaceFileCursor>,
    ) -> Result<WorkspaceFilePage> {
        validate_instance_id(instance_id)?;
        let path = normalize_workspace_path(path)?;
        validate_cursor(cursor)?;
        let (mut page, host_epoch): (WorkspaceFilePage, String) = self
            .request_with_host_epoch(
                "workspace.entry.list",
                &WorkspaceEntryListParams {
                    instance_id,
                    path: &path,
                    cursor,
                    limit: MAX_WORKSPACE_ENTRY_LIST_ITEMS as u16,
                },
                REQUIRED_CAPABILITIES,
                None,
            )
            .await?;
        validate_page(&page, instance_id, &path, cursor)?;
        page.host_epoch = Some(host_epoch);
        Ok(page)
    }

    pub async fn get_workspace_entry(
        &self,
        instance_id: &str,
        path: &str,
    ) -> Result<(WorkspaceFileEntry, String)> {
        validate_instance_id(instance_id)?;
        let path = normalize_workspace_path(path)?;
        let (result, host_epoch): (WorkspaceEntryResult, String) = self
            .request_with_host_epoch(
                "workspace.entry.get",
                &WorkspaceEntryParams {
                    instance_id,
                    path: &path,
                },
                REQUIRED_CAPABILITIES,
                None,
            )
            .await?;
        result.entry.validate()?;
        if result.instance_id != instance_id || result.entry.path != path {
            return Err(protocol("workspace entry belonged to another request"));
        }
        Ok((result.entry, host_epoch))
    }

    /// Streams one workspace file into a caller-owned provisional sink. Dropping
    /// this future closes the dedicated read connection and cancels the transfer.
    pub async fn read_workspace_file<W, R, F>(
        &self,
        instance_id: &str,
        path: &str,
        sink: &mut W,
        mut validate_ready: R,
        mut on_progress: F,
    ) -> Result<WorkspaceFileReadResult>
    where
        W: AsyncWrite + Unpin,
        R: FnMut(&WorkspaceFileEntry) -> Result<()>,
        F: FnMut(WorkspaceFileReadProgress),
    {
        validate_instance_id(instance_id)?;
        let path = normalize_workspace_path(path)?;
        let (mut connection, hello) = self.negotiate(REQUIRED_CAPABILITIES).await?;
        let request_id = Uuid::new_v4().to_string();
        write_json_line(
            &mut connection.stream,
            &WorkspaceFileReadRequest {
                kind: "request",
                version: 2,
                request_id: &request_id,
                request_type: "workspace.file.read",
                params: WorkspaceEntryParams {
                    instance_id,
                    path: &path,
                },
            },
        )
        .await?;
        read_after_request(
            &mut connection.stream,
            sink,
            maximum_line_bytes(&hello),
            &request_id,
            &hello.host.host_epoch,
            instance_id,
            &path,
            &mut validate_ready,
            &mut on_progress,
        )
        .await
    }
}

fn validate_page(
    page: &WorkspaceFilePage,
    instance_id: &str,
    path: &str,
    cursor: Option<&WorkspaceFileCursor>,
) -> Result<()> {
    if page.instance_id != instance_id
        || page.path != path
        || !safe_text(&page.revision, MAX_WORKSPACE_REVISION_CHARS)
        || page.entries.len() > MAX_WORKSPACE_ENTRY_LIST_ITEMS
        || page.entries.len() as u64 > page.total
        || page.truncated != page.next_cursor.is_some()
        || page.host_epoch.is_some()
        || cursor.is_some_and(|value| value.revision != page.revision)
    {
        return Err(protocol("workspace directory page was inconsistent"));
    }
    if page.entries.iter().any(|entry| entry.validate().is_err()) {
        return Err(protocol("workspace directory contained invalid metadata"));
    }
    validate_cursor(page.next_cursor.as_ref())?;
    if page.next_cursor.as_ref().is_some_and(|next| {
        next.revision != page.revision
            || cursor.is_some_and(|current| next.offset <= current.offset)
    }) {
        return Err(protocol(
            "workspace directory continuation was inconsistent",
        ));
    }
    Ok(())
}

fn validate_cursor(cursor: Option<&WorkspaceFileCursor>) -> Result<()> {
    if cursor.is_some_and(|value| {
        !safe_text(&value.revision, MAX_WORKSPACE_REVISION_CHARS)
            || (value.offset == 0 && value.revision.is_empty())
    }) {
        return Err(protocol("workspace directory cursor was invalid"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn read_after_request<S, W, R, F>(
    stream: &mut S,
    sink: &mut W,
    maximum_line_bytes: usize,
    request_id: &str,
    host_epoch: &str,
    instance_id: &str,
    path: &str,
    validate_ready: &mut R,
    on_progress: &mut F,
) -> Result<WorkspaceFileReadResult>
where
    S: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    R: FnMut(&WorkspaceFileEntry) -> Result<()>,
    F: FnMut(WorkspaceFileReadProgress),
{
    let first: Value = read_workspace_line(stream, maximum_line_bytes).await?;
    if first.get("kind").and_then(Value::as_str) == Some("response") {
        let response: ResponseEnvelope = serde_json::from_value(first)?;
        validate_response_envelope(&response, request_id, host_epoch)?;
        let _: Value = response_result(response, "workspace.file.read", None)?;
        return Err(protocol(
            "workspace file read returned an ordinary success response",
        ));
    }
    let entry = match parse_frame(first, request_id, host_epoch, instance_id, path)? {
        WorkspaceFileReadFrame::Ready { entry, .. }
            if entry.path == path && entry.is_file() && entry.size_bytes.is_some() =>
        {
            entry
        }
        _ => {
            return Err(protocol(
                "workspace file read did not begin with file metadata",
            ));
        }
    };
    entry.validate()?;
    let observed_size_bytes = entry.size_bytes.unwrap_or_default();
    if observed_size_bytes > MAX_WORKSPACE_FILE_BYTES {
        return Err(protocol(
            "workspace file readiness exceeded its transfer bound",
        ));
    }
    validate_ready(&entry)?;
    let mut digest = Sha256::new();
    let mut chunks = 0_u64;
    let mut size_bytes = 0_u64;
    on_progress(WorkspaceFileReadProgress {
        bytes_received: 0,
        observed_size_bytes,
    });

    loop {
        let raw: Value = read_workspace_line(stream, maximum_line_bytes).await?;
        if raw.get("kind").and_then(Value::as_str) == Some("response") {
            return Err(protocol(
                "workspace file read returned an ordinary response after readiness",
            ));
        }
        match parse_frame(raw, request_id, host_epoch, instance_id, path)? {
            WorkspaceFileReadFrame::Ready { .. } => {
                return Err(protocol("Host repeated workspace file readiness"));
            }
            WorkspaceFileReadFrame::Error { error, .. } => return Err(read_error(error)),
            WorkspaceFileReadFrame::Chunk { index, data, .. } => {
                if index != chunks {
                    return Err(protocol("workspace file chunks arrived out of order"));
                }
                let bytes = decode_canonical_base64(
                    &data,
                    MAX_WORKSPACE_FILE_CHUNK_BYTES,
                    "workspace file data",
                )?;
                if bytes.is_empty() {
                    return Err(protocol("workspace file contained an empty chunk"));
                }
                size_bytes = size_bytes
                    .checked_add(bytes.len() as u64)
                    .ok_or_else(|| protocol("workspace file size overflowed"))?;
                if size_bytes > MAX_WORKSPACE_FILE_BYTES {
                    return Err(protocol("workspace file exceeded its transfer bound"));
                }
                sink.write_all(&bytes).await?;
                digest.update(&bytes);
                chunks += 1;
                on_progress(WorkspaceFileReadProgress {
                    bytes_received: size_bytes,
                    observed_size_bytes,
                });
            }
            WorkspaceFileReadFrame::Complete {
                chunks: terminal_chunks,
                size_bytes: terminal_size,
                sha256,
                ..
            } => {
                if terminal_chunks != chunks
                    || terminal_size != size_bytes
                    || terminal_size > MAX_WORKSPACE_FILE_BYTES
                    || !lowercase_sha256(&sha256)
                {
                    return Err(protocol("workspace file completion was inconsistent"));
                }
                let actual_digest = hex::encode(digest.finalize());
                if sha256 != actual_digest {
                    return Err(protocol("workspace file SHA-256 verification failed"));
                }
                sink.flush().await?;
                require_clean_end(stream).await?;
                return Ok(WorkspaceFileReadResult {
                    entry,
                    chunks,
                    size_bytes,
                    sha256: actual_digest,
                    host_epoch: host_epoch.into(),
                });
            }
        }
    }
}

async fn read_workspace_line<T, R>(stream: &mut R, maximum_line_bytes: usize) -> Result<T>
where
    T: serde::de::DeserializeOwned,
    R: AsyncRead + Unpin,
{
    timeout(
        READ_IDLE_TIMEOUT,
        read_json_line(stream, maximum_line_bytes),
    )
    .await
    .map_err(|_| protocol("workspace file read timed out"))?
}

async fn require_clean_end<R: AsyncRead + Unpin>(stream: &mut R) -> Result<()> {
    let mut trailing = [0_u8; 1];
    let read = timeout(READ_IDLE_TIMEOUT, stream.read(&mut trailing))
        .await
        .map_err(|_| protocol("workspace file read timed out before completion closed"))??;
    if read != 0 {
        return Err(protocol("workspace file read sent data after completion"));
    }
    Ok(())
}

fn parse_frame(
    raw: Value,
    request_id: &str,
    host_epoch: &str,
    instance_id: &str,
    path: &str,
) -> Result<WorkspaceFileReadFrame> {
    let frame: WorkspaceFileReadFrame = serde_json::from_value(raw)
        .map_err(|error| protocol(format!("invalid workspace file frame: {error}")))?;
    let (version, frame_request, frame_epoch, frame_instance, frame_path) = match &frame {
        WorkspaceFileReadFrame::Ready {
            version,
            request_id,
            host_epoch,
            instance_id,
            path,
            ..
        }
        | WorkspaceFileReadFrame::Chunk {
            version,
            request_id,
            host_epoch,
            instance_id,
            path,
            ..
        }
        | WorkspaceFileReadFrame::Complete {
            version,
            request_id,
            host_epoch,
            instance_id,
            path,
            ..
        }
        | WorkspaceFileReadFrame::Error {
            version,
            request_id,
            host_epoch,
            instance_id,
            path,
            ..
        } => (*version, request_id, host_epoch, instance_id, path),
    };
    if version != 2
        || frame_request != request_id
        || frame_epoch != host_epoch
        || frame_instance != instance_id
        || frame_path != path
    {
        return Err(protocol("workspace file frame belonged to another request"));
    }
    Ok(frame)
}

fn read_error(error: WorkspaceFileReadError) -> ClientError {
    if !matches!(
        error.code.as_str(),
        "workspace_entry_unavailable" | "workspace_file_too_large"
    ) || !safe_text(&error.message, MAX_ERROR_MESSAGE_CHARS)
    {
        return protocol("workspace file read returned an invalid error");
    }
    ClientError::Host {
        code: error.code,
        message: error.message,
        retryable: false,
        details: None,
    }
}

pub fn normalize_workspace_path(path: &str) -> Result<String> {
    if path.is_empty()
        || path.chars().count() > MAX_WORKSPACE_PATH_CHARS
        || path.contains('\0')
        || path.starts_with('/')
    {
        return Err(protocol("workspace path was outside the current Work"));
    }
    let parts = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| *part == ".." || part.chars().any(char::is_control))
    {
        return Err(protocol("workspace path was outside the current Work"));
    }
    Ok(if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    })
}

fn validate_instance_id(value: &str) -> Result<()> {
    if !safe_text(value, MAX_INSTANCE_ID_CHARS) {
        return Err(protocol("workspace request identity was invalid"));
    }
    Ok(())
}

fn safe_text(value: &str, maximum_chars: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum_chars
        && !value.chars().any(char::is_control)
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn protocol(message: impl Into<String>) -> ClientError {
    ClientError::Protocol(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncWriteExt, duplex};

    #[tokio::test]
    async fn opening_a_workspace_file_accepts_the_exact_bytes_observed_during_the_read() {
        let (mut client, mut host) = duplex(16 * 1024);
        let host_task = tokio::spawn(async move {
            for frame in [
                json!({
                    "kind": "workspace_file_read_ready",
                    "version": 2,
                    "requestId": "request",
                    "hostEpoch": "epoch",
                    "instanceId": "work",
                    "path": "changing.txt",
                    "entry": { "path": "changing.txt", "name": "changing.txt", "kind": "file", "hidden": false, "sizeBytes": 2 }
                }),
                json!({
                    "kind": "workspace_file_read_chunk",
                    "version": 2,
                    "requestId": "request",
                    "hostEpoch": "epoch",
                    "instanceId": "work",
                    "path": "changing.txt",
                    "index": 0,
                    "data": "YWJj"
                }),
                json!({
                    "kind": "workspace_file_read_complete",
                    "version": 2,
                    "requestId": "request",
                    "hostEpoch": "epoch",
                    "instanceId": "work",
                    "path": "changing.txt",
                    "chunks": 1,
                    "sizeBytes": 3,
                    "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                }),
            ] {
                write_json_line(&mut host, &frame).await.unwrap();
            }
            host.shutdown().await.unwrap();
        });
        let mut bytes = Vec::new();
        let result = read_after_request(
            &mut client,
            &mut bytes,
            1024 * 1024,
            "request",
            "epoch",
            "work",
            "changing.txt",
            &mut |_| Ok(()),
            &mut |_| {},
        )
        .await
        .unwrap();
        host_task.await.unwrap();

        assert_eq!(bytes, b"abc");
        assert_eq!(result.size_bytes, 3);
        assert_eq!(result.entry.size_bytes, Some(2));
    }

    #[tokio::test]
    async fn readiness_policy_can_stop_a_grown_file_before_any_chunk_is_written() {
        let (mut client, mut host) = duplex(4 * 1024);
        let host_task = tokio::spawn(async move {
            write_json_line(
                &mut host,
                &json!({
                    "kind": "workspace_file_read_ready",
                    "version": 2,
                    "requestId": "request",
                    "hostEpoch": "epoch",
                    "instanceId": "work",
                    "path": "grown.txt",
                    "entry": { "path": "grown.txt", "name": "grown.txt", "kind": "file", "hidden": false, "sizeBytes": 11 * 1024 * 1024 }
                }),
            )
            .await
            .unwrap();
            host.shutdown().await.unwrap();
        });
        let mut bytes = Vec::new();
        let error = read_after_request(
            &mut client,
            &mut bytes,
            1024 * 1024,
            "request",
            "epoch",
            "work",
            "grown.txt",
            &mut |_| Err(ClientError::Protocol("confirmation required".into())),
            &mut |_| {},
        )
        .await
        .unwrap_err();
        host_task.await.unwrap();

        assert!(
            matches!(error, ClientError::Protocol(message) if message == "confirmation required")
        );
        assert!(bytes.is_empty());
    }
}
