use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    ClientError, DockClient, DockEvent, InstanceSnapshot, Result,
    capabilities::{
        EXTENSION_CONTROL as CONTROL_CAPABILITIES, EXTENSION_RESPONSE as RESPONSE_CAPABILITIES,
        EXTENSION_WIDGETS as WIDGET_CAPABILITIES, SNAPSHOT as TOOLS_CAPABILITIES,
    },
    client::ProtocolEventStream,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMethod {
    Select,
    Confirm,
    Input,
    Editor,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveInteraction {
    pub id: String,
    pub method: InteractionMethod,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum InteractionRequest {
    Select {
        #[serde(rename = "controllerId")]
        controller_id: String,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        title: String,
        options: Vec<String>,
        #[serde(rename = "issuedAt")]
        issued_at: String,
        #[serde(rename = "expiresAt")]
        expires_at: Option<String>,
    },
    Confirm {
        #[serde(rename = "controllerId")]
        controller_id: String,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        title: String,
        message: String,
        #[serde(rename = "issuedAt")]
        issued_at: String,
        #[serde(rename = "expiresAt")]
        expires_at: Option<String>,
    },
    Input {
        #[serde(rename = "controllerId")]
        controller_id: String,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        title: String,
        placeholder: Option<String>,
        #[serde(rename = "issuedAt")]
        issued_at: String,
        #[serde(rename = "expiresAt")]
        expires_at: Option<String>,
    },
    Editor {
        #[serde(rename = "controllerId")]
        controller_id: String,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        title: String,
        prefill: Option<String>,
        #[serde(rename = "issuedAt")]
        issued_at: String,
        #[serde(rename = "expiresAt")]
        expires_at: Option<String>,
    },
}

impl InteractionRequest {
    pub fn controller_id(&self) -> &str {
        match self {
            Self::Select { controller_id, .. }
            | Self::Confirm { controller_id, .. }
            | Self::Input { controller_id, .. }
            | Self::Editor { controller_id, .. } => controller_id,
        }
    }

    pub fn interaction_id(&self) -> &str {
        match self {
            Self::Select { interaction_id, .. }
            | Self::Confirm { interaction_id, .. }
            | Self::Input { interaction_id, .. }
            | Self::Editor { interaction_id, .. } => interaction_id,
        }
    }

    pub fn method(&self) -> InteractionMethod {
        match self {
            Self::Select { .. } => InteractionMethod::Select,
            Self::Confirm { .. } => InteractionMethod::Confirm,
            Self::Input { .. } => InteractionMethod::Input,
            Self::Editor { .. } => InteractionMethod::Editor,
        }
    }

    pub fn select_options(&self) -> Option<&[String]> {
        match self {
            Self::Select { options, .. } => Some(options),
            _ => None,
        }
    }

    fn validate(&self) -> Result<()> {
        validate_id(self.controller_id(), "controllerId")?;
        validate_id(self.interaction_id(), "interactionId")?;
        let (title, issued_at, expires_at) = match self {
            Self::Select {
                title,
                options,
                issued_at,
                expires_at,
                ..
            } => {
                if options.len() > 200 || options.iter().any(|value| value.chars().count() > 8_000)
                {
                    return protocol("select options exceeded protocol bounds");
                }
                (title, issued_at, expires_at)
            }
            Self::Confirm {
                title,
                message,
                issued_at,
                expires_at,
                ..
            } => {
                validate_text(message, 8_000, "confirm message")?;
                (title, issued_at, expires_at)
            }
            Self::Input {
                title,
                placeholder,
                issued_at,
                expires_at,
                ..
            } => {
                if let Some(value) = placeholder {
                    validate_text(value, 8_000, "input placeholder")?;
                }
                (title, issued_at, expires_at)
            }
            Self::Editor {
                title,
                prefill,
                issued_at,
                expires_at,
                ..
            } => {
                if let Some(value) = prefill {
                    validate_text(value, 256_000, "editor prefill")?;
                }
                (title, issued_at, expires_at)
            }
        };
        validate_text(title, 2_048, "interaction title")?;
        validate_timestamp(issued_at, "issuedAt")?;
        if let Some(value) = expires_at {
            validate_timestamp(value, "expiresAt")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum InteractionResponse {
    Select { value: String },
    Confirm { confirmed: bool },
    Input { value: String },
    Editor { value: String },
}

impl InteractionResponse {
    pub fn cancelled(method: InteractionMethod) -> Value {
        serde_json::json!({ "method": method, "cancelled": true })
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Select { value } => validate_text(value, 8_000, "select response"),
            Self::Input { value } | Self::Editor { value } => {
                validate_text(value, 256_000, "interaction response")
            }
            Self::Confirm { .. } => Ok(()),
        }
    }

    pub fn method(&self) -> InteractionMethod {
        match self {
            Self::Select { .. } => InteractionMethod::Select,
            Self::Confirm { .. } => InteractionMethod::Confirm,
            Self::Input { .. } => InteractionMethod::Input,
            Self::Editor { .. } => InteractionMethod::Editor,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionCancellationReason {
    User,
    Timeout,
    Signal,
    Detach,
    Replacement,
    HostDraining,
    Overflow,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WidgetPlacement {
    AboveEditor,
    BelowEditor,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data")]
pub enum ExtensionEvent {
    #[serde(rename = "interaction.resolved")]
    InteractionResolved(InteractionResolution),
    #[serde(rename = "interaction.cancelled")]
    InteractionCancelled(InteractionCancellation),
    #[serde(rename = "extension.notification")]
    Notification(ExtensionNotification),
    #[serde(rename = "extension.status_changed")]
    StatusChanged(StatusChanged),
    #[serde(rename = "extension.tools_expanded_changed")]
    ToolsExpandedChanged(ToolsExpandedChanged),
    #[serde(rename = "extension.widget_changed")]
    WidgetChanged(WidgetChanged),
    #[serde(rename = "extension.error")]
    Error(ExtensionError),
}

macro_rules! event_data {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $(pub $field: $ty),* }
    };
}

event_data!(InteractionResolution {
    interaction_id: String,
    method: InteractionMethod
});
event_data!(InteractionCancellation {
    interaction_id: String,
    method: InteractionMethod,
    reason: InteractionCancellationReason
});
event_data!(ExtensionNotification { message: String, level: NotificationLevel, operation_id: Option<String> });
event_data!(StatusChanged { key: String, text: Option<String> });
event_data!(ToolsExpandedChanged { expanded: bool });
event_data!(WidgetChanged { key: String, lines: Option<Vec<String>>, placement: Option<WidgetPlacement> });
event_data!(ExtensionError { source: Option<String>, event: Option<String>, error: String });

impl ExtensionEvent {
    pub fn from_dock_event(event: &DockEvent) -> Result<Option<Self>> {
        let parsed = match event.event_type.as_str() {
            "interaction.resolved" => Self::InteractionResolved(parse_data(&event.data)?),
            "interaction.cancelled" => Self::InteractionCancelled(parse_data(&event.data)?),
            "extension.notification" => Self::Notification(parse_data(&event.data)?),
            "extension.status_changed" => Self::StatusChanged(parse_data(&event.data)?),
            "extension.tools_expanded_changed" => {
                Self::ToolsExpandedChanged(parse_data(&event.data)?)
            }
            "extension.widget_changed" => Self::WidgetChanged(parse_data(&event.data)?),
            "extension.error" => Self::Error(parse_data(&event.data)?),
            "interaction.requested" | "extension.title_set" | "extension.editor_text_set" => {
                return protocol("controller-targeted event appeared on ordinary follow");
            }
            value if value.starts_with("extension.") || value.starts_with("interaction.") => {
                return protocol("unsupported Extension UI event");
            }
            _ => return Ok(None),
        };
        parsed.validate()?;
        Ok(Some(parsed))
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::InteractionResolved(value) => validate_id(&value.interaction_id, "interactionId"),
            Self::InteractionCancelled(value) => {
                validate_id(&value.interaction_id, "interactionId")
            }
            Self::Notification(value) => {
                validate_text(&value.message, 2_048, "notification")?;
                if let Some(id) = &value.operation_id {
                    validate_id(id, "operationId")?;
                }
                Ok(())
            }
            Self::StatusChanged(value) => {
                validate_key(&value.key)?;
                if let Some(text) = &value.text {
                    validate_text(text, 2_048, "status")?;
                }
                Ok(())
            }
            Self::ToolsExpandedChanged(_) => Ok(()),
            Self::WidgetChanged(value) => {
                validate_key(&value.key)?;
                if let Some(lines) = &value.lines
                    && (lines.len() > 200 || lines.iter().any(|line| line.chars().count() > 8_000))
                {
                    return protocol("widget lines exceeded protocol bounds");
                }
                Ok(())
            }
            Self::Error(value) => {
                if let Some(source) = &value.source {
                    validate_text(source, 256, "error source")?;
                }
                if let Some(event) = &value.event {
                    validate_text(event, 128, "error event")?;
                }
                validate_text(&value.error, 2_048, "extension error")
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data")]
pub enum ControllerEventData {
    #[serde(rename = "interaction.requested")]
    InteractionRequested(InteractionRequest),
    #[serde(rename = "extension.title_set")]
    TitleSet(TitleDirective),
    #[serde(rename = "extension.editor_text_set")]
    EditorTextSet(EditorDirective),
}

event_data!(TitleDirective {
    controller_id: String,
    title: String
});
event_data!(EditorDirective {
    controller_id: String,
    text: String
});

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEvent {
    pub sequence: u64,
    pub instance_id: String,
    pub runtime_generation: u64,
    pub occurred_at: String,
    #[serde(flatten)]
    pub event: ControllerEventData,
}

pub struct ExtensionControlStream {
    inner: ProtocolEventStream,
    instance_id: String,
    runtime_generation: u64,
    controller_id: String,
    last_sequence: u64,
}

impl ExtensionControlStream {
    pub async fn next_event(&mut self) -> Result<ControllerEvent> {
        let event: DockEvent = self.inner.next().await?;
        if event.scope != "instance"
            || event.instance_id != self.instance_id
            || event.runtime_generation != self.runtime_generation
            || event.sequence <= self.last_sequence
        {
            return protocol("controller event freshness was invalid");
        }
        let data = match event.event_type.as_str() {
            "interaction.requested" => {
                let request: InteractionRequest = parse_data(&event.data)?;
                request.validate()?;
                if request.controller_id() != self.controller_id {
                    return protocol("interaction request targeted another controller");
                }
                ControllerEventData::InteractionRequested(request)
            }
            "extension.title_set" => {
                let value: TitleDirective = parse_data(&event.data)?;
                validate_id(&value.controller_id, "controllerId")?;
                validate_text(&value.title, 2_048, "title directive")?;
                if value.controller_id != self.controller_id {
                    return protocol("title directive targeted another controller");
                }
                ControllerEventData::TitleSet(value)
            }
            "extension.editor_text_set" => {
                let value: EditorDirective = parse_data(&event.data)?;
                validate_id(&value.controller_id, "controllerId")?;
                validate_text(&value.text, 256_000, "editor directive")?;
                if value.controller_id != self.controller_id {
                    return protocol("editor directive targeted another controller");
                }
                ControllerEventData::EditorTextSet(value)
            }
            _ => return protocol("controller stream received an ordinary event"),
        };
        self.last_sequence = event.sequence;
        Ok(ControllerEvent {
            sequence: event.sequence,
            instance_id: event.instance_id,
            runtime_generation: event.runtime_generation,
            occurred_at: event.occurred_at,
            event: data,
        })
    }
}

pub struct ExtensionController {
    pub instance_id: String,
    pub runtime_generation: u64,
    pub host_epoch: String,
    pub lease: ExtensionControllerLease,
    pub stream: ExtensionControlStream,
}

/// Opaque authority credential. It intentionally implements neither `Serialize` nor `Debug`.
#[derive(Clone)]
pub struct ExtensionControllerLease {
    instance_id: String,
    runtime_generation: u64,
    lease_token: String,
}

impl ExtensionControllerLease {
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }
    pub fn runtime_generation(&self) -> u64 {
        self.runtime_generation
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlParams<'a> {
    instance_id: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlResult {
    instance_id: String,
    runtime_generation: u64,
    lease_token: String,
    controller_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RespondParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    lease_token: &'a str,
    interaction_id: &'a str,
    response: &'a Value,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionResolutionState {
    Resolved,
    AlreadyResolved,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InteractionRespondResult {
    pub interaction_id: String,
    pub state: InteractionResolutionState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewportParams<'a> {
    instance_id: &'a str,
    lease_token: &'a str,
    expected_runtime_generation: u64,
    width: u16,
    height: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WidgetViewportResult {
    pub accepted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsExpandedParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    expected_runtime_generation: u64,
    expanded: bool,
}

#[derive(Debug, Deserialize)]
struct ToolsExpandedResult {
    instance: InstanceSnapshot,
}

impl DockClient {
    pub async fn control_extension_ui(&self, instance_id: &str) -> Result<ExtensionController> {
        let (result, stream): (ControlResult, ProtocolEventStream) = self
            .open_event_stream(
                "interaction.control",
                &ControlParams { instance_id },
                CONTROL_CAPABILITIES,
            )
            .await?;
        if result.instance_id != instance_id || result.runtime_generation == 0 {
            return protocol("interaction.control returned a stale or foreign binding");
        }
        validate_id(&result.lease_token, "leaseToken")?;
        validate_id(&result.controller_id, "controllerId")?;
        let host_epoch = stream.host_epoch().to_owned();
        let controller_id = result.controller_id.clone();
        Ok(ExtensionController {
            instance_id: result.instance_id.clone(),
            runtime_generation: result.runtime_generation,
            host_epoch,
            lease: ExtensionControllerLease {
                instance_id: result.instance_id.clone(),
                runtime_generation: result.runtime_generation,
                lease_token: result.lease_token,
            },
            stream: ExtensionControlStream {
                inner: stream,
                instance_id: result.instance_id,
                runtime_generation: result.runtime_generation,
                controller_id,
                last_sequence: 0,
            },
        })
    }

    pub async fn respond_interaction(
        &self,
        controller: &ExtensionControllerLease,
        interaction_id: &str,
        response: &InteractionResponse,
        cancelled: bool,
        operation_id: Option<&str>,
    ) -> Result<InteractionRespondResult> {
        validate_id(interaction_id, "interactionId")?;
        response.validate()?;
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let encoded = if cancelled {
            InteractionResponse::cancelled(response.method())
        } else {
            serde_json::to_value(response).map_err(ClientError::Json)?
        };
        let result: InteractionRespondResult = self
            .request(
                "interaction.respond",
                &RespondParams {
                    operation_id,
                    instance_id: &controller.instance_id,
                    lease_token: &controller.lease_token,
                    interaction_id,
                    response: &encoded,
                },
                RESPONSE_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_interaction_result(result, interaction_id, operation_id)
    }

    pub async fn set_extension_widget_viewport(
        &self,
        controller: &ExtensionControllerLease,
        width: u16,
        height: u16,
    ) -> Result<WidgetViewportResult> {
        if width == 0 || height == 0 || width > 10_000 || height > 10_000 {
            return protocol("widget viewport must be between 1 and 10000 cells");
        }
        let result: WidgetViewportResult = self
            .request(
                "extension.widget_viewport.set",
                &ViewportParams {
                    instance_id: &controller.instance_id,
                    lease_token: &controller.lease_token,
                    expected_runtime_generation: controller.runtime_generation,
                    width,
                    height,
                },
                WIDGET_CAPABILITIES,
                None,
            )
            .await?;
        if !result.accepted {
            return protocol("Host did not accept widget viewport");
        }
        Ok(result)
    }

    pub async fn set_tools_expanded(
        &self,
        instance_id: &str,
        expected_runtime_generation: u64,
        expanded: bool,
        operation_id: Option<&str>,
    ) -> Result<InstanceSnapshot> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: ToolsExpandedResult = self
            .request(
                "extension.tools_expanded.set",
                &ToolsExpandedParams {
                    operation_id,
                    instance_id,
                    expected_runtime_generation,
                    expanded,
                },
                TOOLS_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        result
            .instance
            .validate()
            .map_err(|error| ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: error.to_string(),
            })?;
        if result.instance.id != instance_id
            || result.instance.runtime_generation != expected_runtime_generation
            || result.instance.tools_expanded != expanded
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "tools-expanded result did not prove the correlated Work state".into(),
            });
        }
        Ok(result.instance)
    }
}

pub(crate) fn validate_active_interaction(value: &ActiveInteraction) -> Result<()> {
    validate_id(&value.id, "activeInteraction.id")?;
    if let Some(expires_at) = &value.expires_at {
        validate_timestamp(expires_at, "activeInteraction.expiresAt")?;
    }
    Ok(())
}

pub(crate) fn validate_extension_status(status: &BTreeMap<String, String>) -> Result<()> {
    if status.len() > 64 {
        return protocol("extension status exceeded 64 keys");
    }
    for (key, text) in status {
        validate_key(key)?;
        validate_text(text, 2_048, "extension status")?;
    }
    Ok(())
}

fn validate_interaction_result(
    result: InteractionRespondResult,
    interaction_id: &str,
    operation_id: &str,
) -> Result<InteractionRespondResult> {
    if result.interaction_id != interaction_id {
        return Err(ClientError::EffectUnknown {
            operation_id: operation_id.to_owned(),
            message: "interaction response did not correlate to the requested interaction".into(),
        });
    }
    Ok(result)
}

fn parse_data<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone())
        .map_err(|error| ClientError::Protocol(format!("invalid Extension UI data: {error}")))
}

fn validate_id(value: &str, field: &str) -> Result<()> {
    if value.is_empty() || value.chars().count() > 128 || value.chars().any(char::is_control) {
        return protocol(format!("{field} was invalid"));
    }
    Ok(())
}

fn validate_key(value: &str) -> Result<()> {
    if value.is_empty() || value.chars().count() > 256 || value.chars().any(char::is_control) {
        return protocol("Extension UI key was invalid");
    }
    Ok(())
}

fn validate_text(value: &str, max: usize, field: &str) -> Result<()> {
    if value.chars().count() > max {
        return protocol(format!("{field} exceeded protocol bounds"));
    }
    Ok(())
}

fn validate_timestamp(value: &str, field: &str) -> Result<()> {
    if value.len() < 20 || !value.contains('T') || !value.ends_with('Z') {
        return protocol(format!("{field} was not an ISO timestamp"));
    }
    Ok(())
}

fn protocol<T>(message: impl Into<String>) -> Result<T> {
    Err(ClientError::Protocol(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dock_event(event_type: &str, data: Value) -> DockEvent {
        DockEvent {
            scope: "instance".into(),
            sequence: 1,
            instance_id: "work".into(),
            runtime_generation: 2,
            occurred_at: "2026-01-01T00:00:00.000Z".into(),
            event_type: event_type.into(),
            data,
        }
    }

    #[test]
    fn response_variants_have_exact_protocol_shapes() {
        assert_eq!(
            serde_json::to_value(InteractionResponse::Select { value: "a".into() }).unwrap(),
            serde_json::json!({"method":"select","value":"a"})
        );
        assert_eq!(
            serde_json::to_value(InteractionResponse::Confirm { confirmed: false }).unwrap(),
            serde_json::json!({"method":"confirm","confirmed":false})
        );
        assert_eq!(
            InteractionResponse::cancelled(InteractionMethod::Editor),
            serde_json::json!({"method":"editor","cancelled":true})
        );
        assert!(
            serde_json::from_value::<InteractionResponse>(
                serde_json::json!({"method":"confirm","confirmed":true,"value":"bad"})
            )
            .is_err()
        );
    }

    #[test]
    fn extension_events_accept_additive_host_metadata_but_keep_stream_types_separate() {
        let valid = dock_event(
            "extension.widget_changed",
            serde_json::json!({"key":"build","lines":["ok"],"placement":"aboveEditor"}),
        );
        assert!(matches!(
            ExtensionEvent::from_dock_event(&valid).unwrap(),
            Some(ExtensionEvent::WidgetChanged(_))
        ));
        let extra = dock_event(
            "extension.status_changed",
            serde_json::json!({"key":"x","text":"y","futureDataField":true}),
        );
        assert!(matches!(
            ExtensionEvent::from_dock_event(&extra).unwrap(),
            Some(ExtensionEvent::StatusChanged(StatusChanged { key, .. })) if key == "x"
        ));
        let directive: TitleDirective = parse_data(&serde_json::json!({
            "controllerId":"controller", "title":"Build", "futureDataField":true
        }))
        .unwrap();
        assert_eq!(directive.title, "Build");
        let request: InteractionRequest = parse_data(&serde_json::json!({
            "controllerId":"controller", "interactionId":"interaction", "method":"confirm",
            "title":"Continue?", "message":"Ready", "issuedAt":"2026-01-01T00:00:00.000Z",
            "expiresAt":null, "futureDataField":true
        }))
        .unwrap();
        assert_eq!(request.method(), InteractionMethod::Confirm);
        let targeted = dock_event(
            "extension.title_set",
            serde_json::json!({"controllerId":"c","title":"x"}),
        );
        assert!(ExtensionEvent::from_dock_event(&targeted).is_err());
    }

    #[test]
    fn widget_and_dialog_bounds_fail_closed() {
        let too_many = dock_event(
            "extension.widget_changed",
            serde_json::json!({"key":"x","lines": vec!["x"; 201]}),
        );
        assert!(ExtensionEvent::from_dock_event(&too_many).is_err());
        let request: InteractionRequest = serde_json::from_value(serde_json::json!({
            "controllerId":"controller", "interactionId":"interaction", "method":"select", "title":"Pick", "options":vec!["x"; 201], "issuedAt":"2026-01-01T00:00:00.000Z"
        })).unwrap();
        assert!(request.validate().is_err());
    }

    #[test]
    fn interaction_mutation_result_requires_exact_correlation() {
        let result = InteractionRespondResult {
            interaction_id: "other".into(),
            state: InteractionResolutionState::Resolved,
        };
        let error = validate_interaction_result(result, "expected", "operation-1").unwrap_err();
        assert!(
            matches!(error, ClientError::EffectUnknown { operation_id, .. } if operation_id == "operation-1")
        );
        let additive = serde_json::from_value::<InteractionRespondResult>(serde_json::json!({
            "interactionId":"expected", "state":"resolved", "futureResultField":true
        }))
        .unwrap();
        assert_eq!(additive.interaction_id, "expected");
        assert!(
            serde_json::from_value::<InteractionRespondResult>(serde_json::json!({
                "interactionId":"expected", "state":"future"
            }))
            .is_err()
        );
    }
}
