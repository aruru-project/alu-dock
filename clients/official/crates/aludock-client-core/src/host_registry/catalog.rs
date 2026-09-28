use super::{invalid, now_rfc3339, validate_host_id};
use crate::{
    ClientError, Result,
    private_fs::{read_private_json, storage_error},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(super) const REGISTRY_SCHEMA_VERSION: u32 = 2;
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRecord {
    pub host_id: String,
    pub added_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRegistrySnapshot {
    pub schema_version: u32,
    pub revision: u64,
    pub active_host_id: Option<String>,
    #[serde(default)]
    pub local_selected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_endpoint_override: Option<String>,
    pub hosts: Vec<HostRecord>,
}

impl HostRegistrySnapshot {
    pub(super) fn empty() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            revision: 1,
            active_host_id: None,
            local_selected: false,
            local_endpoint_override: None,
            hosts: Vec::new(),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.schema_version != REGISTRY_SCHEMA_VERSION
            || self.revision == 0
            || (self.local_selected && self.active_host_id.is_some())
            || self.local_endpoint_override.as_ref().is_some_and(|value| {
                crate::local_transport::LocalDockEndpoint::configured(value).is_err()
            })
        {
            return Err(invalid(
                "stored Host registry schema or revision is invalid",
            ));
        }
        let mut previous: Option<&str> = None;
        for record in &self.hosts {
            validate_host_id(&record.host_id)?;
            OffsetDateTime::parse(&record.added_at, &Rfc3339)
                .map_err(|_| invalid("stored Host registry timestamp is invalid"))?;
            if previous.is_some_and(|value| value >= record.host_id.as_str()) {
                return Err(invalid(
                    "stored Host registry entries are duplicated or unsorted",
                ));
            }
            previous = Some(&record.host_id);
        }
        match &self.active_host_id {
            Some(host_id) => {
                validate_host_id(host_id)?;
                if self
                    .hosts
                    .binary_search_by(|item| item.host_id.cmp(host_id))
                    .is_err()
                {
                    return Err(invalid("active Host is not present in the registry"));
                }
            }
            None if !self.hosts.is_empty() && !self.local_selected => {
                return Err(invalid(
                    "a non-empty Host registry must have one selected connection",
                ));
            }
            None => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(super) struct Catalog {
    directory: PathBuf,
}
impl Catalog {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    fn registry_directory(&self) -> PathBuf {
        self.directory.clone()
    }
    pub(super) fn snapshot(&self) -> Result<HostRegistrySnapshot> {
        self.load_snapshot()?
            .ok_or_else(|| invalid("Host registry has no committed snapshot"))
    }

    pub(super) fn select_local(&self, expected_revision: u64) -> Result<HostRegistrySnapshot> {
        let current = self.snapshot()?;
        crate::local_transport::LocalDockEndpoint::resolve(
            current.local_endpoint_override.as_deref(),
        )?;
        self.mutate(expected_revision, |snapshot| {
            snapshot.active_host_id = None;
            snapshot.local_selected = true;
            Ok(())
        })
    }

    pub(super) fn set_local_endpoint_override(
        &self,
        expected_revision: u64,
        endpoint: Option<&str>,
    ) -> Result<HostRegistrySnapshot> {
        let endpoint = endpoint.map(str::trim).filter(|value| !value.is_empty());
        if let Some(value) = endpoint {
            crate::local_transport::LocalDockEndpoint::configured(value)?;
        }
        self.mutate(expected_revision, |snapshot| {
            snapshot.local_endpoint_override = endpoint.map(str::to_owned);
            Ok(())
        })
    }

    pub(super) fn set_active_host(
        &self,
        host_id: &str,
        expected_revision: u64,
    ) -> Result<HostRegistrySnapshot> {
        validate_host_id(host_id)?;
        self.mutate(expected_revision, |snapshot| {
            if snapshot
                .hosts
                .binary_search_by(|item| item.host_id.as_str().cmp(host_id))
                .is_err()
            {
                return Err(ClientError::HostNotFound(host_id.to_owned()));
            }
            snapshot.active_host_id = Some(host_id.to_owned());
            snapshot.local_selected = false;
            Ok(())
        })
    }

    pub(super) fn load_snapshot(&self) -> Result<Option<HostRegistrySnapshot>> {
        let Some((filename_revision, path)) = crate::storage::snapshots::latest_snapshot(
            &self.registry_directory(),
            parse_registry_filename,
            "Host registry contains an unexpected committed entry",
            storage_error,
        )?
        else {
            return Ok(None);
        };
        let snapshot: HostRegistrySnapshot = read_private_json(&path)?;
        snapshot.validate()?;
        if snapshot.revision != filename_revision {
            return Err(ClientError::InvalidPairing(
                "Host registry filename and revision do not match".into(),
            ));
        }
        Ok(Some(snapshot))
    }

    pub(super) fn publish_initial(&self, snapshot: &HostRegistrySnapshot) -> Result<()> {
        snapshot.validate()?;
        if self.write_snapshot(snapshot)? {
            self.cleanup_snapshots(snapshot.revision)
        } else {
            Ok(())
        }
    }

    pub(super) fn mutate<F>(
        &self,
        expected_revision: u64,
        update: F,
    ) -> Result<HostRegistrySnapshot>
    where
        F: FnOnce(&mut HostRegistrySnapshot) -> Result<()>,
    {
        let mut snapshot = self.snapshot()?;
        crate::storage::snapshots::check_revision(
            expected_revision,
            snapshot.revision,
            |expected, actual| ClientError::RegistryConflict { expected, actual },
        )?;
        update(&mut snapshot)?;
        snapshot.revision = snapshot
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("Host registry revision overflowed"))?;
        snapshot.validate()?;
        if !self.write_snapshot(&snapshot)? {
            let actual = self.snapshot()?.revision;
            return Err(ClientError::RegistryConflict {
                expected: expected_revision,
                actual,
            });
        }
        self.cleanup_snapshots(snapshot.revision)?;
        Ok(snapshot)
    }

    fn write_snapshot(&self, snapshot: &HostRegistrySnapshot) -> Result<bool> {
        crate::private_fs::publish_private_file(
            &self
                .registry_directory()
                .join(format!("registry-{:020}.json", snapshot.revision)),
            &serde_json::to_vec_pretty(snapshot)?,
        )
    }

    fn cleanup_snapshots(&self, latest_revision: u64) -> Result<()> {
        crate::storage::snapshots::cleanup_snapshots(
            &self.registry_directory(),
            latest_revision,
            parse_registry_filename,
            storage_error,
        )
    }

    pub(super) fn add_host(
        &self,
        host_id: &str,
        mut observed_revision: u64,
    ) -> Result<HostRegistrySnapshot> {
        loop {
            let current = self.snapshot()?;
            if current.hosts.iter().any(|item| item.host_id == host_id) {
                return Ok(current);
            }
            observed_revision = observed_revision.max(current.revision);
            match self.mutate(observed_revision, |snapshot| {
                snapshot.hosts.push(HostRecord {
                    host_id: host_id.to_owned(),
                    added_at: now_rfc3339()?,
                });
                snapshot.hosts.sort_by(|a, b| a.host_id.cmp(&b.host_id));
                snapshot.active_host_id = Some(host_id.to_owned());
                snapshot.local_selected = false;
                Ok(())
            }) {
                Ok(snapshot) => return Ok(snapshot),
                Err(ClientError::RegistryConflict { actual, .. }) => observed_revision = actual,
                Err(error) => return Err(error),
            }
        }
    }
}
fn parse_registry_filename(value: &str) -> Option<u64> {
    let revision = value.strip_prefix("registry-")?.strip_suffix(".json")?;
    if revision.len() != 20 || !revision.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    revision.parse().ok()
}
