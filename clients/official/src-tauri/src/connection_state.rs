use crate::errors::{CommandError, lifecycle_error};
use aludock_client_core::{
    ClientError, ClientPreferencesStore, ConnectionRouter, DockClient, HostConnectionProfile,
    HostRegistry, IdentityStore, LocalDockEndpoint, validate_host_id,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub(crate) const LOCAL_CONNECTION_SCOPE_ID: &str = "local";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ConnectionTarget {
    Local,
    Host { host_id: String },
}

impl ConnectionTarget {
    pub(crate) fn scope_id(&self) -> &str {
        match self {
            Self::Local => LOCAL_CONNECTION_SCOPE_ID,
            Self::Host { host_id } => host_id,
        }
    }
}

#[derive(Default)]
pub(crate) struct RuntimeLifecycle {
    pub(crate) active_target: Option<ConnectionTarget>,
    pub(crate) selection_generation: u64,
}

#[derive(Clone)]
pub(crate) struct ConnectionRuntimeState {
    pub(crate) registry: HostRegistry,
    pub(crate) preferences: ClientPreferencesStore,
    pub(crate) local_identity: IdentityStore,
    pub(crate) lifecycle: Arc<Mutex<RuntimeLifecycle>>,
    pub(crate) selected_client: Arc<Mutex<Option<SelectedConnectionClient>>>,
}

pub(crate) struct SelectedConnectionClient {
    pub(crate) target: ConnectionTarget,
    pub(crate) selection_generation: u64,
    pub(crate) client: DockClient,
}

impl RuntimeLifecycle {
    pub(crate) fn transition_to_host(
        &mut self,
        host_id: Option<String>,
    ) -> Result<u64, CommandError> {
        self.transition_to(host_id.map(|host_id| ConnectionTarget::Host { host_id }))
    }

    pub(crate) fn transition_to_local(&mut self) -> Result<u64, CommandError> {
        self.transition_to(Some(ConnectionTarget::Local))
    }

    pub(crate) fn transition_to(
        &mut self,
        target: Option<ConnectionTarget>,
    ) -> Result<u64, CommandError> {
        self.selection_generation = self
            .selection_generation
            .checked_add(1)
            .ok_or_else(lifecycle_error)?;
        self.active_target = target;
        Ok(self.selection_generation)
    }

    pub(crate) fn connection_id(&self) -> Option<&str> {
        self.active_target.as_ref().map(ConnectionTarget::scope_id)
    }
}

impl ConnectionRuntimeState {
    pub(crate) fn open(application_data_dir: Option<PathBuf>) -> Result<Self, ClientError> {
        let registry = if let Some(path) = std::env::var_os("ALUDOCK_CLIENT_IDENTITY_DIR") {
            HostRegistry::open(PathBuf::from(path))?
        } else if let Some(path) = application_data_dir {
            HostRegistry::open(path.join("identity"))?
        } else {
            HostRegistry::platform_default()?
        };
        let preferences = ClientPreferencesStore::open(registry.root().join("client-preferences"))?;
        let local_identity = IdentityStore::new(registry.root().join("local-client-identity"));
        let snapshot = registry.snapshot()?;
        let active_target = if snapshot.local_selected {
            Some(ConnectionTarget::Local)
        } else {
            snapshot
                .active_host_id
                .map(|host_id| ConnectionTarget::Host { host_id })
        };
        Ok(Self {
            registry,
            preferences,
            local_identity,
            lifecycle: Arc::new(Mutex::new(RuntimeLifecycle {
                active_target,
                selection_generation: 1,
            })),
            selected_client: Arc::new(Mutex::new(None)),
        })
    }

    // This is the same first-use selection as synchronous Windows startup used
    // to make. Never replace an existing local/remote user selection.
    #[cfg(any(target_os = "windows", test))]
    pub(crate) fn select_initial_local(&self) -> Result<(), CommandError> {
        let mut lifecycle = self.lifecycle.lock().map_err(|_| lifecycle_error())?;
        let snapshot = self.registry.snapshot().map_err(CommandError::from)?;
        if snapshot.active_host_id.is_none()
            && !snapshot.local_selected
            && snapshot.hosts.is_empty()
        {
            self.registry
                .select_local(snapshot.revision)
                .map_err(CommandError::from)?;
            lifecycle.transition_to_local()?;
        }
        Ok(())
    }
}

pub(crate) fn ensure_connection_selection(
    lifecycle: &RuntimeLifecycle,
    connection_id: &str,
    selection_generation: u64,
) -> Result<(), CommandError> {
    if lifecycle.selection_generation != selection_generation {
        return Err(CommandError {
            code: "stale_connection_selection".into(),
            message: "当前连接已经改变；旧请求已丢弃。".into(),
            details: Some(serde_json::json!({
                "connectionId": connection_id,
                "selectionGeneration": selection_generation,
                "currentSelectionGeneration": lifecycle.selection_generation,
            })),
            outcome_unknown: false,
            operation_id: None,
        });
    }
    if lifecycle.connection_id() != Some(connection_id) {
        return Err(CommandError {
            code: "stale_connection_selection".into(),
            message: "当前连接已经改变；请求未发送。".into(),
            details: Some(serde_json::json!({ "connectionId": connection_id })),
            outcome_unknown: false,
            operation_id: None,
        });
    }
    Ok(())
}

pub(crate) fn resolve_connection_store(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
) -> Result<IdentityStore, CommandError> {
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    match lifecycle.active_target.as_ref() {
        Some(ConnectionTarget::Local) => Ok(runtime.local_identity.clone()),
        Some(ConnectionTarget::Host { host_id }) => runtime
            .registry
            .resolve_store(Some(host_id))
            .map_err(CommandError::from),
        None => Err(lifecycle_error()),
    }
}

pub(crate) fn mutate_selected_host<T>(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
    mutation: impl FnOnce(&IdentityStore) -> aludock_client_core::Result<T>,
) -> Result<T, CommandError> {
    validate_host_id(connection_id).map_err(CommandError::from)?;
    // Keep the lifecycle lock through the profile CAS. A Host transition can
    // therefore happen either before this revalidation or after persistence,
    // never between the generation check and the write.
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    if lifecycle.active_target
        != Some(ConnectionTarget::Host {
            host_id: connection_id.to_owned(),
        })
    {
        return Err(CommandError::from(ClientError::HostNotFound(
            connection_id.to_owned(),
        )));
    }
    let store = runtime
        .registry
        .resolve_store(Some(connection_id))
        .map_err(CommandError::from)?;
    mutation(&store).map_err(CommandError::from)
}

pub(crate) fn connection_profile(
    store: &IdentityStore,
    host_id: &str,
) -> Result<HostConnectionProfile, CommandError> {
    let profile = store
        .load_connection_profile()
        .map_err(CommandError::from)?
        .ok_or_else(|| CommandError {
            code: "not_paired".into(),
            message: "尚未连接 AluDock".into(),
            details: None,
            outcome_unknown: false,
            operation_id: None,
        })?;
    if profile.host_id != host_id {
        return Err(CommandError::from(ClientError::InvalidPairing(
            "saved Host profile identity does not match the selected Host".into(),
        )));
    }
    Ok(profile)
}

pub(crate) fn dock_client(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
    store: &IdentityStore,
) -> Result<DockClient, CommandError> {
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    let target = lifecycle
        .active_target
        .clone()
        .ok_or_else(lifecycle_error)?;
    let profile = match &target {
        ConnectionTarget::Local => None,
        ConnectionTarget::Host { host_id } => Some(connection_profile(store, host_id)?),
    };
    let mut selected = runtime
        .selected_client
        .lock()
        .map_err(|_| lifecycle_error())?;
    if let Some(current) = selected.as_ref()
        && current.target == target
        && current.selection_generation == selection_generation
    {
        if let Some(profile) = &profile {
            current
                .client
                .router()
                .reconcile(profile)
                .map_err(CommandError::from)?;
        }
        return Ok(current.client.clone());
    }
    if let Some(previous) = selected.take() {
        previous.client.router().close();
    }
    let router = match &target {
        ConnectionTarget::Host { .. } => {
            ConnectionRouter::from_store(store, profile.as_ref().ok_or_else(lifecycle_error)?)
                .map_err(CommandError::from)?
        }
        ConnectionTarget::Local => {
            let snapshot = runtime.registry.snapshot().map_err(CommandError::from)?;
            let endpoint = LocalDockEndpoint::resolve(snapshot.local_endpoint_override.as_deref())
                .map_err(CommandError::from)?;
            ConnectionRouter::local(
                &runtime.local_identity,
                endpoint,
                LOCAL_CONNECTION_SCOPE_ID.into(),
            )
            .map_err(CommandError::from)?
        }
    };
    let client = DockClient::new(router);
    *selected = Some(SelectedConnectionClient {
        target,
        selection_generation,
        client: client.clone(),
    });
    Ok(client)
}

pub(crate) fn reconcile_selected_client(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    selection_generation: u64,
    profile: &HostConnectionProfile,
) -> Result<(), CommandError> {
    let lifecycle = runtime.lifecycle.lock().map_err(|_| lifecycle_error())?;
    ensure_connection_selection(&lifecycle, connection_id, selection_generation)?;
    let selected = runtime
        .selected_client
        .lock()
        .map_err(|_| lifecycle_error())?;
    if let Some(current) = selected.as_ref()
        && current.target
            == (ConnectionTarget::Host {
                host_id: connection_id.to_owned(),
            })
        && current.selection_generation == selection_generation
    {
        current
            .client
            .router()
            .reconcile(profile)
            .map_err(CommandError::from)?;
    }
    Ok(())
}

pub(crate) fn attachment_authority(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
) -> Result<String, CommandError> {
    let endpoint = if connection_id == LOCAL_CONNECTION_SCOPE_ID {
        let snapshot = runtime.registry.snapshot().map_err(CommandError::from)?;
        Some(
            LocalDockEndpoint::resolve(snapshot.local_endpoint_override.as_deref())
                .map_err(CommandError::from)?
                .display(),
        )
    } else {
        None
    };
    Ok(serde_json::to_string(&(connection_id, endpoint)).expect("authority tuple"))
}

pub(crate) fn observation_key(
    runtime: &ConnectionRuntimeState,
    connection_id: &str,
    instance_id: &str,
    host_epoch: &str,
) -> Result<String, CommandError> {
    let local_endpoint = if connection_id == LOCAL_CONNECTION_SCOPE_ID {
        let snapshot = runtime.registry.snapshot().map_err(CommandError::from)?;
        Some(
            LocalDockEndpoint::resolve(snapshot.local_endpoint_override.as_deref())
                .map_err(CommandError::from)?
                .display(),
        )
    } else {
        None
    };
    Ok(
        serde_json::to_string(&(connection_id, local_endpoint, instance_id, host_epoch))
            .expect("string tuple"),
    )
}
