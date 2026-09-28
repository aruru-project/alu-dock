//! Opted instance observation: one bounded logical record, atomic initial handoff.
use crate::{
    ClientError, Result,
    client::{
        MAX_DOCK_TRANSFER_BYTES, ResponseEnvelope, response_result, validate_response_envelope,
    },
    file_io::{FILE_IDLE, FileActivity, read_byte_record, write_file_record},
    tls::{ConnectedTransport, ControlStream},
    wire::decode_canonical_base64,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};
use tokio::{
    io::{BufReader, ReadHalf, WriteHalf},
    time::Instant,
};

pub(crate) const CAPABILITY: &str = "instance.records.v1";
// Wire constants mirror Protocol V2's file byte-window fragment size, not an event size limit.
const CHUNK_BYTES: usize = 64 * 1024;

/// The choice belongs to an observation owner, including its checkpoint reads and reconnects.
#[derive(Clone, Default)]
pub struct InstanceDeliveryContext(Arc<AtomicU8>);
impl InstanceDeliveryContext {
    pub(crate) fn legacy(&self) -> bool {
        self.0.load(Ordering::Acquire) == 2
    }
    fn began(&self) {
        self.0.store(1, Ordering::Release);
    }
    pub(crate) fn fallback(&self, error: &ClientError) -> bool {
        let missing = matches!(error, ClientError::Host {code,details:Some(details),..}
            if code == "capability_missing" && details["missing"].as_array().is_some_and(|values| values.iter().any(|value| value.as_str() == Some(CAPABILITY))));
        missing
            && self
                .0
                .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }
}

pub(crate) struct InstanceRecords {
    reader: BufReader<ReadHalf<Box<dyn ControlStream>>>,
    writer: WriteHalf<Box<dyn ControlStream>>,
    request: String,
    epoch: String,
    maximum_line: usize,
    record_index: u64,
    wire_bytes: u64,
    consumed: u64,
    transit: u64,
    context: InstanceDeliveryContext,
    deadline: Option<Instant>,
}
fn invalid(message: &str) -> ClientError {
    ClientError::Protocol(message.into())
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("Invalid instance record count"))
}
impl InstanceRecords {
    pub(crate) fn new(
        connection: ConnectedTransport,
        request: String,
        epoch: String,
        maximum_line: usize,
        context: InstanceDeliveryContext,
    ) -> Self {
        let (reader, writer) = tokio::io::split(connection.stream);
        Self {
            reader: BufReader::new(reader),
            writer,
            request,
            epoch,
            maximum_line,
            record_index: 0,
            wire_bytes: 0,
            consumed: 0,
            transit: 0,
            context,
            deadline: Some(Instant::now() + FILE_IDLE),
        }
    }
    fn correlate(&self, value: &Value) -> Result<()> {
        if value["version"] != 2
            || value["requestId"] != self.request
            || value["hostEpoch"] != self.epoch
        {
            return Err(invalid("Instance record correlation changed"));
        }
        Ok(())
    }
    pub(crate) async fn next(&mut self, live: bool) -> Result<Value> {
        if live {
            self.deadline = None;
        }
        let mut bytes = Vec::new();
        let mut index = 0;
        let mut expected_count = None;
        loop {
            let (frame, count) = read_byte_record(
                &mut self.reader,
                &mut self.writer,
                self.maximum_line,
                &self.request,
                &self.epoch,
                self.wire_bytes,
                self.consumed,
                true,
                &mut self.deadline,
                "instance_record",
                || self.context.began(),
            )
            .await?;
            self.wire_bytes += count as u64;
            if frame["kind"] == "instance_record_fragment" {
                self.context.began();
            }
            self.correlate(&frame)?;
            if frame["kind"] == "response" && self.record_index == 0 && index == 0 {
                let response: ResponseEnvelope = serde_json::from_value(frame)?;
                validate_response_envelope(&response, &self.request, &self.epoch)?;
                let _: Value = response_result(response, "instance records", None)?;
                return Err(invalid("Expected instance record fragments"));
            }
            if frame["kind"] == "instance_record_activity" {
                let next = number(&frame, "inTransitBytes")?;
                if next > self.transit {
                    self.transit = next;
                    self.deadline = Some(Instant::now() + FILE_IDLE);
                }
                continue;
            }
            if frame["kind"] != "instance_record_fragment" {
                return Err(invalid("Unexpected instance delivery frame"));
            }
            self.context.began();
            let count = number(&frame, "count")?;
            if number(&frame, "recordIndex")? != self.record_index
                || number(&frame, "index")? != index
                || count == 0
                || count > MAX_DOCK_TRANSFER_BYTES.div_ceil(CHUNK_BYTES) as u64
                || index >= count
                || expected_count.is_some_and(|expected| expected != count)
            {
                return Err(invalid("Instance record fragments are out of order"));
            }
            expected_count = Some(count);
            let part = decode_canonical_base64(
                frame["data"]
                    .as_str()
                    .ok_or_else(|| invalid("Missing instance record bytes"))?,
                CHUNK_BYTES,
                "instance record",
            )?;
            if bytes.len() + part.len() > MAX_DOCK_TRANSFER_BYTES {
                return Err(invalid("Instance record exceeded its aggregate bound"));
            }
            self.consumed += part.len() as u64;
            bytes.extend_from_slice(&part);
            index += 1;
            self.deadline = Some(Instant::now() + FILE_IDLE);
            write_file_record(&mut self.writer,&json!({"kind":"instance_record_progress","version":2,"requestId":self.request,"hostEpoch":self.epoch,"receivedWireBytes":self.wire_bytes,"consumedBytes":self.consumed}),&FileActivity::new()).await?;
            if index == count {
                self.record_index += 1;
                return Ok(serde_json::from_slice(&bytes)?);
            }
        }
    }
    pub(crate) async fn initial(&mut self, read: bool) -> Result<Value> {
        let metadata = self.next(false).await?;
        let response: ResponseEnvelope = serde_json::from_value(metadata)?;
        validate_response_envelope(&response, &self.request, &self.epoch)?;
        let mut result: Value = response_result(response, "instance records", None)?;
        if result["page"]["events"]
            .as_array()
            .is_none_or(|items| !items.is_empty())
            || (read
                && result["recentHistory"]
                    .as_array()
                    .is_none_or(|items| !items.is_empty()))
        {
            return Err(invalid("Instance metadata arrays were not empty"));
        }
        let mut history = Vec::new();
        let mut events = Vec::new();
        let mut ids = HashSet::new();
        loop {
            let mut record = self.next(false).await?;
            self.correlate(&record)?;
            match record["kind"].as_str() {
                Some("instance_history") if read && events.is_empty() => {
                    let entry = record["entry"].take();
                    let parsed: crate::HistoryRecord = serde_json::from_value(entry.clone())?;
                    if !ids.insert(parsed.entry_id) {
                        return Err(invalid("Duplicate instance history record"));
                    }
                    history.push(entry);
                }
                Some("event") => {
                    // Event bodies use the same DTO as ordinary V2; EventPage checks order/domain.
                    let event = record["event"].take();
                    let _: crate::DockEvent = serde_json::from_value(event.clone())?;
                    events.push(event);
                }
                Some("instance_ready") => {
                    if number(&record, "historyEntries")? != history.len() as u64
                        || number(&record, "eventCount")? != events.len() as u64
                    {
                        return Err(invalid("Instance ready counts did not match"));
                    }
                    result["page"]["events"] = Value::Array(events);
                    if read {
                        result["recentHistory"] = Value::Array(history);
                    }
                    return Ok(result);
                }
                _ => return Err(invalid("Instance initial records were out of order")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    // #325: the native observer must not inherit a whole-record/RPC deadline,
    // and a stalled half-frame must fail without returning partial content.
    #[tokio::test(start_paused = true)]
    async fn quiet_follow_and_progressing_partial_records_survive_but_a_partial_stall_ends() {
        let (client, mut peer) = tokio::io::duplex(4096);
        let context = InstanceDeliveryContext::default();
        let mut records = InstanceRecords::new(
            ConnectedTransport {
                stream: Box::new(BufReader::new(client)),
            },
            "r".into(),
            "h".into(),
            1_048_576,
            context.clone(),
        );
        let value = json!({"text":"雪\\\"".repeat(200)});
        use base64::Engine as _;
        let frame = crate::file_io::encode_record(&json!({
            "kind":"instance_record_fragment","version":2,"requestId":"r","hostEpoch":"h",
            "recordIndex":0,"index":0,"count":1,
            "data":base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&value).unwrap())
        })).unwrap();
        let sending = async {
            // No pending live data: this is allowed to be silent indefinitely.
            tokio::time::sleep(std::time::Duration::from_secs(200)).await;
            for part in frame.chunks(256) {
                peer.write_all(part).await.unwrap();
                tokio::time::sleep(std::time::Duration::from_secs(40)).await;
            }
        };
        let (actual, ()) = tokio::join!(records.next(true), sending);
        assert_eq!(actual.unwrap(), value);
        assert_eq!(context.0.load(Ordering::Acquire), 1);

        let prefix = b"{\"kind\":\"instance_record_fragment\",\"version\":2,\"requestId\":\"r\",\"hostEpoch\":\"h\",\"recordIndex\":1,\"index\":0,\"count\":1,\"data\":\"";
        peer.write_all(prefix).await.unwrap();
        let started = Instant::now();
        assert!(records.next(true).await.is_err());
        assert!(started.elapsed() >= FILE_IDLE);
    }
}
