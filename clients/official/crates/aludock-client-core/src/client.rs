use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    ClientError, ClientIdentity, Endpoint, HostConnectionProfile, IdentityStore, PairingMetadata,
    Result,
    tls::{ConnectedTls, connect_tls, read_json_line, write_json_line},
    wire::decode_canonical_base64,
};

const MAX_CONTROL_LINE_BYTES: usize = 1024 * 1024;
const MAX_DOCK_TRANSFER_BYTES: usize = 256 * 1024 * 1024;
const MAX_RESPONSE_TRANSFER_CHUNK_BYTES: usize = 512 * 1024;
const MAX_RESPONSE_TRANSFER_CHUNKS: usize =
    MAX_DOCK_TRANSFER_BYTES.div_ceil(MAX_RESPONSE_TRANSFER_CHUNK_BYTES);
const RESPONSE_TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const CATALOG_SCHEMA_VERSION: u64 = 1;

#[derive(Clone)]
pub struct DockClient {
    endpoints: Vec<Endpoint>,
    identity: ClientIdentity,
    host_certificate: Vec<u8>,
    metadata: PairingMetadata,
}

impl DockClient {
    pub fn from_store(store: &IdentityStore, endpoint_override: Option<Endpoint>) -> Result<Self> {
        let paired = store.load_pairing()?;
        let endpoint = endpoint_override.unwrap_or_else(|| paired.metadata.endpoint.clone());
        Ok(Self {
            endpoints: vec![endpoint],
            identity: paired.identity,
            host_certificate: paired.host_certificate,
            metadata: paired.metadata,
        })
    }

    /// Builds a client that can safely try multiple addresses for one paired Host.
    /// Every address is still authenticated against the same exact Host certificate.
    pub fn from_store_endpoints(
        store: &IdentityStore,
        endpoints: impl IntoIterator<Item = Endpoint>,
    ) -> Result<Self> {
        let paired = store.load_pairing()?;
        let mut endpoints = endpoints.into_iter().collect::<Vec<_>>();
        endpoints.dedup();
        if endpoints.is_empty() {
            return Err(ClientError::InvalidEndpoint(
                "at least one Host address is required".into(),
            ));
        }
        Ok(Self {
            endpoints,
            identity: paired.identity,
            host_certificate: paired.host_certificate,
            metadata: paired.metadata,
        })
    }

    pub fn from_connection_profile(
        store: &IdentityStore,
        profile: &HostConnectionProfile,
    ) -> Result<Self> {
        Self::from_store_endpoints(
            store,
            profile
                .ordered_verified_endpoints()
                .into_iter()
                .map(|candidate| candidate.endpoint.clone()),
        )
    }

    pub fn from_connection_profile_preferred(
        store: &IdentityStore,
        profile: &HostConnectionProfile,
        preferred_endpoint_id: &str,
    ) -> Result<Self> {
        let ordered = profile.ordered_verified_endpoints();
        let preferred = ordered
            .iter()
            .find(|candidate| candidate.id == preferred_endpoint_id)
            .ok_or_else(|| {
                ClientError::InvalidEndpoint("preferred Host address is not verified".into())
            })?;
        let endpoints = std::iter::once(preferred.endpoint.clone()).chain(
            ordered
                .into_iter()
                .filter(|candidate| candidate.id != preferred_endpoint_id)
                .map(|candidate| candidate.endpoint.clone()),
        );
        Self::from_store_endpoints(store, endpoints)
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoints[0]
    }

    pub fn endpoints(&self) -> &[Endpoint] {
        &self.endpoints
    }

    pub(crate) async fn request<P, R>(
        &self,
        request_type: &'static str,
        params: &P,
        required_capabilities: &[&str],
        operation_id: Option<&str>,
    ) -> Result<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        self.request_with_host_epoch(request_type, params, required_capabilities, operation_id)
            .await
            .map(|(result, _)| result)
    }

    pub(crate) async fn request_with_host_epoch<P, R>(
        &self,
        request_type: &'static str,
        params: &P,
        required_capabilities: &[&str],
        operation_id: Option<&str>,
    ) -> Result<(R, String)>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let (mut connection, hello) = self.negotiate(required_capabilities).await?;
        let request_id = Uuid::new_v4().to_string();
        let request = RequestEnvelope {
            kind: "request",
            version: 2,
            request_id: &request_id,
            request_type,
            params,
        };
        if let Err(error) = write_json_line(&mut connection.stream, &request).await {
            return Err(ambiguous_if_mutation(error, operation_id));
        }
        let response = if request_type == "session.tree" {
            read_response_envelope(
                &mut connection.stream,
                maximum_line_bytes(&hello),
                &request_id,
                &hello.host.host_epoch,
            )
            .await
        } else {
            read_json_line(&mut connection.stream, maximum_line_bytes(&hello)).await
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => return Err(ambiguous_if_mutation(error, operation_id)),
        };
        validate_response_envelope(&response, &request_id, &hello.host.host_epoch)
            .map_err(|error| ambiguous_if_mutation(error, operation_id))?;
        let result = response_result(response, request_type, operation_id)?;
        Ok((result, hello.host.host_epoch))
    }

    pub(crate) async fn open_event_stream<P, R>(
        &self,
        request_type: &'static str,
        params: &P,
        required_capabilities: &[&str],
    ) -> Result<(R, ProtocolEventStream)>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let (mut connection, hello) = self.negotiate(required_capabilities).await?;
        let request_id = Uuid::new_v4().to_string();
        write_json_line(
            &mut connection.stream,
            &RequestEnvelope {
                kind: "request",
                version: 2,
                request_id: &request_id,
                request_type,
                params,
            },
        )
        .await?;
        let maximum_bytes = maximum_line_bytes(&hello);
        let response: ResponseEnvelope =
            read_json_line(&mut connection.stream, maximum_bytes).await?;
        validate_response_envelope(&response, &request_id, &hello.host.host_epoch)?;
        let result = response_result(response, request_type, None)?;
        Ok((
            result,
            ProtocolEventStream {
                connection,
                request_id,
                host_epoch: hello.host.host_epoch,
                maximum_bytes,
            },
        ))
    }

    pub(crate) async fn negotiate(
        &self,
        required_capabilities: &[&str],
    ) -> Result<(ConnectedTls, HelloAck)> {
        let mut failures = Vec::new();
        for endpoint in &self.endpoints {
            match self
                .negotiate_endpoint(endpoint, required_capabilities)
                .await
            {
                Ok(negotiated) => return Ok(negotiated),
                Err(error) => failures.push(format!("{endpoint}: {error}")),
            }
        }
        Err(ClientError::Protocol(format!(
            "none of the saved addresses reached the paired Host ({})",
            failures.join("; ")
        )))
    }

    async fn negotiate_endpoint(
        &self,
        endpoint: &Endpoint,
        required_capabilities: &[&str],
    ) -> Result<(ConnectedTls, HelloAck)> {
        let mut connection =
            connect_tls(endpoint, &self.identity, Some(&self.host_certificate)).await?;
        let request_id = Uuid::new_v4().to_string();
        write_json_line(
            &mut connection.stream,
            &ClientHello {
                kind: "hello",
                request_id: &request_id,
                versions: [2],
                client: ClientDescription {
                    name: "aludock-client",
                    version: env!("CARGO_PKG_VERSION"),
                    client_id: &self.metadata.client_id,
                },
                required_capabilities,
            },
        )
        .await?;
        let reply: HelloReply =
            read_json_line(&mut connection.stream, MAX_CONTROL_LINE_BYTES).await?;
        let hello = validate_hello(reply, &request_id, required_capabilities)?;
        Ok((connection, hello))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResponseTransferFrame {
    kind: String,
    version: u8,
    request_id: String,
    host_epoch: String,
    index: usize,
    count: usize,
    data: String,
}

async fn read_response_envelope<R: AsyncRead + Unpin>(
    stream: &mut R,
    maximum_line_bytes: usize,
    request_id: &str,
    host_epoch: &str,
) -> Result<ResponseEnvelope> {
    let mut reader = BufReader::new(stream);
    let first: Value = read_response_line(&mut reader, maximum_line_bytes).await?;
    if first.get("kind").and_then(Value::as_str) != Some("response_transfer") {
        let response: ResponseEnvelope = serde_json::from_value(first).map_err(|error| {
            ClientError::Protocol(format!("invalid response envelope: {error}"))
        })?;
        if response.ok {
            return Err(protocol(
                "session tree success did not use response transfer framing",
            ));
        }
        return Ok(response);
    }
    let mut expected_count = None;
    let mut next_index = 0_usize;
    let mut bytes = Vec::new();
    let mut raw = first;
    loop {
        let frame: ResponseTransferFrame = serde_json::from_value(raw)
            .map_err(|error| protocol(format!("invalid response transfer frame: {error}")))?;
        if frame.kind != "response_transfer"
            || frame.version != 2
            || frame.request_id != request_id
            || frame.host_epoch != host_epoch
            || frame.count == 0
            || frame.count > MAX_RESPONSE_TRANSFER_CHUNKS
            || frame.index >= frame.count
        {
            return Err(protocol(
                "response transfer identity, version, index, or count was invalid",
            ));
        }
        if expected_count.is_none() && frame.index != 0 {
            return Err(protocol("response transfer did not begin with chunk zero"));
        }
        let count = *expected_count.get_or_insert(frame.count);
        if frame.count != count || frame.index != next_index {
            return Err(protocol(
                "response transfer chunks were inconsistent or out of order",
            ));
        }
        let chunk = decode_canonical_base64(
            &frame.data,
            MAX_RESPONSE_TRANSFER_CHUNK_BYTES,
            "response transfer data",
        )?;
        let aggregate = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| protocol("response transfer size overflowed"))?;
        if aggregate > MAX_DOCK_TRANSFER_BYTES {
            return Err(protocol("response transfer exceeded its aggregate bound"));
        }
        bytes.extend_from_slice(&chunk);
        next_index += 1;
        if next_index == count {
            break;
        }
        raw = read_response_line(&mut reader, maximum_line_bytes).await?;
        if raw.get("kind").and_then(Value::as_str) != Some("response_transfer") {
            return Err(protocol(
                "response transfer ended before all chunks arrived",
            ));
        }
    }

    let response: ResponseEnvelope = serde_json::from_slice(&bytes)
        .map_err(|error| protocol(format!("response transfer was not valid JSON: {error}")))?;
    if !response.ok {
        return Err(protocol(
            "response transfer contained an unsuccessful response",
        ));
    }
    Ok(response)
}

async fn read_response_line<T: DeserializeOwned, R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    maximum_bytes: usize,
) -> Result<T> {
    let line = timeout(RESPONSE_TRANSFER_IDLE_TIMEOUT, async {
        let mut bytes = Vec::new();
        loop {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Err(ClientError::Protocol(
                    "TLS connection closed before a complete JSONL response".into(),
                ));
            }
            if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
                if bytes.len().saturating_add(newline) >= maximum_bytes {
                    return Err(protocol(format!(
                        "JSONL response exceeded {maximum_bytes} bytes"
                    )));
                }
                bytes.extend_from_slice(&available[..newline]);
                reader.consume(newline + 1);
                break;
            }
            if bytes.len().saturating_add(available.len()) >= maximum_bytes {
                return Err(protocol(format!(
                    "JSONL response exceeded {maximum_bytes} bytes"
                )));
            }
            let consumed = available.len();
            bytes.extend_from_slice(available);
            reader.consume(consumed);
        }
        serde_json::from_slice(&bytes).map_err(ClientError::from)
    })
    .await
    .map_err(|_| protocol("timed out while receiving a response transfer"))??;
    Ok(line)
}

fn protocol(message: impl Into<String>) -> ClientError {
    ClientError::Protocol(message.into())
}

pub(crate) struct ProtocolEventStream {
    connection: ConnectedTls,
    request_id: String,
    host_epoch: String,
    maximum_bytes: usize,
}

impl ProtocolEventStream {
    pub(crate) fn host_epoch(&self) -> &str {
        &self.host_epoch
    }

    pub(crate) async fn next<T: DeserializeOwned>(&mut self) -> Result<T> {
        let envelope: EventEnvelope =
            read_json_line(&mut self.connection.stream, self.maximum_bytes).await?;
        if envelope.kind != "event"
            || envelope.version != 2
            || envelope.request_id != self.request_id
            || envelope.host_epoch != self.host_epoch
        {
            return Err(ClientError::Protocol(
                "event correlation, version, or Host epoch was invalid".into(),
            ));
        }
        serde_json::from_value(envelope.event)
            .map_err(|error| ClientError::Protocol(format!("invalid event: {error}")))
    }
}

pub(crate) fn maximum_line_bytes(hello: &HelloAck) -> usize {
    hello
        .limits
        .max_line_bytes
        .min(MAX_CONTROL_LINE_BYTES as u64) as usize
}

pub(crate) fn validate_response_envelope(
    response: &ResponseEnvelope,
    request_id: &str,
    host_epoch: &str,
) -> Result<()> {
    if response.kind != "response"
        || response.version != 2
        || response.request_id != request_id
        || response.host_epoch != host_epoch
        || (response.ok && (response.result.is_none() || response.error.is_some()))
        || (!response.ok && (response.result.is_some() || response.error.is_none()))
    {
        return Err(ClientError::Protocol(
            "response correlation, version, or Host epoch was invalid".into(),
        ));
    }
    Ok(())
}

pub(crate) fn response_result<R: DeserializeOwned>(
    response: ResponseEnvelope,
    request_type: &str,
    operation_id: Option<&str>,
) -> Result<R> {
    if !response.ok {
        let error = response.error.unwrap_or(RemoteError {
            code: "unknown".into(),
            message: "Host returned an unsuccessful response without an error".into(),
            retryable: false,
            details: None,
        });
        if error.code == "effect_unknown"
            || (error.code == "operation_receipt_expired" && operation_id.is_some())
        {
            let reported_operation_id = error
                .details
                .as_ref()
                .and_then(|details| details.get("operationId"))
                .and_then(Value::as_str);
            let operation_id = match (operation_id, reported_operation_id) {
                (Some(expected), Some(reported)) if expected != reported => {
                    return Err(ClientError::EffectUnknown {
                        operation_id: expected.to_owned(),
                        message: "Host reported an unknown effect for a different operation ID"
                            .into(),
                    });
                }
                (Some(expected), _) => expected.to_owned(),
                (None, Some(reported)) => reported.to_owned(),
                (None, None) => "unknown".into(),
            };
            return Err(ClientError::EffectUnknown {
                operation_id,
                message: error.message,
            });
        }
        return Err(ClientError::Host {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details: error.details,
        });
    }
    let result = response
        .result
        .ok_or_else(|| ClientError::Protocol("successful response omitted its result".into()))?;
    serde_json::from_value(result).map_err(|error| {
        ambiguous_if_mutation(
            ClientError::Protocol(format!("invalid {request_type} result: {error}")),
            operation_id,
        )
    })
}

fn ambiguous_if_mutation(error: ClientError, operation_id: Option<&str>) -> ClientError {
    match operation_id {
        Some(operation_id) => ClientError::EffectUnknown {
            operation_id: operation_id.to_owned(),
            message: error.to_string(),
        },
        None => error,
    }
}

fn validate_hello(
    reply: HelloReply,
    request_id: &str,
    required_capabilities: &[&str],
) -> Result<HelloAck> {
    let ack = match reply {
        HelloReply::Ack(ack) if ack.kind == "hello_ack" => ack,
        HelloReply::Ack(_) => {
            return Err(ClientError::Protocol(
                "Host returned an invalid hello reply kind".into(),
            ));
        }
        HelloReply::Error(error)
            if error.kind == "hello_error" && error.request_id == request_id =>
        {
            return Err(ClientError::Protocol(format!(
                "hello failed ({}): {}",
                error.error.code, error.error.message
            )));
        }
        HelloReply::Error(_) => {
            return Err(ClientError::Protocol(
                "hello error correlation or kind was invalid".into(),
            ));
        }
    };
    if ack.request_id != request_id
        || ack.version != 2
        || ack.catalog_schema_version != CATALOG_SCHEMA_VERSION
    {
        return Err(ClientError::Protocol(
            "hello response correlation, version, or catalog schema was invalid".into(),
        ));
    }
    for capability in required_capabilities {
        if !ack.capabilities.iter().any(|value| value == capability) {
            return Err(ClientError::Protocol(format!(
                "hello response omitted required capability {capability}"
            )));
        }
    }
    Ok(ack)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientHello<'a> {
    kind: &'static str,
    request_id: &'a str,
    versions: [u8; 1],
    client: ClientDescription<'a>,
    required_capabilities: &'a [&'a str],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientDescription<'a> {
    name: &'static str,
    version: &'static str,
    client_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestEnvelope<'a, P> {
    kind: &'static str,
    version: u8,
    request_id: &'a str,
    #[serde(rename = "type")]
    request_type: &'static str,
    params: &'a P,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum HelloReply {
    Ack(HelloAck),
    Error(HelloError),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HelloAck {
    kind: String,
    request_id: String,
    version: u8,
    catalog_schema_version: u64,
    pub(crate) host: HelloHost,
    capabilities: Vec<String>,
    limits: ProtocolLimits,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HelloHost {
    pub(crate) host_epoch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolLimits {
    max_line_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloError {
    kind: String,
    request_id: String,
    error: HelloErrorBody,
}

#[derive(Deserialize)]
struct HelloErrorBody {
    code: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResponseEnvelope {
    kind: String,
    version: u8,
    request_id: String,
    host_epoch: String,
    ok: bool,
    result: Option<Value>,
    error: Option<RemoteError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventEnvelope {
    kind: String,
    version: u8,
    request_id: String,
    host_epoch: String,
    event: Value,
}

#[derive(Deserialize)]
struct RemoteError {
    code: String,
    message: String,
    retryable: bool,
    details: Option<Value>,
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::*;

    fn hello_ack(catalog_schema_version: u64) -> HelloAck {
        HelloAck {
            kind: "hello_ack".into(),
            request_id: "hello-request".into(),
            version: 2,
            catalog_schema_version,
            host: HelloHost {
                host_epoch: "epoch".into(),
            },
            capabilities: vec!["core.v2".into()],
            limits: ProtocolLimits {
                max_line_bytes: 1024,
            },
        }
    }

    fn failed_response(code: &str, operation_id: &str) -> ResponseEnvelope {
        ResponseEnvelope {
            kind: "response".into(),
            version: 2,
            request_id: "request".into(),
            host_epoch: "epoch".into(),
            ok: false,
            result: None,
            error: Some(RemoteError {
                code: code.into(),
                message: "result cannot be proven".into(),
                retryable: false,
                details: Some(serde_json::json!({
                    "operationId": operation_id,
                    "queryHint": "refresh"
                })),
            }),
        }
    }

    #[test]
    fn hello_requires_the_supported_catalog_schema() {
        assert!(
            validate_hello(HelloReply::Ack(hello_ack(1)), "hello-request", &["core.v2"]).is_ok()
        );
        assert!(
            validate_hello(HelloReply::Ack(hello_ack(2)), "hello-request", &["core.v2"]).is_err()
        );
    }

    #[tokio::test]
    async fn tree_success_requires_complete_transfer_before_business_parsing() {
        let logical = serde_json::json!({
            "kind": "response",
            "version": 2,
            "requestId": "tree-request",
            "hostEpoch": "epoch",
            "ok": true,
            "result": {
                "nodes": [{
                    "entryId": "root",
                    "depth": 0,
                    "kind": "message",
                    "role": "user",
                    "displayClass": "content",
                    "summary": "hello",
                    "hasChildren": false
                }],
                "leafId": "root"
            }
        });
        let bytes = serde_json::to_vec(&logical).unwrap();
        let chunks = bytes.chunks(48).collect::<Vec<_>>();
        let (mut client, mut host) = tokio::io::duplex(16 * 1024);
        for (index, chunk) in chunks.iter().enumerate() {
            write_json_line(
                &mut host,
                &serde_json::json!({
                    "kind": "response_transfer",
                    "version": 2,
                    "requestId": "tree-request",
                    "hostEpoch": "epoch",
                    "index": index,
                    "count": chunks.len(),
                    "data": STANDARD.encode(chunk),
                }),
            )
            .await
            .unwrap();
        }
        drop(host);

        let response =
            read_response_envelope(&mut client, MAX_CONTROL_LINE_BYTES, "tree-request", "epoch")
                .await
                .unwrap();
        validate_response_envelope(&response, "tree-request", "epoch").unwrap();
        assert_eq!(
            response.result.unwrap()["leafId"],
            "root",
            "the caller receives one complete logical Tree instead of transport chunks"
        );

        let (mut client, mut host) = tokio::io::duplex(4 * 1024);
        write_json_line(&mut host, &logical).await.unwrap();
        drop(host);
        assert!(
            read_response_envelope(&mut client, MAX_CONTROL_LINE_BYTES, "tree-request", "epoch",)
                .await
                .is_err(),
            "an ordinary success response cannot bypass mandatory Tree transfer framing"
        );
    }

    #[test]
    fn uncertain_write_keeps_the_callers_operation_id() {
        let error = response_result::<Value>(
            failed_response("effect_unknown", "different-operation"),
            "settings.update",
            Some("original-operation"),
        )
        .expect_err("mismatched uncertainty must fail closed");
        assert!(matches!(
            error,
            ClientError::EffectUnknown { operation_id, .. }
                if operation_id == "original-operation"
        ));
    }

    #[test]
    fn expired_mutation_receipt_is_not_treated_as_a_replayable_host_error() {
        let error = response_result::<Value>(
            failed_response("operation_receipt_expired", "original-operation"),
            "tool.set_active",
            Some("original-operation"),
        )
        .expect_err("an expired write receipt is ambiguous");
        assert!(matches!(
            error,
            ClientError::EffectUnknown { operation_id, .. }
                if operation_id == "original-operation"
        ));
    }
}
