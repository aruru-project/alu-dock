use std::sync::{Arc, Mutex};

use tokio::time::timeout;

use crate::{
    ClientError, ClientIdentity, Endpoint, HostConnectionProfile, IdentityStore, Result,
    client::{HelloAck, negotiate_local_endpoint, negotiate_pinned_endpoint},
    local_transport::LocalDockEndpoint,
    timing::CONNECTION_ACQUISITION_TIMEOUT,
    tls::{ConnectedTransport, PinnedTlsConnector},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteSnapshot {
    pub active_endpoint_id: Option<String>,
    pub config_revision: u64,
    pub route_generation: u64,
    pub closed: bool,
}

#[derive(Clone)]
pub struct ConnectionRouter {
    inner: Arc<RouterInner>,
}

struct RouterInner {
    connector: Option<PinnedTlsConnector>,
    client_id: String,
    state: Mutex<RouterState>,
    route_generation: tokio::sync::watch::Sender<u64>,
    acquisition: tokio::sync::Mutex<()>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum CandidateTarget {
    Pinned(Endpoint),
    Local(LocalDockEndpoint),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Candidate {
    id: String,
    target: CandidateTarget,
}

struct RouterState {
    connection_id: String,
    config_revision: u64,
    route_generation: u64,
    resolution_generation: u64,
    last_resolution_error: Option<String>,
    last_resolution_capabilities: Option<Vec<String>>,
    recently_failed_endpoint_id: Option<String>,
    candidates: Vec<Candidate>,
    active_endpoint_id: Option<String>,
    closed: bool,
}

pub(crate) struct RoutedConnection {
    pub(crate) connection: ConnectedTransport,
    pub(crate) hello: HelloAck,
    pub(crate) endpoint_id: String,
    pub(crate) route_generation: u64,
}

impl ConnectionRouter {
    pub fn from_store(store: &IdentityStore, profile: &HostConnectionProfile) -> Result<Self> {
        let paired = store.load_pairing()?;
        let candidates = candidates(profile)?;
        let connector = Some(PinnedTlsConnector::new(
            &paired.identity,
            Some(&paired.host_certificate),
        )?);
        let client_id = paired.metadata.client_id;
        let active_endpoint_id = candidates.first().map(|candidate| candidate.id.clone());
        let (route_generation, _) = tokio::sync::watch::channel(1);
        Ok(Self {
            inner: Arc::new(RouterInner {
                connector,
                client_id,
                state: Mutex::new(RouterState {
                    connection_id: profile.host_id.clone(),
                    config_revision: profile.revision,
                    route_generation: 1,
                    resolution_generation: 0,
                    last_resolution_error: None,
                    last_resolution_capabilities: None,
                    recently_failed_endpoint_id: None,
                    candidates,
                    active_endpoint_id,
                    closed: false,
                }),
                route_generation,
                acquisition: tokio::sync::Mutex::new(()),
            }),
        })
    }

    pub(crate) fn from_pinned_endpoint(
        endpoint: Endpoint,
        identity: ClientIdentity,
        host_certificate: Vec<u8>,
        client_id: String,
    ) -> Result<Self> {
        let connector = Some(PinnedTlsConnector::new(&identity, Some(&host_certificate))?);
        let (route_generation, _) = tokio::sync::watch::channel(1);
        Ok(Self {
            inner: Arc::new(RouterInner {
                connector,
                client_id,
                state: Mutex::new(RouterState {
                    connection_id: "explicit-endpoint-probe".into(),
                    config_revision: 1,
                    route_generation: 1,
                    resolution_generation: 0,
                    last_resolution_error: None,
                    last_resolution_capabilities: None,
                    recently_failed_endpoint_id: None,
                    candidates: vec![Candidate {
                        id: "explicit-endpoint".into(),
                        target: CandidateTarget::Pinned(endpoint),
                    }],
                    active_endpoint_id: None,
                    closed: false,
                }),
                route_generation,
                acquisition: tokio::sync::Mutex::new(()),
            }),
        })
    }

    pub fn local(
        store: &IdentityStore,
        endpoint: LocalDockEndpoint,
        context_id: String,
    ) -> Result<Self> {
        let (route_generation, _) = tokio::sync::watch::channel(1);
        Ok(Self {
            inner: Arc::new(RouterInner {
                connector: None,
                client_id: store.client_id()?,
                state: Mutex::new(RouterState {
                    connection_id: context_id,
                    config_revision: 1,
                    route_generation: 1,
                    resolution_generation: 0,
                    last_resolution_error: None,
                    last_resolution_capabilities: None,
                    recently_failed_endpoint_id: None,
                    candidates: vec![Candidate {
                        id: "local-ipc".into(),
                        target: CandidateTarget::Local(endpoint),
                    }],
                    active_endpoint_id: None,
                    closed: false,
                }),
                route_generation,
                acquisition: tokio::sync::Mutex::new(()),
            }),
        })
    }

    pub fn reconcile(&self, profile: &HostConnectionProfile) -> Result<()> {
        let next_candidates = candidates(profile)?;
        let mut state = self.inner.state.lock().map_err(|_| router_state_error())?;
        if state.closed || state.connection_id != profile.host_id {
            return Err(router_closed_error());
        }
        if state.candidates == next_candidates {
            state.config_revision = profile.revision;
            return Ok(());
        }
        state.config_revision = profile.revision;
        state.route_generation = state.route_generation.saturating_add(1);
        state.last_resolution_error = None;
        state.last_resolution_capabilities = None;
        if state.active_endpoint_id.as_ref().is_some_and(|active| {
            !next_candidates
                .iter()
                .any(|candidate| &candidate.id == active)
        }) {
            state.active_endpoint_id = None;
        }
        if state
            .recently_failed_endpoint_id
            .as_ref()
            .is_some_and(|failed| {
                !next_candidates
                    .iter()
                    .any(|candidate| &candidate.id == failed)
            })
        {
            state.recently_failed_endpoint_id = None;
        }
        state.candidates = next_candidates;
        self.inner
            .route_generation
            .send_replace(state.route_generation);
        Ok(())
    }

    pub fn snapshot(&self) -> RouteSnapshot {
        let state = self
            .inner
            .state
            .lock()
            .expect("Host connection router state poisoned");
        RouteSnapshot {
            active_endpoint_id: state.active_endpoint_id.clone(),
            config_revision: state.config_revision,
            route_generation: state.route_generation,
            closed: state.closed,
        }
    }

    pub fn close(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.closed = true;
            state.active_endpoint_id = None;
            state.route_generation = state.route_generation.saturating_add(1);
            self.inner
                .route_generation
                .send_replace(state.route_generation);
        }
    }

    pub(crate) fn ensure_open(&self) -> Result<()> {
        let state = self.inner.state.lock().map_err(|_| router_state_error())?;
        if state.closed {
            return Err(router_closed_error());
        }
        Ok(())
    }

    pub(crate) fn report_connection_failure(&self, endpoint_id: &str, route_generation: u64) {
        if let Ok(mut state) = self.inner.state.lock()
            && !state.closed
            && state.route_generation == route_generation
            && state.active_endpoint_id.as_deref() == Some(endpoint_id)
        {
            state.active_endpoint_id = None;
            state.route_generation = state.route_generation.saturating_add(1);
            state.last_resolution_error = None;
            state.last_resolution_capabilities = None;
            state.recently_failed_endpoint_id = Some(endpoint_id.to_owned());
            self.inner
                .route_generation
                .send_replace(state.route_generation);
        }
    }

    pub(crate) async fn acquire(&self, required_capabilities: &[&str]) -> Result<RoutedConnection> {
        let attempted_active = {
            let state = self.inner.state.lock().map_err(|_| router_state_error())?;
            state
                .active_endpoint_id
                .clone()
                .map(|endpoint_id| (endpoint_id, state.route_generation))
        };
        match timeout(
            CONNECTION_ACQUISITION_TIMEOUT,
            self.acquire_before_deadline(required_capabilities),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                if let Some((endpoint_id, route_generation)) = attempted_active {
                    self.report_connection_failure(&endpoint_id, route_generation);
                }
                Err(ClientError::Protocol(
                    "Host connection setup timed out".into(),
                ))
            }
        }
    }

    async fn acquire_before_deadline(
        &self,
        required_capabilities: &[&str],
    ) -> Result<RoutedConnection> {
        let capability_key = capability_key(required_capabilities);
        loop {
            let mut active_route_changes = self.inner.route_generation.subscribe();
            let (generation, active) = {
                let state = self.inner.state.lock().map_err(|_| router_state_error())?;
                if state.closed {
                    return Err(router_closed_error());
                }
                let active = state.active_endpoint_id.as_ref().and_then(|active| {
                    state
                        .candidates
                        .iter()
                        .find(|candidate| &candidate.id == active)
                        .cloned()
                });
                (state.route_generation, active)
            };

            let mut failed_active = None;
            if let Some(candidate) = active {
                let result = tokio::select! {
                    changed = active_route_changes.changed() => {
                        changed.map_err(|_| router_closed_error())?;
                        continue;
                    }
                    result = self.negotiate(&candidate, required_capabilities) => result,
                };
                match result {
                    Ok((connection, hello)) => {
                        let state = self.inner.state.lock().map_err(|_| router_state_error())?;
                        if state.closed {
                            return Err(router_closed_error());
                        }
                        if state.route_generation == generation
                            && state.active_endpoint_id.as_deref() == Some(candidate.id.as_str())
                            && state.candidates.iter().any(|current| current == &candidate)
                        {
                            return Ok(RoutedConnection {
                                connection,
                                hello,
                                endpoint_id: candidate.id,
                                route_generation: generation,
                            });
                        }
                        drop(state);
                        drop(connection);
                        continue;
                    }
                    Err(error) => {
                        let mut state =
                            self.inner.state.lock().map_err(|_| router_state_error())?;
                        if state.closed {
                            return Err(router_closed_error());
                        }
                        if state.route_generation != generation
                            || state.active_endpoint_id.as_deref() != Some(candidate.id.as_str())
                        {
                            continue;
                        }
                        state.active_endpoint_id = None;
                        state.route_generation = state.route_generation.saturating_add(1);
                        self.inner
                            .route_generation
                            .send_replace(state.route_generation);
                        state.last_resolution_error = None;
                        state.last_resolution_capabilities = None;
                        state.recently_failed_endpoint_id = Some(candidate.id.clone());
                        failed_active =
                            Some((state.route_generation, candidate.id, error.to_string()));
                    }
                }
            }

            let observed_resolution = {
                let state = self.inner.state.lock().map_err(|_| router_state_error())?;
                state.resolution_generation
            };
            let (permit, waited) = match self.inner.acquisition.try_lock() {
                Ok(permit) => (permit, false),
                Err(_) => (self.inner.acquisition.lock().await, true),
            };

            let mut resolution_route_changes = self.inner.route_generation.subscribe();
            let (resolution_generation, ordered, mut failures) = {
                let state = self.inner.state.lock().map_err(|_| router_state_error())?;
                if state.closed {
                    return Err(router_closed_error());
                }
                if state.active_endpoint_id.is_some() {
                    drop(state);
                    drop(permit);
                    continue;
                }
                if waited
                    && state.resolution_generation != observed_resolution
                    && state.last_resolution_capabilities.as_ref() == Some(&capability_key)
                    && let Some(error) = &state.last_resolution_error
                {
                    return Err(ClientError::Protocol(error.clone()));
                }
                let skipped = failed_active.as_ref().filter(|(failed_generation, _, _)| {
                    *failed_generation == state.route_generation
                });
                let mut ordered = state
                    .candidates
                    .iter()
                    .filter(|candidate| {
                        skipped.is_none_or(|(_, failed_id, _)| candidate.id != failed_id.as_str())
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if let Some(failed) = state.recently_failed_endpoint_id.as_deref()
                    && let Some(index) = ordered.iter().position(|candidate| candidate.id == failed)
                {
                    let candidate = ordered.remove(index);
                    ordered.push(candidate);
                }
                let failures = skipped
                    .map(|(_, id, error)| vec![format!("{id}: {error}")])
                    .unwrap_or_default();
                (state.route_generation, ordered, failures)
            };

            let mut stale = false;
            for candidate in ordered {
                let result = tokio::select! {
                    changed = resolution_route_changes.changed() => {
                        changed.map_err(|_| router_closed_error())?;
                        stale = true;
                        break;
                    }
                    result = self.negotiate(&candidate, required_capabilities) => result,
                };
                match result {
                    Ok((connection, hello)) => {
                        let mut state =
                            self.inner.state.lock().map_err(|_| router_state_error())?;
                        if state.closed {
                            return Err(router_closed_error());
                        }
                        if state.route_generation != resolution_generation
                            || !state.candidates.iter().any(|current| current == &candidate)
                        {
                            drop(state);
                            drop(connection);
                            stale = true;
                            break;
                        }
                        state.active_endpoint_id = Some(candidate.id.clone());
                        state.route_generation = state.route_generation.saturating_add(1);
                        self.inner
                            .route_generation
                            .send_replace(state.route_generation);
                        state.resolution_generation = state.resolution_generation.saturating_add(1);
                        state.last_resolution_error = None;
                        state.last_resolution_capabilities = None;
                        state.recently_failed_endpoint_id = None;
                        let route_generation = state.route_generation;
                        return Ok(RoutedConnection {
                            connection,
                            hello,
                            endpoint_id: candidate.id,
                            route_generation,
                        });
                    }
                    Err(error) => failures.push(format!("{}: {error}", candidate.id)),
                }
            }
            if stale {
                drop(permit);
                continue;
            }

            let error = format!(
                "none of the saved addresses reached the paired Host ({})",
                failures.join("; ")
            );
            let mut state = self.inner.state.lock().map_err(|_| router_state_error())?;
            if state.closed {
                return Err(router_closed_error());
            }
            if state.route_generation != resolution_generation || state.active_endpoint_id.is_some()
            {
                drop(state);
                drop(permit);
                continue;
            }
            state.resolution_generation = state.resolution_generation.saturating_add(1);
            state.last_resolution_error = Some(error.clone());
            state.last_resolution_capabilities = Some(capability_key.clone());
            return Err(ClientError::Protocol(error));
        }
    }

    async fn negotiate(
        &self,
        candidate: &Candidate,
        required_capabilities: &[&str],
    ) -> Result<(ConnectedTransport, HelloAck)> {
        match &candidate.target {
            CandidateTarget::Pinned(endpoint) => {
                let connector = self.inner.connector.as_ref().ok_or_else(|| {
                    ClientError::InvalidPairing(
                        "the selected Host has no paired network identity".into(),
                    )
                })?;
                negotiate_pinned_endpoint(
                    endpoint,
                    connector,
                    &self.inner.client_id,
                    required_capabilities,
                )
                .await
            }
            CandidateTarget::Local(endpoint) => {
                negotiate_local_endpoint(endpoint, &self.inner.client_id, required_capabilities)
                    .await
            }
        }
    }
}

fn capability_key(required_capabilities: &[&str]) -> Vec<String> {
    let mut capabilities = required_capabilities
        .iter()
        .map(|capability| (*capability).to_owned())
        .collect::<Vec<_>>();
    capabilities.sort_unstable();
    capabilities.dedup();
    capabilities
}

fn candidates(profile: &HostConnectionProfile) -> Result<Vec<Candidate>> {
    let candidates = profile
        .ordered_verified_endpoints()
        .into_iter()
        .map(|candidate| Candidate {
            id: candidate.id.clone(),
            target: CandidateTarget::Pinned(candidate.endpoint.clone()),
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Err(ClientError::InvalidEndpoint(
            "at least one verified Host address is required".into(),
        ));
    }
    Ok(candidates)
}

fn router_state_error() -> ClientError {
    ClientError::Protocol("Host connection state is unavailable".into())
}

fn router_closed_error() -> ClientError {
    ClientError::Protocol("Host connection was invalidated".into())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use rustls::{
        ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    };
    use serde_json::Value;
    use tokio::{
        net::TcpListener,
        sync::Notify,
        task::JoinHandle,
        time::{Duration, timeout},
    };
    use tokio_rustls::TlsAcceptor;

    use super::*;
    use crate::{
        DockClient,
        tls::{read_json_line, write_json_line},
    };

    #[derive(Clone)]
    enum ServerMode {
        CloseBeforeHello,
        HelloThenClose,
        HelloWithoutCapabilities,
        CloseAfterRequest,
        HoldHello {
            arrived: Arc<Notify>,
            release: Arc<Notify>,
        },
        HoldResponse {
            arrived: Arc<Notify>,
            release: Arc<Notify>,
        },
    }

    struct TestHost {
        endpoint: Endpoint,
        connections: Arc<AtomicUsize>,
        requests: Arc<AtomicUsize>,
        task: JoinHandle<()>,
    }

    impl TestHost {
        fn stop(self) {
            self.task.abort();
        }
    }

    async fn spawn_test_host(identity: &ClientIdentity, mode: ServerMode) -> TestHost {
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let certificate = CertificateDer::from(identity.certificate_der().to_vec());
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            identity.private_key_der().to_vec(),
        ));
        let config = ServerConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = Endpoint::new("127.0.0.1", listener.local_addr().unwrap().port()).unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let task_connections = connections.clone();
        let task_requests = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                task_connections.fetch_add(1, Ordering::SeqCst);
                let acceptor = acceptor.clone();
                let mode = mode.clone();
                let requests = task_requests.clone();
                tokio::spawn(async move {
                    let Ok(mut stream) = acceptor.accept(tcp).await else {
                        return;
                    };
                    if matches!(mode, ServerMode::CloseBeforeHello) {
                        return;
                    }
                    let Ok(hello) = read_json_line::<Value, _>(&mut stream, 1024 * 1024).await
                    else {
                        return;
                    };
                    let request_id = hello
                        .get("requestId")
                        .and_then(Value::as_str)
                        .unwrap()
                        .to_owned();
                    let requested_capabilities = hello
                        .get("requiredCapabilities")
                        .cloned()
                        .unwrap_or_else(|| Value::Array(Vec::new()));
                    if let ServerMode::HoldHello { arrived, release } = &mode {
                        arrived.notify_one();
                        release.notified().await;
                    }
                    let capabilities = if matches!(
                        mode,
                        ServerMode::HelloWithoutCapabilities | ServerMode::HoldHello { .. }
                    ) {
                        Value::Array(Vec::new())
                    } else {
                        requested_capabilities
                    };
                    if write_json_line(
                        &mut stream,
                        &serde_json::json!({
                            "kind": "hello_ack",
                            "requestId": request_id,
                            "version": 2,
                            "catalogSchemaVersion": 1,
                            "host": { "hostEpoch": "test-epoch" },
                            "capabilities": capabilities,
                            "limits": { "maxLineBytes": 1048576 }
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    if matches!(mode, ServerMode::CloseAfterRequest)
                        && read_json_line::<Value, _>(&mut stream, 1024 * 1024)
                            .await
                            .is_ok()
                    {
                        requests.fetch_add(1, Ordering::SeqCst);
                    } else if let ServerMode::HoldResponse { arrived, release } = &mode
                        && let Ok(request) =
                            read_json_line::<Value, _>(&mut stream, 1024 * 1024).await
                    {
                        arrived.notify_one();
                        release.notified().await;
                        let request_id = request.get("requestId").and_then(Value::as_str).unwrap();
                        let _ = write_json_line(
                            &mut stream,
                            &serde_json::json!({
                                "kind": "response",
                                "version": 2,
                                "requestId": request_id,
                                "hostEpoch": "test-epoch",
                                "ok": true,
                                "result": { "completed": true }
                            }),
                        )
                        .await;
                    }
                });
            }
        });
        TestHost {
            endpoint,
            connections,
            requests,
            task,
        }
    }

    fn test_router(
        client: &ClientIdentity,
        host: &ClientIdentity,
        candidates: Vec<(&str, Endpoint)>,
        active_endpoint_id: &str,
    ) -> ConnectionRouter {
        let connector = PinnedTlsConnector::new(client, Some(host.certificate_der())).unwrap();
        let (route_generation, _) = tokio::sync::watch::channel(1);
        ConnectionRouter {
            inner: Arc::new(RouterInner {
                connector: Some(connector),
                client_id: "test-client".into(),
                state: Mutex::new(RouterState {
                    connection_id: "test-host".into(),
                    config_revision: 1,
                    route_generation: 1,
                    resolution_generation: 0,
                    last_resolution_error: None,
                    last_resolution_capabilities: None,
                    recently_failed_endpoint_id: None,
                    candidates: candidates
                        .into_iter()
                        .map(|(id, endpoint)| Candidate {
                            id: id.into(),
                            target: CandidateTarget::Pinned(endpoint),
                        })
                        .collect(),
                    active_endpoint_id: Some(active_endpoint_id.into()),
                    closed: false,
                }),
                route_generation,
                acquisition: tokio::sync::Mutex::new(()),
            }),
        }
    }

    #[tokio::test]
    async fn promoted_fallback_is_reused_by_the_next_connection() {
        let client = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let dead = spawn_test_host(&host, ServerMode::CloseBeforeHello).await;
        let healthy = spawn_test_host(&host, ServerMode::HelloThenClose).await;
        let router = test_router(
            &client,
            &host,
            vec![
                ("dead", dead.endpoint.clone()),
                ("healthy", healthy.endpoint.clone()),
            ],
            "dead",
        );

        drop(router.acquire(&[]).await.unwrap());
        drop(router.acquire(&[]).await.unwrap());

        assert_eq!(
            router.snapshot().active_endpoint_id.as_deref(),
            Some("healthy")
        );
        assert_eq!(dead.connections.load(Ordering::SeqCst), 1);
        assert_eq!(healthy.connections.load(Ordering::SeqCst), 2);
        dead.stop();
        healthy.stop();
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_fallback_scan() {
        let client = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let active = spawn_test_host(&host, ServerMode::CloseBeforeHello).await;
        let fallback_dead = spawn_test_host(&host, ServerMode::CloseBeforeHello).await;
        let healthy = spawn_test_host(&host, ServerMode::HelloThenClose).await;
        let router = test_router(
            &client,
            &host,
            vec![
                ("active", active.endpoint.clone()),
                ("fallback-dead", fallback_dead.endpoint.clone()),
                ("healthy", healthy.endpoint.clone()),
            ],
            "active",
        );

        let (left, right) = tokio::join!(router.acquire(&[]), router.acquire(&[]));
        drop(left.unwrap());
        drop(right.unwrap());

        assert_eq!(fallback_dead.connections.load(Ordering::SeqCst), 1);
        assert_eq!(healthy.connections.load(Ordering::SeqCst), 2);
        active.stop();
        fallback_dead.stop();
        healthy.stop();
    }

    #[tokio::test]
    async fn capability_specific_failure_is_not_shared_with_another_caller() {
        let client = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let active = spawn_test_host(&host, ServerMode::HelloWithoutCapabilities).await;
        let arrived = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let fallback = spawn_test_host(
            &host,
            ServerMode::HoldHello {
                arrived: arrived.clone(),
                release: release.clone(),
            },
        )
        .await;
        let router = test_router(
            &client,
            &host,
            vec![
                ("active", active.endpoint.clone()),
                ("fallback", fallback.endpoint.clone()),
            ],
            "active",
        );
        let unsupported_router = router.clone();
        let unsupported =
            tokio::spawn(async move { unsupported_router.acquire(&["unsupported"]).await });

        arrived.notified().await;
        let compatible_router = router.clone();
        let compatible = tokio::spawn(async move { compatible_router.acquire(&[]).await });
        tokio::task::yield_now().await;
        release.notify_one();

        assert!(unsupported.await.unwrap().is_err());
        release.notify_one();
        drop(
            timeout(Duration::from_secs(2), compatible)
                .await
                .expect("the compatible caller must perform its own hello")
                .unwrap()
                .unwrap(),
        );
        active.stop();
        fallback.stop();
    }

    #[tokio::test]
    async fn invalidation_cancels_a_late_route_result() {
        let client = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let arrived = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let delayed = spawn_test_host(
            &host,
            ServerMode::HoldHello {
                arrived: arrived.clone(),
                release: release.clone(),
            },
        )
        .await;
        let router = test_router(
            &client,
            &host,
            vec![("delayed", delayed.endpoint.clone())],
            "delayed",
        );
        let task_router = router.clone();
        let acquisition = tokio::spawn(async move { task_router.acquire(&[]).await });

        arrived.notified().await;
        router.close();
        let result = timeout(Duration::from_secs(1), acquisition)
            .await
            .expect("close must wake route setup")
            .unwrap();
        assert!(
            matches!(result, Err(ClientError::Protocol(message)) if message.contains("invalidated"))
        );
        release.notify_one();
        delayed.stop();
    }

    #[tokio::test]
    async fn invalidation_discards_a_late_business_result() {
        let client_identity = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let arrived = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let delayed = spawn_test_host(
            &host,
            ServerMode::HoldResponse {
                arrived: arrived.clone(),
                release: release.clone(),
            },
        )
        .await;
        let router = test_router(
            &client_identity,
            &host,
            vec![("delayed", delayed.endpoint.clone())],
            "delayed",
        );
        let client = DockClient::new(router.clone());
        let request = tokio::spawn(async move {
            client
                .request::<_, Value>("test.read", &serde_json::json!({}), &[], None)
                .await
        });

        arrived.notified().await;
        router.close();
        release.notify_one();

        let result = timeout(Duration::from_secs(1), request)
            .await
            .expect("the completed stale result must be discarded")
            .unwrap();
        assert!(
            matches!(result, Err(ClientError::Protocol(message)) if message.contains("invalidated"))
        );
        delayed.stop();
    }

    #[tokio::test]
    async fn mutation_failure_after_dispatch_is_not_replayed_on_fallback() {
        let client_identity = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let active = spawn_test_host(&host, ServerMode::CloseAfterRequest).await;
        let fallback = spawn_test_host(&host, ServerMode::HelloThenClose).await;
        let router = test_router(
            &client_identity,
            &host,
            vec![
                ("active", active.endpoint.clone()),
                ("fallback", fallback.endpoint.clone()),
            ],
            "active",
        );
        let client = DockClient::new(router.clone());

        let result: Result<Value> = client
            .request(
                "test.mutation",
                &serde_json::json!({}),
                &[],
                Some("operation-1"),
            )
            .await;

        assert!(matches!(
            result,
            Err(ClientError::EffectUnknown { operation_id, .. }) if operation_id == "operation-1"
        ));
        assert_eq!(active.requests.load(Ordering::SeqCst), 1);
        assert_eq!(fallback.connections.load(Ordering::SeqCst), 0);
        assert_eq!(router.snapshot().active_endpoint_id, None);

        drop(router.acquire(&[]).await.unwrap());
        assert_eq!(fallback.connections.load(Ordering::SeqCst), 1);
        assert_eq!(
            router.snapshot().active_endpoint_id.as_deref(),
            Some("fallback")
        );
        active.stop();
        fallback.stop();
    }
}
