#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod windows_launch;

fn main() {
    #[cfg(windows)]
    if let Some(code) = windows_launch::run() {
        std::process::exit(code);
    }
    #[cfg(windows)]
    if !windows_launch::desktop_allowed() {
        std::process::exit(1);
    }
    aludock_client_app_lib::run();
}
