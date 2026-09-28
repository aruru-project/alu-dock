use std::{
    future::Future,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    fs::File,
    io::{AsyncBufRead, AsyncReadExt, AsyncWrite},
    sync::Notify,
};
use uuid::Uuid;

use crate::{
    ClientError, DockClient, Result,
    capabilities::ATTACHMENTS as REQUIRED_CAPABILITIES,
    client::{ResponseEnvelope, maximum_line_bytes, response_result, validate_response_envelope},
    timing::LONG_MUTATION_RESPONSE_TIMEOUT,
    tls::{read_json_line, write_json_line},
    wire::MAX_CONTROL_BASE64_CHUNK_BYTES,
};

pub const MAX_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ATTACHMENT_NAME_CHARS: usize = 1_024;
const MAX_ATTACHMENT_MEDIA_TYPE_CHARS: usize = 512;
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 32;
const HASH_BUFFER_BYTES: usize = 64 * 1024;

/// Canonical, path-free attachment metadata returned by the Host.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    pub file_id: String,
    pub name: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    pub sha256: String,
    pub stored_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentDtoWire {
    file_id: String,
    name: String,
    size_bytes: u64,
    media_type: Option<String>,
    sha256: String,
    stored_at: String,
}

impl<'de> Deserialize<'de> for AttachmentDto {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = AttachmentDtoWire::deserialize(deserializer)?;
        validate_attachment_dto(&value).map_err(D::Error::custom)?;
        Ok(Self {
            file_id: value.file_id,
            name: value.name,
            size_bytes: value.size_bytes,
            media_type: value.media_type,
            sha256: value.sha256,
            stored_at: value.stored_at,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentUploadStatus {
    Stored,
    Reused,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AttachmentUploadResult {
    pub attachment: AttachmentDto,
    pub status: AttachmentUploadStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentUploadPhase {
    Hashing,
    Uploading,
    Finalizing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadProgress {
    pub phase: AttachmentUploadPhase,
    pub bytes_processed: u64,
    pub total_bytes: u64,
}

/// Cooperative, process-local cancellation. Cancelling before the completion
/// frame closes the upload without publishing an attachment.
#[derive(Debug, Default)]
struct AttachmentUploadCancellationState {
    cancelled: AtomicBool,
    notification: Notify,
}

#[derive(Clone, Debug, Default)]
pub struct AttachmentUploadCancellation {
    state: Arc<AttachmentUploadCancellationState>,
}

impl AttachmentUploadCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.state.cancelled.store(true, Ordering::Release);
        self.state.notification.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        let notified = self.state.notification.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.is_cancelled() {
            notified.await;
        }
    }
}

#[derive(Clone)]
struct PreparedFile {
    size_bytes: u64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadRequest<'a> {
    kind: &'static str,
    version: u8,
    request_id: &'a str,
    #[serde(rename = "type")]
    request_type: &'static str,
    params: UploadParams<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    name: &'a str,
    size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_type: Option<&'a str>,
    sha256: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadReady {
    kind: String,
    version: u8,
    request_id: String,
    host_epoch: String,
    max_chunk_bytes: u64,
}

impl DockClient {
    /// Pre-hashes and uploads one regular file over a fresh exact-pinned mTLS
    /// connection. The operation ID is caller-owned. This is an upload, not a read-only
    /// query: reconnecting callers must retain the result rather than replay it.
    pub async fn upload_attachment_file<F>(
        &self,
        path: impl AsRef<Path>,
        operation_id: &str,
        instance_id: &str,
        name: &str,
        media_type: Option<&str>,
        cancellation: &AttachmentUploadCancellation,
        mut on_progress: F,
    ) -> Result<AttachmentUploadResult>
    where
        F: FnMut(AttachmentUploadProgress),
    {
        validate_header_fields(operation_id, instance_id, name, media_type)?;
        let path = path.as_ref();
        let prepared = prehash_file(path, cancellation, &mut on_progress).await?;

        for file_mode in [true, false] {
            let mut capabilities = REQUIRED_CAPABILITIES.to_vec();
            if file_mode {
                capabilities.push(crate::file_transfer::FILE_TRANSFER_CAPABILITY);
            }
            let routed =
                match wait_before_completion(cancellation, self.negotiate(&capabilities)).await {
                    Ok(routed) => routed,
                    Err(error)
                        if file_mode && crate::file_transfer::missing_file_capability(&error) =>
                    {
                        continue;
                    }
                    Err(error) => return Err(error),
                };
            let endpoint_id = routed.endpoint_id;
            let route_generation = routed.route_generation;
            let mut connection = routed.connection;
            let hello = routed.hello;
            let request_id = Uuid::new_v4().to_string();
            if let Err(error) = wait_before_completion(
                cancellation,
                write_json_line(
                    &mut connection.stream,
                    &UploadRequest {
                        kind: "request",
                        version: 2,
                        request_id: &request_id,
                        request_type: "attachment.upload",
                        params: UploadParams {
                            operation_id,
                            instance_id,
                            name,
                            size_bytes: prepared.size_bytes,
                            media_type,
                            sha256: &prepared.sha256,
                        },
                    },
                ),
            )
            .await
            {
                self.router()
                    .report_connection_failure(&endpoint_id, route_generation);
                return Err(error);
            }

            let mut body_started = false;
            let result = upload_after_header(
                &mut connection.stream,
                path,
                &request_id,
                &hello.host.host_epoch,
                maximum_line_bytes(&hello),
                operation_id,
                &prepared,
                cancellation,
                &mut on_progress,
                &mut body_started,
                file_mode,
            )
            .await;
            if result.is_err() {
                self.router()
                    .report_connection_failure(&endpoint_id, route_generation);
            }
            // Only an explicit refusal before readiness may retry using old records.
            if file_mode
                && !body_started
                && result
                    .as_ref()
                    .err()
                    .is_some_and(crate::file_transfer::missing_file_capability)
            {
                continue;
            }
            return result;
        }
        unreachable!("legacy attempt returns")
    }
}

async fn prehash_file<F>(
    path: &Path,
    cancellation: &AttachmentUploadCancellation,
    on_progress: &mut F,
) -> Result<PreparedFile>
where
    F: FnMut(AttachmentUploadProgress),
{
    let metadata = wait_before_completion(cancellation, async {
        Ok(tokio::fs::symlink_metadata(path).await?)
    })
    .await?;
    if !metadata.file_type().is_file() {
        return Err(ClientError::Protocol(
            "attachment source must be a regular file".into(),
        ));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(ClientError::AttachmentTooLarge {
            size_bytes: metadata.len(),
            maximum_bytes: MAX_ATTACHMENT_BYTES,
        });
    }

    let mut file =
        wait_before_completion(cancellation, async { Ok(File::open(path).await?) }).await?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut count = 0_u64;
    on_progress(AttachmentUploadProgress {
        phase: AttachmentUploadPhase::Hashing,
        bytes_processed: 0,
        total_bytes: metadata.len(),
    });
    loop {
        let read =
            wait_before_completion(cancellation, async { Ok(file.read(&mut buffer).await?) })
                .await?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .ok_or(ClientError::AttachmentTooLarge {
                size_bytes: u64::MAX,
                maximum_bytes: MAX_ATTACHMENT_BYTES,
            })?;
        if count > MAX_ATTACHMENT_BYTES {
            return Err(ClientError::AttachmentTooLarge {
                size_bytes: count,
                maximum_bytes: MAX_ATTACHMENT_BYTES,
            });
        }
        digest.update(&buffer[..read]);
        on_progress(AttachmentUploadProgress {
            phase: AttachmentUploadPhase::Hashing,
            bytes_processed: count,
            total_bytes: metadata.len(),
        });
    }
    if count != metadata.len() {
        return Err(ClientError::AttachmentSourceChanged);
    }
    Ok(PreparedFile {
        size_bytes: count,
        sha256: hex::encode(digest.finalize()),
    })
}

#[allow(clippy::too_many_arguments)]
async fn upload_after_header<S, F>(
    stream: &mut S,
    path: &Path,
    request_id: &str,
    host_epoch: &str,
    maximum_line_bytes: usize,
    operation_id: &str,
    prepared: &PreparedFile,
    cancellation: &AttachmentUploadCancellation,
    on_progress: &mut F,
    body_started: &mut bool,
    file_mode: bool,
) -> Result<AttachmentUploadResult>
where
    S: AsyncBufRead + AsyncWrite + Unpin,
    F: FnMut(AttachmentUploadProgress),
{
    let first: Value =
        wait_for_host_before_completion(cancellation, read_json_line(stream, maximum_line_bytes))
            .await?;
    let kind = first.get("kind").and_then(Value::as_str);
    if kind == Some("response") {
        return terminal_result(first, request_id, host_epoch, operation_id, prepared, true);
    }
    if kind
        != Some(if file_mode {
            "file_ready"
        } else {
            "attachment_upload_ready"
        })
    {
        return Err(ClientError::Protocol(
            "Upload readiness differs from negotiated framing".into(),
        ));
    }
    if file_mode && first.get("direction").and_then(Value::as_str) != Some("upload") {
        return Err(ClientError::Protocol(
            "File readiness has wrong direction".into(),
        ));
    }
    let window = if file_mode {
        first.get("windowBytes").and_then(Value::as_u64)
    } else {
        None
    };

    let ready: UploadReady = serde_json::from_value(first)?;
    if (ready.kind != "attachment_upload_ready" && ready.kind != "file_ready")
        || (file_mode
            && window.is_none_or(|value| {
                value < ready.max_chunk_bytes || value > crate::file_transfer::FILE_WINDOW_BYTES
            }))
        || ready.version != 2
        || ready.request_id != request_id
        || ready.host_epoch != host_epoch
        || ready.max_chunk_bytes == 0
        || ready.max_chunk_bytes > MAX_CONTROL_BASE64_CHUNK_BYTES as u64
    {
        return Err(ClientError::Protocol(
            "attachment readiness correlation or limits were invalid".into(),
        ));
    }
    *body_started = true;
    check_cancelled(cancellation)?;

    let metadata = wait_before_completion(cancellation, async {
        Ok(tokio::fs::symlink_metadata(path).await?)
    })
    .await?;
    if !metadata.file_type().is_file() {
        return Err(ClientError::AttachmentSourceChanged);
    }
    let line_limited_chunk = maximum_line_bytes.saturating_sub(256) / 4 * 3;
    let chunk_bytes = usize::try_from(ready.max_chunk_bytes)
        .unwrap_or(usize::MAX)
        .min(line_limited_chunk);
    if chunk_bytes == 0 {
        return Err(ClientError::Protocol(
            "negotiated line limit cannot carry an attachment chunk".into(),
        ));
    }

    let mut file =
        wait_before_completion(cancellation, async { Ok(File::open(path).await?) }).await?;
    on_progress(AttachmentUploadProgress {
        phase: AttachmentUploadPhase::Uploading,
        bytes_processed: 0,
        total_bytes: prepared.size_bytes,
    });
    let summary = wait_before_completion(
        cancellation,
        crate::file_transfer::send_file(
            stream,
            &mut file,
            request_id,
            host_epoch,
            maximum_line_bytes,
            chunk_bytes,
            window,
            prepared.size_bytes,
            &prepared.sha256,
            &mut |bytes_processed| {
                on_progress(AttachmentUploadProgress {
                    phase: AttachmentUploadPhase::Uploading,
                    bytes_processed,
                    total_bytes: prepared.size_bytes,
                })
            },
        ),
    )
    .await?;
    let count = summary.size_bytes;
    check_cancelled(cancellation)?;

    let complete = if file_mode {
        serde_json::json!({"kind":"file_complete","version":2,"requestId":request_id,"hostEpoch":host_epoch,"chunks":summary.chunks,"sizeBytes":summary.size_bytes,"sha256":summary.sha256})
    } else {
        serde_json::json!({"kind":"attachment_complete","version":2,"requestId":request_id,"chunks":summary.chunks})
    };
    wait_after_completion_started(cancellation, operation_id, async {
        if file_mode {
            crate::file_io::write_file_record(
                stream,
                &complete,
                &crate::file_io::FileActivity::new(),
            )
            .await
        } else {
            write_json_line(stream, &complete).await
        }
    })
    .await?;
    on_progress(AttachmentUploadProgress {
        phase: AttachmentUploadPhase::Finalizing,
        bytes_processed: count,
        total_bytes: prepared.size_bytes,
    });

    let terminal: Value =
        wait_for_host_after_completion_started(cancellation, operation_id, async {
            if file_mode {
                crate::file_transfer::read_file_receipt(
                    stream,
                    maximum_line_bytes,
                    request_id,
                    host_epoch,
                    prepared.size_bytes,
                )
                .await
            } else {
                read_json_line(stream, maximum_line_bytes).await
            }
        })
        .await?;
    terminal_result(
        terminal,
        request_id,
        host_epoch,
        operation_id,
        prepared,
        true,
    )
}

fn terminal_result(
    value: Value,
    request_id: &str,
    host_epoch: &str,
    operation_id: &str,
    prepared: &PreparedFile,
    uncertain_on_invalid: bool,
) -> Result<AttachmentUploadResult> {
    let response: ResponseEnvelope = serde_json::from_value(value).map_err(|error| {
        let error = ClientError::Json(error);
        if uncertain_on_invalid {
            effect_unknown(operation_id, error)
        } else {
            error
        }
    })?;
    validate_response_envelope(&response, request_id, host_epoch).map_err(|error| {
        if uncertain_on_invalid {
            effect_unknown(operation_id, error)
        } else {
            error
        }
    })?;
    let result: AttachmentUploadResult =
        response_result(response, "attachment.upload", Some(operation_id))?;
    if result.attachment.size_bytes != prepared.size_bytes
        || result.attachment.sha256 != prepared.sha256
    {
        return Err(effect_unknown(
            operation_id,
            ClientError::Protocol(
                "attachment receipt size or digest did not match the uploaded file".into(),
            ),
        ));
    }
    Ok(result)
}

async fn wait_for_host_before_completion<T>(
    cancellation: &AttachmentUploadCancellation,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    wait_before_completion(cancellation, async {
        match tokio::time::timeout(LONG_MUTATION_RESPONSE_TIMEOUT, future).await {
            Ok(result) => result,
            Err(_) => Err(ClientError::Protocol(
                "attachment upload response timed out".into(),
            )),
        }
    })
    .await
}

async fn wait_for_host_after_completion_started<T>(
    cancellation: &AttachmentUploadCancellation,
    operation_id: &str,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    wait_after_completion_started(cancellation, operation_id, async {
        match tokio::time::timeout(LONG_MUTATION_RESPONSE_TIMEOUT, future).await {
            Ok(result) => result,
            Err(_) => Err(ClientError::Protocol(
                "attachment upload response timed out".into(),
            )),
        }
    })
    .await
}

async fn wait_before_completion<T>(
    cancellation: &AttachmentUploadCancellation,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(ClientError::AttachmentUploadCancelled),
        result = future => result,
    }
}

async fn wait_after_completion_started<T>(
    cancellation: &AttachmentUploadCancellation,
    operation_id: &str,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(effect_unknown(
            operation_id,
            ClientError::AttachmentUploadCancelled,
        )),
        result = future => result.map_err(|error| effect_unknown(operation_id, error)),
    }
}

fn validate_attachment_dto(value: &AttachmentDtoWire) -> std::result::Result<(), &'static str> {
    if !canonical_attachment_uuid(&value.file_id) {
        return Err("attachment fileId must be a lowercase version-4 UUID");
    }
    if value.name.is_empty()
        || value.name.chars().count() > MAX_ATTACHMENT_NAME_CHARS
        || value
            .name
            .chars()
            .any(|character| matches!(character, '/' | '\\') || wire_control(character))
    {
        return Err("attachment name must be a bounded safe display name");
    }
    if value.size_bytes > MAX_ATTACHMENT_BYTES {
        return Err("attachment sizeBytes exceeds the attachment limit");
    }
    if value.media_type.as_ref().is_some_and(|media_type| {
        media_type.is_empty()
            || media_type.chars().count() > MAX_ATTACHMENT_MEDIA_TYPE_CHARS
            || media_type.chars().any(wire_control)
    }) {
        return Err("attachment mediaType must be nonempty, bounded, and control-free");
    }
    if value.sha256.len() != 64
        || !value
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("attachment sha256 must be 64 lowercase hexadecimal characters");
    }
    if value.stored_at.len() != 24
        || !value.stored_at.ends_with('Z')
        || value.stored_at.as_bytes().get(19) != Some(&b'.')
        || OffsetDateTime::parse(&value.stored_at, &Rfc3339).is_err()
    {
        return Err("attachment storedAt must be a canonical ISO-8601 UTC timestamp");
    }
    Ok(())
}

fn canonical_attachment_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn wire_control(character: char) -> bool {
    matches!(character as u32, 0x00..=0x1f | 0x7f..=0x9f)
}

fn validate_header_fields(
    operation_id: &str,
    instance_id: &str,
    name: &str,
    media_type: Option<&str>,
) -> Result<()> {
    if !safe_wire_text(operation_id, 128) {
        return Err(ClientError::Protocol(
            "attachment operation ID must be non-empty, control-free, and at most 128 characters"
                .into(),
        ));
    }
    if !safe_wire_text(instance_id, 512) {
        return Err(ClientError::Protocol(
            "attachment instance ID must be non-empty, control-free, and at most 512 characters"
                .into(),
        ));
    }
    if !safe_wire_text(name, 1024) {
        return Err(ClientError::Protocol(
            "attachment name must be non-empty, control-free, and at most 1024 characters".into(),
        ));
    }
    if media_type.is_some_and(|value| !safe_wire_text(value, 512)) {
        return Err(ClientError::Protocol(
            "attachment media type must be control-free and at most 512 characters".into(),
        ));
    }
    Ok(())
}

fn safe_wire_text(value: &str, maximum_chars: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum_chars
        && !value.chars().any(char::is_control)
}

fn check_cancelled(cancellation: &AttachmentUploadCancellation) -> Result<()> {
    if cancellation.is_cancelled() {
        Err(ClientError::AttachmentUploadCancelled)
    } else {
        Ok(())
    }
}

fn effect_unknown(operation_id: &str, error: ClientError) -> ClientError {
    ClientError::EffectUnknown {
        operation_id: operation_id.to_owned(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
    use serde_json::json;
    use tokio::io::duplex;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "aludock-attachment-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, bytes).expect("test file");
        path
    }

    fn terminal(request_id: &str, sha256: &str, size_bytes: u64) -> Value {
        json!({
            "kind": "response",
            "version": 2,
            "requestId": request_id,
            "hostEpoch": "epoch",
            "ok": true,
            "result": {
                "attachment": {
                    "fileId": "123e4567-e89b-42d3-a456-426614174000",
                    "name": "host-name.txt",
                    "sizeBytes": size_bytes,
                    "mediaType": "text/plain",
                    "sha256": sha256,
                    "storedAt": "2026-08-16T00:00:00.000Z"
                },
                "status": "stored"
            }
        })
    }

    #[test]
    fn upload_header_is_closed_and_path_free() {
        let value = serde_json::to_value(UploadRequest {
            kind: "request",
            version: 2,
            request_id: "request",
            request_type: "attachment.upload",
            params: UploadParams {
                operation_id: "operation",
                instance_id: "remote-work",
                name: "display.txt",
                size_bytes: 3,
                media_type: None,
                sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
        })
        .unwrap();
        assert_eq!(value["type"], "attachment.upload");
        assert_eq!(value["params"]["instanceId"], "remote-work");
        assert_eq!(value["params"]["name"], "display.txt");
        assert!(value["params"].get("path").is_none());
        assert!(value["params"].get("mediaType").is_none());
    }

    #[tokio::test]
    async fn readiness_streams_sequential_canonical_chunks_and_completion() {
        let path = temp_file("chunks", b"abcdef");
        let cancellation = AttachmentUploadCancellation::new();
        let mut ignored = |_| {};
        let prepared = prehash_file(&path, &cancellation, &mut ignored)
            .await
            .unwrap();
        let (client, host) = duplex(16 * 1024);
        let mut client = tokio::io::BufReader::new(client);
        let mut host = tokio::io::BufReader::new(host);
        let digest = prepared.sha256.clone();
        let host_task = tokio::spawn(async move {
            write_json_line(
                &mut host,
                &json!({
                    "kind": "attachment_upload_ready",
                    "version": 2,
                    "requestId": "request",
                    "hostEpoch": "epoch",
                    "maxChunkBytes": 2
                }),
            )
            .await
            .unwrap();
            for (index, bytes) in [b"ab", b"cd", b"ef"].into_iter().enumerate() {
                let line: Value = read_json_line(&mut host, 4096).await.unwrap();
                assert_eq!(line["kind"], "attachment_chunk");
                assert_eq!(line["index"], index as u64);
                assert_eq!(
                    BASE64_STANDARD
                        .decode(line["data"].as_str().unwrap())
                        .unwrap(),
                    bytes
                );
            }
            let complete: Value = read_json_line(&mut host, 4096).await.unwrap();
            assert_eq!(complete["kind"], "attachment_complete");
            assert_eq!(complete["chunks"], 3);
            write_json_line(&mut host, &terminal("request", &digest, 6))
                .await
                .unwrap();
        });
        let result = upload_after_header(
            &mut client,
            &path,
            "request",
            "epoch",
            4096,
            "operation",
            &prepared,
            &cancellation,
            &mut ignored,
            &mut false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            result.attachment.file_id,
            "123e4567-e89b-42d3-a456-426614174000"
        );
        host_task.await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn immediate_terminal_receipt_sends_no_body() {
        let path = temp_file("immediate", b"same");
        let cancellation = AttachmentUploadCancellation::new();
        let mut ignored = |_| {};
        let prepared = prehash_file(&path, &cancellation, &mut ignored)
            .await
            .unwrap();
        let (client, mut host) = duplex(4096);
        let mut client = tokio::io::BufReader::new(client);
        write_json_line(
            &mut host,
            &terminal("request", &prepared.sha256, prepared.size_bytes),
        )
        .await
        .unwrap();
        let result = upload_after_header(
            &mut client,
            &path,
            "request",
            "epoch",
            4096,
            "operation",
            &prepared,
            &cancellation,
            &mut ignored,
            &mut false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(result.status, AttachmentUploadStatus::Stored);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn changed_source_is_detected_before_completion() {
        let path = temp_file("changed", b"before");
        let cancellation = AttachmentUploadCancellation::new();
        let mut ignored = |_| {};
        let prepared = prehash_file(&path, &cancellation, &mut ignored)
            .await
            .unwrap();
        std::fs::write(&path, b"changed").unwrap();
        let (client, mut host) = duplex(4096);
        let mut client = tokio::io::BufReader::new(client);
        write_json_line(
            &mut host,
            &json!({
                "kind": "attachment_upload_ready",
                "version": 2,
                "requestId": "request",
                "hostEpoch": "epoch",
                "maxChunkBytes": 512
            }),
        )
        .await
        .unwrap();
        let error = upload_after_header(
            &mut client,
            &path,
            "request",
            "epoch",
            4096,
            "operation",
            &prepared,
            &cancellation,
            &mut ignored,
            &mut false,
            false,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ClientError::AttachmentSourceChanged));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn attachment_dto_validates_known_fields_and_ignores_future_fields() {
        let valid = json!({
            "fileId": "123e4567-e89b-42d3-a456-426614174000",
            "name": "report.pdf",
            "sizeBytes": 42,
            "mediaType": "application/pdf",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "storedAt": "2026-08-16T00:00:00.000Z",
            "futureOptionalField": { "supportedLater": true }
        });
        serde_json::from_value::<AttachmentDto>(valid.clone()).unwrap();

        for (field, malformed) in [
            ("fileId", json!("file-1")),
            ("name", json!("../report.pdf")),
            ("sizeBytes", json!(MAX_ATTACHMENT_BYTES + 1)),
            ("mediaType", json!("")),
            (
                "sha256",
                json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            ),
            ("storedAt", json!("not-a-timestamp")),
        ] {
            let mut candidate = valid.clone();
            candidate[field] = malformed;
            assert!(
                serde_json::from_value::<AttachmentDto>(candidate).is_err(),
                "malformed {field} was accepted"
            );
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_stalled_readiness_read() {
        let path = temp_file("stalled-read", b"");
        let cancellation = AttachmentUploadCancellation::new();
        let mut ignored = |_| {};
        let prepared = prehash_file(&path, &cancellation, &mut ignored)
            .await
            .unwrap();
        let (client, _host) = duplex(256);
        let mut client = tokio::io::BufReader::new(client);
        let canceller = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            canceller.cancel();
        });

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            upload_after_header(
                &mut client,
                &path,
                "request",
                "epoch",
                4096,
                "operation",
                &prepared,
                &cancellation,
                &mut ignored,
                &mut false,
                false,
            ),
        )
        .await
        .expect("cancellation must interrupt the stalled readiness read")
        .unwrap_err();
        assert!(matches!(error, ClientError::AttachmentUploadCancelled));
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn cancellation_interrupts_stalled_chunk_write() {
        let path = temp_file("stalled-write", &[b'x'; 4096]);
        let cancellation = AttachmentUploadCancellation::new();
        let mut ignored = |_| {};
        let prepared = prehash_file(&path, &cancellation, &mut ignored)
            .await
            .unwrap();
        let (client, mut host) = duplex(256);
        let mut client = tokio::io::BufReader::new(client);
        let host_task = tokio::spawn(async move {
            write_json_line(
                &mut host,
                &json!({
                    "kind": "attachment_upload_ready",
                    "version": 2,
                    "requestId": "request",
                    "hostEpoch": "epoch",
                    "maxChunkBytes": 512
                }),
            )
            .await
            .unwrap();
            std::future::pending::<()>().await;
        });
        let canceller = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            canceller.cancel();
        });

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            upload_after_header(
                &mut client,
                &path,
                "request",
                "epoch",
                4096,
                "operation",
                &prepared,
                &cancellation,
                &mut ignored,
                &mut false,
                false,
            ),
        )
        .await
        .expect("cancellation must interrupt backpressure")
        .unwrap_err();
        assert!(matches!(error, ClientError::AttachmentUploadCancelled));
        host_task.abort();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn cancellation_after_completion_send_is_effect_unknown() {
        let path = temp_file("post-complete-cancel", b"");
        let cancellation = AttachmentUploadCancellation::new();
        let mut ignored = |_| {};
        let prepared = prehash_file(&path, &cancellation, &mut ignored)
            .await
            .unwrap();
        let (client, host) = duplex(4096);
        let mut client = tokio::io::BufReader::new(client);
        let mut host = tokio::io::BufReader::new(host);
        let host_cancellation = cancellation.clone();
        let host_task = tokio::spawn(async move {
            write_json_line(
                &mut host,
                &json!({
                    "kind": "attachment_upload_ready",
                    "version": 2,
                    "requestId": "request",
                    "hostEpoch": "epoch",
                    "maxChunkBytes": 512
                }),
            )
            .await
            .unwrap();
            let complete: Value = read_json_line(&mut host, 4096).await.unwrap();
            assert_eq!(complete["kind"], "attachment_complete");
            host_cancellation.cancel();
            std::future::pending::<()>().await;
        });

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            upload_after_header(
                &mut client,
                &path,
                "request",
                "epoch",
                4096,
                "operation-kept",
                &prepared,
                &cancellation,
                &mut ignored,
                &mut false,
                false,
            ),
        )
        .await
        .expect("post-completion cancellation must interrupt the terminal wait")
        .unwrap_err();
        assert!(matches!(
            error,
            ClientError::EffectUnknown { operation_id, .. } if operation_id == "operation-kept"
        ));
        host_task.abort();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn terminal_transport_failure_after_completion_is_effect_unknown() {
        let path = temp_file("unknown", b"");
        let cancellation = AttachmentUploadCancellation::new();
        let mut ignored = |_| {};
        let prepared = prehash_file(&path, &cancellation, &mut ignored)
            .await
            .unwrap();
        let (client, mut host) = duplex(4096);
        let mut client = tokio::io::BufReader::new(client);
        write_json_line(
            &mut host,
            &json!({
                "kind": "attachment_upload_ready",
                "version": 2,
                "requestId": "request",
                "hostEpoch": "epoch",
                "maxChunkBytes": 512
            }),
        )
        .await
        .unwrap();
        let mut host = tokio::io::BufReader::new(host);
        let host_task = tokio::spawn(async move {
            let complete: Value = read_json_line(&mut host, 4096).await.unwrap();
            assert_eq!(complete["kind"], "attachment_complete");
        });
        let error = upload_after_header(
            &mut client,
            &path,
            "request",
            "epoch",
            4096,
            "operation-kept",
            &prepared,
            &cancellation,
            &mut ignored,
            &mut false,
            false,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            ClientError::EffectUnknown { operation_id, .. } if operation_id == "operation-kept"
        ));
        host_task.await.unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
