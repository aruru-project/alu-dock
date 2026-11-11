use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::{
    DockClient, ResourceContentResult, Result,
    capabilities::{INSTANCE_ASSISTANT_V1, SYSTEM_TEMPLATES, with_assistant_choice},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemSourceKind {
    ProjectSystem,
    GlobalSystem,
    DockTemplate,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCandidate {
    pub id: String,
    pub name: String,
    pub kind: SystemSourceKind,
    pub path: String,
    pub worker_config: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SystemCatalogCursor {
    pub revision: String,
    pub offset: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCatalogResult {
    pub cwd: String,
    pub candidates: Vec<SystemCandidate>,
    pub total: u64,
    pub revision: String,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_selection: Option<SystemCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<SystemCatalogCursor>,
    /// This directory opens new Works as the assistant unless the creator says otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub default_assistant: bool,
    /// The connected Host takes the "open as the assistant" choice. Read from the hello of
    /// the connection that carried this answer, never from the answer itself.
    #[serde(skip_deserializing)]
    pub assistant_choice: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SystemDefaultSetResult {
    /// The system this save remembered; a save that only remembers the assistant has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<SystemCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogParams<'a> {
    cwd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a SystemCatalogCursor>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentParams<'a> {
    cwd: &'a str,
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DefaultParams<'a> {
    cwd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
    operation_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    assistant: Option<bool>,
}

impl DockClient {
    pub async fn system_catalog(
        &self,
        cwd: &str,
        host_id: Option<&str>,
        cursor: Option<&SystemCatalogCursor>,
    ) -> Result<SystemCatalogResult> {
        let (mut page, hello): (SystemCatalogResult, _) = self
            .request_with_hello(
                "system.catalog",
                &CatalogParams {
                    cwd,
                    host_id,
                    cursor,
                },
                SYSTEM_TEMPLATES,
                None,
                None,
            )
            .await?;
        page.assistant_choice = hello
            .capabilities
            .iter()
            .any(|capability| capability == INSTANCE_ASSISTANT_V1);
        Ok(page)
    }

    pub async fn system_content_all(
        &self,
        cwd: &str,
        id: &str,
        host_id: Option<&str>,
    ) -> Result<ResourceContentResult> {
        let params = ContentParams {
            cwd,
            id,
            host_id,
            offset: None,
            revision: None,
        };
        if let Some(result) = self
            .read_file_text("system.content", &params, SYSTEM_TEMPLATES)
            .await?
        {
            return Ok(result);
        }
        let mut text = String::new();
        let mut offset = None;
        let mut revision: Option<String> = None;
        loop {
            let page = self
                .system_content(cwd, id, host_id, offset, revision.as_deref())
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

    pub async fn system_content(
        &self,
        cwd: &str,
        id: &str,
        host_id: Option<&str>,
        offset: Option<u64>,
        revision: Option<&str>,
    ) -> Result<ResourceContentResult> {
        self.request(
            "system.content",
            &ContentParams {
                cwd,
                id,
                host_id,
                offset,
                revision,
            },
            SYSTEM_TEMPLATES,
            None,
        )
        .await
    }

    /// `Some(true)` also remembers opening new Works here as the assistant and `Some(false)`
    /// forgets it; `None` keeps whatever the directory remembered, as an older client's save does.
    /// `id` may be `None` only with `Some(true)`: the assistant takes no system, and the directory
    /// keeps the system it had for Works not opened as her.
    pub async fn set_system_default(
        &self,
        cwd: &str,
        id: Option<&str>,
        host_id: Option<&str>,
        operation_id: Option<&str>,
        assistant: Option<bool>,
    ) -> Result<SystemDefaultSetResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        self.request(
            "system.default.set",
            &DefaultParams {
                cwd,
                id,
                host_id,
                operation_id,
                assistant,
            },
            &with_assistant_choice(SYSTEM_TEMPLATES, assistant),
            Some(operation_id),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_that_opens_as_the_assistant_says_so_and_saving_can_remember_it() {
        let page: SystemCatalogResult = serde_json::from_value(serde_json::json!({
            "cwd": "/home/alu/.aludock/assistant",
            "candidates": [],
            "total": 0,
            "revision": "r1",
            "warnings": [],
            "defaultAssistant": true,
            "assistantChoice": true
        }))
        .unwrap();
        assert!(page.default_assistant);
        assert!(
            !page.assistant_choice,
            "whether the Host takes the choice comes from its hello, not from the answer"
        );
        let older: SystemCatalogResult = serde_json::from_value(serde_json::json!({
            "cwd": "/project", "candidates": [], "total": 0, "revision": "r1", "warnings": []
        }))
        .unwrap();
        assert!(!older.default_assistant);
        let shown = serde_json::to_value(&older).unwrap();
        assert!(shown.get("defaultAssistant").is_none());
        assert_eq!(shown["assistantChoice"], false);

        let forget = serde_json::to_value(DefaultParams {
            cwd: "/project",
            id: Some("template"),
            host_id: None,
            operation_id: "save-1",
            assistant: Some(false),
        })
        .unwrap();
        assert_eq!(
            forget,
            serde_json::json!({ "cwd": "/project", "id": "template", "operationId": "save-1", "assistant": false })
        );
        let older_save = serde_json::to_value(DefaultParams {
            cwd: "/project",
            id: Some("template"),
            host_id: None,
            operation_id: "save-1",
            assistant: None,
        })
        .unwrap();
        assert!(older_save.get("assistant").is_none());
        // 2026-11-12: remembering her says no system, and the Host answers with none.
        let hers = serde_json::to_value(DefaultParams {
            cwd: "/project",
            id: None,
            host_id: None,
            operation_id: "save-2",
            assistant: Some(true),
        })
        .unwrap();
        assert_eq!(
            hers,
            serde_json::json!({ "cwd": "/project", "operationId": "save-2", "assistant": true })
        );
        let answer: SystemDefaultSetResult = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(answer.selection.is_none());
        assert_eq!(
            with_assistant_choice(SYSTEM_TEMPLATES, Some(true)),
            ["core.v2", "system.templates.v1", "instance.assistant.v1"]
        );
        assert_eq!(
            with_assistant_choice(SYSTEM_TEMPLATES, Some(false)),
            ["core.v2", "system.templates.v1"],
            "turning the choice off asks nothing of the Host"
        );
    }

    // New Client / older Host: its hello offers no `instance.assistant.v1`. The directory's
    // systems are listed as before, and the creation page is told not to offer the switch.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_older_host_lists_its_systems_and_takes_no_assistant_choice() {
        use crate::tls::{read_json_line, write_json_line};
        use crate::{ConnectionRouter, IdentityStore, LocalDockEndpoint};
        let directory = std::env::temp_dir().join(format!("sys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let endpoint = directory.join("dock.sock");
        let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio::io::BufReader::new(socket);
            let hello: Value = read_json_line(&mut socket, 16 * 1024).await.unwrap();
            write_json_line(
                &mut socket,
                &serde_json::json!({
                    "kind": "hello_ack", "version": 2, "requestId": hello["requestId"],
                    "catalogSchemaVersion": 1, "host": {"hostEpoch": "epoch"},
                    "capabilities": ["core.v2", "system.templates.v1"],
                    "limits": {"maxLineBytes": 16384}
                }),
            )
            .await
            .unwrap();
            let request: Value = read_json_line(&mut socket, 16 * 1024).await.unwrap();
            assert_eq!(request["type"], "system.catalog");
            write_json_line(
                &mut socket,
                &serde_json::json!({
                    "kind": "response", "version": 2, "requestId": request["requestId"],
                    "hostEpoch": "epoch", "ok": true, "result": {
                        "cwd": "/project", "total": 1, "revision": "r1", "warnings": [],
                        "candidates": [{
                            "id": "project", "name": "项目 SYSTEM", "kind": "project-system",
                            "path": "/project/.pi/SYSTEM.md", "workerConfig": {}
                        }]
                    }
                }),
            )
            .await
            .unwrap();
            hello["requiredCapabilities"].clone()
        });
        let client = DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(directory.join("identity")),
                LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                "older-host-systems".into(),
            )
            .unwrap(),
        );
        let page = client.system_catalog("/project", None, None).await;
        let required = peer.await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        let page = page.unwrap();
        assert_eq!(page.candidates[0].name, "项目 SYSTEM");
        assert!(!page.assistant_choice);
        assert!(
            !required
                .as_array()
                .unwrap()
                .iter()
                .any(|capability| capability == INSTANCE_ASSISTANT_V1),
            "listing systems does not ask the Host for the assistant choice"
        );
    }
}
