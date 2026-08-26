use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit,
    aead::{AeadInPlace, generic_array::GenericArray},
};
use hkdf::Hkdf;
use rand_core_legacy::OsRng;
use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, PKCS_RSA_SHA256,
};
use rsa::{
    RsaPrivateKey, RsaPublicKey,
    pkcs8::{DecodePrivateKey, DecodePublicKey},
    pss::{BlindedSigningKey, Signature, VerifyingKey},
    signature::{RandomizedSigner, SignatureEncoding, Verifier},
    traits::PublicKeyParts,
};
use sha2_legacy::{Digest, Sha256, Sha512};
use x509_cert::{
    Certificate,
    der::{Decode, Encode},
};
use zeroize::Zeroizing;

use crate::{ClientError, Result};

const PAIRING_LABEL: &[u8] = b"alu-dock-pair-setup-v1";
const ENCRYPT_SALT: &[u8] = b"Alu-Dock-Pair-Setup-Encrypt-Salt-v1";
const ENCRYPT_INFO: &[u8] = b"Alu-Dock-Pair-Setup-Encrypt-Info-v1";
const SIGN_SALT: &[u8] = b"Alu-Dock-Pair-Setup-Sign-Salt-v1";

#[derive(Clone)]
pub struct ClientIdentity {
    certificate_der: Vec<u8>,
    private_key_der: Zeroizing<Vec<u8>>,
}

impl ClientIdentity {
    pub fn generate() -> Result<Self> {
        let key_pair = KeyPair::generate_for(&PKCS_RSA_SHA256)
            .map_err(|error| ClientError::Crypto(format!("could not generate RSA key: {error}")))?;
        let mut params = CertificateParams::new(Vec::<String>::new()).map_err(|error| {
            ClientError::Crypto(format!("could not create certificate parameters: {error}"))
        })?;
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, "AluDock Client");
        params.distinguished_name = name;
        params.is_ca = IsCa::NoCa;
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        let certificate = params.self_signed(&key_pair).map_err(|error| {
            ClientError::Crypto(format!("could not self-sign client certificate: {error}"))
        })?;
        Self::from_der(certificate.der().to_vec(), key_pair.serialize_der())
    }

    pub fn from_der(certificate_der: Vec<u8>, private_key_der: Vec<u8>) -> Result<Self> {
        validate_rsa_certificate(&certificate_der)?;
        let private_key = RsaPrivateKey::from_pkcs8_der(&private_key_der)
            .map_err(|error| ClientError::Crypto(format!("invalid client private key: {error}")))?;
        if private_key.n().bits() < 2048 {
            return Err(ClientError::Crypto(
                "client RSA key must contain at least 2048 bits".into(),
            ));
        }
        Ok(Self {
            certificate_der,
            private_key_der: Zeroizing::new(private_key_der),
        })
    }

    pub fn certificate_der(&self) -> &[u8] {
        &self.certificate_der
    }

    pub fn private_key_der(&self) -> &[u8] {
        &self.private_key_der
    }

    pub fn fingerprint(&self) -> String {
        hex::encode(Sha256::digest(&self.certificate_der))
    }
}

pub struct PairingIdentityContext<'a> {
    pub pairing_id: &'a str,
    pub client_nonce: &'a [u8; 16],
    pub client_certificate: &'a [u8],
    pub server_certificate: &'a [u8],
}

pub struct EncryptedIdentity {
    pub encrypted: Vec<u8>,
    pub auth_tag: [u8; 16],
}

pub fn create_client_identity_record(
    session_key: &[u8; 64],
    context: &PairingIdentityContext<'_>,
    identity: &ClientIdentity,
) -> Result<EncryptedIdentity> {
    validate_context(context)?;
    let transcript = identity_transcript("client", session_key, context)?;
    let private_key = RsaPrivateKey::from_pkcs8_der(identity.private_key_der())
        .map_err(|error| ClientError::Crypto(format!("invalid client private key: {error}")))?;
    let signing_key = BlindedSigningKey::<Sha256>::new_with_salt_len(private_key, 32);
    let signature = signing_key.sign_with_rng(&mut OsRng, &transcript).to_vec();
    encrypt_identity("client", session_key, context, &transcript, signature)
}

pub fn verify_server_identity_record(
    session_key: &[u8; 64],
    context: &PairingIdentityContext<'_>,
    record: &EncryptedIdentity,
) -> Result<()> {
    validate_context(context)?;
    let transcript = identity_transcript("server", session_key, context)?;
    let signature = decrypt_identity("server", session_key, context, &transcript, record)?;
    let public_key = rsa_public_key(context.server_certificate)?;
    let verifying_key = VerifyingKey::<Sha256>::new_with_salt_len(public_key, 32);
    let signature = Signature::try_from(signature.as_slice()).map_err(|error| {
        ClientError::Crypto(format!("invalid server identity signature: {error}"))
    })?;
    verifying_key
        .verify(&transcript, &signature)
        .map_err(|_| ClientError::InvalidPairing("server identity signature was not valid".into()))
}

pub fn validate_rsa_certificate(certificate_der: &[u8]) -> Result<()> {
    let public_key = rsa_public_key(certificate_der)?;
    if public_key.n().bits() < 2048 {
        return Err(ClientError::InvalidPairing(
            "pairing certificates must use RSA keys of at least 2048 bits".into(),
        ));
    }
    Ok(())
}

fn rsa_public_key(certificate_der: &[u8]) -> Result<RsaPublicKey> {
    let certificate = Certificate::from_der(certificate_der)
        .map_err(|error| ClientError::Crypto(format!("invalid X.509 certificate: {error}")))?;
    let spki = certificate
        .tbs_certificate
        .subject_public_key_info
        .to_der()
        .map_err(|error| ClientError::Crypto(format!("invalid certificate public key: {error}")))?;
    RsaPublicKey::from_public_key_der(&spki).map_err(|error| {
        ClientError::InvalidPairing(format!("pairing certificate is not RSA: {error}"))
    })
}

fn identity_transcript(
    role: &str,
    session_key: &[u8; 64],
    context: &PairingIdentityContext<'_>,
) -> Result<Vec<u8>> {
    let mut sign_context = [0_u8; 32];
    Hkdf::<Sha512>::new(Some(SIGN_SALT), session_key)
        .expand(
            format!("Alu-Dock-Pair-Setup-{role}-Sign-Info-v1").as_bytes(),
            &mut sign_context,
        )
        .map_err(|_| ClientError::Crypto("could not derive pairing signing context".into()))?;
    let transcript = encode_fields(&[
        PAIRING_LABEL,
        role.as_bytes(),
        context.pairing_id.as_bytes(),
        context.client_nonce,
        context.server_certificate,
        context.client_certificate,
        &sign_context,
    ])?;
    sign_context.fill(0);
    Ok(transcript)
}

fn encrypt_identity(
    role: &str,
    session_key: &[u8; 64],
    context: &PairingIdentityContext<'_>,
    transcript: &[u8],
    mut plaintext: Vec<u8>,
) -> Result<EncryptedIdentity> {
    let key = encryption_key(session_key)?;
    let nonce = identity_nonce(role);
    let aad = identity_aad(role, context, transcript)?;
    let cipher = ChaCha20Poly1305::new(GenericArray::from_slice(&key));
    let tag = cipher
        .encrypt_in_place_detached(GenericArray::from_slice(&nonce), &aad, &mut plaintext)
        .map_err(|_| ClientError::Crypto("could not encrypt pairing identity".into()))?;
    Ok(EncryptedIdentity {
        encrypted: plaintext,
        auth_tag: tag.into(),
    })
}

fn decrypt_identity(
    role: &str,
    session_key: &[u8; 64],
    context: &PairingIdentityContext<'_>,
    transcript: &[u8],
    record: &EncryptedIdentity,
) -> Result<Vec<u8>> {
    if record.encrypted.is_empty() || record.encrypted.len() > 1024 {
        return Err(ClientError::InvalidPairing(
            "encrypted identity has an invalid length".into(),
        ));
    }
    let key = encryption_key(session_key)?;
    let nonce = identity_nonce(role);
    let aad = identity_aad(role, context, transcript)?;
    let cipher = ChaCha20Poly1305::new(GenericArray::from_slice(&key));
    let mut plaintext = record.encrypted.clone();
    cipher
        .decrypt_in_place_detached(
            GenericArray::from_slice(&nonce),
            &aad,
            &mut plaintext,
            GenericArray::from_slice(&record.auth_tag),
        )
        .map_err(|_| {
            ClientError::InvalidPairing("server identity authentication tag was not valid".into())
        })?;
    Ok(plaintext)
}

fn encryption_key(session_key: &[u8; 64]) -> Result<[u8; 32]> {
    let mut key = [0_u8; 32];
    Hkdf::<Sha512>::new(Some(ENCRYPT_SALT), session_key)
        .expand(ENCRYPT_INFO, &mut key)
        .map_err(|_| ClientError::Crypto("could not derive pairing encryption key".into()))?;
    Ok(key)
}

fn identity_nonce(role: &str) -> [u8; 12] {
    let digest = Sha256::new()
        .chain_update(PAIRING_LABEL)
        .chain_update(format!(":{role}:identity").as_bytes())
        .finalize();
    digest[..12]
        .try_into()
        .expect("SHA-256 has at least 12 bytes")
}

fn identity_aad(
    role: &str,
    context: &PairingIdentityContext<'_>,
    transcript: &[u8],
) -> Result<Vec<u8>> {
    let transcript_hash = Sha256::digest(transcript);
    encode_fields(&[
        PAIRING_LABEL,
        format!("{role}:identity").as_bytes(),
        context.pairing_id.as_bytes(),
        &transcript_hash,
    ])
}

fn encode_fields(fields: &[&[u8]]) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    for field in fields {
        let length = u32::try_from(field.len())
            .map_err(|_| ClientError::Crypto("pairing identity field is too large".into()))?;
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(field);
    }
    Ok(output)
}

fn validate_context(context: &PairingIdentityContext<'_>) -> Result<()> {
    if context.client_nonce.len() != 16 {
        return Err(ClientError::InvalidPairing(
            "client nonce must contain 16 bytes".into(),
        ));
    }
    validate_rsa_certificate(context.client_certificate)?;
    validate_rsa_certificate(context.server_certificate)
}

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
    use serde::Deserialize;

    use super::{EncryptedIdentity, PairingIdentityContext, verify_server_identity_record};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        pairing_id: String,
        session_key: String,
        client_nonce: String,
        client_certificate: String,
        server_certificate: String,
        encrypted: String,
        auth_tag: String,
    }

    #[test]
    fn verifies_aludock_typescript_server_identity_fixture() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../tests/fixtures/remote-pairing-server-identity.json"
        ))
        .expect("valid fixture");
        let decode = |value: &str| BASE64.decode(value).expect("fixture base64");
        let session_key: [u8; 64] = decode(&fixture.session_key)
            .try_into()
            .expect("64-byte key");
        let client_nonce: [u8; 16] = decode(&fixture.client_nonce)
            .try_into()
            .expect("16-byte nonce");
        let client_certificate = decode(&fixture.client_certificate);
        let server_certificate = decode(&fixture.server_certificate);
        let record = EncryptedIdentity {
            encrypted: decode(&fixture.encrypted),
            auth_tag: decode(&fixture.auth_tag).try_into().expect("16-byte tag"),
        };
        let context = PairingIdentityContext {
            pairing_id: &fixture.pairing_id,
            client_nonce: &client_nonce,
            client_certificate: &client_certificate,
            server_certificate: &server_certificate,
        };

        verify_server_identity_record(&session_key, &context, &record)
            .expect("Rust must verify the TypeScript reference identity");
    }
}
