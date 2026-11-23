//! Path-free values for client interfaces; native capabilities never leave core.
use super::*;
use crate::config::{SafeResourcesResult, project_resources};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSessionReload {
    pub instance: InstanceSnapshot,
    #[serde(flatten)]
    pub projection: SafeResourcesResult,
}

pub fn project_session_reload(result: SessionReloadResult) -> SafeSessionReload {
    SafeSessionReload {
        instance: result.instance,
        projection: project_resources(result.projection),
    }
}
