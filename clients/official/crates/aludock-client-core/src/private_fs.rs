use std::{
    fs::{self, OpenOptions},
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
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|source| storage_error(path, source))
}

#[cfg(windows)]
pub(crate) fn set_private_directory_permissions(path: &Path) -> Result<()> {
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

pub(crate) fn remove_file_sync(path: &Path, parent: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => sync_directory(parent),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(storage_error(path, source)),
    }
}
