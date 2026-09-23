//! Only this App's outstanding operations and unconsumed receipts; not a Host ledger.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

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
    pub state: String,
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
        if entries
            .get(id)
            .is_some_and(|entry| entry.state == "succeeded" || entry.state == "failed")
        {
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
        E: Serialize + Send + 'static,
        F: Future<Output = Result<T, E>> + Send + 'static,
    {
        association.state = "pending".into();
        {
            let mut entries = self.entries.lock().unwrap();
            if entries
                .get(&association.operation_id)
                .is_some_and(|entry| entry.state != "failed")
            {
                return Err(crate::ClientError::Protocol(
                    "operation is already associated; do not replay it".into(),
                ));
            }
            entries.insert(association.operation_id.clone(), association.clone());
        }
        let _ = self.updates.send(association.clone());
        let owner = self.clone();
        Ok(tokio::spawn(async move {
            let result = operation.await;
            match &result {
                Ok(value) => {
                    association.state = "succeeded".into();
                    association.result = serde_json::to_value(value).ok();
                }
                Err(error) => {
                    let value = serde_json::to_value(error).unwrap_or(Value::Null);
                    association.state = if value["outcomeUnknown"] == false {
                        "failed"
                    } else {
                        "unknown"
                    }
                    .into();
                    association.error = Some(value);
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
        .expect("native operation task panicked"))
    }
}
