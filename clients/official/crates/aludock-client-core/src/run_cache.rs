//! Private per-process cache lifetime. A lease prevents startup cleanup from
//! touching another running client. No user source/download paths enter here.
use crate::{
    Result,
    private_fs::{set_private_directory_permissions, storage_error},
};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub(crate) struct RunCache {
    pub path: PathBuf,
    _lease: Option<File>,
}
impl RunCache {
    // Tests/default observers may create media files lazily. Production uses open.
    pub fn lazy(path: PathBuf) -> Self {
        Self { path, _lease: None }
    }
    pub fn open(parent: &Path) -> Result<Self> {
        fs::create_dir_all(parent).map_err(|e| storage_error(parent, e))?;
        set_private_directory_permissions(parent)?;
        let lock_path = parent.join("startup");
        let _startup = startup_lease(&lock_path).map_err(|e| storage_error(&lock_path, e))?;
        for entry in fs::read_dir(parent).map_err(|e| storage_error(parent, e))? {
            let entry = entry.map_err(|e| storage_error(parent, e))?;
            let name = entry.file_name();
            let Some(id) = name.to_str().and_then(|n| n.strip_prefix("run-")) else {
                continue;
            };
            if uuid::Uuid::parse_str(id).is_err()
                || !entry
                    .file_type()
                    .map_err(|e| storage_error(parent, e))?
                    .is_dir()
            {
                continue;
            }
            let owner = entry.path().join("owner");
            match fs::symlink_metadata(&owner) {
                Ok(metadata) if metadata.file_type().is_file() => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // Creation is serialized by startup: no active creator can
                    // be between mkdir and acquiring this run's owner lease.
                    fs::remove_dir_all(entry.path())
                        .map_err(|e| storage_error(&entry.path(), e))?;
                    continue;
                }
                _ => continue,
            }
            // An inaccessible or held lease is not evidence of a dead owner.
            if let Ok(lease) = lease(&owner, false) {
                drop(lease);
                fs::remove_dir_all(entry.path()).map_err(|e| storage_error(&entry.path(), e))?;
            }
        }
        let path = parent.join(format!("run-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|e| storage_error(&path, e))?;
        set_private_directory_permissions(&path)?;
        let owner = path.join("owner");
        let file = lease(&owner, true).map_err(|e| storage_error(&owner, e))?;
        Ok(Self {
            path,
            _lease: Some(file),
        })
    }
}
impl Drop for RunCache {
    fn drop(&mut self) {
        // Windows cannot unlink an exclusively-open lease.
        self._lease.take();
        let _ = fs::remove_dir_all(&self.path);
    }
}
fn startup_lease(path: &Path) -> std::io::Result<File> {
    let started = std::time::Instant::now();
    loop {
        let result = lease(path, true).or_else(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                lease(path, false)
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
fn lease(path: &Path, create: bool) -> std::io::Result<File> {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restarting_client_cleans_only_abandoned_private_runs() {
        let parent =
            std::env::temp_dir().join(format!("aludock-cache-test-{}", uuid::Uuid::new_v4()));
        let first = RunCache::open(&parent).unwrap();
        fs::write(first.path.join("download"), b"read image").unwrap();
        let abandoned = parent.join(format!("run-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&abandoned).unwrap();
        drop(lease(&abandoned.join("owner"), true).unwrap());
        let interrupted_creation = parent.join(format!("run-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&interrupted_creation).unwrap();
        fs::write(parent.join("user-file"), b"untouched").unwrap();
        let second = RunCache::open(&parent).unwrap();
        assert!(first.path.join("download").exists());
        assert!(!abandoned.exists());
        assert!(!interrupted_creation.exists());
        assert!(parent.join("user-file").exists());
        let second_path = second.path.clone();
        drop(second);
        assert!(!second_path.exists());
        drop(first);
        fs::remove_dir_all(parent).unwrap();
    }
}
