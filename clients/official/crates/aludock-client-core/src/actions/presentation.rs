//! Path-free values for client interfaces; native capabilities never leave core.
use super::*;
use crate::conversation::{ProjectedQueueItem, project_pending_message};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeQueueDequeueReceipt {
    pub instance_id: String,
    pub restored: Vec<ProjectedQueueItem>,
    pub in_flight: Vec<ProjectedQueueItem>,
}

#[derive(Serialize)]
pub struct SafeQueueDequeueResult {
    pub receipt: SafeQueueDequeueReceipt,
    pub instance: InstanceSnapshot,
}

pub fn project_queue_dequeue(result: QueueDequeueResult) -> SafeQueueDequeueResult {
    SafeQueueDequeueResult {
        receipt: SafeQueueDequeueReceipt {
            instance_id: result.receipt.instance_id,
            restored: result
                .receipt
                .restored
                .into_iter()
                .map(project_pending_message)
                .collect(),
            in_flight: result
                .receipt
                .in_flight
                .into_iter()
                .map(project_pending_message)
                .collect(),
        },
        instance: result.instance,
    }
}

pub fn restored_image_scope(
    connection_id: &str,
    selection_generation: u64,
    work_id: &str,
    host_epoch: &str,
    runtime_generation: u64,
) -> RestoredImageScope {
    RestoredImageScope {
        host_epoch: host_epoch.into(),
        runtime_generation,
        connection_id: connection_id.to_owned(),
        selection_generation,
        work_id: work_id.to_owned(),
    }
}
