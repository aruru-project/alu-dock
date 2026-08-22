use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ClientError, ClientIdentity, DockClient, Endpoint, HostConnectionProfile, IdentityStore,
    PendingPairing, Result, StoredPairing, capabilities,
};

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
    let client = DockClient::from_pinned_endpoint(
        endpoint.clone(),
        identity.clone(),
        host_certificate.to_vec(),
        client_id.to_owned(),
    );
    let (result, host_epoch): (HostInfo, String) = client
        .request_with_host_epoch("host.info", &EmptyParams {}, capabilities::HOST_INFO, None)
        .await?;
    if result.host.host_epoch != host_epoch {
        return Err(ClientError::Protocol(
            "host.info result did not describe the negotiated host epoch".into(),
        ));
    }
    Ok(result)
}

#[derive(Serialize)]
struct EmptyParams {}
