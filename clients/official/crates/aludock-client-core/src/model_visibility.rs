use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DockClient, ModelInfo, Result, capabilities::MODEL_VISIBILITY};

/// One exact model on one machine, as Pi names it: provider plus model id.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

/// A machine's selectable models and the ones its Host leaves out of every model list.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVisibilityResult {
    pub models: Vec<ModelInfo>,
    pub total: u64,
    pub truncated: bool,
    pub hidden: Vec<ModelRef>,
    /// Why a hand-edited list could not be used; that machine hides nothing until it is saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_problem: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelVisibilitySetResult {
    pub hidden: Vec<ModelRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GetParams<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetParams<'a> {
    operation_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
    hidden: &'a [ModelRef],
}

impl DockClient {
    /// Omit `host_id` for the connected Host itself.
    pub async fn model_visibility(&self, host_id: Option<&str>) -> Result<ModelVisibilityResult> {
        self.request(
            "model.visibility.get",
            &GetParams { host_id },
            MODEL_VISIBILITY,
            None,
        )
        .await
    }

    /// Replaces the machine's whole hidden list; the last save wins.
    pub async fn set_model_visibility(
        &self,
        hidden: &[ModelRef],
        host_id: Option<&str>,
        operation_id: Option<&str>,
    ) -> Result<ModelVisibilitySetResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        self.request(
            "model.visibility.set",
            &SetParams {
                operation_id,
                host_id,
                hidden,
            },
            MODEL_VISIBILITY,
            Some(operation_id),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_list_is_saved_for_the_chosen_machine() {
        let hidden = [ModelRef {
            provider: "azure-openai-responses".into(),
            id: "gpt-5.6".into(),
        }];
        let params = serde_json::to_value(SetParams {
            operation_id: "operation-a",
            host_id: Some("subhost-a"),
            hidden: &hidden,
        })
        .unwrap();
        assert_eq!(
            params,
            serde_json::json!({
                "operationId": "operation-a",
                "hostId": "subhost-a",
                "hidden": [{ "provider": "azure-openai-responses", "id": "gpt-5.6" }]
            })
        );
        assert_eq!(
            serde_json::to_value(GetParams { host_id: None }).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn settings_page_reads_models_hidden_entries_and_a_broken_file_notice() {
        let result: ModelVisibilityResult = serde_json::from_value(serde_json::json!({
            "models": [{ "provider": "openai", "id": "gpt-5.6", "name": "GPT-5.6", "reasoning": true }],
            "total": 1,
            "truncated": false,
            "hidden": [{ "provider": "azure-openai-responses", "id": "gpt-5.6" }],
            "fileProblem": "model-visibility.json 不是有效的 JSON"
        }))
        .unwrap();
        assert_eq!(result.models[0].id, "gpt-5.6");
        assert_eq!(result.hidden[0].provider, "azure-openai-responses");
        assert_eq!(
            result.file_problem.as_deref(),
            Some("model-visibility.json 不是有效的 JSON")
        );
    }
}
