use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncWrite};
use uuid::Uuid;

use crate::{
    ClientError, DockClient, Result,
    capabilities::INSTANCE_DELIVERABLES as REQUIRED_CAPABILITIES,
    client::{ResponseEnvelope, maximum_line_bytes, response_result, validate_response_envelope},
    tls::write_json_line,
};

pub use crate::file_transfer::{
    MAX_SOURCE_FILE_TRANSFER_BYTES as MAX_TEMPORARY_DELIVERABLE_BYTES,
    MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES as MAX_DELIVERABLE_CHUNK_BYTES,
};
pub const MAX_TEMPORARY_DELIVERABLES_PER_INSTANCE: usize = 1_024;
const MAX_INSTANCE_ID_CHARS: usize = 128;
const MAX_DELIVERY_REF_CHARS: usize = 128;
const MAX_DELIVERABLE_NAME_CHARS: usize = 512;
const MAX_ERROR_MESSAGE_CHARS: usize = 2_048;

/// Path-free metadata for one temporary file registered by an Agent.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverableDto {
    pub delivery_ref: String,
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliverableDtoWire {
    delivery_ref: String,
    name: String,
    size_bytes: u64,
}

impl<'de> Deserialize<'de> for DeliverableDto {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = DeliverableDtoWire::deserialize(deserializer)?;
        let value = Self {
            delivery_ref: wire.delivery_ref,
            name: wire.name,
            size_bytes: wire.size_bytes,
        };
        value.validate().map_err(D::Error::custom)?;
        Ok(value)
    }
}

impl DeliverableDto {
    pub fn validate(&self) -> Result<()> {
        if !safe_text(&self.delivery_ref, MAX_DELIVERY_REF_CHARS)
            || !safe_deliverable_name(&self.name)
            || self.size_bytes > MAX_TEMPORARY_DELIVERABLE_BYTES
        {
            return Err(protocol("temporary file metadata was invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverableDownloadResult {
    pub deliverable: DeliverableDto,
    pub chunks: u64,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeliverableDownloadProgress {
    pub bytes_received: u64,
    pub total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliverableParams<'a> {
    instance_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliverableDownloadParams<'a> {
    instance_id: &'a str,
    delivery_ref: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliverableDownloadRequest<'a> {
    kind: &'static str,
    version: u8,
    request_id: &'a str,
    #[serde(rename = "type")]
    request_type: &'static str,
    params: DeliverableDownloadParams<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliverableListResult {
    instance_id: String,
    deliverables: Vec<DeliverableDto>,
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum DeliverableDownloadFrame {
    #[serde(rename = "deliverable_download_ready")]
    Ready {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "deliveryRef")]
        delivery_ref: String,
        deliverable: DeliverableDto,
    },
    #[serde(rename = "deliverable_download_chunk")]
    Chunk {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "deliveryRef")]
        delivery_ref: String,
        index: u64,
        data: String,
    },
    #[serde(rename = "deliverable_download_complete")]
    Complete {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "deliveryRef")]
        delivery_ref: String,
        chunks: u64,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        sha256: String,
    },
    #[serde(rename = "deliverable_download_error")]
    Error {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "deliveryRef")]
        delivery_ref: String,
        error: DeliverableDownloadError,
    },
}

#[derive(Deserialize)]
struct DeliverableDownloadError {
    code: String,
    message: String,
}

impl DockClient {
    pub async fn list_deliverables(&self, instance_id: &str) -> Result<Vec<DeliverableDto>> {
        let result: DeliverableListResult = self
            .request(
                "deliverable.list",
                &DeliverableParams { instance_id },
                REQUIRED_CAPABILITIES,
                None,
            )
            .await?;
        if result.instance_id != instance_id
            || result.deliverables.len() > MAX_TEMPORARY_DELIVERABLES_PER_INSTANCE
        {
            return Err(protocol("temporary file list belonged to another work"));
        }
        let mut refs = HashSet::with_capacity(result.deliverables.len());
        if result
            .deliverables
            .iter()
            .any(|item| !refs.insert(item.delivery_ref.as_str()))
        {
            return Err(protocol(
                "temporary file list contained duplicate references",
            ));
        }
        Ok(result.deliverables)
    }

    /// Streams one temporary delivery into a caller-owned provisional sink.
    /// The caller must discard the sink on every error and commit it only after
    /// this method returns success.
    pub async fn download_deliverable<W, F>(
        &self,
        instance_id: &str,
        delivery_ref: &str,
        sink: &mut W,
        mut on_progress: F,
    ) -> Result<DeliverableDownloadResult>
    where
        W: AsyncWrite + Unpin,
        F: FnMut(DeliverableDownloadProgress),
    {
        if !safe_text(instance_id, MAX_INSTANCE_ID_CHARS)
            || !safe_text(delivery_ref, MAX_DELIVERY_REF_CHARS)
        {
            return Err(protocol("temporary file request identity was invalid"));
        }
        let total = std::sync::atomic::AtomicU64::new(0);
        let mut accepted_delivery = None;
        if let Some(file) = self
            .read_file_stream(
                "deliverable.download",
                &DeliverableDownloadParams {
                    instance_id,
                    delivery_ref,
                },
                REQUIRED_CAPABILITIES,
                MAX_TEMPORARY_DELIVERABLE_BYTES,
                sink,
                |metadata| {
                    let delivery: DeliverableDto =
                        serde_json::from_value(metadata["deliverable"].clone())?;
                    if delivery.delivery_ref != delivery_ref {
                        return Err(protocol("File belongs to another delivery"));
                    }
                    total.store(delivery.size_bytes, std::sync::atomic::Ordering::Relaxed);
                    accepted_delivery = Some(delivery);
                    Ok(())
                },
                |bytes_received| {
                    on_progress(DeliverableDownloadProgress {
                        bytes_received,
                        total_bytes: total.load(std::sync::atomic::Ordering::Relaxed),
                    })
                },
            )
            .await?
        {
            let deliverable: DeliverableDto =
                serde_json::from_value(file.result["deliverable"].clone())?;
            if accepted_delivery.as_ref() != Some(&deliverable)
                || file.summary.size_bytes != deliverable.size_bytes
            {
                return Err(protocol(
                    "File completion differs from the accepted delivery",
                ));
            }
            return Ok(DeliverableDownloadResult {
                deliverable,
                chunks: file.summary.chunks,
                size_bytes: file.summary.size_bytes,
                sha256: file.summary.sha256,
            });
        }
        let routed = self.negotiate(REQUIRED_CAPABILITIES).await?;
        let endpoint_id = routed.endpoint_id;
        let route_generation = routed.route_generation;
        let mut connection = routed.connection;
        let hello = routed.hello;
        let request_id = Uuid::new_v4().to_string();
        if let Err(error) = write_json_line(
            &mut connection.stream,
            &DeliverableDownloadRequest {
                kind: "request",
                version: 2,
                request_id: &request_id,
                request_type: "deliverable.download",
                params: DeliverableDownloadParams {
                    instance_id,
                    delivery_ref,
                },
            },
        )
        .await
        {
            self.router()
                .report_connection_failure(&endpoint_id, route_generation);
            return Err(error);
        }
        let result = download_after_request(
            &mut connection.stream,
            sink,
            maximum_line_bytes(&hello),
            &request_id,
            &hello.host.host_epoch,
            instance_id,
            delivery_ref,
            &mut on_progress,
        )
        .await;
        if result.is_err() {
            self.router()
                .report_connection_failure(&endpoint_id, route_generation);
        } else {
            self.router().ensure_open()?;
        }
        result
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_after_request<S, W, F>(
    stream: &mut S,
    sink: &mut W,
    maximum_line_bytes: usize,
    request_id: &str,
    host_epoch: &str,
    instance_id: &str,
    delivery_ref: &str,
    on_progress: &mut F,
) -> Result<DeliverableDownloadResult>
where
    S: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(DeliverableDownloadProgress),
{
    use crate::file_transfer::{LegacyFileFrame, receive_legacy_file};
    let (deliverable, summary) = receive_legacy_file(
        stream,
        sink,
        maximum_line_bytes,
        MAX_TEMPORARY_DELIVERABLE_BYTES,
        MAX_DELIVERABLE_CHUNK_BYTES,
        |raw| {
            if raw.get("kind").and_then(Value::as_str) == Some("response") {
                let response: ResponseEnvelope = serde_json::from_value(raw)?;
                validate_response_envelope(&response, request_id, host_epoch)?;
                let _: Value = response_result(response, "deliverable.download", None)?;
                return Err(protocol("File returned ordinary success"));
            }
            Ok(
                match parse_frame(raw, request_id, host_epoch, instance_id, delivery_ref)? {
                    DeliverableDownloadFrame::Ready { deliverable, .. } => {
                        LegacyFileFrame::Ready(deliverable)
                    }
                    DeliverableDownloadFrame::Chunk { index, data, .. } => {
                        LegacyFileFrame::Chunk(index, data)
                    }
                    DeliverableDownloadFrame::Complete {
                        chunks,
                        size_bytes,
                        sha256,
                        ..
                    } => LegacyFileFrame::Complete(chunks, size_bytes, sha256),
                    DeliverableDownloadFrame::Error { error, .. } => {
                        LegacyFileFrame::Error(download_error(error))
                    }
                },
            )
        },
        |metadata: &DeliverableDto| {
            if metadata.delivery_ref != delivery_ref {
                return Err(protocol("File belongs to another delivery"));
            }
            Ok(())
        },
        |bytes_received, metadata| {
            on_progress(DeliverableDownloadProgress {
                bytes_received,
                total_bytes: metadata.size_bytes,
            })
        },
    )
    .await?;
    if summary.size_bytes != deliverable.size_bytes {
        return Err(protocol("File size changed"));
    }
    Ok(DeliverableDownloadResult {
        deliverable,
        chunks: summary.chunks,
        size_bytes: summary.size_bytes,
        sha256: summary.sha256,
    })
}

fn parse_frame(
    raw: Value,
    request_id: &str,
    host_epoch: &str,
    instance_id: &str,
    delivery_ref: &str,
) -> Result<DeliverableDownloadFrame> {
    let frame: DeliverableDownloadFrame = serde_json::from_value(raw)
        .map_err(|error| protocol(format!("invalid temporary file download frame: {error}")))?;
    let (version, frame_request, frame_epoch, frame_instance, frame_delivery) = match &frame {
        DeliverableDownloadFrame::Ready {
            version,
            request_id,
            host_epoch,
            instance_id,
            delivery_ref,
            ..
        }
        | DeliverableDownloadFrame::Chunk {
            version,
            request_id,
            host_epoch,
            instance_id,
            delivery_ref,
            ..
        }
        | DeliverableDownloadFrame::Complete {
            version,
            request_id,
            host_epoch,
            instance_id,
            delivery_ref,
            ..
        }
        | DeliverableDownloadFrame::Error {
            version,
            request_id,
            host_epoch,
            instance_id,
            delivery_ref,
            ..
        } => (*version, request_id, host_epoch, instance_id, delivery_ref),
    };
    if version != 2
        || frame_request != request_id
        || frame_epoch != host_epoch
        || frame_instance != instance_id
        || frame_delivery != delivery_ref
    {
        return Err(protocol(
            "temporary file download identity or Host state was invalid",
        ));
    }
    Ok(frame)
}

fn download_error(error: DeliverableDownloadError) -> ClientError {
    if error.code != "file_unavailable" || !safe_text(&error.message, MAX_ERROR_MESSAGE_CHARS) {
        return protocol("temporary file download returned an invalid error");
    }
    ClientError::Host {
        code: error.code,
        message: error.message,
        retryable: false,
        details: None,
    }
}

fn safe_text(value: &str, maximum_chars: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum_chars
        && !value.chars().any(char::is_control)
}

fn safe_deliverable_name(value: &str) -> bool {
    safe_text(value, MAX_DELIVERABLE_NAME_CHARS)
        && !value
            .chars()
            .any(|character| matches!(character, '/' | '\\'))
}

fn protocol(message: impl Into<String>) -> ClientError {
    ClientError::Protocol(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncWriteExt, duplex};

    async fn send_download(host: &mut tokio::io::DuplexStream, digest: &str) {
        for frame in [
            json!({
                "kind": "deliverable_download_ready",
                "version": 2,
                "requestId": "request",
                "hostEpoch": "epoch",
                "instanceId": "work",
                "deliveryRef": "delivery-1",
                "deliverable": { "deliveryRef": "delivery-1", "name": "hello.txt", "sizeBytes": 5, "futureDeliverableField": true },
                "futureFrameField": true
            }),
            json!({
                "kind": "deliverable_download_chunk",
                "version": 2,
                "requestId": "request",
                "hostEpoch": "epoch",
                "instanceId": "work",
                "deliveryRef": "delivery-1",
                "index": 0,
                "data": "aGVs",
                "futureFrameField": true
            }),
            json!({
                "kind": "deliverable_download_chunk",
                "version": 2,
                "requestId": "request",
                "hostEpoch": "epoch",
                "instanceId": "work",
                "deliveryRef": "delivery-1",
                "index": 1,
                "data": "bG8=",
                "futureFrameField": true
            }),
            json!({
                "kind": "deliverable_download_complete",
                "version": 2,
                "requestId": "request",
                "hostEpoch": "epoch",
                "instanceId": "work",
                "deliveryRef": "delivery-1",
                "chunks": 2,
                "sizeBytes": 5,
                "sha256": digest,
                "futureFrameField": true
            }),
        ] {
            write_json_line(host, &frame).await.unwrap();
        }
        host.shutdown().await.unwrap();
    }

    #[test]
    fn delivery_responses_and_error_frames_accept_additive_host_metadata() {
        let list: DeliverableListResult = serde_json::from_value(json!({
            "instanceId":"work",
            "deliverables":[{
                "deliveryRef":"delivery-1", "name":"hello.txt", "sizeBytes":5,
                "futureDeliverableField":true
            }],
            "futureResultField":true
        }))
        .unwrap();
        assert_eq!(list.deliverables[0].name, "hello.txt");

        let error = parse_frame(
            json!({
                "kind":"deliverable_download_error", "version":2, "requestId":"request",
                "hostEpoch":"epoch", "instanceId":"work", "deliveryRef":"delivery-1",
                "error":{"code":"file_unavailable", "message":"gone", "futureErrorField":true},
                "futureFrameField":true
            }),
            "request",
            "epoch",
            "work",
            "delivery-1",
        )
        .unwrap();
        assert!(matches!(error, DeliverableDownloadFrame::Error { .. }));
        assert!(
            parse_frame(
                json!({
                    "kind":"deliverable_download_future", "version":2, "requestId":"request",
                    "hostEpoch":"epoch", "instanceId":"work", "deliveryRef":"delivery-1"
                }),
                "request",
                "epoch",
                "work",
                "delivery-1"
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn downloading_a_delivery_writes_the_exact_verified_file() {
        let (client, mut host) = duplex(16 * 1024);
        let mut client = tokio::io::BufReader::new(client);
        let host_task = tokio::spawn(async move {
            send_download(
                &mut host,
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            )
            .await;
        });
        let mut bytes = Vec::new();
        let mut progress = Vec::new();
        let result = download_after_request(
            &mut client,
            &mut bytes,
            1024 * 1024,
            "request",
            "epoch",
            "work",
            "delivery-1",
            &mut |value| progress.push(value),
        )
        .await
        .unwrap();
        host_task.await.unwrap();

        assert_eq!(bytes, b"hello");
        assert_eq!(result.deliverable.name, "hello.txt");
        assert_eq!(result.chunks, 2);
        assert_eq!(progress.last().unwrap().bytes_received, 5);
    }

    #[tokio::test]
    async fn a_delivery_with_the_wrong_digest_is_not_accepted() {
        let (client, mut host) = duplex(16 * 1024);
        let mut client = tokio::io::BufReader::new(client);
        let host_task = tokio::spawn(async move {
            send_download(&mut host, &"0".repeat(64)).await;
        });
        let mut bytes = Vec::new();
        let error = download_after_request(
            &mut client,
            &mut bytes,
            1024 * 1024,
            "request",
            "epoch",
            "work",
            "delivery-1",
            &mut |_| {},
        )
        .await
        .unwrap_err();
        host_task.await.unwrap();

        assert!(matches!(error, ClientError::Protocol(message) if message.contains("SHA-256")));
    }
}
