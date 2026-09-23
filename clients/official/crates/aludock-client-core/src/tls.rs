use std::{fmt, sync::Arc};

use rustls::{
    ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
};
use serde::{Serialize, de::DeserializeOwned};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::{TlsConnector, client::TlsStream};

use crate::{
    ClientError, ClientIdentity, Endpoint, Result,
    identity::validate_rsa_certificate,
    timing::{CONNECT_PHASE_TIMEOUT, PROTOCOL_WRITE_TIMEOUT},
};

pub(crate) trait ControlStream: AsyncBufRead + AsyncWrite + Unpin + Send {}
impl<T> ControlStream for T where T: AsyncBufRead + AsyncWrite + Unpin + Send {}

pub(crate) struct ConnectedTransport {
    pub stream: Box<dyn ControlStream>,
}

// Buffer once, after certificate verification, including direct pairing reads.
// BufReader forwards writes/flushes; it does not add a write buffer.
pub(crate) struct ConnectedTls {
    pub stream: BufReader<TlsStream<TcpStream>>,
    pub host_certificate: Vec<u8>,
}

impl From<ConnectedTls> for ConnectedTransport {
    fn from(connection: ConnectedTls) -> Self {
        Self {
            stream: Box::new(connection.stream),
        }
    }
}

#[derive(Clone)]
pub(crate) struct PinnedTlsConnector {
    connector: TlsConnector,
    expected_host_certificate: Option<Arc<[u8]>>,
}

impl PinnedTlsConnector {
    pub(crate) fn new(
        identity: &ClientIdentity,
        expected_host_certificate: Option<&[u8]>,
    ) -> Result<Self> {
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let expected_host_certificate = expected_host_certificate.map(Arc::<[u8]>::from);
        let verifier = Arc::new(PinnedServerVerifier {
            expected: expected_host_certificate.clone(),
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
        Ok(Self {
            connector: TlsConnector::from(Arc::new(config)),
            expected_host_certificate,
        })
    }

    pub(crate) async fn connect(&self, endpoint: &Endpoint) -> Result<ConnectedTls> {
        let tcp = timeout(
            CONNECT_PHASE_TIMEOUT,
            TcpStream::connect((endpoint.host(), endpoint.port())),
        )
        .await
        .map_err(|_| ClientError::Tls("timed out opening TCP connection".into()))??;
        tcp.set_nodelay(true)?;
        let server_name = ServerName::try_from("alu-dock")
            .expect("static server name is valid")
            .to_owned();
        let stream = timeout(
            CONNECT_PHASE_TIMEOUT,
            self.connector.connect(server_name, tcp),
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
        if self
            .expected_host_certificate
            .as_deref()
            .is_some_and(|expected| host_certificate != expected)
        {
            return Err(ClientError::HostCertificateMismatch);
        }
        Ok(ConnectedTls {
            stream: BufReader::new(stream),
            host_certificate,
        })
    }
}

pub(crate) async fn connect_tls(
    endpoint: &Endpoint,
    identity: &ClientIdentity,
    expected_host_certificate: Option<&[u8]>,
) -> Result<ConnectedTls> {
    PinnedTlsConnector::new(identity, expected_host_certificate)?
        .connect(endpoint)
        .await
}

pub(crate) async fn write_json_line<T, W>(stream: &mut W, value: &T) -> Result<()>
where
    T: Serialize,
    W: AsyncWriteExt + Unpin,
{
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    timeout(PROTOCOL_WRITE_TIMEOUT, async {
        stream.write_all(&bytes).await?;
        stream.flush().await?;
        Result::<()>::Ok(())
    })
    .await
    .map_err(|_| ClientError::Protocol("timed out writing a protocol frame".into()))?
}

pub(crate) async fn read_json_line<T, R>(stream: &mut R, maximum_bytes: usize) -> Result<T>
where
    T: DeserializeOwned,
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    loop {
        // The limit includes the newline. In particular, reject zero before
        // waiting for input, and retain all bytes after this frame in the
        // connection-owned buffer for the next frame or terminal EOF check.
        if bytes.len() >= maximum_bytes {
            return Err(ClientError::Protocol(format!(
                "JSONL response exceeded {maximum_bytes} bytes"
            )));
        }
        let available = stream.fill_buf().await?;
        if available.is_empty() {
            return Err(ClientError::Protocol(
                "TLS connection closed before a complete JSONL response".into(),
            ));
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if bytes.len().saturating_add(newline) >= maximum_bytes {
                return Err(ClientError::Protocol(format!(
                    "JSONL response exceeded {maximum_bytes} bytes"
                )));
            }
            bytes.extend_from_slice(&available[..newline]);
            stream.consume(newline + 1);
            break;
        }
        if bytes.len().saturating_add(available.len()) >= maximum_bytes {
            return Err(ClientError::Protocol(format!(
                "JSONL response exceeded {maximum_bytes} bytes"
            )));
        }
        let consumed = available.len();
        bytes.extend_from_slice(available);
        stream.consume(consumed);
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::io::AsyncReadExt;
    use tokio::time::Duration;

    // V2's maximum line bytes includes the newline: exceeding it must not
    // become an unbounded allocation or a newly accepted protocol frame.
    #[tokio::test]
    async fn jsonl_frames_preserve_the_newline_inclusive_byte_limit() {
        for capacity in [1, 2, 8192] {
            for (wire, maximum, accepted) in [
                ("0\n", 2, true),
                ("0\n", 1, false),
                ("1234\n", 5, true),
                ("1234\n", 4, false),
                ("\"é\"\n", 5, true),
                ("\"é\"\n", 4, false),
            ] {
                let mut reader = BufReader::with_capacity(capacity, wire.as_bytes());
                let result = read_json_line::<Value, _>(&mut reader, maximum).await;
                if accepted {
                    assert_eq!(
                        result.unwrap(),
                        serde_json::from_str::<Value>(wire).unwrap()
                    );
                } else {
                    assert!(matches!(result, Err(ClientError::Protocol(_))));
                }
            }
        }
    }

    // Connection read-ahead must survive across hello/response/event frames
    // and remain visible to terminal EOF checks, even in a single buffer.
    #[tokio::test]
    async fn consecutive_jsonl_frames_leave_terminal_tail_bytes_visible() {
        for capacity in [1, 2, 8192] {
            let mut reader = BufReader::with_capacity(capacity, &b"{\"ok\":true}\n[1,2]\n!"[..]);
            assert_eq!(
                read_json_line::<Value, _>(&mut reader, 12).await.unwrap(),
                json!({"ok":true})
            );
            assert_eq!(
                read_json_line::<Value, _>(&mut reader, 6).await.unwrap(),
                json!([1, 2])
            );
            let mut tail = Vec::new();
            reader.read_to_end(&mut tail).await.unwrap();
            assert_eq!(tail, b"!");
        }
    }

    #[tokio::test]
    async fn jsonl_requires_a_complete_frame_and_respects_the_callers_timeout() {
        for wire in ["", "0", "{\"ok\":true}"] {
            let mut reader = BufReader::with_capacity(2, wire.as_bytes());
            assert!(matches!(
                read_json_line::<Value, _>(&mut reader, 64).await,
                Err(ClientError::Protocol(_))
            ));
        }
        let (stream, _peer) = tokio::io::duplex(64);
        let mut reader = BufReader::new(stream);
        // A zero budget must fail without waiting for this silent peer.
        let zero = timeout(
            Duration::from_millis(250),
            read_json_line::<Value, _>(&mut reader, 0),
        )
        .await
        .unwrap();
        assert!(matches!(zero, Err(ClientError::Protocol(_))));
        assert!(
            timeout(
                Duration::from_millis(20),
                read_json_line::<Value, _>(&mut reader, 64)
            )
            .await
            .is_err()
        );
    }
}
