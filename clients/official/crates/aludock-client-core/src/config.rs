mod presentation;
pub use presentation::*;
use std::collections::HashSet;
use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::{
    ClientError, DockClient, InstanceSnapshot, Result,
    capabilities::{
        COMMAND_DISCOVERY as COMMAND_DISCOVERY_CAPABILITIES, MODELS as MODEL_CAPABILITIES,
        RESOURCE_CONTENT as RESOURCE_CONTENT_CAPABILITIES, RESOURCES as RESOURCE_CAPABILITIES,
        SETTINGS as SETTINGS_CAPABILITIES, SNAPSHOT as SNAPSHOT_CAPABILITIES,
        TOOLS as TOOL_CAPABILITIES,
    },
};
const MAX_COMMAND_CONTENT_PAGE_CHARS: usize = 64_000;
const MAX_COMMAND_ARGUMENT_PREFIX_CHARS: usize = 16_384;
const MAX_COMMAND_COMPLETION_TEXT_CHARS: usize = 2_048;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub context_window: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsResult {
    pub models: Vec<ModelInfo>,
    pub available_thinking_levels: Vec<ThinkingLevel>,
    pub instance: InstanceSnapshot,
    pub total: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigurationResult {
    instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThinkingConfigurationResult {
    instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    BuiltIn,
    Extension,
    Skill,
    Prompt,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SourceInfo {
    pub kind: SourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    pub description: Option<String>,
    pub source: SourceInfo,
    pub argument_hint: Option<String>,
    pub argument_completions: bool,
    pub content_available: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CommandReference {
    pub name: String,
    pub source: SourceInfo,
}

impl From<&CommandInfo> for CommandReference {
    fn from(command: &CommandInfo) -> Self {
        Self {
            name: command.name.clone(),
            source: command.source.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandContentResult {
    pub command: CommandReference,
    pub available: bool,
    pub format: Option<String>,
    pub revision: Option<String>,
    pub text: Option<String>,
    pub complete: Option<bool>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CommandArgumentCompletion {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum CommandCompletionItems {
    Available(Vec<CommandArgumentCompletion>),
    Unavailable(()),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CommandCompletionsResult {
    pub command: CommandReference,
    pub items: CommandCompletionItems,
    pub total: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CommandsResult {
    pub commands: Vec<CommandInfo>,
    pub total: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub active: bool,
    pub source: Option<SourceInfo>,
    pub parameter_schema: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolsResult {
    pub tools: Vec<ToolInfo>,
    pub instance: InstanceSnapshot,
    pub total: u64,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum SettingKey {
    AutoCompaction,
    CompactionReserveTokens,
    CompactionKeepRecentTokens,
    AutoRetry,
    EnableSkillCommands,
    HideThinking,
    ShowCacheMissNotices,
    ShowHardwareCursor,
    ClearOnShrink,
    ShowTerminalProgress,
    QuietStartup,
    CollapseChangelog,
    EnableInstallTelemetry,
    SteeringMode,
    FollowUpMode,
    Transport,
    DoubleEscapeAction,
    TreeFilterMode,
    DefaultProjectTrust,
    HttpIdleTimeoutMs,
    EditorPaddingX,
    OutputPad,
    AutocompleteMaxVisible,
    Warnings,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum SettingValue {
    Boolean(bool),
    Integer(u64),
    Enum(String),
    Object(Map<String, Value>),
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SettingSource {
    Global,
    Project,
    Effective,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SettingValueType {
    Boolean,
    Enum,
    Integer,
    Object,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingInfo {
    pub key: SettingKey,
    pub value: SettingValue,
    pub source: SettingSource,
    pub writable: bool,
    pub value_type: SettingValueType,
    pub allowed_values: Option<Vec<Value>>,
    pub min: Option<u64>,
    pub max: Option<u64>,
    pub reload_required: bool,
    pub host_restart_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SettingsResult {
    pub settings: Vec<SettingInfo>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SettingUpdate {
    pub key: SettingKey,
    pub value: SettingValue,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingUpdateResult {
    pub setting: SettingInfo,
    pub instance: InstanceSnapshot,
    pub reload_required: bool,
    pub host_restart_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Extension,
    Skill,
    Prompt,
    Context,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResourceInfo {
    pub kind: ResourceKind,
    pub name: String,
    pub path: Option<String>,
    pub source: Option<SourceInfo>,
    #[serde(
        rename = "contentRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub content_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceContentResult {
    pub text: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceContentParams<'a> {
    instance_id: &'a str,
    content_ref: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DiagnosticInfo {
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesResult {
    pub resources: Vec<ResourceInfo>,
    pub diagnostics: Vec<DiagnosticInfo>,
    pub resource_total: u64,
    pub resources_truncated: bool,
    pub diagnostic_total: u64,
    pub diagnostics_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceParams<'a> {
    instance_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandParams<'a> {
    instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    prefix: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandContentParams<'a> {
    instance_id: &'a str,
    command: &'a CommandReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandCompletionsParams<'a> {
    instance_id: &'a str,
    command: &'a CommandReference,
    argument_prefix: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    provider: &'a str,
    model_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinkingParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    level: ThinkingLevel,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    names: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    update: &'a SettingUpdate,
}

impl DockClient {
    pub async fn run_catalog_command(
        &self,
        instance_id: &str,
        name: &str,
        arguments: &str,
        operation_id: &str,
    ) -> Result<crate::SubmitResult> {
        let arguments = arguments.trim();
        let message = if arguments.is_empty() {
            format!("/{name}")
        } else {
            format!("/{name} {arguments}")
        };
        self.submit_message(
            instance_id,
            &message,
            crate::DeliveryMode::Auto,
            Some(operation_id),
        )
        .await
    }

    pub async fn commands(
        &self,
        instance_id: &str,
        prefix: Option<&str>,
    ) -> Result<CommandsResult> {
        let result: CommandsResult = self
            .request(
                "command.catalog",
                &CommandParams {
                    instance_id,
                    prefix,
                },
                RESOURCE_CAPABILITIES,
                None,
            )
            .await?;
        validate_commands(&result)?;
        Ok(result)
    }

    pub async fn command_content(
        &self,
        instance_id: &str,
        command: &CommandReference,
        cursor: Option<&str>,
    ) -> Result<CommandContentResult> {
        validate_command_reference(command)?;
        if let Some(cursor) = cursor {
            bounded_nonempty(cursor, 128, "command content cursor")?;
        }
        let result: CommandContentResult = self
            .request(
                "command.content",
                &CommandContentParams {
                    instance_id,
                    command,
                    cursor,
                },
                COMMAND_DISCOVERY_CAPABILITIES,
                None,
            )
            .await?;
        validate_command_content(&result, command)?;
        Ok(result)
    }

    pub async fn command_completions(
        &self,
        instance_id: &str,
        command: &CommandReference,
        argument_prefix: &str,
    ) -> Result<CommandCompletionsResult> {
        validate_command_reference(command)?;
        if argument_prefix.chars().count() > MAX_COMMAND_ARGUMENT_PREFIX_CHARS {
            return Err(ClientError::Protocol(
                "command argument prefix exceeded its bound".into(),
            ));
        }
        let result: CommandCompletionsResult = self
            .request(
                "command.complete",
                &CommandCompletionsParams {
                    instance_id,
                    command,
                    argument_prefix,
                },
                COMMAND_DISCOVERY_CAPABILITIES,
                None,
            )
            .await?;
        validate_command_completions(&result, command)?;
        Ok(result)
    }

    pub async fn models(&self, instance_id: &str) -> Result<ModelsResult> {
        let (result, host_epoch): (ModelsResult, _) = self
            .request_with_host_epoch(
                "model.list",
                &InstanceParams { instance_id },
                MODEL_CAPABILITIES,
                None,
            )
            .await?;
        validate_models(&result, instance_id, &host_epoch)?;
        Ok(result)
    }

    pub async fn set_model(
        &self,
        instance_id: &str,
        provider: &str,
        model_id: &str,
        operation_id: Option<&str>,
    ) -> Result<InstanceSnapshot> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let (result, host_epoch): (ModelConfigurationResult, _) = self
            .request_with_host_epoch(
                "model.set",
                &ModelParams {
                    operation_id,
                    instance_id,
                    provider,
                    model_id,
                },
                &SNAPSHOT_CAPABILITIES
                    .iter()
                    .copied()
                    .chain(["models.v1"])
                    .collect::<Vec<_>>(),
                Some(operation_id),
            )
            .await?;
        validate_snapshot_mutation(&result.instance, instance_id, &host_epoch, operation_id)?;
        Ok(result.instance)
    }

    pub async fn set_thinking(
        &self,
        instance_id: &str,
        level: ThinkingLevel,
        operation_id: Option<&str>,
    ) -> Result<InstanceSnapshot> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let (result, host_epoch): (ThinkingConfigurationResult, _) = self
            .request_with_host_epoch(
                "thinking.set",
                &ThinkingParams {
                    operation_id,
                    instance_id,
                    level,
                },
                &SNAPSHOT_CAPABILITIES
                    .iter()
                    .copied()
                    .chain(["models.v1"])
                    .collect::<Vec<_>>(),
                Some(operation_id),
            )
            .await?;
        validate_snapshot_mutation(&result.instance, instance_id, &host_epoch, operation_id)?;
        Ok(result.instance)
    }

    pub async fn tools(&self, instance_id: &str) -> Result<ToolsResult> {
        let (result, host_epoch): (ToolsResult, _) = self
            .request_with_host_epoch(
                "tool.list",
                &InstanceParams { instance_id },
                TOOL_CAPABILITIES,
                None,
            )
            .await?;
        validate_tools(&result, instance_id, &host_epoch, None)?;
        Ok(result)
    }

    pub async fn set_active_tools(
        &self,
        instance_id: &str,
        names: &[String],
        operation_id: Option<&str>,
    ) -> Result<ToolsResult> {
        if names.iter().collect::<HashSet<_>>().len() != names.len() {
            return Err(ClientError::Protocol(
                "active tool names must be unique".into(),
            ));
        }
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let (result, host_epoch): (ToolsResult, _) = self
            .request_with_host_epoch(
                "tool.set_active",
                &ToolParams {
                    operation_id,
                    instance_id,
                    names,
                },
                TOOL_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_tools(
            &result,
            instance_id,
            &host_epoch,
            Some((operation_id, names)),
        )?;
        Ok(result)
    }

    pub async fn settings(&self, instance_id: &str) -> Result<SettingsResult> {
        let result: SettingsResult = self
            .request(
                "settings.get",
                &InstanceParams { instance_id },
                SETTINGS_CAPABILITIES,
                None,
            )
            .await?;
        Ok(result)
    }

    pub async fn update_setting(
        &self,
        instance_id: &str,
        update: &SettingUpdate,
        operation_id: Option<&str>,
    ) -> Result<SettingUpdateResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let (result, host_epoch): (SettingUpdateResult, _) = self
            .request_with_host_epoch(
                "settings.update",
                &SettingParams {
                    operation_id,
                    instance_id,
                    update,
                },
                SETTINGS_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_snapshot_mutation(&result.instance, instance_id, &host_epoch, operation_id)?;
        Ok(result)
    }

    pub async fn resource_content_all(
        &self,
        instance_id: &str,
        content_ref: &str,
    ) -> Result<ResourceContentResult> {
        let params = ResourceContentParams {
            instance_id,
            content_ref,
            offset: None,
            revision: None,
        };
        if let Some(result) = self
            .read_file_text("resource.content", &params, RESOURCE_CONTENT_CAPABILITIES)
            .await?
        {
            return Ok(result);
        }
        let mut text = String::new();
        let mut offset = None;
        let mut revision: Option<String> = None;
        loop {
            let page = self
                .resource_content(instance_id, content_ref, offset, revision.as_deref())
                .await?;
            text.push_str(&page.text);
            offset = page.next_offset;
            revision = Some(page.revision);
            if offset.is_none() {
                return Ok(ResourceContentResult {
                    text,
                    revision: revision.unwrap(),
                    next_offset: None,
                });
            }
        }
    }

    pub async fn resource_content(
        &self,
        instance_id: &str,
        content_ref: &str,
        offset: Option<u64>,
        revision: Option<&str>,
    ) -> Result<ResourceContentResult> {
        self.request(
            "resource.content",
            &ResourceContentParams {
                instance_id,
                content_ref,
                offset,
                revision,
            },
            RESOURCE_CONTENT_CAPABILITIES,
            None,
        )
        .await
    }

    pub async fn resources(&self, instance_id: &str) -> Result<ResourcesResult> {
        let result: ResourcesResult = self
            .request(
                "resource.get",
                &InstanceParams { instance_id },
                RESOURCE_CAPABILITIES,
                None,
            )
            .await?;
        validate_resources(&result)?;
        Ok(result)
    }
}

fn validate_models(result: &ModelsResult, instance_id: &str, host_epoch: &str) -> Result<()> {
    validate_snapshot(&result.instance, instance_id, host_epoch)
}

fn validate_commands(result: &CommandsResult) -> Result<()> {
    for command in &result.commands {
        validate_command_reference(&CommandReference::from(command))?;
    }
    Ok(())
}

fn validate_command_reference(command: &CommandReference) -> Result<()> {
    bounded_nonempty(&command.name, 256, "command name")
}

fn validate_command_content(
    result: &CommandContentResult,
    expected: &CommandReference,
) -> Result<()> {
    if &result.command != expected {
        return Err(ClientError::Protocol(
            "command content referenced a different command".into(),
        ));
    }
    if !result.available {
        return Ok(());
    }
    if result.format.as_deref() != Some("markdown") {
        return Err(ClientError::Protocol(
            "command content format was not markdown".into(),
        ));
    }
    bounded_nonempty(
        result.revision.as_deref().unwrap_or(""),
        128,
        "command content revision",
    )?;
    let text = result
        .text
        .as_deref()
        .ok_or_else(|| ClientError::Protocol("available command content omitted text".into()))?;
    if text.chars().count() > MAX_COMMAND_CONTENT_PAGE_CHARS {
        return Err(ClientError::Protocol(
            "command content page exceeded its bound".into(),
        ));
    }
    let complete = result.complete.ok_or_else(|| {
        ClientError::Protocol("available command content omitted completion state".into())
    })?;
    if complete == result.next_cursor.is_some() {
        return Err(ClientError::Protocol(
            "command content continuation metadata was inconsistent".into(),
        ));
    }
    if let Some(cursor) = result.next_cursor.as_deref() {
        bounded_nonempty(cursor, 128, "command content cursor")?;
    }
    Ok(())
}

fn validate_command_completions(
    result: &CommandCompletionsResult,
    expected: &CommandReference,
) -> Result<()> {
    if &result.command != expected {
        return Err(ClientError::Protocol(
            "command completions referenced a different command".into(),
        ));
    }
    let returned = match &result.items {
        CommandCompletionItems::Available(items) => items.len(),
        CommandCompletionItems::Unavailable(()) => 0,
    };
    if returned > 1_000 {
        return Err(ClientError::Protocol(
            "command completions exceeded their bound".into(),
        ));
    }
    let items = match &result.items {
        CommandCompletionItems::Available(items) => items.as_slice(),
        CommandCompletionItems::Unavailable(()) => &[],
    };
    for item in items {
        if item.value.chars().count() > MAX_COMMAND_ARGUMENT_PREFIX_CHARS {
            return Err(ClientError::Protocol(
                "command completion value exceeded its bound".into(),
            ));
        }
        bounded_nonempty(
            &item.label,
            MAX_COMMAND_COMPLETION_TEXT_CHARS,
            "command completion label",
        )?;
        if item.description.as_ref().is_some_and(|description| {
            description.chars().count() > MAX_COMMAND_COMPLETION_TEXT_CHARS
        }) {
            return Err(ClientError::Protocol(
                "command completion description exceeded its bound".into(),
            ));
        }
    }
    Ok(())
}

fn validate_tools(
    result: &ToolsResult,
    instance_id: &str,
    host_epoch: &str,
    mutation: Option<(&str, &[String])>,
) -> Result<()> {
    validate_snapshot(&result.instance, instance_id, host_epoch)
        .map_err(|error| mutation_error(mutation, error))
}

fn validate_resources(result: &ResourcesResult) -> Result<()> {
    for resource in &result.resources {
        bounded_nonempty(&resource.name, 256, "resource name")?;
    }
    Ok(())
}

fn validate_snapshot(
    instance: &InstanceSnapshot,
    instance_id: &str,
    host_epoch: &str,
) -> Result<()> {
    if instance.id != instance_id
        || instance
            .owner_host_epoch
            .as_deref()
            .is_some_and(|owner| owner != host_epoch)
    {
        return Err(ClientError::Protocol(
            "instance snapshot did not correlate to the request and negotiated Host".into(),
        ));
    }
    Ok(())
}

fn validate_snapshot_mutation(
    instance: &InstanceSnapshot,
    instance_id: &str,
    host_epoch: &str,
    operation_id: &str,
) -> Result<()> {
    validate_snapshot(instance, instance_id, host_epoch)
        .map_err(|error| effect_unknown(operation_id, &error.to_string()))
}

fn bounded_nonempty(value: &str, max: usize, field: &str) -> Result<()> {
    if value.is_empty() || value.chars().count() > max {
        return Err(ClientError::Protocol(format!(
            "{field} must be bounded and non-empty"
        )));
    }
    Ok(())
}

fn mutation_error(mutation: Option<(&str, &[String])>, error: ClientError) -> ClientError {
    match mutation {
        Some((operation_id, _)) => effect_unknown(operation_id, &error.to_string()),
        None => error,
    }
}

fn effect_unknown(operation_id: &str, message: &str) -> ClientError {
    ClientError::EffectUnknown {
        operation_id: operation_id.to_owned(),
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_source_omits_absent_optional_identity_fields() {
        let source = SourceInfo {
            kind: SourceKind::BuiltIn,
            path: None,
            package: None,
        };
        assert_eq!(
            serde_json::to_value(source).unwrap(),
            serde_json::json!({ "kind": "built-in" })
        );
    }

    #[test]
    fn command_discovery_results_keep_owner_identity_and_page_invariants() {
        let command = CommandReference {
            name: "idea".into(),
            source: SourceInfo {
                kind: SourceKind::Prompt,
                path: Some("/worker/prompts/idea.md".into()),
                package: None,
            },
        };
        let page = CommandContentResult {
            command: command.clone(),
            available: true,
            format: Some("markdown".into()),
            revision: Some("revision-1".into()),
            text: Some("Prompt body".into()),
            complete: Some(false),
            next_cursor: Some("next-page".into()),
        };
        assert!(validate_command_content(&page, &command).is_ok());

        let mut mismatched = page.clone();
        mismatched.command.name = "other".into();
        assert!(validate_command_content(&mismatched, &command).is_err());

        let completions = CommandCompletionsResult {
            command: command.clone(),
            items: CommandCompletionItems::Available(vec![CommandArgumentCompletion {
                value: "src/".into(),
                label: "src/".into(),
                description: Some("Source directory".into()),
            }]),
            total: 1,
            truncated: false,
        };
        assert!(validate_command_completions(&completions, &command).is_ok());

        let absent_but_truncated = CommandCompletionsResult {
            command: command.clone(),
            items: CommandCompletionItems::Unavailable(()),
            total: 1,
            truncated: true,
        };
        assert!(validate_command_completions(&absent_but_truncated, &command).is_ok());
        let unavailable = CommandContentResult {
            available: false,
            ..page
        };
        assert!(validate_command_content(&unavailable, &command).is_ok());

        let missing_items = serde_json::json!({
            "command": command,
            "total": 0,
            "truncated": false
        });
        assert!(serde_json::from_value::<CommandCompletionsResult>(missing_items).is_err());
    }
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct CommandReferenceScope {
    pub connection_id: String,
    pub selection_generation: u64,
    pub instance_id: String,
}

#[derive(Default)]
struct CommandReferenceEntries {
    generations: HashMap<CommandReferenceScope, u64>,
    scopes: HashMap<CommandReferenceScope, HashMap<String, CommandReference>>,
}

#[derive(Default)]
pub struct CommandReferenceState {
    inner: Mutex<CommandReferenceEntries>,
}

impl CommandReferenceState {
    pub fn begin(&self, scope: &CommandReferenceScope) -> u64 {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.generations.retain(|candidate, _| {
            candidate.connection_id != scope.connection_id
                || candidate.selection_generation == scope.selection_generation
        });
        inner.scopes.retain(|candidate, _| {
            candidate.connection_id != scope.connection_id
                || candidate.selection_generation == scope.selection_generation
        });
        let generation = inner
            .generations
            .get(scope)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        inner.generations.insert(scope.clone(), generation);
        generation
    }

    pub fn replace(
        &self,
        scope: CommandReferenceScope,
        generation: u64,
        references: HashMap<String, CommandReference>,
    ) -> bool {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if inner.generations.get(&scope) != Some(&generation) {
            return false;
        }
        inner.scopes.insert(scope, references);
        true
    }

    pub fn resolve(
        &self,
        scope: &CommandReferenceScope,
        reference_id: &str,
    ) -> Result<CommandReference> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .scopes
            .get(scope)
            .and_then(|references| references.get(reference_id))
            .cloned()
            .ok_or_else(|| ClientError::Action {
                code: "command_reference_expired",
                message: "命令引用已失效，请刷新命令目录后重试。",
            })
    }
}
