//! File steps shared by the three existing revisioned JSON formats.
//! Schemas, filename compatibility and conflict errors stay with their owners.
use crate::{ClientError, Result, private_fs::sync_directory};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn latest_snapshot(
    directory: &Path,
    revision: fn(&str) -> Option<u64>,
    unexpected_entry: &str,
    io_error: fn(&Path, std::io::Error) -> ClientError,
) -> Result<Option<(u64, PathBuf)>> {
    let mut latest = None;
    for entry in fs::read_dir(directory).map_err(|source| io_error(directory, source))? {
        let entry = entry.map_err(|source| io_error(directory, source))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let value =
            revision(&name).ok_or_else(|| ClientError::InvalidPairing(unexpected_entry.into()))?;
        if latest.as_ref().is_none_or(|(current, _)| value >= *current) {
            latest = Some((value, entry.path()));
        }
    }
    Ok(latest)
}

pub(crate) fn check_revision(
    expected: u64,
    actual: u64,
    conflict: impl FnOnce(u64, u64) -> ClientError,
) -> Result<()> {
    if actual != expected {
        return Err(conflict(expected, actual));
    }
    Ok(())
}

pub(crate) fn cleanup_snapshots(
    directory: &Path,
    latest: u64,
    revision: fn(&str) -> Option<u64>,
    io_error: fn(&Path, std::io::Error) -> ClientError,
) -> Result<()> {
    let retain_from = latest.saturating_sub(1);
    let mut changed = false;
    for entry in fs::read_dir(directory).map_err(|source| io_error(directory, source))? {
        let entry = entry.map_err(|source| io_error(directory, source))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if revision(&name).is_some_and(|value| value < retain_from) {
            fs::remove_file(entry.path()).map_err(|source| io_error(&entry.path(), source))?;
            changed = true;
        }
    }
    if changed {
        sync_directory(directory)?;
    }
    Ok(())
}
