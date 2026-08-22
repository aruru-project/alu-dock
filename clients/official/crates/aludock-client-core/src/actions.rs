use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ClientError, DockClient, ImagePath, InstanceExecution, InstanceSnapshot, PendingMessage,
    Result,
    capabilities::{
        ABORT as ABORT_CAPABILITIES, QUEUE as QUEUE_CAPABILITIES, submit as submit_capabilities,
    },
};

#[derive(Clone, Copy, Debug, Serialize)]
pub enum DeliveryMode {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "prompt")]
    Prompt,
    #[serde(rename = "steer")]
    Steer,
    #[serde(rename = "followUp")]
    FollowUp,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReceipt {
    pub accepted: bool,
    pub operation_id: String,
    pub instance_id: String,
    pub kind: String,
    pub delivery: String,
    pub queued: bool,
    pub accepted_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SubmitResult {
    pub receipt: SubmitReceipt,
    pub instance: InstanceSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmitParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachments: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<&'a [ImagePath]>,
    delivery: DeliveryMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct InstanceResult {
    instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDequeueReceipt {
    pub operation_id: String,
    pub instance_id: String,
    pub restored: Vec<PendingMessage>,
    pub in_flight: Vec<PendingMessage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct QueueDequeueResult {
    pub receipt: QueueDequeueReceipt,
    pub instance: InstanceSnapshot,
}

impl DockClient {
    pub async fn submit_message(
        &self,
        instance_id: &str,
        message: &str,
        delivery: DeliveryMode,
        operation_id: Option<&str>,
    ) -> Result<SubmitResult> {
        self.submit_message_with_attachments_and_images(
            instance_id,
            message,
            &[],
            &[],
            delivery,
            operation_id,
        )
        .await
    }

    pub async fn submit_message_with_attachments(
        &self,
        instance_id: &str,
        message: &str,
        attachment_file_ids: &[String],
        delivery: DeliveryMode,
        operation_id: Option<&str>,
    ) -> Result<SubmitResult> {
        self.submit_message_with_attachments_and_images(
            instance_id,
            message,
            attachment_file_ids,
            &[],
            delivery,
            operation_id,
        )
        .await
    }

    pub async fn submit_message_with_attachments_and_images(
        &self,
        instance_id: &str,
        message: &str,
        attachment_file_ids: &[String],
        images: &[ImagePath],
        delivery: DeliveryMode,
        operation_id: Option<&str>,
    ) -> Result<SubmitResult> {
        validate_submit_content(message, attachment_file_ids, images)?;
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let attachments = (!attachment_file_ids.is_empty()).then_some(attachment_file_ids);
        let images = (!images.is_empty()).then_some(images);
        let capabilities = submit_capabilities(attachments.is_some(), images.is_some());
        let result: SubmitResult = self
            .request(
                "command.submit",
                &SubmitParams {
                    operation_id,
                    instance_id,
                    message,
                    attachments,
                    images,
                    delivery,
                },
                &capabilities,
                Some(operation_id),
            )
            .await?;
        result
            .instance
            .validate()
            .map_err(|error| mutation_unknown(operation_id, error))?;
        if !result.receipt.accepted
            || result.receipt.operation_id != operation_id
            || result.receipt.instance_id != instance_id
            || result.instance.id != instance_id
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "message admission receipt did not correlate to the request".into(),
            });
        }
        Ok(result)
    }

    pub async fn dequeue_messages(
        &self,
        instance_id: &str,
        operation_id: Option<&str>,
    ) -> Result<QueueDequeueResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: QueueDequeueResult = self
            .request(
                "queue.dequeue",
                &MutationParams {
                    operation_id,
                    instance_id,
                },
                QUEUE_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        result
            .instance
            .validate()
            .map_err(|error| mutation_unknown(operation_id, error))?;
        let item_count = result.receipt.restored.len() + result.receipt.in_flight.len();
        let unique_count = result
            .receipt
            .restored
            .iter()
            .chain(&result.receipt.in_flight)
            .map(|item| item.queue_item_id.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len();
        if result.receipt.operation_id != operation_id
            || result.receipt.instance_id != instance_id
            || result.instance.id != instance_id
            || result.instance.pending.total != 0
            || unique_count != item_count
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "queue dequeue response did not prove an empty, correlated queue".into(),
            });
        }
        Ok(result)
    }

    pub async fn abort_run(
        &self,
        instance_id: &str,
        operation_id: Option<&str>,
    ) -> Result<InstanceSnapshot> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: InstanceResult = self
            .request(
                "command.abort",
                &MutationParams {
                    operation_id,
                    instance_id,
                },
                ABORT_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        result
            .instance
            .validate()
            .map_err(|error| mutation_unknown(operation_id, error))?;
        if result.instance.id != instance_id
            || result.instance.execution == InstanceExecution::Running
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "abort response did not prove that the run stopped".into(),
            });
        }
        Ok(result.instance)
    }
}

fn validate_submit_content(
    message: &str,
    attachment_file_ids: &[String],
    images: &[ImagePath],
) -> Result<()> {
    if message.trim().is_empty() && attachment_file_ids.is_empty() && images.is_empty() {
        return Err(ClientError::Protocol(
            "a message must contain text, an attachment, or an image".into(),
        ));
    }
    let mut unique = HashSet::new();
    if attachment_file_ids.len() > 32
        || attachment_file_ids.iter().any(|file_id| {
            file_id.is_empty()
                || file_id.chars().count() > 128
                || file_id.chars().any(char::is_control)
                || !unique.insert(file_id.as_str())
        })
    {
        return Err(ClientError::Protocol(
            "attachment file IDs must be 1..32 unique, control-free values of at most 128 characters"
                .into(),
        ));
    }
    Ok(())
}

fn mutation_unknown(operation_id: &str, error: ClientError) -> ClientError {
    ClientError::EffectUnknown {
        operation_id: operation_id.to_owned(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_only_submit_is_valid_and_projects_file_ids() {
        let attachments = vec!["file-a".to_owned(), "file-b".to_owned()];
        validate_submit_content("   ", &attachments, &[]).expect("attachment-only submit");
        let value = serde_json::to_value(SubmitParams {
            operation_id: "operation",
            instance_id: "instance",
            message: "",
            attachments: Some(&attachments),
            images: None,
            delivery: DeliveryMode::Auto,
        })
        .unwrap();
        assert_eq!(
            value["attachments"],
            serde_json::json!(["file-a", "file-b"])
        );
        assert!(validate_submit_content("", &[], &[]).is_err());
        assert!(validate_submit_content("ok", &["same".into(), "same".into()], &[]).is_err());
    }

    #[test]
    fn text_only_submit_omits_optional_payloads_and_image_capability() {
        let value = serde_json::to_value(SubmitParams {
            operation_id: "operation",
            instance_id: "instance",
            message: "hello",
            attachments: None,
            images: None,
            delivery: DeliveryMode::Prompt,
        })
        .unwrap();
        assert!(value.get("attachments").is_none());
        assert!(value.get("images").is_none());
        assert!(!submit_capabilities(false, false).contains(&"command.images.path.v1"));
    }

    #[test]
    fn image_submit_projects_descriptors_and_requires_image_capability() {
        let images = vec![ImagePath {
            path: "/native/image.png".into(),
            mime_type: "image/png".into(),
        }];
        validate_submit_content("", &[], &images).expect("image-only submit");
        let value = serde_json::to_value(SubmitParams {
            operation_id: "operation",
            instance_id: "instance",
            message: "",
            attachments: None,
            images: Some(&images),
            delivery: DeliveryMode::Auto,
        })
        .unwrap();
        assert_eq!(value["images"][0]["path"], "/native/image.png");
        assert!(submit_capabilities(false, true).contains(&"command.images.path.v1"));
    }
}
