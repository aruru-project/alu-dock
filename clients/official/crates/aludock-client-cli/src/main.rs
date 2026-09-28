use std::{io::Write, path::PathBuf};

use aludock_client_core::{
    ConnectionRouter, DockClient, Endpoint, HostInfo, HostRegistry, IdentityStore,
    InstanceSelector, PairingProgress, ReadReplay, host_info,
};
use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "aludock-client",
    version,
    about = "AluDock Protocol V2 development client"
)]
struct Cli {
    /// Override the platform-default private client data root.
    #[arg(long, global = true)]
    identity_dir: Option<PathBuf>,

    /// Select a saved Host for a Host-bound command; defaults to the active Host.
    #[arg(long, global = true)]
    host_id: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pair a new Host with an isolated client identity and activate it.
    Pair {
        /// Remote AluDock TLS endpoint, for example 192.168.1.10:9999.
        endpoint: Endpoint,

        /// Safe human-readable device name shown in the local AluDock Hub.
        #[arg(long)]
        device_name: String,
    },

    /// List the deterministic saved Host catalog.
    Hosts,

    /// Make a saved Host active without making a network request.
    UseHost {
        /// Canonical 64-character lowercase hexadecimal Host ID.
        target_host_id: String,
    },

    /// Delete this device's local credentials for a Host (not remote revocation).
    RemoveHostLocal {
        /// Canonical 64-character lowercase hexadecimal Host ID.
        target_host_id: String,

        /// Confirm deletion of locally stored credentials and addresses.
        #[arg(long)]
        confirm_local_removal: bool,
    },

    /// Connect with the selected stored identity and request Protocol V2 host.info.
    HostInfo {
        /// Optional replacement address for the same pinned Host identity.
        #[arg(long)]
        endpoint: Option<Endpoint>,
    },

    /// List real AluDock Works through Protocol V2.
    ListWorks {
        /// Include stopped historical Works.
        #[arg(long)]
        all: bool,
    },

    /// Read the authoritative conversation bootstrap for one Work.
    ReadWork {
        /// Dock Work identity from list-works.
        instance_id: String,
    },

    /// Open instance.follow and validate its initial handoff page.
    FollowWork {
        /// Dock Work identity from list-works.
        instance_id: String,
        /// Wait up to five seconds for one live event after the handoff.
        #[arg(long)]
        wait_event: bool,
    },

    /// Read Command Center, model, tool, setting, and resource projections.
    InspectControls {
        /// Active Dock Work identity from list-works.
        instance_id: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let registry = match cli
        .identity_dir
        .or_else(|| std::env::var_os("ALUDOCK_CLIENT_IDENTITY_DIR").map(PathBuf::from))
    {
        Some(path) => HostRegistry::open(path).context("could not open the client data root")?,
        None => HostRegistry::platform_default().context("could not select client storage")?,
    };

    match cli.command {
        Command::Pair {
            endpoint,
            device_name,
        } => {
            if cli.host_id.is_some() {
                bail!("--host-id does not apply to pair; pairing creates and activates a Host");
            }
            let verified = registry
                .verify_pairing(endpoint, &device_name, |event| match event {
                    PairingProgress::PinGenerated { pin } => {
                        println!("Pairing PIN: {pin}");
                        println!(
                            "Open the local AluDock Hub pairing window, select this device, and enter that PIN."
                        );
                        let _ = std::io::stdout().flush();
                    }
                    PairingProgress::WaitingForHostApproval { pairing_id } => {
                        println!(
                            "Pairing request submitted ({pairing_id}); waiting for local approval..."
                        );
                    }
                    PairingProgress::HostApproved => {
                        println!("PIN accepted; authenticating the pairing...");
                    }
                    PairingProgress::VerifyingIdentities => {
                        println!("Verifying both certificate identities...");
                    }
                    PairingProgress::ConfirmingConnection => {
                        println!("Confirming the final pinned Protocol V2 connection...");
                    }
                    PairingProgress::SavingIdentity => {
                        println!("Saving the paired development identity...");
                    }
                })
                .await
                .context("pairing failed")?;
            let host_id = verified.host_id();
            let revision = registry
                .save_pairing(verified)
                .context("could not save paired Host")?;
            let store = registry
                .resolve_store(Some(&host_id))
                .context("could not resolve saved Host")?;
            let pairing = store.load_pairing()?;
            println!("Paired with {}.", pairing.metadata.endpoint);
            println!("Host ID: {host_id}");
            println!(
                "Client certificate fingerprint: {}",
                pairing.identity.fingerprint()
            );
            println!("Registry revision: {revision}");

            let info = host_info(&store, None)
                .await
                .context("pairing completed, but the Protocol V2 host.info check failed")?;
            print_host_info(&info);
        }
        Command::Hosts => {
            if cli.host_id.is_some() {
                bail!("--host-id does not apply to hosts");
            }
            let snapshot = registry.snapshot().context("could not load Host catalog")?;
            println!("Registry revision: {}", snapshot.revision);
            if snapshot.hosts.is_empty() {
                println!("No Hosts are saved locally.");
            }
            for record in snapshot.hosts {
                let store = registry
                    .resolve_store(Some(&record.host_id))
                    .with_context(|| format!("could not load Host {}", record.host_id))?;
                let profile = store
                    .load_connection_profile()
                    .context("could not load Host connection profile")?
                    .context("saved Host has no connection profile")?;
                let active = if snapshot.active_host_id.as_deref() == Some(&record.host_id) {
                    "*"
                } else {
                    " "
                };
                let endpoints = profile
                    .endpoints
                    .iter()
                    .map(|entry| entry.endpoint.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                println!(
                    "{active} {}\t{}\t{}\tadded {}",
                    record.host_id, profile.display_name, endpoints, record.added_at
                );
            }
        }
        Command::UseHost { target_host_id } => {
            if cli.host_id.is_some() {
                bail!("use-host takes its Host ID as a positional argument");
            }
            let snapshot = registry.snapshot().context("could not load Host catalog")?;
            let updated = registry
                .set_active_host(&target_host_id, snapshot.revision)
                .context("could not select Host")?;
            println!("Active Host: {target_host_id}");
            println!("Registry revision: {}", updated.revision);
        }
        Command::RemoveHostLocal {
            target_host_id,
            confirm_local_removal,
        } => {
            if cli.host_id.is_some() {
                bail!("remove-host-local takes its Host ID as a positional argument");
            }
            if !confirm_local_removal {
                bail!(
                    "local removal was not confirmed; rerun with --confirm-local-removal. This deletes this device's saved credentials and addresses but does not revoke access on the Host"
                );
            }
            let snapshot = registry.snapshot().context("could not load Host catalog")?;
            let updated = registry
                .remove_host(&target_host_id, snapshot.revision)
                .context("could not remove saved Host credentials")?;
            println!("Removed locally saved Host: {target_host_id}");
            println!("This did not revoke this device on the Host.");
            println!("Registry revision: {}", updated.revision);
            match updated.active_host_id {
                Some(active) => println!("Active Host: {active}"),
                None => println!("No Host is active."),
            }
        }
        Command::HostInfo { endpoint } => {
            let store = selected_store(&registry, cli.host_id.as_deref())?;
            let info = match endpoint {
                Some(endpoint) => host_info(&store, Some(endpoint))
                    .await
                    .context("host.info failed")?,
                None => {
                    let profile = store
                        .load_connection_profile()
                        .context("could not load the Host connection profile")?
                        .context("no paired Host profile is available")?;
                    DockClient::new(
                        ConnectionRouter::from_store(&store, &profile)
                            .context("could not load the paired Host identity")?,
                    )
                    .host_info()
                    .await
                    .context("host.info failed")?
                }
            };
            print_host_info(&info);
        }
        Command::ListWorks { all } => {
            let store = selected_store(&registry, cli.host_id.as_deref())?;
            let client = client_from_profile(&store)?;
            let catalog = client
                .list_instances(if all {
                    InstanceSelector::All
                } else {
                    InstanceSelector::Actionable
                })
                .await
                .context("instance.list failed")?;
            println!("Works: {}", catalog.total);
            for work in catalog.instances {
                println!(
                    "{}\t{}\t{:?}\t{:?}\t{}",
                    work.id, work.display_name, work.lifecycle, work.execution, work.cwd
                );
            }
        }
        Command::ReadWork { instance_id } => {
            let store = selected_store(&registry, cli.host_id.as_deref())?;
            let client = client_from_profile(&store)?;
            let read = client
                .read_instance(&instance_id, None, ReadReplay::ConversationBootstrap)
                .await
                .context("instance.read failed")?;
            println!("Work: {}", read.instance.display_name);
            println!("History records: {}", read.recent_history.len());
            println!("Active events: {}", read.page.events.len());
            println!("Pending messages: {}", read.pending_messages.len());
            println!("History truncated: {}", read.history_truncated);
        }
        Command::FollowWork {
            instance_id,
            wait_event,
        } => {
            let store = selected_store(&registry, cli.host_id.as_deref())?;
            let client = client_from_profile(&store)?;
            let read = client
                .read_instance(&instance_id, None, ReadReplay::ConversationBootstrap)
                .await
                .context("instance.read failed")?;
            let (page, mut stream) = client
                .follow_instance(&instance_id, &read.page.latest)
                .await
                .context("instance.follow failed")?;
            println!("Follow handoff events: {}", page.events.len());
            println!("Follow cursor sequence: {}", page.latest.sequence);
            if wait_event {
                match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next_event())
                    .await
                {
                    Ok(Ok(event)) => println!(
                        "Live event: {} at sequence {}",
                        event.event_type, event.sequence
                    ),
                    Ok(Err(error)) => return Err(error).context("live follow failed"),
                    Err(_) => println!("No live event arrived within five seconds."),
                }
            }
        }
        Command::InspectControls { instance_id } => {
            let store = selected_store(&registry, cli.host_id.as_deref())?;
            let client = client_from_profile(&store)?;
            let commands = client
                .commands(&instance_id, None)
                .await
                .context("command.catalog failed")?;
            let models = client
                .models(&instance_id)
                .await
                .context("model.list failed")?;
            let tools = client
                .tools(&instance_id)
                .await
                .context("tool.list failed")?;
            let settings = client
                .settings(&instance_id)
                .await
                .context("settings.get failed")?;
            let resources = client
                .resources(&instance_id)
                .await
                .context("resource.get failed")?;
            println!("Commands: {}/{}", commands.commands.len(), commands.total);
            println!("Models: {}/{}", models.models.len(), models.total);
            println!(
                "Thinking levels: {}",
                models.available_thinking_levels.len()
            );
            println!("Tools: {}/{}", tools.tools.len(), tools.total);
            println!(
                "Active tools: {}",
                tools.tools.iter().filter(|tool| tool.active).count()
            );
            println!("Settings: {}", settings.settings.len());
            println!(
                "Resources: {}/{}; diagnostics: {}/{}",
                resources.resources.len(),
                resources.resource_total,
                resources.diagnostics.len(),
                resources.diagnostic_total
            );
        }
    }
    Ok(())
}

fn selected_store(registry: &HostRegistry, host_id: Option<&str>) -> Result<IdentityStore> {
    registry
        .resolve_store(host_id)
        .context("could not resolve the selected Host")
}

fn client_from_profile(store: &IdentityStore) -> Result<DockClient> {
    let profile = store
        .load_connection_profile()
        .context("could not load the Host connection profile")?
        .context("no paired Host profile is available")?;
    ConnectionRouter::from_store(store, &profile)
        .map(DockClient::new)
        .context("could not load the paired Host identity")
}

fn print_host_info(info: &HostInfo) {
    println!("Protocol V2 connection succeeded.");
    println!("Host state: {}", info.state);
    println!("AluDock: {}", info.host.dock_version);
    println!("Pi SDK: {}", info.host.pi_sdk_version);
    println!("Host epoch: {}", info.host.host_epoch);
}
