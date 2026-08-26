use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::{
    ClientError, DockClient, InstanceSnapshot, Result,
    capabilities::{
        COMMAND_DISCOVERY as COMMAND_DISCOVERY_CAPABILITIES, MODELS as MODEL_CAPABILITIES,
        RESOURCES as RESOURCE_CAPABILITIES, SETTINGS as SETTINGS_CAPABILITIES,
        SNAPSHOT as SNAPSHOT_CAPABILITIES, TOOLS as TOOL_CAPABILITIES,
    },
};
const MAX_COMMAND_CONTENT_PAGE_CHARS: usize = 64_000;
const MAX_COMMAND_ARGUMENT_PREFIX_CHARS: usize = 16_384;
const MAX_COMMAND_ARGUMENT_HINT_CHARS: usize = 2_048;
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
    settings_write: SettingsWrite,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThinkingConfigurationResult {
    actual_level: ThinkingLevel,
    available_thinking_levels: Vec<ThinkingLevel>,
    instance: InstanceSnapshot,
    settings_write: SettingsWrite,
}

#[derive(Clone, Debug, Deserialize)]
struct SettingsWrite {
    persisted: bool,
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

const SETTING_KEYS: [SettingKey; 24] = [
    SettingKey::AutoCompaction,
    SettingKey::CompactionReserveTokens,
    SettingKey::CompactionKeepRecentTokens,
    SettingKey::AutoRetry,
    SettingKey::EnableSkillCommands,
    SettingKey::HideThinking,
    SettingKey::ShowCacheMissNotices,
    SettingKey::ShowHardwareCursor,
    SettingKey::ClearOnShrink,
    SettingKey::ShowTerminalProgress,
    SettingKey::QuietStartup,
    SettingKey::CollapseChangelog,
    SettingKey::EnableInstallTelemetry,
    SettingKey::SteeringMode,
    SettingKey::FollowUpMode,
    SettingKey::Transport,
    SettingKey::DoubleEscapeAction,
    SettingKey::TreeFilterMode,
    SettingKey::DefaultProjectTrust,
    SettingKey::HttpIdleTimeoutMs,
    SettingKey::EditorPaddingX,
    SettingKey::OutputPad,
    SettingKey::AutocompleteMaxVisible,
    SettingKey::Warnings,
];

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
        let selected = result.instance.executor.model.as_ref();
        if !result.settings_write.persisted
            || selected.map(|model| (model.provider.as_str(), model.id.as_str()))
                != Some((provider, model_id))
        {
            return Err(effect_unknown(
                operation_id,
                "model response did not prove the requested persisted model",
            ));
        }
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
        let snapshot_level = result.instance.executor.thinking_level.as_deref();
        let requested = thinking_name(level);
        if !result.settings_write.persisted
            || result.actual_level != level
            || snapshot_level != Some(requested)
            || !valid_thinking_levels(&result.available_thinking_levels)
            || !result.available_thinking_levels.contains(&level)
        {
            return Err(effect_unknown(
                operation_id,
                "thinking response did not prove the requested persisted level",
            ));
        }
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
        validate_settings(&result)?;
        Ok(result)
    }

    pub async fn update_setting(
        &self,
        instance_id: &str,
        update: &SettingUpdate,
        operation_id: Option<&str>,
    ) -> Result<SettingUpdateResult> {
        validate_update(update)?;
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
        if validate_setting(&result.setting).is_err()
            || result.setting.key != update.key
            || result.setting.value != update.value
            || result.reload_required != result.setting.reload_required
            || result.host_restart_required != result.setting.host_restart_required
        {
            return Err(effect_unknown(
                operation_id,
                "setting response did not prove the requested value and requirements",
            ));
        }
        Ok(result)
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
    validate_completeness(
        result.models.len(),
        result.total,
        result.truncated,
        "models",
    )?;
    validate_snapshot(&result.instance, instance_id, host_epoch)?;
    if !valid_thinking_levels(&result.available_thinking_levels) {
        return Err(ClientError::Protocol(
            "model result contained duplicate thinking levels".into(),
        ));
    }
    for model in &result.models {
        bounded_nonempty(&model.provider, 256, "model provider")?;
        bounded_nonempty(&model.id, 512, "model ID")?;
        bounded_nonempty(&model.name, 256, "model name")?;
        if model.context_window == Some(0) {
            return Err(ClientError::Protocol(
                "model context window must be positive".into(),
            ));
        }
    }
    Ok(())
}

fn validate_commands(result: &CommandsResult) -> Result<()> {
    validate_completeness(
        result.commands.len(),
        result.total,
        result.truncated,
        "commands",
    )?;
    for command in &result.commands {
        validate_command_reference(&CommandReference::from(command))?;
        if command
            .argument_hint
            .as_ref()
            .is_some_and(|hint| hint.chars().count() > MAX_COMMAND_ARGUMENT_HINT_CHARS)
        {
            return Err(ClientError::Protocol(
                "command argument hint exceeded its bound".into(),
            ));
        }
        if command.content_available == Some(false) {
            return Err(ClientError::Protocol(
                "command content availability must be omitted unless true".into(),
            ));
        }
    }
    if !result
        .commands
        .windows(2)
        .all(|items| command_key(&items[0]) <= command_key(&items[1]))
    {
        return Err(ClientError::Protocol(
            "command catalog was not canonically sorted".into(),
        ));
    }
    Ok(())
}

fn validate_command_reference(command: &CommandReference) -> Result<()> {
    bounded_nonempty(&command.name, 256, "command name")?;
    validate_source(&command.source)
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
        if result.format.is_some()
            || result.revision.is_some()
            || result.text.is_some()
            || result.complete.is_some()
            || result.next_cursor.is_some()
        {
            return Err(ClientError::Protocol(
                "unavailable command content carried content fields".into(),
            ));
        }
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
    validate_completeness(
        returned,
        result.total,
        result.truncated,
        "command completions",
    )?;
    if matches!(&result.items, CommandCompletionItems::Unavailable(()))
        && (result.total != 0 || result.truncated)
    {
        return Err(ClientError::Protocol(
            "absent command completions carried collection state".into(),
        ));
    }
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
    let invalid = || ClientError::Protocol("tool result failed its invariants".into());
    validate_completeness(result.tools.len(), result.total, result.truncated, "tools")
        .map_err(|error| mutation_error(mutation, error))?;
    validate_snapshot(&result.instance, instance_id, host_epoch)
        .map_err(|error| mutation_error(mutation, error))?;
    for tool in &result.tools {
        bounded_nonempty(&tool.name, 256, "tool name")
            .map_err(|error| mutation_error(mutation, error))?;
        if let Some(source) = &tool.source {
            validate_source(source).map_err(|error| mutation_error(mutation, error))?;
        }
    }
    if !result
        .tools
        .windows(2)
        .all(|items| tool_key(&items[0]) <= tool_key(&items[1]))
    {
        return Err(mutation_error(mutation, invalid()));
    }
    if let Some((operation_id, requested)) = mutation {
        let requested = requested.iter().map(String::as_str).collect::<HashSet<_>>();
        let actual = result
            .tools
            .iter()
            .filter(|tool| tool.active)
            .map(|tool| tool.name.as_str())
            .collect::<HashSet<_>>();
        if actual != requested {
            return Err(effect_unknown(
                operation_id,
                "active tool snapshot did not match the requested exact set",
            ));
        }
    }
    Ok(())
}

fn validate_settings(result: &SettingsResult) -> Result<()> {
    if result.settings.len() != SETTING_KEYS.len() {
        return Err(ClientError::Protocol(
            "settings result was not complete".into(),
        ));
    }
    for (setting, expected_key) in result.settings.iter().zip(SETTING_KEYS) {
        if setting.key != expected_key {
            return Err(ClientError::Protocol(
                "settings result was not in canonical key order".into(),
            ));
        }
        validate_setting(setting)?;
    }
    Ok(())
}

fn validate_setting(setting: &SettingInfo) -> Result<()> {
    let definition = setting_definition(setting.key);
    if setting.writable != definition.writable
        || setting.value_type != definition.value_type
        || setting.allowed_values != definition.allowed_values
        || setting.min != definition.min
        || setting.max != definition.max
        || setting.reload_required != definition.reload_required
        || setting.host_restart_required != definition.host_restart_required
        || !value_matches_definition(&setting.value, &definition)
    {
        return Err(ClientError::Protocol(format!(
            "setting {:?} did not match the frozen Protocol V2 definition",
            setting.key
        )));
    }
    Ok(())
}

fn validate_update(update: &SettingUpdate) -> Result<()> {
    let definition = setting_definition(update.key);
    if !definition.writable || !value_matches_definition(&update.value, &definition) {
        return Err(ClientError::Protocol(
            "setting update did not match a writable Protocol V2 setting".into(),
        ));
    }
    Ok(())
}

fn validate_resources(result: &ResourcesResult) -> Result<()> {
    validate_completeness(
        result.resources.len(),
        result.resource_total,
        result.resources_truncated,
        "resources",
    )?;
    validate_completeness(
        result.diagnostics.len(),
        result.diagnostic_total,
        result.diagnostics_truncated,
        "diagnostics",
    )?;
    for resource in &result.resources {
        bounded_nonempty(&resource.name, 256, "resource name")?;
        if let Some(source) = &resource.source {
            validate_source(source)?;
        }
    }
    if !result
        .resources
        .windows(2)
        .all(|items| resource_key(&items[0]) <= resource_key(&items[1]))
        || !result
            .diagnostics
            .windows(2)
            .all(|items| diagnostic_key(&items[0]) <= diagnostic_key(&items[1]))
    {
        return Err(ClientError::Protocol(
            "resource projection was not canonically sorted".into(),
        ));
    }
    Ok(())
}

fn validate_snapshot(
    instance: &InstanceSnapshot,
    instance_id: &str,
    host_epoch: &str,
) -> Result<()> {
    instance.validate()?;
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

fn validate_completeness(returned: usize, total: u64, truncated: bool, field: &str) -> Result<()> {
    if total < returned as u64 || truncated != ((returned as u64) < total) {
        return Err(ClientError::Protocol(format!(
            "{field} completeness metadata was inconsistent"
        )));
    }
    Ok(())
}

fn valid_thinking_levels(levels: &[ThinkingLevel]) -> bool {
    levels.len() <= 7 && levels.iter().copied().collect::<HashSet<_>>().len() == levels.len()
}

fn thinking_name(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
        ThinkingLevel::Max => "max",
    }
}

fn bounded_nonempty(value: &str, max: usize, field: &str) -> Result<()> {
    if value.is_empty() || value.chars().count() > max {
        return Err(ClientError::Protocol(format!(
            "{field} must be bounded and non-empty"
        )));
    }
    Ok(())
}

fn validate_source(source: &SourceInfo) -> Result<()> {
    if source.kind == SourceKind::BuiltIn && (source.path.is_some() || source.package.is_some()) {
        return Err(ClientError::Protocol(
            "built-in source unexpectedly carried a path or package".into(),
        ));
    }
    Ok(())
}

fn source_key(source: Option<&SourceInfo>) -> (String, &str, &str) {
    match source {
        Some(source) => (
            format!("{:?}", source.kind).to_lowercase(),
            source.package.as_deref().unwrap_or(""),
            source.path.as_deref().unwrap_or(""),
        ),
        None => ("builtin".into(), "", ""),
    }
}

fn command_key(command: &CommandInfo) -> (&str, (String, &str, &str), &str, &str, bool, bool) {
    (
        &command.name,
        source_key(Some(&command.source)),
        command.description.as_deref().unwrap_or(""),
        command.argument_hint.as_deref().unwrap_or(""),
        command.argument_completions,
        command.content_available == Some(true),
    )
}

fn tool_key(tool: &ToolInfo) -> (&str, (String, &str, &str), &str, bool, String) {
    (
        &tool.name,
        source_key(tool.source.as_ref()),
        &tool.description,
        tool.active,
        serde_json::to_string(&tool.parameter_schema).unwrap_or_default(),
    )
}

fn resource_key(resource: &ResourceInfo) -> (String, &str, &str, (String, &str, &str)) {
    (
        format!("{:?}", resource.kind).to_lowercase(),
        &resource.name,
        resource.path.as_deref().unwrap_or(""),
        source_key(resource.source.as_ref()),
    )
}

fn diagnostic_key(diagnostic: &DiagnosticInfo) -> (String, &str, &str) {
    (
        format!("{:?}", diagnostic.severity).to_lowercase(),
        &diagnostic.message,
        diagnostic.source.as_deref().unwrap_or(""),
    )
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

#[derive(Clone)]
struct SettingDefinition {
    value_type: SettingValueType,
    allowed_values: Option<Vec<Value>>,
    min: Option<u64>,
    max: Option<u64>,
    reload_required: bool,
    host_restart_required: bool,
    writable: bool,
}

fn setting_definition(key: SettingKey) -> SettingDefinition {
    use SettingKey::*;
    match key {
        CompactionReserveTokens | CompactionKeepRecentTokens => integer(0, 2_147_483_647, false),
        SteeringMode | FollowUpMode => enumeration(&["all", "one-at-a-time"]),
        Transport => enumeration(&["auto", "sse", "websocket", "websocket-cached"]),
        DoubleEscapeAction => enumeration(&["fork", "tree", "none"]),
        TreeFilterMode => enumeration(&["default", "no-tools", "user-only", "labeled-only", "all"]),
        DefaultProjectTrust => enumeration(&["ask", "always", "never"]),
        HttpIdleTimeoutMs => integer(0, 2_147_483_647, true),
        EditorPaddingX => integer(0, 3, true),
        OutputPad => integer(0, 1, true),
        AutocompleteMaxVisible => integer(3, 20, true),
        Warnings => SettingDefinition {
            value_type: SettingValueType::Object,
            allowed_values: None,
            min: None,
            max: None,
            reload_required: false,
            host_restart_required: false,
            writable: true,
        },
        EnableSkillCommands => boolean_setting(true),
        _ => boolean_setting(false),
    }
}

fn boolean_setting(reload_required: bool) -> SettingDefinition {
    SettingDefinition {
        value_type: SettingValueType::Boolean,
        allowed_values: None,
        min: None,
        max: None,
        reload_required,
        host_restart_required: false,
        writable: true,
    }
}

fn enumeration(values: &[&str]) -> SettingDefinition {
    SettingDefinition {
        value_type: SettingValueType::Enum,
        allowed_values: Some(
            values
                .iter()
                .map(|value| Value::String((*value).into()))
                .collect(),
        ),
        min: None,
        max: None,
        reload_required: false,
        host_restart_required: false,
        writable: true,
    }
}

fn integer(min: u64, max: u64, writable: bool) -> SettingDefinition {
    SettingDefinition {
        value_type: SettingValueType::Integer,
        allowed_values: None,
        min: Some(min),
        max: Some(max),
        reload_required: false,
        host_restart_required: false,
        writable,
    }
}

fn value_matches_definition(value: &SettingValue, definition: &SettingDefinition) -> bool {
    match (value, definition.value_type) {
        (SettingValue::Boolean(_), SettingValueType::Boolean) => true,
        (SettingValue::Enum(value), SettingValueType::Enum) => definition
            .allowed_values
            .as_ref()
            .is_some_and(|allowed| allowed.contains(&Value::String(value.clone()))),
        (SettingValue::Integer(value), SettingValueType::Integer) => {
            definition.min.is_some_and(|min| *value >= min)
                && definition.max.is_some_and(|max| *value <= max)
        }
        (SettingValue::Object(value), SettingValueType::Object) => {
            value.keys().all(|key| key == "anthropicExtraUsage")
                && value
                    .get("anthropicExtraUsage")
                    .is_none_or(Value::is_boolean)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_metadata_and_values_follow_frozen_contract() {
        let transport = SettingInfo {
            key: SettingKey::Transport,
            value: SettingValue::Enum("websocket".into()),
            source: SettingSource::Global,
            writable: true,
            value_type: SettingValueType::Enum,
            allowed_values: Some(vec![
                Value::String("auto".into()),
                Value::String("sse".into()),
                Value::String("websocket".into()),
                Value::String("websocket-cached".into()),
            ]),
            min: None,
            max: None,
            reload_required: false,
            host_restart_required: false,
        };
        assert!(validate_setting(&transport).is_ok());
        assert!(
            validate_update(&SettingUpdate {
                key: SettingKey::CompactionReserveTokens,
                value: SettingValue::Integer(100),
            })
            .is_err()
        );

        let invalid = SettingInfo {
            key: SettingKey::EditorPaddingX,
            value: SettingValue::Integer(2),
            source: SettingSource::Global,
            writable: true,
            value_type: SettingValueType::Integer,
            allowed_values: None,
            min: Some(0),
            max: Some(4),
            reload_required: false,
            host_restart_required: false,
        };
        assert!(validate_setting(&invalid).is_err());
    }

    #[test]
    fn completeness_requires_honest_truncation_state() {
        assert!(validate_completeness(2, 3, true, "test").is_ok());
        assert!(validate_completeness(2, 3, false, "test").is_err());
        assert!(validate_completeness(3, 2, false, "test").is_err());
    }

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
        assert!(validate_command_completions(&absent_but_truncated, &command).is_err());

        let missing_items = serde_json::json!({
            "command": command,
            "total": 0,
            "truncated": false
        });
        assert!(serde_json::from_value::<CommandCompletionsResult>(missing_items).is_err());
    }

    #[test]
    fn object_setting_accepts_only_the_projected_warning_control() {
        let mut value = Map::new();
        value.insert("anthropicExtraUsage".into(), Value::Bool(false));
        assert!(
            validate_update(&SettingUpdate {
                key: SettingKey::Warnings,
                value: SettingValue::Object(value.clone()),
            })
            .is_ok()
        );
        value.insert("secretPath".into(), Value::String("/host/private".into()));
        assert!(
            validate_update(&SettingUpdate {
                key: SettingKey::Warnings,
                value: SettingValue::Object(value),
            })
            .is_err()
        );
    }
}
