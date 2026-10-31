use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    ActiveInteraction, ClientError, DockClient, Result,
    capabilities::{
        CATALOG_MAINTENANCE as FORGET_CAPABILITIES, INSTANCE_ADOPT as ADOPT_CAPABILITIES,
        INSTANCE_CATALOG as INSTANCE_CAPABILITIES, INSTANCE_REOPEN as REOPEN_CAPABILITIES,
        MACHINES as MACHINE_CAPABILITIES, WORKSPACE_LIST as WORKSPACE_CAPABILITIES,
    },
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstanceLifecycle {
    Active,
    Stopping,
    Stopped,
    HostLost,
    RuntimeError,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstanceExecution {
    Idle,
    Running,
    Failed,
    Unavailable,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCursor {
    pub host_epoch: String,
    pub instance_id: String,
    pub runtime_generation: u64,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCounts {
    pub steering: u64,
    pub follow_up: u64,
    pub total: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdentity {
    pub provider: String,
    pub id: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorSnapshot {
    pub kind: String,
    pub version: Option<String>,
    pub pi_session_id: String,
    #[serde(skip_serializing)]
    pub session_file: Option<String>,
    pub model: Option<ModelIdentity>,
    pub thinking_level: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSnapshot {
    pub parent_id: Option<String>,
    pub id: String,
    pub creation_operation_id: String,
    pub host_id: Option<String>,
    pub key: Option<String>,
    pub name: Option<String>,
    pub display_name: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub lifecycle: InstanceLifecycle,
    pub execution: InstanceExecution,
    pub compacting: bool,
    pub last_run: String,
    pub reopenable: bool,
    pub runtime_generation: u64,
    pub owner_host_epoch: Option<String>,
    pub interruption: Option<Value>,
    pub pending: PendingCounts,
    pub executor: ExecutorSnapshot,
    pub metrics: Option<Value>,
    #[serde(default)]
    pub extension_status: BTreeMap<String, String>,
    pub tools_expanded: bool,
    pub active_interaction: Option<ActiveInteraction>,
    pub active_command_id: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub execution_changed_at: String,
    pub run_started_at: Option<String>,
    pub event_cursor: EventCursor,
}

impl InstanceSnapshot {
    pub fn validate(&self) -> Result<()> {
        if self.runtime_generation == 0
            || self.host_id.as_ref().is_some_and(String::is_empty)
            || self.event_cursor.instance_id != self.id
            || self.event_cursor.runtime_generation != self.runtime_generation
        {
            return Err(ClientError::Protocol(
                "instance snapshot cursor identity was invalid".into(),
            ));
        }
        if let Some(owner) = &self.owner_host_epoch
            && (&self.event_cursor.host_epoch != owner)
        {
            return Err(ClientError::Protocol(
                "instance cursor did not match its Host owner".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstanceSelector {
    Actionable,
    All,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceListParams {
    selector: InstanceSelector,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<InstanceListCursor>,
    limit: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceListCursor {
    revision: u64,
    offset: u64,
    selector: InstanceSelector,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceListResult {
    instances: Vec<InstanceSnapshot>,
    page: InstanceListPage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceListPage {
    revision: u64,
    total: u64,
    hidden_stopped: u64,
    next_cursor: Option<InstanceListCursor>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceCatalog {
    pub instances: Vec<InstanceSnapshot>,
    pub total: u64,
    pub hidden_stopped: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MachineKind {
    Main,
    Subhost,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MachinePlatform {
    Linux,
    Windows,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub host_id: String,
    pub name: String,
    pub kind: MachineKind,
    pub available: bool,
    pub platform: Option<MachinePlatform>,
    pub home_path: Option<String>,
    pub workspace_roots: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct MachinesResult {
    machines: Vec<Machine>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceEntryKind {
    Directory,
    Symlink,
    /// Any value this client build does not know; newer Hosts may add values.
    #[serde(other)]
    Unrecognized,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkspaceEntry {
    pub name: String,
    pub kind: WorkspaceEntryKind,
    pub hidden: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePage {
    pub path: String,
    pub parent: Option<String>,
    pub revision: String,
    pub entries: Vec<WorkspaceEntry>,
    pub total: u64,
    pub truncated: bool,
    pub next_cursor: Option<WorkspaceCursor>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCursor {
    revision: String,
    offset: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceListParams<'a> {
    path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a WorkspaceCursor>,
    limit: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateInstanceParams<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worker_config: Option<&'a serde_json::Map<String, Value>>,
    operation_id: &'a str,
    cwd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trust_challenge_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_trust_decision: Option<ProjectTrustDecision>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdoptInstanceParams<'a> {
    operation_id: &'a str,
    session_file: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trust_challenge_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_trust_decision: Option<ProjectTrustDecision>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectTrustDecision {
    TrustOnce,
    TrustAndRemember,
    DenyOnce,
    DenyAndRemember,
}

#[derive(Debug, Deserialize)]
struct InstanceResult {
    instance: InstanceSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceMutationParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReopenInstanceParams<'a> {
    operation_id: &'a str,
    instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    trust_challenge_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_trust_decision: Option<ProjectTrustDecision>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopReceipt {
    pub operation_id: String,
    pub already_stopped: bool,
    pub cleanup_errors: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StopResult {
    pub receipt: StopReceipt,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenResult {
    pub operation_id: String,
    pub previous_lifecycle: InstanceLifecycle,
    pub instance: InstanceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetReceipt {
    pub operation_id: String,
    pub forgotten_id: String,
    pub previous_lifecycle: InstanceLifecycle,
    pub pi_session_files_deleted: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ForgetResult {
    pub receipt: ForgetReceipt,
}

impl DockClient {
    pub async fn list_machines(&self) -> Result<Vec<Machine>> {
        let result: MachinesResult = self
            .request(
                "machine.list",
                &serde_json::json!({}),
                MACHINE_CAPABILITIES,
                None,
            )
            .await?;
        let mut identities = HashSet::new();
        let mut main_count = 0;
        for machine in &result.machines {
            if machine.host_id.is_empty()
                || machine.name.is_empty()
                || !identities.insert(&machine.host_id)
            {
                return Err(ClientError::Protocol(
                    "machine list contained an invalid or duplicate identity".into(),
                ));
            }
            if machine.kind == MachineKind::Main {
                main_count += 1;
            }
            if let Some(roots) = &machine.workspace_roots {
                let valid = machine.platform.is_some_and(|platform| {
                    !roots.is_empty()
                        && roots
                            .iter()
                            .all(|root| machine_workspace_root_is_valid(root, platform))
                });
                if !valid {
                    return Err(ClientError::Protocol(
                        "machine list contained invalid workspace roots".into(),
                    ));
                }
            }
        }
        if result.machines.is_empty() || main_count != 1 {
            return Err(ClientError::Protocol(
                "machine list did not contain exactly one Main".into(),
            ));
        }
        Ok(result.machines)
    }

    pub async fn list_instances(&self, selector: InstanceSelector) -> Result<InstanceCatalog> {
        self.list_instances_with_host_epoch(selector)
            .await
            .map(|(catalog, _)| catalog)
    }

    pub async fn list_instances_with_host_epoch(
        &self,
        selector: InstanceSelector,
    ) -> Result<(InstanceCatalog, String)> {
        let mut cursor = None;
        let mut instances = Vec::new();
        let mut scan_identity = None;
        let mut scan_host_epoch: Option<String> = None;
        loop {
            let (result, host_epoch): (InstanceListResult, String) = self
                .request_with_host_epoch(
                    "instance.list",
                    &InstanceListParams {
                        selector,
                        cursor: cursor.clone(),
                        limit: 100,
                    },
                    INSTANCE_CAPABILITIES,
                    None,
                )
                .await?;
            if let Some(expected) = &scan_host_epoch
                && expected != &host_epoch
            {
                return Err(ClientError::Protocol(
                    "Host epoch changed during instance catalog pagination".into(),
                ));
            }
            scan_host_epoch = Some(host_epoch);
            for instance in &result.instances {
                instance.validate()?;
            }
            let identity = (
                result.page.revision,
                result.page.total,
                result.page.hidden_stopped,
            );
            if let Some(expected) = scan_identity
                && expected != identity
            {
                return Err(ClientError::Protocol(
                    "instance catalog changed during pagination".into(),
                ));
            }
            scan_identity = Some(identity);
            instances.extend(result.instances);
            cursor = result.page.next_cursor;
            if cursor.is_none() {
                return Ok((
                    InstanceCatalog {
                        instances,
                        total: result.page.total,
                        hidden_stopped: result.page.hidden_stopped,
                    },
                    scan_host_epoch.ok_or_else(|| {
                        ClientError::Protocol("instance catalog omitted its Host epoch".into())
                    })?,
                ));
            }
        }
    }

    pub async fn list_workspace(
        &self,
        path: &str,
        cursor: Option<&WorkspaceCursor>,
    ) -> Result<WorkspacePage> {
        self.list_workspace_for_machine(path, cursor, None).await
    }

    pub async fn list_workspace_for_machine(
        &self,
        path: &str,
        cursor: Option<&WorkspaceCursor>,
        target_host_id: Option<&str>,
    ) -> Result<WorkspacePage> {
        let page: WorkspacePage = self
            .request(
                "workspace.list",
                &WorkspaceListParams {
                    path,
                    cursor,
                    limit: 200,
                    host_id: target_host_id,
                },
                WORKSPACE_CAPABILITIES,
                None,
            )
            .await?;
        if page.truncated != page.next_cursor.is_some() {
            return Err(ClientError::Protocol(
                "workspace page truncation state was inconsistent".into(),
            ));
        }
        Ok(page)
    }

    pub async fn create_instance(
        &self,
        cwd: &str,
        name: Option<&str>,
        continuation: Option<(&str, ProjectTrustDecision)>,
        operation_id: Option<&str>,
    ) -> Result<InstanceSnapshot> {
        self.create_instance_for_machine(cwd, name, continuation, operation_id, None, None, None)
            .await
    }

    pub async fn create_instance_for_machine(
        &self,
        cwd: &str,
        name: Option<&str>,
        continuation: Option<(&str, ProjectTrustDecision)>,
        operation_id: Option<&str>,
        target_host_id: Option<&str>,
        worker_config: Option<&serde_json::Map<String, Value>>,
        parent_id: Option<&str>,
    ) -> Result<InstanceSnapshot> {
        let generated_operation_id = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated_operation_id);
        let (trust_challenge_id, project_trust_decision) = continuation
            .map(|(challenge, decision)| (Some(challenge), Some(decision)))
            .unwrap_or((None, None));
        let required_capabilities =
            crate::capabilities::instance_create(worker_config.is_some(), parent_id.is_some());
        let result: InstanceResult = self
            .request(
                "instance.create",
                &CreateInstanceParams {
                    parent_id,
                    operation_id,
                    worker_config,
                    cwd,
                    name,
                    host_id: target_host_id,
                    trust_challenge_id,
                    project_trust_decision,
                },
                &required_capabilities,
                Some(operation_id),
            )
            .await?;
        result
            .instance
            .validate()
            .map_err(|error| ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: error.to_string(),
            })?;
        if result.instance.creation_operation_id != operation_id
            || result.instance.parent_id.as_deref() != parent_id
            || target_host_id
                .is_some_and(|target| result.instance.host_id.as_deref() != Some(target))
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "created Work did not correlate to the requested operation and Machine"
                    .into(),
            });
        }
        Ok(result.instance)
    }

    pub async fn adopt_instance_for_machine(
        &self,
        session_file: &str,
        name: Option<&str>,
        continuation: Option<(&str, ProjectTrustDecision)>,
        operation_id: Option<&str>,
        target_host_id: Option<&str>,
        expected_host_epoch: &str,
    ) -> Result<InstanceSnapshot> {
        let generated_operation_id = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated_operation_id);
        let (trust_challenge_id, project_trust_decision) = continuation
            .map(|(challenge, decision)| (Some(challenge), Some(decision)))
            .unwrap_or((None, None));
        let result: InstanceResult = self
            .request_on_host_epoch(
                "instance.adopt",
                &AdoptInstanceParams {
                    operation_id,
                    session_file,
                    name,
                    host_id: target_host_id,
                    trust_challenge_id,
                    project_trust_decision,
                },
                ADOPT_CAPABILITIES,
                Some(operation_id),
                expected_host_epoch,
            )
            .await?;
        result
            .instance
            .validate()
            .map_err(|error| ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: error.to_string(),
            })?;
        if result.instance.creation_operation_id != operation_id
            || result.instance.executor.session_file.as_deref() != Some(session_file)
            || target_host_id
                .is_some_and(|target| result.instance.host_id.as_deref() != Some(target))
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "adopted Work did not correlate to the requested operation, Session, and Machine"
                    .into(),
            });
        }
        Ok(result.instance)
    }

    pub async fn stop_instance(
        &self,
        instance_id: &str,
        operation_id: Option<&str>,
    ) -> Result<StopResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: StopResult = self
            .request(
                "instance.stop",
                &InstanceMutationParams {
                    operation_id,
                    instance_id,
                },
                INSTANCE_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        validate_stop_result(result, instance_id, operation_id)
    }

    pub async fn reopen_instance(
        &self,
        instance_id: &str,
        continuation: Option<(&str, ProjectTrustDecision)>,
        operation_id: Option<&str>,
    ) -> Result<ReopenResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let (trust_challenge_id, project_trust_decision) = continuation
            .map(|(challenge, decision)| (Some(challenge), Some(decision)))
            .unwrap_or((None, None));
        let result: ReopenResult = self
            .request(
                "instance.reopen",
                &ReopenInstanceParams {
                    operation_id,
                    instance_id,
                    trust_challenge_id,
                    project_trust_decision,
                },
                REOPEN_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        result
            .instance
            .validate()
            .map_err(|error| mutation_unknown(operation_id, error))?;
        if result.operation_id != operation_id || result.instance.id != instance_id {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "reopen response did not prove a fresh, correlated Work generation".into(),
            });
        }
        Ok(result)
    }

    pub async fn forget_instance(
        &self,
        instance_id: &str,
        operation_id: Option<&str>,
    ) -> Result<ForgetResult> {
        let generated = Uuid::new_v4().to_string();
        let operation_id = operation_id.unwrap_or(&generated);
        let result: ForgetResult = self
            .request(
                "instance.forget",
                &InstanceMutationParams {
                    operation_id,
                    instance_id,
                },
                FORGET_CAPABILITIES,
                Some(operation_id),
            )
            .await?;
        if result.receipt.operation_id != operation_id || result.receipt.forgotten_id != instance_id
        {
            return Err(ClientError::EffectUnknown {
                operation_id: operation_id.to_owned(),
                message: "forget response did not prove safe catalog-only removal".into(),
            });
        }
        Ok(result)
    }
}

fn validate_stop_result(
    result: StopResult,
    instance_id: &str,
    operation_id: &str,
) -> Result<StopResult> {
    result
        .instance
        .validate()
        .map_err(|error| mutation_unknown(operation_id, error))?;
    if result.receipt.operation_id != operation_id || result.instance.id != instance_id {
        return Err(ClientError::EffectUnknown {
            operation_id: operation_id.to_owned(),
            message: "stop response did not prove a correlated stopped Work".into(),
        });
    }
    Ok(result)
}

fn machine_workspace_root_is_valid(root: &str, platform: MachinePlatform) -> bool {
    match platform {
        MachinePlatform::Linux => root == "/",
        MachinePlatform::Windows => {
            let bytes = root.as_bytes();
            bytes.len() == 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/')
        }
        // A platform this build does not know has a root shape it cannot judge.
        MachinePlatform::Unrecognized => !root.is_empty(),
    }
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

    fn stopped_result(operation_id: &str, cleanup_errors: Option<Vec<String>>) -> StopResult {
        StopResult {
            receipt: StopReceipt {
                operation_id: operation_id.into(),
                already_stopped: false,
                cleanup_errors,
            },
            instance: InstanceSnapshot {
                parent_id: None,
                id: "work".into(),
                creation_operation_id: "created".into(),
                host_id: None,
                key: None,
                name: None,
                display_name: "Work".into(),
                cwd: "/tmp".into(),
                git_branch: None,
                lifecycle: InstanceLifecycle::Stopped,
                execution: InstanceExecution::Unavailable,
                compacting: false,
                last_run: "aborted".into(),
                reopenable: false,
                runtime_generation: 1,
                owner_host_epoch: None,
                interruption: None,
                pending: PendingCounts {
                    steering: 0,
                    follow_up: 0,
                    total: 0,
                },
                executor: ExecutorSnapshot {
                    kind: "pi".into(),
                    version: None,
                    pi_session_id: "session".into(),
                    session_file: Some("/sessions/session.jsonl".into()),
                    model: None,
                    thinking_level: None,
                },
                metrics: None,
                extension_status: BTreeMap::new(),
                tools_expanded: false,
                active_interaction: None,
                active_command_id: None,
                last_error: None,
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:01Z".into(),
                execution_changed_at: "2026-01-01T00:00:01Z".into(),
                run_started_at: None,
                event_cursor: EventCursor {
                    host_epoch: "old-epoch".into(),
                    instance_id: "work".into(),
                    runtime_generation: 1,
                    sequence: 8,
                },
            },
        }
    }

    #[test]
    fn snapshot_serialization_does_not_expose_session_file() {
        let value = serde_json::to_value(stopped_result("operation", None).instance).unwrap();
        assert!(value["executor"].get("sessionFile").is_none());
        assert!(!value.to_string().contains("/sessions/session.jsonl"));
    }

    #[test]
    fn machine_response_preserves_host_workspace_roots() {
        let result: MachinesResult = serde_json::from_value(serde_json::json!({
            "machines": [{
                "hostId": "windows-host",
                "name": "Windows",
                "kind": "subhost",
                "available": true,
                "platform": "windows",
                "homePath": "C:\\Users\\alice",
                "workspaceRoots": ["C:\\", "D:\\"]
            }]
        }))
        .unwrap();
        assert_eq!(
            result.machines[0].workspace_roots.as_deref().unwrap(),
            &["C:\\".to_owned(), "D:\\".to_owned()]
        );
        assert!(machine_workspace_root_is_valid(
            "D:\\",
            MachinePlatform::Windows
        ));
        assert!(!machine_workspace_root_is_valid(
            "D:\\projects",
            MachinePlatform::Windows
        ));
    }

    #[test]
    fn machine_target_is_carried_by_directory_browsing_and_work_creation() {
        let workspace = serde_json::to_value(WorkspaceListParams {
            path: "/",
            cursor: None,
            limit: 200,
            host_id: Some("subhost-a"),
        })
        .unwrap();
        assert_eq!(
            workspace,
            serde_json::json!({ "path": "/", "limit": 200, "hostId": "subhost-a" })
        );

        let creation = serde_json::to_value(CreateInstanceParams {
            parent_id: Some("coordinator"),
            operation_id: "operation-a",
            cwd: "/project",
            name: None,
            worker_config: None,
            host_id: Some("subhost-a"),
            trust_challenge_id: None,
            project_trust_decision: None,
        })
        .unwrap();
        assert_eq!(
            creation,
            serde_json::json!({
                "operationId": "operation-a",
                "parentId": "coordinator",
                "cwd": "/project",
                "hostId": "subhost-a"
            })
        );

        let adoption = serde_json::to_value(AdoptInstanceParams {
            operation_id: "operation-b",
            session_file: "C:\\sessions\\saved.jsonl",
            name: None,
            host_id: Some("subhost-a"),
            trust_challenge_id: None,
            project_trust_decision: None,
        })
        .unwrap();
        assert_eq!(
            adoption,
            serde_json::json!({
                "operationId": "operation-b",
                "sessionFile": "C:\\sessions\\saved.jsonl",
                "hostId": "subhost-a"
            })
        );
    }

    #[test]
    fn stop_validation_accepts_correlated_stopped_snapshot_and_keeps_cleanup_errors() {
        let result = validate_stop_result(
            stopped_result("operation", Some(vec!["cleanup failed".into()])),
            "work",
            "operation",
        )
        .unwrap();
        assert_eq!(
            result.receipt.cleanup_errors.unwrap(),
            vec!["cleanup failed"]
        );
    }

    #[test]
    fn stop_validation_turns_uncorrelated_receipt_into_effect_unknown() {
        let error =
            validate_stop_result(stopped_result("other", None), "work", "operation").unwrap_err();
        assert!(
            matches!(error, ClientError::EffectUnknown { operation_id, .. } if operation_id == "operation")
        );
    }
}
