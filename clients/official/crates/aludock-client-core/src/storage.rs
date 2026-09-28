pub(crate) mod snapshots;
use std::{
    fs,
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{
    ClientError, ClientIdentity, Endpoint, Result,
    private_fs::{
        set_private_directory_permissions, storage_error, sync_directory, write_new_private_file,
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

    #[cfg(test)]
    pub fn load_or_create_identity(&self) -> Result<ClientIdentity> {
        self.ensure_private_directory()?;

        let manifest_path = self.root.join(IDENTITY_MANIFEST);
        if manifest_path.exists() {
            let manifest: IdentityManifest = self.read_json_file(&manifest_path)?;
            return self.load_identity(&manifest);
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
        self.write_atomic_private_file(&path, format!("{value}\n").as_bytes())?;
        Ok(value)
    }

    pub fn is_paired(&self) -> bool {
        self.root.join(PAIRING_MANIFEST).exists()
    }

    #[cfg(test)]
    pub fn save_pairing(
        &self,
        identity: &ClientIdentity,
        host_certificate: &[u8],
        endpoint: &Endpoint,
        device_name: &str,
        client_id: &str,
    ) -> Result<()> {
        if self.is_paired() {
            return Err(ClientError::InvalidPairing(
                "this profile is already paired".into(),
            ));
        }
        let metadata = pairing_metadata(identity, endpoint, device_name, client_id);
        let generation = self.write_pairing_generation(host_certificate, &metadata)?;
        self.write_new_manifest(
            PAIRING_MANIFEST,
            &PairingManifest {
                schema_version: 1,
                generation,
            },
        )
    }

    pub(crate) fn initialize_pairing(&self, pairing: &StoredPairing) -> Result<()> {
        self.ensure_private_directory()?;
        if self.is_paired() {
            return Err(ClientError::InvalidPairing(
                "this profile is already paired".into(),
            ));
        }
        // The caller owns a fresh unpublished directory; no partial identity is resumed.
        let generation = self.write_generation(
            "identity",
            &[
                (CLIENT_CERTIFICATE, pairing.identity.certificate_der()),
                (CLIENT_PRIVATE_KEY, pairing.identity.private_key_der()),
            ],
        )?;
        self.write_new_manifest(
            IDENTITY_MANIFEST,
            &IdentityManifest {
                schema_version: 1,
                generation,
                client_fingerprint: pairing.identity.fingerprint(),
            },
        )?;
        self.write_atomic_private_file(
            &self.root.join(CLIENT_ID),
            format!("{}\n", pairing.metadata.client_id).as_bytes(),
        )?;
        let generation =
            self.write_pairing_generation(&pairing.host_certificate, &pairing.metadata)?;
        self.write_new_manifest(
            PAIRING_MANIFEST,
            &PairingManifest {
                schema_version: 1,
                generation,
            },
        )?;
        Ok(())
    }

    fn load_identity(&self, manifest: &IdentityManifest) -> Result<ClientIdentity> {
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
        Ok(identity)
    }

    pub fn load_pairing(&self) -> Result<StoredPairing> {
        self.ensure_private_directory()?;
        let manifest: PairingManifest = self.read_json_file(&self.root.join(PAIRING_MANIFEST))?;
        let identity_manifest = self.read_json_file(&self.root.join(IDENTITY_MANIFEST))?;
        let identity = self.load_identity(&identity_manifest)?;
        let (host_certificate, metadata) = self.load_pairing_generation(&manifest, &identity)?;
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
        self.write_atomic_private_file(&self.root.join(name), &bytes)
    }

    fn read_json_file<T: DeserializeOwned>(&self, path: &Path) -> Result<T> {
        serde_json::from_slice(&self.read_private_file(path)?).map_err(ClientError::from)
    }

    fn write_atomic_private_file(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if !crate::private_fs::publish_private_file(path, bytes)? {
            return Err(ClientError::InvalidPairing(format!(
                "identity state already exists: {}",
                path.display()
            )));
        }
        Ok(())
    }

    fn ensure_private_directory(&self) -> Result<()> {
        crate::private_fs::ensure_private_directory(&self.root)
    }

    fn ensure_state_directory(&self) -> Result<()> {
        crate::private_fs::ensure_fixed_directory(&self.root, STATE_DIRECTORY)
    }

    fn state_directory(&self) -> PathBuf {
        self.root.join(STATE_DIRECTORY)
    }

    fn read_private_file(&self, path: &Path) -> Result<Vec<u8>> {
        #[cfg(unix)]
        {
            let metadata =
                fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
            assert_private_file_permissions(path, &metadata)?;
        }
        crate::private_fs::read_regular_file(path)
    }
}

#[cfg(test)]
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

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, path::PathBuf};

    use crate::IdentityStore;

    fn temporary_store(name: &str) -> (PathBuf, IdentityStore) {
        let path =
            std::env::temp_dir().join(format!("aludock-client-{name}-{}", uuid::Uuid::new_v4()));
        (path.clone(), IdentityStore::new(path))
    }

    #[test]
    fn reopening_repairs_directory_access_but_still_protects_the_private_key() {
        use std::os::unix::fs::PermissionsExt;
        let (path, store) = temporary_store("private-access");
        let original = store.load_or_create_identity().unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let reopened = IdentityStore::new(&path);
        assert_eq!(
            reopened.load_or_create_identity().unwrap().fingerprint(),
            original.fingerprint()
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("client-identity-manifest.json")).unwrap())
                .unwrap();
        let key = path
            .join("state")
            .join(manifest["generation"].as_str().unwrap())
            .join("client-private-key.der");
        // Credential privacy is the explicit security boundary, not a syscall count.
        fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(reopened.load_or_create_identity().is_err());
        fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            reopened.load_or_create_identity().unwrap().fingerprint(),
            original.fingerprint()
        );
        fs::remove_dir_all(path).unwrap();
    }
}
