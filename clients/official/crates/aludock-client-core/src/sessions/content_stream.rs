//! Conversation records share byte transport, not file source or storage semantics.
use super::{ContentAssembler, parse_content_chunk, protocol};
use crate::{ContentBlock, DockClient, Result};
use serde_json::{Value, json};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::AsyncWrite;

#[derive(Default)]
struct ContentSink {
    record: Vec<u8>,
    assembler: ContentAssembler,
}

impl ContentSink {
    fn consume(&mut self, mut bytes: &[u8]) -> Result<()> {
        while !bytes.is_empty() {
            let newline = bytes.iter().position(|byte| *byte == b'\n');
            let length = newline.unwrap_or(bytes.len());
            // Same record bound as the Protocol V2 producer; not a total-body cap.
            if self.record.len().saturating_add(length) > crate::client::MAX_CONTROL_LINE_BYTES {
                return Err(protocol(
                    "conversation record exceeds the protocol record bound",
                ));
            }
            self.record.extend_from_slice(&bytes[..length]);
            if newline.is_none() {
                break;
            }
            let chunk = parse_content_chunk(serde_json::from_slice(&self.record)?)?;
            self.assembler.push(chunk)?;
            self.record.clear();
            bytes = &bytes[length + 1..];
        }
        Ok(())
    }

    fn finish(self, total_blocks: usize) -> Result<Vec<ContentBlock>> {
        if !self.record.is_empty() {
            return Err(protocol("conversation record is missing its LF terminator"));
        }
        self.assembler.finish(total_blocks)
    }
}

impl AsyncWrite for ContentSink {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Poll::Ready(
            self.consume(bytes)
                .map(|()| bytes.len())
                .map_err(std::io::Error::other),
        )
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl DockClient {
    pub(super) async fn read_content_stream(
        &self,
        instance_id: &str,
        host_epoch: &str,
        generation: u64,
        revision: &str,
        content_ref: &str,
        total_blocks: usize,
    ) -> Result<Option<Vec<ContentBlock>>> {
        let mut sink = ContentSink::default();
        let check_identity = |value: &Value| -> Result<()> {
            if value.get("runtimeGeneration").and_then(Value::as_u64) != Some(generation)
                || value.get("revision").and_then(Value::as_str) != Some(revision)
                || value.get("contentRef").and_then(Value::as_str) != Some(content_ref)
            {
                return Err(protocol(
                    "conversation content changed while a complete entry was loading",
                ));
            }
            Ok(())
        };
        let Some(body) = self
            .read_byte_stream(
                "conversation.content.stream",
                &json!({"instanceId": instance_id, "contentRef": content_ref}),
                crate::capabilities::CONVERSATION_CONTENT_STREAM,
                &[
                    crate::capabilities::CONVERSATION_CONTENT_STREAM_V1,
                    crate::file_transfer::FILE_TRANSFER_CAPABILITY,
                ],
                9_007_199_254_740_991,
                &mut sink,
                check_identity,
                |_| {},
            )
            .await?
        else {
            return Ok(None);
        };
        check_identity(&body.result)?;
        if body.host_epoch != host_epoch
            || body.result.get("instanceId").and_then(Value::as_str) != Some(instance_id)
            || body.result.get("chunks").and_then(Value::as_u64) != Some(body.summary.chunks)
            || body.result.get("sizeBytes").and_then(Value::as_u64) != Some(body.summary.size_bytes)
            || body.result.get("sha256").and_then(Value::as_str)
                != Some(body.summary.sha256.as_str())
        {
            return Err(protocol(
                "conversation completion differs from the verified body",
            ));
        }
        // All blocks stay provisional until integrity, clean EOF and scope checks pass.
        Ok(Some(sink.finish(total_blocks)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_body_survives_every_byte_split_in_unicode_and_json_escapes() {
        let records = concat!(
            "{\"type\":\"text\",\"blockIndex\":0,\"text\":\"😀\\n\\\"\",\"offset\":0,\"blockComplete\":false}\n",
            "{\"type\":\"text\",\"blockIndex\":0,\"text\":\"尾\",\"offset\":4,\"blockComplete\":true}\n",
            "{\"type\":\"image_ref\",\"blockIndex\":1,\"mimeType\":\"image/png\",\"contentRef\":\"image-1\"}\n",
            r#"{"type":"tool_call","blockIndex":2,"toolCallId":"call","toolName":"read","argumentsJson":"{\"path\":\"😀\"}","offset":0,"blockComplete":true}"#, "\n",
            r#"{"type":"tool_result","blockIndex":3,"toolCallId":"call","toolName":"read","text":"line\n尾","isError":false,"omittedFields":[],"offset":0,"blockComplete":true}"#, "\n"
        ).as_bytes();
        for split in 0..=records.len() {
            let mut sink = ContentSink::default();
            sink.consume(&records[..split]).unwrap();
            sink.consume(&records[split..]).unwrap();
            let result = serde_json::to_value(sink.finish(4).unwrap()).unwrap();
            assert_eq!(
                result,
                json!([
                    {"type":"text", "text":"😀\n\"尾"},
                    {"type":"image", "mimeType":"image/png", "contentRef":"image-1"},
                    {"type":"tool_call", "toolCallId":"call", "toolName":"read", "args":{"path":"😀"}, "omittedFields":[]},
                    {"type":"tool_result", "toolCallId":"call", "toolName":"read", "text":"line\n尾", "isError":false, "omittedFields":[], "presentation":null}
                ])
            );
        }
    }

    // #356: a block kind only a newer Host knows is placed as "unrecognized" and the
    // known text around it still reads; a malformed known chunk is still an error.
    #[test]
    fn unknown_block_kinds_keep_the_known_blocks_readable() {
        let records = concat!(
            "{\"type\":\"text\",\"blockIndex\":0,\"text\":\"before\",\"offset\":0,\"blockComplete\":true}\n",
            "{\"type\":\"hologram\",\"blockIndex\":1,\"frames\":[1,2],\"offset\":0,\"blockComplete\":false}\n",
            "{\"type\":\"hologram\",\"blockIndex\":1,\"frames\":[3],\"offset\":2,\"blockComplete\":true}\n",
            "{\"type\":\"citation\",\"blockIndex\":2,\"url\":\"https://example.test\"}\n",
            "{\"type\":\"text\",\"blockIndex\":3,\"text\":\"after\",\"offset\":0,\"blockComplete\":true}\n"
        )
        .as_bytes();
        let mut sink = ContentSink::default();
        sink.consume(records).unwrap();
        assert_eq!(
            serde_json::to_value(sink.finish(4).unwrap()).unwrap(),
            json!([
                {"type":"text", "text":"before"},
                {"type":"unrecognized"},
                {"type":"unrecognized"},
                {"type":"text", "text":"after"}
            ])
        );

        let mut sink = ContentSink::default();
        assert!(
            sink.consume(
                b"{\"type\":\"text\",\"blockIndex\":0,\"offset\":0,\"blockComplete\":true}\n"
            )
            .is_err(),
            "a known chunk kind missing its fields must not pass as unrecognized"
        );
    }

    #[test]
    fn interrupted_jsonl_cannot_publish_a_partial_body() {
        // Whole-read contract: LF is required even if the last JSON object parses.
        let mut sink = ContentSink::default();
        sink.consume(b"{\"type\":\"text\",\"blockIndex\":0,\"text\":\"partial\",\"offset\":0,\"blockComplete\":true}").unwrap();
        assert!(sink.finish(1).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn only_missing_optional_stream_support_before_ready_uses_the_same_reference_pages() {
        use super::super::{ConversationReadContext, ConversationReadView};
        use crate::{ConnectionRouter, IdentityStore, LocalDockEndpoint};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        // The peer only supplies static protocol replies. A partial or ordinary
        // failure must not be mistaken for permission to retry/change the view.
        for scenario in [
            "missing-stream",
            "missing-file",
            "ordinary",
            "after-ready",
            "after-chunk",
            "disconnect",
            "wrong-scope",
        ] {
            let root = std::env::temp_dir().join(format!("body-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let endpoint = root.join("s");
            let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
            let fallback = scenario.starts_with("missing-");
            let (finished, done) = tokio::sync::oneshot::channel();
            let peer = tokio::spawn(async move {
                for attempt in 0..if fallback { 2 } else { 1 } {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut socket = BufReader::new(socket);
                    let mut line = String::new();
                    socket.read_line(&mut line).await.unwrap();
                    let hello: Value = serde_json::from_str(&line).unwrap();
                    let ack = json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
                        "host":{"hostEpoch":"epoch"},"limits":{"maxLineBytes":1048576},"capabilities":hello["requiredCapabilities"]});
                    socket
                        .write_all(format!("{ack}\n").as_bytes())
                        .await
                        .unwrap();
                    line.clear();
                    socket.read_line(&mut line).await.unwrap();
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let envelope = |kind: &str| json!({"kind":kind,"version":2,"requestId":request["requestId"],"hostEpoch":"epoch"});
                    if attempt == 1 {
                        assert_eq!(request["type"], "conversation.content");
                        assert_eq!(request["params"]["view"], "references");
                        let mut response = envelope("response");
                        response["ok"] = json!(true);
                        response["result"] = json!({"instanceId":"work","contentRef":"body","runtimeGeneration":1,"revision":"revision","complete":true,
                            "chunks":[{"type":"text","blockIndex":0,"text":"complete","offset":0,"blockComplete":true}]});
                        socket
                            .write_all(format!("{response}\n").as_bytes())
                            .await
                            .unwrap();
                        continue;
                    }
                    assert_eq!(request["type"], "conversation.content.stream");
                    if matches!(
                        scenario,
                        "after-ready" | "after-chunk" | "disconnect" | "wrong-scope"
                    ) {
                        let mut ready = envelope("file_ready");
                        ready["direction"] = json!("download");
                        ready["maxChunkBytes"] = json!(65536);
                        ready["windowBytes"] = json!(262144);
                        ready["metadata"] = json!({"contentRef":"body","revision":"revision","runtimeGeneration":1});
                        socket
                            .write_all(format!("{ready}\n").as_bytes())
                            .await
                            .unwrap();
                    }
                    if matches!(scenario, "after-chunk" | "disconnect" | "wrong-scope") {
                        let bytes = b"{\"type\":\"text\",\"blockIndex\":0,\"text\":\"partial\",\"offset\":0,\"blockComplete\":true}\n";
                        let mut chunk = envelope("file_chunk");
                        chunk["index"] = json!(0);
                        chunk["data"] = json!(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            bytes
                        ));
                        socket
                            .write_all(format!("{chunk}\n").as_bytes())
                            .await
                            .unwrap();
                        line.clear();
                        socket.read_line(&mut line).await.unwrap();
                        if scenario == "disconnect" {
                            continue;
                        }
                        if scenario == "wrong-scope" {
                            use sha2::Digest;
                            let mut complete = envelope("file_complete");
                            complete["chunks"] = json!(1);
                            complete["sizeBytes"] = json!(bytes.len());
                            complete["sha256"] = json!(hex::encode(sha2::Sha256::digest(bytes)));
                            socket
                                .write_all(format!("{complete}\n").as_bytes())
                                .await
                                .unwrap();
                            let mut response = envelope("response");
                            response["ok"] = json!(true);
                            response["result"] = json!({"instanceId":"work","contentRef":"body","revision":"revision","runtimeGeneration":2,
                                "chunks":1,"sizeBytes":bytes.len(),"sha256":complete["sha256"]});
                            socket
                                .write_all(format!("{response}\n").as_bytes())
                                .await
                                .unwrap();
                            continue;
                        }
                    }
                    let mut response = envelope("response");
                    response["ok"] = json!(false);
                    response["error"] = json!({"code":if scenario == "ordinary" {"host_draining"} else {"capability_missing"},"message":"unavailable","retryable":false,
                        "details":{"missing":[if scenario == "missing-file" {"file-transfer.v1"} else {"conversation.content.stream.v1"}]}});
                    socket
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                }
                tokio::select! {
                    _ = listener.accept() => panic!("unexpected fallback connection after {scenario}"),
                    _ = done => {},
                }
            });
            let client = DockClient::new(
                ConnectionRouter::local(
                    &IdentityStore::new(root.join("identity")),
                    LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                    "body-test".into(),
                )
                .unwrap(),
            );
            let result = client
                .hydrate_content(
                    "work",
                    "epoch",
                    1,
                    "revision",
                    "body",
                    1,
                    ConversationReadContext {
                        view: Some(ConversationReadView::References),
                    },
                )
                .await;
            let _ = finished.send(());
            if fallback {
                assert!(
                    matches!(&result.unwrap()[0], ContentBlock::Text { text } if text == "complete")
                );
            } else {
                assert!(
                    result.is_err(),
                    "{scenario} must not publish a partial body"
                );
            }
            peer.await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
