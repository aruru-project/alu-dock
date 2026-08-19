use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{ClientError, Endpoint, IdentityStore, Result, host_info};

const PROFILE_DIRECTORY: &str = "connection-profile-history";
const PROFILE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionKind {
    Local,
    Remote,
    Vpn,
    Manual,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointState {
    DraftUnverified,
    Verified,
    Disabled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointTestStatus {
    pub tested_at: String,
    pub succeeded: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEndpoint {
    pub id: String,
    pub label: String,
    pub kind: ConnectionKind,
    pub endpoint: Endpoint,
    pub state: EndpointState,
    pub verified_at: Option<String>,
    pub last_success_at: Option<String>,
    #[serde(default)]
    pub disabled_from: Option<EndpointState>,
    #[serde(default)]
    pub last_manual_test: Option<EndpointTestStatus>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointTestResult {
    pub profile: HostConnectionProfile,
    pub endpoint_id: String,
    pub succeeded: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ConnectionPolicy {
    Automatic,
    Fixed { endpoint_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConnectionProfile {
    pub schema_version: u32,
    pub revision: u64,
    pub host_id: String,
    pub display_name: String,
    pub endpoints: Vec<HostEndpoint>,
    pub policy: ConnectionPolicy,
    pub last_successful_endpoint_id: Option<String>,
}

impl HostConnectionProfile {
    pub fn ordered_verified_endpoints(&self) -> Vec<&HostEndpoint> {
        let fixed = match &self.policy {
            ConnectionPolicy::Automatic => None,
            ConnectionPolicy::Fixed { endpoint_id } => Some(endpoint_id.as_str()),
        };
        let mut endpoints = self
            .endpoints
            .iter()
            .filter(|candidate| candidate.state == EndpointState::Verified)
            .collect::<Vec<_>>();
        endpoints.sort_by_key(|candidate| {
            let fixed_rank = usize::from(fixed.is_some_and(|id| id != candidate.id));
            let kind_rank = match candidate.kind {
                ConnectionKind::Local => 0,
                ConnectionKind::Vpn => 1,
                ConnectionKind::Remote => 2,
                ConnectionKind::Manual => 3,
            };
            let last_success_rank = usize::from(
                self.last_successful_endpoint_id.as_deref() != Some(candidate.id.as_str()),
            );
            // `sort_by_key` is stable, so the user-controlled profile order is
            // retained after kind and last-success routing preferences.
            (fixed_rank, kind_rank, last_success_rank)
        });
        endpoints
    }

    fn validate(&self, expected_host_id: &str) -> Result<()> {
        if self.schema_version != PROFILE_SCHEMA_VERSION
            || self.revision == 0
            || self.host_id != expected_host_id
            || !safe_label(&self.display_name, 128)
            || self.endpoints.is_empty()
        {
            return Err(ClientError::InvalidPairing(
                "stored Host connection profile is invalid".into(),
            ));
        }
        let mut ids = HashSet::new();
        let mut locators = HashSet::new();
        for endpoint in &self.endpoints {
            if Uuid::parse_str(&endpoint.id).is_err()
                || !ids.insert(endpoint.id.as_str())
                || !locators.insert(endpoint.endpoint.to_string())
                || !safe_label(&endpoint.label, 128)
                || (endpoint.state == EndpointState::Verified
                    && endpoint.verified_at.as_deref().is_some_and(str::is_empty))
                || endpoint.disabled_from == Some(EndpointState::Disabled)
                || (endpoint.state != EndpointState::Disabled && endpoint.disabled_from.is_some())
                || endpoint.last_manual_test.as_ref().is_some_and(|test| {
                    OffsetDateTime::parse(&test.tested_at, &Rfc3339).is_err()
                        || !safe_label(&test.reason, 256)
                })
            {
                return Err(ClientError::InvalidPairing(
                    "stored Host address entry is invalid or duplicated".into(),
                ));
            }
        }
        if !self
            .endpoints
            .iter()
            .any(|endpoint| endpoint.state == EndpointState::Verified)
        {
            return Err(ClientError::InvalidPairing(
                "Host connection profile must retain an enabled verified address".into(),
            ));
        }
        if let ConnectionPolicy::Fixed { endpoint_id } = &self.policy
            && !self.endpoints.iter().any(|candidate| {
                candidate.id == *endpoint_id && candidate.state == EndpointState::Verified
            })
        {
            return Err(ClientError::InvalidPairing(
                "fixed Host address is not enabled and verified".into(),
            ));
        }
        if let Some(endpoint_id) = &self.last_successful_endpoint_id
            && !ids.contains(endpoint_id.as_str())
        {
            return Err(ClientError::InvalidPairing(
                "last successful Host address no longer exists".into(),
            ));
        }
        Ok(())
    }
}

impl IdentityStore {
    pub fn load_connection_profile(&self) -> Result<Option<HostConnectionProfile>> {
        if !self.is_paired() {
            return Ok(None);
        }
        let paired = self.load_pairing()?;
        let host_id = host_id(&paired.host_certificate);
        let directory = self.root().join(PROFILE_DIRECTORY);
        if let Some(profile) = load_latest_profile(&directory, &host_id)? {
            return Ok(Some(profile));
        }
        ensure_private_directory(&directory)?;
        let profile = HostConnectionProfile {
            schema_version: PROFILE_SCHEMA_VERSION,
            revision: 1,
            host_id,
            display_name: "AluDock".into(),
            endpoints: vec![HostEndpoint {
                id: Uuid::new_v4().to_string(),
                label: "局域网".into(),
                kind: ConnectionKind::Local,
                endpoint: paired.metadata.endpoint,
                state: EndpointState::Verified,
                verified_at: None,
                last_success_at: None,
                disabled_from: None,
                last_manual_test: None,
            }],
            policy: ConnectionPolicy::Automatic,
            last_successful_endpoint_id: None,
        };
        if !write_profile(&directory, &profile)? {
            return load_latest_profile(&directory, &profile.host_id);
        }
        Ok(Some(profile))
    }

    pub fn update_connection_profile<F>(&self, update: F) -> Result<HostConnectionProfile>
    where
        F: FnOnce(&mut HostConnectionProfile) -> Result<()>,
    {
        let revision = self
            .load_connection_profile()?
            .ok_or_else(|| {
                ClientError::InvalidPairing(
                    "pair with an AluDock before editing its addresses".into(),
                )
            })?
            .revision;
        self.update_connection_profile_at(revision, update)
    }

    pub fn update_connection_profile_at<F>(
        &self,
        expected_revision: u64,
        update: F,
    ) -> Result<HostConnectionProfile>
    where
        F: FnOnce(&mut HostConnectionProfile) -> Result<()>,
    {
        let mut profile = self.load_connection_profile()?.ok_or_else(|| {
            ClientError::InvalidPairing("pair with an AluDock before editing its addresses".into())
        })?;
        if profile.revision != expected_revision {
            return Err(ClientError::ProfileConflict {
                expected: expected_revision,
                actual: profile.revision,
            });
        }
        update(&mut profile)?;
        profile.revision = profile.revision.checked_add(1).ok_or_else(|| {
            ClientError::InvalidPairing("Host connection profile revision overflowed".into())
        })?;
        profile.validate(&profile.host_id)?;
        let directory = self.root().join(PROFILE_DIRECTORY);
        if let Some(latest) = load_latest_profile(&directory, &profile.host_id)?
            && latest.revision != expected_revision
        {
            return Err(ClientError::ProfileConflict {
                expected: expected_revision,
                actual: latest.revision,
            });
        }
        if !write_profile(&directory, &profile)? {
            let actual = load_latest_profile(&directory, &profile.host_id)?
                .map_or(expected_revision, |latest| latest.revision);
            return Err(ClientError::ProfileConflict {
                expected: expected_revision,
                actual,
            });
        }
        cleanup_old_profiles(&directory, profile.revision)?;
        Ok(profile)
    }
}

pub fn save_unverified_endpoint(
    store: &IdentityStore,
    endpoint: Endpoint,
    label: &str,
    kind: ConnectionKind,
    expected_revision: u64,
) -> Result<HostConnectionProfile> {
    validate_label(label)?;
    store.update_connection_profile_at(expected_revision, |profile| {
        if profile
            .endpoints
            .iter()
            .any(|candidate| candidate.endpoint == endpoint)
        {
            return Err(ClientError::InvalidEndpoint(
                "this Host address is already saved".into(),
            ));
        }
        profile.endpoints.push(HostEndpoint {
            id: Uuid::new_v4().to_string(),
            label: label.to_owned(),
            kind,
            endpoint,
            state: EndpointState::DraftUnverified,
            verified_at: None,
            last_success_at: None,
            disabled_from: None,
            last_manual_test: None,
        });
        Ok(())
    })
}

pub async fn probe_host_endpoint(store: &IdentityStore, endpoint: &Endpoint) -> Result<()> {
    // This Protocol V2 probe uses the existing exact Host pin. A wrong
    // address can never become part of the profile merely because TLS answers.
    host_info(store, Some(endpoint.clone())).await.map(|_| ())
}

pub fn save_verified_endpoint(
    store: &IdentityStore,
    endpoint: Endpoint,
    label: &str,
    kind: ConnectionKind,
    expected_revision: u64,
) -> Result<HostConnectionProfile> {
    validate_label(label)?;
    let tested_at = now();
    store.update_connection_profile_at(expected_revision, |profile| {
        if profile
            .endpoints
            .iter()
            .any(|candidate| candidate.endpoint == endpoint)
        {
            return Err(ClientError::InvalidEndpoint(
                "this Host address is already saved; test the existing entry instead".into(),
            ));
        }
        profile.endpoints.push(HostEndpoint {
            id: Uuid::new_v4().to_string(),
            label: label.to_owned(),
            kind,
            endpoint,
            state: EndpointState::Verified,
            verified_at: Some(tested_at.clone()),
            last_success_at: None,
            disabled_from: None,
            last_manual_test: Some(EndpointTestStatus {
                tested_at,
                succeeded: true,
                reason: "已验证为当前配对的 AluDock。".into(),
            }),
        });
        Ok(())
    })
}

pub fn saved_endpoint_for_test(
    store: &IdentityStore,
    endpoint_id: &str,
    expected_revision: u64,
) -> Result<Endpoint> {
    let profile = store.load_connection_profile()?.ok_or_else(|| {
        ClientError::InvalidPairing("pair with an AluDock before testing its addresses".into())
    })?;
    if profile.revision != expected_revision {
        return Err(ClientError::ProfileConflict {
            expected: expected_revision,
            actual: profile.revision,
        });
    }
    profile
        .endpoints
        .iter()
        .find(|candidate| candidate.id == endpoint_id)
        .map(|candidate| candidate.endpoint.clone())
        .ok_or_else(|| {
            ClientError::InvalidEndpoint("the selected Host address no longer exists".into())
        })
}

pub fn record_endpoint_test(
    store: &IdentityStore,
    endpoint_id: &str,
    expected_revision: u64,
    result: Result<()>,
) -> Result<EndpointTestResult> {
    let succeeded = result.is_ok();
    let reason = match result.as_ref().err() {
        None => "已验证为当前配对的 AluDock。",
        Some(ClientError::HostCertificateMismatch) => "这个地址不是当前配对的 AluDock。",
        Some(ClientError::Protocol(_) | ClientError::Host { .. }) => {
            "已连接到目标，但未能完成 AluDock 协议检查。"
        }
        Some(_) => "无法建立安全连接，请检查地址、端口和网络。",
    }
    .to_owned();
    let tested_at = now();
    let profile = store.update_connection_profile_at(expected_revision, |profile| {
        let endpoint = profile
            .endpoints
            .iter_mut()
            .find(|candidate| candidate.id == endpoint_id)
            .ok_or_else(|| {
                ClientError::InvalidEndpoint("the selected Host address no longer exists".into())
            })?;
        endpoint.last_manual_test = Some(EndpointTestStatus {
            tested_at: tested_at.clone(),
            succeeded,
            reason: reason.clone(),
        });
        if succeeded {
            match endpoint.state {
                EndpointState::DraftUnverified => endpoint.state = EndpointState::Verified,
                EndpointState::Disabled
                    if endpoint.disabled_from.is_none()
                        || endpoint.disabled_from == Some(EndpointState::DraftUnverified) =>
                {
                    // A successful exact-pin probe gives legacy disabled entries
                    // safe verified provenance without enabling them implicitly.
                    endpoint.disabled_from = Some(EndpointState::Verified);
                }
                _ => {}
            }
            endpoint.verified_at = Some(tested_at.clone());
        }
        Ok(())
    })?;
    Ok(EndpointTestResult {
        profile,
        endpoint_id: endpoint_id.to_owned(),
        succeeded,
        reason,
    })
}

fn validate_label(label: &str) -> Result<()> {
    if !safe_label(label, 128) {
        return Err(ClientError::InvalidEndpoint(
            "address label must be a safe non-empty name of at most 128 characters".into(),
        ));
    }
    Ok(())
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC3339 formatting cannot fail")
}

pub fn set_endpoint_enabled(
    store: &IdentityStore,
    endpoint_id: &str,
    enabled: bool,
    expected_revision: u64,
) -> Result<HostConnectionProfile> {
    store.update_connection_profile_at(expected_revision, |profile| {
        let index = profile
            .endpoints
            .iter()
            .position(|candidate| candidate.id == endpoint_id)
            .ok_or_else(|| ClientError::InvalidEndpoint("the selected Host address no longer exists".into()))?;
        if enabled {
            let endpoint = &mut profile.endpoints[index];
            if endpoint.state != EndpointState::Disabled {
                return Err(ClientError::InvalidEndpoint("the selected Host address is already enabled".into()));
            }
            let restored = endpoint.disabled_from.take().ok_or_else(|| {
                ClientError::InvalidEndpoint(
                    "this legacy disabled address has no safe prior state; verify it before enabling".into(),
                )
            })?;
            endpoint.state = restored;
        } else {
            let prior = profile.endpoints[index].state;
            if prior == EndpointState::Disabled {
                return Err(ClientError::InvalidEndpoint("the selected Host address is already disabled".into()));
            }
            if prior == EndpointState::Verified
                && profile
                    .endpoints
                    .iter()
                    .filter(|candidate| candidate.state == EndpointState::Verified)
                    .count()
                    <= 1
            {
                return Err(ClientError::InvalidEndpoint(
                    "at least one enabled verified Host address must remain".into(),
                ));
            }
            let endpoint = &mut profile.endpoints[index];
            endpoint.state = EndpointState::Disabled;
            endpoint.disabled_from = Some(prior);
            if matches!(
                &profile.policy,
                ConnectionPolicy::Fixed { endpoint_id: fixed } if fixed == endpoint_id
            ) {
                profile.policy = ConnectionPolicy::Automatic;
            }
        }
        Ok(())
    })
}

pub fn delete_endpoint(
    store: &IdentityStore,
    endpoint_id: &str,
    expected_revision: u64,
) -> Result<HostConnectionProfile> {
    store.update_connection_profile_at(expected_revision, |profile| {
        let before = profile.endpoints.len();
        profile
            .endpoints
            .retain(|candidate| candidate.id != endpoint_id);
        if profile.endpoints.len() == before {
            return Err(ClientError::InvalidEndpoint(
                "the selected Host address no longer exists".into(),
            ));
        }
        if !profile
            .endpoints
            .iter()
            .any(|candidate| candidate.state == EndpointState::Verified)
        {
            return Err(ClientError::InvalidEndpoint(
                "at least one enabled verified Host address must remain".into(),
            ));
        }
        if matches!(
            &profile.policy,
            ConnectionPolicy::Fixed { endpoint_id: fixed } if fixed == endpoint_id
        ) {
            profile.policy = ConnectionPolicy::Automatic;
        }
        if profile.last_successful_endpoint_id.as_deref() == Some(endpoint_id) {
            profile.last_successful_endpoint_id = None;
        }
        Ok(())
    })
}

pub fn reorder_endpoints(
    store: &IdentityStore,
    endpoint_ids: &[String],
    expected_revision: u64,
) -> Result<HostConnectionProfile> {
    store.update_connection_profile_at(expected_revision, |profile| {
        let requested = endpoint_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if endpoint_ids.len() != profile.endpoints.len()
            || requested.len() != endpoint_ids.len()
            || !profile
                .endpoints
                .iter()
                .all(|candidate| requested.contains(candidate.id.as_str()))
        {
            return Err(ClientError::InvalidEndpoint(
                "address order must contain every saved address exactly once".into(),
            ));
        }
        profile.endpoints.sort_by_key(|candidate| {
            endpoint_ids
                .iter()
                .position(|id| id == &candidate.id)
                .expect("validated endpoint order")
        });
        Ok(())
    })
}

pub fn set_connection_policy(
    store: &IdentityStore,
    policy: ConnectionPolicy,
    expected_revision: u64,
) -> Result<HostConnectionProfile> {
    store.update_connection_profile_at(expected_revision, |profile| {
        if let ConnectionPolicy::Fixed { endpoint_id } = &policy
            && !profile.endpoints.iter().any(|candidate| {
                candidate.id == *endpoint_id && candidate.state == EndpointState::Verified
            })
        {
            return Err(ClientError::InvalidEndpoint(
                "fixed address must be enabled and verified".into(),
            ));
        }
        profile.policy = policy;
        Ok(())
    })
}

pub fn host_id(host_certificate: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"aludock-host-profile-v1\0");
    digest.update(host_certificate);
    hex::encode(digest.finalize())
}

fn load_latest_profile(
    directory: &Path,
    expected_host_id: &str,
) -> Result<Option<HostConnectionProfile>> {
    if !directory.exists() {
        return Ok(None);
    }
    assert_private_directory(directory)?;
    let mut latest: Option<HostConnectionProfile> = None;
    for entry in fs::read_dir(directory).map_err(|source| storage_error(directory, source))? {
        let entry = entry.map_err(|source| storage_error(directory, source))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let metadata =
            fs::symlink_metadata(&path).map_err(|source| storage_error(&path, source))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ClientError::InvalidPairing(
                "Host connection profile is not a regular file".into(),
            ));
        }
        #[cfg(windows)]
        {
            crate::windows_security::secure_file(&path)
                .map_err(|source| storage_error(&path, source))?;
        }
        let bytes = fs::read(&path).map_err(|source| storage_error(&path, source))?;
        let profile: HostConnectionProfile = serde_json::from_slice(&bytes)?;
        profile.validate(expected_host_id)?;
        match &latest {
            Some(current) if current.revision == profile.revision => {
                return Err(ClientError::InvalidPairing(
                    "conflicting Host connection profile revisions were found".into(),
                ));
            }
            Some(current) if current.revision > profile.revision => {}
            _ => latest = Some(profile),
        }
    }
    Ok(latest)
}

fn write_profile(directory: &Path, profile: &HostConnectionProfile) -> Result<bool> {
    ensure_private_directory(directory)?;
    // The deterministic name is a cross-process compare-and-swap: exactly one
    // writer can publish a given revision with hard-link no-clobber semantics.
    let file_name = format!("profile-{:020}.json", profile.revision);
    let final_path = directory.join(file_name);
    let temporary = directory.join(format!(".{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(profile)?;
    write_new_private_file(&temporary, &bytes)?;
    match crate::fs_publish::publish_new_file(&temporary, &final_path) {
        Ok(true) => {
            sync_directory(directory)?;
            Ok(true)
        }
        Ok(false) => Ok(false),
        Err(source) => Err(storage_error(&final_path, source)),
    }
}

fn cleanup_old_profiles(directory: &Path, latest_revision: u64) -> Result<()> {
    let retain_from = latest_revision.saturating_sub(1);
    for entry in fs::read_dir(directory).map_err(|source| storage_error(directory, source))? {
        let entry = entry.map_err(|source| storage_error(directory, source))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let revision = name
            .strip_prefix("profile-")
            .and_then(|rest| rest.get(..20))
            .and_then(|value| value.parse::<u64>().ok());
        if revision.is_some_and(|revision| revision < retain_from) {
            fs::remove_file(&path).map_err(|source| storage_error(&path, source))?;
        }
    }
    sync_directory(directory)
}

fn safe_label(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}'
                )
        })
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(ClientError::InvalidPairing(
                    "Host profile path is not a real directory".into(),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|source| storage_error(path, source))?;
            let metadata =
                fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(ClientError::InvalidPairing(
                    "Host profile path is not a real directory".into(),
                ));
            }
        }
        Err(source) => return Err(storage_error(path, source)),
    }
    set_private_directory_permissions(path)?;
    assert_private_directory(path)
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|source| storage_error(path, source))?;
    file.write_all(bytes)
        .map_err(|source| storage_error(path, source))?;
    file.sync_all()
        .map_err(|source| storage_error(path, source))?;
    set_private_file_permissions(path)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|source| storage_error(path, source))
}

#[cfg(windows)]
fn set_private_directory_permissions(path: &Path) -> Result<()> {
    crate::windows_security::secure_directory(path).map_err(|source| storage_error(path, source))
}

#[cfg(all(not(unix), not(windows)))]
fn set_private_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(windows)]
fn set_private_file_permissions(path: &Path) -> Result<()> {
    crate::windows_security::secure_file(path).map_err(|source| storage_error(path, source))
}

#[cfg(all(not(unix), not(windows)))]
fn set_private_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn assert_private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(ClientError::InvalidPairing(format!(
            "Host profile directory must be private: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn assert_private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ClientError::InvalidPairing(format!(
            "Host profile path is not a directory: {}",
            path.display()
        )));
    }
    crate::windows_security::secure_directory(path)
        .and_then(|()| crate::windows_security::assert_private_directory(path))
        .map_err(|source| storage_error(path, source))
}

#[cfg(all(not(unix), not(windows)))]
fn assert_private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ClientError::InvalidPairing(format!(
            "Host profile path is not a directory: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| storage_error(path, source))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn storage_error(path: &Path, source: std::io::Error) -> ClientError {
    ClientError::Storage {
        path: path.display().to_string(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        ConnectionKind, ConnectionPolicy, EndpointState, HostEndpoint, delete_endpoint,
        load_latest_profile, record_endpoint_test, reorder_endpoints, save_unverified_endpoint,
        set_connection_policy, set_endpoint_enabled, write_profile,
    };
    use crate::{ClientError, ClientIdentity, Endpoint, IdentityStore};

    fn paired_store(name: &str) -> (std::path::PathBuf, IdentityStore) {
        let path = std::env::temp_dir().join(format!(
            "aludock-connections-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        let store = IdentityStore::new(&path);
        let identity = store.load_or_create_identity().expect("identity");
        let host = ClientIdentity::generate().expect("host certificate");
        let endpoint: Endpoint = "192.168.1.8:33781".parse().expect("endpoint");
        let client_id = store.client_id().expect("client id");
        store
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "Test device",
                &client_id,
            )
            .expect("pairing");
        (path, store)
    }

    #[test]
    fn migrates_single_endpoint_and_orders_local_before_remote() {
        let (path, store) = paired_store("migration");
        let initial = store
            .load_connection_profile()
            .expect("profile")
            .expect("paired profile");
        assert_eq!(initial.endpoints.len(), 1);
        assert_eq!(initial.endpoints[0].kind, ConnectionKind::Local);

        let remote: Endpoint = "dock.example:443".parse().expect("remote endpoint");
        let updated = store
            .update_connection_profile(|profile| {
                profile.endpoints.push(HostEndpoint {
                    id: uuid::Uuid::new_v4().to_string(),
                    label: "外网".into(),
                    kind: ConnectionKind::Remote,
                    endpoint: remote.clone(),
                    state: EndpointState::Verified,
                    verified_at: Some("2026-08-16T00:00:00Z".into()),
                    last_success_at: None,
                    disabled_from: None,
                    last_manual_test: None,
                });
                Ok(())
            })
            .expect("updated profile");
        let ordered = updated.ordered_verified_endpoints();
        assert_eq!(ordered[0].kind, ConnectionKind::Local);
        assert_eq!(ordered[1].kind, ConnectionKind::Remote);
        assert_eq!(updated.policy, ConnectionPolicy::Automatic);
        fs::remove_dir_all(path).expect("cleanup");
    }

    #[test]
    fn concurrent_revision_publication_has_one_winner_without_poisoning_the_profile() {
        let (path, store) = paired_store("concurrent-publication");
        let profile = store
            .load_connection_profile()
            .expect("profile")
            .expect("paired profile");
        let directory = store.root().join(super::PROFILE_DIRECTORY);
        let mut left = profile.clone();
        left.revision = 2;
        left.display_name = "Left".into();
        let mut right = profile.clone();
        right.revision = 2;
        right.display_name = "Right".into();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles = [left, right].map(|candidate| {
            let directory = directory.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                write_profile(&directory, &candidate).expect("publication")
            })
        });
        barrier.wait();
        let outcomes = handles.map(|handle| handle.join().expect("writer"));
        assert_eq!(outcomes.into_iter().filter(|won| *won).count(), 1);
        let loaded = load_latest_profile(&directory, &profile.host_id)
            .expect("non-poisoned journal")
            .expect("latest profile");
        assert_eq!(loaded.revision, 2);
        fs::remove_dir_all(path).expect("cleanup");
    }

    #[test]
    fn drafts_are_saved_without_becoming_connection_candidates() {
        let (path, store) = paired_store("draft-exclusion");
        let initial = store.load_connection_profile().unwrap().unwrap();
        let updated = save_unverified_endpoint(
            &store,
            "unreachable.example:443".parse().unwrap(),
            "以后验证",
            ConnectionKind::Remote,
            initial.revision,
        )
        .unwrap();
        assert_eq!(updated.endpoints[1].state, EndpointState::DraftUnverified);
        assert_eq!(updated.ordered_verified_endpoints().len(), 1);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn identity_mismatch_records_safe_failure_without_promoting_draft() {
        let (path, store) = paired_store("mismatch-metadata");
        let initial = store.load_connection_profile().unwrap().unwrap();
        let draft = save_unverified_endpoint(
            &store,
            "wrong.example:443".parse().unwrap(),
            "错误目标",
            ConnectionKind::Remote,
            initial.revision,
        )
        .unwrap();
        let draft_id = draft.endpoints[1].id.clone();
        let outcome = record_endpoint_test(
            &store,
            &draft_id,
            draft.revision,
            Err(ClientError::HostCertificateMismatch),
        )
        .unwrap();
        let endpoint = outcome
            .profile
            .endpoints
            .iter()
            .find(|candidate| candidate.id == draft_id)
            .unwrap();
        assert!(!outcome.succeeded);
        assert_eq!(endpoint.state, EndpointState::DraftUnverified);
        assert_eq!(outcome.reason, "这个地址不是当前配对的 AluDock。");
        assert_eq!(
            endpoint.last_manual_test.as_ref().unwrap().reason,
            outcome.reason
        );
        assert!(!outcome.reason.contains("certificate"));
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn disabling_or_deleting_fixed_route_falls_back_without_losing_last_route() {
        let (path, store) = paired_store("disable-fixed");
        let initial = store.load_connection_profile().unwrap().unwrap();
        let first_id = initial.endpoints[0].id.clone();
        let with_second = store
            .update_connection_profile_at(initial.revision, |profile| {
                profile.endpoints.push(HostEndpoint {
                    id: uuid::Uuid::new_v4().to_string(),
                    label: "VPN".into(),
                    kind: ConnectionKind::Vpn,
                    endpoint: "vpn.example:443".parse().unwrap(),
                    state: EndpointState::Verified,
                    verified_at: Some("2026-08-16T00:00:00Z".into()),
                    last_success_at: None,
                    disabled_from: None,
                    last_manual_test: None,
                });
                Ok(())
            })
            .unwrap();
        let fixed = set_connection_policy(
            &store,
            ConnectionPolicy::Fixed {
                endpoint_id: first_id.clone(),
            },
            with_second.revision,
        )
        .unwrap();
        let disabled = set_endpoint_enabled(&store, &first_id, false, fixed.revision).unwrap();
        assert_eq!(disabled.policy, ConnectionPolicy::Automatic);
        assert_eq!(
            disabled.endpoints[0].disabled_from,
            Some(EndpointState::Verified)
        );
        let enabled = set_endpoint_enabled(&store, &first_id, true, disabled.revision).unwrap();
        assert_eq!(enabled.endpoints[0].state, EndpointState::Verified);
        let second_id = enabled.endpoints[1].id.clone();
        let fixed_again = set_connection_policy(
            &store,
            ConnectionPolicy::Fixed {
                endpoint_id: second_id.clone(),
            },
            enabled.revision,
        )
        .unwrap();
        let deleted = delete_endpoint(&store, &second_id, fixed_again.revision).unwrap();
        assert_eq!(deleted.policy, ConnectionPolicy::Automatic);
        assert!(delete_endpoint(&store, &first_id, deleted.revision).is_err());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn automatic_routing_keeps_user_order_but_prefers_last_success_within_kind() {
        let (path, store) = paired_store("reorder");
        let initial = store.load_connection_profile().unwrap().unwrap();
        let with_routes = store
            .update_connection_profile_at(initial.revision, |profile| {
                for (label, endpoint, kind) in [
                    ("WAN", "wan.example:443", ConnectionKind::Remote),
                    ("LAN 2", "192.168.1.9:33781", ConnectionKind::Local),
                    ("VPN", "vpn.example:443", ConnectionKind::Vpn),
                ] {
                    profile.endpoints.push(HostEndpoint {
                        id: uuid::Uuid::new_v4().to_string(),
                        label: label.into(),
                        kind,
                        endpoint: endpoint.parse().unwrap(),
                        state: EndpointState::Verified,
                        verified_at: Some("2026-08-16T00:00:00Z".into()),
                        last_success_at: None,
                        disabled_from: None,
                        last_manual_test: None,
                    });
                }
                Ok(())
            })
            .unwrap();
        let ids = vec![
            with_routes.endpoints[2].id.clone(),
            with_routes.endpoints[1].id.clone(),
            with_routes.endpoints[3].id.clone(),
            with_routes.endpoints[0].id.clone(),
        ];
        let reordered = reorder_endpoints(&store, &ids, with_routes.revision).unwrap();
        assert_eq!(
            reordered
                .endpoints
                .iter()
                .map(|item| &item.id)
                .collect::<Vec<_>>(),
            ids.iter().collect::<Vec<_>>()
        );
        assert_eq!(
            reordered
                .ordered_verified_endpoints()
                .iter()
                .map(|item| item.label.as_str())
                .collect::<Vec<_>>(),
            vec!["LAN 2", "局域网", "VPN", "WAN"]
        );
        let last_lan_id = reordered.endpoints[3].id.clone();
        let with_last_success = store
            .update_connection_profile_at(reordered.revision, |profile| {
                profile.last_successful_endpoint_id = Some(last_lan_id);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            with_last_success
                .endpoints
                .iter()
                .map(|item| item.label.as_str())
                .collect::<Vec<_>>(),
            vec!["LAN 2", "WAN", "VPN", "局域网"]
        );
        assert_eq!(
            with_last_success
                .ordered_verified_endpoints()
                .iter()
                .map(|item| item.label.as_str())
                .collect::<Vec<_>>(),
            vec!["局域网", "LAN 2", "VPN", "WAN"]
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn legacy_disabled_entry_requires_exact_pin_success_before_reenable() {
        let (path, store) = paired_store("legacy-disabled");
        let initial = store.load_connection_profile().unwrap().unwrap();
        let legacy_id = uuid::Uuid::new_v4().to_string();
        let disabled = store
            .update_connection_profile_at(initial.revision, |profile| {
                profile.endpoints.push(HostEndpoint {
                    id: legacy_id.clone(),
                    label: "旧地址".into(),
                    kind: ConnectionKind::Remote,
                    endpoint: "legacy.example:443".parse().unwrap(),
                    state: EndpointState::Disabled,
                    verified_at: Some("2026-08-16T00:00:00Z".into()),
                    last_success_at: None,
                    disabled_from: None,
                    last_manual_test: None,
                });
                Ok(())
            })
            .unwrap();
        let profile_path = store
            .root()
            .join(super::PROFILE_DIRECTORY)
            .join(format!("profile-{:020}.json", disabled.revision));
        let mut legacy_json = serde_json::to_value(&disabled).unwrap();
        let legacy_endpoint = legacy_json["endpoints"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|endpoint| endpoint["id"] == legacy_id)
            .unwrap()
            .as_object_mut()
            .unwrap();
        legacy_endpoint.remove("disabledFrom");
        legacy_endpoint.remove("lastManualTest");
        fs::write(
            &profile_path,
            serde_json::to_vec_pretty(&legacy_json).unwrap(),
        )
        .unwrap();

        let loaded = store.load_connection_profile().unwrap().unwrap();
        assert_eq!(loaded.endpoints[1].disabled_from, None);
        assert!(set_endpoint_enabled(&store, &legacy_id, true, loaded.revision).is_err());
        let failed = record_endpoint_test(
            &store,
            &legacy_id,
            loaded.revision,
            Err(ClientError::HostCertificateMismatch),
        )
        .unwrap();
        assert_eq!(failed.profile.endpoints[1].state, EndpointState::Disabled);
        assert_eq!(failed.profile.endpoints[1].disabled_from, None);
        let verified =
            record_endpoint_test(&store, &legacy_id, failed.profile.revision, Ok(())).unwrap();
        assert_eq!(verified.profile.endpoints[1].state, EndpointState::Disabled);
        assert_eq!(
            verified.profile.endpoints[1].disabled_from,
            Some(EndpointState::Verified)
        );
        let enabled =
            set_endpoint_enabled(&store, &legacy_id, true, verified.profile.revision).unwrap();
        assert_eq!(enabled.endpoints[1].state, EndpointState::Verified);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn stale_profile_revision_is_rejected() {
        let (path, store) = paired_store("revision-conflict");
        let initial = store.load_connection_profile().unwrap().unwrap();
        store
            .update_connection_profile_at(initial.revision, |profile| {
                profile.display_name = "First writer".into();
                Ok(())
            })
            .unwrap();
        assert!(matches!(
            store.update_connection_profile_at(initial.revision, |_| Ok(())),
            Err(ClientError::ProfileConflict { expected, actual })
                if expected == initial.revision && actual == initial.revision + 1
        ));
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn rejects_a_fixed_unverified_endpoint() {
        let (path, store) = paired_store("unverified-fixed");
        let result = store.update_connection_profile(|profile| {
            let id = uuid::Uuid::new_v4().to_string();
            profile.endpoints.push(HostEndpoint {
                id: id.clone(),
                label: "待验证".into(),
                kind: ConnectionKind::Manual,
                endpoint: "dock.invalid:33781".parse().expect("syntactic endpoint"),
                state: EndpointState::DraftUnverified,
                verified_at: None,
                last_success_at: None,
                disabled_from: None,
                last_manual_test: None,
            });
            profile.policy = ConnectionPolicy::Fixed { endpoint_id: id };
            Ok(())
        });
        assert!(result.is_err());
        fs::remove_dir_all(path).expect("cleanup");
    }
}
