use std::{fs, io, path::Path};

pub(crate) fn publish_new_file(temporary: &Path, destination: &Path) -> io::Result<bool> {
    match publish_platform(temporary, destination) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            fs::remove_file(temporary)?;
            Ok(false)
        }
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(error)
        }
    }
}

#[cfg(not(target_os = "android"))]
fn publish_platform(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(temporary, destination)?;
    fs::remove_file(temporary)
}

#[cfg(target_os = "android")]
fn publish_platform(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let temporary = CString::new(temporary.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "temporary path contains NUL"))?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
    })?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            temporary.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
