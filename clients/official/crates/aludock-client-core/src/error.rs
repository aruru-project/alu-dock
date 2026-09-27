use std::io;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("{message}")]
    Action {
        code: &'static str,
        message: &'static str,
    },
    #[error("invalid endpoint: {0}")]
    InvalidEndpoint(String),
    #[error("invalid pairing data: {0}")]
    InvalidPairing(String),
    #[error("pairing failed ({code}): {message}")]
    PairingRejected { code: String, message: String },
    #[error("the AluDock host certificate did not match the pinned certificate")]
    HostCertificateMismatch,
    #[error("TLS did not provide a host certificate")]
    MissingHostCertificate,
    #[error("TLS error: {0}")]
    Tls(String),
    #[error("Protocol V2 error: {0}")]
    Protocol(String),
    #[error("AluDock rejected the request ({code}): {message}")]
    Host {
        code: String,
        message: String,
        retryable: bool,
        details: Option<serde_json::Value>,
    },
    #[error("the outcome of operation {operation_id} is unknown: {message}")]
    EffectUnknown {
        operation_id: String,
        message: String,
    },
    #[error("attachment is too large ({size_bytes} bytes; maximum {maximum_bytes} bytes)")]
    AttachmentTooLarge { size_bytes: u64, maximum_bytes: u64 },
    #[error("attachment source changed between hashing and upload")]
    AttachmentSourceChanged,
    #[error("attachment upload was cancelled before completion")]
    AttachmentUploadCancelled,
    #[error("Host registry changed (expected revision {expected}, actual revision {actual})")]
    RegistryConflict { expected: u64, actual: u64 },
    #[error("client preferences changed (expected revision {expected}, actual revision {actual})")]
    PreferencesConflict { expected: u64, actual: u64 },
    #[error(
        "Host connection profile changed (expected revision {expected}, actual revision {actual})"
    )]
    ProfileConflict { expected: u64, actual: u64 },
    #[error("Host is not saved locally: {0}")]
    HostNotFound(String),
    #[error("Host is already saved locally and its identity was not overwritten: {0}")]
    HostAlreadySaved(String),
    #[error("identity storage error at {path}: {source}")]
    Storage {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("cryptographic operation failed: {0}")]
    Crypto(String),
}

pub type Result<T> = std::result::Result<T, ClientError>;
