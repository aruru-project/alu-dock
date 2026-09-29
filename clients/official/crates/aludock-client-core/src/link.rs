//! One authenticated connection to a Host carrying many Protocol V2 streams.
//!
//! After a hello that negotiated `transport.multiplex.v1`, every record on the
//! connection is a link record. Each stream is an ordinary Protocol V2
//! connection (its own hello, one request, the response or follow) tunnelled
//! as `stream_data` records, so every consumer keeps reading and writing JSONL
//! exactly as it does on a raw socket. The client pings; a silent link is
//! closed here, and the Host drops a client that stops pinging.
use std::{
    collections::HashMap,
    io,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
    time::Duration,
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufRead, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf},
    sync::{Notify, mpsc},
    task::JoinHandle,
    time::Instant,
};
use uuid::Uuid;

use crate::{
    ClientError, Result,
    client::{HelloAck, MAX_CONTROL_LINE_BYTES, encode_client_hello, validate_hello_line},
    timing::{LINK_PING_INTERVAL, LINK_PONG_TIMEOUT, PROTOCOL_WRITE_TIMEOUT},
    tls::{ConnectedTransport, ControlStream, read_json_line},
};

pub(crate) const MULTIPLEX_CAPABILITY: &str = "transport.multiplex.v1";
/// A link record wraps one Protocol V2 line (the Host bound, mirrored here).
const MAX_LINK_LINE_BYTES: usize = 2 * MAX_CONTROL_LINE_BYTES;
/// Streams one link may hold at once (the Host bound, mirrored here so a
/// request is refused before anything is sent rather than reset after).
const MAX_LINK_STREAMS: usize = 256;
/// Outbound records waiting for the socket; producers wait beyond this.
const MAX_LINK_OUTPUT_BYTES: usize = 8 * MAX_LINK_LINE_BYTES;
/// Inbound records a stream's consumer has not read yet; the stream is reset beyond this.
const MAX_STREAM_INPUT_BYTES: usize = 4 * MAX_LINK_LINE_BYTES;

/// The Host refused a stream's hello; carried through the stream's read error.
#[derive(Clone, Debug)]
pub(crate) struct HostRejection {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl std::fmt::Display for HostRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for HostRejection {}

/// Told the link's own id when the link ends on its own (not when the route closes it).
pub(crate) type LinkClosedCallback = Box<dyn FnOnce(Uuid) + Send>;

enum Inbound {
    Data(Vec<u8>),
    Close,
    Reset(String),
    HelloRejected(HostRejection),
}

struct PendingHello {
    request_id: String,
    required: Vec<String>,
}

struct StreamSlot {
    inbound: mpsc::UnboundedSender<Inbound>,
    queued: Arc<AtomicUsize>,
    pending_hello: Option<PendingHello>,
}

struct LinkInner {
    id: Uuid,
    hello: HelloAck,
    outbound: mpsc::UnboundedSender<Vec<u8>>,
    outbound_bytes: AtomicUsize,
    output_waiters: Mutex<Vec<Waker>>,
    streams: Mutex<HashMap<String, StreamSlot>>,
    closed: AtomicBool,
    closed_notify: Notify,
    last_inbound: Mutex<Instant>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    on_closed: Mutex<Option<LinkClosedCallback>>,
}

#[derive(Clone)]
pub(crate) struct Link {
    inner: Arc<LinkInner>,
}

impl Link {
    /// The connection already completed a hello requiring `transport.multiplex.v1`.
    pub(crate) fn establish(
        connection: ConnectedTransport,
        hello: HelloAck,
        on_closed: LinkClosedCallback,
    ) -> Self {
        let (outbound, outbound_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(LinkInner {
            id: Uuid::new_v4(),
            hello,
            outbound,
            outbound_bytes: AtomicUsize::new(0),
            output_waiters: Mutex::new(Vec::new()),
            streams: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            closed_notify: Notify::new(),
            last_inbound: Mutex::new(Instant::now()),
            tasks: Mutex::new(Vec::new()),
            on_closed: Mutex::new(Some(on_closed)),
        });
        let link = Self { inner };
        let (read_half, write_half) = tokio::io::split(connection.stream);
        let reader = tokio::spawn(link.clone().read_loop(BufReader::new(read_half)));
        let writer = tokio::spawn(link.clone().write_loop(write_half, outbound_rx));
        let pinger = tokio::spawn(link.clone().ping_loop());
        if let Ok(mut tasks) = link.inner.tasks.lock() {
            tasks.extend([reader, writer, pinger]);
        }
        link
    }

    pub(crate) fn hello(&self) -> &HelloAck {
        &self.inner.hello
    }

    pub(crate) fn id(&self) -> Uuid {
        self.inner.id
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Open one stream and pipeline its hello; the first inbound record is that
    /// hello's reply and is validated before any response bytes reach the reader.
    pub(crate) fn open_stream(
        &self,
        client_id: &str,
        required_capabilities: &[&str],
    ) -> Result<ConnectedTransport> {
        if self.is_closed() {
            return Err(link_closed_error());
        }
        let missing: Vec<&str> = required_capabilities
            .iter()
            .copied()
            .filter(|capability| {
                !self
                    .inner
                    .hello
                    .capabilities
                    .iter()
                    .any(|advertised| advertised == capability)
            })
            .collect();
        if !missing.is_empty() {
            let mut sorted = missing.clone();
            sorted.sort_unstable();
            return Err(ClientError::Host {
                code: "capability_missing".into(),
                message: "Required capabilities are unavailable".into(),
                retryable: false,
                details: Some(serde_json::json!({ "missing": sorted })),
            });
        }
        let stream_id = Uuid::new_v4().to_string();
        let hello_request_id = Uuid::new_v4().to_string();
        let (inbound, receiver) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        {
            let mut streams = self.inner.streams.lock().map_err(|_| link_state_error())?;
            if streams.len() >= MAX_LINK_STREAMS {
                return Err(ClientError::Protocol(
                    "too many requests are open on the Host link".into(),
                ));
            }
            streams.insert(
                stream_id.clone(),
                StreamSlot {
                    inbound,
                    queued: queued.clone(),
                    pending_hello: Some(PendingHello {
                        request_id: hello_request_id.clone(),
                        required: required_capabilities
                            .iter()
                            .map(|capability| (*capability).to_owned())
                            .collect(),
                    }),
                },
            );
        }
        self.send(&serde_json::json!({ "kind": "stream_open", "streamId": stream_id }))?;
        let hello = encode_client_hello(&hello_request_id, client_id, required_capabilities)?;
        self.send(
            &serde_json::json!({ "kind": "stream_data", "streamId": stream_id, "data": hello }),
        )?;
        let stream = VirtualStream {
            link: self.clone(),
            stream_id,
            receiver,
            queued,
            current: Vec::new(),
            offset: 0,
            pending_line: Vec::new(),
            read_ended: false,
            write_closed: false,
        };
        Ok(ConnectedTransport {
            stream: Box::new(BufReader::new(stream)),
        })
    }

    /// The route gave this link up on purpose: no address failure is reported.
    pub(crate) fn close(&self) {
        if let Ok(mut slot) = self.inner.on_closed.lock() {
            slot.take();
        }
        self.finish("Host link closed");
    }

    fn finish(&self, reason: &str) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = reason;
        if let Ok(mut streams) = self.inner.streams.lock() {
            streams.clear();
        }
        self.inner.closed_notify.notify_waiters();
        if let Ok(mut waiters) = self.inner.output_waiters.lock() {
            for waker in waiters.drain(..) {
                waker.wake();
            }
        }
        if let Ok(mut tasks) = self.inner.tasks.lock() {
            for task in tasks.drain(..) {
                task.abort();
            }
        }
        let callback = self
            .inner
            .on_closed
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(callback) = callback {
            callback(self.inner.id);
        }
    }

    fn send(&self, record: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(record)?;
        bytes.push(b'\n');
        if bytes.len() > MAX_LINK_LINE_BYTES {
            return Err(ClientError::Protocol(
                "link record exceeds its line bound".into(),
            ));
        }
        self.inner
            .outbound_bytes
            .fetch_add(bytes.len(), Ordering::SeqCst);
        self.inner
            .outbound
            .send(bytes)
            .map_err(|_| link_closed_error())
    }

    fn output_has_room(&self, cx: &Context<'_>) -> bool {
        if self.inner.outbound_bytes.load(Ordering::SeqCst) < MAX_LINK_OUTPUT_BYTES {
            return true;
        }
        if let Ok(mut waiters) = self.inner.output_waiters.lock() {
            waiters.push(cx.waker().clone());
        }
        // Re-check after registering, so a drain between the load and the push is not missed.
        self.inner.outbound_bytes.load(Ordering::SeqCst) < MAX_LINK_OUTPUT_BYTES
    }

    fn release_stream(&self, stream_id: &str, notify_peer: bool) {
        let removed = self
            .inner
            .streams
            .lock()
            .ok()
            .map(|mut streams| streams.remove(stream_id).is_some())
            .unwrap_or(false);
        if removed && notify_peer && !self.is_closed() {
            let _ =
                self.send(&serde_json::json!({ "kind": "stream_close", "streamId": stream_id }));
        }
    }

    async fn write_loop(
        self,
        mut writer: tokio::io::WriteHalf<Box<dyn ControlStream>>,
        mut outbound: mpsc::UnboundedReceiver<Vec<u8>>,
    ) {
        while let Some(bytes) = outbound.recv().await {
            let written = tokio::time::timeout(PROTOCOL_WRITE_TIMEOUT, async {
                writer.write_all(&bytes).await?;
                writer.flush().await
            })
            .await;
            self.inner
                .outbound_bytes
                .fetch_sub(bytes.len(), Ordering::SeqCst);
            if let Ok(mut waiters) = self.inner.output_waiters.lock() {
                for waker in waiters.drain(..) {
                    waker.wake();
                }
            }
            match written {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return self.finish("Host link write failed"),
                Err(_) => return self.finish("Host link write timed out"),
            }
        }
    }

    async fn ping_loop(self) {
        loop {
            tokio::time::sleep(LINK_PING_INTERVAL).await;
            if self.is_closed() {
                return;
            }
            let silent = self
                .inner
                .last_inbound
                .lock()
                .map(|at| at.elapsed())
                .unwrap_or(Duration::ZERO);
            if silent > LINK_PING_INTERVAL + LINK_PONG_TIMEOUT {
                return self.finish("Host link stopped answering");
            }
            if self.send(&serde_json::json!({ "kind": "ping" })).is_err() {
                return;
            }
        }
    }

    async fn read_loop<R: AsyncBufRead + Unpin>(self, mut reader: R) {
        loop {
            let record: Value = match read_json_line(&mut reader, MAX_LINK_LINE_BYTES).await {
                Ok(record) => record,
                Err(_) => return self.finish("Host link ended"),
            };
            if let Ok(mut at) = self.inner.last_inbound.lock() {
                *at = Instant::now();
            }
            let kind = record.get("kind").and_then(Value::as_str).unwrap_or("");
            let stream_id = record.get("streamId").and_then(Value::as_str);
            match (kind, stream_id) {
                ("pong", None) => {}
                ("ping", None) => {
                    if self.send(&serde_json::json!({ "kind": "pong" })).is_err() {
                        return;
                    }
                }
                ("stream_data", Some(stream_id)) => {
                    let Some(data) = record.get("data").and_then(Value::as_str) else {
                        return self.finish("Host link sent an invalid stream record");
                    };
                    if data.len() > MAX_CONTROL_LINE_BYTES {
                        return self.finish("Host link sent an oversized stream record");
                    }
                    self.deliver_data(stream_id, data);
                }
                ("stream_close", Some(stream_id)) => {
                    self.deliver(stream_id, Inbound::Close, true);
                }
                ("stream_reset", Some(stream_id)) => {
                    let reason = record
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Host reset the stream")
                        .to_owned();
                    self.deliver(stream_id, Inbound::Reset(reason), true);
                }
                _ => return self.finish("Host link sent an unknown record"),
            }
        }
    }

    fn deliver_data(&self, stream_id: &str, data: &str) {
        let mut streams = match self.inner.streams.lock() {
            Ok(streams) => streams,
            Err(_) => return,
        };
        let Some(slot) = streams.get_mut(stream_id) else {
            return;
        };
        if let Some(pending) = slot.pending_hello.take() {
            let required: Vec<&str> = pending.required.iter().map(String::as_str).collect();
            match validate_hello_line(data, &pending.request_id, &required) {
                Ok(_) => {}
                Err(ClientError::Host {
                    code,
                    message,
                    retryable,
                    details,
                }) => {
                    let _ = slot.inbound.send(Inbound::HelloRejected(HostRejection {
                        code,
                        message,
                        retryable,
                        details,
                    }));
                    streams.remove(stream_id);
                }
                Err(error) => {
                    let _ = slot.inbound.send(Inbound::Reset(error.to_string()));
                    streams.remove(stream_id);
                }
            }
            return;
        }
        let queued = slot.queued.fetch_add(data.len() + 1, Ordering::SeqCst) + data.len() + 1;
        if queued > MAX_STREAM_INPUT_BYTES {
            let _ = slot.inbound.send(Inbound::Reset(
                "stream input queue exceeded its bound".into(),
            ));
            streams.remove(stream_id);
            drop(streams);
            let _ = self.send(&serde_json::json!({
                "kind": "stream_reset", "streamId": stream_id, "reason": "Stream input queue exceeded its bound"
            }));
            return;
        }
        let mut line = Vec::with_capacity(data.len() + 1);
        line.extend_from_slice(data.as_bytes());
        line.push(b'\n');
        let _ = slot.inbound.send(Inbound::Data(line));
    }

    fn deliver(&self, stream_id: &str, inbound: Inbound, remove: bool) {
        let Ok(mut streams) = self.inner.streams.lock() else {
            return;
        };
        if remove {
            if let Some(slot) = streams.remove(stream_id) {
                let _ = slot.inbound.send(inbound);
            }
        } else if let Some(slot) = streams.get(stream_id) {
            let _ = slot.inbound.send(inbound);
        }
    }
}

impl Drop for LinkInner {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            for task in tasks.drain(..) {
                task.abort();
            }
        }
    }
}

fn link_closed_error() -> ClientError {
    ClientError::Protocol("Host link closed".into())
}

fn link_state_error() -> ClientError {
    ClientError::Protocol("Host link state is unavailable".into())
}

/// One stream on the link, presented to consumers as an ordinary connection.
struct VirtualStream {
    link: Link,
    stream_id: String,
    receiver: mpsc::UnboundedReceiver<Inbound>,
    queued: Arc<AtomicUsize>,
    current: Vec<u8>,
    offset: usize,
    pending_line: Vec<u8>,
    read_ended: bool,
    write_closed: bool,
}

impl AsyncRead for VirtualStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            if self.offset < self.current.len() {
                let available = &self.current[self.offset..];
                let count = available.len().min(buf.remaining());
                buf.put_slice(&available[..count]);
                self.offset += count;
                if self.offset == self.current.len() {
                    self.current.clear();
                    self.offset = 0;
                }
                return Poll::Ready(Ok(()));
            }
            if self.read_ended {
                return Poll::Ready(Ok(()));
            }
            match self.receiver.poll_recv(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Inbound::Data(line))) => {
                    self.queued.fetch_sub(line.len(), Ordering::SeqCst);
                    self.current = line;
                    self.offset = 0;
                }
                Poll::Ready(Some(Inbound::Close)) => {
                    self.read_ended = true;
                    return Poll::Ready(Ok(()));
                }
                Poll::Ready(Some(Inbound::Reset(reason))) => {
                    self.read_ended = true;
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        reason,
                    )));
                }
                Poll::Ready(Some(Inbound::HelloRejected(rejection))) => {
                    self.read_ended = true;
                    return Poll::Ready(Err(io::Error::other(rejection)));
                }
                Poll::Ready(None) => {
                    self.read_ended = true;
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        "Host link closed",
                    )));
                }
            }
        }
    }
}

impl AsyncWrite for VirtualStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.write_closed {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stream is closed",
            )));
        }
        if self.link.is_closed() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Host link closed",
            )));
        }
        if !self.link.output_has_room(cx) {
            return Poll::Pending;
        }
        self.pending_line.extend_from_slice(bytes);
        while let Some(newline) = self.pending_line.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending_line.drain(..=newline).collect();
            let text = match std::str::from_utf8(&line[..line.len() - 1]) {
                Ok(text) => text,
                Err(_) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "protocol line is not UTF-8",
                    )));
                }
            };
            let record = serde_json::json!({ "kind": "stream_data", "streamId": self.stream_id, "data": text });
            if let Err(error) = self.link.send(&record) {
                return Poll::Ready(Err(io::Error::other(error.to_string())));
            }
        }
        if self.pending_line.len() > MAX_CONTROL_LINE_BYTES {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "protocol line exceeds its bound",
            )));
        }
        Poll::Ready(Ok(bytes.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    /// A stream close is a full close on the Host, like a socket close; only dropping the stream sends it.
    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.write_closed = true;
        Poll::Ready(Ok(()))
    }
}

impl Drop for VirtualStream {
    fn drop(&mut self) {
        self.link.release_stream(&self.stream_id, true);
    }
}

#[cfg(test)]
mod tests {
    //! A fixture Host that carries links, as the real Host does after
    //! `transport.multiplex.v1`: the first hello reply advertises it, later
    //! connections are links whose streams each do hello + request.
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use crate::{
        ClientError, ConnectionRouter, DockClient, IdentityStore, LocalDockEndpoint,
        tls::{read_json_line, write_json_line},
    };

    fn hello_ack(hello: &Value, epoch: &str) -> Value {
        json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
            "host":{"hostEpoch":epoch},"capabilities":["core.v2","host.info","instance.catalog","transport.multiplex.v1"],"limits":{"maxLineBytes":1048576}})
    }

    fn host_info(request: &Value, epoch: &str) -> Value {
        json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":epoch,"ok":true,
            "result":{"state":"running","host":{"pid":1,"dockVersion":"0","piSdkVersion":"0","hostEpoch":epoch,"startedAt":"2026-01-01T00:00:00.000Z"},"catalog":{},"paths":{},"diagnostics":[]}})
    }

    struct Fixture {
        directory: std::path::PathBuf,
        socket: std::path::PathBuf,
        connections: Arc<AtomicUsize>,
        pings: Arc<AtomicUsize>,
    }

    /// `answer_pings` false models a Host whose link went silent after a request answered.
    fn spawn_fixture(
        epoch: &'static str,
        answer_pings: bool,
        drop_link_after_streams: Option<usize>,
    ) -> Fixture {
        let directory = std::env::temp_dir().join(format!(
            "link-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::create_dir(&directory).unwrap();
        let socket = directory.join("s");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let pings = Arc::new(AtomicUsize::new(0));
        let (seen, ping_count) = (connections.clone(), pings.clone());
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                seen.fetch_add(1, Ordering::SeqCst);
                let ping_count = ping_count.clone();
                tokio::spawn(async move {
                    let mut stream = BufReader::new(stream);
                    let hello: Value = read_json_line(&mut stream, 1 << 20).await.unwrap();
                    write_json_line(&mut stream, &hello_ack(&hello, epoch))
                        .await
                        .unwrap();
                    let required = hello["requiredCapabilities"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    if !required
                        .iter()
                        .any(|value| value == "transport.multiplex.v1")
                    {
                        let request: Value = read_json_line(&mut stream, 1 << 20).await.unwrap();
                        write_json_line(&mut stream, &host_info(&request, epoch))
                            .await
                            .unwrap();
                        return;
                    }
                    let mut hellos: std::collections::HashMap<String, bool> = Default::default();
                    let mut served = 0;
                    loop {
                        let mut line = String::new();
                        if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        let record: Value = serde_json::from_str(&line).unwrap();
                        match record["kind"].as_str().unwrap() {
                            "ping" => {
                                ping_count.fetch_add(1, Ordering::SeqCst);
                                if answer_pings {
                                    write_json_line(&mut stream, &json!({"kind":"pong"}))
                                        .await
                                        .unwrap();
                                }
                            }
                            "stream_open" => {
                                hellos
                                    .insert(record["streamId"].as_str().unwrap().to_owned(), false);
                            }
                            "stream_close" => {
                                hellos.remove(record["streamId"].as_str().unwrap());
                            }
                            "stream_data" => {
                                let stream_id = record["streamId"].as_str().unwrap().to_owned();
                                let inner: Value =
                                    serde_json::from_str(record["data"].as_str().unwrap()).unwrap();
                                let reply = if inner["kind"] == "hello" {
                                    assert_eq!(hellos.insert(stream_id.clone(), true), Some(false));
                                    let missing: Vec<&Value> = inner["requiredCapabilities"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .filter(|value| {
                                            value.as_str() == Some("no.such.capability")
                                        })
                                        .collect();
                                    if missing.is_empty() {
                                        hello_ack(&inner, epoch)
                                    } else {
                                        json!({"kind":"hello_error","requestId":inner["requestId"],"error":{"code":"capability_missing","message":"Required capabilities are unavailable","missing":["no.such.capability"]}})
                                    }
                                } else {
                                    assert_eq!(
                                        hellos.get(&stream_id),
                                        Some(&true),
                                        "request before hello"
                                    );
                                    host_info(&inner, epoch)
                                };
                                let closes = reply["kind"] != "hello_ack";
                                write_json_line(&mut stream, &json!({"kind":"stream_data","streamId":stream_id,"data":serde_json::to_string(&reply).unwrap()})).await.unwrap();
                                if closes {
                                    write_json_line(
                                        &mut stream,
                                        &json!({"kind":"stream_close","streamId":stream_id}),
                                    )
                                    .await
                                    .unwrap();
                                    served += 1;
                                    if drop_link_after_streams == Some(served) {
                                        stream.get_mut().shutdown().await.unwrap();
                                        return;
                                    }
                                }
                            }
                            other => panic!("unexpected link record {other}"),
                        }
                    }
                });
            }
        });
        Fixture {
            directory,
            socket,
            connections,
            pings,
        }
    }

    fn client(fixture: &Fixture) -> DockClient {
        DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(fixture.directory.join("identity")),
                LocalDockEndpoint::configured(fixture.socket.to_str().unwrap()).unwrap(),
                "link-test".into(),
            )
            .unwrap(),
        )
    }

    // Card #329: after the first reply says the Host carries links, every later
    // request is a stream on one connection instead of a new handshake.
    #[tokio::test]
    async fn requests_after_the_first_share_one_connection_and_a_stream_refusal_is_the_hosts_error()
    {
        let fixture = spawn_fixture("epoch", true, None);
        let client = client(&fixture);
        assert_eq!(client.host_info().await.unwrap().host.host_epoch, "epoch");
        assert_eq!(fixture.connections.load(Ordering::SeqCst), 1);
        let (a, b, c) = tokio::join!(client.host_info(), client.host_info(), client.host_info());
        assert!(a.is_ok() && b.is_ok() && c.is_ok());
        assert_eq!(client.host_info().await.unwrap().host.host_epoch, "epoch");
        assert_eq!(
            fixture.connections.load(Ordering::SeqCst),
            2,
            "one link after the discovering connection"
        );
        let refused = client
            .router()
            .acquire(&["no.such.capability"])
            .await
            .err()
            .expect("an unadvertised capability is refused before any stream opens");
        assert!(
            matches!(refused, ClientError::Host { ref code, .. } if code == "capability_missing"),
            "{refused:?}"
        );
        assert_eq!(fixture.connections.load(Ordering::SeqCst), 2);
        std::fs::remove_dir_all(&fixture.directory).unwrap();
    }

    #[tokio::test]
    async fn a_lost_link_is_replaced_by_the_next_request() {
        let fixture = spawn_fixture("epoch", true, Some(1));
        let client = client(&fixture);
        client.host_info().await.unwrap();
        client.host_info().await.unwrap();
        assert_eq!(fixture.connections.load(Ordering::SeqCst), 2);
        // The fixture ended the link after that stream; the next request notices and reconnects.
        let mut attempts = 0;
        loop {
            attempts += 1;
            if client.host_info().await.is_ok() && fixture.connections.load(Ordering::SeqCst) == 3 {
                break;
            }
            assert!(
                attempts < 5,
                "the route did not recover after the link ended"
            );
        }
        std::fs::remove_dir_all(&fixture.directory).unwrap();
    }

    #[tokio::test]
    async fn a_silent_link_is_closed_after_the_ping_timeout_and_the_route_reconnects() {
        let fixture = spawn_fixture("epoch", false, None);
        let client = client(&fixture);
        client.host_info().await.unwrap();
        client.host_info().await.unwrap();
        assert_eq!(fixture.connections.load(Ordering::SeqCst), 2);
        tokio::time::pause();
        let link_closed = async {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if fixture.pings.load(Ordering::SeqCst) > 0
                    && client.router().snapshot().active_endpoint_id.is_none()
                {
                    return;
                }
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(120), link_closed)
            .await
            .expect("silent link must be given up");
        tokio::time::resume();
        client.host_info().await.unwrap();
        assert_eq!(fixture.connections.load(Ordering::SeqCst), 3);
        std::fs::remove_dir_all(&fixture.directory).unwrap();
    }
}
