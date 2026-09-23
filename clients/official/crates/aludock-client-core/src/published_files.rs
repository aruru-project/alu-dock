use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncWrite, AsyncWriteExt};

use crate::{
    ClientError, DockClient, Result, capabilities::PUBLISHED_FILES as PUBLISHED_FILE_CAPABILITIES,
    wire::decode_canonical_base64,
};

pub const MAX_PUBLISHED_FILE_REF_CHARS: usize = 128;
pub const MAX_PUBLISHED_FILE_NAME_CHARS: usize = 1_024;
pub const MAX_PUBLISHED_FILE_MEDIA_TYPE_CHARS: usize = 256;
pub const MAX_PUBLISHED_FILE_CHUNK_BYTES: usize = 256 * 1_024;
pub const MAX_PUBLISHED_FILE_BYTES: usize = 512 * 1_024 * 1_024;

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
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
pub struct PublishedFileTransfer {
    pub file: PublishedFileDto,
    pub size_bytes: u64,
    /// Local digest of the received bytes; file.read does not provide a remote digest.
    pub sha256: String,
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
    pub async fn read_published_file<W: AsyncWrite + Unpin>(
        &self,
        instance_id: &str,
        expected_file: &PublishedFileDto,
        sink: &mut W,
    ) -> Result<PublishedFileTransfer> {
        expected_file.validate()?;
        let mut digest = Sha256::new();
        let mut size_bytes = 0_u64;
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
            sink.write_all(&chunk).await.map_err(|e| {
                crate::private_fs::storage_error(std::path::Path::new("published image sink"), e)
            })?;
            digest.update(&chunk);
            size_bytes += chunk.len() as u64;

            if page.complete {
                if size_bytes != expected_file.size_bytes {
                    return Err(protocol(
                        "published file completed with an inconsistent size",
                    ));
                }
                return Ok(PublishedFileTransfer {
                    file: page.file,
                    size_bytes,
                    sha256: hex::encode(digest.finalize()),
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

#[cfg(all(test, unix, not(target_os = "android")))]
mod native_file_test {
    use super::*;
    use crate::{
        ConnectionRouter, IdentityStore, LocalDockEndpoint, MediaScope, SessionContent,
        tls::{read_json_line, write_json_line},
    };
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use serde_json::{Value, json};

    // Published images now use the same opaque native file for viewing and
    // saving. The peer only supplies ordinary file.read pages, no image DTOs.
    #[tokio::test]
    async fn published_image_pages_are_saved_from_the_verified_local_handle() {
        let directory = std::env::temp_dir().join(format!(
            "pf{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::create_dir(&directory).unwrap();
        let socket = directory.join("s");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let file = PublishedFileDto {
            presentation: "image".into(),
            file_ref: "published-original".into(),
            name: "result.png".into(),
            size_bytes: 12,
            media_type: Some("image/png".into()),
        };
        let expected = file.clone();
        let peer = tokio::spawn(async move {
            for (offset, bytes, complete) in [
                (0, &b"\x89PNG\r"[..], false),
                (5, &b"\n\x1a\nbody"[..], true),
            ] {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = tokio::io::BufReader::new(socket);
                let hello: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                write_json_line(&mut socket, &json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
                    "host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
                let request: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                assert_eq!(request["type"], "file.read");
                assert_eq!(request["params"]["offset"], offset);
                write_json_line(&mut socket, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,
                    "result":{"instanceId":"work","runtimeGeneration":1,"file":expected,"offset":offset,"data":STANDARD.encode(bytes),"complete":complete,
                        "nextOffset": if complete { None } else { Some(5) }}})).await.unwrap();
            }
        });
        let client = DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(directory.join("identity")),
                LocalDockEndpoint::configured(socket.to_str().unwrap()).unwrap(),
                "published-test".into(),
            )
            .unwrap(),
        );
        let content = SessionContent::in_directory(directory.join("media")).unwrap();
        let scope = MediaScope {
            authority: "native-authority".into(),
            instance_id: "work".into(),
            host_epoch: "epoch".into(),
            runtime_generation: 1,
        };
        let handle = content
            .published_image(&client, scope.clone(), &file)
            .await
            .unwrap();
        peer.await.unwrap();
        client.router().close();
        assert_eq!(
            content
                .clone()
                .published_image(&client, scope, &file)
                .await
                .unwrap()
                .handle,
            handle.handle
        );
        let destination = directory.join("saved.png");
        let mut sink = std::fs::File::create(&destination).unwrap();
        content.copy_media(&handle.handle, &mut sink).unwrap();
        sink.sync_all().unwrap();
        drop(sink);
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"\x89PNG\r\n\x1a\nbody"
        );
        // file.read has no remote digest; the recorded digest describes the
        // actual locally received/copied file, not a claimed remote SHA check.
        assert_eq!(
            handle.sha256,
            "776f30dcc133299a75c28d425a30a09788b4a3ca62ce3349d27815888ce5262f"
        );
        assert!(content.copy_media("/etc/passwd", std::io::sink()).is_err());
        drop(content);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
