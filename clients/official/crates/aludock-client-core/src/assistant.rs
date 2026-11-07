//! The personal assistant kept on Main (card #295): her persona, the owner's hand-written
//! notes, what a new assistant session loads, the conversations she took part in, the
//! memories made from them and the model that makes them.
//! Requests carry no `hostId`; the connected Main answers.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DockClient, ModelRef, Result, capabilities::ASSISTANT};

/// Her workspace on Main, the most one document and one memory may hold, and how her memories
/// are being made.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantInfo {
    pub workspace_path: String,
    pub max_document_bytes: u64,
    /// In UTF-16 code units, as a JavaScript string counts them.
    pub max_memory_chars: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction: Option<AssistantExtractionStatus>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantExtractionState {
    /// No model is chosen, so nothing is made into memories.
    Off,
    Idle,
    Working,
    /// The last try did not work; it is tried again at `retry_at`.
    Failed,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

/// Making memories from her conversations in the background, as it stands now.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantExtractionStatus {
    pub state: AssistantExtractionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// Conversations with something said since they were last read for memories.
    pub waiting_sessions: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    /// Written for the owner. With `Idle`, a part of a conversation that was passed over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
}

/// The model that makes her memories; without one nothing is made.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction_model: Option<ModelRef>,
}

/// What a memory is about: the owner, his likes and habits, the two of them, what they went
/// through, or herself.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantMemoryTopic {
    Owner,
    Preferences,
    Relationship,
    Events,
    #[serde(rename = "self")]
    Herself,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

/// In use; set aside as no longer true but kept for the record; or forgotten at the owner's word.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantMemoryState {
    Active,
    Retired,
    Forgotten,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

/// Who made a memory's latest change. Every change a client makes is the owner's.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantMemoryAuthor {
    Extraction,
    Dreaming,
    Assistant,
    Owner,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantMemoryAction {
    Added,
    Rewritten,
    Moved,
    Resident,
    QueryOnly,
    Retired,
    Forgotten,
    Restored,
    Merged,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

/// An entry of her recorded conversations.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantEntryRef {
    pub session_id: String,
    pub entry_id: String,
}

/// Where a memory was said.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMemorySource {
    pub session_id: String,
    pub entry_id: String,
    pub at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMemory {
    pub id: String,
    pub topic: AssistantMemoryTopic,
    pub text: String,
    /// Loaded into every new assistant session; otherwise found only when she looks.
    pub resident: bool,
    pub state: AssistantMemoryState,
    pub author: AssistantMemoryAuthor,
    pub created_at: String,
    pub updated_at: String,
    /// Goes up with every change; a change names the revision it was made from.
    pub revision: u64,
    /// The earliest places it was said, `source_count` in all.
    pub sources: Vec<AssistantMemorySource>,
    pub source_count: u64,
    /// The memory it was merged into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMemoryList {
    /// Newest first.
    pub memories: Vec<AssistantMemory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssistantMemoryChange {
    pub at: String,
    pub author: AssistantMemoryAuthor,
    pub action: AssistantMemoryAction,
    /// The text it was written or rewritten to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssistantMemoryDetail {
    pub memory: AssistantMemory,
    /// Its latest changes, newest first.
    pub history: Vec<AssistantMemoryChange>,
}

/// Which memories a list shows; each field left out widens it. Without `state`, those in use.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMemoryFilter {
    /// Words that must all occur.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<AssistantMemoryTopic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<AssistantMemoryState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resident: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<AssistantMemoryAuthor>,
}

/// What a change to one memory sets; each field left out stays as it is.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMemoryEdit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<AssistantMemoryTopic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resident: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<AssistantMemoryState>,
}

/// The whole text a new assistant session loads now, and when it was put together.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPreview {
    pub text: String,
    pub loaded_at: String,
}

/// Who she is (`persona`) and what the owner told her by hand (`notes`).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AssistantDocumentName {
    Persona,
    Notes,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssistantDocument {
    pub document: AssistantDocumentName,
    pub text: String,
    /// The version this text is; a save names it so a change made elsewhere is not overwritten.
    pub revision: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantEntryKind {
    User,
    Assistant,
    ToolResult,
    Bash,
    Summary,
    Notice,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

/// Where a conversation took place: the session, and the Work and machine it ran in.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSessionInfo {
    pub session_id: String,
    /// A path on Main; the interface has no use for it.
    #[serde(default, skip_serializing)]
    pub session_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The Work's Main ID when it was recorded; that Work may have stopped since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    /// The machine's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    pub started_at: String,
    pub last_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSearchHit {
    pub session: AssistantSessionInfo,
    pub entry_id: String,
    pub at: String,
    pub kind: AssistantEntryKind,
    /// The original text around the match.
    pub snippet: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSearchResult {
    /// Newest first.
    pub hits: Vec<AssistantSearchHit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssistantToolCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantEntry {
    pub entry_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub at: String,
    pub kind: AssistantEntryKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AssistantToolCall>>,
    /// The text was cut; the whole of it stays in the Agent's own session file.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantContextResult {
    pub session: AssistantSessionInfo,
    /// Oldest first, including the entry asked about.
    pub entries: Vec<AssistantEntry>,
    pub has_before: bool,
    pub has_after: bool,
}

#[derive(Serialize)]
struct NoParams {}

#[derive(Serialize)]
struct DocumentParams {
    document: AssistantDocumentName,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentSetParams<'a> {
    operation_id: &'a str,
    document: AssistantDocumentName,
    text: &'a str,
    base_revision: &'a str,
}

#[derive(Serialize)]
struct SearchParams<'a> {
    /// Optional with a time range: then her conversations of that time, newest first.
    #[serde(skip_serializing_if = "Option::is_none")]
    query: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
    limit: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextParams<'a> {
    session_id: &'a str,
    entry_id: &'a str,
    before: u32,
    after: u32,
}

#[derive(Serialize)]
struct MemoryListParams<'a> {
    #[serde(flatten)]
    filter: &'a AssistantMemoryFilter,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
    limit: u32,
}

#[derive(Serialize)]
struct MemoryGetParams<'a> {
    id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryAddParams<'a> {
    operation_id: &'a str,
    topic: AssistantMemoryTopic,
    text: &'a str,
    resident: bool,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    sources: &'a [AssistantEntryRef],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryUpdateParams<'a> {
    operation_id: &'a str,
    id: &'a str,
    revision: u64,
    #[serde(flatten)]
    edit: &'a AssistantMemoryEdit,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSetParams<'a> {
    operation_id: &'a str,
    /// Sent as `null` to stop making memories.
    extraction_model: Option<&'a ModelRef>,
}

impl DockClient {
    pub async fn assistant_info(&self) -> Result<AssistantInfo> {
        self.request("assistant.info", &NoParams {}, ASSISTANT, None)
            .await
    }

    pub async fn assistant_preview(&self) -> Result<AssistantPreview> {
        self.request("assistant.preview", &NoParams {}, ASSISTANT, None)
            .await
    }

    pub async fn assistant_document(
        &self,
        document: AssistantDocumentName,
    ) -> Result<AssistantDocument> {
        self.request(
            "assistant.document.get",
            &DocumentParams { document },
            ASSISTANT,
            None,
        )
        .await
    }

    /// Replaces the whole document. The Host refuses with `assistant_document_changed`
    /// when `base_revision` is no longer current, leaving the document as it is.
    pub async fn set_assistant_document(
        &self,
        document: AssistantDocumentName,
        text: &str,
        base_revision: &str,
        operation_id: Option<&str>,
    ) -> Result<AssistantDocument> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        self.request(
            "assistant.document.set",
            &DocumentSetParams {
                operation_id,
                document,
                text,
                base_revision,
            },
            ASSISTANT,
            Some(operation_id),
        )
        .await
    }

    /// Words that must all appear, or with `from`/`to` alone everything in that time.
    pub async fn assistant_search(
        &self,
        query: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<AssistantSearchResult> {
        self.request(
            "assistant.search",
            &SearchParams {
                query,
                from,
                to,
                cursor,
                limit,
            },
            ASSISTANT,
            None,
        )
        .await
    }

    /// `before` and `after` entries around one entry of the same branch.
    pub async fn assistant_context(
        &self,
        session_id: &str,
        entry_id: &str,
        before: u32,
        after: u32,
    ) -> Result<AssistantContextResult> {
        self.request(
            "assistant.context",
            &ContextParams {
                session_id,
                entry_id,
                before,
                after,
            },
            ASSISTANT,
            None,
        )
        .await
    }

    /// Her memories, newest first.
    pub async fn assistant_memories(
        &self,
        filter: &AssistantMemoryFilter,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<AssistantMemoryList> {
        self.request(
            "assistant.memory.list",
            &MemoryListParams {
                filter,
                cursor,
                limit,
            },
            ASSISTANT,
            None,
        )
        .await
    }

    /// One memory with its latest changes.
    pub async fn assistant_memory(&self, id: &str) -> Result<AssistantMemoryDetail> {
        self.request(
            "assistant.memory.get",
            &MemoryGetParams { id },
            ASSISTANT,
            None,
        )
        .await
    }

    /// A memory the owner writes, said where `sources` name. The same `operation_id` adds
    /// it at most once while the Host runs.
    pub async fn add_assistant_memory(
        &self,
        topic: AssistantMemoryTopic,
        text: &str,
        resident: bool,
        sources: &[AssistantEntryRef],
        operation_id: Option<&str>,
    ) -> Result<AssistantMemory> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        self.request(
            "assistant.memory.add",
            &MemoryAddParams {
                operation_id,
                topic,
                text,
                resident,
                sources,
            },
            ASSISTANT,
            Some(operation_id),
        )
        .await
    }

    /// Changes what `edit` names. The Host refuses, changing nothing, with
    /// `assistant_memory_changed` when `revision` is no longer the memory's, and with
    /// `assistant_memory_merged` when forgetting one whose words live on in the memory it
    /// was merged into. Setting `resident`, even to what it is, makes it the owner's choice.
    pub async fn update_assistant_memory(
        &self,
        id: &str,
        revision: u64,
        edit: &AssistantMemoryEdit,
        operation_id: Option<&str>,
    ) -> Result<AssistantMemory> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        self.request(
            "assistant.memory.update",
            &MemoryUpdateParams {
                operation_id,
                id,
                revision,
                edit,
            },
            ASSISTANT,
            Some(operation_id),
        )
        .await
    }

    pub async fn assistant_settings(&self) -> Result<AssistantSettings> {
        self.request("assistant.settings.get", &NoParams {}, ASSISTANT, None)
            .await
    }

    /// `None` stops making memories; those already made stay.
    pub async fn set_assistant_settings(
        &self,
        extraction_model: Option<&ModelRef>,
        operation_id: Option<&str>,
    ) -> Result<AssistantSettings> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        self.request(
            "assistant.settings.set",
            &SettingsSetParams {
                operation_id,
                extraction_model,
            },
            ASSISTANT,
            Some(operation_id),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_a_document_names_the_version_it_was_edited_from() {
        let params = serde_json::to_value(DocumentSetParams {
            operation_id: "save-1",
            document: AssistantDocumentName::Notes,
            text: "早上先说天气",
            base_revision: "r7",
        })
        .unwrap();
        assert_eq!(
            params,
            serde_json::json!({ "operationId": "save-1", "document": "notes", "text": "早上先说天气", "baseRevision": "r7" })
        );
        let read: AssistantDocument = serde_json::from_value(
            serde_json::json!({ "document": "persona", "text": "她是阿露。", "revision": "r8" }),
        )
        .unwrap();
        assert_eq!(read.document, AssistantDocumentName::Persona);
        assert_eq!(read.revision, "r8");
    }

    #[test]
    fn a_search_sends_the_words_or_only_a_time_range() {
        let params = serde_json::to_value(SearchParams {
            query: Some("天气 早上"),
            from: None,
            to: None,
            cursor: None,
            limit: 20,
        })
        .unwrap();
        assert_eq!(
            params,
            serde_json::json!({ "query": "天气 早上", "limit": 20 })
        );
        let yesterday = serde_json::to_value(SearchParams {
            query: None,
            from: Some("2026-11-06T00:00:00.000Z"),
            to: Some("2026-11-07T00:00:00.000Z"),
            cursor: Some("c2"),
            limit: 20,
        })
        .unwrap();
        assert_eq!(
            yesterday,
            serde_json::json!({ "from": "2026-11-06T00:00:00.000Z", "to": "2026-11-07T00:00:00.000Z", "cursor": "c2", "limit": 20 }),
            "a time range alone lists that time's conversations"
        );
    }

    /// The Host may add fields to hits and sessions; the client reads the ones it knows.
    #[test]
    fn search_results_show_where_a_conversation_happened_without_session_file_paths() {
        let result: AssistantSearchResult = serde_json::from_value(serde_json::json!({
            "hits": [{
                "session": {
                    "sessionId": "s1",
                    "sessionFile": "/home/alu/.pi/agent/sessions/s1.jsonl",
                    "cwd": "/home/alu/.aludock/assistant",
                    "name": "早上聊天",
                    "workId": "work-1",
                    "machine": "工作站",
                    "startedAt": "2026-11-06T08:00:00.000Z",
                    "lastAt": "2026-11-06T08:30:00.000Z",
                    "entryCount": 42
                },
                "entryId": "e3",
                "at": "2026-11-06T08:05:00.000Z",
                "kind": "assistant",
                "snippet": "…今天早上的天气…",
                "score": 0.8
            }],
            "nextCursor": "c2"
        }))
        .unwrap();
        assert_eq!(result.hits[0].session.work_id.as_deref(), Some("work-1"));
        assert_eq!(result.hits[0].kind, AssistantEntryKind::Assistant);
        assert_eq!(result.next_cursor.as_deref(), Some("c2"));
        let shown = serde_json::to_value(&result).unwrap();
        assert!(!shown.to_string().contains("s1.jsonl"));
        assert_eq!(shown["hits"][0]["session"]["machine"], "工作站");
    }

    /// `self` is a Rust keyword, so the topic about herself is named apart from its wire value;
    /// the real-Host gate only lists the owner's topic.
    #[test]
    fn the_topic_about_herself_is_asked_for_as_self() {
        let herself = AssistantMemoryFilter {
            topic: Some(AssistantMemoryTopic::Herself),
            ..AssistantMemoryFilter::default()
        };
        assert_eq!(
            serde_json::to_value(MemoryListParams {
                filter: &herself,
                cursor: None,
                limit: 30,
            })
            .unwrap(),
            serde_json::json!({ "topic": "self", "limit": 30 })
        );
    }

    /// A newer Main may add fields and values; the client keeps the memories it can show.
    #[test]
    fn memories_from_a_newer_main_keep_what_this_client_knows() {
        let list: AssistantMemoryList = serde_json::from_value(serde_json::json!({
            "memories": [{
                "id": "7", "topic": "places", "text": "主人住在海边。", "resident": true,
                "state": "active", "author": "someone-new", "createdAt": "2026-11-07T10:00:00.000Z",
                "updatedAt": "2026-11-07T10:00:00.000Z", "revision": 1, "sources": [], "sourceCount": 0,
                "confidence": 0.9
            }]
        }))
        .unwrap();
        assert_eq!(list.memories[0].topic, AssistantMemoryTopic::Unrecognized);
        assert_eq!(list.memories[0].author, AssistantMemoryAuthor::Unrecognized);
        let info: AssistantInfo = serde_json::from_value(serde_json::json!({
            "workspacePath": "/home/alu/.aludock/assistant",
            "maxDocumentBytes": 262144,
            "maxMemoryChars": 1000,
            "extraction": { "state": "paused", "waitingSessions": 2 }
        }))
        .unwrap();
        let extraction = info.extraction.unwrap();
        assert_eq!(extraction.state, AssistantExtractionState::Unrecognized);
        assert_eq!(extraction.waiting_sessions, 2);
    }

    #[test]
    fn context_keeps_tool_calls_and_says_when_text_was_cut() {
        let result: AssistantContextResult = serde_json::from_value(serde_json::json!({
            "session": { "sessionId": "s1", "startedAt": "2026-11-06T08:00:00.000Z", "lastAt": "2026-11-06T08:30:00.000Z" },
            "entries": [
                { "entryId": "e2", "at": "2026-11-06T08:04:00.000Z", "kind": "user", "text": "今天天气怎么样？" },
                { "entryId": "e3", "parentId": "e2", "at": "2026-11-06T08:05:00.000Z", "kind": "assistant", "text": "我查一下。",
                  "toolCalls": [{ "name": "bash", "arguments": "{\"command\":\"weather\"}" }] },
                { "entryId": "e4", "parentId": "e3", "at": "2026-11-06T08:05:01.000Z", "kind": "tool_result", "toolName": "bash", "text": "晴", "truncated": true }
            ],
            "hasBefore": true,
            "hasAfter": false
        }))
        .unwrap();
        assert!(result.has_before && !result.has_after);
        assert_eq!(
            result.entries[1].tool_calls.as_ref().unwrap()[0].name,
            "bash"
        );
        assert!(result.entries[2].truncated);
        let shown = serde_json::to_value(&result.entries[0]).unwrap();
        assert!(
            shown.get("truncated").is_none(),
            "only cut text carries the mark"
        );
        assert_eq!(
            serde_json::to_value(ContextParams {
                session_id: "s1",
                entry_id: "e3",
                before: 10,
                after: 0
            })
            .unwrap(),
            serde_json::json!({ "sessionId": "s1", "entryId": "e3", "before": 10, "after": 0 })
        );
    }
}
