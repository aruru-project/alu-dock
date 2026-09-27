mod presentation;
pub use presentation::*;
use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;

use crate::{
    AttachmentDto, ClientError, DockClient, EventCursor, InstanceSnapshot, PublishedFileDto,
    Result,
    attachments::MAX_ATTACHMENTS_PER_MESSAGE,
    capabilities::{EVENTS_FOLLOW as FOLLOW_CAPABILITIES, INSTANCE_READ as READ_CAPABILITIES},
    client::ProtocolEventStream,
};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadReplay {
    ConversationBootstrap,
    EventLog,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceReadParams<'a> {
    instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<&'a EventCursor>,
    replay: ReadReplay,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FollowParams<'a> {
    instance_id: &'a str,
    since: &'a EventCursor,
}

#[derive(Debug, Deserialize)]
struct FollowInitial {
    page: EventPage,
}

pub struct FollowStream {
    inner: ProtocolEventStream,
    cursor: EventCursor,
}

impl FollowStream {
    pub async fn next_event(&mut self) -> Result<DockEvent> {
        let event: DockEvent = self.inner.next().await?;
        let same_generation = event.instance_id == self.cursor.instance_id
            && event.runtime_generation == self.cursor.runtime_generation
            // Host filters controller-only events without renumbering the journal.
            && event.sequence > self.cursor.sequence;
        let replacement = event.instance_id == self.cursor.instance_id
            && self.cursor.runtime_generation.checked_add(1) == Some(event.runtime_generation)
            && event.sequence == 1
            && event.event_type == "session.replaced";
        if !same_generation && !replacement {
            return Err(ClientError::Protocol(
                "live event did not continue the accepted cursor".into(),
            ));
        }
        self.cursor.runtime_generation = event.runtime_generation;
        self.cursor.sequence = event.sequence;
        Ok(event)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockEvent {
    pub scope: String,
    pub sequence: u64,
    pub instance_id: String,
    pub runtime_generation: u64,
    pub occurred_at: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<DockEvent>,
    pub earliest: EventCursor,
    pub latest: EventCursor,
    pub truncated: bool,
    pub epoch_changed: bool,
    pub generation_changed: bool,
}

impl EventPage {
    fn validate(&self, instance: &InstanceSnapshot) -> Result<()> {
        let cursors = [&self.earliest, &self.latest];
        if cursors.iter().any(|cursor| {
            cursor.instance_id != instance.id
                || cursor.runtime_generation != instance.runtime_generation
                || cursor.host_epoch != self.latest.host_epoch
        }) || self.earliest.sequence > self.latest.sequence
        {
            return Err(ClientError::Protocol(
                "event page cursor domain was invalid".into(),
            ));
        }
        let mut previous = None;
        for event in &self.events {
            if event.scope != "instance"
                || event.instance_id != instance.id
                || event.runtime_generation != instance.runtime_generation
                || event.sequence == 0
                || event.sequence > self.latest.sequence
                || previous.is_some_and(|sequence| event.sequence <= sequence)
            {
                return Err(ClientError::Protocol(
                    "event page contained an invalid or unordered event".into(),
                ));
            }
            previous = Some(event.sequence);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(rename = "contentRef", skip_serializing_if = "Option::is_none")]
        content_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(rename = "fileId", skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
    },
    ToolCall {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        #[serde(rename = "omittedFields", default)]
        omitted_fields: Vec<String>,
    },
    ToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        text: String,
        #[serde(rename = "isError")]
        is_error: bool,
        #[serde(rename = "publishedFile", skip_serializing_if = "Option::is_none")]
        published_file: Option<PublishedFileDto>,
        presentation: Option<Value>,
        #[serde(rename = "omittedFields", default)]
        omitted_fields: Vec<String>,
    },
    Omitted {
        kind: String,
        description: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub record_id: String,
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub source: String,
    pub visibility: String,
    pub timestamp: Option<String>,
    pub content: Vec<ContentBlock>,
    #[serde(
        default,
        deserialize_with = "deserialize_attachment_list",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub attachments: Vec<AttachmentDto>,
    pub stop_reason: Option<String>,
    pub error: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub is_error: Option<bool>,
    pub custom_type: Option<String>,
    pub display: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_metadata",
        skip_serializing_if = "Option::is_none"
    )]
    pub metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub metadata_omitted_fields: Vec<String>,
    pub command: Option<String>,
    pub exit_code: Option<i64>,
    pub cancelled: Option<bool>,
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
    pub exclude_from_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_kept_entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_entry_id: Option<String>,
    pub label: Option<String>,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub thinking_level: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMessage {
    pub queue_item_id: String,
    pub operation_id: String,
    pub delivery: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<ImagePath>,
    #[serde(
        default,
        deserialize_with = "deserialize_attachment_list",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub attachments: Vec<AttachmentDto>,
    pub accepted_at: String,
}

fn deserialize_metadata<'de, D>(deserializer: D) -> std::result::Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

fn deserialize_attachment_list<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<AttachmentDto>, D::Error>
where
    D: Deserializer<'de>,
{
    let attachments = Vec::<AttachmentDto>::deserialize(deserializer)?;
    if attachments.is_empty() || attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(D::Error::custom(
            "attachments must contain between 1 and 32 items when present",
        ));
    }
    let mut file_ids = HashSet::with_capacity(attachments.len());
    if attachments
        .iter()
        .any(|attachment| !file_ids.insert(attachment.file_id.as_str()))
    {
        return Err(D::Error::custom("attachments must contain unique file IDs"));
    }
    Ok(attachments)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePath {
    pub path: String,
    pub mime_type: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceReadResult {
    pub instance: InstanceSnapshot,
    pub page: EventPage,
    pub recent_history: Vec<HistoryRecord>,
    pub history_revision: u64,
    pub history_truncated: bool,
    pub pending_messages: Vec<PendingMessage>,
}

impl DockClient {
    pub async fn follow_instance(
        &self,
        instance_id: &str,
        since: &EventCursor,
    ) -> Result<(EventPage, FollowStream)> {
        if since.instance_id != instance_id {
            return Err(ClientError::Protocol(
                "follow cursor belongs to a different Work".into(),
            ));
        }
        let (initial, stream): (FollowInitial, ProtocolEventStream) = self
            .open_event_stream(
                "instance.follow",
                &FollowParams { instance_id, since },
                FOLLOW_CAPABILITIES,
            )
            .await?;
        let synthetic_instance = InstanceSnapshot {
            id: instance_id.to_owned(),
            creation_operation_id: String::new(),
            host_id: None,
            key: None,
            name: None,
            display_name: String::new(),
            cwd: String::new(),
            git_branch: None,
            lifecycle: crate::InstanceLifecycle::Active,
            execution: crate::InstanceExecution::Idle,
            compacting: false,
            last_run: String::new(),
            reopenable: false,
            runtime_generation: initial.page.latest.runtime_generation,
            owner_host_epoch: Some(initial.page.latest.host_epoch.clone()),
            interruption: None,
            pending: crate::PendingCounts {
                steering: 0,
                follow_up: 0,
                total: 0,
            },
            executor: crate::ExecutorSnapshot {
                kind: String::new(),
                version: None,
                pi_session_id: String::new(),
                session_file: None,
                model: None,
                thinking_level: None,
            },
            metrics: None,
            extension_status: Default::default(),
            tools_expanded: false,
            active_interaction: None,
            active_command_id: None,
            last_error: None,
            created_at: String::new(),
            updated_at: String::new(),
            execution_changed_at: String::new(),
            run_started_at: None,
            event_cursor: initial.page.latest.clone(),
        };
        if !initial.page.truncated
            && !initial.page.epoch_changed
            && !initial.page.generation_changed
        {
            initial.page.validate(&synthetic_instance)?;
        }
        let cursor = initial.page.latest.clone();
        Ok((
            initial.page,
            FollowStream {
                inner: stream,
                cursor,
            },
        ))
    }

    pub async fn read_instance(
        &self,
        instance_id: &str,
        since: Option<&EventCursor>,
        replay: ReadReplay,
    ) -> Result<InstanceReadResult> {
        if matches!(replay, ReadReplay::ConversationBootstrap) && since.is_some() {
            return Err(ClientError::Protocol(
                "fresh conversation bootstrap must not include a cursor".into(),
            ));
        }
        if matches!(replay, ReadReplay::EventLog) && since.is_none() {
            return Err(ClientError::Protocol(
                "event-log replay requires a complete cursor".into(),
            ));
        }
        let result: InstanceReadResult = self
            .request(
                "instance.read",
                &InstanceReadParams {
                    instance_id,
                    since,
                    replay,
                },
                READ_CAPABILITIES,
                None,
            )
            .await?;
        if result.instance.id != instance_id {
            return Err(ClientError::Protocol(
                "instance.read returned a different Work".into(),
            ));
        }
        result.instance.validate()?;
        result.page.validate(&result.instance)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // #298: controller-only events consume journal sequence numbers but are not
    // sent on ordinary Follow. The real client must keep reading that stream.
    #[cfg(unix)]
    #[tokio::test]
    async fn follow_keeps_receiving_after_controller_only_events() {
        use crate::tls::{read_json_line, write_json_line};
        use crate::{ConnectionRouter, IdentityStore, LocalDockEndpoint};
        let directory = std::env::temp_dir().join(format!("af-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let endpoint = directory.join("dock.sock");
        let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio::io::BufReader::new(socket);
            let hello: Value = read_json_line(&mut socket, 16 * 1024).await.unwrap();
            write_json_line(
                &mut socket,
                &serde_json::json!({
                    "kind": "hello_ack", "version": 2, "requestId": hello["requestId"],
                    "catalogSchemaVersion": 1, "host": {"hostEpoch": "epoch"},
                    "capabilities": FOLLOW_CAPABILITIES, "limits": {"maxLineBytes": 16384}
                }),
            )
            .await
            .unwrap();
            let request: Value = read_json_line(&mut socket, 16 * 1024).await.unwrap();
            assert_eq!(request["type"], "instance.follow");
            let cursor = serde_json::json!({"hostEpoch": "epoch", "instanceId": "work", "runtimeGeneration": 1, "sequence": 10});
            write_json_line(
                &mut socket,
                &serde_json::json!({
                    "kind": "response", "version": 2, "requestId": request["requestId"],
                    "hostEpoch": "epoch", "ok": true, "result": {"page": {
                        "events": [], "earliest": cursor, "latest": cursor,
                        "truncated": false, "epochChanged": false, "generationChanged": false
                    }}
                }),
            )
            .await
            .unwrap();
            for sequence in [11, 14] {
                write_json_line(&mut socket, &serde_json::json!({
                    "kind": "event", "version": 2, "requestId": request["requestId"], "hostEpoch": "epoch",
                    "event": {"scope": "instance", "instanceId": "work", "runtimeGeneration": 1,
                        "sequence": sequence, "occurredAt": "2026-09-15T00:00:00Z",
                        "type": "extension.status_changed", "data": {"key": "phase", "text": "working"}}
                })).await.unwrap();
            }
        });
        let store = IdentityStore::new(directory.join("identity"));
        let client = DockClient::new(
            ConnectionRouter::local(
                &store,
                LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                "follow-gap".into(),
            )
            .unwrap(),
        );
        let cursor = EventCursor {
            host_epoch: "epoch".into(),
            instance_id: "work".into(),
            runtime_generation: 1,
            sequence: 10,
        };
        let (_, mut follow) = client.follow_instance("work", &cursor).await.unwrap();
        let first = follow.next_event().await.unwrap();
        let after_directives = follow.next_event().await;
        peer.await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert_eq!(first.sequence, 11);
        assert_eq!(after_directives.unwrap().sequence, 14);
    }

    #[test]
    fn image_block_preserves_its_attachment_relation() {
        let block: ContentBlock = serde_json::from_value(serde_json::json!({
            "type": "image",
            "mimeType": "image/png",
            "contentRef": "content-1",
            "fileId": "file-1"
        }))
        .unwrap();
        assert_eq!(serde_json::to_value(block).unwrap()["fileId"], "file-1");
    }

    #[test]
    fn pending_message_preserves_canonical_attachment_projection() {
        let pending: PendingMessage = serde_json::from_value(serde_json::json!({
            "queueItemId": "queue-1",
            "operationId": "operation-1",
            "delivery": "followUp",
            "text": "",
            "attachments": [{
                "fileId": "123e4567-e89b-42d3-a456-426614174000",
                "name": "report.pdf",
                "sizeBytes": 42,
                "mediaType": "application/pdf",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "storedAt": "2026-08-16T00:00:00.000Z"
            }],
            "acceptedAt": "2026-08-16T00:00:01Z"
        }))
        .unwrap();
        assert_eq!(pending.attachments.len(), 1);
        assert_eq!(
            pending.attachments[0].file_id,
            "123e4567-e89b-42d3-a456-426614174000"
        );
        assert_eq!(pending.attachments[0].size_bytes, 42);
    }

    fn attachment(file_id: &str) -> serde_json::Value {
        serde_json::json!({
            "fileId": file_id,
            "name": "report.pdf",
            "sizeBytes": 42,
            "mediaType": "application/pdf",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "storedAt": "2026-08-16T00:00:00.000Z"
        })
    }

    fn pending_with(attachments: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "queueItemId": "queue-1",
            "operationId": "operation-1",
            "delivery": "followUp",
            "text": "message",
            "attachments": attachments,
            "acceptedAt": "2026-08-16T00:00:01.000Z"
        })
    }

    fn history_with(attachments: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "recordId": "record-1",
            "entryId": "entry-1",
            "parentId": null,
            "kind": "message",
            "source": "user",
            "visibility": "visible",
            "timestamp": "2026-08-16T00:00:01.000Z",
            "content": [],
            "attachments": attachments
        })
    }

    #[test]
    fn present_attachment_lists_must_be_nonempty_and_unique() {
        let duplicate = serde_json::json!([
            attachment("123e4567-e89b-42d3-a456-426614174000"),
            attachment("123e4567-e89b-42d3-a456-426614174000")
        ]);
        for value in [
            pending_with(serde_json::json!([])),
            pending_with(duplicate.clone()),
        ] {
            assert!(serde_json::from_value::<PendingMessage>(value).is_err());
        }
        for value in [history_with(serde_json::json!([])), history_with(duplicate)] {
            assert!(serde_json::from_value::<HistoryRecord>(value).is_err());
        }
    }
}
