//! Path-free values for client interfaces; native capabilities never leave core.
use super::*;
use crate::conversation::ProjectedEvent;
pub fn safe_controller_event(event: crate::ControllerEvent) -> Result<ProjectedEvent> {
    let (event_type, mut data) = match event.event {
        ControllerEventData::InteractionRequested(request) => {
            let mut value = serde_json::to_value(request).map_err(ClientError::Json)?;
            value
                .as_object_mut()
                .ok_or_else(|| ClientError::Protocol("invalid interaction projection".into()))?
                .remove("controllerId");
            ("interaction.requested".to_owned(), value)
        }
        ControllerEventData::TitleSet(value) => {
            let mut value = serde_json::to_value(value).map_err(ClientError::Json)?;
            value
                .as_object_mut()
                .ok_or_else(|| ClientError::Protocol("invalid title projection".into()))?
                .remove("controllerId");
            ("extension.title_set".to_owned(), value)
        }
        ControllerEventData::EditorTextSet(value) => {
            let mut value = serde_json::to_value(value).map_err(ClientError::Json)?;
            value
                .as_object_mut()
                .ok_or_else(|| ClientError::Protocol("invalid editor projection".into()))?
                .remove("controllerId");
            ("extension.editor_text_set".to_owned(), value)
        }
    };
    // Defense in depth: controller identifiers and lease material are never projected.
    if let Some(object) = data.as_object_mut() {
        object.remove("controllerId");
        object.remove("leaseToken");
    }
    Ok(ProjectedEvent {
        sequence: event.sequence,
        runtime_generation: event.runtime_generation,
        occurred_at: event.occurred_at,
        event_type,
        data,
    })
}
