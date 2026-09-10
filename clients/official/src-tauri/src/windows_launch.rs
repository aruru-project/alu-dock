//! Short-lived Windows process launch primitive; no service orchestration.
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use windows_sys::Win32::Foundation::{
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

pub fn run() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first()?.to_str()? != "--launch-host" {
        return None;
    }
    let result = (|| -> io::Result<()> {
        // Reply pipes belong to this short-lived launcher, never to the Host.
        for handle in [
            io::stdin().as_raw_handle(),
            io::stdout().as_raw_handle(),
            io::stderr().as_raw_handle(),
        ] {
            if !handle.is_null()
                && handle != INVALID_HANDLE_VALUE
                && unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        if args.len() != 4 {
            return Err(io::Error::other(
                "The Windows launch arguments are incomplete.",
            ));
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&args[3])?;
        let mut command = Command::new(&args[1]);
        command
            .arg(&args[2])
            .env("NODE_ENV", "production")
            .creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        if let Some(home) = std::env::var_os("USERPROFILE") {
            command.current_dir(home);
        }
        let child = command.spawn().map_err(|error| io::Error::other(format!(
            "Windows could not start Alu Dock ({error}). Open Alu Dock from the Start Menu and check the Host log."
        )))?;
        writeln!(io::stdout(), "{}", child.id())?;
        Ok(())
    })();
    Some(match result {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(io::stderr(), "{error}");
            1
        }
    })
}
