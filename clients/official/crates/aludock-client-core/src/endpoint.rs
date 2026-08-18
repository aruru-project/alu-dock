use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

use crate::{ClientError, Result};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Endpoint {
    host: String,
    port: u16,
}

impl Endpoint {
    pub fn new(host: impl Into<String>, port: u16) -> Result<Self> {
        let host = host.into();
        let host = host.trim();
        if host.is_empty() {
            return Err(ClientError::InvalidEndpoint("host is empty".into()));
        }
        if port == 0 {
            return Err(ClientError::InvalidEndpoint(
                "port must be between 1 and 65535".into(),
            ));
        }
        let normalized = if host.contains(':') {
            let address = host.parse::<std::net::Ipv6Addr>().map_err(|_| {
                ClientError::InvalidEndpoint(
                    "IPv6 addresses must be valid and must not include a port".into(),
                )
            })?;
            address.to_string()
        } else {
            url::Host::parse(host)
                .map_err(|_| {
                    ClientError::InvalidEndpoint("host name or IP address is invalid".into())
                })?
                .to_string()
        };
        Ok(Self {
            host: normalized,
            port,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl<'de> Deserialize<'de> for Endpoint {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct StoredEndpoint {
            host: String,
            port: u16,
        }

        let stored = StoredEndpoint::deserialize(deserializer)?;
        Self::new(stored.host, stored.port).map_err(D::Error::custom)
    }
}

impl FromStr for Endpoint {
    type Err = ClientError;

    fn from_str(value: &str) -> Result<Self> {
        let url = url::Url::parse(&format!("tls://{value}"))
            .map_err(|error| ClientError::InvalidEndpoint(error.to_string()))?;
        if url.path() != "" && url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ClientError::InvalidEndpoint(
                "expected HOST:PORT without a path, query, or fragment".into(),
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| ClientError::InvalidEndpoint("host is missing".into()))?
            .trim_matches(['[', ']']);
        let port = url
            .port()
            .ok_or_else(|| ClientError::InvalidEndpoint("port is missing".into()))?;
        Self::new(host, port)
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.host.contains(':') {
            write!(formatter, "[{}]:{}", self.host, self.port)
        } else {
            write!(formatter, "{}:{}", self.host, self.port)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Endpoint;

    #[test]
    fn parses_dns_ipv4_and_ipv6_endpoints() {
        for (input, host) in [
            ("dock.example:9999", "dock.example"),
            ("127.0.0.1:9999", "127.0.0.1"),
            ("[::1]:9999", "::1"),
        ] {
            let endpoint: Endpoint = input.parse().expect("valid endpoint");
            assert_eq!(endpoint.host(), host);
            assert_eq!(endpoint.port(), 9999);
        }
    }

    #[test]
    fn rejects_invalid_constructor_and_persisted_endpoints() {
        assert!(Endpoint::new("dock.example", 0).is_err());
        assert!(Endpoint::new("not a host", 9999).is_err());
        assert!(serde_json::from_str::<Endpoint>(r#"{"host":"","port":9999}"#).is_err());
        assert!(serde_json::from_str::<Endpoint>(r#"{"host":"dock.example","port":0}"#).is_err());
    }
}
