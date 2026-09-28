//! File-byte I/O has an idle deadline, not an RPC's whole-record deadline.
use crate::{ClientError, Result};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{future::Future, time::Duration};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    sync::watch,
    time::Instant,
};
pub(crate) const FILE_IDLE: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(crate) struct FileActivity(watch::Sender<Instant>);
impl FileActivity {
    pub fn new() -> Self {
        Self(watch::channel(Instant::now()).0)
    }
    pub fn advanced(&self) {
        self.0.send_replace(Instant::now());
    }
    pub async fn wait<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        let mut activity = self.0.subscribe();
        tokio::pin!(future);
        loop {
            let deadline = *activity.borrow_and_update() + FILE_IDLE;
            tokio::select! {
                biased;
                result=&mut future=>return result,
                _=activity.changed()=>{},
                _=tokio::time::sleep_until(deadline)=>return Err(ClientError::Protocol("File transfer was idle for too long".into())),
            }
        }
    }
    pub async fn write<W: AsyncWrite + Unpin>(
        &self,
        writer: &mut W,
        bytes: &[u8],
    ) -> Result<usize> {
        let count = self.wait(async { Ok(writer.write(bytes).await?) }).await?;
        if count == 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::WriteZero).into());
        }
        self.advanced();
        Ok(count)
    }
    pub async fn flush<W: AsyncWrite + Unpin>(&self, writer: &mut W) -> Result<()> {
        self.wait(async { Ok(writer.flush().await?) }).await
    }
}

/// Recognize only the canonical common header, never a kind string inside body data.
pub(crate) fn chunk_header(bytes: &[u8], request: &str, epoch: &str) -> bool {
    let mut rest = &bytes[..bytes.len().min(4096)];
    for (prefix, expected) in [
        (b"{\"kind\":".as_slice(), Value::String("file_chunk".into())),
        (b",\"version\":".as_slice(), Value::from(2)),
        (b",\"requestId\":".as_slice(), Value::String(request.into())),
        (b",\"hostEpoch\":".as_slice(), Value::String(epoch.into())),
    ] {
        let Some(value) = rest.strip_prefix(prefix) else {
            return false;
        };
        let mut parser = serde_json::Deserializer::from_slice(value).into_iter::<Value>();
        if !matches!(parser.next(),Some(Ok(ref parsed)) if *parsed==expected) {
            return false;
        }
        rest = &value[parser.byte_offset()..];
    }
    rest.starts_with(b",")
}

/// Common recognizable header; parsers still accept any JSON field order.
pub(crate) fn encode_record(value: &Value) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Record<'a> {
        kind: &'a Value,
        version: &'a Value,
        request_id: &'a Value,
        host_epoch: &'a Value,
        #[serde(flatten)]
        body: Map<String, Value>,
    }
    let mut body = value
        .as_object()
        .ok_or_else(|| ClientError::Protocol("Invalid file record".into()))?
        .clone();
    for key in ["kind", "version", "requestId", "hostEpoch"] {
        body.remove(key);
    }
    let mut bytes = serde_json::to_vec(&Record {
        kind: &value["kind"],
        version: &value["version"],
        request_id: &value["requestId"],
        host_epoch: &value["hostEpoch"],
        body,
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}
pub(crate) async fn write_file_record<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
    activity: &FileActivity,
) -> Result<()> {
    let bytes = encode_record(value)?;
    let mut offset = 0;
    while offset < bytes.len() {
        offset += activity.write(writer, &bytes[offset..]).await?;
    }
    activity.flush(writer).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, duplex};
    #[tokio::test(start_paused = true)]
    async fn progressing_file_record_can_exceed_rpc_and_file_deadlines_but_a_stall_stops() {
        let (mut writer, mut peer) = duplex(16);
        let frame = serde_json::json!({"kind":"file_chunk","version":2,"requestId":"r","hostEpoch":"h","index":0,"data":"YWJj"});
        let activity = FileActivity::new();
        let sending = write_file_record(&mut writer, &frame, &activity);
        let receiving = async {
            let mut bytes = Vec::new();
            loop {
                tokio::time::sleep(Duration::from_secs(40)).await;
                let mut part = [0; 16];
                let count = peer.read(&mut part).await.unwrap();
                bytes.extend_from_slice(&part[..count]);
                if bytes.ends_with(b"\n") {
                    break;
                }
            }
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes).unwrap()["data"],
                "YWJj"
            );
        };
        let (sent, ()) = tokio::join!(sending, receiving);
        sent.unwrap();
        let (mut blocked, _peer) = duplex(1);
        assert!(write_file_record(&mut blocked,&serde_json::json!({"kind":"file_progress","version":2,"requestId":"r","hostEpoch":"h","consumedBytes":0,"receivedWireBytes":1}),&FileActivity::new()).await.is_err());
    }
}
