use crate::{
    ClientError, Endpoint, IdentityStore, PairingProgress, Result, VerifiedPairing,
    private_fs::{
        assert_real_directory, ensure_fixed_directory, ensure_private_directory,
        exclusive_file_lease, storage_error, sync_directory,
    },
};
use directories::ProjectDirs;
use std::{
    fs,
    path::{Path, PathBuf},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

mod catalog;
mod preferences;
use catalog::Catalog;
pub use catalog::{HostRecord, HostRegistrySnapshot};
pub use preferences::{ClientPreferences, ClientPreferencesStore, WindowsAwayDelay};

const REGISTRY_DIRECTORY: &str = "host-registry";
const HOSTS_DIRECTORY: &str = "hosts";

/// Saved connections only. Authorization attempts live in the caller's future.
#[derive(Clone, Debug)]
pub struct HostRegistry {
    root: PathBuf,
    catalog: Catalog,
}
impl HostRegistry {
    pub fn platform_default() -> Result<Self> {
        let directories = ProjectDirs::from("moe", "aruru", "AluDock Client")
            .ok_or_else(|| invalid("could not determine the application data directory"))?;
        Self::open(directories.data_local_dir().join("identity"))
    }
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        ensure_private_directory(&root)?;
        ensure_fixed_directory(&root, REGISTRY_DIRECTORY)?;
        ensure_fixed_directory(&root, HOSTS_DIRECTORY)?;
        let registry = Self {
            catalog: Catalog::new(root.join(REGISTRY_DIRECTORY)),
            root,
        };
        if registry.catalog.load_snapshot()?.is_none() {
            registry
                .catalog
                .publish_initial(&HostRegistrySnapshot::empty())?;
        }
        registry.snapshot()?;
        Ok(registry)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn snapshot(&self) -> Result<HostRegistrySnapshot> {
        self.catalog.snapshot()
    }
    pub fn select_local(&self, expected_revision: u64) -> Result<HostRegistrySnapshot> {
        self.catalog.select_local(expected_revision)
    }
    pub fn set_local_endpoint_override(
        &self,
        expected_revision: u64,
        endpoint: Option<&str>,
    ) -> Result<HostRegistrySnapshot> {
        self.catalog
            .set_local_endpoint_override(expected_revision, endpoint)
    }
    pub fn set_active_host(
        &self,
        host_id: &str,
        expected_revision: u64,
    ) -> Result<HostRegistrySnapshot> {
        self.catalog.set_active_host(host_id, expected_revision)
    }
    pub fn resolve_store(&self, requested_host_id: Option<&str>) -> Result<IdentityStore> {
        let snapshot = self.snapshot()?;
        let host_id = requested_host_id
            .or(snapshot.active_host_id.as_deref())
            .ok_or_else(|| invalid("no active Host is selected"))?;
        validate_host_id(host_id)?;
        if !snapshot
            .hosts
            .iter()
            .any(|record| record.host_id == host_id)
        {
            return Err(ClientError::HostNotFound(host_id.to_owned()));
        }
        let path = self.root.join(HOSTS_DIRECTORY).join(host_id);
        assert_real_directory(&path, "Host identity")?;
        let store = IdentityStore::new(path);
        if crate::host_id(&store.load_pairing()?.host_certificate) != host_id {
            return Err(invalid(
                "Host identity directory does not match its pinned certificate",
            ));
        }
        Ok(store)
    }
    pub async fn verify_pairing<F>(
        &self,
        endpoint: Endpoint,
        device_name: &str,
        progress: F,
    ) -> Result<VerifiedPairing>
    where
        F: FnMut(PairingProgress),
    {
        crate::pairing::authenticate(endpoint, device_name, progress, |certificate| {
            let id = crate::host_id(certificate);
            if self.snapshot()?.hosts.iter().any(|host| host.host_id == id) {
                return Err(ClientError::HostAlreadySaved(id));
            }
            Ok(())
        })
        .await
    }

    /// Persist only a fully authenticated new Host, using the current saved layout.
    pub fn save_pairing(&self, verified: VerifiedPairing) -> Result<u64> {
        let lock_path = self.root.join(".host-save.lock");
        let _guard =
            exclusive_file_lease(&lock_path).map_err(|source| storage_error(&lock_path, source))?;
        let host_id = verified.host_id();
        let snapshot = self.snapshot()?;
        if snapshot.hosts.iter().any(|host| host.host_id == host_id) {
            return Err(ClientError::HostAlreadySaved(host_id));
        }
        let hosts = self.root.join(HOSTS_DIRECTORY);
        let path = hosts.join(format!(".saving-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|source| storage_error(&path, source))?;
        let staging = StagedHost(path);
        let store = IdentityStore::new(&staging.0);
        store.initialize_pairing(&verified.pairing)?;
        store.load_connection_profile()?;
        let destination = hosts.join(&host_id);
        if destination.exists() {
            // Under the save lock, the current catalog says this owned directory
            // is unlisted. Its obsolete credential contents are not authoritative.
            dispose_host_directory(&destination, &hosts)?;
        }
        fs::rename(&staging.0, &destination)
            .map_err(|source| storage_error(&destination, source))?;
        sync_directory(&hosts)?;
        match self.catalog.add_host(&host_id, snapshot.revision) {
            Ok(snapshot) => Ok(snapshot.revision),
            Err(error) => {
                // Never erase a committed catalog entry on a post-commit error.
                if self
                    .snapshot()
                    .is_ok_and(|value| !value.hosts.iter().any(|host| host.host_id == host_id))
                {
                    let _ = dispose_host_directory(&destination, &hosts);
                }
                Err(error)
            }
        }
    }

    pub fn remove_host(
        &self,
        host_id: &str,
        expected_revision: u64,
    ) -> Result<HostRegistrySnapshot> {
        let lock_path = self.root.join(".host-save.lock");
        let _guard =
            exclusive_file_lease(&lock_path).map_err(|source| storage_error(&lock_path, source))?;
        validate_host_id(host_id)?;
        let updated = self.catalog.mutate(expected_revision, |snapshot| {
            let index = snapshot
                .hosts
                .binary_search_by(|host| host.host_id.as_str().cmp(host_id))
                .map_err(|_| ClientError::HostNotFound(host_id.to_owned()))?;
            snapshot.hosts.remove(index);
            if snapshot.active_host_id.as_deref() == Some(host_id) {
                snapshot.active_host_id = snapshot
                    .hosts
                    .get(index)
                    .or_else(|| index.checked_sub(1).and_then(|i| snapshot.hosts.get(i)))
                    .map(|host| host.host_id.clone());
            }
            Ok(())
        })?;
        let path = self.root.join(HOSTS_DIRECTORY).join(host_id);
        dispose_host_directory(&path, &self.root.join(HOSTS_DIRECTORY))?;
        Ok(updated)
    }
}
// Remove the formal name before recursive cleanup, so interruption leaves only
// hidden garbage and never blocks a new, fully authenticated save of this Host.
fn dispose_host_directory(path: &Path, parent: &Path) -> Result<()> {
    if path.parent() != Some(parent) {
        return Err(invalid("Host directory is outside its owner"));
    }
    assert_real_directory(path, "obsolete Host identity")?;
    let garbage = parent.join(format!(".cleanup-{}", uuid::Uuid::new_v4()));
    fs::rename(path, &garbage).map_err(|source| storage_error(path, source))?;
    sync_directory(parent)?;
    fs::remove_dir_all(&garbage).map_err(|source| storage_error(&garbage, source))?;
    sync_directory(parent)
}

// This directory is created only after authentication; dropping a failed save
// cleans its own scratch. It is never enumerated as a resumable pairing.
struct StagedHost(PathBuf);
impl Drop for StagedHost {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn validate_host_id(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(
            "Host ID must be exactly 64 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}
fn now_rfc3339() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| invalid(format!("could not format registry timestamp: {error}")))
}
fn invalid(message: impl Into<String>) -> ClientError {
    ClientError::InvalidPairing(message.into())
}
#[cfg(test)]
mod tests;
