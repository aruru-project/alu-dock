//! Path-free values for client interfaces; native capabilities never leave core.
use super::*;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSource {
    pub kind: crate::SourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeCommand {
    pub reference_id: String,
    pub name: String,
    pub description: Option<String>,
    pub source: SafeSource,
    pub argument_hint: Option<String>,
    pub argument_completions: bool,
    pub content_available: bool,
}

#[derive(Serialize)]
pub struct SafeCommandsResult {
    pub commands: Vec<SafeCommand>,
    pub total: u64,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeCommandContentResult {
    pub reference_id: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeCommandCompletionsResult {
    pub reference_id: String,
    pub items: Option<Vec<CommandArgumentCompletion>>,
    pub total: u64,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeTool {
    pub name: String,
    pub description: String,
    pub active: bool,
    pub source: Option<SafeSource>,
}

#[derive(Serialize)]
pub struct SafeToolsResult {
    pub tools: Vec<SafeTool>,
    pub instance: InstanceSnapshot,
    pub total: u64,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct SafeResource {
    pub kind: crate::ResourceKind,
    pub name: String,
    pub source: Option<SafeSource>,
    #[serde(rename = "contentRef", skip_serializing_if = "Option::is_none")]
    pub content_ref: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeResourcesResult {
    pub resources: Vec<SafeResource>,
    pub diagnostics: Vec<SafeDiagnostic>,
    pub resource_total: u64,
    pub resources_truncated: bool,
    pub diagnostic_total: u64,
    pub diagnostics_truncated: bool,
}

#[derive(Serialize)]
pub struct SafeDiagnostic {
    pub severity: crate::DiagnosticSeverity,
    pub message: String,
}

pub fn project_source(source: SourceInfo) -> SafeSource {
    SafeSource {
        kind: source.kind,
        package: source.package,
    }
}

pub fn project_commands(
    result: CommandsResult,
    state: &CommandReferenceState,
    scope: CommandReferenceScope,
    reference_generation: u64,
) -> Result<SafeCommandsResult> {
    let mut references = HashMap::new();
    let commands = result
        .commands
        .into_iter()
        .map(|command: CommandInfo| {
            let reference_id = uuid::Uuid::new_v4().to_string();
            references.insert(reference_id.clone(), CommandReference::from(&command));
            SafeCommand {
                reference_id,
                name: command.name,
                description: command.description,
                source: project_source(command.source),
                argument_hint: command.argument_hint,
                argument_completions: command.argument_completions,
                content_available: command.content_available == Some(true),
            }
        })
        .collect();
    if !state.replace(scope, reference_generation, references) {
        return Err(ClientError::Action {
            code: "command_reference_expired",
            message: "命令引用已失效，请刷新命令目录后重试。",
        });
    }
    Ok(SafeCommandsResult {
        commands,
        total: result.total,
        truncated: result.truncated,
    })
}

pub fn project_tools(result: ToolsResult) -> SafeToolsResult {
    SafeToolsResult {
        tools: result
            .tools
            .into_iter()
            .map(|tool: ToolInfo| SafeTool {
                name: tool.name,
                description: tool.description,
                active: tool.active,
                source: tool.source.map(project_source),
            })
            .collect(),
        instance: result.instance,
        total: result.total,
        truncated: result.truncated,
    }
}

pub fn project_resources(result: ResourcesResult) -> SafeResourcesResult {
    SafeResourcesResult {
        resources: result
            .resources
            .into_iter()
            .map(|resource: ResourceInfo| SafeResource {
                kind: resource.kind,
                name: resource.name,
                source: resource.source.map(project_source),
                content_ref: resource.content_ref,
            })
            .collect(),
        diagnostics: result
            .diagnostics
            .into_iter()
            .map(|diagnostic: DiagnosticInfo| SafeDiagnostic {
                severity: diagnostic.severity,
                message: diagnostic.message,
            })
            .collect(),
        resource_total: result.resource_total,
        resources_truncated: result.resources_truncated,
        diagnostic_total: result.diagnostic_total,
        diagnostics_truncated: result.diagnostics_truncated,
    }
}
