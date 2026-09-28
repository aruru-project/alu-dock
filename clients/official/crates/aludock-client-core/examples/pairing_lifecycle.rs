//! Loopback-only public pairing acceptance probe, driven by tests/pairingProtocol.test.mjs.
use aludock_client_core::{Endpoint, HostRegistry, PairingProgress};
use std::{io::Write, path::PathBuf};
fn progress(event: PairingProgress) {
    if let PairingProgress::PinGenerated { pin } = event {
        println!("{}", serde_json::json!({"pin":pin}));
        std::io::stdout().flush().unwrap();
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let endpoint: Endpoint = args[1].parse()?;
    let root = PathBuf::from(&args[2]);
    let registry = HostRegistry::open(&root)?;
    for mode in ["lost", "tampered", "confirmation_failed"] {
        assert!(
            registry
                .verify_pairing(endpoint.clone(), mode, progress)
                .await
                .is_err()
        );
        assert!(HostRegistry::open(&root)?.snapshot()?.hosts.is_empty());
    }
    let (sent, received) = tokio::sync::oneshot::channel();
    let mut sent = Some(sent);
    {
        let attempt = registry.verify_pairing(endpoint.clone(), "cancel", |event| {
            if matches!(event, PairingProgress::WaitingForHostApproval { .. }) {
                let _ = sent.take().unwrap().send(());
            }
            progress(event);
        });
        tokio::pin!(attempt);
        tokio::select! { result = &mut attempt => panic!("cancelled attempt completed: {}", result.is_ok()), _ = received => {} }
        // Dropping this future ends authorization, with nothing to restore.
    }
    assert!(HostRegistry::open(&root)?.snapshot()?.hosts.is_empty());
    let verified = registry
        .verify_pairing(endpoint.clone(), "success", progress)
        .await?;
    assert!(registry.snapshot()?.hosts.is_empty());
    let id = verified.host_id();
    registry.save_pairing(verified)?;
    let reopened = HostRegistry::open(&root)?;
    let store = reopened.resolve_store(Some(&id))?;
    let original = store.load_pairing()?;
    let profile = store.load_connection_profile()?.unwrap();
    assert!(
        registry
            .verify_pairing(endpoint, "duplicate", progress)
            .await
            .is_err()
    );
    assert_eq!(
        store.load_pairing()?.identity.private_key_der(),
        original.identity.private_key_der()
    );
    assert_eq!(store.load_connection_profile()?.unwrap(), profile);
    println!(
        "{}",
        serde_json::json!({"savedFingerprint":original.identity.fingerprint(),"hostId":id})
    );
    Ok(())
}
