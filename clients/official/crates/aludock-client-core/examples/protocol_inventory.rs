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
    // Follow the pages the way the client list does, until the Host has no more.
    let first = client
        .session_inventory(&cwd, SessionScope::All, Some(&main.host_id), None)
        .await?;
    let total = first.total;
    let mut sessions = first.sessions;
    let mut cursor = first.next_cursor;
    let mut pages = 1;
    while let Some(next) = cursor {
        let page = client
            .session_inventory(&cwd, SessionScope::All, Some(&main.host_id), Some(&next))
            .await?;
        pages += 1;
        sessions.extend(page.sessions);
        cursor = page.next_cursor;
    }
    let unique = sessions
        .iter()
        .map(|session| session.session_id.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    let Some(saved) = sessions
        .first()
        .filter(|saved| saved.session_id == expected_session_id && saved.cwd == cwd)
    else {
        return Err("the most recent saved session was not listed first".into());
    };
    if unique != sessions.len() || sessions.len() as u64 != total {
        return Err(format!(
            "pages listed {} sessions ({unique} unique) of {total}",
            sessions.len()
        )
        .into());
    }
    println!(
        "explicit Main inventory decoded saved session {expected_session_id} last={} cost={} pages={pages} sessions={}",
        saved.last_activity_at.as_deref().unwrap_or("-"),
        saved
            .cost_total
            .map_or_else(|| "-".to_owned(), |cost| cost.to_string()),
        sessions.len()
    );
    Ok(())
}

fn required(
    args: &mut impl Iterator<Item = String>,
    label: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    args.next().ok_or_else(|| format!("missing {label}").into())
}
