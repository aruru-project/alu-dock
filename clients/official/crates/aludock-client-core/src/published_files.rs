use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

use crate::{ClientError, DockClient, Result, wire::decode_canonical_base64};

pub const MAX_PUBLISHED_FILE_REF_CHARS: usize = 128;
pub const MAX_PUBLISHED_FILE_NAME_CHARS: usize = 1_024;
pub const MAX_PUBLISHED_FILE_MEDIA_TYPE_CHARS: usize = 256;
pub const MAX_PUBLISHED_FILE_CHUNK_BYTES: usize = 256 * 1_024;
pub const MAX_PUBLISHED_FILE_BYTES: usize = 512 * 1_024 * 1_024;

const PUBLISHED_FILE_CAPABILITIES: &[&str] = &["core.v2", "published-files.v1"];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedFileDto {
    pub presentation: String,
    pub file_ref: String,
    pub name: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishedFileWire {
    presentation: String,
    file_ref: String,
    name: String,
    size_bytes: u64,
    media_type: Option<String>,
}

impl<'de> Deserialize<'de> for PublishedFileDto {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = PublishedFileWire::deserialize(deserializer)?;
        let value = Self {
            presentation: wire.presentation,
            file_ref: wire.file_ref,
            name: wire.name,
            size_bytes: wire.size_bytes,
            media_type: wire.media_type,
        };
        value.validate().map_err(D::Error::custom)?;
        Ok(value)
    }
}

impl PublishedFileDto {
    pub fn validate(&self) -> Result<()> {
        if self.presentation != "image"
            || self.file_ref.is_empty()
            || self.file_ref.len() > MAX_PUBLISHED_FILE_REF_CHARS
            || self.name.is_empty()
            || self.name.len() > MAX_PUBLISHED_FILE_NAME_CHARS
            || self.size_bytes == 0
            || self.size_bytes > MAX_PUBLISHED_FILE_BYTES as u64
            || self.media_type.as_ref().is_some_and(|value| {
                value.is_empty() || value.len() > MAX_PUBLISHED_FILE_MEDIA_TYPE_CHARS
            })
        {
            return Err(protocol("published file metadata was invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct PublishedFileBytes {
    pub file: PublishedFileDto,
    pub bytes: Vec<u8>,
    pub host_epoch: String,
    pub runtime_generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileReadWireResult {
    instance_id: String,
    runtime_generation: u64,
    file: PublishedFileDto,
    offset: u64,
    data: String,
    complete: bool,
    next_offset: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReadParams<'a> {
    instance_id: &'a str,
    file_ref: &'a str,
    offset: u64,
}

impl DockClient {
    pub async fn read_published_file(
        &self,
        instance_id: &str,
        expected_file: &PublishedFileDto,
    ) -> Result<PublishedFileBytes> {
        expected_file.validate()?;
        let capacity = usize::try_from(expected_file.size_bytes)
            .map_err(|_| protocol("published file size was unsupported on this device"))?;
        let mut bytes = Vec::with_capacity(capacity);
        let mut offset = 0_u64;
        let mut expected_epoch: Option<String> = None;
        let mut expected_generation: Option<u64> = None;

        loop {
            let (page, host_epoch): (FileReadWireResult, String) = self
                .request_with_host_epoch(
                    "file.read",
                    &FileReadParams {
                        instance_id,
                        file_ref: &expected_file.file_ref,
                        offset,
                    },
                    PUBLISHED_FILE_CAPABILITIES,
                    None,
                )
                .await?;
            let chunk = validate_file_page(&page, instance_id, expected_file, offset)?;
            if expected_epoch
                .as_ref()
                .is_some_and(|value| value != &host_epoch)
                || expected_generation.is_some_and(|value| value != page.runtime_generation)
            {
                return Err(protocol(
                    "published file changed while it was being downloaded",
                ));
            }
            expected_epoch.get_or_insert(host_epoch);
            expected_generation.get_or_insert(page.runtime_generation);
            bytes.extend_from_slice(&chunk);

            if page.complete {
                if bytes.len() as u64 != expected_file.size_bytes {
                    return Err(protocol(
                        "published file completed with an inconsistent size",
                    ));
                }
                return Ok(PublishedFileBytes {
                    file: page.file,
                    bytes,
                    host_epoch: expected_epoch.unwrap_or_default(),
                    runtime_generation: expected_generation.unwrap_or_default(),
                });
            }
            offset = page
                .next_offset
                .ok_or_else(|| protocol("published file continuation was missing"))?;
        }
    }
}

fn validate_file_page(
    page: &FileReadWireResult,
    instance_id: &str,
    expected_file: &PublishedFileDto,
    expected_offset: u64,
) -> Result<Vec<u8>> {
    if page.instance_id != instance_id
        || page.runtime_generation == 0
        || page.file != *expected_file
        || page.offset != expected_offset
    {
        return Err(protocol(
            "published file response belonged to another request",
        ));
    }
    let bytes = decode_canonical_base64(
        &page.data,
        MAX_PUBLISHED_FILE_CHUNK_BYTES,
        "published file data",
    )?;
    if bytes.is_empty() {
        return Err(protocol("published file response contained an empty chunk"));
    }
    let end = page
        .offset
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| protocol("published file offset overflowed"))?;
    let continuation_is_valid = if page.complete {
        page.next_offset.is_none() && end == page.file.size_bytes
    } else {
        page.next_offset == Some(end) && end < page.file.size_bytes
    };
    if page.offset >= page.file.size_bytes || end > page.file.size_bytes || !continuation_is_valid {
        return Err(protocol("published file pagination was inconsistent"));
    }
    Ok(bytes)
}

fn protocol(message: impl Into<String>) -> ClientError {
    ClientError::Protocol(message.into())
}

#[cfg(test)]
mod tests {
    use super::{FileReadWireResult, PublishedFileDto, validate_file_page};

    fn file() -> PublishedFileDto {
        PublishedFileDto {
            presentation: "image".into(),
            file_ref: "file-1".into(),
            name: "result.png".into(),
            size_bytes: 5,
            media_type: Some("image/png".into()),
        }
    }

    #[test]
    fn published_file_pages_reconstruct_only_exact_contiguous_bytes() {
        let first = FileReadWireResult {
            instance_id: "work-1".into(),
            runtime_generation: 2,
            file: file(),
            offset: 0,
            data: "aGVs".into(),
            complete: false,
            next_offset: Some(3),
        };
        let second = FileReadWireResult {
            offset: 3,
            data: "bG8=".into(),
            complete: true,
            next_offset: None,
            ..first.clone()
        };
        let mut bytes = validate_file_page(&first, "work-1", &file(), 0).unwrap();
        bytes.extend(validate_file_page(&second, "work-1", &file(), 3).unwrap());
        assert_eq!(bytes, b"hello");

        let drifted = FileReadWireResult {
            offset: 4,
            ..second
        };
        assert!(validate_file_page(&drifted, "work-1", &file(), 3).is_err());
    }
}
