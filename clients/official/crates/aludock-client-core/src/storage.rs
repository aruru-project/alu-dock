use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{
    ClientError, ClientIdentity, Endpoint, Result,
    private_fs::{
        remove_file_sync, set_private_directory_permissions, storage_error, sync_directory,
        write_new_private_file,
    },
};

const CLIENT_CERTIFICATE: &str = "client-certificate.der";
const CLIENT_PRIVATE_KEY: &str = "client-private-key.der";
const HOST_CERTIFICATE: &str = "host-certificate.der";
const METADATA: &str = "pairing-metadata.json";
const CLIENT_ID: &str = "client-id";
const STATE_DIRECTORY: &str = "state";
const IDENTITY_MANIFEST: &str = "client-identity-manifest.json";
const PAIRING_MANIFEST: &str = "pairing-manifest.json";
const PENDING_PAIRING_MANIFEST: &str = "pending-pairing-manifest.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingMetadata {
    pub schema_version: u32,
    pub endpoint: Endpoint,
    pub device_name: String,
    pub client_id: String,
    pub client_fingerprint: String,
}

pub struct StoredPairing {
    pub identity: ClientIdentity,
    pub host_certificate: Vec<u8>,
    pub metadata: PairingMetadata,
}

pub struct PendingPairing {
    pub identity: ClientIdentity,
    pub host_certificate: Vec<u8>,
    pub metadata: PairingMetadata,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityManifest {
    schema_version: u32,
    generation: String,
    client_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingManifest {
    schema_version: u32,
    generation: String,
}

#[derive(Clone, Debug)]
pub struct IdentityStore {
    root: PathBuf,
}

impl IdentityStore {
    pub fn platform_default() -> Result<Self> {
        let directories = ProjectDirs::from("moe", "aruru", "AluDock Client").ok_or_else(|| {
            ClientError::InvalidPairing("could not determine the application data directory".into())
        })?;
        Ok(Self::new(directories.data_local_dir().join("identity")))
    }

    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn load_or_create_identity(&self) -> Result<ClientIdentity> {
        self.ensure_private_directory()?;
        self.migrate_or_repair_legacy_identity()?;

        let manifest_path = self.root.join(IDENTITY_MANIFEST);
        if manifest_path.exists() {
            let manifest: IdentityManifest = self.read_json_file(&manifest_path)?;
            validate_manifest_generation(manifest.schema_version, &manifest.generation)?;
            let generation = self.state_directory().join(&manifest.generation);
            let identity = ClientIdentity::from_der(
                self.read_private_file(&generation.join(CLIENT_CERTIFICATE))?,
                self.read_private_file(&generation.join(CLIENT_PRIVATE_KEY))?,
            )?;
            if identity.fingerprint() != manifest.client_fingerprint {
                return Err(ClientError::InvalidPairing(
                    "committed client identity does not match its manifest".into(),
                ));
            }
            self.cleanup_unreferenced_generations()?;
            return Ok(identity);
        }

        let identity = ClientIdentity::generate()?;
        let generation = self.write_generation(
            "identity",
            &[
                (CLIENT_CERTIFICATE, identity.certificate_der()),
                (CLIENT_PRIVATE_KEY, identity.private_key_der()),
            ],
        )?;
        self.write_new_manifest(
            IDENTITY_MANIFEST,
            &IdentityManifest {
                schema_version: 1,
                generation,
                client_fingerprint: identity.fingerprint(),
            },
        )?;
        self.cleanup_unreferenced_generations()?;
        Ok(identity)
    }

    pub fn client_id(&self) -> Result<String> {
        self.ensure_private_directory()?;
        let path = self.root.join(CLIENT_ID);
        if path.exists() {
            let value = String::from_utf8(self.read_private_file(&path)?)
                .map_err(|_| ClientError::InvalidPairing("stored client ID is not UTF-8".into()))?;
            let value = value.trim();
            Uuid::parse_str(value)
                .map_err(|_| ClientError::InvalidPairing("stored client ID is invalid".into()))?;
            return Ok(value.to_owned());
        }
        let value = Uuid::new_v4().to_string();
        self.write_atomic_private_file(&path, format!("{value}\n").as_bytes(), false)?;
        Ok(value)
    }

    pub fn is_paired(&self) -> bool {
        self.root.join(PAIRING_MANIFEST).exists()
            || (self.root.join(HOST_CERTIFICATE).exists() && self.root.join(METADATA).exists())
    }

    pub fn save_pairing(
        &self,
        identity: &ClientIdentity,
        host_certificate: &[u8],
        endpoint: &Endpoint,
        device_name: &str,
        client_id: &str,
    ) -> Result<()> {
        self.ensure_private_directory()?;
        if self.is_paired() {
            return Err(ClientError::InvalidPairing(format!(
                "an existing paired identity already exists in {}",
                self.root.display()
            )));
        }
        let metadata = pairing_metadata(identity, endpoint, device_name, client_id);
        let generation = self.write_pairing_generation(host_certificate, &metadata)?;
        self.write_new_manifest(
            PAIRING_MANIFEST,
            &PairingManifest {
                schema_version: 1,
                generation,
            },
        )?;
        self.cleanup_unreferenced_generations()
    }

    pub fn save_pending_pairing(
        &self,
        identity: &ClientIdentity,
        host_certificate: &[u8],
        endpoint: &Endpoint,
        device_name: &str,
        client_id: &str,
    ) -> Result<()> {
        self.ensure_private_directory()?;
        if self.is_paired() || self.root.join(PENDING_PAIRING_MANIFEST).exists() {
            return Err(ClientError::InvalidPairing(format!(
                "pairing state already exists in {}",
                self.root.display()
            )));
        }
        let metadata = pairing_metadata(identity, endpoint, device_name, client_id);
        let generation = self.write_pairing_generation(host_certificate, &metadata)?;
        self.write_new_manifest(
            PENDING_PAIRING_MANIFEST,
            &PairingManifest {
                schema_version: 1,
                generation,
            },
        )?;
        self.cleanup_unreferenced_generations()
    }

    pub fn load_pending_pairing(&self) -> Result<Option<PendingPairing>> {
        self.ensure_private_directory()?;
        let identity = self.load_or_create_identity()?;
        let path = self.root.join(PENDING_PAIRING_MANIFEST);
        if !path.exists() {
            return Ok(None);
        }
        let manifest: PairingManifest = self.read_json_file(&path)?;
        let (host_certificate, metadata) = self.load_pairing_generation(&manifest, &identity)?;
        Ok(Some(PendingPairing {
            identity,
            host_certificate,
            metadata,
        }))
    }

    pub fn commit_pending_pairing(&self) -> Result<()> {
        self.ensure_private_directory()?;
        if self.root.join(PAIRING_MANIFEST).exists() {
            remove_file_sync(&self.root.join(PENDING_PAIRING_MANIFEST), &self.root)?;
            self.cleanup_unreferenced_generations()?;
            return Ok(());
        }
        let pending_path = self.root.join(PENDING_PAIRING_MANIFEST);
        let manifest: PairingManifest = self.read_json_file(&pending_path)?;
        let identity = self.load_or_create_identity()?;
        self.load_pairing_generation(&manifest, &identity)?;
        self.write_new_manifest(PAIRING_MANIFEST, &manifest)?;
        remove_file_sync(&pending_path, &self.root)?;
        self.cleanup_unreferenced_generations()
    }

    pub fn clear_pending_pairing(&self) -> Result<()> {
        self.ensure_private_directory()?;
        remove_file_sync(&self.root.join(PENDING_PAIRING_MANIFEST), &self.root)?;
        self.cleanup_unreferenced_generations()
    }

    pub fn load_pairing(&self) -> Result<StoredPairing> {
        self.ensure_private_directory()?;
        let identity = self.load_or_create_identity()?;
        self.migrate_legacy_pairing(&identity)?;
        let path = self.root.join(PAIRING_MANIFEST);
        if !path.exists() {
            if self.root.join(PENDING_PAIRING_MANIFEST).exists() {
                return Err(ClientError::InvalidPairing(
                    "pairing finalization is pending; reconnect to the same Host to recover it"
                        .into(),
                ));
            }
            return Err(ClientError::InvalidPairing(format!(
                "no paired Host is stored in {}",
                self.root.display()
            )));
        }
        let manifest: PairingManifest = self.read_json_file(&path)?;
        let (host_certificate, metadata) = self.load_pairing_generation(&manifest, &identity)?;
        self.cleanup_unreferenced_generations()?;
        Ok(StoredPairing {
            identity,
            host_certificate,
            metadata,
        })
    }

    fn write_pairing_generation(
        &self,
        host_certificate: &[u8],
        metadata: &PairingMetadata,
    ) -> Result<String> {
        let metadata_bytes = serde_json::to_vec_pretty(metadata)?;
        self.write_generation(
            "pairing",
            &[
                (HOST_CERTIFICATE, host_certificate),
                (METADATA, &metadata_bytes),
            ],
        )
    }

    fn load_pairing_generation(
        &self,
        manifest: &PairingManifest,
        identity: &ClientIdentity,
    ) -> Result<(Vec<u8>, PairingMetadata)> {
        validate_manifest_generation(manifest.schema_version, &manifest.generation)?;
        let generation = self.state_directory().join(&manifest.generation);
        let host_certificate = self.read_private_file(&generation.join(HOST_CERTIFICATE))?;
        let metadata: PairingMetadata = self.read_json_file(&generation.join(METADATA))?;
        if metadata.schema_version != 1 || metadata.client_fingerprint != identity.fingerprint() {
            return Err(ClientError::InvalidPairing(
                "stored pairing metadata does not match the client identity".into(),
            ));
        }
        Ok((host_certificate, metadata))
    }

    fn migrate_or_repair_legacy_identity(&self) -> Result<()> {
        if self.root.join(IDENTITY_MANIFEST).exists() {
            return Ok(());
        }
        let certificate_path = self.root.join(CLIENT_CERTIFICATE);
        let key_path = self.root.join(CLIENT_PRIVATE_KEY);
        match (certificate_path.exists(), key_path.exists()) {
            (true, true) => {
                let identity = ClientIdentity::from_der(
                    self.read_private_file(&certificate_path)?,
                    self.read_private_file(&key_path)?,
                )?;
                let generation = self.write_generation(
                    "identity",
                    &[
                        (CLIENT_CERTIFICATE, identity.certificate_der()),
                        (CLIENT_PRIVATE_KEY, identity.private_key_der()),
                    ],
                )?;
                self.write_new_manifest(
                    IDENTITY_MANIFEST,
                    &IdentityManifest {
                        schema_version: 1,
                        generation,
                        client_fingerprint: identity.fingerprint(),
                    },
                )?;
                remove_file_sync(&certificate_path, &self.root)?;
                remove_file_sync(&key_path, &self.root)
            }
            (false, false) => Ok(()),
            _ => {
                let has_pairing_state = self.is_paired()
                    || self.root.join(PENDING_PAIRING_MANIFEST).exists()
                    || self.root.join(HOST_CERTIFICATE).exists()
                    || self.root.join(METADATA).exists();
                if has_pairing_state {
                    return Err(ClientError::InvalidPairing(format!(
                        "client identity is incomplete but pairing state exists in {}",
                        self.root.display()
                    )));
                }
                remove_file_sync(&certificate_path, &self.root)?;
                remove_file_sync(&key_path, &self.root)
            }
        }
    }

    fn migrate_legacy_pairing(&self, identity: &ClientIdentity) -> Result<()> {
        if self.root.join(PAIRING_MANIFEST).exists() {
            return Ok(());
        }
        let certificate_path = self.root.join(HOST_CERTIFICATE);
        let metadata_path = self.root.join(METADATA);
        match (certificate_path.exists(), metadata_path.exists()) {
            (true, true) => {
                let host_certificate = self.read_private_file(&certificate_path)?;
                let metadata: PairingMetadata = self.read_json_file(&metadata_path)?;
                if metadata.schema_version != 1
                    || metadata.client_fingerprint != identity.fingerprint()
                {
                    return Err(ClientError::InvalidPairing(
                        "legacy pairing metadata does not match the client identity".into(),
                    ));
                }
                let generation = self.write_pairing_generation(&host_certificate, &metadata)?;
                self.write_new_manifest(
                    PAIRING_MANIFEST,
                    &PairingManifest {
                        schema_version: 1,
                        generation,
                    },
                )?;
                remove_file_sync(&certificate_path, &self.root)?;
                remove_file_sync(&metadata_path, &self.root)
            }
            (false, false) => Ok(()),
            _ => Err(ClientError::InvalidPairing(format!(
                "legacy pairing state is incomplete in {}",
                self.root.display()
            ))),
        }
    }

    fn write_generation(&self, kind: &str, files: &[(&str, &[u8])]) -> Result<String> {
        self.ensure_state_directory()?;
        let id = Uuid::new_v4();
        let generation = format!("{kind}-{id}");
        let temporary = self.state_directory().join(format!(".{generation}.tmp"));
        let committed = self.state_directory().join(&generation);
        fs::create_dir(&temporary).map_err(|source| storage_error(&temporary, source))?;
        set_private_directory_permissions(&temporary)?;
        sync_directory(&self.state_directory())?;

        let result = (|| {
            for (name, bytes) in files {
                write_new_private_file(&temporary.join(name), bytes)?;
            }
            sync_directory(&temporary)?;
            fs::rename(&temporary, &committed)
                .map_err(|source| storage_error(&committed, source))?;
            sync_directory(&self.state_directory())?;
            Ok(generation)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&temporary);
            let _ = sync_directory(&self.state_directory());
        }
        result
    }

    fn write_new_manifest<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value)?;
        self.write_atomic_private_file(&self.root.join(name), &bytes, false)
    }

    fn read_json_file<T: DeserializeOwned>(&self, path: &Path) -> Result<T> {
        serde_json::from_slice(&self.read_private_file(path)?).map_err(ClientError::from)
    }

    fn write_atomic_private_file(&self, path: &Path, bytes: &[u8], replace: bool) -> Result<()> {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ClientError::InvalidPairing("storage filename is invalid".into()))?;
        let temporary = path.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
        write_new_private_file(&temporary, bytes)?;
        if !replace {
            return match crate::fs_publish::publish_new_file(&temporary, path) {
                Ok(true) => sync_directory(&self.root),
                Ok(false) => Err(ClientError::InvalidPairing(format!(
                    "identity state already exists: {}",
                    path.display()
                ))),
                Err(source) => Err(storage_error(path, source)),
            };
        }
        fs::rename(&temporary, path).map_err(|source| storage_error(path, source))?;
        sync_directory(&self.root)
    }

    fn cleanup_unreferenced_generations(&self) -> Result<()> {
        let state = self.state_directory();
        if !state.exists() {
            return Ok(());
        }
        let mut referenced = HashSet::new();
        for name in [
            IDENTITY_MANIFEST,
            PAIRING_MANIFEST,
            PENDING_PAIRING_MANIFEST,
        ] {
            let path = self.root.join(name);
            if !path.exists() {
                continue;
            }
            let value: serde_json::Value = self.read_json_file(&path)?;
            if let Some(generation) = value.get("generation").and_then(|value| value.as_str()) {
                referenced.insert(generation.to_owned());
            }
        }
        for entry in fs::read_dir(&state).map_err(|source| storage_error(&state, source))? {
            let entry = entry.map_err(|source| storage_error(&state, source))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if referenced.contains(&name) {
                continue;
            }
            let Some(expected_files) = generated_state_files(&name) else {
                // Unknown state belongs to its creator. In particular, legacy
                // migration must never recursively erase it while inspecting
                // the singleton store.
                continue;
            };
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|source| storage_error(&path, source))?;
            if metadata.file_type().is_symlink() || metadata.is_file() {
                fs::remove_file(&path).map_err(|source| storage_error(&path, source))?;
            } else if metadata.is_dir() {
                if name.starts_with('.') && name.ends_with(".tmp") {
                    // Canonical dot-temporary generations are never committed
                    // user state and are wholly owned by this writer.
                    fs::remove_dir_all(&path).map_err(|source| storage_error(&path, source))?;
                } else {
                    for file_name in expected_files {
                        let file = path.join(file_name);
                        match fs::symlink_metadata(&file) {
                            Ok(metadata)
                                if metadata.is_file() && !metadata.file_type().is_symlink() =>
                            {
                                fs::remove_file(&file)
                                    .map_err(|source| storage_error(&file, source))?;
                            }
                            Ok(_) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                            Err(source) => return Err(storage_error(&file, source)),
                        }
                    }
                    match fs::remove_dir(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                        Err(source) => return Err(storage_error(&path, source)),
                    }
                }
            }
        }
        sync_directory(&state)
    }

    fn ensure_private_directory(&self) -> Result<()> {
        match fs::symlink_metadata(&self.root) {
            Ok(metadata) => assert_real_private_directory(&self.root, &metadata, "identity path")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(&self.root)
                    .map_err(|source| storage_error(&self.root, source))?;
                let metadata = fs::symlink_metadata(&self.root)
                    .map_err(|source| storage_error(&self.root, source))?;
                assert_real_private_directory(&self.root, &metadata, "identity path")?;
            }
            Err(source) => return Err(storage_error(&self.root, source)),
        }
        set_private_directory_permissions(&self.root)
    }

    fn ensure_state_directory(&self) -> Result<()> {
        let path = self.state_directory();
        match fs::symlink_metadata(&path) {
            Ok(metadata) => assert_real_private_directory(&path, &metadata, "identity state path")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&path).map_err(|source| storage_error(&path, source))?;
                sync_directory(&self.root)?;
                let metadata =
                    fs::symlink_metadata(&path).map_err(|source| storage_error(&path, source))?;
                assert_real_private_directory(&path, &metadata, "identity state path")?;
            }
            Err(source) => return Err(storage_error(&path, source)),
        }
        set_private_directory_permissions(&path)
    }

    fn state_directory(&self) -> PathBuf {
        self.root.join(STATE_DIRECTORY)
    }

    fn read_private_file(&self, path: &Path) -> Result<Vec<u8>> {
        let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ClientError::InvalidPairing(format!(
                "identity state is not a regular file: {}",
                path.display()
            )));
        }
        #[cfg(windows)]
        {
            let parent = path.parent().ok_or_else(|| {
                ClientError::InvalidPairing("identity state has no parent directory".into())
            })?;
            crate::windows_security::secure_directory(parent)
                .map_err(|source| storage_error(parent, source))?;
            crate::windows_security::secure_file(path)
                .map_err(|source| storage_error(path, source))?;
        }
        assert_private_file_permissions(path, &metadata)?;
        fs::read(path).map_err(|source| storage_error(path, source))
    }
}

fn pairing_metadata(
    identity: &ClientIdentity,
    endpoint: &Endpoint,
    device_name: &str,
    client_id: &str,
) -> PairingMetadata {
    PairingMetadata {
        schema_version: 1,
        endpoint: endpoint.clone(),
        device_name: device_name.to_owned(),
        client_id: client_id.to_owned(),
        client_fingerprint: identity.fingerprint(),
    }
}

fn generated_state_files(name: &str) -> Option<&'static [&'static str]> {
    let generation = name
        .strip_prefix('.')
        .and_then(|value| value.strip_suffix(".tmp"))
        .unwrap_or(name);
    let (id, files): (&str, &[&str]) = if let Some(id) = generation.strip_prefix("identity-") {
        (id, &[CLIENT_CERTIFICATE, CLIENT_PRIVATE_KEY])
    } else if let Some(id) = generation.strip_prefix("pairing-") {
        (id, &[HOST_CERTIFICATE, METADATA])
    } else {
        return None;
    };
    let parsed = Uuid::parse_str(id).ok()?;
    (parsed.to_string() == id).then_some(files)
}

fn validate_manifest_generation(schema_version: u32, generation: &str) -> Result<()> {
    let valid_kind = generation
        .strip_prefix("identity-")
        .or_else(|| generation.strip_prefix("pairing-"));
    let Some(id) = valid_kind else {
        return Err(ClientError::InvalidPairing(
            "identity manifest contains an invalid generation".into(),
        ));
    };
    if schema_version != 1 || Uuid::parse_str(id).is_err() || generation.contains(['/', '\\']) {
        return Err(ClientError::InvalidPairing(
            "identity manifest contains an invalid generation".into(),
        ));
    }
    Ok(())
}

fn assert_real_private_directory(path: &Path, metadata: &fs::Metadata, label: &str) -> Result<()> {
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ClientError::InvalidPairing(format!(
            "{label} is not a real directory: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn assert_private_file_permissions(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(ClientError::InvalidPairing(format!(
            "identity state must not be accessible by group or other users: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn assert_private_file_permissions(path: &Path, _metadata: &fs::Metadata) -> Result<()> {
    crate::windows_security::assert_private_file(path).map_err(|source| storage_error(path, source))
}

#[cfg(all(not(unix), not(windows)))]
fn assert_private_file_permissions(_path: &Path, _metadata: &fs::Metadata) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{CLIENT_CERTIFICATE, STATE_DIRECTORY};
    use crate::{ClientIdentity, Endpoint, IdentityStore};

    fn temporary_store(name: &str) -> (PathBuf, IdentityStore) {
        let path =
            std::env::temp_dir().join(format!("aludock-client-{name}-{}", uuid::Uuid::new_v4()));
        (path.clone(), IdentityStore::new(path))
    }

    #[test]
    fn repairs_an_interrupted_legacy_identity_creation() {
        let (path, store) = temporary_store("partial-identity");
        fs::create_dir_all(&path).expect("temp directory");
        let abandoned = ClientIdentity::generate().expect("identity");
        fs::write(path.join(CLIENT_CERTIFICATE), abandoned.certificate_der())
            .expect("partial certificate");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("directory mode");
            fs::set_permissions(
                path.join(CLIENT_CERTIFICATE),
                fs::Permissions::from_mode(0o600),
            )
            .expect("file mode");
        }

        let recovered = store
            .load_or_create_identity()
            .expect("partial uncommitted identity should be repaired");
        let loaded = store
            .load_or_create_identity()
            .expect("repaired identity should remain stable");
        assert_eq!(recovered.fingerprint(), loaded.fingerprint());
        assert_ne!(recovered.fingerprint(), abandoned.fingerprint());
        fs::remove_dir_all(path).expect("cleanup");
    }

    #[test]
    fn ignores_and_removes_an_uncommitted_generation() {
        let (path, store) = temporary_store("orphan-generation");
        let orphan = path
            .join(STATE_DIRECTORY)
            .join(format!(".identity-{}.tmp", uuid::Uuid::new_v4()));
        fs::create_dir_all(&orphan).expect("orphan generation");
        fs::write(orphan.join("partial"), b"not committed").expect("orphan file");

        let first = store.load_or_create_identity().expect("create identity");
        let second = store.load_or_create_identity().expect("load identity");
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert!(!orphan.exists());
        fs::remove_dir_all(path).expect("cleanup");
    }

    #[test]
    fn pending_pairing_commits_without_rewriting_credential_files() {
        let (path, store) = temporary_store("pending-pairing");
        let identity = store.load_or_create_identity().expect("identity");
        let endpoint: Endpoint = "127.0.0.1:33781".parse().expect("endpoint");
        let host = ClientIdentity::generate().expect("host-shaped certificate");
        let client_id = store.client_id().expect("client id");
        store
            .save_pending_pairing(
                &identity,
                host.certificate_der(),
                &endpoint,
                "Test device",
                &client_id,
            )
            .expect("pending pairing");

        assert!(!store.is_paired());
        let pending = store
            .load_pending_pairing()
            .expect("load pending")
            .expect("pending exists");
        assert_eq!(pending.host_certificate, host.certificate_der());
        store.commit_pending_pairing().expect("commit pending");

        let paired = store.load_pairing().expect("load committed pairing");
        assert_eq!(paired.host_certificate, host.certificate_der());
        assert_eq!(paired.metadata.endpoint, endpoint);
        assert!(
            store
                .load_pending_pairing()
                .expect("pending query")
                .is_none()
        );
        fs::remove_dir_all(path).expect("cleanup");
    }
}
