use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    ClientError, ClientIdentity, Endpoint, HostConnectionProfile, IdentityStore, PendingPairing,
    Result, StoredPairing,
    tls::{connect_tls, read_json_line, write_json_line},
};

const MAX_CONTROL_LINE_BYTES: usize = 1024 * 1024;
const CATALOG_SCHEMA_VERSION: u64 = 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostIdentity {
    pub pid: u32,
    pub dock_version: String,
    pub pi_sdk_version: String,
    pub host_epoch: String,
    pub started_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub state: String,
    pub host: HostIdentity,
    pub catalog: Value,
    pub paths: Value,
    pub diagnostics: Vec<Value>,
}

pub async fn host_info(
    store: &IdentityStore,
    endpoint_override: Option<Endpoint>,
) -> Result<HostInfo> {
    if !store.is_paired()
        && let Some(pending) = store.load_pending_pairing()?
    {
        let endpoint = endpoint_override.unwrap_or_else(|| pending.metadata.endpoint.clone());
        let info = request_host_info(
            &endpoint,
            &pending.identity,
            &pending.host_certificate,
            &pending.metadata.client_id,
        )
        .await?;
        store.commit_pending_pairing()?;
        return Ok(info);
    }

    let paired = store.load_pairing()?;
    let endpoint = endpoint_override.unwrap_or_else(|| paired.metadata.endpoint.clone());
    request_host_info(
        &endpoint,
        &paired.identity,
        &paired.host_certificate,
        &paired.metadata.client_id,
    )
    .await
}

pub async fn host_info_for_profile(
    store: &IdentityStore,
    profile: &HostConnectionProfile,
) -> Result<(HostInfo, String)> {
    let paired = store.load_pairing()?;
    let mut failures = Vec::new();
    for candidate in profile.ordered_verified_endpoints() {
        match request_host_info(
            &candidate.endpoint,
            &paired.identity,
            &paired.host_certificate,
            &paired.metadata.client_id,
        )
        .await
        {
            Ok(info) => return Ok((info, candidate.id.clone())),
            Err(error) => failures.push(format!("{}: {error}", candidate.label)),
        }
    }
    Err(ClientError::Protocol(format!(
        "none of the verified addresses reached the paired Host ({})",
        failures.join("; ")
    )))
}

pub(crate) async fn probe_pending_pairing(pending: &PendingPairing) -> Result<()> {
    request_host_info(
        &pending.metadata.endpoint,
        &pending.identity,
        &pending.host_certificate,
        &pending.metadata.client_id,
    )
    .await?;
    Ok(())
}

pub(crate) async fn probe_stored_pairing(pairing: &StoredPairing) -> Result<()> {
    request_host_info(
        &pairing.metadata.endpoint,
        &pairing.identity,
        &pairing.host_certificate,
        &pairing.metadata.client_id,
    )
    .await?;
    Ok(())
}

async fn request_host_info(
    endpoint: &Endpoint,
    identity: &ClientIdentity,
    host_certificate: &[u8],
    client_id: &str,
) -> Result<HostInfo> {
    let mut connection = connect_tls(endpoint, identity, Some(host_certificate)).await?;

    let hello_request_id = Uuid::new_v4().to_string();
    let hello = ClientHello {
        kind: "hello",
        request_id: &hello_request_id,
        versions: [2],
        client: ClientDescription {
            name: "aludock-client",
            version: env!("CARGO_PKG_VERSION"),
            client_id,
        },
        required_capabilities: ["core.v2", "host.info"],
    };
    write_json_line(&mut connection.stream, &hello).await?;
    let hello_reply: HelloReply =
        read_json_line(&mut connection.stream, MAX_CONTROL_LINE_BYTES).await?;
    let hello_ack = match hello_reply {
        HelloReply::Ack(ack) if ack.kind == "hello_ack" => ack,
        HelloReply::Ack(_) => {
            return Err(ClientError::Protocol(
                "host returned an invalid hello reply kind".into(),
            ));
        }
        HelloReply::Error(error)
            if error.kind == "hello_error" && error.request_id == hello_request_id =>
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
    validate_hello_ack(&hello_ack, &hello_request_id, &["core.v2", "host.info"])?;

    let request_id = Uuid::new_v4().to_string();
    write_json_line(
        &mut connection.stream,
        &HostInfoRequest {
            kind: "request",
            version: 2,
            request_id: &request_id,
            request_type: "host.info",
            params: EmptyParams {},
        },
    )
    .await?;
    let response: ControlResponse = read_json_line(
        &mut connection.stream,
        hello_ack
            .limits
            .max_line_bytes
            .min(MAX_CONTROL_LINE_BYTES as u64) as usize,
    )
    .await?;
    if response.kind != "response"
        || response.version != 2
        || response.request_id != request_id
        || response.host_epoch != hello_ack.host.host_epoch
    {
        return Err(ClientError::Protocol(
            "host.info response correlation, version, or host epoch was invalid".into(),
        ));
    }
    if !response.ok {
        let error = response.error.unwrap_or(ControlError {
            code: "unknown".into(),
            message: "host returned an unsuccessful response without an error".into(),
        });
        return Err(ClientError::Protocol(format!(
            "host.info failed ({}): {}",
            error.code, error.message
        )));
    }
    let result: HostInfo =
        serde_json::from_value(response.result.ok_or_else(|| {
            ClientError::Protocol("host.info response omitted its result".into())
        })?)?;
    if result.host.host_epoch != hello_ack.host.host_epoch {
        return Err(ClientError::Protocol(
            "host.info result did not describe the negotiated host epoch".into(),
        ));
    }
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientHello<'a> {
    kind: &'static str,
    request_id: &'a str,
    versions: [u8; 1],
    client: ClientDescription<'a>,
    required_capabilities: [&'static str; 2],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientDescription<'a> {
    name: &'static str,
    version: &'static str,
    client_id: &'a str,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum HelloReply {
    Ack(HelloAck),
    Error(HelloError),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloAck {
    kind: String,
    request_id: String,
    version: u8,
    catalog_schema_version: u64,
    host: HostIdentity,
    capabilities: Vec<String>,
    limits: ProtocolLimits,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfoRequest<'a> {
    kind: &'static str,
    version: u8,
    request_id: &'a str,
    #[serde(rename = "type")]
    request_type: &'static str,
    params: EmptyParams,
}

#[derive(Serialize)]
struct EmptyParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlResponse {
    kind: String,
    version: u8,
    request_id: String,
    host_epoch: String,
    ok: bool,
    result: Option<Value>,
    error: Option<ControlError>,
}

#[derive(Deserialize)]
struct ControlError {
    code: String,
    message: String,
}

fn validate_hello_ack(ack: &HelloAck, request_id: &str, capabilities: &[&str]) -> Result<()> {
    if ack.request_id != request_id
        || ack.version != 2
        || ack.catalog_schema_version != CATALOG_SCHEMA_VERSION
    {
        return Err(ClientError::Protocol(
            "hello response correlation, version, or catalog schema was invalid".into(),
        ));
    }
    for capability in capabilities {
        if !ack.capabilities.iter().any(|value| value == capability) {
            return Err(ClientError::Protocol(format!(
                "hello response omitted required capability {capability}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello_ack(schema: u64) -> HelloAck {
        HelloAck {
            kind: "hello_ack".into(),
            request_id: "pending-hello".into(),
            version: 2,
            catalog_schema_version: schema,
            host: HostIdentity {
                pid: 1,
                dock_version: "test".into(),
                pi_sdk_version: "test".into(),
                host_epoch: "epoch".into(),
                started_at: "2026-08-16T00:00:00.000Z".into(),
            },
            capabilities: vec!["core.v2".into(), "host.info".into()],
            limits: ProtocolLimits {
                max_line_bytes: 1024,
            },
        }
    }

    #[test]
    fn pending_and_host_info_hello_requires_catalog_schema_one() {
        assert!(
            validate_hello_ack(&hello_ack(1), "pending-hello", &["core.v2", "host.info"]).is_ok()
        );
        assert!(
            validate_hello_ack(&hello_ack(0), "pending-hello", &["core.v2", "host.info"]).is_err()
        );
    }
}
