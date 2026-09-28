use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ClientError, ClientIdentity, ConnectionRouter, DockClient, Endpoint, HostConnectionProfile,
    IdentityStore, Result, StoredPairing, capabilities,
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
    let client = DockClient::new(ConnectionRouter::from_store(store, profile)?);
    let info = client.host_info().await?;
    let endpoint_id = client
        .router()
        .snapshot()
        .active_endpoint_id
        .ok_or_else(|| ClientError::Protocol("Host connection has no active address".into()))?;
    Ok((info, endpoint_id))
}

impl DockClient {
    pub async fn host_info(&self) -> Result<HostInfo> {
        let (result, host_epoch): (HostInfo, String) = self
            .request_with_host_epoch("host.info", &EmptyParams {}, capabilities::HOST_INFO, None)
            .await?;
        if result.host.host_epoch != host_epoch {
            return Err(ClientError::Protocol(
                "host.info result did not describe the negotiated host epoch".into(),
            ));
        }
        Ok(result)
    }
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
    DockClient::new(ConnectionRouter::from_pinned_endpoint(
        endpoint.clone(),
        identity.clone(),
        host_certificate.to_vec(),
        client_id.to_owned(),
    )?)
    .host_info()
    .await
}

#[derive(Serialize)]
struct EmptyParams {}
