use base64::{Engine as _, engine::general_purpose::STANDARD};

use serde::de::DeserializeOwned;
use std::time::Duration;
use tokio::{
    io::{AsyncBufRead, AsyncRead, AsyncReadExt},
    time::timeout,
};

use crate::{ClientError, Result, tls::read_json_line};

// Mirrors src/core/transport-bounds.ts; source-file and image producers have
// their own independent chunk budgets, even where their current values match.
pub(crate) const MAX_CONTROL_BASE64_CHUNK_BYTES: usize = 512 * 1024;

pub(crate) async fn read_timed_json_line<T: DeserializeOwned, R: AsyncBufRead + Unpin>(
    stream: &mut R,
    maximum_bytes: usize,
    idle_timeout: Duration,
    subject: &str,
) -> Result<T> {
    timeout(idle_timeout, read_json_line(stream, maximum_bytes))
        .await
        .map_err(|_| protocol(format!("{subject} timed out")))?
}

/// Only dedicated file streams require EOF after their terminal frame.
/// Ordinary responses and paginated reads must not use this check.
pub(crate) async fn require_clean_end<R: AsyncRead + Unpin>(
    stream: &mut R,
    idle_timeout: Duration,
    subject: &str,
) -> Result<()> {
    let mut trailing = [0_u8; 1];
    let read = timeout(idle_timeout, stream.read(&mut trailing))
        .await
        .map_err(|_| protocol(format!("{subject} timed out before completion closed")))??;
    if read != 0 {
        return Err(protocol(format!("{subject} sent data after completion")));
    }
    Ok(())
}

pub(crate) fn decode_canonical_base64(
    value: &str,
    maximum_bytes: usize,
    subject: &str,
) -> Result<Vec<u8>> {
    let maximum_chars = maximum_bytes.div_ceil(3) * 4;
    if value.is_empty() || value.len() > maximum_chars {
        return Err(protocol(format!("{subject} exceeded its protocol bound")));
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| protocol(format!("{subject} was not valid base64")))?;
    if bytes.len() > maximum_bytes || STANDARD.encode(&bytes) != value {
        return Err(protocol(format!("{subject} was not canonical base64")));
    }
    Ok(bytes)
}

fn protocol(message: impl Into<String>) -> ClientError {
    ClientError::Protocol(message.into())
}
