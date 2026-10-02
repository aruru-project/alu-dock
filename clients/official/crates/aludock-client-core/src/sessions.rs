mod content_stream;
mod presentation;
pub use presentation::*;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ClientError, DiagnosticInfo, DockClient, HistoryRecord, InstanceSnapshot, ProjectTrustDecision,
    PublishedFileDto, ResourceInfo, Result,
    capabilities::{
        CONVERSATION_CONTENT as CONVERSATION_CAPABILITIES, CONVERSATION_REFERENCES,
        CONVERSATION_REFERENCES_V1, SESSION_COMMANDS as SESSION_COMMAND_CAPABILITIES,
        SESSION_HISTORY as SESSION_HISTORY_CAPABILITIES, SESSION_INVENTORY,
        SESSION_INVENTORY_PAGES, SESSION_TREE as SESSION_TREE_CAPABILITIES,
    },
    conversation_images::{MAX_CONVERSATION_IMAGE_BYTES, valid_image_mime_type},
    wire::decode_canonical_base64,
};

/// Complete native default templates, not a dynamically assembled provider request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionPromptTemplatesResult {
    pub system: String,
    pub summarize: String,
    pub update: String,
    pub turn_prefix: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionScope {
    Cwd,
    All,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub session_file: String,
    pub name: Option<String>,
    pub first_user_message: Option<String>,
    pub cwd: String,
    pub updated_at: Option<String>,
    /// Latest conversation time; older Hosts only report `updated_at`.
    pub last_activity_at: Option<String>,
    /// Recorded call costs summed over the saved session; absent when none were recorded.
    pub cost_total: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInventoryQuery {
    cwd: String,
    scope: SessionScope,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInventoryDiagnostic {
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInventoryWireResult {
    sessions: Vec<SessionInfo>,
    query: SessionInventoryQuery,
    total: u64,
    truncated: bool,
    #[serde(default)]
    incomplete: bool,
    #[serde(default)]
    diagnostics: Vec<SessionInventoryDiagnostic>,
    #[serde(default)]
    diagnostics_truncated: bool,
    #[serde(default)]
    next_cursor: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SessionInventoryResult {
    pub sessions: Vec<SessionInfo>,
    pub total: u64,
    pub truncated: bool,
    pub incomplete: bool,
    pub diagnostics: Vec<SessionInventoryDiagnostic>,
    pub diagnostics_truncated: bool,
    /// Pass back to `session_inventory` to read the next page; absent on the last page.
    pub next_cursor: Option<String>,
    pub host_epoch: String,
}

/// One history scan and its bodies share the view selected by their first request.
/// This is caller-owned read state, never a Host-wide capability cache.
#[derive(Clone, Copy, Debug, Default)]
pub struct ConversationReadContext {
    view: Option<ConversationReadView>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConversationReadView {
    References,
    Legacy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHistoryEntry {
    pub entry: HistoryRecord,
    pub content_ref: String,
    pub content_complete: bool,
    pub total_blocks: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHistoryPage {
    pub instance: InstanceSnapshot,
    pub revision: String,
    pub entries: Vec<ConversationHistoryEntry>,
    pub has_earlier: bool,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryPage {
    pub history_revision: u64,
    pub entries: Vec<HistoryRecord>,
    pub has_earlier: bool,
    pub next_before_entry_id: Option<String>,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConversationContentChunk {
    Text {
        block_index: usize,
        text: String,
        offset: usize,
        block_complete: bool,
    },
    Thinking {
        block_index: usize,
        text: String,
        offset: usize,
        block_complete: bool,
    },
    ImageRef {
        block_index: usize,
        mime_type: String,
        content_ref: Option<String>,
        file_id: Option<String>,
    },
    Image {
        block_index: usize,
        mime_type: String,
        data: String,
        offset: usize,
        block_complete: bool,
    },
    ToolCall {
        block_index: usize,
        tool_call_id: String,
        tool_name: String,
        arguments_json: String,
        offset: usize,
        block_complete: bool,
    },
    ToolResult {
        block_index: usize,
        tool_call_id: String,
        tool_name: String,
        text: String,
        offset: usize,
        block_complete: bool,
        is_error: bool,
        published_file: Option<PublishedFileDto>,
        /// Sent once, on the chunk that completes the result block.
        #[serde(default)]
        nested_calls: Option<serde_json::Value>,
        omitted_fields: Option<Vec<String>>,
    },
    Omitted {
        block_index: usize,
        kind: String,
        description: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContentPage {
    pub instance_id: String,
    pub runtime_generation: u64,
    pub revision: String,
    pub content_ref: String,
    pub chunks: Vec<ConversationContentChunk>,
    pub complete: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationHistoryParams<'a> {
    instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    view: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
    limit: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionHistoryParams<'a> {
    instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    before_entry_id: Option<&'a str>,
    limit: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationContentParams<'a> {
    instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    view: Option<&'a str>,
    content_ref: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInventoryParams<'a> {
    cwd: &'a str,
    scope: SessionScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMutationParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSwitchParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    session_file: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    trust_challenge_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_trust_decision: Option<ProjectTrustDecision>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionNewParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_session: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionNameParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    name: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionCompactParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_instructions: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionReplacementResult {
    pub cancelled: bool,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionNameResult {
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompaction {
    pub summary: String,
    pub first_kept_entry_id: String,
    pub tokens_before: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionCompactionResult {
    pub result: SessionCompaction,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReloadResult {
    pub resources: Vec<ResourceInfo>,
    pub diagnostics: Vec<DiagnosticInfo>,
    pub resource_total: u64,
    pub resources_truncated: bool,
    pub diagnostic_total: u64,
    pub diagnostics_truncated: bool,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TreeNodeKind {
    Message,
    ThinkingLevelChange,
    ModelChange,
    Compaction,
    BranchSummary,
    Custom,
    CustomMessage,
    Label,
    SessionInfo,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TreeNodeRole {
    User,
    Assistant,
    Tool,
    System,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TreeDisplayClass {
    Content,
    Tool,
    Metadata,
    Structural,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TreeNodeState {
    Error,
    Aborted,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub depth: usize,
    pub kind: TreeNodeKind,
    pub role: Option<TreeNodeRole>,
    pub display_class: TreeDisplayClass,
    pub state: Option<TreeNodeState>,
    pub label: Option<String>,
    pub timestamp: Option<String>,
    pub summary: String,
    pub has_children: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTree {
    pub nodes: Vec<TreeNode>,
    pub leaf_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeParams<'a> {
    instance_id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigateParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    target_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    summarize: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_instructions: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replace_instructions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeActionParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    entry_id: &'a str,
}

#[derive(Clone, Debug, Default)]
pub struct NavigateOptions<'a> {
    pub summarize: bool,
    pub custom_instructions: Option<&'a str>,
    pub replace_instructions: bool,
    pub label: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNavigateResult {
    pub cancelled: bool,
    pub aborted: Option<bool>,
    pub editor_text: Option<String>,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkResult {
    pub cancelled: bool,
    pub selected_text: Option<String>,
    pub instance: InstanceSnapshot,
}

impl DockClient {
    pub async fn session_history(
        &self,
        instance_id: &str,
        before_entry_id: Option<&str>,
        limit: u16,
    ) -> Result<(SessionHistoryPage, String)> {
        if limit == 0 || limit > 50 {
            return Err(protocol("session history limit must be between 1 and 50"));
        }
        let (page, epoch): (SessionHistoryPage, String) = self
            .request_with_host_epoch(
                "session.history",
                &SessionHistoryParams {
                    instance_id,
                    before_entry_id,
                    limit,
                },
                SESSION_HISTORY_CAPABILITIES,
                None,
            )
            .await?;
        validate_session_history_page(&page, instance_id, before_entry_id)?;
        Ok((page, epoch))
    }

    /// Read text/tool content and image references; only explicitly missing support uses the legacy view.
    pub async fn conversation_history(
        &self,
        instance_id: &str,
        cursor: Option<&str>,
        limit: u16,
        context: &mut ConversationReadContext,
    ) -> Result<(ConversationHistoryPage, String)> {
        if limit == 0 || limit > 50 {
            return Err(protocol(
                "conversation history limit must be between 1 and 50",
            ));
        }
        let mut params = ConversationHistoryParams {
            instance_id,
            cursor,
            limit,
            view: (context.view != Some(ConversationReadView::Legacy)).then_some("references"),
        };
        let result = self
            .request_with_host_epoch(
                "conversation.history",
                &params,
                if params.view.is_some() {
                    CONVERSATION_REFERENCES
                } else {
                    CONVERSATION_CAPABILITIES
                },
                None,
            )
            .await;
        let (page, epoch): (ConversationHistoryPage, String) = match result {
            Err(error) if context.view.is_none() && missing_reference_view(&error) => {
                context.view = Some(ConversationReadView::Legacy);
                params.view = None;
                self.request_with_host_epoch(
                    "conversation.history",
                    &params,
                    CONVERSATION_CAPABILITIES,
                    None,
                )
                .await?
            }
            result => result?,
        };
        validate_history_page(&page, instance_id)?;
        context.view.get_or_insert(ConversationReadView::References);
        Ok((page, epoch))
    }

    /// Complete a record without downloading its images on reference-capable Hosts.
    pub async fn conversation_content(
        &self,
        instance_id: &str,
        content_ref: &str,
        cursor: Option<&str>,
        context: &mut ConversationReadContext,
    ) -> Result<(ConversationContentPage, String)> {
        let mut params = ConversationContentParams {
            instance_id,
            content_ref,
            cursor,
            view: (context.view != Some(ConversationReadView::Legacy)).then_some("references"),
        };
        let result = self
            .request_with_host_epoch(
                "conversation.content",
                &params,
                if params.view.is_some() {
                    CONVERSATION_REFERENCES
                } else {
                    CONVERSATION_CAPABILITIES
                },
                None,
            )
            .await;
        let (page, epoch): (ConversationContentPage, String) = match result {
            Err(error) if context.view.is_none() && missing_reference_view(&error) => {
                context.view = Some(ConversationReadView::Legacy);
                params.view = None;
                self.request_with_host_epoch(
                    "conversation.content",
                    &params,
                    CONVERSATION_CAPABILITIES,
                    None,
                )
                .await?
            }
            result => result?,
        };
        validate_content_page(&page, instance_id, content_ref)?;
        context.view.get_or_insert(ConversationReadView::References);
        Ok((page, epoch))
    }

    pub(crate) async fn hydrate_content(
        &self,
        instance_id: &str,
        host_epoch: &str,
        generation: u64,
        revision: &str,
        content_ref: &str,
        total_blocks: usize,
        mut context: ConversationReadContext,
    ) -> Result<Vec<crate::ContentBlock>> {
        if context.view == Some(ConversationReadView::References) {
            if let Some(blocks) = self
                .read_content_stream(
                    instance_id,
                    host_epoch,
                    generation,
                    revision,
                    content_ref,
                    total_blocks,
                )
                .await?
            {
                return Ok(blocks);
            }
            // Only an explicit missing optional capability before readiness reaches
            // this old page path. The descriptor's selected view remains fixed.
        }
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        let mut assembler = ContentAssembler::default();
        loop {
            let (page, epoch) = self
                .conversation_content(instance_id, content_ref, cursor.as_deref(), &mut context)
                .await?;
            if epoch != host_epoch
                || page.runtime_generation != generation
                || page.revision != revision
            {
                return Err(protocol(
                    "conversation content changed while a complete entry was loading",
                ));
            }
            for chunk in page.chunks {
                assembler.push(chunk)?;
            }
            if page.complete {
                break;
            }
            let next = page
                .next_cursor
                .ok_or_else(|| protocol("incomplete conversation content omitted its cursor"))?;
            if !seen.insert(next.clone()) {
                return Err(protocol("conversation content cursor repeated"));
            }
            cursor = Some(next);
        }
        assembler.finish(total_blocks)
    }

    /// Reads one page, newest conversation first. `cursor` is the previous
    /// page's `next_cursor`; omit it for the first page.
    pub async fn session_inventory(
        &self,
        cwd: &str,
        scope: SessionScope,
        target_host_id: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<SessionInventoryResult> {
        let (wire, host_epoch): (SessionInventoryWireResult, String) = self
            .request_with_host_epoch(
                "session.inventory",
                &SessionInventoryParams {
                    cwd,
                    scope,
                    host_id: target_host_id,
                    cursor,
                },
                if cursor.is_some() {
                    SESSION_INVENTORY_PAGES
                } else {
                    SESSION_INVENTORY
                },
                None,
            )
            .await?;
        if wire.query.cwd != cwd || wire.query.scope != scope {
            return Err(protocol(
                "session inventory did not correlate to the requested Machine and scope",
            ));
        }
        validate_session_infos(&wire.sessions)?;
        if wire.diagnostics.iter().any(|diagnostic| {
            diagnostic.message.len() > 4_000
                || diagnostic
                    .path
                    .as_ref()
                    .is_some_and(|path| path.len() > 16_384)
        }) {
            return Err(protocol(
                "session inventory diagnostics exceeded their bounds",
            ));
        }
        Ok(SessionInventoryResult {
            sessions: wire.sessions,
            total: wire.total,
            truncated: wire.truncated,
            incomplete: wire.incomplete,
            diagnostics: wire.diagnostics,
            diagnostics_truncated: wire.diagnostics_truncated,
            next_cursor: wire.next_cursor,
            host_epoch,
        })
    }

    pub async fn new_session(
        &self,
        instance_id: &str,
        parent_session: Option<&str>,
        operation_id: Option<&str>,
    ) -> Result<SessionReplacementResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result = self
            .request(
                "session.new",
                &SessionNewParams {
                    operation_id,
                    instance_id,
                    parent_session,
                },
                SESSION_COMMAND_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_replacement(result, instance_id, operation_id)
    }

    pub async fn switch_session(
        &self,
        instance_id: &str,
        session_file: &str,
        continuation: Option<(&str, ProjectTrustDecision)>,
        operation_id: &str,
    ) -> Result<SessionReplacementResult> {
        let (trust_challenge_id, project_trust_decision) = continuation
            .map(|(id, decision)| (Some(id), Some(decision)))
            .unwrap_or((None, None));
        let result = self
            .request(
                "session.switch",
                &SessionSwitchParams {
                    operation_id,
                    instance_id,
                    session_file,
                    trust_challenge_id,
                    project_trust_decision,
                },
                SESSION_COMMAND_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_replacement(result, instance_id, operation_id)
    }

    pub async fn name_session(
        &self,
        instance_id: &str,
        name: &str,
        operation_id: Option<&str>,
    ) -> Result<SessionNameResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: SessionNameResult = self
            .request(
                "session.name",
                &SessionNameParams {
                    operation_id,
                    instance_id,
                    name,
                },
                SESSION_COMMAND_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_mutation_snapshot(&result.instance, instance_id, operation_id)?;
        Ok(result)
    }

    pub async fn compaction_prompts(
        &self,
        instance_id: &str,
    ) -> Result<CompactionPromptTemplatesResult> {
        self.request(
            "session.compaction.prompts",
            &serde_json::json!({ "instanceId": instance_id }),
            crate::capabilities::COMPACTION_PROMPTS,
            None,
        )
        .await
    }

    pub async fn compact_session(
        &self,
        instance_id: &str,
        custom_instructions: Option<&str>,
        operation_id: Option<&str>,
    ) -> Result<SessionCompactionResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: SessionCompactionResult = self
            .request(
                "session.compact",
                &SessionCompactParams {
                    operation_id,
                    instance_id,
                    custom_instructions,
                },
                SESSION_COMMAND_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_mutation_snapshot(&result.instance, instance_id, operation_id)?;
        Ok(result)
    }

    pub async fn reload_session(
        &self,
        instance_id: &str,
        operation_id: Option<&str>,
    ) -> Result<SessionReloadResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: SessionReloadResult = self
            .request(
                "session.reload",
                &SessionMutationParams {
                    operation_id,
                    instance_id,
                },
                SESSION_COMMAND_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_mutation_snapshot(&result.instance, instance_id, operation_id)?;
        Ok(result)
    }

    pub async fn session_tree(&self, instance_id: &str) -> Result<(SessionTree, String)> {
        let (tree, host_epoch): (SessionTree, String) = self
            .request_with_host_epoch(
                "session.tree",
                &TreeParams { instance_id },
                SESSION_TREE_CAPABILITIES,
                None,
            )
            .await?;
        validate_tree(&tree)?;
        Ok((tree, host_epoch))
    }

    pub async fn navigate_session(
        &self,
        instance_id: &str,
        target_id: &str,
        options: NavigateOptions<'_>,
        operation_id: Option<&str>,
    ) -> Result<SessionNavigateResult> {
        if !options.summarize
            && (options.custom_instructions.is_some()
                || options.replace_instructions
                || options.label.is_some())
        {
            return Err(protocol("navigation summary options require summarize"));
        }
        if options.replace_instructions && options.custom_instructions.is_none() {
            return Err(protocol(
                "replacement instructions require custom instructions",
            ));
        }
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: SessionNavigateResult = self
            .request(
                "session.navigate",
                &NavigateParams {
                    operation_id,
                    instance_id,
                    target_id,
                    summarize: Some(options.summarize),
                    custom_instructions: options.custom_instructions,
                    replace_instructions: options.summarize.then_some(options.replace_instructions),
                    label: options.label,
                },
                SESSION_TREE_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_mutation_snapshot(&result.instance, instance_id, operation_id)?;
        Ok(result)
    }

    pub async fn fork_session(
        &self,
        instance_id: &str,
        entry_id: &str,
        operation_id: Option<&str>,
    ) -> Result<SessionForkResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: SessionForkResult = self
            .request(
                "session.fork",
                &TreeActionParams {
                    operation_id,
                    instance_id,
                    entry_id,
                },
                SESSION_TREE_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_mutation_snapshot(&result.instance, instance_id, operation_id)?;
        Ok(result)
    }

    pub async fn clone_session(
        &self,
        instance_id: &str,
        entry_id: &str,
        operation_id: Option<&str>,
    ) -> Result<SessionReplacementResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result = self
            .request(
                "session.clone",
                &TreeActionParams {
                    operation_id,
                    instance_id,
                    entry_id,
                },
                SESSION_TREE_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_replacement(result, instance_id, operation_id)
    }
}

fn validate_session_history_page(
    page: &SessionHistoryPage,
    instance_id: &str,
    before_entry_id: Option<&str>,
) -> Result<()> {
    page.instance.validate()?;
    if page.instance.id != instance_id || page.history_revision == 0 {
        return Err(protocol("session history identity or revision was invalid"));
    }
    if page.has_earlier != page.next_before_entry_id.is_some() {
        return Err(protocol("session history continuation was inconsistent"));
    }
    if page.next_before_entry_id.as_deref()
        != page.entries.first().map(|entry| entry.entry_id.as_str())
        && page.has_earlier
    {
        return Err(protocol(
            "session history continuation did not identify its first entry",
        ));
    }
    let mut ids = HashSet::with_capacity(page.entries.len());
    if page.entries.iter().any(|entry| {
        entry.entry_id.is_empty()
            || !ids.insert(entry.entry_id.as_str())
            || before_entry_id.is_some_and(|anchor| entry.entry_id == anchor)
    }) {
        return Err(protocol(
            "session history contained invalid or repeated entries",
        ));
    }
    Ok(())
}

fn validate_history_page(page: &ConversationHistoryPage, instance_id: &str) -> Result<()> {
    page.instance.validate()?;
    if page.instance.id != instance_id
        || page.revision.is_empty()
        || page.revision.len() > 128
        || page.has_earlier != page.next_cursor.is_some()
    {
        return Err(protocol("conversation history result invariants failed"));
    }
    let mut ids = HashSet::new();
    let mut refs = HashSet::new();
    for item in &page.entries {
        if item.entry.record_id.is_empty()
            || item.entry.entry_id.is_empty()
            || item.content_ref.is_empty()
            || item.content_ref.len() > 128
            || !ids.insert(&item.entry.record_id)
            || !refs.insert(&item.content_ref)
        {
            return Err(protocol(
                "conversation history contained invalid or duplicate identities",
            ));
        }
    }
    Ok(())
}

fn validate_content_page(
    page: &ConversationContentPage,
    instance_id: &str,
    content_ref: &str,
) -> Result<()> {
    if page.instance_id != instance_id
        || page.content_ref != content_ref
        || page.runtime_generation == 0
        || page.revision.is_empty()
        || page.revision.len() > 128
        || page.complete == page.next_cursor.is_some()
        || (!page.complete && page.chunks.is_empty())
        || page.chunks.len() > 64
    {
        return Err(protocol("conversation content result invariants failed"));
    }
    Ok(())
}

fn validate_replacement(
    result: SessionReplacementResult,
    instance_id: &str,
    operation_id: &str,
) -> Result<SessionReplacementResult> {
    validate_mutation_snapshot(&result.instance, instance_id, operation_id)?;
    Ok(result)
}

fn validate_mutation_snapshot(
    instance: &InstanceSnapshot,
    instance_id: &str,
    operation_id: &str,
) -> Result<()> {
    if instance.id != instance_id {
        return Err(unknown(
            operation_id,
            "session mutation response returned a different Work",
        ));
    }
    Ok(())
}

fn validate_tree(tree: &SessionTree) -> Result<()> {
    for node in &tree.nodes {
        if node.entry_id.is_empty()
            || node.entry_id.len() > 128
            || node
                .parent_id
                .as_ref()
                .is_some_and(|parent| parent.is_empty() || parent.len() > 128)
            || node.depth > 100_000
        {
            return Err(protocol(
                "session tree identity or depth exceeded protocol bounds",
            ));
        }
    }
    Ok(())
}

fn missing_reference_view(error: &ClientError) -> bool {
    error.missing_capability(&[CONVERSATION_REFERENCES_V1])
}

#[derive(Default)]
struct ContentAssembler {
    blocks: HashMap<usize, PartialBlock>,
    next_block: usize,
}

#[derive(Clone)]
enum PartialBlock {
    ImageRef {
        mime: String,
        content_ref: Option<String>,
        file_id: Option<String>,
    },
    Text {
        kind: bool,
        data: String,
        complete: bool,
    },
    Image {
        mime: String,
        data: String,
        complete: bool,
    },
    ToolCall {
        id: String,
        name: String,
        data: String,
        complete: bool,
    },
    ToolResult {
        id: String,
        name: String,
        data: String,
        complete: bool,
        is_error: bool,
        published_file: Option<PublishedFileDto>,
        omitted: Vec<String>,
        nested_calls: Option<serde_json::Value>,
    },
    Omitted {
        kind: String,
        description: String,
    },
}

impl ContentAssembler {
    fn push(&mut self, chunk: ConversationContentChunk) -> Result<()> {
        let index = match &chunk {
            ConversationContentChunk::Text { block_index, .. }
            | ConversationContentChunk::Thinking { block_index, .. }
            | ConversationContentChunk::Image { block_index, .. }
            | ConversationContentChunk::ImageRef { block_index, .. }
            | ConversationContentChunk::ToolCall { block_index, .. }
            | ConversationContentChunk::ToolResult { block_index, .. }
            | ConversationContentChunk::Omitted { block_index, .. } => *block_index,
        };
        if index != self.next_block {
            return Err(protocol("conversation content blocks were not contiguous"));
        }
        match chunk {
            ConversationContentChunk::ImageRef {
                mime_type,
                content_ref,
                file_id,
                ..
            } => {
                self.blocks.insert(
                    index,
                    PartialBlock::ImageRef {
                        mime: mime_type,
                        content_ref,
                        file_id,
                    },
                );
                self.next_block += 1;
            }
            ConversationContentChunk::Text {
                text,
                offset,
                block_complete,
                ..
            } => self.push_text(index, false, text, offset, block_complete)?,
            ConversationContentChunk::Thinking {
                text,
                offset,
                block_complete,
                ..
            } => self.push_text(index, true, text, offset, block_complete)?,
            ConversationContentChunk::Image {
                mime_type,
                data,
                offset,
                block_complete,
                ..
            } => self.push_image(index, mime_type, data, offset, block_complete)?,
            ConversationContentChunk::ToolCall {
                tool_call_id,
                tool_name,
                arguments_json,
                offset,
                block_complete,
                ..
            } => self.push_tool_call(
                index,
                tool_call_id,
                tool_name,
                arguments_json,
                offset,
                block_complete,
            )?,
            ConversationContentChunk::ToolResult {
                tool_call_id,
                tool_name,
                text,
                offset,
                block_complete,
                is_error,
                published_file,
                nested_calls,
                omitted_fields,
                ..
            } => self.push_tool_result(
                index,
                tool_call_id,
                tool_name,
                text,
                offset,
                block_complete,
                is_error,
                published_file,
                nested_calls,
                omitted_fields.unwrap_or_default(),
            )?,
            ConversationContentChunk::Omitted {
                kind, description, ..
            } => {
                self.blocks
                    .insert(index, PartialBlock::Omitted { kind, description });
                self.next_block += 1;
            }
        }
        Ok(())
    }

    fn push_text(
        &mut self,
        index: usize,
        kind: bool,
        text: String,
        offset: usize,
        done: bool,
    ) -> Result<()> {
        let block = self
            .blocks
            .entry(index)
            .or_insert_with(|| PartialBlock::Text {
                kind,
                data: String::new(),
                complete: false,
            });
        match block {
            PartialBlock::Text {
                kind: expected,
                data,
                complete,
            } if *expected == kind && !*complete && utf16_len(data) == offset => {
                data.push_str(&text);
                *complete = done;
                if done {
                    self.next_block += 1;
                }
                Ok(())
            }
            _ => Err(protocol("conversation text chunk continuity failed")),
        }
    }
    fn push_image(
        &mut self,
        index: usize,
        mime: String,
        text: String,
        offset: usize,
        done: bool,
    ) -> Result<()> {
        if !valid_image_mime_type(&mime) {
            return Err(protocol("conversation image MIME type was invalid"));
        }
        let block = self
            .blocks
            .entry(index)
            .or_insert_with(|| PartialBlock::Image {
                mime: mime.clone(),
                data: String::new(),
                complete: false,
            });
        match block {
            PartialBlock::Image {
                mime: expected,
                data,
                complete,
            } if *expected == mime && !*complete && utf16_len(data) == offset => {
                if data.len().saturating_add(text.len())
                    > MAX_CONVERSATION_IMAGE_BYTES.div_ceil(3) * 4
                {
                    return Err(protocol("conversation image exceeded its protocol bound"));
                }
                data.push_str(&text);
                *complete = done;
                if done {
                    self.next_block += 1;
                }
                Ok(())
            }
            _ => Err(protocol("conversation image chunk continuity failed")),
        }
    }
    fn push_tool_call(
        &mut self,
        index: usize,
        id: String,
        name: String,
        text: String,
        offset: usize,
        done: bool,
    ) -> Result<()> {
        let block = self
            .blocks
            .entry(index)
            .or_insert_with(|| PartialBlock::ToolCall {
                id: id.clone(),
                name: name.clone(),
                data: String::new(),
                complete: false,
            });
        match block {
            PartialBlock::ToolCall {
                id: expected_id,
                name: expected_name,
                data,
                complete,
            } if *expected_id == id
                && *expected_name == name
                && !*complete
                && utf16_len(data) == offset =>
            {
                data.push_str(&text);
                *complete = done;
                if done {
                    self.next_block += 1;
                }
                Ok(())
            }
            _ => Err(protocol("conversation tool-call chunk continuity failed")),
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn push_tool_result(
        &mut self,
        index: usize,
        id: String,
        name: String,
        text: String,
        offset: usize,
        done: bool,
        is_error: bool,
        published_file: Option<PublishedFileDto>,
        nested_calls: Option<serde_json::Value>,
        omitted: Vec<String>,
    ) -> Result<()> {
        let block = self
            .blocks
            .entry(index)
            .or_insert_with(|| PartialBlock::ToolResult {
                id: id.clone(),
                name: name.clone(),
                data: String::new(),
                complete: false,
                is_error,
                published_file: published_file.clone(),
                omitted: omitted.clone(),
                nested_calls: None,
            });
        match block {
            PartialBlock::ToolResult {
                id: expected_id,
                name: expected_name,
                data,
                complete,
                is_error: expected_error,
                published_file: expected_published_file,
                omitted: expected_omitted,
                nested_calls: received_calls,
            } if *expected_id == id
                && *expected_name == name
                && *expected_error == is_error
                && *expected_published_file == published_file
                && *expected_omitted == omitted
                && !*complete
                && utf16_len(data) == offset =>
            {
                data.push_str(&text);
                *complete = done;
                if nested_calls.is_some() {
                    *received_calls = nested_calls;
                }
                if done {
                    self.next_block += 1;
                }
                Ok(())
            }
            _ => Err(protocol("conversation tool-result chunk continuity failed")),
        }
    }

    fn finish(mut self, total: usize) -> Result<Vec<crate::ContentBlock>> {
        if self.next_block != total || self.blocks.len() != total {
            return Err(protocol(
                "conversation content completed with a mismatched block count",
            ));
        }
        let mut output = Vec::with_capacity(total);
        for index in 0..total {
            let block = self
                .blocks
                .remove(&index)
                .ok_or_else(|| protocol("conversation content omitted a block"))?;
            output.push(match block {
                PartialBlock::ImageRef {
                    mime,
                    content_ref,
                    file_id,
                } => crate::ContentBlock::Image {
                    mime_type: mime,
                    content_ref,
                    file_id,
                    data: None,
                },
                PartialBlock::Text {
                    kind: false,
                    data,
                    complete: true,
                } => crate::ContentBlock::Text { text: data },
                PartialBlock::Text {
                    kind: true,
                    data,
                    complete: true,
                } => crate::ContentBlock::Thinking { text: data },
                PartialBlock::Image {
                    mime,
                    data,
                    complete: true,
                } => {
                    decode_canonical_base64(
                        &data,
                        MAX_CONVERSATION_IMAGE_BYTES,
                        "conversation image data",
                    )?;
                    crate::ContentBlock::Image {
                        mime_type: mime,
                        content_ref: None,
                        data: Some(data),
                        file_id: None,
                    }
                }
                PartialBlock::ToolCall {
                    id,
                    name,
                    data,
                    complete: true,
                } => crate::ContentBlock::ToolCall {
                    tool_call_id: id,
                    tool_name: name,
                    args: serde_json::from_str(&data)
                        .map_err(|_| protocol("conversation tool arguments were not valid JSON"))?,
                    omitted_fields: Vec::new(),
                },
                PartialBlock::ToolResult {
                    id,
                    name,
                    data,
                    complete: true,
                    is_error,
                    published_file,
                    omitted,
                    nested_calls,
                } => crate::ContentBlock::ToolResult {
                    tool_call_id: id,
                    tool_name: name,
                    text: data,
                    is_error,
                    published_file,
                    presentation: None,
                    nested_calls,
                    omitted_fields: omitted,
                },
                PartialBlock::Omitted { kind, description } => {
                    crate::ContentBlock::Omitted { kind, description }
                }
                _ => {
                    return Err(protocol(
                        "conversation content declared completion before a block completed",
                    ));
                }
            });
        }
        Ok(output)
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
fn validate_session_infos(sessions: &[SessionInfo]) -> Result<()> {
    for session in sessions {
        if session.session_id.is_empty()
            || session.session_id.len() > 128
            || session.session_file.is_empty()
            || session.session_file.len() > 16_384
            || session.cwd.is_empty()
            || session.cwd.len() > 16_384
        {
            return Err(protocol("session list identity exceeded protocol bounds"));
        }
    }
    Ok(())
}

fn protocol(message: &str) -> ClientError {
    ClientError::Protocol(message.into())
}
fn unknown(operation_id: &str, message: &str) -> ClientError {
    ClientError::EffectUnknown {
        operation_id: operation_id.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_prompts_preserve_all_four_strings_without_snapshot() {
        let wire = serde_json::json!({
            "system": "系统\n完整文本", "summarize": "first summary",
            "update": "update summary", "turnPrefix": "prefix\n"
        });
        let result: CompactionPromptTemplatesResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(), wire);
        let mut missing = wire.clone();
        missing.as_object_mut().unwrap().remove("turnPrefix");
        assert!(serde_json::from_value::<CompactionPromptTemplatesResult>(missing).is_err());
        let mut invalid = wire;
        invalid["system"] = serde_json::json!(123);
        assert!(serde_json::from_value::<CompactionPromptTemplatesResult>(invalid).is_err());
    }

    #[test]
    fn saved_session_inventory_targets_the_selected_machine() {
        let request = serde_json::to_value(SessionInventoryParams {
            cwd: "C:\\Users\\alu",
            scope: SessionScope::All,
            host_id: Some("subhost-a"),
            cursor: Some("next-page"),
        })
        .unwrap();
        assert_eq!(
            request,
            serde_json::json!({
                "cwd": "C:\\Users\\alu",
                "scope": "all",
                "hostId": "subhost-a",
                "cursor": "next-page"
            })
        );
    }

    #[test]
    fn content_assembler_rejects_non_contiguous_offsets() {
        let mut assembler = ContentAssembler::default();
        assembler
            .push(ConversationContentChunk::Text {
                block_index: 0,
                text: "abc".into(),
                offset: 0,
                block_complete: false,
            })
            .unwrap();
        assert!(
            assembler
                .push(ConversationContentChunk::Text {
                    block_index: 0,
                    text: "x".into(),
                    offset: 2,
                    block_complete: true
                })
                .is_err()
        );
    }

    #[test]
    fn content_offsets_use_protocol_utf16_units() {
        let mut assembler = ContentAssembler::default();
        assembler
            .push(ConversationContentChunk::Text {
                block_index: 0,
                text: "阿😀".into(),
                offset: 0,
                block_complete: false,
            })
            .unwrap();
        assembler
            .push(ConversationContentChunk::Text {
                block_index: 0,
                text: "露".into(),
                offset: 3,
                block_complete: true,
            })
            .unwrap();
        assert!(
            matches!(&assembler.finish(1).unwrap()[0], crate::ContentBlock::Text { text } if text == "阿😀露")
        );
    }

    // Card #350 review: a codemode result's calls come with the last piece of its full content.
    #[test]
    fn a_tool_result_read_in_pieces_keeps_the_calls_sent_with_its_last_piece() {
        let calls = serde_json::json!({
            "calls": [{"toolName": "mcp__harbor__echo", "argumentsJson": "{\"text\":\"lantern\"}", "status": "ok", "durationMs": 12}],
            "complete": true
        });
        let piece = |text: &str, offset: usize, last: bool| {
            let mut value = serde_json::json!({
                "type": "tool_result", "blockIndex": 0, "toolCallId": "script", "toolName": "codemode",
                "text": text, "offset": offset, "blockComplete": last, "isError": false
            });
            if last {
                value["nestedCalls"] = calls.clone();
            }
            serde_json::from_value::<ConversationContentChunk>(value).unwrap()
        };
        let mut assembler = ContentAssembler::default();
        assembler
            .push(piece("Script completed\n", 0, false))
            .unwrap();
        assembler
            .push(piece("Output:\nharbor echoed lantern", 17, true))
            .unwrap();
        assert!(matches!(
            &assembler.finish(1).unwrap()[0],
            crate::ContentBlock::ToolResult { text, nested_calls: Some(received), .. }
                if text == "Script completed\nOutput:\nharbor echoed lantern" && *received == calls
        ));
    }

    #[test]
    fn content_assembler_preserves_complete_image_bytes() {
        let mut assembler = ContentAssembler::default();
        assembler
            .push(ConversationContentChunk::Image {
                block_index: 0,
                mime_type: "image/png".into(),
                data: "aGVs".into(),
                offset: 0,
                block_complete: false,
            })
            .unwrap();
        assembler
            .push(ConversationContentChunk::Image {
                block_index: 0,
                mime_type: "image/png".into(),
                data: "bG8=".into(),
                offset: 4,
                block_complete: true,
            })
            .unwrap();
        assert!(matches!(
            &assembler.finish(1).unwrap()[0],
            crate::ContentBlock::Image { mime_type, data: Some(data), .. }
                if mime_type == "image/png" && data == "aGVsbG8="
        ));
    }

    #[test]
    fn content_assembler_builds_complete_typed_blocks() {
        let mut assembler = ContentAssembler::default();
        assembler
            .push(ConversationContentChunk::Text {
                block_index: 0,
                text: "hello".into(),
                offset: 0,
                block_complete: true,
            })
            .unwrap();
        assembler
            .push(ConversationContentChunk::ToolCall {
                block_index: 1,
                tool_call_id: "call".into(),
                tool_name: "read".into(),
                arguments_json: "{\"path\":\"a\"}".into(),
                offset: 0,
                block_complete: true,
            })
            .unwrap();
        assembler
            .push(
                serde_json::from_value(serde_json::json!({
                    "type": "image_ref", "blockIndex": 2, "mimeType": "image/png",
                    "contentRef": "original-image", "fileId": "permanent-attachment"
                }))
                .unwrap(),
            )
            .unwrap();
        let blocks = assembler.finish(3).unwrap();
        assert!(
            matches!(&blocks[2], crate::ContentBlock::Image { mime_type, content_ref: Some(reference), file_id: Some(file), data: None }
            if mime_type == "image/png" && reference == "original-image" && file == "permanent-attachment")
        );
        assert!(matches!(&blocks[0], crate::ContentBlock::Text { text } if text == "hello"));
        assert!(
            matches!(&blocks[1], crate::ContentBlock::ToolCall { tool_name, .. } if tool_name == "read")
        );
    }

    #[test]
    fn saved_session_inventory_accepts_additive_host_metadata() {
        let value = serde_json::json!({
            "sessions": [{
                "sessionId": "saved-session",
                "sessionFile": "/sessions/saved.jsonl",
                "name": "Saved",
                "firstUserMessage": "continue",
                "cwd": "/workspace",
                "updatedAt": "2026-09-05T00:00:00.000Z",
                "lastActivityAt": "2026-09-04T00:00:00.000Z",
                "costTotal": 1.25,
                "futureSessionField": true
            }],
            "query": {
                "cwd": "/workspace",
                "scope": "all",
                "hostId": "main-host",
                "futureQueryField": true
            },
            "total": 1,
            "truncated": false,
            "incomplete": true,
            "diagnostics": [{
                "message": "one location was unavailable",
                "path": "/sessions/missing",
                "futureDiagnosticField": true
            }],
            "diagnosticsTruncated": false,
            "nextCursor": "page-2",
            "futureResultField": true
        });
        let parsed = serde_json::from_value::<SessionInventoryWireResult>(value).unwrap();
        assert_eq!(parsed.query.cwd, "/workspace");
        assert_eq!(parsed.query.scope, SessionScope::All);
        assert_eq!(parsed.sessions[0].session_id, "saved-session");
        assert_eq!(
            parsed.sessions[0].last_activity_at.as_deref(),
            Some("2026-09-04T00:00:00.000Z")
        );
        assert_eq!(parsed.sessions[0].cost_total, Some(1.25));
        assert_eq!(parsed.next_cursor.as_deref(), Some("page-2"));
        assert_eq!(
            parsed.diagnostics[0].message,
            "one location was unavailable"
        );

        assert!(
            serde_json::from_value::<SessionInventoryWireResult>(serde_json::json!({
                "sessions": [], "query": {"cwd": "/workspace", "scope": "future"},
                "total": 0, "truncated": false
            }))
            .is_err()
        );
    }

    #[test]
    fn content_chunk_parser_uses_protocol_camel_case_fields() {
        let value = serde_json::json!({
            "type": "tool_result",
            "blockIndex": 2,
            "toolCallId": "call",
            "toolName": "bash",
            "text": "ok",
            "offset": 0,
            "blockComplete": true,
            "isError": false,
            "publishedFile": {
                "presentation": "image",
                "fileRef": "file-1",
                "name": "result.png",
                "sizeBytes": 5,
                "mediaType": "image/png"
            }
        });
        assert!(matches!(
            serde_json::from_value::<ConversationContentChunk>(value).unwrap(),
            ConversationContentChunk::ToolResult {
                block_index: 2,
                block_complete: true,
                published_file: Some(PublishedFileDto { file_ref, .. }),
                ..
            } if file_ref == "file-1"
        ));
    }
}

#[derive(Clone, Default)]
pub struct SessionTokenState {
    registry: Arc<Mutex<SessionTokenRegistry>>,
}

#[derive(Default)]
struct SessionTokenRegistry {
    next_request: u64,
    tokens: HashMap<String, SessionTokenBinding>,
}

struct SessionTokenBinding {
    request_id: u64,
    connection_id: String,
    selection_generation: u64,
    scope: SessionTokenScope,
    session_file: String,
}

#[derive(Clone)]
pub enum SessionTokenScope {
    Work {
        host_epoch: String,
        instance_id: String,
        runtime_generation: u64,
    },
    Machine {
        machine_host_id: String,
        host_epoch: String,
    },
}

pub fn begin_session_token_request(state: &SessionTokenState) -> Result<u64> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| ClientError::Protocol("Session token registry is unavailable".into()))?;
    registry.next_request = registry
        .next_request
        .checked_add(1)
        .ok_or_else(|| ClientError::Protocol("Session token request counter overflowed".into()))?;
    Ok(registry.next_request)
}
pub fn publish_session_tokens(
    state: &SessionTokenState,
    request_id: u64,
    connection_id: &str,
    selection_generation: u64,
    scope: SessionTokenScope,
    tokens: HashMap<String, String>,
) -> Result<()> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| ClientError::Protocol("Session token registry is unavailable".into()))?;
    for (token, session_file) in tokens {
        registry.tokens.insert(
            token,
            SessionTokenBinding {
                request_id,
                connection_id: connection_id.to_owned(),
                selection_generation,
                scope: scope.clone(),
                session_file,
            },
        );
    }
    let oldest_retained = registry.next_request.saturating_sub(63);
    registry
        .tokens
        .retain(|_, binding| binding.request_id >= oldest_retained);
    Ok(())
}
pub fn resolve_work_session_token(
    state: &SessionTokenState,
    connection_id: &str,
    selection_generation: u64,
    instance_id: &str,
    host_epoch: &str,
    runtime_generation: u64,
    token: &str,
) -> Result<String> {
    let registry = state
        .registry
        .lock()
        .map_err(|_| ClientError::Protocol("Session token registry is unavailable".into()))?;
    let binding = registry
        .tokens
        .get(token)
        .ok_or_else(|| ClientError::Protocol("Session token is invalid or expired".into()))?;
    let scope_matches = matches!(
        &binding.scope,
        SessionTokenScope::Work {
            host_epoch: bound_epoch,
            instance_id: bound_instance,
            runtime_generation: bound_generation,
        } if bound_epoch == host_epoch
            && bound_instance == instance_id
            && *bound_generation == runtime_generation
    );
    if binding.connection_id != connection_id
        || binding.selection_generation != selection_generation
        || !scope_matches
    {
        return Err(ClientError::Protocol(
            "Session token belongs to a stale list result".into(),
        ));
    }
    Ok(binding.session_file.clone())
}
pub fn resolve_machine_session_token(
    state: &SessionTokenState,
    connection_id: &str,
    selection_generation: u64,
    machine_host_id: &str,
    token: &str,
) -> Result<(String, String)> {
    let registry = state
        .registry
        .lock()
        .map_err(|_| ClientError::Protocol("Session token registry is unavailable".into()))?;
    let binding = registry
        .tokens
        .get(token)
        .ok_or_else(|| ClientError::Protocol("Session token is invalid or expired".into()))?;
    let bound_host_epoch = match &binding.scope {
        SessionTokenScope::Machine {
            machine_host_id: bound_machine,
            host_epoch,
        } if bound_machine == machine_host_id => Some(host_epoch),
        _ => None,
    };
    if binding.connection_id != connection_id
        || binding.selection_generation != selection_generation
        || bound_host_epoch.is_none()
    {
        return Err(ClientError::Protocol(
            "Session token belongs to another Host or Machine".into(),
        ));
    }
    Ok((
        binding.session_file.clone(),
        bound_host_epoch.expect("scope was checked").clone(),
    ))
}
impl SessionTokenState {
    pub fn clear(&self) {
        self.registry.lock().unwrap().tokens.clear();
    }
}

#[cfg(test)]
mod inventory_session_token_is_bound_to_main_host_generation_and_machine_test {
    use super::*;
    #[test]
    fn inventory_session_token_is_bound_to_main_host_generation_and_machine() {
        let state = SessionTokenState::default();
        let request = begin_session_token_request(&state).unwrap();
        publish_session_tokens(
            &state,
            request,
            "main-host",
            4,
            SessionTokenScope::Machine {
                machine_host_id: "windows-subhost".into(),
                host_epoch: "main-epoch".into(),
            },
            HashMap::from([("safe-token".into(), "C:\\sessions\\private.jsonl".into())]),
        )
        .unwrap();
        assert_eq!(
            resolve_machine_session_token(&state, "main-host", 4, "windows-subhost", "safe-token",)
                .unwrap(),
            ("C:\\sessions\\private.jsonl".into(), "main-epoch".into(),)
        );
        assert!(
            resolve_machine_session_token(&state, "main-host", 4, "another-machine", "safe-token",)
                .is_err()
        );
        assert!(
            resolve_machine_session_token(
                &state,
                "another-main",
                4,
                "windows-subhost",
                "safe-token",
            )
            .is_err()
        );
        assert!(
            resolve_machine_session_token(&state, "main-host", 5, "windows-subhost", "safe-token",)
                .is_err()
        );
        assert!(
            resolve_work_session_token(&state, "main-host", 4, "work", "epoch", 1, "safe-token",)
                .is_err()
        );
    }
}

#[cfg(test)]
mod older_session_list_completion_does_not_invalidate_newer_tokens_test {
    use super::*;
    #[test]
    fn older_session_list_completion_does_not_invalidate_newer_tokens() {
        let state = SessionTokenState::default();
        let older = begin_session_token_request(&state).unwrap();
        let newer = begin_session_token_request(&state).unwrap();
        let scope = SessionTokenScope::Work {
            host_epoch: "epoch".into(),
            instance_id: "work".into(),
            runtime_generation: 2,
        };
        publish_session_tokens(
            &state,
            newer,
            "host-a",
            7,
            scope.clone(),
            HashMap::from([("new-token".into(), "C:\\sessions\\new.jsonl".into())]),
        )
        .unwrap();
        publish_session_tokens(
            &state,
            older,
            "host-a",
            7,
            scope,
            HashMap::from([("old-token".into(), "/sessions/old.jsonl".into())]),
        )
        .unwrap();
        assert_eq!(
            resolve_work_session_token(&state, "host-a", 7, "work", "epoch", 2, "new-token",)
                .unwrap(),
            "C:\\sessions\\new.jsonl"
        );
        assert!(
            resolve_work_session_token(&state, "host-b", 7, "work", "epoch", 2, "new-token",)
                .is_err()
        );
        assert!(
            resolve_work_session_token(&state, "host-a", 8, "work", "epoch", 2, "new-token",)
                .is_err()
        );
    }
}

/// How an accepted Session result affects the currently observed content.
/// The Host result is authoritative; display application cannot undo its success.
pub trait SessionChange {
    fn replacement(&self) -> Option<(&InstanceSnapshot, bool)>;
}
impl SessionChange for SessionReplacementResult {
    fn replacement(&self) -> Option<(&InstanceSnapshot, bool)> {
        (!self.cancelled).then_some((&self.instance, false))
    }
}
impl SessionChange for SessionForkResult {
    fn replacement(&self) -> Option<(&InstanceSnapshot, bool)> {
        (!self.cancelled).then_some((&self.instance, false))
    }
}
impl SessionChange for SessionNavigateResult {
    fn replacement(&self) -> Option<(&InstanceSnapshot, bool)> {
        (!self.cancelled).then_some((&self.instance, true))
    }
}
impl SessionChange for SessionReloadResult {
    fn replacement(&self) -> Option<(&InstanceSnapshot, bool)> {
        Some((&self.instance, false))
    }
}
