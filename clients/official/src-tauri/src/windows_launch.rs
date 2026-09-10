//! Short-lived native entrypoints. No Tauri window, service, task or Host proxy.
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

pub fn run() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let action = args.first()?.to_str()?;
    if action != "--service" && action != "--launch-host" {
        return None;
    }
    let result = (|| -> io::Result<()> {
        if args.len() < 4 {
            return Err(io::Error::other(
                "The Windows launch arguments are incomplete.",
            ));
        }
        if action == "--service" {
            let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
                io::Error::other("Windows did not provide the local application directory.")
            })?)
            .join("Alu Dock");
            std::fs::create_dir_all(&root)?;
            // Ownership is this live OS handle. A crash releases it; file existence is irrelevant.
            let _gate = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .share_mode(0)
                .open(root.join("install.lock"))
                .map_err(|_| {
                    io::Error::other(
                        "Alu Dock setup or startup is already in progress. Wait and retry.",
                    )
                })?;
            let output = Command::new(&args[1])
                .arg(&args[2])
                .arg("service")
                .args(&args[3..])
                .arg("--json")
                .env("ALUDOCK_START_LOCK_HELD", "1")
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .output()?;
            io::stdout().write_all(&output.stdout)?;
            io::stderr().write_all(&output.stderr)?;
            if !output.status.success() {
                return Err(io::Error::other(
                    "Alu Dock could not complete startup. Check the Host log or rerun Setup.exe.",
                ));
            }
        } else {
            let log = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&args[3])?;
            let mut command = Command::new(&args[1]);
            command
                .arg(&args[2])
                .env("NODE_ENV", "production")
                .env_remove("ALUDOCK_START_LOCK_HELD")
                // Node's detached flag does not escape an SSH KILL_ON_JOB_CLOSE Job.
                // Denied breakaway is an error, never a silent return to that Job.
                .creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone()?))
                .stderr(Stdio::from(log));
            if let Some(home) = std::env::var_os("USERPROFILE") {
                command.current_dir(home);
            }
            let child = command.spawn().map_err(|error| {
                // CreateProcess failed: there is no child to wait for. Clear
                // only this confirmed failure, so a Start Menu retry is possible.
                // Losing the helper AFTER a successful spawn remains uncertain.
                if let Some(root) = std::path::Path::new(&args[3]).parent().and_then(std::path::Path::parent) {
                    let _ = std::fs::write(root.join("host-owner.json"), b"{\"pid\":0,\"exited\":true}");
                }
                io::Error::other(format!(
                    "Windows could not start Alu Dock independently of this terminal ({error}). Open Alu Dock from the Start Menu and check the Host log."
                ))
            })?;
            writeln!(io::stdout(), "{}", child.id())?;
        }
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

/// A migration may temporarily place this executable at the old Desktop entry.
/// Refuse before Tauri/single-instance initialization while Setup owns the gate.
pub fn desktop_allowed() -> bool {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return false;
    };
    let root = PathBuf::from(local).join("Alu Dock");
    if std::fs::create_dir_all(&root).is_err() {
        return false;
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join("install.lock"))
        .is_ok()
}
