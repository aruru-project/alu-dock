use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    ClientError, DiagnosticInfo, DockClient, HistoryRecord, InstanceLifecycle, InstanceSnapshot,
    ProjectTrustDecision, PublishedFileDto, ResourceInfo, Result,
    capabilities::{
        CONVERSATION_CONTENT as CONVERSATION_CAPABILITIES,
        CONVERSATION_IMAGES as CONVERSATION_IMAGE_CAPABILITIES,
        SESSION_COMMANDS as SESSION_COMMAND_CAPABILITIES,
        SESSION_CORE_REQUIRED as SESSION_CORE_CAPABILITIES,
        SESSION_HISTORY as SESSION_HISTORY_CAPABILITIES, SESSION_TREE as SESSION_TREE_CAPABILITIES,
    },
    client::{ResponseEnvelope, maximum_line_bytes, response_result, validate_response_envelope},
    tls::{read_json_line, write_json_line},
    wire::decode_canonical_base64,
};

pub const MAX_CONVERSATION_IMAGE_BYTES: usize = 20 * 1_024 * 1_024;
const MAX_CONVERSATION_IMAGE_CHUNK_BYTES: usize = 512 * 1_024;
const CONVERSATION_IMAGE_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionScope {
    Cwd,
    All,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionInfo {
    pub session_id: String,
    pub session_file: String,
    pub name: Option<String>,
    pub cwd: String,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionsWireResult {
    sessions: Vec<SessionInfo>,
    total: u64,
    truncated: bool,
}

#[derive(Clone, Debug)]
pub struct SessionListResult {
    pub sessions: Vec<SessionInfo>,
    pub total: u64,
    pub truncated: bool,
    pub host_epoch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationHistoryEntry {
    pub entry: HistoryRecord,
    pub content_ref: String,
    pub content_complete: bool,
    pub total_blocks: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationHistoryPage {
    pub instance: InstanceSnapshot,
    pub revision: String,
    pub entries: Vec<ConversationHistoryEntry>,
    pub has_earlier: bool,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
        omitted_fields: Option<Vec<String>>,
    },
    Omitted {
        block_index: usize,
        kind: String,
        description: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationContentPage {
    pub instance_id: String,
    pub runtime_generation: u64,
    pub revision: String,
    pub content_ref: String,
    pub chunks: Vec<ConversationContentChunk>,
    pub complete: bool,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPreviewPage {
    pub records: Vec<HistoryRecord>,
    pub incomplete_entry_ids: Vec<String>,
    pub revision: String,
    pub has_earlier: bool,
    pub next_cursor: Option<String>,
    pub instance: InstanceSnapshot,
    pub host_epoch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedConversationEntry {
    pub record: HistoryRecord,
    pub revision: String,
    pub instance: InstanceSnapshot,
    pub host_epoch: String,
}

#[derive(Clone, Debug)]
pub struct ConversationImageBytes {
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub chunks: u64,
    pub size_bytes: u64,
    pub sha256: String,
    pub host_epoch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationImageRequest<'a> {
    kind: &'static str,
    version: u8,
    request_id: &'a str,
    #[serde(rename = "type")]
    request_type: &'static str,
    params: ConversationImageParams<'a>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationImageParams<'a> {
    instance_id: &'a str,
    content_ref: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum ConversationImageFrame {
    #[serde(rename = "conversation_image_ready")]
    Ready {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "contentRef")]
        content_ref: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        sha256: String,
    },
    #[serde(rename = "conversation_image_chunk")]
    Chunk {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "contentRef")]
        content_ref: String,
        index: u64,
        data: String,
    },
    #[serde(rename = "conversation_image_complete")]
    Complete {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "contentRef")]
        content_ref: String,
        chunks: u64,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        sha256: String,
    },
    #[serde(rename = "conversation_image_error")]
    Error {
        version: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "hostEpoch")]
        host_epoch: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "contentRef")]
        content_ref: String,
        error: ConversationImageError,
    },
}

#[derive(Debug, Deserialize)]
struct ConversationImageError {
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationHistoryParams<'a> {
    instance_id: &'a str,
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
    content_ref: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionListParams<'a> {
    instance_id: &'a str,
    scope: SessionScope,
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
#[serde(deny_unknown_fields)]
pub struct SessionReplacementResult {
    pub cancelled: bool,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionNameResult {
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCompaction {
    pub summary: String,
    pub first_kept_entry_id: String,
    pub tokens_before: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCompactionResult {
    pub result: SessionCompaction,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TreeNodeRole {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TreeDisplayClass {
    Content,
    Tool,
    Metadata,
    Structural,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TreeNodeState {
    Error,
    Aborted,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionNavigateResult {
    pub cancelled: bool,
    pub aborted: Option<bool>,
    pub editor_text: Option<String>,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

    pub async fn conversation_history(
        &self,
        instance_id: &str,
        cursor: Option<&str>,
        limit: u16,
    ) -> Result<(ConversationHistoryPage, String)> {
        if limit == 0 || limit > 50 {
            return Err(protocol(
                "conversation history limit must be between 1 and 50",
            ));
        }
        let (page, epoch): (ConversationHistoryPage, String) = self
            .request_with_host_epoch(
                "conversation.history",
                &ConversationHistoryParams {
                    instance_id,
                    cursor,
                    limit,
                },
                CONVERSATION_CAPABILITIES,
                None,
            )
            .await?;
        validate_history_page(&page, instance_id)?;
        Ok((page, epoch))
    }

    pub async fn conversation_content(
        &self,
        instance_id: &str,
        content_ref: &str,
        cursor: Option<&str>,
    ) -> Result<(ConversationContentPage, String)> {
        let (page, epoch): (ConversationContentPage, String) = self
            .request_with_host_epoch(
                "conversation.content",
                &ConversationContentParams {
                    instance_id,
                    content_ref,
                    cursor,
                },
                CONVERSATION_CAPABILITIES,
                None,
            )
            .await?;
        validate_content_page(&page, instance_id, content_ref)?;
        Ok((page, epoch))
    }

    pub async fn read_conversation_image(
        &self,
        instance_id: &str,
        content_ref: &str,
        expected_mime_type: &str,
    ) -> Result<ConversationImageBytes> {
        if instance_id.is_empty()
            || instance_id.len() > 128
            || content_ref.is_empty()
            || content_ref.len() > 128
            || !valid_image_mime_type(expected_mime_type)
        {
            return Err(protocol("conversation image request identity was invalid"));
        }
        let routed = self.negotiate(CONVERSATION_IMAGE_CAPABILITIES).await?;
        let endpoint_id = routed.endpoint_id;
        let route_generation = routed.route_generation;
        let mut connection = routed.connection;
        let hello = routed.hello;
        let request_id = Uuid::new_v4().to_string();
        if let Err(error) = write_json_line(
            &mut connection.stream,
            &ConversationImageRequest {
                kind: "request",
                version: 2,
                request_id: &request_id,
                request_type: "conversation.image",
                params: ConversationImageParams {
                    instance_id,
                    content_ref,
                },
            },
        )
        .await
        {
            self.router()
                .report_connection_failure(&endpoint_id, route_generation);
            return Err(error);
        }
        let result = read_conversation_image_after_request(
            &mut connection.stream,
            maximum_line_bytes(&hello),
            &request_id,
            &hello.host.host_epoch,
            instance_id,
            content_ref,
            expected_mime_type,
        )
        .await;
        if result
            .as_ref()
            .is_err_and(|error| !matches!(error, ClientError::Host { .. }))
        {
            self.router()
                .report_connection_failure(&endpoint_id, route_generation);
        } else {
            self.router().ensure_open()?;
        }
        result
    }

    pub async fn preview_conversation_page(
        &self,
        instance_id: &str,
        cursor: Option<&str>,
        limit: u16,
    ) -> Result<ConversationPreviewPage> {
        let (page, host_epoch) = self
            .conversation_history(instance_id, cursor, limit)
            .await?;
        let mut records = Vec::with_capacity(page.entries.len());
        let mut incomplete_entry_ids = Vec::new();
        for item in page.entries {
            if item.content_complete {
                if item.entry.content.len() != item.total_blocks {
                    return Err(protocol(
                        "complete conversation preview block count was inconsistent",
                    ));
                }
            } else {
                incomplete_entry_ids.push(item.entry.entry_id.clone());
            }
            records.push(item.entry);
        }
        Ok(ConversationPreviewPage {
            records,
            incomplete_entry_ids,
            revision: page.revision,
            has_earlier: page.has_earlier,
            next_cursor: page.next_cursor,
            instance: page.instance,
            host_epoch,
        })
    }

    pub async fn complete_conversation_entry(
        &self,
        instance_id: &str,
        cursor: Option<&str>,
        limit: u16,
        entry_id: &str,
        expected_revision: &str,
    ) -> Result<CompletedConversationEntry> {
        let (page, host_epoch) = self
            .conversation_history(instance_id, cursor, limit)
            .await?;
        if page.revision != expected_revision {
            return Err(protocol(
                "conversation history changed while an entry was loading",
            ));
        }
        let generation = page.instance.runtime_generation;
        let item = page
            .entries
            .iter()
            .find(|item| item.entry.entry_id == entry_id)
            .ok_or_else(|| protocol("conversation history entry was no longer on its page"))?;
        let mut record = item.entry.clone();
        if item.content_complete {
            if record.content.len() != item.total_blocks {
                return Err(protocol(
                    "complete conversation preview block count was inconsistent",
                ));
            }
        } else {
            record.content = self
                .hydrate_content(
                    instance_id,
                    &host_epoch,
                    generation,
                    expected_revision,
                    item,
                )
                .await?;
        }
        Ok(CompletedConversationEntry {
            record,
            revision: page.revision,
            instance: page.instance,
            host_epoch,
        })
    }

    async fn hydrate_content(
        &self,
        instance_id: &str,
        host_epoch: &str,
        generation: u64,
        revision: &str,
        item: &ConversationHistoryEntry,
    ) -> Result<Vec<crate::ContentBlock>> {
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        let mut assembler = ContentAssembler::default();
        loop {
            let (page, epoch) = self
                .conversation_content(instance_id, &item.content_ref, cursor.as_deref())
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
        assembler.finish(item.total_blocks)
    }

    pub async fn list_sessions(
        &self,
        instance_id: &str,
        scope: SessionScope,
    ) -> Result<SessionListResult> {
        let (wire, host_epoch): (SessionsWireResult, String) = self
            .request_with_host_epoch(
                "session.list",
                &SessionListParams { instance_id, scope },
                SESSION_CORE_CAPABILITIES,
                None,
            )
            .await?;
        if wire.sessions.len() as u64 > wire.total
            || (!wire.truncated && wire.sessions.len() as u64 != wire.total)
        {
            return Err(protocol(
                "session list completeness metadata was inconsistent",
            ));
        }
        let mut ids = HashSet::new();
        let mut files = HashSet::new();
        for session in &wire.sessions {
            if session.session_id.is_empty()
                || session.session_id.len() > 128
                || session.session_file.is_empty()
                || session.session_file.len() > 16_384
                || session.cwd.is_empty()
                || session.cwd.len() > 16_384
                || !ids.insert(&session.session_id)
                || !files.insert(&session.session_file)
            {
                return Err(protocol(
                    "session list contained invalid or duplicate identities",
                ));
            }
        }
        Ok(SessionListResult {
            sessions: wire.sessions,
            total: wire.total,
            truncated: wire.truncated,
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
        let expected = if name.is_empty() { None } else { Some(name) };
        if result.instance.name.as_deref() != expected {
            return Err(unknown(
                operation_id,
                "session name response did not prove the requested name",
            ));
        }
        Ok(result)
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
        if result.result.first_kept_entry_id.is_empty()
            || result.result.first_kept_entry_id.len() > 128
        {
            return Err(unknown(
                operation_id,
                "compaction response contained an invalid retained entry",
            ));
        }
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
        if result.resources.len() as u64 > result.resource_total
            || result.diagnostics.len() as u64 > result.diagnostic_total
            || (!result.resources_truncated
                && result.resources.len() as u64 != result.resource_total)
            || (!result.diagnostics_truncated
                && result.diagnostics.len() as u64 != result.diagnostic_total)
        {
            return Err(unknown(
                operation_id,
                "reload response completeness metadata was inconsistent",
            ));
        }
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
        if result.aborted == Some(true) && !result.cancelled
            || result.cancelled && result.editor_text.is_some()
        {
            return Err(unknown(
                operation_id,
                "navigation response state was inconsistent",
            ));
        }
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
        validate_fork_state(
            result.cancelled,
            result.selected_text.as_deref(),
            operation_id,
        )?;
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

#[allow(clippy::too_many_arguments)]
async fn read_conversation_image_after_request<R: AsyncRead + Unpin>(
    stream: &mut R,
    maximum_line_bytes: usize,
    request_id: &str,
    host_epoch: &str,
    instance_id: &str,
    content_ref: &str,
    expected_mime_type: &str,
) -> Result<ConversationImageBytes> {
    let first: Value = read_conversation_image_line(stream, maximum_line_bytes).await?;
    if first.get("kind").and_then(Value::as_str) == Some("response") {
        let response: ResponseEnvelope = serde_json::from_value(first)?;
        validate_response_envelope(&response, request_id, host_epoch)?;
        let _: Value = response_result(response, "conversation.image", None)?;
        return Err(protocol(
            "conversation image returned an ordinary success response",
        ));
    }
    let first =
        parse_conversation_image_frame(first, request_id, host_epoch, instance_id, content_ref)?;
    let (mime_type, expected_size, expected_sha256) = match first {
        ConversationImageFrame::Ready {
            mime_type,
            size_bytes,
            sha256,
            ..
        } if mime_type == expected_mime_type
            && valid_image_mime_type(&mime_type)
            && size_bytes > 0
            && size_bytes <= MAX_CONVERSATION_IMAGE_BYTES as u64
            && lowercase_sha256(&sha256) =>
        {
            (mime_type, size_bytes, sha256)
        }
        _ => {
            return Err(protocol(
                "conversation image did not begin with valid readiness",
            ));
        }
    };

    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(expected_size as usize)
        .map_err(|_| protocol("conversation image buffer could not be reserved"))?;
    let mut digest = Sha256::new();
    let mut chunks = 0_u64;
    loop {
        let raw: Value = read_conversation_image_line(stream, maximum_line_bytes).await?;
        if raw.get("kind").and_then(Value::as_str) == Some("response") {
            return Err(protocol(
                "conversation image returned an ordinary response after readiness",
            ));
        }
        match parse_conversation_image_frame(raw, request_id, host_epoch, instance_id, content_ref)?
        {
            ConversationImageFrame::Ready { .. } => {
                return Err(protocol("Host repeated conversation image readiness"));
            }
            ConversationImageFrame::Error { error, .. } => {
                return Err(conversation_image_error(error));
            }
            ConversationImageFrame::Chunk { index, data, .. } => {
                if index != chunks {
                    return Err(protocol("conversation image chunks arrived out of order"));
                }
                let chunk = decode_canonical_base64(
                    &data,
                    MAX_CONVERSATION_IMAGE_CHUNK_BYTES,
                    "conversation image data",
                )?;
                if chunk.is_empty()
                    || bytes.len().saturating_add(chunk.len()) > expected_size as usize
                {
                    return Err(protocol(
                        "conversation image bytes exceeded the declared size",
                    ));
                }
                digest.update(&chunk);
                bytes.extend_from_slice(&chunk);
                chunks += 1;
            }
            ConversationImageFrame::Complete {
                chunks: terminal_chunks,
                size_bytes,
                sha256,
                ..
            } => {
                let actual_sha256 = hex::encode(digest.finalize());
                if terminal_chunks != chunks
                    || size_bytes != bytes.len() as u64
                    || size_bytes != expected_size
                    || sha256 != expected_sha256
                    || sha256 != actual_sha256
                {
                    return Err(protocol(
                        "conversation image completion did not match the received bytes",
                    ));
                }
                require_conversation_image_end(stream).await?;
                return Ok(ConversationImageBytes {
                    mime_type,
                    bytes,
                    chunks,
                    size_bytes,
                    sha256: actual_sha256,
                    host_epoch: host_epoch.into(),
                });
            }
        }
    }
}

async fn read_conversation_image_line<T, R>(stream: &mut R, maximum_line_bytes: usize) -> Result<T>
where
    T: serde::de::DeserializeOwned,
    R: AsyncRead + Unpin,
{
    timeout(
        CONVERSATION_IMAGE_IDLE_TIMEOUT,
        read_json_line(stream, maximum_line_bytes),
    )
    .await
    .map_err(|_| protocol("conversation image read timed out"))?
}

async fn require_conversation_image_end<R: AsyncRead + Unpin>(stream: &mut R) -> Result<()> {
    let mut trailing = [0_u8; 1];
    let read = timeout(CONVERSATION_IMAGE_IDLE_TIMEOUT, stream.read(&mut trailing))
        .await
        .map_err(|_| protocol("conversation image did not close after completion"))??;
    if read != 0 {
        return Err(protocol("conversation image sent data after completion"));
    }
    Ok(())
}

fn parse_conversation_image_frame(
    raw: Value,
    request_id: &str,
    host_epoch: &str,
    instance_id: &str,
    content_ref: &str,
) -> Result<ConversationImageFrame> {
    let frame: ConversationImageFrame = serde_json::from_value(raw).map_err(|error| {
        ClientError::Protocol(format!("invalid conversation image frame: {error}"))
    })?;
    let (version, frame_request, frame_epoch, frame_instance, frame_content) = match &frame {
        ConversationImageFrame::Ready {
            version,
            request_id,
            host_epoch,
            instance_id,
            content_ref,
            ..
        }
        | ConversationImageFrame::Chunk {
            version,
            request_id,
            host_epoch,
            instance_id,
            content_ref,
            ..
        }
        | ConversationImageFrame::Complete {
            version,
            request_id,
            host_epoch,
            instance_id,
            content_ref,
            ..
        }
        | ConversationImageFrame::Error {
            version,
            request_id,
            host_epoch,
            instance_id,
            content_ref,
            ..
        } => (version, request_id, host_epoch, instance_id, content_ref),
    };
    if *version != 2
        || frame_request != request_id
        || frame_epoch != host_epoch
        || frame_instance != instance_id
        || frame_content != content_ref
    {
        return Err(protocol(
            "conversation image identity or Host state was invalid",
        ));
    }
    Ok(frame)
}

fn conversation_image_error(error: ConversationImageError) -> ClientError {
    if error.code != "image_unavailable"
        || error.message.is_empty()
        || error.message.chars().count() > 2_048
        || error.message.chars().any(char::is_control)
    {
        return protocol("conversation image returned an invalid error");
    }
    ClientError::Host {
        code: error.code,
        message: error.message,
        retryable: false,
        details: None,
    }
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
        || page.entries.len() > 50
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

fn validate_fork_state(
    cancelled: bool,
    selected_text: Option<&str>,
    operation_id: &str,
) -> Result<()> {
    if cancelled == selected_text.is_some() {
        return Err(unknown(
            operation_id,
            if cancelled {
                "cancelled fork unexpectedly returned selected text"
            } else {
                "completed fork omitted selected text"
            },
        ));
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
    instance
        .validate()
        .map_err(|error| unknown(operation_id, &error.to_string()))?;
    if instance.id != instance_id || instance.lifecycle != InstanceLifecycle::Active {
        return Err(unknown(
            operation_id,
            "session mutation response did not prove an active correlated Work",
        ));
    }
    Ok(())
}

fn validate_tree(tree: &SessionTree) -> Result<()> {
    let mut ids = HashSet::with_capacity(tree.nodes.len());
    let mut ancestors: Vec<&str> = Vec::new();
    for node in &tree.nodes {
        let role_is_stateful = matches!(
            node.role,
            Some(TreeNodeRole::Assistant | TreeNodeRole::Tool)
        );
        if node.entry_id.is_empty()
            || node.entry_id.len() > 128
            || node
                .parent_id
                .as_ref()
                .is_some_and(|parent| parent.is_empty() || parent.len() > 128)
            || node.depth > 100_000
            || !ids.insert(&node.entry_id)
            || (node.kind == TreeNodeKind::Message) != node.role.is_some()
            || (node.role == Some(TreeNodeRole::Tool)
                && node.display_class != TreeDisplayClass::Tool)
            || (node.state.is_some() && !role_is_stateful)
        {
            return Err(protocol("session tree node invariants failed"));
        }
        match node.parent_id.as_deref() {
            None if node.depth == 0 => {}
            Some(parent)
                if node.depth > 0 && ancestors.get(node.depth - 1).copied() == Some(parent) => {}
            _ => {
                return Err(protocol(
                    "session tree was not stable depth-first pre-order",
                ));
            }
        }
        ancestors.truncate(node.depth);
        ancestors.push(&node.entry_id);
    }
    for (index, node) in tree.nodes.iter().enumerate() {
        let expected_children = tree.nodes.get(index + 1).is_some_and(|next| {
            next.depth == node.depth + 1 && next.parent_id.as_deref() == Some(&node.entry_id)
        });
        if node.has_children != expected_children {
            return Err(protocol("session tree child topology was inconsistent"));
        }
    }
    if tree
        .leaf_id
        .as_ref()
        .is_some_and(|leaf_id| !ids.contains(leaf_id))
    {
        return Err(protocol("session tree leaf did not belong to the snapshot"));
    }
    Ok(())
}

#[derive(Default)]
struct ContentAssembler {
    blocks: HashMap<usize, PartialBlock>,
    next_block: usize,
}

#[derive(Clone)]
enum PartialBlock {
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
            | ConversationContentChunk::ToolCall { block_index, .. }
            | ConversationContentChunk::ToolResult { block_index, .. }
            | ConversationContentChunk::Omitted { block_index, .. } => *block_index,
        };
        if index != self.next_block {
            return Err(protocol("conversation content blocks were not contiguous"));
        }
        match chunk {
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
                } => crate::ContentBlock::ToolResult {
                    tool_call_id: id,
                    tool_name: name,
                    text: data,
                    is_error,
                    published_file,
                    presentation: None,
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
fn valid_image_mime_type(value: &str) -> bool {
    let Some(subtype) = value.strip_prefix("image/") else {
        return false;
    };
    !subtype.is_empty()
        && value.len() <= 256
        && subtype.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                )
        })
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
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn loading_conversation_image_returns_exact_streamed_bytes() {
        let sha256 = "6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d";
        let frames = concat!(
            "{\"kind\":\"conversation_image_ready\",\"version\":2,\"requestId\":\"request\",\"hostEpoch\":\"epoch\",\"instanceId\":\"work\",\"contentRef\":\"content\",\"mimeType\":\"image/png\",\"sizeBytes\":5,\"sha256\":\"$SHA\"}\n",
            "{\"kind\":\"conversation_image_chunk\",\"version\":2,\"requestId\":\"request\",\"hostEpoch\":\"epoch\",\"instanceId\":\"work\",\"contentRef\":\"content\",\"index\":0,\"data\":\"aW1hZ2U=\"}\n",
            "{\"kind\":\"conversation_image_complete\",\"version\":2,\"requestId\":\"request\",\"hostEpoch\":\"epoch\",\"instanceId\":\"work\",\"contentRef\":\"content\",\"chunks\":1,\"sizeBytes\":5,\"sha256\":\"$SHA\"}\n"
        )
        .replace("$SHA", sha256);
        let (mut client, mut host) = tokio::io::duplex(4_096);
        let writer = tokio::spawn(async move {
            host.write_all(frames.as_bytes()).await.unwrap();
            host.shutdown().await.unwrap();
        });

        let image = read_conversation_image_after_request(
            &mut client,
            1_024 * 1_024,
            "request",
            "epoch",
            "work",
            "content",
            "image/png",
        )
        .await
        .unwrap();
        writer.await.unwrap();

        assert_eq!(image.bytes, b"image");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.sha256, sha256);
        assert_eq!(image.size_bytes, 5);
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
        let blocks = assembler.finish(2).unwrap();
        assert!(matches!(&blocks[0], crate::ContentBlock::Text { text } if text == "hello"));
        assert!(
            matches!(&blocks[1], crate::ContentBlock::ToolCall { tool_name, .. } if tool_name == "read")
        );
    }

    #[test]
    fn complete_tree_requires_one_consistent_depth_first_snapshot() {
        let root = TreeNode {
            entry_id: "root".into(),
            parent_id: None,
            depth: 0,
            kind: TreeNodeKind::Message,
            role: Some(TreeNodeRole::User),
            display_class: TreeDisplayClass::Content,
            state: None,
            label: None,
            timestamp: None,
            summary: "start".into(),
            has_children: true,
        };
        let child = TreeNode {
            entry_id: "child".into(),
            parent_id: Some("root".into()),
            depth: 1,
            kind: TreeNodeKind::Message,
            role: Some(TreeNodeRole::Assistant),
            display_class: TreeDisplayClass::Content,
            state: None,
            label: None,
            timestamp: None,
            summary: "reply".into(),
            has_children: false,
        };
        let tree = SessionTree {
            nodes: vec![root.clone(), child.clone()],
            leaf_id: Some("child".into()),
        };
        assert!(validate_tree(&tree).is_ok());

        let invalid = SessionTree {
            nodes: vec![
                TreeNode {
                    has_children: false,
                    ..root
                },
                child,
            ],
            leaf_id: Some("missing".into()),
        };
        assert!(validate_tree(&invalid).is_err());
    }

    #[test]
    fn strict_session_wire_parser_rejects_unknown_fields() {
        let value = serde_json::json!({"sessions": [], "total": 0, "truncated": false, "sessionFile": "/leak"});
        assert!(serde_json::from_value::<SessionsWireResult>(value).is_err());
    }

    #[test]
    fn fork_state_requires_text_exactly_when_completed() {
        assert!(validate_fork_state(false, Some("returned draft"), "op").is_ok());
        assert!(validate_fork_state(true, None, "op").is_ok());
        assert!(matches!(
            validate_fork_state(false, None, "op"),
            Err(ClientError::EffectUnknown { .. })
        ));
        assert!(matches!(
            validate_fork_state(true, Some("unexpected"), "op"),
            Err(ClientError::EffectUnknown { .. })
        ));
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
