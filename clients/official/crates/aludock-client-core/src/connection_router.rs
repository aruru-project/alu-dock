use std::sync::{Arc, Mutex};

use tokio::time::timeout;

use crate::{
    ClientError, ClientIdentity, ConnectionPolicy, Endpoint, HostConnectionProfile, IdentityStore,
    Result,
    client::{HelloAck, negotiate_local_endpoint, negotiate_pinned_endpoint},
    link::{Link, LinkTiming, MULTIPLEX_CAPABILITY},
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
    link_timing: LinkTiming,
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
    policy: ConnectionPolicy,
    route_generation: u64,
    resolution_generation: u64,
    last_resolution_error: Option<String>,
    last_resolution_capabilities: Option<Vec<String>>,
    recently_failed_endpoint_id: Option<String>,
    candidates: Vec<Candidate>,
    active_endpoint_id: Option<String>,
    /// The persistent connection to the active address; every request is a stream on it.
    link: Option<Link>,
    /// Whether this Host advertises `transport.multiplex.v1`, learned from its first hello reply.
    multiplex: Option<bool>,
    closed: bool,
}

impl RouterState {
    fn live_link(&self) -> Option<Link> {
        self.link.as_ref().filter(|link| !link.is_closed()).cloned()
    }

    fn take_link(&mut self) -> Option<Link> {
        self.link.take()
    }
}

/// A negotiated connection; a multiplexed one becomes the route's link when the route commits to it.
struct Negotiated {
    connection: ConnectedTransport,
    hello: HelloAck,
    multiplexed: bool,
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
                link_timing: LinkTiming::default(),
                state: Mutex::new(RouterState {
                    connection_id: profile.host_id.clone(),
                    config_revision: profile.revision,
                    policy: profile.policy.clone(),
                    route_generation: 1,
                    resolution_generation: 0,
                    last_resolution_error: None,
                    last_resolution_capabilities: None,
                    recently_failed_endpoint_id: None,
                    candidates,
                    active_endpoint_id,
                    link: None,
                    multiplex: None,
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
                link_timing: LinkTiming::default(),
                state: Mutex::new(RouterState {
                    connection_id: "explicit-endpoint-probe".into(),
                    config_revision: 1,
                    policy: ConnectionPolicy::Automatic,
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
                    link: None,
                    multiplex: None,
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
                link_timing: LinkTiming::default(),
                state: Mutex::new(RouterState {
                    connection_id: context_id,
                    config_revision: 1,
                    policy: ConnectionPolicy::Automatic,
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
                    link: None,
                    multiplex: None,
                    closed: false,
                }),
                route_generation,
                acquisition: tokio::sync::Mutex::new(()),
            }),
        })
    }

    /// Test seam: links of this router judge liveness with these timings.
    #[cfg(test)]
    pub(crate) fn with_link_timing(self, link_timing: LinkTiming) -> Self {
        let state = {
            let state = self.inner.state.lock().expect("router state");
            RouterState {
                connection_id: state.connection_id.clone(),
                config_revision: state.config_revision,
                policy: state.policy.clone(),
                route_generation: state.route_generation,
                resolution_generation: state.resolution_generation,
                last_resolution_error: None,
                last_resolution_capabilities: None,
                recently_failed_endpoint_id: None,
                candidates: state.candidates.clone(),
                active_endpoint_id: state.active_endpoint_id.clone(),
                link: None,
                multiplex: None,
                closed: false,
            }
        };
        let (route_generation, _) = tokio::sync::watch::channel(1);
        Self {
            inner: Arc::new(RouterInner {
                connector: self.inner.connector.clone(),
                client_id: self.inner.client_id.clone(),
                link_timing,
                state: Mutex::new(state),
                route_generation,
                acquisition: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub fn reconcile(&self, profile: &HostConnectionProfile) -> Result<()> {
        let next_candidates = candidates(profile)?;
        let mut state = self.inner.state.lock().map_err(|_| router_state_error())?;
        if state.closed || state.connection_id != profile.host_id {
            return Err(router_closed_error());
        }
        let policy_changed = state.policy != profile.policy;
        if state.candidates == next_candidates && !policy_changed {
            state.config_revision = profile.revision;
            return Ok(());
        }
        state.config_revision = profile.revision;
        state.policy = profile.policy.clone();
        state.route_generation = state.route_generation.saturating_add(1);
        state.last_resolution_error = None;
        state.last_resolution_capabilities = None;
        let preferred_endpoint_id = next_candidates
            .first()
            .map(|candidate| candidate.id.as_str());
        let mut dropped_link = None;
        if state.active_endpoint_id.as_deref() != preferred_endpoint_id {
            state.active_endpoint_id = None;
            state.recently_failed_endpoint_id = None;
            dropped_link = state.take_link();
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
        drop(state);
        if let Some(link) = dropped_link {
            link.close();
        }
        Ok(())
    }

    pub fn reselect_preferred_route(&self) -> Result<bool> {
        let mut state = self.inner.state.lock().map_err(|_| router_state_error())?;
        if state.closed {
            return Err(router_closed_error());
        }
        if !state
            .candidates
            .iter()
            .any(|candidate| matches!(&candidate.target, CandidateTarget::Pinned(_)))
        {
            return Ok(false);
        }
        state.active_endpoint_id = None;
        state.recently_failed_endpoint_id = None;
        state.last_resolution_error = None;
        state.last_resolution_capabilities = None;
        state.route_generation = state.route_generation.saturating_add(1);
        let dropped_link = state.take_link();
        self.inner
            .route_generation
            .send_replace(state.route_generation);
        drop(state);
        if let Some(link) = dropped_link {
            link.close();
        }
        Ok(true)
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
        let mut dropped_link = None;
        if let Ok(mut state) = self.inner.state.lock() {
            state.closed = true;
            state.active_endpoint_id = None;
            state.route_generation = state.route_generation.saturating_add(1);
            dropped_link = state.take_link();
            self.inner
                .route_generation
                .send_replace(state.route_generation);
        }
        if let Some(link) = dropped_link {
            link.close();
        }
    }

    pub(crate) fn ensure_open(&self) -> Result<()> {
        let state = self.inner.state.lock().map_err(|_| router_state_error())?;
        if state.closed {
            return Err(router_closed_error());
        }
        Ok(())
    }

    /// A request on this route failed at the transport. On a live link that is
    /// one stream's failure and the address stays; the link's own liveness decides.
    pub(crate) fn report_connection_failure(&self, endpoint_id: &str, route_generation: u64) {
        if let Ok(mut state) = self.inner.state.lock()
            && !state.closed
            && state.route_generation == route_generation
            && state.active_endpoint_id.as_deref() == Some(endpoint_id)
        {
            if state.live_link().is_some() {
                return;
            }
            state.link = None;
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

    /// Commit a negotiated connection as this route's link. A link that another
    /// caller committed meanwhile is kept; the newer connection is dropped.
    fn adopt_link(
        state: &mut RouterState,
        inner: &Arc<RouterInner>,
        negotiated: Negotiated,
        endpoint_id: &str,
    ) -> Result<Link> {
        if let Some(existing) = state.live_link() {
            drop(negotiated);
            return Ok(existing);
        }
        let weak = Arc::downgrade(inner);
        let failed_endpoint = endpoint_id.to_owned();
        let link = Link::establish(
            negotiated.connection,
            negotiated.hello,
            inner.link_timing,
            Box::new(move |link_id| {
                let Some(inner) = weak.upgrade() else { return };
                ConnectionRouter { inner }.report_link_loss(link_id, &failed_endpoint);
            }),
        );
        state.link = Some(link.clone());
        Ok(link)
    }

    /// The route's current link ended on its own: the address is retried last next time.
    fn report_link_loss(&self, link_id: uuid::Uuid, endpoint_id: &str) {
        if let Ok(mut state) = self.inner.state.lock()
            && !state.closed
            && state.link.as_ref().is_some_and(|link| link.id() == link_id)
            && state.active_endpoint_id.as_deref() == Some(endpoint_id)
        {
            state.link = None;
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

    fn stream_on(
        &self,
        link: &Link,
        required_capabilities: &[&str],
        endpoint_id: String,
        route_generation: u64,
    ) -> Result<RoutedConnection> {
        let connection = link.open_stream(&self.inner.client_id, required_capabilities)?;
        Ok(RoutedConnection {
            connection,
            hello: link.hello().clone(),
            endpoint_id,
            route_generation,
        })
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
                let mut state = self.inner.state.lock().map_err(|_| router_state_error())?;
                if state.closed {
                    return Err(router_closed_error());
                }
                if let Some(link) = state.live_link()
                    && let Some(endpoint_id) = state.active_endpoint_id.clone()
                {
                    let generation = state.route_generation;
                    drop(state);
                    return self.stream_on(&link, required_capabilities, endpoint_id, generation);
                }
                state.link = None;
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
                // One link per route: concurrent callers wait for the first to establish it.
                let link_expected = {
                    let state = self.inner.state.lock().map_err(|_| router_state_error())?;
                    state.multiplex == Some(true)
                };
                let _permit = if link_expected {
                    let permit = self.inner.acquisition.lock().await;
                    let state = self.inner.state.lock().map_err(|_| router_state_error())?;
                    if state.closed {
                        return Err(router_closed_error());
                    }
                    if state.route_generation != generation {
                        continue;
                    }
                    if let Some(link) = state.live_link() {
                        drop(state);
                        return self.stream_on(
                            &link,
                            required_capabilities,
                            candidate.id,
                            generation,
                        );
                    }
                    Some(permit)
                } else {
                    None
                };
                let result = tokio::select! {
                    changed = active_route_changes.changed() => {
                        changed.map_err(|_| router_closed_error())?;
                        continue;
                    }
                    result = self.negotiate(&candidate, required_capabilities) => result,
                };
                match result {
                    Ok(negotiated) => {
                        let mut state =
                            self.inner.state.lock().map_err(|_| router_state_error())?;
                        if state.closed {
                            return Err(router_closed_error());
                        }
                        if state.route_generation == generation
                            && state.active_endpoint_id.as_deref() == Some(candidate.id.as_str())
                            && state.candidates.iter().any(|current| current == &candidate)
                        {
                            if negotiated.multiplexed {
                                let link = Self::adopt_link(
                                    &mut state,
                                    &self.inner,
                                    negotiated,
                                    &candidate.id,
                                )?;
                                drop(state);
                                return self.stream_on(
                                    &link,
                                    required_capabilities,
                                    candidate.id,
                                    generation,
                                );
                            }
                            return Ok(RoutedConnection {
                                connection: negotiated.connection,
                                hello: negotiated.hello,
                                endpoint_id: candidate.id,
                                route_generation: generation,
                            });
                        }
                        drop(state);
                        drop(negotiated);
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
                        // A correlated Host rejection is not an address failure.
                        if matches!(&error, ClientError::Host { .. }) {
                            return Err(error);
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
                    Ok(negotiated) => {
                        let mut state =
                            self.inner.state.lock().map_err(|_| router_state_error())?;
                        if state.closed {
                            return Err(router_closed_error());
                        }
                        if state.route_generation != resolution_generation
                            || !state.candidates.iter().any(|current| current == &candidate)
                        {
                            drop(state);
                            drop(negotiated);
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
                        if negotiated.multiplexed {
                            let link = Self::adopt_link(
                                &mut state,
                                &self.inner,
                                negotiated,
                                &candidate.id,
                            )?;
                            drop(state);
                            return self.stream_on(
                                &link,
                                required_capabilities,
                                candidate.id,
                                route_generation,
                            );
                        }
                        return Ok(RoutedConnection {
                            connection: negotiated.connection,
                            hello: negotiated.hello,
                            endpoint_id: candidate.id,
                            route_generation,
                        });
                    }
                    Err(error @ ClientError::Host { .. }) => {
                        let state = self.inner.state.lock().map_err(|_| router_state_error())?;
                        if state.closed {
                            return Err(router_closed_error());
                        }
                        if state.route_generation != resolution_generation
                            || !state.candidates.iter().any(|current| current == &candidate)
                        {
                            stale = true;
                            break;
                        }
                        return Err(error);
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

    /// The first connection to a Host is an ordinary one; its hello reply says
    /// whether the Host carries links. From then on one link serves the route.
    async fn negotiate(
        &self,
        candidate: &Candidate,
        required_capabilities: &[&str],
    ) -> Result<Negotiated> {
        let multiplex = {
            let state = self.inner.state.lock().map_err(|_| router_state_error())?;
            state.multiplex
        };
        if multiplex == Some(true) {
            match self
                .negotiate_with(candidate, &[MULTIPLEX_CAPABILITY])
                .await
            {
                Ok((connection, hello)) => {
                    return Ok(Negotiated {
                        connection,
                        hello,
                        multiplexed: true,
                    });
                }
                Err(error) if error.missing_capability(&[MULTIPLEX_CAPABILITY]) => {
                    let mut state = self.inner.state.lock().map_err(|_| router_state_error())?;
                    state.multiplex = Some(false);
                }
                Err(error) => return Err(error),
            }
        }
        let (connection, hello) = self
            .negotiate_with(candidate, required_capabilities)
            .await?;
        if multiplex.is_none() {
            let mut state = self.inner.state.lock().map_err(|_| router_state_error())?;
            state.multiplex = Some(
                hello
                    .capabilities
                    .iter()
                    .any(|capability| capability == MULTIPLEX_CAPABILITY),
            );
        }
        Ok(Negotiated {
            connection,
            hello,
            multiplexed: false,
        })
    }

    async fn negotiate_with(
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

impl Drop for RouterInner {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock()
            && let Some(link) = state.take_link()
        {
            link.close();
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
        ConnectionKind, DockClient, EndpointState, HostEndpoint,
        tls::{read_json_line, write_json_line},
    };

    #[derive(Clone)]
    enum ServerMode {
        CloseBeforeHello,
        PairingClosed,
        HelloThenClose,
        HelloWithoutCapabilities,
        MissingSystemCapability,
        CloseAfterRequest,
        Records(&'static str),
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
                    let Ok(stream) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let mut stream = tokio::io::BufReader::new(stream);
                    if matches!(mode, ServerMode::CloseBeforeHello) {
                        return;
                    }
                    let Ok(hello) = read_json_line::<Value, _>(&mut stream, 1024 * 1024).await
                    else {
                        return;
                    };
                    if matches!(mode, ServerMode::PairingClosed) {
                        assert_eq!(hello["type"], "pairing.begin.v1");
                        write_json_line(
                            &mut stream,
                            &serde_json::json!({
                                "type": "pairing.error.v1", "code": "pairing_closed",
                                "message": "Pairing window is closed"
                            }),
                        )
                        .await
                        .unwrap();
                        return;
                    }
                    let request_id = hello
                        .get("requestId")
                        .and_then(Value::as_str)
                        .unwrap()
                        .to_owned();
                    let requested_capabilities = hello
                        .get("requiredCapabilities")
                        .cloned()
                        .unwrap_or_else(|| Value::Array(Vec::new()));
                    if matches!(mode, ServerMode::MissingSystemCapability)
                        && requested_capabilities.as_array().is_some_and(|items| {
                            items.iter().any(|item| item == "system.templates.v1")
                        })
                    {
                        let _ = write_json_line(&mut stream, &serde_json::json!({
                            "kind": "hello_error", "requestId": request_id,
                            "error": { "code": "capability_missing", "message": "Required capabilities are unavailable", "missing": ["system.templates.v1"] }
                        })).await;
                        return;
                    }
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
                    if let ServerMode::Records(mode) = mode {
                        let request: Value =
                            read_json_line(&mut stream, 1024 * 1024).await.unwrap();
                        requests.fetch_add(1, Ordering::SeqCst);
                        let id = &request["requestId"];
                        if mode == "refused" || mode == "missing" {
                            let code = if mode == "missing" {
                                "capability_missing"
                            } else {
                                "instance_not_active"
                            };
                            write_json_line(&mut stream, &serde_json::json!({"kind":"response","version":2,"requestId":id,"hostEpoch":"test-epoch","ok":false,
                                "error":{"code":code,"message":"fixture refusal","retryable":false,"details":{"missing":["instance.records.v1"]}}})).await.unwrap();
                            return;
                        }
                        let cursor = serde_json::json!({"hostEpoch":"test-epoch","instanceId":"work","runtimeGeneration":1,"sequence":0});
                        let metadata = serde_json::json!({"kind":"response","version":2,"requestId":id,"hostEpoch":"test-epoch","ok":true,
                            "result":{"page":{"events":[],"earliest":cursor,"latest":cursor,"truncated":false,"epochChanged":false,"generationChanged":false}}});
                        let ready = serde_json::json!({"kind":"instance_ready","version":2,"requestId":id,"hostEpoch":"test-epoch","historyEntries":0,"eventCount":0});
                        let mut total = 0;
                        for (index, value) in [metadata, ready].iter().enumerate() {
                            use base64::Engine as _;
                            let bytes = if mode == "malformed" {
                                b"{".to_vec()
                            } else {
                                serde_json::to_vec(value).unwrap()
                            };
                            total += bytes.len() as u64;
                            write_json_line(&mut stream,&serde_json::json!({"kind":"instance_record_fragment","version":2,"requestId":id,"hostEpoch":"test-epoch",
                                "recordIndex":index,"index":0,"count":1,"data":base64::engine::general_purpose::STANDARD.encode(bytes)})).await.unwrap();
                            if mode == "malformed" {
                                return;
                            }
                        }
                        while let Ok(progress) =
                            read_json_line::<Value, _>(&mut stream, 1024 * 1024).await
                        {
                            if progress["consumedBytes"].as_u64() == Some(total) {
                                break;
                            }
                        }
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
                link_timing: LinkTiming::default(),
                state: Mutex::new(RouterState {
                    connection_id: "test-host".into(),
                    config_revision: 1,
                    policy: ConnectionPolicy::Automatic,
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
                    link: None,
                    multiplex: None,
                    closed: false,
                }),
                route_generation,
                acquisition: tokio::sync::Mutex::new(()),
            }),
        }
    }

    // Trust boundary: direct pairing reads use the same buffered TLS owner;
    // pin verification still precedes any application data on pinned connects.
    #[tokio::test]
    async fn pairing_reads_the_host_reply_and_a_different_pin_cannot_connect() {
        let host = ClientIdentity::generate().unwrap();
        let endpoint = spawn_test_host(&host, ServerMode::PairingClosed).await;
        let directory =
            std::env::temp_dir().join(format!("aludock-pairing-read-{}", uuid::Uuid::new_v4()));
        let store = IdentityStore::new(&directory);
        let error = crate::HostRegistry::open(store.root())
            .unwrap()
            .verify_pairing(endpoint.endpoint.clone(), "reader-test", |_| {})
            .await
            .err()
            .unwrap();
        assert!(
            matches!(error, ClientError::PairingRejected { code, .. } if code == "pairing_closed")
        );
        assert!(!store.is_paired());
        let client = store.load_or_create_identity().unwrap();
        let error =
            crate::tls::connect_tls(&endpoint.endpoint, &client, Some(client.certificate_der()))
                .await
                .err()
                .expect("a different Host pin must fail");
        assert!(matches!(error, ClientError::HostCertificateMismatch));
        endpoint.stop();
        std::fs::remove_dir_all(directory).unwrap();
    }

    // New Client / old Host: optional system discovery must not make the
    // reachable paired Host look offline or destroy its capability evidence.
    #[tokio::test]
    async fn unsupported_system_selection_preserves_the_host_error_and_basic_connection() {
        let client = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let endpoint = spawn_test_host(&host, ServerMode::MissingSystemCapability).await;
        for active in [false, true] {
            let router = test_router(
                &client,
                &host,
                vec![("local", endpoint.endpoint.clone())],
                "local",
            );
            if !active {
                router.inner.state.lock().unwrap().active_endpoint_id = None;
            }
            let result = router.acquire(&["core.v2", "system.templates.v1"]).await;
            match result {
                Err(ClientError::Host {
                    code,
                    details: Some(details),
                    retryable: false,
                    ..
                }) => {
                    assert_eq!(code, "capability_missing");
                    assert_eq!(
                        details,
                        serde_json::json!({ "missing": ["system.templates.v1"] })
                    );
                }
                _ => {
                    panic!("an unsupported system feature must remain a structured Host rejection")
                }
            }
            if active {
                assert_eq!(
                    router.snapshot().active_endpoint_id.as_deref(),
                    Some("local")
                );
            }
            assert!(
                router.acquire(&["core.v2"]).await.is_ok(),
                "ordinary Host requests remain available"
            );
        }
        endpoint.stop();
    }

    #[test]
    fn choosing_a_fixed_preferred_address_stops_reusing_the_previous_route() {
        let client = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let local = Endpoint::new("127.0.0.1", 10001).unwrap();
        let remote = Endpoint::new("127.0.0.1", 10002).unwrap();
        let router = test_router(
            &client,
            &host,
            vec![("local", local.clone()), ("remote", remote.clone())],
            "remote",
        );
        let endpoint = |id: &str, kind, endpoint| HostEndpoint {
            id: id.into(),
            label: id.into(),
            kind,
            endpoint,
            state: EndpointState::Verified,
            verified_at: None,
            last_success_at: None,
            disabled_from: None,
            last_manual_test: None,
        };
        let profile = HostConnectionProfile {
            schema_version: 1,
            revision: 2,
            host_id: "test-host".into(),
            display_name: "Test Host".into(),
            endpoints: vec![
                endpoint("local", ConnectionKind::Local, local),
                endpoint("remote", ConnectionKind::Remote, remote),
            ],
            policy: ConnectionPolicy::Fixed {
                endpoint_id: "local".into(),
            },
            last_successful_endpoint_id: None,
        };

        router.reconcile(&profile).unwrap();

        assert_eq!(router.snapshot().active_endpoint_id, None);
    }

    #[tokio::test]
    async fn network_change_reselects_the_preferred_address_instead_of_reusing_remote() {
        let client = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        let local = spawn_test_host(&host, ServerMode::HelloThenClose).await;
        let remote = spawn_test_host(&host, ServerMode::HelloThenClose).await;
        let router = test_router(
            &client,
            &host,
            vec![
                ("local", local.endpoint.clone()),
                ("remote", remote.endpoint.clone()),
            ],
            "remote",
        );

        assert!(router.reselect_preferred_route().unwrap());
        drop(router.acquire(&[]).await.unwrap());

        assert_eq!(
            router.snapshot().active_endpoint_id.as_deref(),
            Some("local")
        );
        assert_eq!(local.connections.load(Ordering::SeqCst), 1);
        assert_eq!(remote.connections.load(Ordering::SeqCst), 0);
        local.stop();
        remote.stop();
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
    // #325 review: hello alone cannot keep a broken records endpoint preferred.
    #[tokio::test]
    async fn records_failures_reselect_another_address_but_business_refusals_do_not() {
        let identity = ClientIdentity::generate().unwrap();
        let host = ClientIdentity::generate().unwrap();
        for mode in [
            ServerMode::CloseAfterRequest,
            ServerMode::Records("malformed"),
            ServerMode::Records("refused"),
            ServerMode::Records("missing"),
        ] {
            let business = matches!(mode, ServerMode::Records("refused" | "missing"));
            let active = spawn_test_host(&host, mode).await;
            let healthy = spawn_test_host(&host, ServerMode::Records("valid")).await;
            let router = test_router(
                &identity,
                &host,
                vec![
                    ("active", active.endpoint.clone()),
                    ("healthy", healthy.endpoint.clone()),
                ],
                "active",
            );
            let client = DockClient::new(router.clone());
            let context = crate::InstanceDeliveryContext::default();
            let params = serde_json::json!({"instanceId":"work"});
            let result = client
                .open_instance_records::<_, Value>("instance.follow", &params, &[], &context)
                .await;
            assert!(result.is_err());
            if business {
                assert!(matches!(result, Err(ClientError::Host { .. })));
                assert_eq!(
                    router.snapshot().active_endpoint_id.as_deref(),
                    Some("active")
                );
                assert_eq!(healthy.connections.load(Ordering::SeqCst), 0);
            } else {
                assert_eq!(router.snapshot().active_endpoint_id, None);
                let (result, _stream) = client
                    .open_instance_records::<_, Value>("instance.follow", &params, &[], &context)
                    .await
                    .unwrap();
                assert_eq!(result["page"]["events"], serde_json::json!([]));
                assert_eq!(
                    router.snapshot().active_endpoint_id.as_deref(),
                    Some("healthy")
                );
            }
            active.stop();
            healthy.stop();
        }
    }
}
