//! The personal assistant kept on Main (card #295): her persona, the owner's hand-written
//! notes, what a new assistant session loads, and the conversations she took part in.
//! Requests carry no `hostId`; the connected Main answers.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DockClient, Result, capabilities::ASSISTANT};

/// Her workspace on Main and the most one document may hold.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantInfo {
    pub workspace_path: String,
    pub max_document_bytes: u64,
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
    query: &'a str,
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

    pub async fn assistant_search(
        &self,
        query: &str,
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
    fn a_search_without_a_time_range_sends_only_the_words() {
        let params = serde_json::to_value(SearchParams {
            query: "天气 早上",
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
        let next = serde_json::to_value(SearchParams {
            query: "天气",
            from: Some("2026-11-01T00:00:00.000Z"),
            to: Some("2026-11-08T00:00:00.000Z"),
            cursor: Some("c2"),
            limit: 20,
        })
        .unwrap();
        assert_eq!(next["from"], "2026-11-01T00:00:00.000Z");
        assert_eq!(next["cursor"], "c2");
    }

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
                    "lastAt": "2026-11-06T08:30:00.000Z"
                },
                "entryId": "e3",
                "at": "2026-11-06T08:05:00.000Z",
                "kind": "assistant",
                "snippet": "…今天早上的天气…"
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
