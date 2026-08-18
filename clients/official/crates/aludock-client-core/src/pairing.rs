use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};

use crate::{
    ClientError, Endpoint, IdentityStore, Result,
    identity::{
        EncryptedIdentity, PairingIdentityContext, create_client_identity_record,
        verify_server_identity_record,
    },
    protocol::probe_pending_pairing,
    srp::PairingSrpClient,
    tls::{connect_tls, read_json_line, write_json_line},
};

const MAX_PAIRING_LINE_BYTES: usize = 16 * 1024;
const PAIRING_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug)]
pub enum PairingProgress {
    RecoveringPairing,
    PinGenerated { pin: String },
    WaitingForHostApproval { pairing_id: String },
    HostApproved,
    VerifyingIdentities,
    ConfirmingConnection,
    SavingIdentity,
}

#[derive(Clone, Debug)]
pub struct PairingOutcome {
    pub endpoint: Endpoint,
    pub client_fingerprint: String,
    pub identity_directory: std::path::PathBuf,
}

pub async fn pair<F>(
    endpoint: Endpoint,
    device_name: &str,
    store: &IdentityStore,
    progress: F,
) -> Result<PairingOutcome>
where
    F: FnMut(PairingProgress),
{
    pair_with_host_guard(endpoint, device_name, store, progress, |_| Ok(())).await
}

pub(crate) async fn pair_with_host_guard<F, G>(
    endpoint: Endpoint,
    device_name: &str,
    store: &IdentityStore,
    mut progress: F,
    mut host_guard: G,
) -> Result<PairingOutcome>
where
    F: FnMut(PairingProgress),
    G: FnMut(&[u8]) -> Result<()>,
{
    validate_device_name(device_name)?;
    if store.is_paired() {
        return Err(ClientError::InvalidPairing(
            "this profile is already paired".into(),
        ));
    }
    if let Some(pending) = store.load_pending_pairing()? {
        host_guard(&pending.host_certificate)?;
        progress(PairingProgress::RecoveringPairing);
        probe_pending_pairing(&pending).await.map_err(|error| {
            ClientError::InvalidPairing(format!(
                "a previous pairing may already be trusted by the Host, but recovery failed: {error}; the pending state was kept for another retry"
            ))
        })?;
        store.commit_pending_pairing()?;
        return Ok(PairingOutcome {
            endpoint: pending.metadata.endpoint,
            client_fingerprint: pending.identity.fingerprint(),
            identity_directory: store.root().to_path_buf(),
        });
    }
    let identity = store.load_or_create_identity()?;
    let client_id = store.client_id()?;
    let mut nonce = [0_u8; 16];
    rand::rng().fill_bytes(&mut nonce);
    let pin = format!("{:04}", rand::rng().random_range(0_u16..10_000));

    let begin = PairingClientRecord::Begin {
        device_name: device_name.to_owned(),
        client_nonce: BASE64.encode(nonce),
    };
    let (response, host_certificate) = pairing_request(&endpoint, &identity, None, &begin).await?;
    // The provisional leaf is already exact-pinned by all subsequent pairing
    // requests. A registry can reject a known Host here, before credentials are
    // submitted or accepted, without weakening the final pinned probe.
    host_guard(&host_certificate)?;
    let (pairing_id, mut retry_after) = match response {
        PairingServerRecord::Pending {
            pairing_id,
            retry_after_ms,
        } => (pairing_id, retry_after_ms),
        other => return Err(unexpected("pairing.pending.v1", other)),
    };
    validate_pairing_id(&pairing_id)?;
    progress(PairingProgress::PinGenerated { pin: pin.clone() });
    progress(PairingProgress::WaitingForHostApproval {
        pairing_id: pairing_id.clone(),
    });

    let deadline = Instant::now() + PAIRING_TIMEOUT;
    let challenge = loop {
        if Instant::now() >= deadline {
            return Err(ClientError::InvalidPairing(
                "timed out waiting for local host approval".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(retry_after.clamp(100, 10_000))).await;
        let (response, _) = pairing_request(
            &endpoint,
            &identity,
            Some(&host_certificate),
            &PairingClientRecord::Poll {
                pairing_id: pairing_id.clone(),
            },
        )
        .await?;
        match response {
            PairingServerRecord::Pending {
                pairing_id: returned_id,
                retry_after_ms,
            } => {
                if returned_id != pairing_id {
                    return Err(ClientError::InvalidPairing(
                        "host changed the pairing ID while polling".into(),
                    ));
                }
                retry_after = retry_after_ms;
            }
            PairingServerRecord::SrpChallenge {
                pairing_id: returned_id,
                salt,
                server_public_key,
            } => {
                if returned_id != pairing_id {
                    return Err(ClientError::InvalidPairing(
                        "host changed the pairing ID in its SRP challenge".into(),
                    ));
                }
                break (
                    decode_canonical(&salt, 16, "SRP salt")?,
                    decode_canonical(&server_public_key, 384, "SRP server public key")?,
                );
            }
            other => return Err(unexpected("pairing.srp-challenge.v1", other)),
        }
    };
    progress(PairingProgress::HostApproved);

    let srp = PairingSrpClient::start(&pin, &challenge.0, &challenge.1)?;
    let proof_request = PairingClientRecord::SrpProof {
        pairing_id: pairing_id.clone(),
        client_public_key: BASE64.encode(srp.public_key()),
        proof: BASE64.encode(srp.proof()),
    };
    let (response, _) = pairing_request(
        &endpoint,
        &identity,
        Some(&host_certificate),
        &proof_request,
    )
    .await?;
    let server_proof = match response {
        PairingServerRecord::SrpConfirmed {
            pairing_id: returned_id,
            proof,
        } => {
            if returned_id != pairing_id {
                return Err(ClientError::InvalidPairing(
                    "host changed the pairing ID in its SRP confirmation".into(),
                ));
            }
            decode_canonical(&proof, 64, "SRP server proof")?
        }
        other => return Err(unexpected("pairing.srp-confirmed.v1", other)),
    };
    let session_key = srp.confirm(&server_proof)?;

    progress(PairingProgress::VerifyingIdentities);
    let context = PairingIdentityContext {
        pairing_id: &pairing_id,
        client_nonce: &nonce,
        client_certificate: identity.certificate_der(),
        server_certificate: &host_certificate,
    };
    let client_record = create_client_identity_record(&session_key, &context, &identity)?;
    store.save_pending_pairing(
        &identity,
        &host_certificate,
        &endpoint,
        device_name,
        &client_id,
    )?;
    let response = match pairing_request(
        &endpoint,
        &identity,
        Some(&host_certificate),
        &PairingClientRecord::ClientIdentity {
            pairing_id: pairing_id.clone(),
            encrypted: BASE64.encode(&client_record.encrypted),
            auth_tag: BASE64.encode(client_record.auth_tag),
        },
    )
    .await
    {
        Ok((response, _)) => response,
        Err(error @ ClientError::PairingRejected { .. }) => {
            store.clear_pending_pairing()?;
            return Err(error);
        }
        // A lost or truncated final response is intentionally recoverable via
        // exact pin + mTLS + Protocol V2. Keep pending state for that case.
        Err(error) => return Err(error),
    };
    let verified = (|| {
        let server_record = match response {
            PairingServerRecord::ServerIdentity {
                pairing_id: returned_id,
                encrypted,
                auth_tag,
            } => {
                if returned_id != pairing_id {
                    return Err(ClientError::InvalidPairing(
                        "host changed the pairing ID in its identity record".into(),
                    ));
                }
                EncryptedIdentity {
                    encrypted: decode_canonical_range(
                        &encrypted,
                        1,
                        1024,
                        "encrypted server identity",
                    )?,
                    auth_tag: decode_canonical(
                        &auth_tag,
                        16,
                        "server identity authentication tag",
                    )?
                    .try_into()
                    .expect("length checked"),
                }
            }
            other => return Err(unexpected("pairing.server-identity.v1", other)),
        };
        verify_server_identity_record(&session_key, &context, &server_record)
    })();
    if let Err(error) = verified {
        // A response that was received and cryptographically rejected is not
        // the ambiguous lost-response case and must never be probe-promoted.
        store.clear_pending_pairing()?;
        return Err(error);
    }

    progress(PairingProgress::ConfirmingConnection);
    let pending = store.load_pending_pairing()?.ok_or_else(|| {
        ClientError::InvalidPairing(
            "verified pairing credentials disappeared before final confirmation".into(),
        )
    })?;
    probe_pending_pairing(&pending).await.map_err(|error| {
        ClientError::InvalidPairing(format!(
            "the Host accepted pairing, but the final secure connection could not be confirmed: {error}; the pending state was kept for recovery"
        ))
    })?;

    progress(PairingProgress::SavingIdentity);
    store.commit_pending_pairing()?;
    Ok(PairingOutcome {
        endpoint,
        client_fingerprint: identity.fingerprint(),
        identity_directory: store.root().to_path_buf(),
    })
}

async fn pairing_request(
    endpoint: &Endpoint,
    identity: &crate::ClientIdentity,
    expected_host_certificate: Option<&[u8]>,
    record: &PairingClientRecord,
) -> Result<(PairingServerRecord, Vec<u8>)> {
    let mut connection = connect_tls(endpoint, identity, expected_host_certificate).await?;
    write_json_line(&mut connection.stream, record).await?;
    let response: PairingServerRecord =
        read_json_line(&mut connection.stream, MAX_PAIRING_LINE_BYTES).await?;
    if let PairingServerRecord::Error {
        code,
        message,
        _retry_after_ms: _,
    } = response
    {
        return Err(ClientError::PairingRejected { code, message });
    }
    Ok((response, connection.host_certificate))
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum PairingClientRecord {
    #[serde(rename = "pairing.begin.v1")]
    Begin {
        #[serde(rename = "deviceName")]
        device_name: String,
        #[serde(rename = "clientNonce")]
        client_nonce: String,
    },
    #[serde(rename = "pairing.poll.v1")]
    Poll {
        #[serde(rename = "pairingId")]
        pairing_id: String,
    },
    #[serde(rename = "pairing.srp-proof.v1")]
    SrpProof {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        #[serde(rename = "clientPublicKey")]
        client_public_key: String,
        proof: String,
    },
    #[serde(rename = "pairing.client-identity.v1")]
    ClientIdentity {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        encrypted: String,
        #[serde(rename = "authTag")]
        auth_tag: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum PairingServerRecord {
    #[serde(rename = "pairing.pending.v1")]
    Pending {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        #[serde(rename = "retryAfterMs")]
        retry_after_ms: u64,
    },
    #[serde(rename = "pairing.srp-challenge.v1")]
    SrpChallenge {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        salt: String,
        #[serde(rename = "serverPublicKey")]
        server_public_key: String,
    },
    #[serde(rename = "pairing.srp-confirmed.v1")]
    SrpConfirmed {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        proof: String,
    },
    #[serde(rename = "pairing.server-identity.v1")]
    ServerIdentity {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        encrypted: String,
        #[serde(rename = "authTag")]
        auth_tag: String,
    },
    #[serde(rename = "pairing.error.v1")]
    Error {
        code: String,
        message: String,
        #[serde(rename = "retryAfterMs")]
        _retry_after_ms: Option<u64>,
    },
}

fn decode_canonical(value: &str, length: usize, field: &str) -> Result<Vec<u8>> {
    decode_canonical_range(value, length, length, field)
}

fn decode_canonical_range(
    value: &str,
    minimum: usize,
    maximum: usize,
    field: &str,
) -> Result<Vec<u8>> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| ClientError::InvalidPairing(format!("{field} was not canonical base64")))?;
    if bytes.len() < minimum || bytes.len() > maximum || BASE64.encode(&bytes) != value {
        return Err(ClientError::InvalidPairing(format!(
            "{field} had an invalid length or encoding"
        )));
    }
    Ok(bytes)
}

fn validate_pairing_id(value: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| ClientError::InvalidPairing("host returned an invalid pairing ID".into()))?;
    if parsed.hyphenated().to_string() != value {
        return Err(ClientError::InvalidPairing(
            "host returned a non-canonical pairing ID".into(),
        ));
    }
    Ok(())
}

fn validate_device_name(value: &str) -> Result<()> {
    let forbidden = value.chars().any(|character| {
        character.is_control()
            || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
    });
    if value.is_empty() || value.chars().count() > 128 || forbidden {
        return Err(ClientError::InvalidPairing(
            "device name must be a safe non-empty name of at most 128 characters".into(),
        ));
    }
    Ok(())
}

fn unexpected(expected: &str, actual: PairingServerRecord) -> ClientError {
    ClientError::InvalidPairing(format!("expected {expected}, received {actual:?}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::ClientIdentity;

    #[tokio::test]
    async fn already_paired_error_does_not_disclose_generated_transaction_path() {
        let test_root =
            std::env::temp_dir().join(format!("aludock-path-redaction-{}", uuid::Uuid::new_v4()));
        let root = test_root
            .join("pairing-transactions")
            .join(uuid::Uuid::new_v4().to_string())
            .join("identity");
        let store = IdentityStore::new(&root);
        let identity = store.load_or_create_identity().unwrap();
        let client_id = store.client_id().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let endpoint: Endpoint = "127.0.0.1:1".parse().unwrap();
        store
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "redaction",
                &client_id,
            )
            .unwrap();

        let error = pair(endpoint, "redaction", &store, |_| {})
            .await
            .unwrap_err();
        let message = error.to_string();
        assert!(!message.contains(&root.display().to_string()));
        assert!(!message.contains("pairing-transactions"));
        fs::remove_dir_all(test_root).unwrap();
    }
}
