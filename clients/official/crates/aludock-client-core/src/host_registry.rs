use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    ClientError, Endpoint, IdentityStore, PairingOutcome, PairingProgress, Result, host_id,
    pairing::{pair_with_host_guard, validate_device_name},
    protocol::probe_stored_pairing,
};

const REGISTRY_DIRECTORY: &str = "host-registry";
const HOSTS_DIRECTORY: &str = "hosts";
const TRANSACTIONS_DIRECTORY: &str = "pairing-transactions";
const OPERATIONS_DIRECTORY: &str = "operations";
const MIGRATION_MARKER: &str = "migration-complete.json";
const LEGACY_COPY_MARKER: &str = ".legacy-copy-complete";
const LEGACY_TRANSACTION_STAGING: &str = ".legacy-transaction-staging";
const TRANSACTION_METADATA: &str = "transaction.json";
const TRANSACTION_IDENTITY: &str = "identity";
const REGISTRY_SCHEMA_VERSION: u32 = 1;

const LEGACY_FILES: &[&str] = &[
    "client-identity-manifest.json",
    "pairing-manifest.json",
    "pending-pairing-manifest.json",
    "client-certificate.der",
    "client-private-key.der",
    "host-certificate.der",
    "pairing-metadata.json",
    "client-id",
];
const LEGACY_DIRECTORIES: &[&str] = &["state", "connection-profile-history"];

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
    pub hosts: Vec<HostRecord>,
}

impl HostRegistrySnapshot {
    fn empty() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            revision: 1,
            active_host_id: None,
            hosts: Vec::new(),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.schema_version != REGISTRY_SCHEMA_VERSION || self.revision == 0 {
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
            None if !self.hosts.is_empty() => {
                return Err(invalid(
                    "a non-empty Host registry must have an active Host",
                ));
            }
            None => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct PairingTransaction {
    pub transaction_id: String,
    pub endpoint: Option<Endpoint>,
    pub device_name: Option<String>,
    pub replacement_host_id: Option<String>,
    pub store: IdentityStore,
}

#[derive(Debug)]
pub struct VerifiedPairing {
    pub transaction_id: String,
    pub host_id: String,
    pub outcome: PairingOutcome,
}

#[derive(Debug)]
pub struct PromotedPairing {
    pub transaction_id: String,
    pub host_id: String,
    pub registry_revision: u64,
    pub outcome: PairingOutcome,
}

#[derive(Clone, Debug)]
pub struct HostRegistry {
    root: PathBuf,
    replacement_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransactionRecord {
    schema_version: u32,
    transaction_id: String,
    endpoint: Option<Endpoint>,
    device_name: Option<String>,
    created_at: String,
    legacy_identity: bool,
    #[serde(default)]
    legacy_state_generations: Vec<String>,
    #[serde(default)]
    replacement_host_id: Option<String>,
    verified_host_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationIntent {
    schema_version: u32,
    operation_id: String,
    kind: OperationKind,
    host_id: String,
    transaction_id: Option<String>,
    observed_revision: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum OperationKind {
    PromotePairing,
    RemoveHost,
    MigrateLegacy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationMarker {
    schema_version: u32,
    completed_at: String,
    #[serde(default)]
    migrated_host_id: Option<String>,
    #[serde(default)]
    copied_state_generations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyCopyMarker {
    schema_version: u32,
    state_generations: Vec<String>,
}

impl HostRegistry {
    pub fn platform_default() -> Result<Self> {
        let directories = ProjectDirs::from("moe", "aruru", "AluDock Client")
            .ok_or_else(|| invalid("could not determine the application data directory"))?;
        Self::open(directories.data_local_dir().join("identity"))
    }

    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let registry = Self {
            root: root.into(),
            replacement_lock: Arc::new(Mutex::new(())),
        };
        registry.ensure_layout()?;
        registry.recover_operations()?;
        registry.migrate_legacy_singleton()?;
        if registry.load_snapshot()?.is_none() {
            registry.publish_initial(&HostRegistrySnapshot::empty())?;
        }
        registry.snapshot()?;
        Ok(registry)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn snapshot(&self) -> Result<HostRegistrySnapshot> {
        self.load_snapshot()?
            .ok_or_else(|| invalid("Host registry has no committed snapshot"))
    }

    pub fn resolve_store(&self, requested_host_id: Option<&str>) -> Result<IdentityStore> {
        let snapshot = self.snapshot()?;
        let host_id = match requested_host_id {
            Some(value) => value,
            None => snapshot
                .active_host_id
                .as_deref()
                .ok_or_else(|| invalid("no active Host is selected"))?,
        };
        validate_host_id(host_id)?;
        if snapshot
            .hosts
            .binary_search_by(|item| item.host_id.as_str().cmp(host_id))
            .is_err()
        {
            return Err(ClientError::HostNotFound(host_id.to_owned()));
        }
        let path = self.hosts_directory().join(host_id);
        assert_real_directory(&path, "Host identity")?;
        let store = IdentityStore::new(path);
        let paired = store.load_pairing()?;
        if crate::host_id(&paired.host_certificate) != host_id {
            return Err(invalid(
                "Host identity directory does not match its pinned certificate",
            ));
        }
        Ok(store)
    }

    pub fn set_active_host(
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
            Ok(())
        })
    }

    pub fn remove_local_host(
        &self,
        host_id: &str,
        expected_revision: u64,
    ) -> Result<HostRegistrySnapshot> {
        let _replacement_guard = self
            .replacement_lock
            .lock()
            .map_err(|_| invalid("Host replacement lock is unavailable"))?;
        self.remove_local_host_internal(host_id, expected_revision, true)
    }

    fn remove_local_host_internal(
        &self,
        host_id: &str,
        expected_revision: u64,
        discard_replacements: bool,
    ) -> Result<HostRegistrySnapshot> {
        validate_host_id(host_id)?;
        let current = self.snapshot()?;
        if current.revision != expected_revision {
            return Err(ClientError::RegistryConflict {
                expected: expected_revision,
                actual: current.revision,
            });
        }
        if current
            .hosts
            .binary_search_by(|item| item.host_id.as_str().cmp(host_id))
            .is_err()
        {
            return Err(ClientError::HostNotFound(host_id.to_owned()));
        }
        if discard_replacements {
            let replacement_ids = self
                .pairing_transactions()?
                .into_iter()
                .filter(|transaction| transaction.replacement_host_id.as_deref() == Some(host_id))
                .map(|transaction| transaction.transaction_id)
                .collect::<Vec<_>>();
            for transaction_id in replacement_ids {
                self.discard_pairing_transaction(&transaction_id)?;
            }
        }
        let operation = OperationIntent {
            schema_version: 1,
            operation_id: Uuid::new_v4().to_string(),
            kind: OperationKind::RemoveHost,
            host_id: host_id.to_owned(),
            transaction_id: None,
            observed_revision: expected_revision,
        };
        let operation_path = self.write_operation(&operation)?;
        let updated = match self.mutate(expected_revision, |snapshot| {
            let index = snapshot
                .hosts
                .binary_search_by(|item| item.host_id.as_str().cmp(host_id))
                .map_err(|_| ClientError::HostNotFound(host_id.to_owned()))?;
            snapshot.hosts.remove(index);
            if snapshot.active_host_id.as_deref() == Some(host_id) {
                snapshot.active_host_id = snapshot
                    .hosts
                    .get(index)
                    .or_else(|| index.checked_sub(1).and_then(|i| snapshot.hosts.get(i)))
                    .map(|item| item.host_id.clone());
            }
            Ok(())
        }) {
            Ok(value) => value,
            Err(error) => {
                remove_file_sync(&operation_path, &self.operations_directory())?;
                return Err(error);
            }
        };
        self.finish_removal(&operation, &operation_path)?;
        Ok(updated)
    }

    pub fn pairing_transactions(&self) -> Result<Vec<PairingTransaction>> {
        let directory = self.transactions_directory();
        let mut transactions = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|source| storage_error(&directory, source))? {
            let entry = entry.map_err(|source| storage_error(&directory, source))?;
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|source| storage_error(&path, source))?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(invalid("pairing transaction entry is not a real directory"));
            }
            let id = canonical_uuid(&entry.file_name().to_string_lossy())?;
            let record: TransactionRecord = read_private_json(&path.join(TRANSACTION_METADATA))?;
            validate_transaction(&record, &id)?;
            let identity = path.join(TRANSACTION_IDENTITY);
            assert_real_directory(&identity, "pairing identity")?;
            transactions.push(PairingTransaction {
                transaction_id: id,
                endpoint: record.endpoint,
                device_name: record.device_name,
                replacement_host_id: record.replacement_host_id,
                store: IdentityStore::new(identity),
            });
        }
        transactions.sort_by(|a, b| a.transaction_id.cmp(&b.transaction_id));
        Ok(transactions)
    }

    pub fn start_pairing_transaction(
        &self,
        endpoint: Endpoint,
        device_name: &str,
    ) -> Result<PairingTransaction> {
        validate_device_name(device_name)?;
        if let Some(transaction) = self.matching_transaction(&endpoint, device_name, None)? {
            return Ok(transaction);
        }
        if let Some(transaction) = self.claim_legacy_transaction(&endpoint, device_name)? {
            return Ok(transaction);
        }
        self.create_transaction(Some(endpoint), Some(device_name.to_owned()), false, None)
    }

    pub fn start_repairing_transaction(
        &self,
        endpoint: Endpoint,
        device_name: &str,
        expected_host_id: &str,
    ) -> Result<PairingTransaction> {
        let _replacement_guard = self
            .replacement_lock
            .lock()
            .map_err(|_| invalid("Host replacement lock is unavailable"))?;
        validate_host_id(expected_host_id)?;
        validate_device_name(device_name)?;
        if let Some(transaction) =
            self.matching_transaction(&endpoint, device_name, Some(expected_host_id))?
        {
            return Ok(transaction);
        }
        let snapshot = self.snapshot()?;
        if snapshot
            .hosts
            .binary_search_by(|item| item.host_id.as_str().cmp(expected_host_id))
            .is_err()
            || !self.hosts_directory().join(expected_host_id).exists()
        {
            return Err(ClientError::HostNotFound(expected_host_id.to_owned()));
        }
        self.create_transaction(
            Some(endpoint),
            Some(device_name.to_owned()),
            false,
            Some(expected_host_id.to_owned()),
        )
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
        self.verify_pairing_mode(endpoint, device_name, None, progress)
            .await
    }

    pub async fn verify_repairing<F>(
        &self,
        endpoint: Endpoint,
        device_name: &str,
        expected_host_id: &str,
        progress: F,
    ) -> Result<VerifiedPairing>
    where
        F: FnMut(PairingProgress),
    {
        validate_host_id(expected_host_id)?;
        self.verify_pairing_mode(
            endpoint,
            device_name,
            Some(expected_host_id.to_owned()),
            progress,
        )
        .await
    }

    async fn verify_pairing_mode<F>(
        &self,
        endpoint: Endpoint,
        device_name: &str,
        replacement_host_id: Option<String>,
        mut progress: F,
    ) -> Result<VerifiedPairing>
    where
        F: FnMut(PairingProgress),
    {
        let transaction = match self
            .matching_transaction(&endpoint, device_name, replacement_host_id.as_deref())
            .map_err(|error| self.redact_transaction_error(error))?
        {
            Some(transaction) => transaction,
            None => match replacement_host_id.as_deref() {
                Some(expected_host_id) => self
                    .start_repairing_transaction(endpoint.clone(), device_name, expected_host_id)
                    .map_err(|error| self.redact_transaction_error(error))?,
                None => self
                    .start_pairing_transaction(endpoint.clone(), device_name)
                    .map_err(|error| self.redact_transaction_error(error))?,
            },
        };
        let host_guard = |certificate: &[u8]| {
            let candidate = host_id(certificate);
            if let Some(expected_host_id) = replacement_host_id.as_deref() {
                return if candidate == expected_host_id {
                    Ok(())
                } else {
                    Err(ClientError::HostCertificateMismatch)
                };
            }
            let snapshot = self.snapshot()?;
            if snapshot.hosts.iter().any(|item| item.host_id == candidate)
                || self.hosts_directory().join(&candidate).exists()
            {
                return Err(ClientError::HostAlreadySaved(candidate));
            }
            Ok(())
        };
        let outcome = if transaction.store.is_paired() {
            let pairing = transaction
                .store
                .load_pairing()
                .map_err(|error| self.redact_transaction_error(error))?;
            if pairing.metadata.endpoint != endpoint
                || pairing.metadata.device_name != device_name
                || pairing.metadata.client_id
                    != transaction
                        .store
                        .client_id()
                        .map_err(|error| self.redact_transaction_error(error))?
            {
                return Err(invalid(
                    "committed pairing recovery does not match its transaction request",
                ));
            }
            host_guard(&pairing.host_certificate)?;
            progress(PairingProgress::RecoveringPairing);
            progress(PairingProgress::ConfirmingConnection);
            probe_stored_pairing(&pairing).await.map_err(|error| {
                ClientError::InvalidPairing(format!(
                    "a committed pairing could not be cryptographically revalidated: {error}; it was kept for another retry"
                ))
            })?;
            PairingOutcome {
                endpoint: pairing.metadata.endpoint,
                client_fingerprint: pairing.identity.fingerprint(),
                identity_directory: transaction.store.root().to_path_buf(),
            }
        } else {
            pair_with_host_guard(
                endpoint,
                device_name,
                &transaction.store,
                progress,
                host_guard,
            )
            .await
            .map_err(|error| self.redact_transaction_error(error))?
        };
        let pairing = transaction
            .store
            .load_pairing()
            .map_err(|error| self.redact_transaction_error(error))?;
        let host_id = host_id(&pairing.host_certificate);
        self.mark_transaction_verified(&transaction.transaction_id, &host_id)
            .map_err(|error| self.redact_transaction_error(error))?;
        Ok(VerifiedPairing {
            transaction_id: transaction.transaction_id,
            host_id,
            outcome,
        })
    }

    pub async fn pair_host<F>(
        &self,
        endpoint: Endpoint,
        device_name: &str,
        progress: F,
    ) -> Result<PromotedPairing>
    where
        F: FnMut(PairingProgress),
    {
        let verified = self.verify_pairing(endpoint, device_name, progress).await?;
        let registry_revision =
            self.promote_pairing(&verified.transaction_id, &verified.host_id)?;
        Ok(PromotedPairing {
            transaction_id: verified.transaction_id,
            host_id: verified.host_id,
            registry_revision,
            outcome: verified.outcome,
        })
    }

    pub fn promote_pairing(&self, transaction_id: &str, expected_host_id: &str) -> Result<u64> {
        let transaction_id = canonical_uuid(transaction_id)?;
        validate_host_id(expected_host_id)?;
        let transaction_directory = self.transactions_directory().join(&transaction_id);
        assert_real_directory(&transaction_directory, "pairing transaction")?;
        let record: TransactionRecord =
            read_private_json(&transaction_directory.join(TRANSACTION_METADATA))?;
        validate_transaction(&record, &transaction_id)?;
        if record.verified_host_id.as_deref() != Some(expected_host_id) {
            return Err(invalid(
                "pairing transaction has not completed final pinned verification",
            ));
        }
        let source = transaction_directory.join(TRANSACTION_IDENTITY);
        assert_real_directory(&source, "pairing identity")?;
        let store = IdentityStore::new(&source);
        let paired = store.load_pairing()?;
        let actual_host_id = host_id(&paired.host_certificate);
        if actual_host_id != expected_host_id {
            return Err(invalid(
                "pairing transaction Host ID does not match its exact pin",
            ));
        }
        let current = self.snapshot()?;
        if current
            .hosts
            .iter()
            .any(|item| item.host_id == actual_host_id)
            || self.hosts_directory().join(&actual_host_id).exists()
        {
            return Err(ClientError::HostAlreadySaved(actual_host_id));
        }
        self.associate_legacy_migration(&actual_host_id, &record.legacy_state_generations)?;
        let operation = OperationIntent {
            schema_version: 1,
            operation_id: Uuid::new_v4().to_string(),
            kind: OperationKind::PromotePairing,
            host_id: actual_host_id.clone(),
            transaction_id: Some(transaction_id.clone()),
            observed_revision: current.revision,
        };
        let operation_path = self.write_operation(&operation)?;
        let destination = self.hosts_directory().join(&actual_host_id);
        fs::rename(&source, &destination).map_err(|source| storage_error(&destination, source))?;
        sync_directory(&self.hosts_directory())?;
        let updated = self.add_recovering(&actual_host_id, current.revision)?;
        remove_tree_checked(&transaction_directory, &self.transactions_directory())?;
        remove_file_sync(&operation_path, &self.operations_directory())?;
        Ok(updated.revision)
    }

    pub fn promote_repairing(&self, transaction_id: &str, expected_host_id: &str) -> Result<u64> {
        let transaction_id = canonical_uuid(transaction_id)?;
        validate_host_id(expected_host_id)?;
        let transaction_directory = self.transactions_directory().join(&transaction_id);
        assert_real_directory(&transaction_directory, "pairing transaction")?;
        let record: TransactionRecord =
            read_private_json(&transaction_directory.join(TRANSACTION_METADATA))?;
        validate_transaction(&record, &transaction_id)?;
        if record.replacement_host_id.as_deref() != Some(expected_host_id)
            || record.verified_host_id.as_deref() != Some(expected_host_id)
        {
            return Err(invalid(
                "replacement pairing has not completed exact Host verification",
            ));
        }

        let current = self.snapshot()?;
        let listed = current
            .hosts
            .binary_search_by(|item| item.host_id.as_str().cmp(expected_host_id))
            .is_ok();
        let stored = self.hosts_directory().join(expected_host_id).exists();
        if listed != stored {
            return Err(invalid(
                "saved Host identity is incomplete during re-pairing",
            ));
        }
        if listed {
            let saved_profile = self
                .resolve_store(Some(expected_host_id))?
                .load_connection_profile()?
                .ok_or_else(|| invalid("saved Host connection profile is missing"))?;
            let replacement_store =
                IdentityStore::new(transaction_directory.join(TRANSACTION_IDENTITY));
            replacement_store.update_connection_profile(|profile| {
                profile.display_name = saved_profile.display_name;
                profile.endpoints = saved_profile.endpoints;
                profile.policy = saved_profile.policy;
                profile.last_successful_endpoint_id = saved_profile.last_successful_endpoint_id;
                Ok(())
            })?;
            self.remove_local_host_internal(expected_host_id, current.revision, false)?;
        }
        self.promote_pairing(&transaction_id, expected_host_id)
    }

    pub fn discard_pairing_transaction(&self, transaction_id: &str) -> Result<()> {
        let transaction_id = canonical_uuid(transaction_id)?;
        let directory = self.transactions_directory().join(transaction_id);
        assert_real_directory(&directory, "pairing transaction")?;
        let record: TransactionRecord = read_private_json(&directory.join(TRANSACTION_METADATA))?;
        validate_transaction(&record, &record.transaction_id)?;
        remove_tree_checked(&directory, &self.transactions_directory())
    }

    fn ensure_layout(&self) -> Result<()> {
        ensure_root_directory(&self.root)?;
        for name in [
            REGISTRY_DIRECTORY,
            HOSTS_DIRECTORY,
            TRANSACTIONS_DIRECTORY,
            OPERATIONS_DIRECTORY,
        ] {
            ensure_fixed_directory(&self.root, name)?;
        }
        Ok(())
    }

    fn registry_directory(&self) -> PathBuf {
        self.root.join(REGISTRY_DIRECTORY)
    }

    fn hosts_directory(&self) -> PathBuf {
        self.root.join(HOSTS_DIRECTORY)
    }

    fn transactions_directory(&self) -> PathBuf {
        self.root.join(TRANSACTIONS_DIRECTORY)
    }

    fn operations_directory(&self) -> PathBuf {
        self.root.join(OPERATIONS_DIRECTORY)
    }

    fn redact_transaction_error(&self, error: ClientError) -> ClientError {
        if error
            .to_string()
            .contains(&self.transactions_directory().display().to_string())
        {
            invalid("pairing transaction storage is invalid or unavailable")
        } else {
            error
        }
    }

    fn load_snapshot(&self) -> Result<Option<HostRegistrySnapshot>> {
        let directory = self.registry_directory();
        let mut files = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|source| storage_error(&directory, source))? {
            let entry = entry.map_err(|source| storage_error(&directory, source))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let revision = parse_registry_filename(&name)
                .ok_or_else(|| invalid("Host registry contains an unexpected committed entry"))?;
            files.push((revision, entry.path()));
        }
        files.sort_by_key(|item| item.0);
        let Some((filename_revision, path)) = files.last() else {
            return Ok(None);
        };
        let snapshot: HostRegistrySnapshot = read_private_json(path)?;
        snapshot.validate()?;
        if snapshot.revision != *filename_revision {
            return Err(invalid("Host registry filename and revision do not match"));
        }
        Ok(Some(snapshot))
    }

    fn publish_initial(&self, snapshot: &HostRegistrySnapshot) -> Result<()> {
        snapshot.validate()?;
        if self.write_snapshot(snapshot)? {
            self.cleanup_snapshots(snapshot.revision)
        } else {
            Ok(())
        }
    }

    fn mutate<F>(&self, expected_revision: u64, update: F) -> Result<HostRegistrySnapshot>
    where
        F: FnOnce(&mut HostRegistrySnapshot) -> Result<()>,
    {
        let mut snapshot = self.snapshot()?;
        if snapshot.revision != expected_revision {
            return Err(ClientError::RegistryConflict {
                expected: expected_revision,
                actual: snapshot.revision,
            });
        }
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
        let directory = self.registry_directory();
        let final_path = directory.join(format!("registry-{:020}.json", snapshot.revision));
        let temporary = directory.join(format!(".{}.tmp", Uuid::new_v4()));
        write_new_private_file(&temporary, &serde_json::to_vec_pretty(snapshot)?)?;
        match fs::hard_link(&temporary, &final_path) {
            Ok(()) => {
                fs::remove_file(&temporary).map_err(|source| storage_error(&temporary, source))?;
                sync_directory(&directory)?;
                Ok(true)
            }
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                fs::remove_file(&temporary).map_err(|error| storage_error(&temporary, error))?;
                Ok(false)
            }
            Err(source) => {
                let _ = fs::remove_file(&temporary);
                Err(storage_error(&final_path, source))
            }
        }
    }

    fn cleanup_snapshots(&self, latest_revision: u64) -> Result<()> {
        let directory = self.registry_directory();
        let retain_from = latest_revision.saturating_sub(1);
        for entry in fs::read_dir(&directory).map_err(|source| storage_error(&directory, source))? {
            let entry = entry.map_err(|source| storage_error(&directory, source))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if parse_registry_filename(&name).is_some_and(|revision| revision < retain_from) {
                fs::remove_file(entry.path())
                    .map_err(|source| storage_error(&entry.path(), source))?;
            }
        }
        sync_directory(&directory)
    }

    fn create_transaction(
        &self,
        endpoint: Option<Endpoint>,
        device_name: Option<String>,
        legacy_identity: bool,
        replacement_host_id: Option<String>,
    ) -> Result<PairingTransaction> {
        let id = Uuid::new_v4().to_string();
        let directory = self.transactions_directory().join(&id);
        fs::create_dir(&directory).map_err(|source| storage_error(&directory, source))?;
        set_private_directory_permissions(&directory)?;
        let identity = directory.join(TRANSACTION_IDENTITY);
        fs::create_dir(&identity).map_err(|source| storage_error(&identity, source))?;
        set_private_directory_permissions(&identity)?;
        let record = TransactionRecord {
            schema_version: 1,
            transaction_id: id.clone(),
            endpoint,
            device_name,
            created_at: now_rfc3339()?,
            legacy_identity,
            legacy_state_generations: Vec::new(),
            replacement_host_id,
            verified_host_id: None,
        };
        write_new_private_file(
            &directory.join(TRANSACTION_METADATA),
            &serde_json::to_vec_pretty(&record)?,
        )?;
        sync_directory(&directory)?;
        sync_directory(&self.transactions_directory())?;
        let store = IdentityStore::new(identity);
        store.load_or_create_identity()?;
        store.client_id()?;
        Ok(PairingTransaction {
            transaction_id: id,
            endpoint: record.endpoint,
            device_name: record.device_name,
            replacement_host_id: record.replacement_host_id,
            store,
        })
    }

    fn create_legacy_transaction(
        &self,
        expected_fingerprint: &str,
        expected_client_id: &str,
    ) -> Result<PairingTransaction> {
        let staging = self
            .transactions_directory()
            .join(LEGACY_TRANSACTION_STAGING);
        if staging.exists() {
            return Err(invalid("legacy transaction staging already exists"));
        }
        fs::create_dir(&staging).map_err(|source| storage_error(&staging, source))?;
        set_private_directory_permissions(&staging)?;
        let id = Uuid::new_v4().to_string();
        let mut record = TransactionRecord {
            schema_version: 1,
            transaction_id: id.clone(),
            endpoint: None,
            device_name: None,
            created_at: now_rfc3339()?,
            legacy_identity: true,
            legacy_state_generations: Vec::new(),
            replacement_host_id: None,
            verified_host_id: None,
        };
        write_new_private_file(
            &staging.join(TRANSACTION_METADATA),
            &serde_json::to_vec_pretty(&record)?,
        )?;
        let identity = staging.join(TRANSACTION_IDENTITY);
        copy_legacy_store(&self.root, &identity)?;
        if !legacy_copy_is_complete(&identity)? {
            return Err(invalid("legacy transaction copy did not complete"));
        }
        record.legacy_state_generations = legacy_copy_details(&identity)?.state_generations;
        replace_private_file(
            &staging.join(TRANSACTION_METADATA),
            &serde_json::to_vec_pretty(&record)?,
            &staging,
        )?;
        let copied = IdentityStore::new(&identity);
        if copied.load_or_create_identity()?.fingerprint() != expected_fingerprint
            || copied.client_id()? != expected_client_id
        {
            return Err(invalid(
                "legacy staging identity changed while being migrated",
            ));
        }
        remove_legacy_copy_marker(&identity)?;
        sync_directory(&staging)?;
        let directory = self.transactions_directory().join(&id);
        fs::rename(&staging, &directory).map_err(|source| storage_error(&directory, source))?;
        sync_directory(&self.transactions_directory())?;
        Ok(PairingTransaction {
            transaction_id: id,
            endpoint: record.endpoint,
            device_name: record.device_name,
            replacement_host_id: record.replacement_host_id,
            store: IdentityStore::new(directory.join(TRANSACTION_IDENTITY)),
        })
    }

    fn matching_transaction(
        &self,
        endpoint: &Endpoint,
        device_name: &str,
        replacement_host_id: Option<&str>,
    ) -> Result<Option<PairingTransaction>> {
        for transaction in self.pairing_transactions()? {
            let directory = self
                .transactions_directory()
                .join(&transaction.transaction_id);
            let record: TransactionRecord =
                read_private_json(&directory.join(TRANSACTION_METADATA))?;
            if record.endpoint.as_ref() == Some(endpoint)
                && record.device_name.as_deref() == Some(device_name)
                && record.replacement_host_id.as_deref() == replacement_host_id
            {
                return Ok(Some(transaction));
            }
        }
        Ok(None)
    }

    fn claim_legacy_transaction(
        &self,
        endpoint: &Endpoint,
        device_name: &str,
    ) -> Result<Option<PairingTransaction>> {
        for transaction in self.pairing_transactions()? {
            let directory = self
                .transactions_directory()
                .join(&transaction.transaction_id);
            let path = directory.join(TRANSACTION_METADATA);
            let mut record: TransactionRecord = read_private_json(&path)?;
            if record.legacy_identity && record.endpoint.is_none() {
                record.endpoint = Some(endpoint.clone());
                record.device_name = Some(device_name.to_owned());
                record.legacy_identity = false;
                replace_private_file(&path, &serde_json::to_vec_pretty(&record)?, &directory)?;
                return Ok(Some(transaction));
            }
        }
        Ok(None)
    }

    fn mark_transaction_verified(&self, transaction_id: &str, host_id: &str) -> Result<()> {
        let transaction_id = canonical_uuid(transaction_id)?;
        validate_host_id(host_id)?;
        let directory = self.transactions_directory().join(transaction_id);
        assert_real_directory(&directory, "pairing transaction")?;
        let path = directory.join(TRANSACTION_METADATA);
        let mut record: TransactionRecord = read_private_json(&path)?;
        if record
            .replacement_host_id
            .as_deref()
            .is_some_and(|expected| expected != host_id)
        {
            return Err(ClientError::HostCertificateMismatch);
        }
        record.verified_host_id = Some(host_id.to_owned());
        validate_transaction(&record, &record.transaction_id)?;
        replace_private_file(&path, &serde_json::to_vec_pretty(&record)?, &directory)
    }

    fn add_recovering(
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
                Ok(())
            }) {
                Ok(snapshot) => return Ok(snapshot),
                Err(ClientError::RegistryConflict { actual, .. }) => observed_revision = actual,
                Err(error) => return Err(error),
            }
        }
    }

    fn write_operation(&self, operation: &OperationIntent) -> Result<PathBuf> {
        validate_operation(operation)?;
        let directory = self.operations_directory();
        let path = directory.join(format!("{}.json", operation.operation_id));
        write_new_private_file(&path, &serde_json::to_vec_pretty(operation)?)?;
        sync_directory(&directory)?;
        Ok(path)
    }

    fn recover_operations(&self) -> Result<()> {
        let directory = self.operations_directory();
        let mut paths = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|source| storage_error(&directory, source))? {
            let entry = entry.map_err(|source| storage_error(&directory, source))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".trash-") {
                continue;
            }
            let id = name
                .strip_suffix(".json")
                .ok_or_else(|| invalid("operations directory contains an unexpected entry"))?;
            canonical_uuid(id)?;
            paths.push(entry.path());
        }
        paths.sort();
        for path in paths {
            let operation: OperationIntent = read_private_json(&path)?;
            validate_operation(&operation)?;
            match operation.kind {
                OperationKind::PromotePairing => self.recover_promotion(&operation, &path)?,
                OperationKind::RemoveHost => self.recover_removal(&operation, &path)?,
                OperationKind::MigrateLegacy => self.recover_migration(&operation, &path)?,
            }
        }
        // Trash is never a catalog source. It is safe to finish deleting only
        // operation-scoped directories whose Host has already left the registry.
        let snapshot = self.load_snapshot()?;
        for entry in fs::read_dir(&directory).map_err(|source| storage_error(&directory, source))? {
            let entry = entry.map_err(|source| storage_error(&directory, source))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".trash-")
                && (snapshot.is_none()
                    || snapshot.as_ref().is_some_and(|value| {
                        !value.hosts.iter().any(|host| name.ends_with(&host.host_id))
                    }))
            {
                remove_tree_checked(&entry.path(), &directory)?;
            }
        }
        Ok(())
    }

    fn recover_promotion(&self, operation: &OperationIntent, path: &Path) -> Result<()> {
        let transaction_id = operation
            .transaction_id
            .as_deref()
            .ok_or_else(|| invalid("promotion operation lacks a transaction ID"))?;
        let transaction = self.transactions_directory().join(transaction_id);
        let destination = self.hosts_directory().join(&operation.host_id);
        if !transaction.exists() {
            assert_real_directory(&destination, "promoted Host identity")?;
            let pairing = IdentityStore::new(&destination).load_pairing()?;
            if host_id(&pairing.host_certificate) != operation.host_id {
                return Err(invalid("promoted Host identity does not match the intent"));
            }
            let snapshot = self
                .load_snapshot()?
                .ok_or_else(|| invalid("promoted Host is missing its committed catalog"))?;
            if !snapshot
                .hosts
                .iter()
                .any(|host| host.host_id == operation.host_id)
            {
                return Err(invalid("promoted Host is missing its committed catalog"));
            }
            return remove_file_sync(path, &self.operations_directory());
        }
        assert_real_directory(&transaction, "pairing transaction")?;
        let record: TransactionRecord = read_private_json(&transaction.join(TRANSACTION_METADATA))?;
        validate_transaction(&record, transaction_id)?;
        if record.verified_host_id.as_deref() != Some(operation.host_id.as_str()) {
            return Err(invalid(
                "promotion intent was not backed by final pinned verification",
            ));
        }
        let source = transaction.join(TRANSACTION_IDENTITY);
        match (source.exists(), destination.exists()) {
            (true, false) => {
                assert_real_directory(&source, "pairing identity")?;
                let pairing = IdentityStore::new(&source).load_pairing()?;
                if host_id(&pairing.host_certificate) != operation.host_id {
                    return Err(invalid("promotion intent does not match the pinned Host"));
                }
                fs::rename(&source, &destination)
                    .map_err(|source| storage_error(&destination, source))?;
                sync_directory(&self.hosts_directory())?;
            }
            (true, true) => {
                return Err(ClientError::HostAlreadySaved(operation.host_id.clone()));
            }
            (false, false) => {
                return Err(invalid(
                    "promotion operation lost both staging and destination",
                ));
            }
            (false, true) => {}
        }
        let pairing = IdentityStore::new(&destination).load_pairing()?;
        if host_id(&pairing.host_certificate) != operation.host_id {
            return Err(invalid("promoted Host identity does not match the intent"));
        }
        self.add_recovering(&operation.host_id, operation.observed_revision)?;
        if transaction.exists() {
            remove_tree_checked(&transaction, &self.transactions_directory())?;
        }
        remove_file_sync(path, &self.operations_directory())
    }

    fn recover_migration(&self, operation: &OperationIntent, path: &Path) -> Result<()> {
        let temporary = self
            .hosts_directory()
            .join(format!(".migrate-{}", operation.operation_id));
        let destination = self.hosts_directory().join(&operation.host_id);
        if !temporary.exists() && !destination.exists() {
            // The durable intent preceded the copy, so the untouched singleton
            // remains authoritative and normal migration can restart it.
            return remove_file_sync(path, &self.operations_directory());
        }
        if temporary.exists() && destination.exists() {
            return Err(invalid(
                "legacy migration has both temporary and committed destinations",
            ));
        }
        if temporary.exists() {
            assert_real_directory(&temporary, "legacy migration staging")?;
            if !legacy_copy_is_complete(&temporary)? {
                remove_tree_checked(&temporary, &self.hosts_directory())?;
                return remove_file_sync(path, &self.operations_directory());
            }
            let pairing = IdentityStore::new(&temporary).load_pairing()?;
            if legacy_markers_exist(&self.root)
                && !legacy_pairing_copy_matches(&self.root, &temporary)?
            {
                // The singleton remains authoritative until migration commits.
                // Drop a complete but stale/mismatched copy so this open can
                // restart migration from the source instead of adopting it.
                remove_tree_checked(&temporary, &self.hosts_directory())?;
                return remove_file_sync(path, &self.operations_directory());
            }
            if host_id(&pairing.host_certificate) != operation.host_id {
                return Err(invalid(
                    "legacy migration intent does not match its Host pin",
                ));
            }
            fs::rename(&temporary, &destination)
                .map_err(|source| storage_error(&destination, source))?;
            sync_directory(&self.hosts_directory())?;
        }
        let pairing = IdentityStore::new(&destination).load_pairing()?;
        if host_id(&pairing.host_certificate) != operation.host_id {
            return Err(invalid(
                "migrated legacy identity does not match its Host pin",
            ));
        }
        let copied_state_generations = legacy_copy_details(&destination)?.state_generations;
        remove_legacy_copy_marker(&destination)?;
        match self.load_snapshot()? {
            None => self.publish_initial(&HostRegistrySnapshot {
                schema_version: 1,
                revision: 1,
                active_host_id: Some(operation.host_id.clone()),
                hosts: vec![HostRecord {
                    host_id: operation.host_id.clone(),
                    added_at: now_rfc3339()?,
                }],
            })?,
            Some(snapshot)
                if !snapshot
                    .hosts
                    .iter()
                    .any(|host| host.host_id == operation.host_id) =>
            {
                self.add_recovering(&operation.host_id, snapshot.revision)?;
            }
            Some(_) => {}
        }
        self.finish_migration(
            &self.root.join(MIGRATION_MARKER),
            path,
            Some((Some(&operation.host_id), copied_state_generations)),
        )
    }

    fn recover_removal(&self, operation: &OperationIntent, path: &Path) -> Result<()> {
        let snapshot = self.load_snapshot()?;
        if snapshot.as_ref().is_some_and(|value| {
            value
                .hosts
                .iter()
                .any(|host| host.host_id == operation.host_id)
        }) {
            return remove_file_sync(path, &self.operations_directory());
        }
        self.finish_removal(operation, path)
    }

    fn finish_removal(&self, operation: &OperationIntent, path: &Path) -> Result<()> {
        let host = self.hosts_directory().join(&operation.host_id);
        let trash = self.operations_directory().join(format!(
            ".trash-{}-{}",
            operation.operation_id, operation.host_id
        ));
        if host.exists() {
            assert_real_directory(&host, "Host identity")?;
            if trash.exists() {
                return Err(invalid("removal trash destination already exists"));
            }
            fs::rename(&host, &trash).map_err(|source| storage_error(&trash, source))?;
            sync_directory(&self.hosts_directory())?;
            sync_directory(&self.operations_directory())?;
        }
        if trash.exists() {
            remove_tree_checked(&trash, &self.operations_directory())?;
        }
        self.cleanup_migrated_legacy_credentials(&operation.host_id)?;
        remove_file_sync(path, &self.operations_directory())
    }

    fn associate_legacy_migration(&self, host_id: &str, generations: &[String]) -> Result<()> {
        if generations.is_empty() {
            return Ok(());
        }
        let marker_path = self.root.join(MIGRATION_MARKER);
        let mut marker: MigrationMarker = read_private_json(&marker_path)?;
        validate_migration_marker(&marker)?;
        if marker.copied_state_generations != generations {
            return Err(invalid(
                "legacy transaction generations do not match migration marker",
            ));
        }
        match marker.migrated_host_id.as_deref() {
            Some(existing) if existing != host_id => {
                return Err(invalid(
                    "legacy migration is already associated with another Host",
                ));
            }
            Some(_) => return Ok(()),
            None => marker.migrated_host_id = Some(host_id.to_owned()),
        }
        replace_private_file(
            &marker_path,
            &serde_json::to_vec_pretty(&marker)?,
            &self.root,
        )
    }

    fn cleanup_migrated_legacy_credentials(&self, removed_host_id: &str) -> Result<()> {
        let marker_path = self.root.join(MIGRATION_MARKER);
        if !marker_path.exists() {
            return Ok(());
        }
        let marker: MigrationMarker = read_private_json(&marker_path)?;
        validate_migration_marker(&marker)?;
        if marker.migrated_host_id.as_deref() != Some(removed_host_id) {
            return Ok(());
        }
        let state = self.root.join("state");
        for generation in &marker.copied_state_generations {
            let directory = state.join(generation);
            if !directory.exists() {
                continue;
            }
            assert_real_directory(&directory, "migrated legacy credential generation")?;
            let files: &[&str] = if generation.starts_with("identity-") {
                &["client-certificate.der", "client-private-key.der"]
            } else {
                &["host-certificate.der", "pairing-metadata.json"]
            };
            for file in files {
                remove_file_sync(&directory.join(file), &directory)?;
            }
            match fs::remove_dir(&directory) {
                Ok(()) => sync_directory(&state)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                Err(error) => return Err(storage_error(&directory, error)),
            }
        }
        Ok(())
    }

    fn migrate_legacy_singleton(&self) -> Result<()> {
        let marker = self.root.join(MIGRATION_MARKER);
        if marker.exists() {
            let marker: MigrationMarker = read_private_json(&marker)?;
            validate_migration_marker(&marker)?;
            return Ok(());
        }
        if !legacy_markers_exist(&self.root) {
            write_new_private_file(
                &marker,
                &serde_json::to_vec_pretty(&MigrationMarker {
                    schema_version: 1,
                    completed_at: now_rfc3339()?,
                    migrated_host_id: None,
                    copied_state_generations: Vec::new(),
                })?,
            )?;
            sync_directory(&self.root)?;
            return Ok(());
        }

        let legacy = IdentityStore::new(&self.root);
        let identity = legacy.load_or_create_identity()?;
        let fingerprint = identity.fingerprint();
        let client_id = legacy.client_id()?;
        if legacy.is_paired() {
            let pairing = legacy.load_pairing()?;
            let profile = legacy
                .load_connection_profile()?
                .ok_or_else(|| invalid("paired legacy identity has no connection profile"))?;
            let id = host_id(&pairing.host_certificate);
            if self.hosts_directory().join(&id).exists() {
                return Err(ClientError::HostAlreadySaved(id));
            }
            let operation = OperationIntent {
                schema_version: 1,
                operation_id: Uuid::new_v4().to_string(),
                kind: OperationKind::MigrateLegacy,
                host_id: id.clone(),
                transaction_id: None,
                observed_revision: self.load_snapshot()?.map_or(0, |value| value.revision),
            };
            let operation_path = self.write_operation(&operation)?;
            let temporary = self
                .hosts_directory()
                .join(format!(".migrate-{}", operation.operation_id));
            copy_legacy_store(&self.root, &temporary)?;
            if !legacy_copy_is_complete(&temporary)? {
                return Err(invalid("legacy migration copy did not complete"));
            }
            let copied = IdentityStore::new(&temporary);
            let copied_pairing = copied.load_pairing()?;
            let copied_profile = copied
                .load_connection_profile()?
                .ok_or_else(|| invalid("copied legacy profile is missing"))?;
            if copied_pairing.identity.fingerprint() != fingerprint
                || copied.client_id()? != client_id
                || copied_pairing.metadata.client_id != client_id
                || copied_pairing.host_certificate != pairing.host_certificate
                || copied_profile != profile
            {
                return Err(invalid("legacy identity changed while being migrated"));
            }
            let destination = self.hosts_directory().join(&id);
            fs::rename(&temporary, &destination)
                .map_err(|source| storage_error(&destination, source))?;
            sync_directory(&self.hosts_directory())?;
            let copied_state_generations = legacy_copy_details(&destination)?.state_generations;
            remove_legacy_copy_marker(&destination)?;
            if self.load_snapshot()?.is_none() {
                self.publish_initial(&HostRegistrySnapshot {
                    schema_version: 1,
                    revision: 1,
                    active_host_id: Some(id.clone()),
                    hosts: vec![HostRecord {
                        host_id: id,
                        added_at: now_rfc3339()?,
                    }],
                })?;
            } else {
                let revision = self.snapshot()?.revision;
                self.add_recovering(&operation.host_id, revision)?;
            }
            self.finish_migration(
                &marker,
                &operation_path,
                Some((Some(&operation.host_id), copied_state_generations)),
            )?;
        } else {
            let pending = legacy.load_pending_pairing()?;
            let stale_staging = self
                .transactions_directory()
                .join(LEGACY_TRANSACTION_STAGING);
            if stale_staging.exists() {
                remove_tree_checked(&stale_staging, &self.transactions_directory())?;
            }
            let mut recoverable = None;
            for transaction in self.pairing_transactions()? {
                let metadata_path = self
                    .transactions_directory()
                    .join(&transaction.transaction_id)
                    .join(TRANSACTION_METADATA);
                let record: TransactionRecord = read_private_json(&metadata_path)?;
                if record.legacy_identity && record.endpoint.is_none() {
                    recoverable = Some(transaction);
                    break;
                }
            }
            let transaction = match recoverable {
                Some(transaction) => transaction,
                None => self.create_legacy_transaction(&fingerprint, &client_id)?,
            };
            let copied = IdentityStore::new(transaction.store.root());
            if copied.load_or_create_identity()?.fingerprint() != fingerprint
                || copied.client_id()? != client_id
            {
                return Err(invalid(
                    "legacy staging identity changed while being migrated",
                ));
            }
            if let Some(pending) = pending {
                let copied_pending = copied
                    .load_pending_pairing()?
                    .ok_or_else(|| invalid("pending legacy pairing was not preserved"))?;
                if copied_pending.host_certificate != pending.host_certificate {
                    return Err(invalid("pending Host pin changed while being migrated"));
                }
                let metadata_path = self
                    .transactions_directory()
                    .join(&transaction.transaction_id)
                    .join(TRANSACTION_METADATA);
                let mut record: TransactionRecord = read_private_json(&metadata_path)?;
                record.endpoint = Some(pending.metadata.endpoint);
                record.device_name = Some(pending.metadata.device_name);
                record.legacy_identity = false;
                record.verified_host_id = None;
                replace_private_file(
                    &metadata_path,
                    &serde_json::to_vec_pretty(&record)?,
                    metadata_path.parent().expect("metadata has parent"),
                )?;
            }
            let record: TransactionRecord = read_private_json(
                &self
                    .transactions_directory()
                    .join(&transaction.transaction_id)
                    .join(TRANSACTION_METADATA),
            )?;
            self.finish_migration(
                &marker,
                &self.root.join(".no-operation"),
                Some((None, record.legacy_state_generations)),
            )?;
        }
        Ok(())
    }

    fn finish_migration(
        &self,
        marker: &Path,
        operation_path: &Path,
        copied: Option<(Option<&str>, Vec<String>)>,
    ) -> Result<()> {
        if marker.exists() {
            let existing: MigrationMarker = read_private_json(marker)?;
            validate_migration_marker(&existing)?;
            if let Some((host_id, generations)) = copied
                && (existing.migrated_host_id.as_deref() != host_id
                    || existing.copied_state_generations != generations)
            {
                return Err(invalid(
                    "legacy migration marker does not match the copied identity",
                ));
            }
        } else {
            let (migrated_host_id, copied_state_generations) = copied
                .map(|(host_id, generations)| (host_id.map(str::to_owned), generations))
                .unwrap_or_default();
            write_new_private_file(
                marker,
                &serde_json::to_vec_pretty(&MigrationMarker {
                    schema_version: 1,
                    completed_at: now_rfc3339()?,
                    migrated_host_id,
                    copied_state_generations,
                })?,
            )?;
            sync_directory(&self.root)?;
        }
        for name in LEGACY_FILES {
            let path = self.root.join(name);
            if path.exists() {
                remove_file_sync(&path, &self.root)?;
            }
        }
        // The journals can contain files from newer versions or an operator.
        // Keep both trees intact: only the individually copied, fixed-name
        // top-level legacy files above are proven safe to remove.
        if operation_path.exists() {
            remove_file_sync(operation_path, &self.operations_directory())?;
        }
        Ok(())
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

fn validate_transaction(record: &TransactionRecord, expected_id: &str) -> Result<()> {
    if record.schema_version != 1
        || canonical_uuid(&record.transaction_id)? != expected_id
        || OffsetDateTime::parse(&record.created_at, &Rfc3339).is_err()
        || record.endpoint.is_some() != record.device_name.is_some()
        || record.device_name.as_deref().is_some_and(str::is_empty)
    {
        return Err(invalid("pairing transaction metadata is invalid"));
    }
    validate_state_generations(&record.legacy_state_generations)?;
    if let Some(host_id) = &record.replacement_host_id {
        validate_host_id(host_id)?;
        if record.endpoint.is_none() || record.legacy_identity {
            return Err(invalid("replacement pairing transaction is invalid"));
        }
    }
    if let Some(host_id) = &record.verified_host_id {
        validate_host_id(host_id)?;
        if record.endpoint.is_none()
            || record
                .replacement_host_id
                .as_ref()
                .is_some_and(|expected| expected != host_id)
        {
            return Err(invalid(
                "verified pairing transaction has invalid Host identity",
            ));
        }
    }
    if record.legacy_identity && record.verified_host_id.is_some() {
        return Err(invalid("pairing transaction metadata is invalid"));
    }
    Ok(())
}

fn validate_operation(operation: &OperationIntent) -> Result<()> {
    if operation.schema_version != 1
        || canonical_uuid(&operation.operation_id)? != operation.operation_id
    {
        return Err(invalid("operation intent is invalid"));
    }
    validate_host_id(&operation.host_id)?;
    match operation.kind {
        OperationKind::PromotePairing => {
            let id = operation
                .transaction_id
                .as_deref()
                .ok_or_else(|| invalid("promotion intent lacks a transaction ID"))?;
            canonical_uuid(id)?;
        }
        OperationKind::RemoveHost | OperationKind::MigrateLegacy => {
            if operation.transaction_id.is_some() {
                return Err(invalid("operation intent has an unexpected transaction ID"));
            }
        }
    }
    Ok(())
}

fn canonical_uuid(value: &str) -> Result<String> {
    let parsed = Uuid::parse_str(value).map_err(|_| invalid("path ID is not a valid UUID"))?;
    let canonical = parsed.hyphenated().to_string();
    if canonical != value {
        return Err(invalid("path ID is not a canonical lowercase UUID"));
    }
    Ok(canonical)
}

fn parse_registry_filename(value: &str) -> Option<u64> {
    let revision = value.strip_prefix("registry-")?.strip_suffix(".json")?;
    if revision.len() != 20 || !revision.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    revision.parse().ok()
}

fn validate_migration_marker(marker: &MigrationMarker) -> Result<()> {
    if marker.schema_version != 1 || OffsetDateTime::parse(&marker.completed_at, &Rfc3339).is_err()
    {
        return Err(invalid("legacy migration marker is invalid"));
    }
    if let Some(host_id) = &marker.migrated_host_id {
        validate_host_id(host_id)?;
    }
    validate_state_generations(&marker.copied_state_generations)
}

fn validate_state_generations(generations: &[String]) -> Result<()> {
    let mut previous: Option<&str> = None;
    for generation in generations {
        if previous.is_some_and(|value| value >= generation.as_str()) {
            return Err(invalid(
                "legacy state generation list is duplicated or unsorted",
            ));
        }
        let uuid = generation
            .strip_prefix("identity-")
            .or_else(|| generation.strip_prefix("pairing-"))
            .ok_or_else(|| invalid("legacy state generation is invalid"))?;
        let parsed = Uuid::parse_str(uuid)
            .map_err(|_| invalid("legacy state generation UUID is invalid"))?;
        if parsed.to_string() != uuid {
            return Err(invalid("legacy state generation UUID is not canonical"));
        }
        previous = Some(generation);
    }
    Ok(())
}

fn legacy_markers_exist(root: &Path) -> bool {
    LEGACY_FILES.iter().any(|name| root.join(name).exists())
        || LEGACY_DIRECTORIES
            .iter()
            .any(|name| root.join(name).exists())
}

fn copy_legacy_store(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err(invalid("legacy migration destination already exists"));
    }
    fs::create_dir(destination).map_err(|source_error| storage_error(destination, source_error))?;
    set_private_directory_permissions(destination)?;
    for name in LEGACY_FILES {
        let from = source.join(name);
        if from.exists() {
            copy_private_file(&from, &destination.join(name))?;
        }
    }
    let state_generations = copy_referenced_legacy_state(source, destination)?;
    copy_legacy_profiles(source, destination)?;
    sync_directory(destination)?;
    write_new_private_file(
        &destination.join(LEGACY_COPY_MARKER),
        &serde_json::to_vec_pretty(&LegacyCopyMarker {
            schema_version: 1,
            state_generations,
        })?,
    )?;
    sync_directory(destination)
}

fn legacy_copy_is_complete(directory: &Path) -> Result<bool> {
    let marker = directory.join(LEGACY_COPY_MARKER);
    match fs::symlink_metadata(&marker) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(invalid("legacy copy completion marker is invalid"));
            }
            legacy_copy_details(directory)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(storage_error(&marker, error)),
    }
}

fn legacy_copy_details(directory: &Path) -> Result<LegacyCopyMarker> {
    let marker: LegacyCopyMarker = read_private_json(&directory.join(LEGACY_COPY_MARKER))?;
    if marker.schema_version != 1 {
        return Err(invalid("legacy copy completion marker is invalid"));
    }
    validate_state_generations(&marker.state_generations)?;
    Ok(marker)
}

fn remove_legacy_copy_marker(directory: &Path) -> Result<()> {
    remove_file_sync(&directory.join(LEGACY_COPY_MARKER), directory)
}

fn copy_referenced_legacy_state(source: &Path, destination: &Path) -> Result<Vec<String>> {
    let source_state = source.join("state");
    if !source_state.exists() {
        return Ok(Vec::new());
    }
    assert_real_directory(&source_state, "legacy identity state")?;
    let destination_state = destination.join("state");
    fs::create_dir(&destination_state).map_err(|error| storage_error(&destination_state, error))?;
    set_private_directory_permissions(&destination_state)?;
    let mut generations = HashSet::new();
    for manifest in [
        "client-identity-manifest.json",
        "pairing-manifest.json",
        "pending-pairing-manifest.json",
    ] {
        let path = source.join(manifest);
        if path.exists() {
            let value: serde_json::Value = read_private_json(&path)?;
            let generation = value
                .get("generation")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| invalid("legacy manifest has no generation"))?;
            generations.insert(generation.to_owned());
        }
    }
    let mut generations = generations.into_iter().collect::<Vec<_>>();
    generations.sort();
    for generation in &generations {
        let (uuid, files): (&str, &[&str]) =
            if let Some(uuid) = generation.strip_prefix("identity-") {
                (uuid, &["client-certificate.der", "client-private-key.der"])
            } else if let Some(uuid) = generation.strip_prefix("pairing-") {
                (uuid, &["host-certificate.der", "pairing-metadata.json"])
            } else {
                return Err(invalid("legacy manifest generation is invalid"));
            };
        let parsed = Uuid::parse_str(uuid)
            .map_err(|_| invalid("legacy manifest generation UUID is invalid"))?;
        if parsed.to_string() != uuid {
            return Err(invalid("legacy manifest generation UUID is not canonical"));
        }
        let from = source_state.join(generation);
        assert_real_directory(&from, "legacy credential generation")?;
        let to = destination_state.join(generation);
        fs::create_dir(&to).map_err(|error| storage_error(&to, error))?;
        set_private_directory_permissions(&to)?;
        for file in files {
            copy_private_file(&from.join(file), &to.join(file))?;
        }
        sync_directory(&to)?;
    }
    sync_directory(&destination_state)?;
    Ok(generations)
}

fn legacy_pairing_copy_matches(source: &Path, destination: &Path) -> Result<bool> {
    let legacy = IdentityStore::new(source);
    let copied = IdentityStore::new(destination);
    let legacy_pairing = legacy.load_pairing()?;
    let copied_pairing = copied.load_pairing()?;
    let legacy_profile = legacy
        .load_connection_profile()?
        .ok_or_else(|| invalid("paired legacy identity has no connection profile"))?;
    let copied_profile = copied
        .load_connection_profile()?
        .ok_or_else(|| invalid("copied legacy profile is missing"))?;

    Ok(
        copied_pairing.identity.fingerprint() == legacy_pairing.identity.fingerprint()
            && copied.client_id()? == legacy.client_id()?
            && copied_pairing.metadata.client_id == legacy_pairing.metadata.client_id
            && copied_pairing.host_certificate == legacy_pairing.host_certificate
            && copied_profile == legacy_profile,
    )
}

fn copy_legacy_profiles(source: &Path, destination: &Path) -> Result<()> {
    let from = source.join("connection-profile-history");
    if !from.exists() {
        return Ok(());
    }
    assert_real_directory(&from, "legacy profile history")?;
    let to = destination.join("connection-profile-history");
    fs::create_dir(&to).map_err(|error| storage_error(&to, error))?;
    set_private_directory_permissions(&to)?;
    for entry in fs::read_dir(&from).map_err(|error| storage_error(&from, error))? {
        let entry = entry.map_err(|error| storage_error(&from, error))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_legacy_profile_filename(name) {
            copy_private_file(&entry.path(), &to.join(name))?;
        }
    }
    sync_directory(&to)
}

fn is_legacy_profile_filename(name: &str) -> bool {
    let Some(value) = name
        .strip_prefix("profile-")
        .and_then(|rest| rest.strip_suffix(".json"))
    else {
        return false;
    };
    if value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return true;
    }
    let Some((revision, id)) = value.split_once('-') else {
        return false;
    };
    revision.len() == 20
        && revision.bytes().all(|byte| byte.is_ascii_digit())
        && canonical_uuid(id).is_ok()
}

fn copy_private_file(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source).map_err(|error| storage_error(source, error))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid("legacy identity component is not a regular file"));
    }
    let bytes = fs::read(source).map_err(|error| storage_error(source, error))?;
    write_new_private_file(destination, &bytes)
}

fn ensure_root_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(invalid("client data root is not a real directory"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|source| storage_error(path, source))?;
            assert_real_directory(path, "client data root")?;
        }
        Err(source) => return Err(storage_error(path, source)),
    }
    set_private_directory_permissions(path)
}

fn ensure_fixed_directory(root: &Path, name: &str) -> Result<()> {
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(invalid("client data component is not a real directory"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|source| storage_error(&path, source))?;
            sync_directory(root)?;
        }
        Err(source) => return Err(storage_error(&path, source)),
    }
    set_private_directory_permissions(&path)
}

fn assert_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid(format!("{label} is not a real directory")));
    }
    Ok(())
}

fn remove_tree_checked(path: &Path, parent: &Path) -> Result<()> {
    if path.parent() != Some(parent) {
        return Err(invalid(
            "refused to remove a directory outside its expected parent",
        ));
    }
    assert_real_directory(path, "removal target")?;
    fs::remove_dir_all(path).map_err(|source| storage_error(path, source))?;
    sync_directory(parent)
}

fn replace_private_file(path: &Path, bytes: &[u8], parent: &Path) -> Result<()> {
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    write_new_private_file(&temporary, bytes)?;
    fs::rename(&temporary, path).map_err(|source| storage_error(path, source))?;
    sync_directory(parent)
}

fn read_private_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid("registry state is not a regular file"));
    }
    serde_json::from_slice(&fs::read(path).map_err(|source| storage_error(path, source))?)
        .map_err(ClientError::from)
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
    Ok(())
}

fn remove_file_sync(path: &Path, parent: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => sync_directory(parent),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(storage_error(path, source)),
    }
}

fn now_rfc3339() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| invalid(format!("could not format registry timestamp: {error}")))
}

fn invalid(message: impl Into<String>) -> ClientError {
    ClientError::InvalidPairing(message.into())
}

fn storage_error(path: &Path, source: std::io::Error) -> ClientError {
    ClientError::Storage {
        path: path.display().to_string(),
        source,
    }
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

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|source| storage_error(path, source))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::{Arc, Barrier},
        thread,
    };

    use super::*;
    use crate::{ClientIdentity, Endpoint};

    fn root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("aludock-registry-{name}-{}", Uuid::new_v4()))
    }

    fn committed_unverified_host(
        registry: &HostRegistry,
        host: &ClientIdentity,
        endpoint: Endpoint,
        device_name: &str,
    ) -> (String, String) {
        let transaction = registry
            .start_pairing_transaction(endpoint.clone(), device_name)
            .unwrap();
        let identity = transaction.store.load_or_create_identity().unwrap();
        let client_id = transaction.store.client_id().unwrap();
        transaction
            .store
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                device_name,
                &client_id,
            )
            .unwrap();
        (transaction.transaction_id, host_id(host.certificate_der()))
    }

    fn synthetic_host(registry: &HostRegistry, host: &ClientIdentity) -> (String, String) {
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        let (transaction_id, id) = committed_unverified_host(registry, host, endpoint, "test");
        registry
            .mark_transaction_verified(&transaction_id, &id)
            .unwrap();
        (transaction_id, id)
    }

    #[test]
    fn creates_a_versioned_empty_registry_and_rejects_future_schema() {
        let path = root("schema");
        let registry = HostRegistry::open(&path).unwrap();
        assert_eq!(registry.snapshot().unwrap(), HostRegistrySnapshot::empty());
        let file = path
            .join(REGISTRY_DIRECTORY)
            .join("registry-00000000000000000001.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        value["schemaVersion"] = 2.into();
        fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(HostRegistry::open(&path).is_err());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn canonical_ids_and_stale_cas_are_rejected() {
        for invalid in ["../x", &"A".repeat(64), &"g".repeat(64), &"０".repeat(64)] {
            assert!(validate_host_id(invalid).is_err());
        }
        let path = root("cas");
        let registry = HostRegistry::open(&path).unwrap();
        let host = ClientIdentity::generate().unwrap();
        let (transaction, id) = synthetic_host(&registry, &host);
        let revision = registry.promote_pairing(&transaction, &id).unwrap();
        registry.set_active_host(&id, revision).unwrap();
        assert!(matches!(
            registry.set_active_host(&id, revision),
            Err(ClientError::RegistryConflict { .. })
        ));
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn identities_are_isolated_and_collisions_never_overwrite() {
        let path = root("isolation");
        let registry = HostRegistry::open(&path).unwrap();
        let host_a = ClientIdentity::generate().unwrap();
        let host_b = ClientIdentity::generate().unwrap();
        let (tx_a, id_a) = synthetic_host(&registry, &host_a);
        registry.promote_pairing(&tx_a, &id_a).unwrap();
        let (tx_b, id_b) = synthetic_host(&registry, &host_b);
        registry.promote_pairing(&tx_b, &id_b).unwrap();
        let store_a = registry.resolve_store(Some(&id_a)).unwrap();
        let store_b = registry.resolve_store(Some(&id_b)).unwrap();
        assert_ne!(
            store_a.load_pairing().unwrap().identity.fingerprint(),
            store_b.load_pairing().unwrap().identity.fingerprint()
        );
        assert_ne!(store_a.client_id().unwrap(), store_b.client_id().unwrap());

        let (collision, collision_id) = synthetic_host(&registry, &host_a);
        let collision_store = registry
            .transactions_directory()
            .join(&collision)
            .join(TRANSACTION_IDENTITY);
        let fingerprint = IdentityStore::new(&collision_store)
            .load_pairing()
            .unwrap()
            .identity
            .fingerprint();
        assert!(matches!(
            registry.promote_pairing(&collision, &collision_id),
            Err(ClientError::HostAlreadySaved(_))
        ));
        assert_eq!(
            IdentityStore::new(collision_store)
                .load_pairing()
                .unwrap()
                .identity
                .fingerprint(),
            fingerprint
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn re_pairing_same_host_replaces_revoked_client_identity() {
        let path = root("re-pair");
        let registry = HostRegistry::open(&path).unwrap();
        let host = ClientIdentity::generate().unwrap();
        let (original_transaction, saved_host_id) = synthetic_host(&registry, &host);
        registry
            .promote_pairing(&original_transaction, &saved_host_id)
            .unwrap();
        registry
            .resolve_store(Some(&saved_host_id))
            .unwrap()
            .update_connection_profile(|profile| {
                profile.display_name = "家里的工作站".into();
                Ok(())
            })
            .unwrap();
        let original_fingerprint = registry
            .resolve_store(Some(&saved_host_id))
            .unwrap()
            .load_pairing()
            .unwrap()
            .identity
            .fingerprint();

        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        let replacement = registry
            .start_repairing_transaction(endpoint.clone(), "test", &saved_host_id)
            .unwrap();
        assert_eq!(
            replacement.replacement_host_id.as_deref(),
            Some(saved_host_id.as_str())
        );
        let other_host = ClientIdentity::generate().unwrap();
        assert!(matches!(
            registry.mark_transaction_verified(
                &replacement.transaction_id,
                &host_id(other_host.certificate_der())
            ),
            Err(ClientError::HostCertificateMismatch)
        ));
        let replacement_identity = replacement.store.load_or_create_identity().unwrap();
        let replacement_fingerprint = replacement_identity.fingerprint();
        let client_id = replacement.store.client_id().unwrap();
        replacement
            .store
            .save_pairing(
                &replacement_identity,
                host.certificate_der(),
                &endpoint,
                "test",
                &client_id,
            )
            .unwrap();
        registry
            .mark_transaction_verified(&replacement.transaction_id, &saved_host_id)
            .unwrap();
        registry
            .promote_repairing(&replacement.transaction_id, &saved_host_id)
            .unwrap();

        let snapshot = registry.snapshot().unwrap();
        assert_eq!(
            snapshot.active_host_id.as_deref(),
            Some(saved_host_id.as_str())
        );
        assert_eq!(snapshot.hosts.len(), 1);
        assert_ne!(replacement_fingerprint, original_fingerprint);
        let replacement_store = registry.resolve_store(Some(&saved_host_id)).unwrap();
        assert_eq!(
            replacement_store
                .load_pairing()
                .unwrap()
                .identity
                .fingerprint(),
            replacement_fingerprint
        );
        assert_eq!(
            replacement_store
                .load_connection_profile()
                .unwrap()
                .unwrap()
                .display_name,
            "家里的工作站"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn deleting_a_host_discards_its_replacement_transactions() {
        let path = root("delete-with-re-pair");
        let registry = HostRegistry::open(&path).unwrap();
        let host = ClientIdentity::generate().unwrap();
        let (transaction_id, host_id) = synthetic_host(&registry, &host);
        registry.promote_pairing(&transaction_id, &host_id).unwrap();

        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        let replacement = registry
            .start_repairing_transaction(endpoint, "test", &host_id)
            .unwrap();
        let replacement_directory = registry
            .transactions_directory()
            .join(&replacement.transaction_id);
        let revision = registry.snapshot().unwrap().revision;
        registry.remove_local_host(&host_id, revision).unwrap();

        assert!(registry.pairing_transactions().unwrap().is_empty());
        assert!(!replacement_directory.exists());
        assert!(
            registry
                .promote_repairing(&replacement.transaction_id, &host_id)
                .is_err()
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn concurrent_repair_creation_cannot_escape_successful_host_deletion() {
        let path = root("delete-re-pair-race");
        let registry = Arc::new(HostRegistry::open(&path).unwrap());
        let host = ClientIdentity::generate().unwrap();
        let (transaction_id, host_id) = synthetic_host(&registry, &host);
        registry.promote_pairing(&transaction_id, &host_id).unwrap();
        let revision = registry.snapshot().unwrap().revision;
        let barrier = Arc::new(Barrier::new(2));

        let starter_registry = registry.clone();
        let starter_barrier = barrier.clone();
        let starter_host_id = host_id.clone();
        let starter = thread::spawn(move || {
            starter_barrier.wait();
            starter_registry.start_repairing_transaction(
                "127.0.0.1:9999".parse().unwrap(),
                "test",
                &starter_host_id,
            )
        });
        barrier.wait();
        registry.remove_local_host(&host_id, revision).unwrap();
        let _ = starter.join().unwrap();

        assert!(registry.snapshot().unwrap().hosts.is_empty());
        assert!(registry.pairing_transactions().unwrap().is_empty());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn historical_profile_filename_migration_preserves_exact_legacy_state() {
        let path = root("historical-profile-migration");
        let legacy = IdentityStore::new(&path);
        let identity = legacy.load_or_create_identity().unwrap();
        let client_id = legacy.client_id().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        legacy
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "legacy",
                &client_id,
            )
            .unwrap();
        let profile = legacy.load_connection_profile().unwrap().unwrap();
        let profile_directory = path.join("connection-profile-history");
        fs::rename(
            profile_directory.join("profile-00000000000000000001.json"),
            profile_directory.join(format!(
                "profile-00000000000000000001-{}.json",
                Uuid::new_v4()
            )),
        )
        .unwrap();
        let fingerprint = identity.fingerprint();
        let pin = host.certificate_der().to_vec();

        let registry = HostRegistry::open(&path).unwrap();
        let snapshot = registry.snapshot().unwrap();
        let migrated = registry
            .resolve_store(snapshot.active_host_id.as_deref())
            .unwrap();
        let pairing = migrated.load_pairing().unwrap();
        assert_eq!(pairing.identity.fingerprint(), fingerprint);
        assert_eq!(migrated.client_id().unwrap(), client_id);
        assert_eq!(pairing.metadata.client_id, client_id);
        assert_eq!(pairing.host_certificate, pin);
        assert_eq!(
            migrated.load_connection_profile().unwrap().unwrap(),
            profile
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn migration_preserves_unknown_state_and_profile_files() {
        let path = root("migration-unknown-files");
        let legacy = IdentityStore::new(&path);
        let identity = legacy.load_or_create_identity().unwrap();
        let client_id = legacy.client_id().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        legacy
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "legacy",
                &client_id,
            )
            .unwrap();
        legacy.load_connection_profile().unwrap().unwrap();
        let identity_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("client-identity-manifest.json")).unwrap())
                .unwrap();
        let generation = identity_manifest["generation"].as_str().unwrap().to_owned();
        let pairing_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("pairing-manifest.json")).unwrap()).unwrap();
        let pairing_generation = pairing_manifest["generation"].as_str().unwrap().to_owned();
        let unknown_state = path.join("state").join("future-state.bin");
        let unknown_generation_file = path.join("state").join(&generation).join("future-key.note");
        let unknown_profile = path
            .join("connection-profile-history")
            .join("future-profile.note");
        fs::write(&unknown_state, b"future state").unwrap();
        fs::write(&unknown_generation_file, b"future generation data").unwrap();
        fs::write(&unknown_profile, b"future profile data").unwrap();

        let registry = HostRegistry::open(&path).unwrap();
        let snapshot = registry.snapshot().unwrap();
        let migrated_host = snapshot.active_host_id.clone().unwrap();
        assert!(
            !registry
                .resolve_store(Some(&migrated_host))
                .unwrap()
                .root()
                .join("connection-profile-history")
                .join("future-profile.note")
                .exists()
        );
        registry
            .remove_local_host(&migrated_host, snapshot.revision)
            .unwrap();

        assert!(
            !path
                .join("state")
                .join(&generation)
                .join("client-certificate.der")
                .exists()
        );
        assert!(
            !path
                .join("state")
                .join(&generation)
                .join("client-private-key.der")
                .exists()
        );
        assert!(!path.join("state").join(&pairing_generation).exists());
        assert_eq!(fs::read(&unknown_state).unwrap(), b"future state");
        assert_eq!(
            fs::read(&unknown_generation_file).unwrap(),
            b"future generation data"
        );
        assert_eq!(fs::read(&unknown_profile).unwrap(), b"future profile data");
        fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn committed_pairing_retry_requires_cryptographic_revalidation() {
        let path = root("committed-pairing-retry");
        let registry = HostRegistry::open(&path).unwrap();
        let endpoint: Endpoint = "127.0.0.1:1".parse().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let (transaction_id, host_id) =
            committed_unverified_host(&registry, &host, endpoint.clone(), "retry");

        let error = registry
            .pair_host(endpoint, "retry", |_| {})
            .await
            .unwrap_err();

        assert!(error.to_string().contains("cryptographically revalidated"));
        assert!(!registry.hosts_directory().join(&host_id).exists());
        let record: TransactionRecord = read_private_json(
            &registry
                .transactions_directory()
                .join(transaction_id)
                .join(TRANSACTION_METADATA),
        )
        .unwrap();
        assert_eq!(record.verified_host_id, None);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn interrupted_migration_copy_is_discarded_and_recopied() {
        let path = root("interrupted-migration-copy");
        let legacy = IdentityStore::new(&path);
        let identity = legacy.load_or_create_identity().unwrap();
        let client_id = legacy.client_id().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        legacy
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "legacy",
                &client_id,
            )
            .unwrap();
        let id = host_id(host.certificate_der());
        let registry = HostRegistry {
            root: path.clone(),
            replacement_lock: Arc::new(Mutex::new(())),
        };
        registry.ensure_layout().unwrap();
        let operation = OperationIntent {
            schema_version: 1,
            operation_id: Uuid::new_v4().to_string(),
            kind: OperationKind::MigrateLegacy,
            host_id: id.clone(),
            transaction_id: None,
            observed_revision: 0,
        };
        registry.write_operation(&operation).unwrap();
        let incomplete = registry
            .hosts_directory()
            .join(format!(".migrate-{}", operation.operation_id));
        fs::create_dir(&incomplete).unwrap();
        fs::write(incomplete.join("partial"), b"incomplete").unwrap();

        let recovered = HostRegistry::open(&path).unwrap();

        assert!(recovered.resolve_store(Some(&id)).is_ok());
        assert!(!incomplete.exists());
        assert!(path.join("state").exists());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn complete_mismatched_migration_is_discarded_and_recopied() {
        let path = root("complete-mismatched-migration");
        let legacy = IdentityStore::new(&path);
        let identity = legacy.load_or_create_identity().unwrap();
        let client_id = legacy.client_id().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        legacy
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "legacy",
                &client_id,
            )
            .unwrap();
        let profile = legacy.load_connection_profile().unwrap().unwrap();
        let fingerprint = identity.fingerprint();
        let pin = host.certificate_der().to_vec();
        let id = host_id(&pin);

        let registry = HostRegistry {
            root: path.clone(),
            replacement_lock: Arc::new(Mutex::new(())),
        };
        registry.ensure_layout().unwrap();
        let operation = OperationIntent {
            schema_version: 1,
            operation_id: Uuid::new_v4().to_string(),
            kind: OperationKind::MigrateLegacy,
            host_id: id.clone(),
            transaction_id: None,
            observed_revision: 0,
        };
        let operation_path = registry.write_operation(&operation).unwrap();
        let temporary = registry
            .hosts_directory()
            .join(format!(".migrate-{}", operation.operation_id));
        copy_legacy_store(&path, &temporary).unwrap();
        IdentityStore::new(&temporary)
            .update_connection_profile(|copied_profile| {
                copied_profile.display_name = "mismatched staging profile".into();
                Ok(())
            })
            .unwrap();
        assert!(legacy_copy_is_complete(&temporary).unwrap());

        let recovered = HostRegistry::open(&path).unwrap();
        let migrated = recovered.resolve_store(Some(&id)).unwrap();
        let pairing = migrated.load_pairing().unwrap();
        assert_eq!(pairing.identity.fingerprint(), fingerprint);
        assert_eq!(migrated.client_id().unwrap(), client_id);
        assert_eq!(pairing.metadata.client_id, client_id);
        assert_eq!(pairing.host_certificate, pin);
        assert_eq!(
            migrated.load_connection_profile().unwrap().unwrap(),
            profile
        );
        assert!(!temporary.exists());
        assert!(!operation_path.exists());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn orphan_hosts_are_not_adopted_and_removal_keeps_sibling() {
        let path = root("removal");
        let registry = HostRegistry::open(&path).unwrap();
        let orphan = registry.hosts_directory().join("0".repeat(64));
        fs::create_dir(&orphan).unwrap();
        assert!(registry.snapshot().unwrap().hosts.is_empty());

        let host_a = ClientIdentity::generate().unwrap();
        let host_b = ClientIdentity::generate().unwrap();
        let (tx_a, id_a) = synthetic_host(&registry, &host_a);
        registry.promote_pairing(&tx_a, &id_a).unwrap();
        let (tx_b, id_b) = synthetic_host(&registry, &host_b);
        let revision = registry.promote_pairing(&tx_b, &id_b).unwrap();
        let snapshot = registry.remove_local_host(&id_b, revision).unwrap();
        assert!(!registry.hosts_directory().join(&id_b).exists());
        assert!(registry.hosts_directory().join(&id_a).exists());
        assert_eq!(snapshot.active_host_id.as_deref(), Some(id_a.as_str()));
        assert!(orphan.exists());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn unverified_staging_cannot_be_promoted() {
        let path = root("unverified-promotion");
        let registry = HostRegistry::open(&path).unwrap();
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        let transaction = registry
            .start_pairing_transaction(endpoint.clone(), "test")
            .unwrap();
        let identity = transaction.store.load_or_create_identity().unwrap();
        let client_id = transaction.store.client_id().unwrap();
        let host = ClientIdentity::generate().unwrap();
        transaction
            .store
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "test",
                &client_id,
            )
            .unwrap();
        let id = host_id(host.certificate_der());
        assert!(
            registry
                .promote_pairing(&transaction.transaction_id, &id)
                .is_err()
        );
        assert!(transaction.store.root().exists());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn unpaired_singleton_identity_is_preserved_for_only_one_transaction() {
        let path = root("unpaired-migration");
        let legacy = IdentityStore::new(&path);
        let fingerprint = legacy.load_or_create_identity().unwrap().fingerprint();
        let client_id = legacy.client_id().unwrap();
        let identity_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("client-identity-manifest.json")).unwrap())
                .unwrap();
        let legacy_generation = identity_manifest["generation"].as_str().unwrap().to_owned();
        let registry = HostRegistry::open(&path).unwrap();
        let transactions = registry.pairing_transactions().unwrap();
        assert_eq!(transactions.len(), 1);
        assert_eq!(
            transactions[0]
                .store
                .load_or_create_identity()
                .unwrap()
                .fingerprint(),
            fingerprint
        );
        assert_eq!(transactions[0].store.client_id().unwrap(), client_id);
        let next = registry
            .start_pairing_transaction("127.0.0.1:9999".parse().unwrap(), "first")
            .unwrap();
        assert_eq!(next.transaction_id, transactions[0].transaction_id);
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        let identity = next.store.load_or_create_identity().unwrap();
        let host = ClientIdentity::generate().unwrap();
        next.store
            .save_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "first",
                &client_id,
            )
            .unwrap();
        let migrated_host_id = host_id(host.certificate_der());
        registry
            .mark_transaction_verified(&next.transaction_id, &migrated_host_id)
            .unwrap();
        let revision = registry
            .promote_pairing(&next.transaction_id, &migrated_host_id)
            .unwrap();
        registry
            .remove_local_host(&migrated_host_id, revision)
            .unwrap();
        assert!(
            !path
                .join("state")
                .join(&legacy_generation)
                .join("client-private-key.der")
                .exists()
        );
        let subsequent = registry
            .start_pairing_transaction("127.0.0.1:9998".parse().unwrap(), "second")
            .unwrap();
        assert_ne!(
            subsequent
                .store
                .load_or_create_identity()
                .unwrap()
                .fingerprint(),
            fingerprint
        );
        assert_ne!(subsequent.store.client_id().unwrap(), client_id);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn flat_legacy_singleton_migrates_without_replacing_credentials() {
        let path = root("flat-migration");
        fs::create_dir_all(&path).unwrap();
        let identity = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        let client_id = Uuid::new_v4().to_string();
        let metadata = crate::PairingMetadata {
            schema_version: 1,
            endpoint,
            device_name: "flat legacy".into(),
            client_id: client_id.clone(),
            client_fingerprint: identity.fingerprint(),
        };
        for (name, bytes) in [
            ("client-certificate.der", identity.certificate_der()),
            ("client-private-key.der", identity.private_key_der()),
            ("host-certificate.der", host.certificate_der()),
        ] {
            fs::write(path.join(name), bytes).unwrap();
        }
        fs::write(
            path.join("pairing-metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        fs::write(path.join("client-id"), format!("{client_id}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            for name in [
                "client-certificate.der",
                "client-private-key.der",
                "host-certificate.der",
                "pairing-metadata.json",
                "client-id",
            ] {
                fs::set_permissions(path.join(name), fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
        let registry = HostRegistry::open(&path).unwrap();
        let migrated = registry
            .resolve_store(None)
            .unwrap()
            .load_pairing()
            .unwrap();
        assert_eq!(migrated.identity.fingerprint(), identity.fingerprint());
        assert_eq!(migrated.metadata.client_id, client_id);
        assert_eq!(migrated.host_certificate, host.certificate_der());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn pending_singleton_becomes_a_recoverable_transaction() {
        let path = root("pending-migration");
        let legacy = IdentityStore::new(&path);
        let identity = legacy.load_or_create_identity().unwrap();
        let fingerprint = identity.fingerprint();
        let client_id = legacy.client_id().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let endpoint: Endpoint = "127.0.0.1:9999".parse().unwrap();
        legacy
            .save_pending_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "legacy pending",
                &client_id,
            )
            .unwrap();

        let registry = HostRegistry::open(&path).unwrap();
        assert!(registry.snapshot().unwrap().hosts.is_empty());
        let transactions = registry.pairing_transactions().unwrap();
        assert_eq!(transactions.len(), 1);
        let pending = transactions[0]
            .store
            .load_pending_pairing()
            .unwrap()
            .unwrap();
        assert_eq!(pending.identity.fingerprint(), fingerprint);
        assert_eq!(pending.metadata.client_id, client_id);
        assert_eq!(pending.host_certificate, host.certificate_der());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn promotion_and_removal_intents_recover_without_touching_a_sibling() {
        let path = root("intent-recovery");
        let registry = HostRegistry::open(&path).unwrap();
        let host_a = ClientIdentity::generate().unwrap();
        let host_b = ClientIdentity::generate().unwrap();
        let (tx_a, id_a) = synthetic_host(&registry, &host_a);
        let revision_a = registry.promote_pairing(&tx_a, &id_a).unwrap();

        let (tx_b, id_b) = synthetic_host(&registry, &host_b);
        let operation = OperationIntent {
            schema_version: 1,
            operation_id: Uuid::new_v4().to_string(),
            kind: OperationKind::PromotePairing,
            host_id: id_b.clone(),
            transaction_id: Some(tx_b.clone()),
            observed_revision: revision_a,
        };
        registry.write_operation(&operation).unwrap();
        let source = registry
            .transactions_directory()
            .join(&tx_b)
            .join(TRANSACTION_IDENTITY);
        fs::rename(&source, registry.hosts_directory().join(&id_b)).unwrap();
        let registry = HostRegistry::open(&path).unwrap();
        let promoted = registry.snapshot().unwrap();
        assert!(promoted.hosts.iter().any(|host| host.host_id == id_b));

        let remove = OperationIntent {
            schema_version: 1,
            operation_id: Uuid::new_v4().to_string(),
            kind: OperationKind::RemoveHost,
            host_id: id_a.clone(),
            transaction_id: None,
            observed_revision: promoted.revision,
        };
        registry.write_operation(&remove).unwrap();
        registry
            .mutate(promoted.revision, |snapshot| {
                snapshot.hosts.retain(|host| host.host_id != id_a);
                if snapshot.active_host_id.as_deref() == Some(id_a.as_str()) {
                    snapshot.active_host_id = Some(id_b.clone());
                }
                Ok(())
            })
            .unwrap();
        let registry = HostRegistry::open(&path).unwrap();
        assert!(!registry.hosts_directory().join(&id_a).exists());
        assert!(registry.hosts_directory().join(&id_b).exists());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn promotion_recovery_accepts_committed_catalog_after_transaction_deletion() {
        let path = root("promotion-post-transaction-delete");
        let registry = HostRegistry::open(&path).unwrap();
        let host = ClientIdentity::generate().unwrap();
        let (transaction_id, id) = synthetic_host(&registry, &host);
        let operation = OperationIntent {
            schema_version: 1,
            operation_id: Uuid::new_v4().to_string(),
            kind: OperationKind::PromotePairing,
            host_id: id.clone(),
            transaction_id: Some(transaction_id.clone()),
            observed_revision: registry.snapshot().unwrap().revision,
        };
        let operation_path = registry.write_operation(&operation).unwrap();
        let transaction = registry.transactions_directory().join(&transaction_id);
        fs::rename(
            transaction.join(TRANSACTION_IDENTITY),
            registry.hosts_directory().join(&id),
        )
        .unwrap();
        registry
            .add_recovering(&id, operation.observed_revision)
            .unwrap();
        remove_tree_checked(&transaction, &registry.transactions_directory()).unwrap();

        let recovered = HostRegistry::open(&path).unwrap();

        assert!(recovered.resolve_store(Some(&id)).is_ok());
        assert!(!operation_path.exists());
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn fixed_component_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let path = root("symlink");
        fs::create_dir_all(&path).unwrap();
        let outside = root("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, path.join(HOSTS_DIRECTORY)).unwrap();
        assert!(HostRegistry::open(&path).is_err());
        fs::remove_file(path.join(HOSTS_DIRECTORY)).unwrap();
        fs::remove_dir_all(path).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
