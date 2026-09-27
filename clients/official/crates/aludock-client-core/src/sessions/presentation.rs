//! Path-free values for client interfaces; native capabilities never leave core.
use super::*;
use crate::config::{SafeDiagnostic, SafeResource, project_source};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSessionReload {
    pub instance: InstanceSnapshot,
    pub resources: Vec<SafeResource>,
    pub diagnostics: Vec<SafeDiagnostic>,
    pub resource_total: u64,
    pub resources_truncated: bool,
    pub diagnostic_total: u64,
    pub diagnostics_truncated: bool,
}

pub fn project_session_reload(result: SessionReloadResult) -> SafeSessionReload {
    SafeSessionReload {
        instance: result.instance,
        resources: result
            .resources
            .into_iter()
            .map(|resource| SafeResource {
                kind: resource.kind,
                name: resource.name,
                source: resource.source.map(project_source),
                content_ref: resource.content_ref,
            })
            .collect(),
        diagnostics: result
            .diagnostics
            .into_iter()
            .map(|diagnostic| SafeDiagnostic {
                severity: diagnostic.severity,
                message: diagnostic.message,
            })
            .collect(),
        resource_total: result.resource_total,
        resources_truncated: result.resources_truncated,
        diagnostic_total: result.diagnostic_total,
        diagnostics_truncated: result.diagnostics_truncated,
    }
}
