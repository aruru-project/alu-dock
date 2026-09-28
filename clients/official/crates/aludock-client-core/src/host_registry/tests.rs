use super::*;
use crate::{ClientIdentity, PairingMetadata, StoredPairing, private_fs::write_new_private_file};
use serde_json::json;
use uuid::Uuid;

fn verified(host: &ClientIdentity, name: &str) -> VerifiedPairing {
    let identity = ClientIdentity::generate().unwrap();
    VerifiedPairing {
        pairing: StoredPairing {
            metadata: PairingMetadata {
                schema_version: 1,
                endpoint: Endpoint::new("127.0.0.1", 4444).unwrap(),
                device_name: name.into(),
                client_id: Uuid::new_v4().to_string(),
                client_fingerprint: identity.fingerprint(),
            },
            identity,
            host_certificate: host.certificate_der().to_vec(),
        },
    }
}
fn root() -> PathBuf {
    std::env::temp_dir().join(format!("aludock-saved-host-{}", Uuid::new_v4()))
}
fn file(path: &Path, bytes: &[u8]) {
    ensure_private_directory(path.parent().unwrap()).unwrap();
    write_new_private_file(path, bytes).unwrap();
}

#[test]
fn current_012_saved_host_reopens_and_duplicate_pairing_keeps_its_profile() {
    // Hand-written 0.2.12 on-disk shapes, including a profile filename that the
    // released client can retain. No new production serializer builds this input.
    let root = root();
    let host = ClientIdentity::generate().unwrap();
    let original = ClientIdentity::generate().unwrap();
    let id = crate::host_id(host.certificate_der());
    let home = root.join("hosts").join(&id);
    let ig = "identity-11111111-1111-4111-8111-111111111111";
    let pg = "pairing-22222222-2222-4222-8222-222222222222";
    file(
        &home.join("state").join(ig).join("client-certificate.der"),
        original.certificate_der(),
    );
    file(
        &home.join("state").join(ig).join("client-private-key.der"),
        original.private_key_der(),
    );
    file(
        &home.join("state").join(pg).join("host-certificate.der"),
        host.certificate_der(),
    );
    file(
        &home.join("client-identity-manifest.json"),
        json!({"schemaVersion":1,"generation":ig,"clientFingerprint":original.fingerprint()})
            .to_string()
            .as_bytes(),
    );
    file(
        &home.join("pairing-manifest.json"),
        json!({"schemaVersion":1,"generation":pg})
            .to_string()
            .as_bytes(),
    );
    file(
        &home.join("client-id"),
        b"33333333-3333-4333-8333-333333333333\n",
    );
    file(&home.join("state").join(pg).join("pairing-metadata.json"), json!({"schemaVersion":1,"endpoint":{"host":"127.0.0.1","port":4444},"deviceName":"Desktop","clientId":"33333333-3333-4333-8333-333333333333","clientFingerprint":original.fingerprint()}).to_string().as_bytes());
    file(&root.join("host-registry/registry-00000000000000000007.json"), json!({"schemaVersion":2,"revision":7,"activeHostId":id,"localSelected":false,"hosts":[{"hostId":id,"addedAt":"2026-09-01T00:00:00Z"}]}).to_string().as_bytes());
    let profile_path = home.join("connection-profile-history/profile-00000000000000000009-44444444-4444-4444-8444-444444444444.json");
    let profile = json!({"schemaVersion":1,"revision":9,"hostId":id,"displayName":"Saved desktop","endpoints":[{"id":"55555555-5555-4555-8555-555555555555","label":"Home","kind":"local","endpoint":{"host":"127.0.0.1","port":4444},"state":"verified","verifiedAt":null,"lastSuccessAt":null,"disabledFrom":null,"lastManualTest":null}],"policy":{"mode":"fixed","endpoint_id":"55555555-5555-4555-8555-555555555555"},"lastSuccessfulEndpointId":"55555555-5555-4555-8555-555555555555"});
    file(&profile_path, profile.to_string().as_bytes());
    file(&root.join("client-preferences/preferences-00000000000000000003.json"), br#"{"schemaVersion":1,"revision":3,"windowsAwayDelay":"thirty_minutes","windowsStartLocalHost":false}"#);
    // Retired unfinished state is not inspected or promoted, even if malformed.
    file(
        &root.join("pairing-transactions/old/transaction.json"),
        b"unfinished",
    );
    file(&home.join("pending-pairing-manifest.json"), b"unfinished");
    let registry = HostRegistry::open(&root).unwrap();
    assert_eq!(registry.snapshot().unwrap().revision, 7);
    let store = registry.resolve_store(None).unwrap();
    assert_eq!(
        store.load_pairing().unwrap().identity.private_key_der(),
        original.private_key_der()
    );
    assert_eq!(
        store.client_id().unwrap(),
        "33333333-3333-4333-8333-333333333333"
    );
    let saved_profile = store.load_connection_profile().unwrap().unwrap();
    assert_eq!(serde_json::to_value(&saved_profile).unwrap(), profile);
    let preferences = ClientPreferencesStore::open(root.join("client-preferences"))
        .unwrap()
        .snapshot()
        .unwrap();
    assert_eq!(
        preferences.windows_away_delay,
        WindowsAwayDelay::ThirtyMinutes
    );
    assert!(!preferences.windows_start_local_host);
    assert!(matches!(
        registry.save_pairing(verified(&host, "Duplicate")),
        Err(ClientError::HostAlreadySaved(_))
    ));
    let reopened = HostRegistry::open(&root)
        .unwrap()
        .resolve_store(None)
        .unwrap();
    assert_eq!(
        reopened.load_pairing().unwrap().identity.private_key_der(),
        original.private_key_der()
    );
    assert_eq!(
        reopened.load_connection_profile().unwrap().unwrap(),
        saved_profile
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(profile_path).unwrap()).unwrap(),
        profile
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn failed_catalog_publication_does_not_trap_a_new_explicit_pairing() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let root = root();
    let registry = HostRegistry::open(&root).unwrap();
    let host = ClientIdentity::generate().unwrap();
    let catalog = root.join("host-registry");
    fs::set_permissions(&catalog, fs::Permissions::from_mode(0o500)).unwrap();
    let result = registry.save_pairing(verified(&host, "Could not publish"));
    fs::set_permissions(&catalog, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    let reopened = HostRegistry::open(&root).unwrap();
    assert!(reopened.snapshot().unwrap().hosts.is_empty());
    // Process-exit fixture: complete private files published, catalog not yet saved.
    let abandoned = verified(&host, "Interrupted publication");
    IdentityStore::new(root.join("hosts").join(abandoned.host_id()))
        .initialize_pairing(&abandoned.pairing)
        .unwrap();
    // A stopped cleanup need not leave a readable credential set.
    fs::remove_file(
        root.join("hosts")
            .join(abandoned.host_id())
            .join("pairing-manifest.json"),
    )
    .unwrap();
    reopened
        .save_pairing(verified(&host, "New authorization"))
        .unwrap();
    assert_eq!(
        reopened
            .resolve_store(None)
            .unwrap()
            .load_pairing()
            .unwrap()
            .metadata
            .device_name,
        "New authorization"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn saved_selection_conflicts_and_removal_keep_the_other_host() {
    let root = root();
    let registry = HostRegistry::open(&root).unwrap();
    let a = ClientIdentity::generate().unwrap();
    let b = ClientIdentity::generate().unwrap();
    let aid = crate::host_id(a.certificate_der());
    let bid = crate::host_id(b.certificate_der());
    let stale = registry.save_pairing(verified(&a, "A")).unwrap();
    let revision = registry.save_pairing(verified(&b, "B")).unwrap();
    assert!(matches!(
        registry.set_active_host(&aid, stale),
        Err(ClientError::RegistryConflict { .. })
    ));
    registry.remove_host(&aid, revision).unwrap();
    let reopened = HostRegistry::open(&root).unwrap();
    assert_eq!(reopened.snapshot().unwrap().hosts.len(), 1);
    assert_eq!(
        reopened
            .resolve_store(Some(&bid))
            .unwrap()
            .load_pairing()
            .unwrap()
            .host_certificate,
        b.certificate_der()
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
#[test]
fn chosen_local_connection_and_override_survive_reopening_the_client() {
    let path = root();
    let registry = HostRegistry::open(&path).unwrap();
    let configured = registry
        .set_local_endpoint_override(1, Some("/tmp/alu-dock-review.sock"))
        .unwrap();
    let selected = registry.select_local(configured.revision).unwrap();
    drop(registry);

    let reopened = HostRegistry::open(&path).unwrap().snapshot().unwrap();
    assert!(reopened.local_selected);
    assert!(reopened.active_host_id.is_none());
    assert_eq!(
        reopened.local_endpoint_override.as_deref(),
        Some("/tmp/alu-dock-review.sock")
    );
    assert_eq!(reopened.revision, selected.revision);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn independent_clients_pairing_the_same_host_keep_the_winners_credentials_and_profile() {
    use std::sync::{Arc, Barrier};
    let root = root();
    let host = ClientIdentity::generate().unwrap();
    let first = HostRegistry::open(&root).unwrap();
    let second = HostRegistry::open(&root).unwrap();
    let ready = Arc::new(Barrier::new(3));
    let mut clients = Vec::new();
    for (registry, name) in [(first, "First client"), (second, "Second client")] {
        let pairing = verified(&host, name);
        let key = pairing.pairing.identity.private_key_der().to_vec();
        let ready = ready.clone();
        clients.push(std::thread::spawn(move || {
            ready.wait();
            let result = registry.save_pairing(pairing);
            if result.is_ok() {
                registry
                    .resolve_store(None)
                    .unwrap()
                    .update_connection_profile(|profile| {
                        profile.display_name = name.into();
                        Ok(())
                    })
                    .unwrap();
            }
            (result, key, name)
        }));
    }
    ready.wait();
    let results: Vec<_> = clients
        .into_iter()
        .map(|client| client.join().unwrap())
        .collect();
    let winner = results
        .iter()
        .find(|(result, _, _)| result.is_ok())
        .unwrap();
    assert_eq!(
        results
            .iter()
            .filter(|(result, _, _)| result.is_ok())
            .count(),
        1
    );
    assert!(
        results
            .iter()
            .any(|(result, _, _)| matches!(result, Err(ClientError::HostAlreadySaved(_))))
    );
    let reopened = HostRegistry::open(&root).unwrap();
    let store = reopened.resolve_store(None).unwrap();
    assert_eq!(
        store.load_pairing().unwrap().identity.private_key_der(),
        winner.1
    );
    assert_eq!(
        store
            .load_connection_profile()
            .unwrap()
            .unwrap()
            .display_name,
        winner.2
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn interrupted_credential_cleanup_does_not_block_a_new_authorized_save() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let root = root();
    let registry = HostRegistry::open(&root).unwrap();
    let host = ClientIdentity::generate().unwrap();
    let id = crate::host_id(host.certificate_der());
    let revision = registry
        .save_pairing(verified(&host, "Before removal"))
        .unwrap();
    // Deny removal of generation directories, on generated test data only.
    // Keep a directory handle so permissions can be restored after its rename.
    let state = fs::File::open(root.join("hosts").join(&id).join("state")).unwrap();
    state
        .set_permissions(fs::Permissions::from_mode(0o500))
        .unwrap();
    let removed = registry.remove_host(&id, revision);
    assert!(removed.is_err());
    let reopened = HostRegistry::open(&root).unwrap();
    assert!(reopened.snapshot().unwrap().hosts.is_empty());
    let saved = reopened.save_pairing(verified(&host, "New authorization"));
    state
        .set_permissions(fs::Permissions::from_mode(0o700))
        .unwrap();
    saved.unwrap();
    assert_eq!(
        reopened
            .resolve_store(None)
            .unwrap()
            .load_pairing()
            .unwrap()
            .metadata
            .device_name,
        "New authorization"
    );
    fs::remove_dir_all(root).unwrap();
}
