use std::time::Duration;

pub(crate) const CONNECT_PHASE_TIMEOUT: Duration = Duration::from_secs(6);
pub(crate) const CONNECTION_ACQUISITION_TIMEOUT: Duration = Duration::from_secs(8);
/// Choosing an address starts the next saved address this long after the
/// previous one, or as soon as it fails, so a silent address costs only this.
pub(crate) const ROUTE_RACE_STAGGER: Duration = Duration::from_millis(250);
pub(crate) const PROTOCOL_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const CONTROL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const LONG_MUTATION_RESPONSE_TIMEOUT: Duration = Duration::from_secs(600);
pub(crate) const RESPONSE_TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const FILE_READ_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
/// The client pings its Host link this often while it is open.
pub(crate) const LINK_PING_INTERVAL: Duration = Duration::from_secs(15);
/// A link that has been silent for a ping interval plus this is gone.
pub(crate) const LINK_PONG_TIMEOUT: Duration = Duration::from_secs(10);
