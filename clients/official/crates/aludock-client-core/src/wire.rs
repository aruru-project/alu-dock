use base64::{Engine as _, engine::general_purpose::STANDARD};

use crate::{ClientError, Result};

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
