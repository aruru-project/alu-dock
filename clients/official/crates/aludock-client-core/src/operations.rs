//! Only this App's outstanding operations and unconsumed receipts; not a Host ledger.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

/// Error classification is typed; presentation serialization is only for clients.
pub trait OperationFailure: Send + 'static {
    fn outcome_unknown(&self) -> bool;
    fn presentation(&self) -> Value;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationState {
    Pending,
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationAssociation {
    pub operation_id: String,
    pub kind: String,
    pub connection_id: String,
    pub instance_id: String,
    pub host_epoch: String,
    pub runtime_generation: u64,
    pub session_id: String,
    pub editor: Value,
    pub state: OperationState,
    pub result: Option<Value>,
    pub error: Option<Value>,
}
#[derive(Clone)]
pub struct OperationAssociations {
    entries: Arc<Mutex<BTreeMap<String, OperationAssociation>>>,
    updates: broadcast::Sender<OperationAssociation>,
}
impl Default for OperationAssociations {
    fn default() -> Self {
        Self {
            entries: Default::default(),
            updates: broadcast::channel(64).0,
        }
    }
}
impl OperationAssociations {
    pub fn subscribe(&self) -> broadcast::Receiver<OperationAssociation> {
        self.updates.subscribe()
    }
    pub fn pending(&self) -> Vec<OperationAssociation> {
        self.entries.lock().unwrap().values().cloned().collect()
    }
    pub fn consume(&self, id: &str) {
        let mut entries = self.entries.lock().unwrap();
        if entries.get(id).is_some_and(|entry| {
            entry.state == OperationState::Succeeded || entry.state == OperationState::Failed
        }) {
            entries.remove(id);
        }
    }
    /// Runs independently of the IPC waiter. Never retries a mutation, even when
    /// a WebView is gone or the result is unknown.
    pub async fn execute<T, E, F>(
        &self,
        mut association: OperationAssociation,
        operation: F,
    ) -> crate::Result<Result<T, E>>
    where
        T: Serialize + Send + 'static,
        E: OperationFailure,
        F: Future<Output = Result<T, E>> + Send + 'static,
    {
        association.state = OperationState::Pending;
        {
            let mut entries = self.entries.lock().unwrap();
            if entries
                .get(&association.operation_id)
                .is_some_and(|entry| entry.state != OperationState::Failed)
            {
                return Err(crate::ClientError::Protocol(
                    "operation is already associated; do not replay it".into(),
                ));
            }
            entries.insert(association.operation_id.clone(), association.clone());
        }
        let _ = self.updates.send(association.clone());
        let owner = self.clone();
        let operation_id = association.operation_id.clone();
        tokio::spawn(async move {
            // The coordinator survives both a dropped IPC waiter and an operation panic.
            let result = tokio::spawn(operation).await;
            let result = match result {
                Ok(result) => Ok(result),
                Err(_) => Err(crate::ClientError::EffectUnknown {
                    operation_id: association.operation_id.clone(),
                    message: "操作结果尚未确认，请查看当前工作状态，不要重复提交。".into(),
                }),
            };
            match &result {
                Ok(Ok(value)) => {
                    association.state = OperationState::Succeeded;
                    association.result = serde_json::to_value(value).ok();
                }
                Ok(Err(error)) => {
                    let value = error.presentation();
                    association.state = if !error.outcome_unknown() {
                        OperationState::Failed
                    } else {
                        OperationState::Unknown
                    };
                    association.error = Some(value);
                }
                Err(_) => {
                    association.state = OperationState::Unknown;
                    association.error = Some(serde_json::json!({
                        "code": "effect_unknown",
                        "message": "操作结果尚未确认，请查看当前工作状态，不要重复提交。",
                        "outcomeUnknown": true,
                        "operationId": association.operation_id,
                    }));
                }
            }
            owner
                .entries
                .lock()
                .unwrap()
                .insert(association.operation_id.clone(), association.clone());
            let _ = owner.updates.send(association);
            result
        })
        .await
        .map_err(|_| crate::ClientError::EffectUnknown {
            operation_id,
            message: "操作结果暂时无法读取，请查看当前工作状态，不要重复提交。".into(),
        })?
    }
}

impl OperationFailure for crate::ClientError {
    fn outcome_unknown(&self) -> bool {
        matches!(self, Self::EffectUnknown { .. })
    }
    fn presentation(&self) -> Value {
        serde_json::json!({"message": self.to_string(), "outcomeUnknown": self.outcome_unknown()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn interrupted_operation_finishes_as_unknown_instead_of_staying_pending() {
        let operations = OperationAssociations::default();
        let association = operation_association(
            "send",
            "submit_message",
            "local",
            "work",
            "epoch",
            1,
            Value::Null,
        );
        let result: crate::Result<Result<(), crate::ClientError>> = operations
            .execute(association, async { panic!("operation interrupted") })
            .await;
        assert!(matches!(
            result,
            Err(crate::ClientError::EffectUnknown { .. })
        ));
        assert_eq!(operations.pending()[0].state, OperationState::Unknown);
        operations.consume("send");
        assert_eq!(operations.pending().len(), 1);
    }
}

pub fn operation_association(
    id: &str,
    kind: &str,
    connection: &str,
    instance: &str,
    host_epoch: &str,
    runtime_generation: u64,
    editor: Value,
) -> crate::OperationAssociation {
    crate::OperationAssociation {
        operation_id: id.into(),
        kind: kind.into(),
        connection_id: connection.into(),
        instance_id: instance.into(),
        host_epoch: host_epoch.into(),
        runtime_generation,
        session_id: editor["sessionId"].as_str().unwrap_or_default().into(),
        editor,
        state: OperationState::Pending,
        result: None,
        error: None,
    }
}
