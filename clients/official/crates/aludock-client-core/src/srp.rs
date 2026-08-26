use rand::RngCore;
use sha2::{Digest, Sha512};
use srp::{
    ClientG3072, Group,
    bigint::BoxedUint,
    groups::G3072,
    utils::{compute_k, compute_u_padded},
};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::{ClientError, Result};

const GROUP_BYTES: usize = 384;
const PROOF_BYTES: usize = 64;
const SESSION_KEY_BYTES: usize = 64;
const IDENTITY: &[u8] = b"Pair-Setup";

pub struct PairingSrpClient {
    public_key: [u8; GROUP_BYTES],
    proof: [u8; PROOF_BYTES],
    expected_server_proof: [u8; PROOF_BYTES],
    session_key: Zeroizing<[u8; SESSION_KEY_BYTES]>,
}

impl PairingSrpClient {
    pub fn start(pin: &str, salt: &[u8], server_public_key: &[u8]) -> Result<Self> {
        let mut secret = [0_u8; 32];
        rand::rng().fill_bytes(&mut secret);
        let result = Self::from_secret(pin, salt, server_public_key, &secret);
        secret.zeroize();
        result
    }

    fn from_secret(
        pin: &str,
        salt: &[u8],
        server_public_key: &[u8],
        secret: &[u8],
    ) -> Result<Self> {
        validate_inputs(pin, salt, server_public_key, secret)?;

        let client = ClientG3072::<Sha512>::new();
        let a = BoxedUint::from_be_slice_vartime(secret);
        let public_key = pad_group(&client.compute_public_ephemeral(secret))?;
        let server_public = BoxedUint::from_be_slice_vartime(server_public_key);
        let generator = G3072::generator();
        let u = compute_u_padded::<Sha512>(&generator, &public_key, server_public_key);
        let k = compute_k::<Sha512>(&generator);
        let identity_hash = ClientG3072::<Sha512>::compute_identity_hash(IDENTITY, pin.as_bytes());
        let x = ClientG3072::<Sha512>::compute_x(identity_hash.as_slice(), salt);
        let premaster = client.compute_premaster_secret(&server_public, &k, &x, &a, &u);
        let premaster = pad_group(&premaster.to_be_bytes_trimmed_vartime())?;
        let session_key: [u8; SESSION_KEY_BYTES] = Sha512::digest(premaster).into();

        let proof = client_proof(
            &generator,
            salt,
            &public_key,
            server_public_key,
            &session_key,
        );
        let expected_server_proof = Sha512::new()
            .chain_update(public_key)
            .chain_update(proof)
            .chain_update(session_key)
            .finalize()
            .into();

        Ok(Self {
            public_key,
            proof,
            expected_server_proof,
            session_key: Zeroizing::new(session_key),
        })
    }

    pub fn public_key(&self) -> &[u8; GROUP_BYTES] {
        &self.public_key
    }

    pub fn proof(&self) -> &[u8; PROOF_BYTES] {
        &self.proof
    }

    pub fn confirm(self, server_proof: &[u8]) -> Result<Zeroizing<[u8; SESSION_KEY_BYTES]>> {
        if server_proof.len() != PROOF_BYTES
            || self.expected_server_proof.ct_eq(server_proof).unwrap_u8() != 1
        {
            return Err(ClientError::InvalidPairing(
                "SRP server proof did not authenticate the host".into(),
            ));
        }
        Ok(self.session_key)
    }
}

fn validate_inputs(pin: &str, salt: &[u8], server_public_key: &[u8], secret: &[u8]) -> Result<()> {
    if pin.len() != 4 || !pin.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ClientError::InvalidPairing(
            "PIN must contain exactly four ASCII digits".into(),
        ));
    }
    if salt.len() != 16 {
        return Err(ClientError::InvalidPairing(
            "SRP salt must contain 16 bytes".into(),
        ));
    }
    if server_public_key.len() != GROUP_BYTES {
        return Err(ClientError::InvalidPairing(
            "SRP server public key must contain 384 bytes".into(),
        ));
    }
    if secret.len() < 32 {
        return Err(ClientError::InvalidPairing(
            "SRP client secret must contain at least 32 bytes".into(),
        ));
    }
    Ok(())
}

fn client_proof(
    generator: &srp::bigint::modular::BoxedMontyForm,
    salt: &[u8],
    public_key: &[u8],
    server_public_key: &[u8],
    session_key: &[u8],
) -> [u8; PROOF_BYTES] {
    let modulus = generator.params().modulus().to_be_bytes();
    let generator_bytes = generator.retrieve().to_be_bytes();
    let first_nonzero = generator_bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(generator_bytes.len() - 1);
    let generator_bytes = &generator_bytes[first_nonzero..];

    let mut mixed_group_hash = Sha512::digest(modulus);
    let generator_hash = Sha512::digest(generator_bytes);
    for (left, right) in mixed_group_hash.iter_mut().zip(generator_hash) {
        *left ^= right;
    }
    let identity_hash = Sha512::digest(IDENTITY);

    Sha512::new()
        .chain_update(mixed_group_hash)
        .chain_update(identity_hash)
        .chain_update(salt)
        .chain_update(public_key)
        .chain_update(server_public_key)
        .chain_update(session_key)
        .finalize()
        .into()
}

fn pad_group(input: &[u8]) -> Result<[u8; GROUP_BYTES]> {
    if input.len() > GROUP_BYTES {
        return Err(ClientError::InvalidPairing(
            "SRP integer exceeded the 3072-bit group".into(),
        ));
    }
    let mut output = [0_u8; GROUP_BYTES];
    output[GROUP_BYTES - input.len()..].copy_from_slice(input);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::PairingSrpClient;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        pin: String,
        salt: String,
        client_secret: String,
        server_public_key: String,
        client_public_key: String,
        client_proof: String,
        server_proof: String,
        session_key: String,
    }

    #[test]
    fn matches_fast_srp_hap_reference_vector() {
        let fixture: Fixture =
            serde_json::from_str(include_str!("../tests/fixtures/fast-srp-hap-v2.json"))
                .expect("valid fixture");
        let decode = |value: &str| hex::decode(value).expect("fixture hex");
        let client = PairingSrpClient::from_secret(
            &fixture.pin,
            &decode(&fixture.salt),
            &decode(&fixture.server_public_key),
            &decode(&fixture.client_secret),
        )
        .expect("valid SRP inputs");

        assert_eq!(
            client.public_key().as_slice(),
            decode(&fixture.client_public_key)
        );
        assert_eq!(client.proof().as_slice(), decode(&fixture.client_proof));
        let session_key = client
            .confirm(&decode(&fixture.server_proof))
            .expect("server proof must verify");
        assert_eq!(session_key.as_slice(), decode(&fixture.session_key));
    }
}
