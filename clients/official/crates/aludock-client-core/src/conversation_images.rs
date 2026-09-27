use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;

use crate::{
    ClientError, DockClient, Result,
    capabilities::CONVERSATION_IMAGES as CONVERSATION_IMAGE_CAPABILITIES,
    client::{ResponseEnvelope, maximum_line_bytes, response_result, validate_response_envelope},
    file_transfer::{FileTransfer, lowercase_sha256},
    timing::FILE_READ_IDLE_TIMEOUT,
    tls::write_json_line,
    wire::{read_timed_json_line, require_clean_end},
};

pub const MAX_CONVERSATION_IMAGE_BYTES: usize = 20 * 1_024 * 1_024;
const MAX_CONVERSATION_IMAGE_CHUNK_BYTES: usize = 512 * 1_024;

#[derive(Clone, Debug)]
pub struct ConversationImageTransfer {
    pub mime_type: String,
    pub chunks: u64,
    pub size_bytes: u64,
    pub sha256: String,
    pub host_epoch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationImageRequest<'a> {
    kind: &'static str,
    version: u8,
    request_id: &'a str,
    #[serde(rename = "type")]
    request_type: &'static str,
    params: ConversationImageParams<'a>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationImageParams<'a> {
    instance_id: &'a str,
    content_ref: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum ConversationImageFrame {
    #[serde(rename = "conversation_image_ready")]
    Ready {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "contentRef")]
        content_ref: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        sha256: String,
    },
    #[serde(rename = "conversation_image_chunk")]
    Chunk {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "contentRef")]
        content_ref: String,
        index: u64,
        data: String,
    },
    #[serde(rename = "conversation_image_complete")]
    Complete {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "contentRef")]
        content_ref: String,
        chunks: u64,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        sha256: String,
    },
    #[serde(rename = "conversation_image_error")]
    Error {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "contentRef")]
        content_ref: String,
        error: ConversationImageError,
    },
}

#[derive(Debug, Deserialize)]
struct ConversationImageError {
    code: String,
    message: String,
}

impl DockClient {
    /// Stream into a provisional sink. The caller must not publish it until this
    /// returns successfully (including the terminal frame and stream closure).
    pub async fn read_conversation_image<W: AsyncWrite + Unpin>(
        &self,
        instance_id: &str,
        content_ref: &str,
        expected_mime_type: &str,
        sink: &mut W,
    ) -> Result<ConversationImageTransfer> {
        if instance_id.is_empty()
            || instance_id.len() > 128
            || content_ref.is_empty()
            || content_ref.len() > 128
            || !valid_image_mime_type(expected_mime_type)
        {
            return Err(protocol("conversation image request identity was invalid"));
        }
        let routed = self.negotiate(CONVERSATION_IMAGE_CAPABILITIES).await?;
        let endpoint_id = routed.endpoint_id;
        let route_generation = routed.route_generation;
        let mut connection = routed.connection;
        let hello = routed.hello;
        let request_id = Uuid::new_v4().to_string();
        if let Err(error) = write_json_line(
            &mut connection.stream,
            &ConversationImageRequest {
                kind: "request",
                version: 2,
                request_id: &request_id,
                request_type: "conversation.image",
                params: ConversationImageParams {
                    instance_id,
                    content_ref,
                },
            },
        )
        .await
        {
            self.router()
                .report_connection_failure(&endpoint_id, route_generation);
            return Err(error);
        }
        let result = read_conversation_image_after_request(
            &mut connection.stream,
            maximum_line_bytes(&hello),
            &request_id,
            &hello.host.host_epoch,
            instance_id,
            content_ref,
            expected_mime_type,
            sink,
        )
        .await;
        if result.as_ref().is_err_and(|error| {
            !matches!(
                error,
                ClientError::Host { .. } | ClientError::Storage { .. }
            )
        }) {
            self.router()
                .report_connection_failure(&endpoint_id, route_generation);
        } else {
            self.router().ensure_open()?;
        }
        result
    }
}

#[allow(clippy::too_many_arguments)]
async fn read_conversation_image_after_request<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    stream: &mut R,
    maximum_line_bytes: usize,
    request_id: &str,
    host_epoch: &str,
    instance_id: &str,
    content_ref: &str,
    expected_mime_type: &str,
    sink: &mut W,
) -> Result<ConversationImageTransfer> {
    let first: Value = read_timed_json_line(
        stream,
        maximum_line_bytes,
        FILE_READ_IDLE_TIMEOUT,
        "conversation image read",
    )
    .await?;
    if first.get("kind").and_then(Value::as_str) == Some("response") {
        let response: ResponseEnvelope = serde_json::from_value(first)?;
        validate_response_envelope(&response, request_id, host_epoch)?;
        let _: Value = response_result(response, "conversation.image", None)?;
        return Err(protocol(
            "conversation image returned an ordinary success response",
        ));
    }
    let first =
        parse_conversation_image_frame(first, request_id, host_epoch, instance_id, content_ref)?;
    let (mime_type, expected_size, expected_sha256) = match first {
        ConversationImageFrame::Ready {
            mime_type,
            size_bytes,
            sha256,
            ..
        } if mime_type == expected_mime_type
            && valid_image_mime_type(&mime_type)
            && size_bytes > 0
            && size_bytes <= MAX_CONVERSATION_IMAGE_BYTES as u64
            && lowercase_sha256(&sha256) =>
        {
            (mime_type, size_bytes, sha256)
        }
        _ => {
            return Err(protocol(
                "conversation image did not begin with valid readiness",
            ));
        }
    };

    let mut transfer = FileTransfer::new(expected_size, "conversation image");
    loop {
        let raw: Value = read_timed_json_line(
            stream,
            maximum_line_bytes,
            FILE_READ_IDLE_TIMEOUT,
            "conversation image read",
        )
        .await?;
        if raw.get("kind").and_then(Value::as_str) == Some("response") {
            return Err(protocol(
                "conversation image returned an ordinary response after readiness",
            ));
        }
        match parse_conversation_image_frame(raw, request_id, host_epoch, instance_id, content_ref)?
        {
            ConversationImageFrame::Ready { .. } => {
                return Err(protocol("Host repeated conversation image readiness"));
            }
            ConversationImageFrame::Error { error, .. } => {
                return Err(conversation_image_error(error));
            }
            ConversationImageFrame::Chunk { index, data, .. } => {
                let chunk =
                    transfer.decode_chunk(index, &data, MAX_CONVERSATION_IMAGE_CHUNK_BYTES)?;
                sink.write_all(&chunk)
                    .await
                    .map_err(|source| ClientError::Storage {
                        path: "conversation media provisional sink".into(),
                        source,
                    })?;
            }
            ConversationImageFrame::Complete {
                chunks: terminal_chunks,
                size_bytes,
                sha256,
                ..
            } => {
                if size_bytes != expected_size || sha256 != expected_sha256 {
                    return Err(protocol(
                        "conversation image completion did not match the received bytes",
                    ));
                }
                let summary = transfer.finish(terminal_chunks, size_bytes, &sha256)?;
                require_clean_end(stream, FILE_READ_IDLE_TIMEOUT, "conversation image").await?;
                sink.flush().await.map_err(|source| ClientError::Storage {
                    path: "conversation media provisional sink".into(),
                    source,
                })?;
                return Ok(ConversationImageTransfer {
                    mime_type,
                    chunks: summary.chunks,
                    size_bytes: summary.size_bytes,
                    sha256: summary.sha256,
                    host_epoch: host_epoch.into(),
                });
            }
        }
    }
}

fn parse_conversation_image_frame(
    raw: Value,
    request_id: &str,
    host_epoch: &str,
    instance_id: &str,
    content_ref: &str,
) -> Result<ConversationImageFrame> {
    let frame: ConversationImageFrame = serde_json::from_value(raw).map_err(|error| {
        ClientError::Protocol(format!("invalid conversation image frame: {error}"))
    })?;
    let (version, frame_request, frame_epoch, frame_instance, frame_content) = match &frame {
        ConversationImageFrame::Ready {
            version,
            request_id,
            host_epoch,
            instance_id,
            content_ref,
            ..
        }
        | ConversationImageFrame::Chunk {
            version,
            request_id,
            host_epoch,
            instance_id,
            content_ref,
            ..
        }
        | ConversationImageFrame::Complete {
            version,
            request_id,
            host_epoch,
            instance_id,
            content_ref,
            ..
        }
        | ConversationImageFrame::Error {
            version,
            request_id,
            host_epoch,
            instance_id,
            content_ref,
            ..
        } => (version, request_id, host_epoch, instance_id, content_ref),
    };
    if *version != 2
        || frame_request != request_id
        || frame_epoch != host_epoch
        || frame_instance != instance_id
        || frame_content != content_ref
    {
        return Err(protocol(
            "conversation image identity or Host state was invalid",
        ));
    }
    Ok(frame)
}

fn conversation_image_error(error: ConversationImageError) -> ClientError {
    if error.code != "image_unavailable"
        || error.message.is_empty()
        || error.message.chars().count() > 2_048
        || error.message.chars().any(char::is_control)
    {
        return protocol("conversation image returned an invalid error");
    }
    ClientError::Host {
        code: error.code,
        message: error.message,
        retryable: false,
        details: None,
    }
}

pub(crate) fn valid_image_mime_type(value: &str) -> bool {
    let Some(subtype) = value.strip_prefix("image/") else {
        return false;
    };
    !subtype.is_empty()
        && value.len() <= 256
        && subtype.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                )
        })
}

fn protocol(message: &str) -> ClientError {
    ClientError::Protocol(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn loading_conversation_image_verifies_the_stream_and_reports_full_disk() {
        let sha256 = "6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d";
        let frames = concat!(
            "{\"kind\":\"conversation_image_ready\",\"version\":2,\"requestId\":\"request\",\"hostEpoch\":\"epoch\",\"instanceId\":\"work\",\"contentRef\":\"content\",\"mimeType\":\"image/png\",\"sizeBytes\":5,\"sha256\":\"$SHA\"}\n",
            "{\"kind\":\"conversation_image_chunk\",\"version\":2,\"requestId\":\"request\",\"hostEpoch\":\"epoch\",\"instanceId\":\"work\",\"contentRef\":\"content\",\"index\":0,\"data\":\"aW1hZ2U=\"}\n",
            "{\"kind\":\"conversation_image_complete\",\"version\":2,\"requestId\":\"request\",\"hostEpoch\":\"epoch\",\"instanceId\":\"work\",\"contentRef\":\"content\",\"chunks\":1,\"sizeBytes\":5,\"sha256\":\"$SHA\"}\n"
        )
        .replace("$SHA", sha256);
        let complete_frames = frames.clone();
        let (client, mut host) = tokio::io::duplex(4_096);
        let mut client = tokio::io::BufReader::new(client);
        let writer = tokio::spawn(async move {
            host.write_all(frames.as_bytes()).await.unwrap();
            host.shutdown().await.unwrap();
        });

        let mut bytes = Vec::new();
        let image = read_conversation_image_after_request(
            &mut client,
            1_024 * 1_024,
            "request",
            "epoch",
            "work",
            "content",
            "image/png",
            &mut bytes,
        )
        .await
        .unwrap();
        writer.await.unwrap();

        assert_eq!(bytes, b"image");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.sha256, sha256);
        assert_eq!(image.size_bytes, 5);
        // V2 terminal framing is a transport integrity boundary. A buffered
        // read must not hide bytes after complete, or accept a truncated frame.
        for invalid in [
            format!("{complete_frames}!"),
            complete_frames.trim_end_matches('\n').to_owned(),
            complete_frames.replace("\"chunks\":1", "\"chunks\":2"),
            // Frozen V2 integrity rules: no missing terminal frame, skipped
            // chunk index, or bytes beyond the size announced in readiness.
            format!(
                "{}\n",
                complete_frames
                    .lines()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            complete_frames.replace("\"index\":0", "\"index\":1"),
            complete_frames.replace("aW1hZ2U=", "aW1hZ2Vz"),
        ] {
            let mut reader = tokio::io::BufReader::new(invalid.as_bytes());
            let mut partial = Vec::new();
            assert!(matches!(
                read_conversation_image_after_request(
                    &mut reader,
                    1_024 * 1_024,
                    "request",
                    "epoch",
                    "work",
                    "content",
                    "image/png",
                    &mut partial,
                )
                .await,
                Err(ClientError::Protocol(_))
            ));
            // Do not write an overrun to the provisional sink and only notice
            // it later at complete: readiness announced exactly five bytes.
            assert!(partial.len() <= 5);
        }
        // Explicit disk-full boundary: a completed wire transfer cannot become
        // valid cache content when its provisional sink cannot flush the bytes.
        #[cfg(target_os = "linux")]
        {
            let mut full = tokio::fs::OpenOptions::new()
                .write(true)
                .open("/dev/full")
                .await
                .unwrap();
            let result = read_conversation_image_after_request(
                &mut complete_frames.as_bytes(),
                1_024 * 1_024,
                "request",
                "epoch",
                "work",
                "content",
                "image/png",
                &mut full,
            )
            .await;
            assert!(matches!(result, Err(ClientError::Storage { .. })));
        }
    }
}
