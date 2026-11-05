use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DockClient, ModelInfo, ModelRef, Result, capabilities::CHILD_MODELS};

/// Main's models to pick from, less hidden ones, and the list Agents read through `dock_models`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildModelsResult {
    pub models: Vec<ModelInfo>,
    pub total: u64,
    pub truncated: bool,
    /// In its saved order.
    pub listed: Vec<ModelRef>,
    /// The most models the list may hold; the Host refuses more.
    pub limit: u64,
    /// Why a hand-edited list could not be used; Agents see no list until it is saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_problem: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChildModelsSetResult {
    pub listed: Vec<ModelRef>,
}

#[derive(Serialize)]
struct GetParams {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetParams<'a> {
    operation_id: &'a str,
    models: &'a [ModelRef],
}

impl DockClient {
    /// The list exists only on Main, so the connected Host answers; there is no machine to choose.
    pub async fn child_models(&self) -> Result<ChildModelsResult> {
        self.request("model.children.get", &GetParams {}, CHILD_MODELS, None)
            .await
    }

    /// Replaces the whole list; the last save wins.
    pub async fn set_child_models(
        &self,
        models: &[ModelRef],
        operation_id: Option<&str>,
    ) -> Result<ChildModelsSetResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        self.request(
            "model.children.set",
            &SetParams {
                operation_id,
                models,
            },
            CHILD_MODELS,
            Some(operation_id),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_saved_in_order_without_a_machine() {
        let models = [
            ModelRef {
                provider: "openai-sub".into(),
                id: "gpt-6-astra".into(),
            },
            ModelRef {
                provider: "claude-sub".into(),
                id: "claude-haiku-5-5".into(),
            },
        ];
        let params = serde_json::to_value(SetParams {
            operation_id: "operation-a",
            models: &models,
        })
        .unwrap();
        assert_eq!(
            params,
            serde_json::json!({
                "operationId": "operation-a",
                "models": [
                    { "provider": "openai-sub", "id": "gpt-6-astra" },
                    { "provider": "claude-sub", "id": "claude-haiku-5-5" }
                ]
            })
        );
        assert_eq!(
            serde_json::to_value(GetParams {}).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn settings_page_reads_models_the_list_and_a_broken_file_notice() {
        let result: ChildModelsResult = serde_json::from_value(serde_json::json!({
            "models": [{ "provider": "openai-sub", "id": "gpt-6-astra", "name": "GPT-6 Astra", "reasoning": true }],
            "total": 1,
            "truncated": false,
            "listed": [{ "provider": "claude-sub", "id": "claude-haiku-5-5" }],
            "limit": 50,
            "fileProblem": "child-models.json is not valid JSON"
        }))
        .unwrap();
        assert_eq!(result.models[0].id, "gpt-6-astra");
        assert_eq!(result.listed[0].provider, "claude-sub");
        assert_eq!(result.limit, 50);
        assert_eq!(
            result.file_problem.as_deref(),
            Some("child-models.json is not valid JSON")
        );
    }
}
