//! Path-free values for client interfaces; native capabilities never leave core.
use super::*;
use crate::ExtensionEvent;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationBootstrap {
    pub instance: InstanceSnapshot,
    pub records: Vec<HistoryRecord>,
    pub active_events: Vec<ProjectedEvent>,
    pub extension_ui: ExtensionBootstrap,
    pub queue: Vec<ProjectedQueueItem>,
    pub cursor: EventCursor,
    pub history_revision: u64,
    pub history_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionBootstrap {
    pub status: std::collections::BTreeMap<String, String>,
    pub tools_expanded: bool,
    pub active_interaction: Option<crate::ActiveInteraction>,
    pub events: Vec<ProjectedEvent>,
    /// Questions arrive on this observation and are answered without the operator connection.
    pub shared_questions: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedEvent {
    pub sequence: u64,
    pub runtime_generation: u64,
    pub occurred_at: String,
    pub event_type: String,
    pub data: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedQueueItem {
    pub queue_item_id: String,
    pub delivery: String,
    pub text: String,
    pub attachments: Vec<AttachmentDto>,
    pub image_count: usize,
    pub accepted_at: String,
}

pub fn project_conversation_read(read: crate::InstanceReadResult) -> Result<ConversationBootstrap> {
    let active_events = read
        .page
        .events
        .iter()
        .filter(|event| {
            matches!(
                event.event_type.as_str(),
                "message.submitted"
                    | "message.delta"
                    | "message.completed"
                    | "run.settled"
                    | "tool.started"
                    | "tool.args_updated"
                    | "tool.output_updated"
                    | "tool.completed"
                    | "bash.started"
                    | "bash.output"
                    | "bash.completed"
            )
        })
        .cloned()
        .map(project_event)
        .collect::<Result<Vec<_>>>()?;
    let extension_events = read
        .page
        .events
        .iter()
        .map(project_extension_event)
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    let queue = read
        .pending_messages
        .into_iter()
        .map(project_pending_message)
        .collect();
    Ok(ConversationBootstrap {
        instance: read.instance.clone(),
        records: read.recent_history,
        active_events,
        extension_ui: ExtensionBootstrap {
            status: read.instance.extension_status,
            tools_expanded: read.instance.tools_expanded,
            active_interaction: read.instance.active_interaction,
            events: extension_events,
            shared_questions: read.shared_questions,
        },
        queue,
        cursor: read.page.latest,
        history_revision: read.history_revision,
        history_truncated: read.history_truncated,
    })
}

pub fn project_pending_message(item: PendingMessage) -> ProjectedQueueItem {
    ProjectedQueueItem {
        queue_item_id: item.queue_item_id,
        delivery: item.delivery,
        text: item.text,
        attachments: item.attachments,
        image_count: item.images.len(),
        accepted_at: item.accepted_at,
    }
}

pub fn project_event(event: crate::DockEvent) -> crate::Result<ProjectedEvent> {
    let extension = ExtensionEvent::from_dock_event(&event)?;
    let data = match extension {
        Some(value) => extension_data(value)?,
        None => strip_image_paths(event.data),
    };
    Ok(ProjectedEvent {
        sequence: event.sequence,
        runtime_generation: event.runtime_generation,
        occurred_at: event.occurred_at,
        event_type: event.event_type,
        data,
    })
}

pub fn project_extension_event(event: &crate::DockEvent) -> crate::Result<Option<ProjectedEvent>> {
    let Some(value) = ExtensionEvent::from_dock_event(event)? else {
        return Ok(None);
    };
    let data = extension_data(value)?;
    Ok(Some(ProjectedEvent {
        sequence: event.sequence,
        runtime_generation: event.runtime_generation,
        occurred_at: event.occurred_at.clone(),
        event_type: event.event_type.clone(),
        data,
    }))
}

/// Validated Extension UI data; which operator connection a question named stays in core.
fn extension_data(value: ExtensionEvent) -> Result<Value> {
    let mut encoded = serde_json::to_value(value).map_err(ClientError::Json)?;
    let mut data = encoded.get_mut("data").map(Value::take).ok_or_else(|| {
        ClientError::Protocol("Extension UI projection omitted event data".into())
    })?;
    if let Some(object) = data.as_object_mut() {
        object.remove("controllerId");
    }
    Ok(data)
}

pub fn strip_image_paths(mut data: Value) -> Value {
    if let Some(images) = data.get_mut("images").and_then(Value::as_array_mut) {
        for image in images {
            if let Some(object) = image.as_object_mut() {
                object.remove("path");
            }
        }
    }
    data
}

pub fn project_session_update(update: crate::SessionUpdate) -> Result<Value> {
    use crate::SessionUpdate;
    Ok(match update {
        SessionUpdate::ObservationCut(mut read) => {
            read.recent_history.clear();
            let mut bootstrap = project_conversation_read(read)?;
            bootstrap.active_events.clear();
            serde_json::json!({"kind":"facts", "bootstrap":bootstrap})
        }
        SessionUpdate::Read(read) => {
            serde_json::json!({"kind": "read", "bootstrap": project_conversation_read(read)?})
        }
        SessionUpdate::Content { token, update } => match update {
            crate::ContentUpdate::CheckpointBegin { read } => {
                serde_json::json!({"kind":"content", "token":token, "change":{"kind":"checkpoint_begin", "bootstrap":project_conversation_read(read)?}})
            }
            crate::ContentUpdate::MemoryRecord { .. } => {
                return Err(ClientError::Protocol(
                    "unresolved local content record".into(),
                ));
            }
            update => serde_json::json!({"kind":"content", "token":token, "change":update}),
        },
        SessionUpdate::ReplayEvent { token, event } => {
            serde_json::json!({"kind":"event", "replayToken":token, "event":project_event(event)?})
        }
        SessionUpdate::Event(event) => {
            serde_json::json!({"kind": "event", "event": project_event(event)?})
        }
        SessionUpdate::Replaced(target) => {
            serde_json::json!({"kind": "replaced", "target": target})
        }
        SessionUpdate::Status { state, message } => {
            serde_json::json!({"kind": "status", "state": state, "message": message})
        }
    })
}

pub fn project_session_snapshot(
    snapshot: crate::SessionSnapshot,
    replacement: bool,
) -> Result<Value> {
    let replacement = replacement || (snapshot.read.is_none() && snapshot.target.is_some());
    let bootstrap = match snapshot
        .read
        .map(|read| project_conversation_read((*read).clone()))
        .transpose()
    {
        Ok(bootstrap) => bootstrap,
        Err(_) if replacement => {
            return Ok(
                serde_json::json!({"kind":"replacement_snapshot", "target":snapshot.target,
            "state":"content_error", "message":"无法显示返回内容，请刷新当前工作后重试。"}),
            );
        }
        Err(error) => return Err(error),
    };
    Ok(
        serde_json::json!({"kind": if replacement { "replacement_snapshot" } else { "snapshot" }, "bootstrap": bootstrap,
        "target": snapshot.target, "state": snapshot.state, "message": snapshot.message, "contentToken": snapshot.content_token, "canLoadEarlier": snapshot.can_load_earlier}),
    )
}
