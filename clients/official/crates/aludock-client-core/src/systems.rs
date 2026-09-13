use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::{DockClient, ResourceContentResult, Result, capabilities::SYSTEM_TEMPLATES};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemSourceKind {
    ProjectSystem,
    GlobalSystem,
    DockTemplate,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SystemDefaultSetResult {
    pub selection: SystemCandidate,
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
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
    operation_id: &'a str,
}

impl DockClient {
    pub async fn system_catalog(
        &self,
        cwd: &str,
        host_id: Option<&str>,
        cursor: Option<&SystemCatalogCursor>,
    ) -> Result<SystemCatalogResult> {
        self.request(
            "system.catalog",
            &CatalogParams {
                cwd,
                host_id,
                cursor,
            },
            SYSTEM_TEMPLATES,
            None,
        )
        .await
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

    pub async fn set_system_default(
        &self,
        cwd: &str,
        id: &str,
        host_id: Option<&str>,
        operation_id: Option<&str>,
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
            },
            SYSTEM_TEMPLATES,
            Some(operation_id),
        )
        .await
    }
}
