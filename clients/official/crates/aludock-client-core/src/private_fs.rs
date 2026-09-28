use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

use crate::{ClientError, Result};

pub(crate) fn storage_error(path: &Path, source: std::io::Error) -> ClientError {
    ClientError::Storage {
        path: path.display().to_string(),
        source,
    }
}

#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| storage_error(path, source))
}

#[cfg(not(unix))]
pub(crate) fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
pub(crate) fn set_private_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
    if metadata.permissions().mode() & 0o7777 == 0o700 {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|source| storage_error(path, source))
}

#[cfg(windows)]
pub(crate) fn set_private_directory_permissions(path: &Path) -> Result<()> {
    if crate::windows_security::assert_private_directory(path).is_ok() {
        return Ok(());
    }
    crate::windows_security::secure_directory(path).map_err(|source| storage_error(path, source))
}

#[cfg(all(not(unix), not(windows)))]
pub(crate) fn set_private_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|source| storage_error(path, source))
}

#[cfg(windows)]
fn set_private_file_permissions(path: &Path) -> Result<()> {
    if crate::windows_security::assert_private_file(path).is_ok() {
        return Ok(());
    }
    crate::windows_security::secure_file(path).map_err(|source| storage_error(path, source))
}

#[cfg(all(not(unix), not(windows)))]
fn set_private_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

pub(crate) fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|source| storage_error(path, source))?;
    file.write_all(bytes)
        .map_err(|source| storage_error(path, source))?;
    file.sync_all()
        .map_err(|source| storage_error(path, source))?;
    set_private_file_permissions(path)
}

/// Creates/repairs a private directory, but does not rewrite correct permissions.
pub(crate) fn ensure_private_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|source| storage_error(path, source))?;
        }
        Err(source) => return Err(storage_error(path, source)),
    }
    assert_real_directory(path, "private directory")?;
    set_private_directory_permissions(path)
}

pub(crate) fn assert_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ClientError::InvalidPairing(format!(
            "{label} is not a real directory"
        )));
    }
    #[cfg(windows)]
    set_private_directory_permissions(path)?;
    Ok(())
}

/// Checks the path on every read; Windows retains repair of inherited ACLs.
pub(crate) fn read_regular_file(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|source| storage_error(path, source))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ClientError::InvalidPairing(
            "stored state is not a regular file".into(),
        ));
    }
    #[cfg(windows)]
    {
        let parent = path
            .parent()
            .ok_or_else(|| ClientError::InvalidPairing("stored state has no parent".into()))?;
        set_private_directory_permissions(parent)?;
        set_private_file_permissions(path)?;
    }
    fs::read(path).map_err(|source| storage_error(path, source))
}

pub(crate) fn read_private_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&read_regular_file(path)?).map_err(ClientError::from)
}

/// Atomic publication; false means another writer owns the destination.
pub(crate) fn publish_private_file(path: &Path, bytes: &[u8]) -> Result<bool> {
    let parent = path
        .parent()
        .ok_or_else(|| ClientError::InvalidPairing("stored state has no parent".into()))?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        write_new_private_file(&temporary, bytes)?;
        let published = crate::fs_publish::publish_new_file(&temporary, path)
            .map_err(|source| storage_error(path, source))?;
        if published {
            sync_directory(parent)?;
        }
        Ok(published)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn ensure_fixed_directory(root: &Path, name: &str) -> Result<()> {
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(ClientError::InvalidPairing(
                    "client data component is not a real directory".into(),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|source| storage_error(&path, source))?;
            sync_directory(root)?;
        }
        Err(source) => return Err(storage_error(&path, source)),
    }
    set_private_directory_permissions(&path)
}

// The returned OS handle owns the lease. Never unlink the lease file on release.
pub(crate) fn exclusive_file_lease(path: &Path) -> std::io::Result<File> {
    let started = std::time::Instant::now();
    loop {
        let result = file_lease(path, true).or_else(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                file_lease(path, false)
            } else {
                Err(e)
            }
        });
        match result {
            Ok(file) => return Ok(file),
            Err(e)
                if (e.kind() == std::io::ErrorKind::WouldBlock
                    || cfg!(windows) && e.raw_os_error() == Some(32))
                    && started.elapsed() < std::time::Duration::from_secs(10) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            Err(e) => return Err(e),
        }
    }
}
pub(crate) fn file_lease(path: &Path, create: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(file)
}
