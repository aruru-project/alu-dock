mod presentation;
pub use presentation::*;
use std::collections::HashSet;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ClientError, DockClient, ImagePath, InstanceSnapshot, PendingMessage, Result,
    capabilities::{
        ABORT as ABORT_CAPABILITIES, ABORT_RESTORE_QUEUE as ABORT_RESTORE_QUEUE_CAPABILITIES,
        BASH as BASH_CAPABILITIES, QUEUE as QUEUE_CAPABILITIES, RUN_ABORT_RESTORE_QUEUE_V1,
        submit as submit_capabilities,
    },
};

/// One shell command line, the same bound the Host applies to `bash.run`.
pub const MAX_BASH_COMMAND_CHARS: usize = 8_000;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BashRunParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    command: &'a str,
    exclude_from_context: bool,
}

/// The shell command has started; its output and completion arrive as `bash.*` events.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashRunReceipt {
    pub operation_id: String,
    pub instance_id: String,
    pub started_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BashRunResult {
    pub receipt: BashRunReceipt,
    pub instance: InstanceSnapshot,
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
        if result.receipt.operation_id != operation_id
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
        if result.receipt.operation_id != operation_id
            || result.receipt.instance_id != instance_id
            || result.instance.id != instance_id
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "queue dequeue response did not correlate to the request".into(),
            });
        }
        Ok(result)
    }

    /// Stop the current reply and take every waiting Queue message back in one
    /// Host step, so none of them starts once the reply stops.
    pub async fn abort_run(
        &self,
        instance_id: &str,
        operation_id: Option<&str>,
    ) -> Result<QueueDequeueResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: QueueDequeueResult = match self
            .request(
                "command.abort_restore_queue",
                &MutationParams {
                    operation_id,
                    instance_id,
                },
                ABORT_RESTORE_QUEUE_CAPABILITIES,
                Some(operation_id),
            )
            .await
        {
            Err(error) if error.missing_capability(&[RUN_ABORT_RESTORE_QUEUE_V1]) => {
                // An older Host still gets its Queue back before the abort.
                let mut restored = self.dequeue_messages(instance_id, None).await?;
                restored.instance = self.abort_only(instance_id, operation_id).await?;
                restored.receipt.operation_id = operation_id.to_owned();
                restored
            }
            other => other?,
        };
        if result.receipt.operation_id != operation_id
            || result.receipt.instance_id != instance_id
            || result.instance.id != instance_id
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "abort response returned a different Work".into(),
            });
        }
        Ok(result)
    }

    /// Pi's `!` (`exclude_from_context: false`) or `!!` (`true`): run one shell command
    /// in the Work's directory on its machine. The receipt only says it started.
    pub async fn run_bash(
        &self,
        instance_id: &str,
        command: &str,
        exclude_from_context: bool,
        operation_id: Option<&str>,
    ) -> Result<BashRunResult> {
        if command.trim().is_empty() || command.chars().count() > MAX_BASH_COMMAND_CHARS {
            return Err(ClientError::Protocol(
                "a shell command must be non-empty and at most 8000 characters".into(),
            ));
        }
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: BashRunResult = self
            .request(
                "bash.run",
                &BashRunParams {
                    operation_id,
                    instance_id,
                    command,
                    exclude_from_context,
                },
                BASH_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        if result.receipt.operation_id != operation_id
            || result.receipt.instance_id != instance_id
            || result.instance.id != instance_id
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "shell command receipt did not correlate to the request".into(),
            });
        }
        Ok(result)
    }

    /// Stops every shell command this Work is running; the Agent reply and Queue are untouched.
    pub async fn abort_bash(
        &self,
        instance_id: &str,
        operation_id: Option<&str>,
    ) -> Result<InstanceSnapshot> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: InstanceResult = self
            .request(
                "bash.abort",
                &MutationParams {
                    operation_id,
                    instance_id,
                },
                BASH_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        if result.instance.id != instance_id {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "shell abort response returned a different Work".into(),
            });
        }
        Ok(result.instance)
    }

    async fn abort_only(&self, instance_id: &str, operation_id: &str) -> Result<InstanceSnapshot> {
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
    if attachment_file_ids.len() > crate::MAX_ATTACHMENTS_PER_MESSAGE
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

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RestoredImageScope {
    pub host_epoch: String,
    pub runtime_generation: u64,
    pub connection_id: String,
    pub selection_generation: u64,
    pub work_id: String,
}

#[derive(Clone)]
struct RestoredImageBatch {
    cursor_sequence: Option<u64>,
    token: String,
    images: Vec<ImagePath>,
}

#[derive(Clone, Default)]
struct RestoredImageBucket {
    batches: Vec<RestoredImageBatch>,
}

#[derive(Clone)]
pub struct RestoredImageCapture {
    pub tokens: Vec<String>,
    pub images: Vec<ImagePath>,
}

#[derive(Clone, Default)]
pub struct RestoredImageState {
    state: Arc<Mutex<RestoredImages>>,
}

#[derive(Default)]
struct RestoredImages {
    buckets: HashMap<RestoredImageScope, RestoredImageBucket>,
    session_boundaries: HashMap<(String, String, u64), ImageSessionBoundary>,
    connection_revision: u64,
}

/// Queue-local acceptance boundary, updated by canonical Session acceptance.
/// Explicit clearing revokes the request; navigation instead orders its receipt.
#[derive(Default)]
struct ImageSessionBoundary {
    clear_revision: u64,
    changed_at: Option<crate::EventCursor>,
}

impl ImageSessionBoundary {
    fn permits(&self, runtime_generation: u64, sequence: Option<u64>) -> bool {
        self.changed_at.as_ref().is_none_or(|position| {
            position.runtime_generation == runtime_generation
                && sequence.is_some_and(|sequence| sequence > position.sequence)
        })
    }
}

fn image_session(scope: &RestoredImageScope) -> (String, String, u64) {
    (
        scope.host_epoch.clone(),
        scope.work_id.clone(),
        scope.runtime_generation,
    )
}

impl RestoredImageState {
    pub fn append(&self, scope: RestoredImageScope, images: Vec<ImagePath>) -> usize {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let buckets = &mut state.buckets;
        if !images.is_empty() {
            buckets
                .entry(scope.clone())
                .or_default()
                .batches
                .push(RestoredImageBatch {
                    cursor_sequence: None,
                    token: uuid::Uuid::new_v4().to_string(),
                    images,
                });
        }
        buckets.get(&scope).map_or(0, |bucket| {
            bucket.batches.iter().map(|batch| batch.images.len()).sum()
        })
    }

    pub fn capture(&self, scope: &RestoredImageScope) -> Option<RestoredImageCapture> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let buckets = &state.buckets;
        let bucket = buckets.get(scope)?;
        let capture = RestoredImageCapture {
            tokens: bucket
                .batches
                .iter()
                .map(|batch| batch.token.clone())
                .collect(),
            images: bucket
                .batches
                .iter()
                .flat_map(|batch| batch.images.iter().cloned())
                .collect(),
        };
        (!capture.images.is_empty()).then_some(capture)
    }

    pub fn clear_after_success(&self, scope: &RestoredImageScope, tokens: &[String]) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let buckets = &mut state.buckets;
        let remove_bucket = if let Some(bucket) = buckets.get_mut(scope) {
            bucket
                .batches
                .retain(|batch| !tokens.iter().any(|token| token == &batch.token));
            bucket.batches.is_empty()
        } else {
            false
        };
        if remove_bucket {
            buckets.remove(scope);
        }
    }

    pub fn clear_scope(&self, scope: &RestoredImageScope) -> usize {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .session_boundaries
            .entry(image_session(scope))
            .or_default()
            .clear_revision += 1;
        state.buckets.remove(scope).map_or(0, |bucket| {
            bucket.batches.iter().map(|batch| batch.images.len()).sum()
        })
    }

    /// Called only after core accepts a real Session/branch replacement.
    pub(crate) fn session_changed(&self, target: &InstanceSnapshot) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let epoch = &target.event_cursor.host_epoch;
        let work = &target.id;
        let generation = target.runtime_generation;
        let matches = |identity: &(String, String, u64)| {
            &identity.0 == epoch && &identity.1 == work && identity.2 <= generation
        };
        state
            .session_boundaries
            .entry((epoch.clone(), work.clone(), generation))
            .or_default();
        for (identity, boundary) in &mut state.session_boundaries {
            if matches(identity) {
                boundary.changed_at = Some(target.event_cursor.clone());
            }
        }
        let RestoredImages {
            buckets,
            session_boundaries,
            ..
        } = &mut *state;
        buckets.retain(|scope, bucket| {
            if !matches(&image_session(scope)) {
                return true;
            }
            // A receipt already known to follow this change belongs to the new
            // branch, even when the display/cache was behind when it arrived.
            bucket.batches.retain(|batch| {
                session_boundaries
                    .get(&image_session(scope))
                    .is_some_and(|boundary| {
                        boundary.permits(scope.runtime_generation, batch.cursor_sequence)
                    })
            });
            !bucket.batches.is_empty()
        });
    }

    pub fn rebind_generation(&self, connection_id: &str, old_generation: u64, new_generation: u64) {
        if old_generation == new_generation {
            return;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.connection_revision += 1;
        let buckets = &mut state.buckets;
        let preserved = buckets
            .drain()
            .filter(|(scope, _)| {
                scope.connection_id == connection_id && scope.selection_generation == old_generation
            })
            .collect::<Vec<_>>();
        for (old_scope, bucket) in preserved {
            buckets.insert(
                RestoredImageScope {
                    host_epoch: old_scope.host_epoch,
                    runtime_generation: old_scope.runtime_generation,
                    connection_id: old_scope.connection_id,
                    selection_generation: new_generation,
                    work_id: old_scope.work_id,
                },
                bucket,
            );
        }
    }

    pub fn clear(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.connection_revision += 1;
        state.buckets.clear();
        state.session_boundaries.clear();
    }
}

impl RestoredImageState {
    #[allow(clippy::too_many_arguments)]
    pub async fn submit(
        &self,
        client: &DockClient,
        attachments: &crate::AttachmentState,
        scope: &RestoredImageScope,
        authority: &str,
        message: &str,
        file_ids: &[String],
        operation_id: &str,
    ) -> Result<SubmitResult> {
        let captured = self.capture(scope);
        let uploads = attachments.capture_submission(
            authority,
            &scope.work_id,
            &scope.host_epoch,
            scope.runtime_generation,
            file_ids,
        );
        let images = captured
            .as_ref()
            .map_or(&[][..], |capture| capture.images.as_slice());
        let result = client
            .submit_message_with_attachments_and_images(
                &scope.work_id,
                message,
                file_ids,
                images,
                DeliveryMode::Auto,
                Some(operation_id),
            )
            .await?;
        if let Some(capture) = captured {
            self.clear_after_success(scope, &capture.tokens);
        }
        attachments.finish_submission(uploads);
        Ok(result)
    }
    pub async fn dequeue(
        &self,
        client: &DockClient,
        scope: RestoredImageScope,
        operation_id: &str,
    ) -> Result<QueueDequeueResult> {
        let work_id = scope.work_id.clone();
        self.take_back(scope, client.dequeue_messages(&work_id, Some(operation_id)))
            .await
    }

    /// Abort returns the Queue like `dequeue`, so its images follow the same rules.
    pub async fn abort_run(
        &self,
        client: &DockClient,
        scope: RestoredImageScope,
        operation_id: &str,
    ) -> Result<QueueDequeueResult> {
        let work_id = scope.work_id.clone();
        self.take_back(scope, client.abort_run(&work_id, Some(operation_id)))
            .await
    }

    async fn take_back(
        &self,
        scope: RestoredImageScope,
        request: impl std::future::Future<Output = Result<QueueDequeueResult>>,
    ) -> Result<QueueDequeueResult> {
        let identity = image_session(&scope);
        let version = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let revision = state
                .session_boundaries
                .entry(identity.clone())
                .or_default()
                .clear_revision;
            (state.connection_revision, revision)
        };
        let result = request.await?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let position = &result.instance.event_cursor;
        let boundary = state.session_boundaries.get(&identity);
        if version
            == (
                state.connection_revision,
                boundary.map_or(0, |boundary| boundary.clear_revision),
            )
            && position.host_epoch == scope.host_epoch
            && position.instance_id == scope.work_id
            && position.runtime_generation == scope.runtime_generation
            && boundary.is_none_or(|boundary| {
                boundary.permits(scope.runtime_generation, Some(position.sequence))
            })
        {
            let images: Vec<_> = result
                .receipt
                .restored
                .iter()
                .flat_map(|item| item.images.iter().cloned())
                .collect();
            if !images.is_empty() {
                state
                    .buckets
                    .entry(scope)
                    .or_default()
                    .batches
                    .push(RestoredImageBatch {
                        cursor_sequence: Some(result.instance.event_cursor.sequence),
                        token: uuid::Uuid::new_v4().to_string(),
                        images,
                    });
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod restored_images_tests {
    use super::*;
    #[test]
    fn restored_images_are_retained_until_matching_submit_success_or_explicit_clear() {
        let state = RestoredImageState::default();
        let scope = restored_image_scope("host", 3, "work", "epoch", 1);
        let first = ImagePath {
            path: "/native/first.png".into(),
            mime_type: "image/png".into(),
        };
        assert_eq!(state.append(scope.clone(), vec![first]), 1);
        let captured = state.capture(&scope).expect("captured restored image");
        assert!(
            state
                .capture(&restored_image_scope("host", 3, "work", "epoch", 2))
                .is_none(),
            "a new Session cannot reuse restored images from the previous runtime"
        );

        // A failed submit performs no clear, so the same batch remains available.
        assert_eq!(state.capture(&scope).unwrap().tokens, captured.tokens);

        // A later dequeue appends instead of discarding the earlier restored draft.
        // Success for the older submit clears only what that submit captured.
        let second = ImagePath {
            path: "/native/second.jpg".into(),
            mime_type: "image/jpeg".into(),
        };
        assert_eq!(state.append(scope.clone(), vec![second]), 2);
        state.clear_after_success(&scope, &captured.tokens);
        let replacement = state.capture(&scope).expect("newer batch retained");
        assert_eq!(replacement.images.len(), 1);
        assert_eq!(replacement.images[0].path, "/native/second.jpg");

        state.clear_after_success(&scope, &replacement.tokens);
        assert!(state.capture(&scope).is_none());
        state.append(
            scope.clone(),
            vec![ImagePath {
                path: "/native/third.webp".into(),
                mime_type: "image/webp".into(),
            }],
        );
        assert_eq!(state.append(scope.clone(), Vec::new()), 1);
        assert_eq!(state.clear_scope(&scope), 1);
        assert!(state.capture(&scope).is_none());
    }
    #[test]
    fn same_host_generation_rebind_preserves_only_that_hosts_restored_images() {
        let state = RestoredImageState::default();
        let old_scope = restored_image_scope("host-a", 3, "work", "epoch", 1);
        let new_scope = restored_image_scope("host-a", 4, "work", "epoch", 1);
        let other_scope = restored_image_scope("host-b", 3, "work", "epoch", 1);
        state.append(
            old_scope.clone(),
            vec![ImagePath {
                path: "/native/restored.png".into(),
                mime_type: "image/png".into(),
            }],
        );
        state.append(
            other_scope.clone(),
            vec![ImagePath {
                path: "/native/other.png".into(),
                mime_type: "image/png".into(),
            }],
        );

        state.rebind_generation("host-a", 3, 4);

        assert!(state.capture(&old_scope).is_none());
        assert_eq!(state.capture(&new_scope).unwrap().images.len(), 1);
        assert!(state.capture(&other_scope).is_none());
    }
}
