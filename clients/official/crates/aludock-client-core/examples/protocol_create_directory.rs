//! Exercise the create option over the official client's public connection to a real Host.
use aludock_client_core::{
    ConnectionRouter, DockClient, IdentityStore, InstanceLifecycle, LocalDockEndpoint,
};
use std::{env, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let store = IdentityStore::new(PathBuf::from(&args[2]));
    let client = DockClient::new(ConnectionRouter::local(
        &store,
        LocalDockEndpoint::configured(&args[1])?,
        "create-directory-gate".into(),
    )?);
    assert!(client.host_info().await?.supports_create_directory);
    let work = client
        .create_instance_for_machine(&args[3], None, None, None, None, None, None, Some(true))
        .await?;
    assert_eq!(work.cwd, args[3]);
    assert_eq!(work.lifecycle, InstanceLifecycle::Active);
    Ok(())
}
