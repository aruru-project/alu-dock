//! Shared file producers, receivers and integrity checks. Business admission and commit stay outside.
use crate::file_io::{FILE_IDLE, FileActivity, write_file_record};
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

    pub async fn write_chunk<W: AsyncWrite + Unpin>(
        &mut self,
        index: u64,
        data: &str,
        maximum_chunk: usize,
        sink: &mut W,
    ) -> Result<u64> {
        let bytes = self.decode_chunk(index, data, maximum_chunk)?;
        sink.write_all(&bytes).await?;
        Ok(self.size_bytes)
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

    /// Old page protocols have no remote digest. This is only the local received summary.
    pub fn received_summary(self) -> FileTransferSummary {
        FileTransferSummary {
            chunks: self.chunks,
            size_bytes: self.size_bytes,
            sha256: hex::encode(self.digest.finalize()),
        }
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

use crate::{
    DockClient,
    client::{ResponseEnvelope, maximum_line_bytes, response_result, validate_response_envelope},
    tls::{read_json_line_counted, read_json_line_observed, write_json_line},
    wire::require_clean_end,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

pub(crate) const FILE_TRANSFER_CAPABILITY: &str = "file-transfer.v1";
pub(crate) const FILE_WINDOW_BYTES: u64 = 256 * 1024;

pub(crate) fn missing_file_capability(error: &ClientError) -> bool {
    missing_stream_capability(error, &[FILE_TRANSFER_CAPABILITY])
}

fn missing_stream_capability(error: &ClientError, optional: &[&str]) -> bool {
    matches!(error, ClientError::Host { code, details: Some(details), .. }
        if code == "capability_missing" && details.get("missing").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item.as_str().is_some_and(|capability| optional.contains(&capability)))))
}

pub(crate) struct RemoteFile {
    pub result: Value,
    pub summary: FileTransferSummary,
    pub host_epoch: String,
}

impl DockClient {
    pub(crate) async fn read_file_text<P: Serialize>(
        &self,
        request_type: &str,
        params: &P,
        capabilities: &[&str],
    ) -> Result<Option<crate::config::ResourceContentResult>> {
        let mut bytes = Vec::new();
        let Some(file) = self
            .read_file_stream(
                request_type,
                params,
                capabilities,
                9_007_199_254_740_991,
                &mut bytes,
                |_| Ok(()),
                |_| {},
            )
            .await?
        else {
            return Ok(None);
        };
        let text = String::from_utf8(bytes).map_err(|_| ClientError::Host {
            code: "resource_unavailable".into(),
            message: "这份资源不是 UTF-8 文本。请检查文件编码后重新打开。".into(),
            retryable: false,
            details: None,
        })?;
        let revision = file
            .result
            .get("revision")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Missing resource revision"))?
            .to_owned();
        Ok(Some(crate::config::ResourceContentResult {
            text,
            revision,
            next_offset: None,
        }))
    }

    /// None means explicit missing capability before any file was delivered. Never retry partial data.
    pub(crate) async fn read_file_stream<P, W, R, F>(
        &self,
        request_type: &str,
        params: &P,
        capabilities: &[&str],
        maximum_bytes: u64,
        sink: &mut W,
        ready: R,
        progress: F,
    ) -> Result<Option<RemoteFile>>
    where
        P: Serialize,
        W: AsyncWrite + Unpin,
        R: FnMut(&Value) -> Result<()>,
        F: FnMut(u64),
    {
        self.read_byte_stream(request_type, params, capabilities, &[FILE_TRANSFER_CAPABILITY], maximum_bytes, sink, ready, progress).await
    }

    /// None means explicit missing capability before any file was delivered. Never retry partial data.
    pub(crate) async fn read_byte_stream<P, W, R, F>(
        &self,
        request_type: &str,
        params: &P,
        capabilities: &[&str],
        fallback_capabilities: &[&str],
        maximum_bytes: u64,
        sink: &mut W,
        mut ready: R,
        mut progress: F,
    ) -> Result<Option<RemoteFile>>
    where
        P: Serialize,
        W: AsyncWrite + Unpin,
        R: FnMut(&Value) -> Result<()>,
        F: FnMut(u64),
    {
        let mut required = capabilities.to_vec();
        required.push(FILE_TRANSFER_CAPABILITY);
        let routed = match self.negotiate(&required).await {
            Ok(value) => value,
            Err(error) if missing_stream_capability(&error, fallback_capabilities) => return Ok(None),
            Err(error) => return Err(error),
        };
        self.check_file_host_epoch(&routed.hello.host.host_epoch)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let host_epoch = routed.hello.host.host_epoch.clone();
        let maximum_line = maximum_line_bytes(&routed.hello);
        let mut stream = routed.connection.stream;
        timed(write_json_line(&mut stream, &json!({"kind":"request","version":2,"requestId":request_id,"type":request_type,"params":params}))).await?;
        let mut began = false;
        let result = receive_file(
            &mut stream,
            sink,
            maximum_line,
            &request_id,
            &host_epoch,
            maximum_bytes,
            &mut began,
            &mut ready,
            &mut progress,
        )
        .await;
        match result {
            Ok((result, summary)) => {
                self.router().ensure_open()?;
                Ok(Some(RemoteFile {
                    result,
                    summary,
                    host_epoch,
                }))
            }
            Err(error) if !began && missing_stream_capability(&error, fallback_capabilities) => Ok(None),
            Err(error) => {
                self.router()
                    .report_connection_failure(&routed.endpoint_id, routed.route_generation);
                Err(error)
            }
        }
    }
}

async fn timed<T>(future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    timeout(FILE_IDLE, future)
        .await
        .map_err(|_| ClientError::Protocol("File transfer was idle for too long".into()))?
}
fn invalid(message: &str) -> ClientError {
    ClientError::Protocol(message.into())
}
fn correlated(value: &Value, request_id: &str, host_epoch: &str) -> Result<()> {
    if value.get("version").and_then(Value::as_u64) != Some(2)
        || value.get("requestId").and_then(Value::as_str) != Some(request_id)
        || value.get("hostEpoch").and_then(Value::as_str) != Some(host_epoch)
    {
        return Err(invalid("File frame belongs to another request"));
    }
    Ok(())
}
fn number(value: &Value, field: &str) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("Invalid file transfer count"))
}

async fn receive_file<S, W, R, F>(
    stream: &mut S,
    sink: &mut W,
    maximum_line: usize,
    request_id: &str,
    host_epoch: &str,
    maximum_bytes: u64,
    began: &mut bool,
    ready: &mut R,
    progress: &mut F,
) -> Result<(Value, FileTransferSummary)>
where
    S: AsyncBufRead + AsyncWrite + Unpin,
    W: AsyncWrite + Unpin,
    R: FnMut(&Value) -> Result<()>,
    F: FnMut(u64),
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(reader);
    let mut transfer = Some(FileTransfer::new(maximum_bytes, "file"));
    let mut summary: Option<FileTransferSummary> = None;
    let mut chunk_limit = 0_usize;
    let mut wire_bytes = 0_u64;
    let mut transit = 0;
    let mut transit_deadline = tokio::time::Instant::now() + FILE_IDLE;
    loop {
        let consumed = transfer
            .as_ref()
            .map(FileTransfer::size_bytes)
            .unwrap_or_else(|| {
                summary
                    .as_ref()
                    .map(|summary| summary.size_bytes)
                    .unwrap_or(0)
            });
        let (frame, count) = read_file_record(
            &mut reader,
            &mut writer,
            maximum_line,
            request_id,
            host_epoch,
            wire_bytes,
            consumed,
            summary.is_none(),
            &mut transit_deadline,
        )
        .await?;
        wire_bytes += count as u64;
        correlated(&frame, request_id, host_epoch)?;
        if frame.get("kind").and_then(Value::as_str) == Some("file_activity") {
            let next = number(&frame, "inTransitBytes")?;
            if next > transit {
                transit = next;
                if summary.is_none() {
                    transit_deadline = tokio::time::Instant::now() + FILE_IDLE;
                }
            }
            if tokio::time::Instant::now() >= transit_deadline {
                return Err(invalid("File transfer was idle for too long"));
            }
            continue;
        }
        transit_deadline = tokio::time::Instant::now() + FILE_IDLE;
        match frame.get("kind").and_then(Value::as_str) {
            Some("response") => {
                let response: ResponseEnvelope = serde_json::from_value(frame)?;
                validate_response_envelope(&response, request_id, host_epoch)?;
                let result: Value = response_result(response, "file", None)?;
                let summary =
                    summary.ok_or_else(|| invalid("File response preceded completion"))?;
                FileActivity::new().flush(sink).await?;
                require_clean_end(&mut reader, FILE_IDLE, "file").await?;
                return Ok((result, summary));
            }
            Some("file_ready") if !*began => {
                if frame.get("direction").and_then(Value::as_str) != Some("download") {
                    return Err(invalid("File readiness has wrong direction"));
                }
                chunk_limit = number(&frame, "maxChunkBytes")? as usize;
                let window = number(&frame, "windowBytes")?;
                if chunk_limit == 0
                    || chunk_limit > crate::wire::MAX_CONTROL_BASE64_CHUNK_BYTES
                    || window < chunk_limit as u64
                    || window > FILE_WINDOW_BYTES
                {
                    return Err(invalid("Unsupported file transfer bounds"));
                }
                *began = true;
                ready(frame.get("metadata").unwrap_or(&Value::Null))?;
                progress(0);
            }
            Some("file_chunk") if *began && summary.is_none() => {
                let transfer = transfer
                    .as_mut()
                    .ok_or_else(|| invalid("File data after completion"))?;
                let previous = transfer.size_bytes();
                let bytes = transfer.decode_chunk(
                    number(&frame, "index")?,
                    frame
                        .get("data")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("Missing file bytes"))?,
                    chunk_limit,
                )?;
                let activity = FileActivity::new();
                let mut written = 0;
                while written < bytes.len() {
                    written += activity.write(sink, &bytes[written..]).await?;
                    write_file_record(&mut writer,&json!({"kind":"file_progress","version":2,"requestId":request_id,"hostEpoch":host_epoch,"receivedWireBytes":wire_bytes,"consumedBytes":previous+written as u64}),&activity).await?;
                }
                progress(transfer.size_bytes());
                transit_deadline = tokio::time::Instant::now() + FILE_IDLE;
            }
            Some("file_complete") if *began && summary.is_none() => {
                summary = Some(
                    transfer.take().unwrap().finish(
                        number(&frame, "chunks")?,
                        number(&frame, "sizeBytes")?,
                        frame
                            .get("sha256")
                            .and_then(Value::as_str)
                            .ok_or_else(|| invalid("Missing file digest"))?,
                    )?,
                );
            }
            _ => return Err(invalid("Unexpected file transfer record")),
        }
    }
}

/// Read a potentially slow JSONL record while reporting only actual arriving bytes.
/// A watch slot coalesces reception; there is no polling heartbeat or per-byte queue.
async fn read_file_record<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
    maximum_line: usize,
    request_id: &str,
    host_epoch: &str,
    wire_bytes: u64,
    consumed: u64,
    report_progress: bool,
    deadline: &mut tokio::time::Instant,
) -> Result<(Value, usize)> {
    let (received, mut changes) = tokio::sync::watch::channel(wire_bytes);
    let mut total = wire_bytes;
    let line = read_json_line_observed(reader, maximum_line, |count, prefix| {
        total += count as u64;
        if crate::file_io::chunk_header(prefix, request_id, host_epoch) {
            received.send_replace(total);
        }
    });
    tokio::pin!(line);
    loop {
        tokio::select! {
            biased;
            result = &mut line => return result,
            changed = changes.changed() => {
                changed.map_err(|_| invalid("File reception ended"))?;
                let wire = *changes.borrow_and_update();
                *deadline = tokio::time::Instant::now() + FILE_IDLE;
                if report_progress { write_file_record(writer, &json!({"kind":"file_progress","version":2,"requestId":request_id,"hostEpoch":host_epoch,"receivedWireBytes":wire,"consumedBytes":consumed}), &FileActivity::new()).await?; }
            },
            _ = tokio::time::sleep_until(*deadline) => return Err(invalid("File transfer was idle for too long")),
        }
    }
}

/// Common sender for legacy and negotiated uploads. Caller owns the completion/commit boundary.
pub(crate) async fn send_file<S, R, F>(
    stream: &mut S,
    source: &mut R,
    request_id: &str,
    host_epoch: &str,
    maximum_line: usize,
    chunk_bytes: usize,
    window_bytes: Option<u64>,
    expected_size: u64,
    expected_sha: &str,
    progress: &mut F,
) -> Result<FileTransferSummary>
where
    S: AsyncBufRead + AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
    F: FnMut(u64),
{
    let (reader, mut writer) = tokio::io::split(stream);
    // Do not prefetch beyond the last ACK: the caller owns the subsequent receipt.
    let mut reader = tokio::io::BufReader::with_capacity(1, reader);
    let state = std::sync::Mutex::new(SenderProgress::default());
    let activity = FileActivity::new();
    let (changed, mut changes) = tokio::sync::watch::channel(0_u64);
    let receiving = async {
        if expected_size == 0 {
            return Ok::<(), ClientError>(());
        }
        loop {
            let (frame, _): (Value, usize) =
                read_json_line_counted(&mut reader, maximum_line).await?;
            correlated(&frame, request_id, host_epoch)?;
            let mut state = state.lock().unwrap();
            let advanced = state.accept(&frame)?;
            if advanced {
                activity.advanced();
                changed.send_modify(|n| *n += 1);
            }
            // Stop at the full final ACK boundary. Never cancel a reader that
            // may already have consumed the prefix of the next receipt record.
            if state.consumed == expected_size {
                return Ok(());
            }
        }
    };
    let sending = async {
        let mut buffer = vec![0; chunk_bytes];
        let mut digest = Sha256::new();
        let mut count = 0;
        let mut chunks = 0;
        loop {
            let read = activity
                .wait(async { Ok(source.read(&mut buffer).await?) })
                .await?;
            if read == 0 {
                break;
            }
            activity.advanced();
            if count + read as u64 > expected_size {
                return Err(ClientError::AttachmentSourceChanged);
            }
            if let Some(window) = window_bytes {
                while count + read as u64 - state.lock().unwrap().consumed > window {
                    activity
                        .wait(async {
                            changes
                                .changed()
                                .await
                                .map_err(|_| invalid("File progress ended"))
                        })
                        .await?;
                }
            }
            state.lock().unwrap().sent = count + read as u64;
            digest.update(&buffer[..read]);
            let mut frame = json!({"kind":if window_bytes.is_some(){"file_chunk"}else{"attachment_chunk"},"version":2,"requestId":request_id,"index":chunks,"data":base64::Engine::encode(&base64::engine::general_purpose::STANDARD,&buffer[..read])});
            if window_bytes.is_some() {
                frame["hostEpoch"] = json!(host_epoch);
                write_file_record(&mut writer, &frame, &activity).await?;
            } else {
                write_json_line(&mut writer, &frame).await?;
            }
            count += read as u64;
            chunks += 1;
            progress(count);
        }
        if window_bytes.is_some() {
            while state.lock().unwrap().consumed < count {
                activity
                    .wait(async {
                        changes
                            .changed()
                            .await
                            .map_err(|_| invalid("File progress ended"))
                    })
                    .await?;
            }
        }
        let sha256 = hex::encode(digest.finalize());
        if count != expected_size || sha256 != expected_sha {
            return Err(ClientError::AttachmentSourceChanged);
        }
        Ok(FileTransferSummary {
            chunks,
            size_bytes: count,
            sha256,
        })
    };
    if window_bytes.is_none() {
        return sending.await;
    }
    let (summary, ()) = tokio::try_join!(sending, receiving)?;
    Ok(summary)
}
#[derive(Default)]
struct SenderProgress {
    sent: u64,
    consumed: u64,
    wire: u64,
    transit: u64,
}
impl SenderProgress {
    fn accept(&mut self, frame: &Value) -> Result<bool> {
        if frame.get("kind").and_then(Value::as_str) == Some("file_activity") {
            let transit = number(frame, "inTransitBytes")?;
            let advanced = transit > self.transit;
            self.transit = self.transit.max(transit);
            return Ok(advanced);
        }
        if frame.get("kind").and_then(Value::as_str) != Some("file_progress") {
            return Err(invalid("Expected file consumption progress"));
        }
        let consumed = number(frame, "consumedBytes")?;
        let wire = number(frame, "receivedWireBytes")?;
        if consumed < self.consumed || consumed > self.sent || wire < self.wire {
            return Err(invalid("Inconsistent file progress"));
        }
        let advanced = consumed > self.consumed || wire > self.wire;
        self.consumed = consumed;
        self.wire = wire;
        Ok(advanced)
    }
}

/// Already-observed transit reports can be queued before the business receipt.
/// The caller's single receipt deadline remains authoritative; these do not restart it.
pub(crate) async fn read_file_receipt<S: AsyncBufRead + Unpin>(
    stream: &mut S,
    maximum_line: usize,
    request_id: &str,
    host_epoch: &str,
    size: u64,
) -> Result<Value> {
    let mut progress = SenderProgress {
        sent: size,
        consumed: size,
        ..Default::default()
    };
    loop {
        let (record, _): (Value, usize) = read_json_line_counted(stream, maximum_line).await?;
        if matches!(
            record.get("kind").and_then(Value::as_str),
            Some("file_activity" | "file_progress")
        ) {
            correlated(&record, request_id, host_epoch)?;
            progress.accept(&record)?;
        } else {
            return Ok(record);
        }
    }
}

pub(crate) enum LegacyFileFrame<M> {
    Ready(M),
    Chunk(u64, String),
    Complete(u64, u64, String),
    Error(ClientError),
}

/// Endpoint-specific old records only translate into this same serial sink/integrity path.
pub(crate) async fn receive_legacy_file<S, W, M, C, R, F>(
    stream: &mut S,
    sink: &mut W,
    maximum_line: usize,
    maximum_bytes: u64,
    chunk_bytes: usize,
    mut codec: C,
    mut ready: R,
    mut progress: F,
) -> Result<(M, FileTransferSummary)>
where
    S: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    C: FnMut(Value) -> Result<LegacyFileFrame<M>>,
    R: FnMut(&M) -> Result<()>,
    F: FnMut(u64, &M),
{
    let mut metadata = None;
    let mut transfer = FileTransfer::new(maximum_bytes, "file");
    loop {
        let raw: Value = crate::wire::read_timed_json_line(
            stream,
            maximum_line,
            crate::timing::FILE_READ_IDLE_TIMEOUT,
            "file",
        )
        .await?;
        match codec(raw)? {
            LegacyFileFrame::Ready(value) if metadata.is_none() => {
                ready(&value)?;
                progress(0, &value);
                metadata = Some(value);
            }
            LegacyFileFrame::Chunk(index, data) if metadata.is_some() => {
                transfer
                    .write_chunk(index, &data, chunk_bytes, sink)
                    .await?;
                progress(transfer.size_bytes(), metadata.as_ref().unwrap());
            }
            LegacyFileFrame::Complete(chunks, size, sha) if metadata.is_some() => {
                let summary = transfer.finish(chunks, size, &sha)?;
                sink.flush().await?;
                require_clean_end(stream, crate::timing::FILE_READ_IDLE_TIMEOUT, "file").await?;
                return Ok((metadata.unwrap(), summary));
            }
            LegacyFileFrame::Error(error) => return Err(error),
            _ => return Err(invalid("Unexpected legacy file frame")),
        }
    }
}

#[cfg(test)]
mod flow_tests {
    use super::*;
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::{AsyncReadExt, ReadBuf, duplex};
    use tokio::sync::oneshot;
    struct DrainFlush {
        socket: tokio::io::DuplexStream,
        drained: oneshot::Receiver<()>,
        finished: bool,
    }
    impl AsyncRead for DrainFlush {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.socket).poll_read(cx, buf)
        }
    }
    impl AsyncWrite for DrainFlush {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Pin::new(&mut self.socket).poll_write(cx, bytes)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            if self.finished {
                return Poll::Ready(Ok(()));
            }
            match Pin::new(&mut self.drained).poll(cx) {
                Poll::Ready(_) => {
                    self.finished = true;
                    Poll::Ready(Ok(()))
                }
                Poll::Pending => Poll::Pending,
            }
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.socket).poll_shutdown(cx)
        }
    }
    const SHA: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[tokio::test]
    async fn final_ack_does_not_consume_half_of_a_late_activity_before_the_receipt() {
        for bytes in [b"abc".as_slice(), b"".as_slice()] {
            let digest = hex::encode(Sha256::digest(bytes));
            let (client, host) = duplex(4096);
            let mut client = tokio::io::BufReader::new(client);
            let mut host = tokio::io::BufReader::new(host);
            let body = async {
                let mut source = bytes;
                let summary = send_file(
                    &mut client,
                    &mut source,
                    "r",
                    "h",
                    4096,
                    64,
                    Some(256),
                    bytes.len() as u64,
                    &digest,
                    &mut |_| {},
                )
                .await?;
                write_file_record(&mut client,&json!({"kind":"file_complete","version":2,"requestId":"r","hostEpoch":"h","chunks":summary.chunks,"sizeBytes":summary.size_bytes,"sha256":summary.sha256}),&FileActivity::new()).await?;
                read_file_receipt(&mut client, 4096, "r", "h", bytes.len() as u64).await
            };
            let peer = async {
                let activity=crate::file_io::encode_record(&json!({"kind":"file_activity","version":2,"requestId":"r","hostEpoch":"h","inTransitBytes":1})).unwrap();
                let cut = activity.len() / 2;
                let mut first = Vec::new();
                if !bytes.is_empty() {
                    let (_, wire): (Value, usize) =
                        read_json_line_counted(&mut host, 4096).await.unwrap();
                    first=crate::file_io::encode_record(&json!({"kind":"file_progress","version":2,"requestId":"r","hostEpoch":"h","receivedWireBytes":wire,"consumedBytes":3})).unwrap();
                }
                first.extend_from_slice(&activity[..cut]);
                host.write_all(&first).await.unwrap();
                let (complete, _): (Value, usize) =
                    read_json_line_counted(&mut host, 4096).await.unwrap();
                assert_eq!(complete["kind"], "file_complete");
                host.write_all(&activity[cut..]).await.unwrap();
                write_json_line(&mut host,&json!({"kind":"response","version":2,"requestId":"r","hostEpoch":"h","ok":true,"result":{}})).await.unwrap();
            };
            let (result, ()) = tokio::join!(body, peer);
            assert_eq!(result.unwrap()["kind"], "response");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn upload_receives_real_peer_progress_while_a_record_flush_is_blocked() {
        let (client, peer) = duplex(4096);
        let (drained, gate) = oneshot::channel();
        let (finished, finish) = oneshot::channel();
        let mut client = tokio::io::BufReader::new(DrainFlush {
            socket: client,
            drained: gate,
            finished: false,
        });
        let sending = async {
            let result = send_file(
                &mut client,
                &mut b"abc".as_slice(),
                "r",
                "h",
                4096,
                64,
                Some(256),
                3,
                SHA,
                &mut |_| {},
            )
            .await;
            let _ = finished.send(());
            result
        };
        let receiving = async {
            let (mut read, mut write) = tokio::io::split(peer);
            let mut wire = Vec::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(40)).await;
                let mut bytes = [0; 16];
                let count = read.read(&mut bytes).await.unwrap();
                wire.extend_from_slice(&bytes[..count]);
                let consumed = if wire.ends_with(b"\n") { 3 } else { 0 };
                write_json_line(&mut write,&json!({"kind":"file_progress","version":2,"requestId":"r","hostEpoch":"h","receivedWireBytes":wire.len(),"consumedBytes":consumed})).await.unwrap();
                if consumed == 3 {
                    break;
                }
            }
            assert_eq!(
                serde_json::from_slice::<Value>(&wire).unwrap()["data"],
                "YWJj"
            );
            drained.send(()).unwrap();
            let _ = finish.await;
        };
        let (result, ()) = tokio::join!(sending, receiving);
        assert_eq!(result.unwrap().size_bytes, 3);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_sink_acknowledges_only_successfully_written_payload_parts() {
        let (client, mut host) = duplex(4096);
        let mut client = tokio::io::BufReader::new(client);
        let (mut sink, mut consumer) = duplex(1);
        let receive = async {
            receive_file(
                &mut client,
                &mut sink,
                4096,
                "r",
                "h",
                3,
                &mut false,
                &mut |_| Ok(()),
                &mut |_| {},
            )
            .await
        };
        let produce = async {
            let activity = FileActivity::new();
            write_file_record(&mut host,&json!({"kind":"file_ready","version":2,"requestId":"r","hostEpoch":"h","direction":"download","maxChunkBytes":64,"windowBytes":256}),&activity).await.unwrap();
            let chunk=crate::file_io::encode_record(&json!({"kind":"file_chunk","version":2,"requestId":"r","hostEpoch":"h","index":0,"data":"YWJj"})).unwrap();
            host.write_all(&chunk[..chunk.len() - 3]).await.unwrap();
            for byte in &chunk[chunk.len() - 3..] {
                tokio::time::sleep(std::time::Duration::from_secs(40)).await;
                host.write_all(&[*byte]).await.unwrap();
            }
            let mut host = tokio::io::BufReader::new(host);
            let mut consumed = 0;
            while consumed < 3 {
                let (frame, _): (Value, usize) =
                    read_json_line_counted(&mut host, 4096).await.unwrap();
                assert_eq!(frame["kind"], "file_progress");
                let next = frame["consumedBytes"].as_u64().unwrap();
                assert!(next >= consumed && next <= 3);
                consumed = next;
            }
            write_file_record(&mut host,&json!({"kind":"file_complete","version":2,"requestId":"r","hostEpoch":"h","chunks":1,"sizeBytes":3,"sha256":SHA}),&activity).await.unwrap();
            write_json_line(&mut host,&json!({"kind":"response","version":2,"requestId":"r","hostEpoch":"h","ok":true,"result":{}})).await.unwrap();
            host.shutdown().await.unwrap();
        };
        let consume = async {
            let mut bytes = Vec::new();
            for _ in 0..3 {
                tokio::time::sleep(std::time::Duration::from_secs(40)).await;
                bytes.push(consumer.read_u8().await.unwrap());
            }
            assert_eq!(bytes, b"abc");
        };
        let (result, (), ()) = tokio::join!(receive, produce, consume);
        assert_eq!(result.unwrap().1.size_bytes, 3);
    }
}
