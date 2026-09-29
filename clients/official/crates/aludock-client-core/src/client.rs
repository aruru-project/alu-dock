use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::{
    io::AsyncBufRead,
    time::{Instant, timeout, timeout_at},
};
use uuid::Uuid;

use crate::{
    ClientError, ConnectionRouter, Endpoint, Result,
    local_transport::LocalDockEndpoint,
    timing::{
        CONTROL_RESPONSE_TIMEOUT, LONG_MUTATION_RESPONSE_TIMEOUT, RESPONSE_TRANSFER_IDLE_TIMEOUT,
    },
    tls::{ConnectedTransport, PinnedTlsConnector, read_json_line, write_json_line},
    wire::{
        MAX_CONTROL_BASE64_CHUNK_BYTES as MAX_RESPONSE_TRANSFER_CHUNK_BYTES,
        decode_canonical_base64, read_timed_json_line,
    },
};

pub(crate) const MAX_CONTROL_LINE_BYTES: usize = 1024 * 1024;
const CLIENT_VERSION: &str = match option_env!("ALUDOCK_RELEASE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
pub(crate) const MAX_DOCK_TRANSFER_BYTES: usize = 256 * 1024 * 1024;
const MAX_RESPONSE_TRANSFER_CHUNKS: usize =
    MAX_DOCK_TRANSFER_BYTES.div_ceil(MAX_RESPONSE_TRANSFER_CHUNK_BYTES);
pub(crate) const CATALOG_SCHEMA_VERSION: u64 = 1;

#[derive(Clone)]
pub struct DockClient {
    router: ConnectionRouter,
    expected_host_epoch: Option<String>,
}

impl DockClient {
    pub fn new(router: ConnectionRouter) -> Self {
        Self {
            router,
            expected_host_epoch: None,
        }
    }

    /// Freeze the intended Host incarnation for unary requests through this clone.
    /// The existing handshake fence runs before any request bytes are sent.
    pub fn with_host_epoch(&self, host_epoch: impl Into<String>) -> Self {
        Self {
            router: self.router.clone(),
            expected_host_epoch: Some(host_epoch.into()),
        }
    }

    pub fn router(&self) -> &ConnectionRouter {
        &self.router
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
        self.request_with_host_epoch_fenced(
            request_type,
            params,
            required_capabilities,
            operation_id,
            None,
        )
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
        self.request_with_host_epoch_fenced(
            request_type,
            params,
            required_capabilities,
            operation_id,
            None,
        )
        .await
    }

    pub(crate) async fn request_on_host_epoch<P, R>(
        &self,
        request_type: &'static str,
        params: &P,
        required_capabilities: &[&str],
        operation_id: Option<&str>,
        expected_host_epoch: &str,
    ) -> Result<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        self.request_with_host_epoch_fenced(
            request_type,
            params,
            required_capabilities,
            operation_id,
            Some(expected_host_epoch),
        )
        .await
        .map(|(result, _)| result)
    }

    async fn request_with_host_epoch_fenced<P, R>(
        &self,
        request_type: &'static str,
        params: &P,
        required_capabilities: &[&str],
        operation_id: Option<&str>,
        expected_host_epoch: Option<&str>,
    ) -> Result<(R, String)>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let request_deadline = Instant::now() + response_timeout_for(request_type);
        let routed = self.negotiate(required_capabilities).await?;
        if expected_host_epoch
            .or(self.expected_host_epoch.as_deref())
            .is_some_and(|expected| routed.hello.host.host_epoch.as_str() != expected)
        {
            return Err(ClientError::Protocol(
                "Host changed before the request began".into(),
            ));
        }
        let endpoint_id = routed.endpoint_id;
        let route_generation = routed.route_generation;
        let mut connection = routed.connection;
        let hello = routed.hello;
        let request_id = Uuid::new_v4().to_string();
        let request = RequestEnvelope {
            kind: "request",
            version: 2,
            request_id: &request_id,
            request_type,
            params,
        };
        let write_result = timeout_at(
            request_deadline,
            write_json_line(&mut connection.stream, &request),
        )
        .await
        .map_err(|_| ClientError::Protocol("control request timed out".into()))
        .and_then(|result| result);
        if let Err(error) = write_result {
            self.router
                .report_connection_failure(&endpoint_id, route_generation);
            return Err(ambiguous_if_mutation(error, operation_id));
        }
        let response = timeout_at(request_deadline, async {
            if request_type == "session.tree" {
                read_response_envelope(
                    &mut connection.stream,
                    maximum_line_bytes(&hello),
                    &request_id,
                    &hello.host.host_epoch,
                )
                .await
            } else {
                read_json_line(&mut connection.stream, maximum_line_bytes(&hello)).await
            }
        })
        .await
        .map_err(|_| ClientError::Protocol("control response timed out".into()))
        .and_then(|response| response);
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.router
                    .report_connection_failure(&endpoint_id, route_generation);
                return Err(ambiguous_if_mutation(error, operation_id));
            }
        };
        if let Err(error) =
            validate_response_envelope(&response, &request_id, &hello.host.host_epoch)
        {
            self.router
                .report_connection_failure(&endpoint_id, route_generation);
            return Err(ambiguous_if_mutation(error, operation_id));
        }
        if let Err(error) = self.router.ensure_open() {
            return Err(ambiguous_if_mutation(error, operation_id));
        }
        let result = response_result(response, request_type, operation_id)?;
        Ok((result, hello.host.host_epoch))
    }

    pub(crate) async fn open_instance_records<P: Serialize, R: DeserializeOwned>(
        &self,
        request_type: &'static str,
        params: &P,
        capabilities: &[&str],
        context: &crate::InstanceDeliveryContext,
    ) -> Result<(R, ProtocolEventStream)> {
        let mut params = serde_json::to_value(params)?;
        params["delivery"] = Value::String("records".into());
        let mut required = capabilities.to_vec();
        required.push(crate::instance_records::CAPABILITY);
        let routed = self.negotiate(&required).await?;
        let request_id = Uuid::new_v4().to_string();
        let maximum_bytes = maximum_line_bytes(&routed.hello);
        let host_epoch = routed.hello.host.host_epoch;
        let mut connection = routed.connection;
        let received: Result<(R, crate::instance_records::InstanceRecords)> = async {
            write_json_line(
                &mut connection.stream,
                &RequestEnvelope {
                    kind: "request",
                    version: 2,
                    request_id: &request_id,
                    request_type,
                    params: &params,
                },
            )
            .await?;
            let mut records = crate::instance_records::InstanceRecords::new(
                connection,
                request_id.clone(),
                host_epoch.clone(),
                maximum_bytes,
                context.clone(),
            );
            let value = records.initial(request_type == "instance.read").await?;
            Ok((serde_json::from_value(value)?, records))
        }
        .await;
        let (result, records) = received.map_err(|error| {
            // A business refusal (including optional capability negotiation) is
            // not evidence that this address failed. Transport/protocol errors are.
            if !matches!(&error, ClientError::Host { .. }) {
                self.router
                    .report_connection_failure(&routed.endpoint_id, routed.route_generation);
            }
            error
        })?;
        self.router.ensure_open()?;
        Ok((
            result,
            ProtocolEventStream {
                connection: None,
                records: Some(records),
                request_id,
                host_epoch,
                maximum_bytes,
                router: self.router.clone(),
                endpoint_id: routed.endpoint_id,
                route_generation: routed.route_generation,
            },
        ))
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
        let request_deadline = Instant::now() + CONTROL_RESPONSE_TIMEOUT;
        let routed = self.negotiate(required_capabilities).await?;
        let endpoint_id = routed.endpoint_id;
        let route_generation = routed.route_generation;
        let mut connection = routed.connection;
        let hello = routed.hello;
        let request_id = Uuid::new_v4().to_string();
        if let Err(error) = timeout_at(
            request_deadline,
            write_json_line(
                &mut connection.stream,
                &RequestEnvelope {
                    kind: "request",
                    version: 2,
                    request_id: &request_id,
                    request_type,
                    params,
                },
            ),
        )
        .await
        .map_err(|_| ClientError::Protocol("control request timed out".into()))
        .and_then(|result| result)
        {
            self.router
                .report_connection_failure(&endpoint_id, route_generation);
            return Err(error);
        }
        let maximum_bytes = maximum_line_bytes(&hello);
        let response: ResponseEnvelope = match timeout_at(
            request_deadline,
            read_json_line(&mut connection.stream, maximum_bytes),
        )
        .await
        .map_err(|_| ClientError::Protocol("control response timed out".into()))
        .and_then(|response| response)
        {
            Ok(response) => response,
            Err(error) => {
                self.router
                    .report_connection_failure(&endpoint_id, route_generation);
                return Err(error);
            }
        };
        if let Err(error) =
            validate_response_envelope(&response, &request_id, &hello.host.host_epoch)
        {
            self.router
                .report_connection_failure(&endpoint_id, route_generation);
            return Err(error);
        }
        self.router.ensure_open()?;
        let result = response_result(response, request_type, None)?;
        Ok((
            result,
            ProtocolEventStream {
                connection: Some(connection),
                records: None,
                request_id,
                host_epoch: hello.host.host_epoch,
                maximum_bytes,
                router: self.router.clone(),
                endpoint_id,
                route_generation,
            },
        ))
    }

    pub(crate) fn check_file_host_epoch(&self, epoch: &str) -> Result<()> {
        if self
            .expected_host_epoch
            .as_deref()
            .is_some_and(|expected| expected != epoch)
        {
            return Err(ClientError::Protocol(
                "Host changed before the file request began".into(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn negotiate(
        &self,
        required_capabilities: &[&str],
    ) -> Result<crate::connection_router::RoutedConnection> {
        self.router.acquire(required_capabilities).await
    }
}

pub(crate) async fn negotiate_pinned_endpoint(
    endpoint: &Endpoint,
    connector: &PinnedTlsConnector,
    client_id: &str,
    required_capabilities: &[&str],
) -> Result<(ConnectedTransport, HelloAck)> {
    negotiate_transport(
        connector.connect(endpoint).await?.into(),
        client_id,
        required_capabilities,
    )
    .await
}

pub(crate) async fn negotiate_local_endpoint(
    endpoint: &LocalDockEndpoint,
    client_id: &str,
    required_capabilities: &[&str],
) -> Result<(ConnectedTransport, HelloAck)> {
    negotiate_transport(endpoint.connect().await?, client_id, required_capabilities).await
}

async fn negotiate_transport(
    mut connection: ConnectedTransport,
    client_id: &str,
    required_capabilities: &[&str],
) -> Result<(ConnectedTransport, HelloAck)> {
    let request_id = Uuid::new_v4().to_string();
    write_json_line(
        &mut connection.stream,
        &ClientHello {
            kind: "hello",
            request_id: &request_id,
            versions: [2],
            client: ClientDescription {
                name: "aludock-client",
                version: CLIENT_VERSION,
                client_id,
            },
            required_capabilities,
        },
    )
    .await?;
    let reply: HelloReply = timeout(
        CONTROL_RESPONSE_TIMEOUT,
        read_json_line(&mut connection.stream, MAX_CONTROL_LINE_BYTES),
    )
    .await
    .map_err(|_| ClientError::Protocol("Host hello timed out".into()))??;
    let hello = validate_hello(reply, &request_id, required_capabilities)?;
    Ok((connection, hello))
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

async fn read_response_envelope<R: AsyncBufRead + Unpin>(
    stream: &mut R,
    maximum_line_bytes: usize,
    request_id: &str,
    host_epoch: &str,
) -> Result<ResponseEnvelope> {
    let first: Value = read_timed_json_line(
        stream,
        maximum_line_bytes,
        RESPONSE_TRANSFER_IDLE_TIMEOUT,
        "response transfer",
    )
    .await?;
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
        raw = read_timed_json_line(
            stream,
            maximum_line_bytes,
            RESPONSE_TRANSFER_IDLE_TIMEOUT,
            "response transfer",
        )
        .await?;
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

fn protocol(message: impl Into<String>) -> ClientError {
    ClientError::Protocol(message.into())
}

pub(crate) struct ProtocolEventStream {
    connection: Option<ConnectedTransport>,
    records: Option<crate::instance_records::InstanceRecords>,
    request_id: String,
    host_epoch: String,
    maximum_bytes: usize,
    router: ConnectionRouter,
    endpoint_id: String,
    route_generation: u64,
}

impl ProtocolEventStream {
    pub(crate) fn host_epoch(&self) -> &str {
        &self.host_epoch
    }

    pub(crate) async fn next<T: DeserializeOwned>(&mut self) -> Result<T> {
        self.router.ensure_open()?;
        let envelope: EventEnvelope = match async {
            if let Some(records) = self.records.as_mut() {
                Ok(serde_json::from_value(records.next(true).await?)?)
            } else {
                read_json_line(
                    &mut self.connection.as_mut().unwrap().stream,
                    self.maximum_bytes,
                )
                .await
            }
        }
        .await
        {
            Ok(envelope) => envelope,
            Err(error) => {
                self.router
                    .report_connection_failure(&self.endpoint_id, self.route_generation);
                return Err(error);
            }
        };
        if envelope.kind != "event"
            || envelope.version != 2
            || envelope.request_id != self.request_id
            || envelope.host_epoch != self.host_epoch
        {
            self.router
                .report_connection_failure(&self.endpoint_id, self.route_generation);
            return Err(ClientError::Protocol(
                "event correlation, version, or Host epoch was invalid".into(),
            ));
        }
        self.router.ensure_open()?;
        serde_json::from_value(envelope.event).map_err(|error| {
            self.router
                .report_connection_failure(&self.endpoint_id, self.route_generation);
            ClientError::Protocol(format!("invalid event: {error}"))
        })
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

// Keep these request classes aligned with alu_dock/src/control/dock-client.ts.
fn response_timeout_for(request_type: &str) -> Duration {
    match request_type {
        "instance.create" | "instance.ensure" | "instance.adopt" | "instance.reopen"
        | "instance.stop" | "command.abort" | "session.switch" | "session.new"
        | "session.compact" | "session.reload" | "session.navigate" | "session.fork"
        | "session.clone" => LONG_MUTATION_RESPONSE_TIMEOUT,
        _ => CONTROL_RESPONSE_TIMEOUT,
    }
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
            let mut details = serde_json::Map::new();
            if let Some(missing) = error.error.missing {
                details.insert("missing".into(), serde_json::json!(missing));
            }
            if let Some(versions) = error.error.host_versions {
                details.insert("hostVersions".into(), serde_json::json!(versions));
            }
            if let Some(delay) = error.error.retry_after_ms {
                details.insert("retryAfterMs".into(), serde_json::json!(delay));
            }
            return Err(ClientError::Host {
                retryable: matches!(error.error.code.as_str(), "host_starting" | "host_draining"),
                code: error.error.code,
                message: error.error.message,
                details: (!details.is_empty()).then_some(Value::Object(details)),
            });
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
#[serde(rename_all = "camelCase")]
struct HelloErrorBody {
    code: String,
    message: String,
    missing: Option<Vec<String>>,
    host_versions: Option<Vec<u64>>,
    retry_after_ms: Option<u64>,
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
        let (client, mut host) = tokio::io::duplex(16 * 1024);
        let mut client = tokio::io::BufReader::new(client);
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

        let (client, mut host) = tokio::io::duplex(4 * 1024);
        let mut client = tokio::io::BufReader::new(client);
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
    fn lifecycle_close_after_a_dispatched_mutation_is_effect_unknown() {
        let error = ambiguous_if_mutation(
            ClientError::Protocol("client lifecycle closed".into()),
            Some("operation"),
        );
        assert!(matches!(
            error,
            ClientError::EffectUnknown { operation_id, .. } if operation_id == "operation"
        ));
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
    fn response_waits_match_the_dock_control_client_policy() {
        assert_eq!(
            response_timeout_for("instance.list"),
            Duration::from_secs(30)
        );
        assert_eq!(
            response_timeout_for("instance.reopen"),
            Duration::from_secs(600)
        );
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
