use std::{env, path::PathBuf};

use aludock_client_core::{
    ConnectionRouter, DockClient, IdentityStore, LocalDockEndpoint, MachineKind, SessionScope,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let socket = required(&mut args, "socket path")?;
    let identity_root = required(&mut args, "identity root")?;
    let cwd = required(&mut args, "workspace path")?;
    let expected_session_id = required(&mut args, "expected session id")?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }

    let store = IdentityStore::new(PathBuf::from(identity_root));
    let endpoint = LocalDockEndpoint::configured(&socket)?;
    let router = ConnectionRouter::local(&store, endpoint, "client-protocol-gate".into())?;
    let client = DockClient::new(router);
    let main = client
        .list_machines()
        .await?
        .into_iter()
        .find(|machine| machine.kind == MachineKind::Main)
        .ok_or("Host did not advertise Main")?;
    let inventory = client
        .session_inventory(&cwd, SessionScope::All, Some(&main.host_id))
        .await?;
    if inventory.sessions.len() != 1
        || inventory.sessions[0].session_id != expected_session_id
        || inventory.sessions[0].cwd != cwd
    {
        return Err(format!(
            "explicit Main inventory did not return the saved session: {:?}",
            inventory
                .sessions
                .iter()
                .map(|session| (&session.session_id, &session.cwd))
                .collect::<Vec<_>>()
        )
        .into());
    }
    println!("explicit Main inventory decoded saved session {expected_session_id}");
    Ok(())
}

fn required(
    args: &mut impl Iterator<Item = String>,
    label: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    args.next().ok_or_else(|| format!("missing {label}").into())
}
