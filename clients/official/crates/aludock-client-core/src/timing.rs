use std::time::Duration;

pub(crate) const CONNECT_PHASE_TIMEOUT: Duration = Duration::from_secs(6);
pub(crate) const CONNECTION_ACQUISITION_TIMEOUT: Duration = Duration::from_secs(8);
pub(crate) const PROTOCOL_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const CONTROL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const LONG_MUTATION_RESPONSE_TIMEOUT: Duration = Duration::from_secs(600);
pub(crate) const RESPONSE_TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const FILE_READ_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
