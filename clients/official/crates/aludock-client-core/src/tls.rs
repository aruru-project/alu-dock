use std::{fmt, sync::Arc, time::Duration};

use rustls::{
    ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
};
use serde::{Serialize, de::DeserializeOwned};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::{TlsConnector, client::TlsStream};

use crate::{ClientError, ClientIdentity, Endpoint, Result, identity::validate_rsa_certificate};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

pub(crate) struct ConnectedTls {
    pub stream: TlsStream<TcpStream>,
    pub host_certificate: Vec<u8>,
}

pub(crate) async fn connect_tls(
    endpoint: &Endpoint,
    identity: &ClientIdentity,
    expected_host_certificate: Option<&[u8]>,
) -> Result<ConnectedTls> {
    let provider = rustls::crypto::aws_lc_rs::default_provider();
    let verifier = Arc::new(PinnedServerVerifier {
        expected: expected_host_certificate.map(Arc::<[u8]>::from),
        supported: provider.signature_verification_algorithms,
    });
    let certificate = CertificateDer::from(identity.certificate_der().to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        identity.private_key_der().to_vec(),
    ));
    let config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| ClientError::Tls(error.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(vec![certificate], key)
        .map_err(|error| ClientError::Tls(error.to_string()))?;

    let tcp = timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((endpoint.host(), endpoint.port())),
    )
    .await
    .map_err(|_| ClientError::Tls("timed out opening TCP connection".into()))??;
    tcp.set_nodelay(true)?;
    let server_name = ServerName::try_from("alu-dock")
        .expect("static server name is valid")
        .to_owned();
    let stream = timeout(
        CONNECT_TIMEOUT,
        TlsConnector::from(Arc::new(config)).connect(server_name, tcp),
    )
    .await
    .map_err(|_| ClientError::Tls("timed out establishing TLS connection".into()))?
    .map_err(|error| {
        if error.to_string().contains("pinned AluDock certificate") {
            ClientError::HostCertificateMismatch
        } else {
            ClientError::Tls(error.to_string())
        }
    })?;
    let host_certificate = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .map(|certificate| certificate.as_ref().to_vec())
        .ok_or(ClientError::MissingHostCertificate)?;
    if let Some(expected) = expected_host_certificate
        && host_certificate != expected
    {
        return Err(ClientError::HostCertificateMismatch);
    }
    Ok(ConnectedTls {
        stream,
        host_certificate,
    })
}

pub(crate) async fn write_json_line<T, W>(stream: &mut W, value: &T) -> Result<()>
where
    T: Serialize,
    W: AsyncWriteExt + Unpin,
{
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    stream.flush().await?;
    Ok(())
}

pub(crate) async fn read_json_line<T, R>(stream: &mut R, maximum_bytes: usize) -> Result<T>
where
    T: DeserializeOwned,
    R: AsyncReadExt + Unpin,
{
    let mut bytes = Vec::new();
    loop {
        if bytes.len() >= maximum_bytes {
            return Err(ClientError::Protocol(format!(
                "JSONL response exceeded {maximum_bytes} bytes"
            )));
        }
        let mut byte = [0_u8; 1];
        let count = stream.read(&mut byte).await?;
        if count == 0 {
            return Err(ClientError::Protocol(
                "TLS connection closed before a complete JSONL response".into(),
            ));
        }
        if byte[0] == b'\n' {
            break;
        }
        bytes.push(byte[0]);
    }
    serde_json::from_slice(&bytes).map_err(ClientError::from)
}

#[derive(Clone)]
struct PinnedServerVerifier {
    expected: Option<Arc<[u8]>>,
    supported: WebPkiSupportedAlgorithms,
}

impl fmt::Debug for PinnedServerVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PinnedServerVerifier")
            .field("has_expected_certificate", &self.expected.is_some())
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, RustlsError> {
        validate_rsa_certificate(end_entity.as_ref())
            .map_err(|error| RustlsError::General(error.to_string()))?;
        if let Some(expected) = &self.expected
            && expected.as_ref() != end_entity.as_ref()
        {
            return Err(RustlsError::General(
                "pinned AluDock certificate did not match".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, certificate, signature, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, certificate, signature, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}
