use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    ClientError, ClientIdentity, Endpoint, HostConnectionProfile, IdentityStore, PairingMetadata,
    Result,
    tls::{ConnectedTls, connect_tls, read_json_line, write_json_line},
};

const MAX_CONTROL_LINE_BYTES: usize = 1024 * 1024;
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
        let response: ResponseEnvelope =
            match read_json_line(&mut connection.stream, maximum_line_bytes(&hello)).await {
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
