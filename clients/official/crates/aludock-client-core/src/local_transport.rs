#[cfg(not(any(target_os = "windows", target_os = "android")))]
use std::path::PathBuf;

#[cfg(not(target_os = "android"))]
use tokio::{io::BufReader, time::timeout};

#[cfg(not(target_os = "android"))]
use crate::timing::CONNECT_PHASE_TIMEOUT;
use crate::{ClientError, Result, tls::ConnectedTransport};

#[cfg(target_os = "windows")]
const WINDOWS_PIPE: &str = r"\\.\pipe\alu-dock";
#[cfg(target_os = "windows")]
const WINDOWS_PIPE_PREFIX: &str = r"\\.\pipe\";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalDockEndpoint {
    locator: LocalDockLocator,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum LocalDockLocator {
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    Unix(PathBuf),
    #[cfg(target_os = "windows")]
    WindowsPipe(String),
}

impl LocalDockEndpoint {
    pub fn resolve(configured: Option<&str>) -> Result<Self> {
        match configured.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => Self::configured(value),
            None => Self::platform_default(),
        }
    }

    pub fn configured(value: &str) -> Result<Self> {
        #[cfg(target_os = "windows")]
        {
            let name = value.strip_prefix(WINDOWS_PIPE_PREFIX).ok_or_else(|| {
                ClientError::InvalidEndpoint(r"Windows Named Pipe must start with \\.\pipe\".into())
            })?;
            if name.is_empty() || name.len() > 256 || name.contains('\\') || name.contains('\0') {
                return Err(ClientError::InvalidEndpoint(
                    "Windows Named Pipe name is invalid".into(),
                ));
            }
            return Ok(Self {
                locator: LocalDockLocator::WindowsPipe(value.to_owned()),
            });
        }
        #[cfg(target_os = "android")]
        {
            let _ = value;
            Err(unsupported())
        }
        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(ClientError::InvalidEndpoint(
                    "Unix Socket path must be absolute".into(),
                ));
            }
            Ok(Self {
                locator: LocalDockLocator::Unix(path),
            })
        }
    }

    pub fn platform_default() -> Result<Self> {
        #[cfg(target_os = "windows")]
        {
            return Self::configured(WINDOWS_PIPE);
        }
        #[cfg(target_os = "android")]
        {
            Err(unsupported())
        }
        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        {
            let home = directories::BaseDirs::new()
                .ok_or_else(|| {
                    ClientError::InvalidEndpoint(
                        "could not determine the local AluDock socket path".into(),
                    )
                })?
                .home_dir()
                .to_owned();
            let path = posix_socket_path(std::env::var_os("XDG_RUNTIME_DIR").as_deref(), &home)?;
            Ok(Self {
                locator: LocalDockLocator::Unix(path),
            })
        }
    }

    #[cfg(not(target_os = "android"))]
    pub fn display(&self) -> String {
        match &self.locator {
            #[cfg(not(target_os = "windows"))]
            LocalDockLocator::Unix(path) => path.display().to_string(),
            #[cfg(target_os = "windows")]
            LocalDockLocator::WindowsPipe(path) => path.clone(),
        }
    }

    #[cfg(target_os = "android")]
    pub fn display(&self) -> String {
        unreachable!("Android rejects local Dock endpoints")
    }

    pub(crate) async fn connect(&self) -> Result<ConnectedTransport> {
        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        {
            let LocalDockLocator::Unix(path) = &self.locator;
            let stream = timeout(CONNECT_PHASE_TIMEOUT, tokio::net::UnixStream::connect(path))
                .await
                .map_err(|_| {
                    ClientError::Protocol("timed out opening the local AluDock connection".into())
                })??;
            Ok(ConnectedTransport {
                stream: Box::new(BufReader::new(stream)),
            })
        }

        #[cfg(target_os = "windows")]
        {
            let LocalDockLocator::WindowsPipe(path) = &self.locator;
            let stream = timeout(CONNECT_PHASE_TIMEOUT, async {
                loop {
                    match tokio::net::windows::named_pipe::ClientOptions::new().open(path) {
                        Ok(stream) => return Ok(stream),
                        Err(error) if error.raw_os_error() == Some(231) => {
                            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                        }
                        Err(error) => return Err(error),
                    }
                }
            })
            .await
            .map_err(|_| {
                ClientError::Protocol("timed out opening the local AluDock connection".into())
            })??;
            Ok(ConnectedTransport {
                stream: Box::new(BufReader::new(stream)),
            })
        }

        #[cfg(target_os = "android")]
        {
            Err(unsupported())
        }
    }
}

#[cfg(target_os = "android")]
fn unsupported() -> ClientError {
    ClientError::InvalidEndpoint(
        "local AluDock connections are available on desktop devices".into(),
    )
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn posix_socket_path(
    runtime_directory: Option<&std::ffi::OsStr>,
    home: &std::path::Path,
) -> Result<PathBuf> {
    match runtime_directory.filter(|directory| !directory.is_empty()) {
        Some(directory) => {
            let directory = PathBuf::from(directory);
            if !directory.is_absolute() {
                return Err(ClientError::InvalidEndpoint(
                    "XDG_RUNTIME_DIR must be an absolute path".into(),
                ));
            }
            Ok(directory.join("alu-dock").join("dock.sock"))
        }
        None => Ok(home.join(".alu-dock").join("run").join("dock.sock")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    #[test]
    fn local_connection_uses_the_platform_default_until_the_user_overrides_it() {
        assert_eq!(
            posix_socket_path(
                Some(std::ffi::OsStr::new("/tmp/aludock-runtime")),
                std::path::Path::new("/home/test"),
            )
            .unwrap(),
            PathBuf::from("/tmp/aludock-runtime/alu-dock/dock.sock")
        );
        assert_eq!(
            LocalDockEndpoint::configured("/tmp/custom-dock.sock")
                .unwrap()
                .display(),
            "/tmp/custom-dock.sock"
        );
    }

    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    #[tokio::test]
    async fn local_connection_opens_the_user_selected_unix_socket() {
        let directory =
            std::env::temp_dir().join(format!("aludock-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("dock.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let accept = tokio::spawn(async move { listener.accept().await.unwrap() });

        let connection = LocalDockEndpoint::configured(path.to_str().unwrap())
            .unwrap()
            .connect()
            .await
            .unwrap();
        drop(connection);
        drop(accept.await.unwrap());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn local_connection_uses_default_or_configured_named_pipe() {
        assert_eq!(
            LocalDockEndpoint::platform_default().unwrap().display(),
            WINDOWS_PIPE
        );
        assert_eq!(
            LocalDockEndpoint::configured(r"\\.\pipe\custom-dock")
                .unwrap()
                .display(),
            r"\\.\pipe\custom-dock"
        );
    }
}
