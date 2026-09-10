#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{App, AppHandle, Manager};
#[cfg(target_os = "windows")]
use tauri::{Emitter, WindowEvent};
#[cfg(target_os = "windows")]
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShellStatus {
    pub supported: bool,
    pub host_ready: bool,
    pub host_phase: String,
    pub role: Option<String>,
    pub main_connected: Option<bool>,
    pub restoring_works: bool,
    pub unavailable_works: u64,
    pub startup_error: Option<String>,
    pub logs_path: Option<String>,
    pub login_start_enabled: bool,
    pub auto_start_local_host: bool,
}

#[derive(Clone)]
pub struct DesktopShellState {
    status: Arc<Mutex<DesktopShellStatus>>,
    #[cfg(target_os = "windows")]
    exit_requested: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    tray_operation_active: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    manages_local_host: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    runtime: Option<WindowsRuntime>,
}

impl DesktopShellState {
    pub fn initialize(app: &App) -> Self {
        #[cfg(target_os = "windows")]
        {
            use tauri_plugin_autostart::ManagerExt;

            let auto_start = app
                .state::<super::ConnectionRuntimeState>()
                .preferences
                .snapshot()
                .map(|p| p.windows_start_local_host)
                .unwrap_or(true);
            let runtime = WindowsRuntime::discover();
            let mut status = match &runtime {
                Ok(runtime) => runtime.initial_status(),
                Err(error) => DesktopShellStatus {
                    supported: true,
                    host_ready: false,
                    host_phase: "unknown".into(),
                    role: None,
                    startup_error: Some(error.clone()),
                    logs_path: windows_host_log_path()
                        .ok()
                        .map(|path| path.display().to_string()),
                    login_start_enabled: false,
                    ..Default::default()
                },
            };
            status.login_start_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            status.auto_start_local_host = auto_start;
            if !auto_start {
                status.host_phase = "stopped".into();
                status.startup_error = None;
            }
            return Self {
                status: Arc::new(Mutex::new(status)),
                exit_requested: Arc::new(AtomicBool::new(false)),
                tray_operation_active: Arc::new(AtomicBool::new(false)),
                manages_local_host: Arc::new(AtomicBool::new(auto_start && runtime.is_ok())),
                runtime: runtime.ok(),
            };
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = app;
            Self {
                status: Arc::new(Mutex::new(DesktopShellStatus {
                    supported: false,
                    host_ready: false,
                    host_phase: "unknown".into(),
                    role: None,
                    startup_error: None,
                    logs_path: None,
                    login_start_enabled: false,
                    ..Default::default()
                })),
            }
        }
    }

    pub fn snapshot(&self) -> DesktopShellStatus {
        self.status
            .lock()
            .expect("desktop shell status lock poisoned")
            .clone()
    }

    #[cfg(target_os = "windows")]
    fn update(&self, app: &AppHandle, mut status: DesktopShellStatus) -> DesktopShellStatus {
        use tauri_plugin_autostart::ManagerExt;
        let mut current = self
            .status
            .lock()
            .expect("desktop shell status lock poisoned");

        status.auto_start_local_host = current.auto_start_local_host;
        status.login_start_enabled = app
            .autolaunch()
            .is_enabled()
            .unwrap_or(current.login_start_enabled);
        if status.host_ready && !current.host_ready && status.role.as_deref() == Some("main") {
            if app
                .state::<super::ConnectionRuntimeState>()
                .select_initial_local()
                .is_err()
            {
                status.startup_error =
                    Some("无法自动连接本机 Alu Dock。请在主机列表中选择本机。".into());
            }
        }
        if *current == status {
            return status;
        }
        *current = status.clone();
        drop(current);
        update_tray(app, &status);
        let _ = app.emit("desktop-shell-changed", status.clone());
        status
    }
}

pub fn finish_setup(app: &mut App) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    {
        create_tray(app)?;
        let handle = app.handle().clone();
        let state = app.state::<DesktopShellState>().inner().clone();
        if let Some(runtime) = state.runtime.clone() {
            let starter = runtime.clone();
            let start_state = state.clone();
            let start_app = handle.clone();
            if state.snapshot().auto_start_local_host {
                state.tray_operation_active.store(true, Ordering::SeqCst);
                tauri::async_runtime::spawn(async move {
                    if let Ok(status) =
                        tauri::async_runtime::spawn_blocking(move || start_host(&starter)).await
                    {
                        start_state
                            .tray_operation_active
                            .store(false, Ordering::SeqCst);
                        start_state.update(&start_app, status);
                    }
                });
            }
            tauri::async_runtime::spawn(async move {
                loop {
                    let mut status = runtime.observe().await;
                    if !status.host_ready
                        && (status.host_phase == "unknown" || status.host_phase == "stopped")
                    {
                        // Keep an actionable launch failure until there is new
                        // startup/readiness evidence, not merely an absent pipe.
                        if let Some(error) = state.snapshot().startup_error {
                            status.startup_error = Some(error);
                        }
                    }
                    state.update(&handle, status);
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            });
        }
        let background = std::env::args().any(|argument| argument == "--background");
        let status = app.state::<DesktopShellState>().snapshot();
        if !background || status.startup_error.is_some() {
            show_main_window(app.handle());
        }
    }
    #[cfg(not(target_os = "windows"))]
    show_main_window(app.handle());
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() == "main"
        && let WindowEvent::CloseRequested { api, .. } = event
        && !window
            .state::<DesktopShellState>()
            .exit_requested
            .load(Ordering::SeqCst)
    {
        api.prevent_close();
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn desktop_shell_status(state: tauri::State<'_, DesktopShellState>) -> DesktopShellStatus {
    state.snapshot()
}

#[tauri::command]
pub async fn start_desktop_host(
    app: AppHandle,
    state: tauri::State<'_, DesktopShellState>,
) -> Result<DesktopShellStatus, String> {
    #[cfg(target_os = "windows")]
    {
        let state = state.inner().clone();
        let runtime = state
            .runtime
            .clone()
            .ok_or_else(|| "Alu Dock is not ready on this computer. Run Setup.exe from the Windows package, then try again.".to_owned())?;
        state.manages_local_host.store(true, Ordering::SeqCst);
        let status = tauri::async_runtime::spawn_blocking(move || start_host(&runtime))
            .await
            .map_err(|error| format!("Alu Dock could not start: {error}"))?;
        Ok(state.update(&app, status))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(state.snapshot())
    }
}

#[cfg(target_os = "windows")]
pub fn set_login_start(
    app: AppHandle,
    state: &DesktopShellState,
    enabled: bool,
) -> Result<DesktopShellStatus, String> {
    use tauri_plugin_autostart::ManagerExt;

    {
        let launcher = app.autolaunch();
        if enabled {
            launcher.enable().map_err(|_| {
                "Windows could not enable login startup. Try again from Alu Dock.".to_owned()
            })?;
        } else {
            launcher.disable().map_err(|_| {
                "Windows could not disable login startup. Try again from Alu Dock.".to_owned()
            })?;
        }
        let mut status = state.snapshot();
        status.login_start_enabled = enabled;
        Ok(state.update(&app, status))
    }
}

#[tauri::command]
pub fn open_desktop_host_log(
    app: AppHandle,
    state: tauri::State<'_, DesktopShellState>,
) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_opener::OpenerExt;

        let path = state.snapshot().logs_path.ok_or_else(|| {
            "Alu Dock has not created a Host log yet. Try starting it first.".to_owned()
        })?;
        app.opener().open_path(path, None::<&str>).map_err(|_| {
            "Windows could not open the Alu Dock log. Try again from the file explorer.".to_owned()
        })
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        Err("Host logs are available from the Windows Desktop package.".into())
    }
}

#[tauri::command]
pub fn open_desktop_tui(state: tauri::State<'_, DesktopShellState>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let runtime = state
            .runtime
            .as_ref()
            .ok_or_else(|| "Alu Dock is not ready on this computer. Run Setup.exe from the Windows package, then try again.".to_owned())?;
        runtime.open_tui()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("The bundled terminal entry is available in the Windows package.".into())
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowsRuntime {
    root: std::path::PathBuf,
    launcher: std::path::PathBuf,
    logs_path: std::path::PathBuf,
}

#[cfg(target_os = "windows")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus {
    ready: bool,
    role: Option<String>,
    logs_path: Option<String>,
    #[serde(default)]
    sub_state: String,
    main_connected: Option<bool>,
    #[serde(default)]
    restoring_works: bool,
    #[serde(default)]
    unavailable_works: u64,
}

#[cfg(target_os = "windows")]
impl WindowsRuntime {
    fn discover() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|_| {
            "Alu Dock could not locate its Windows package. Run Setup.exe again.".to_owned()
        })?;
        let root = executable
            .parent()
            .ok_or_else(|| {
                "Alu Dock could not locate its Windows package. Run Setup.exe again.".to_owned()
            })?
            .to_path_buf();
        let launcher = match std::env::var_os("ALUDOCK_DESKTOP_LAUNCHER_PATH") {
            Some(path) => std::path::PathBuf::from(path),
            None => root.join("aludock.cmd"),
        };
        if !launcher.is_file() {
            return Err(
                "The Alu Dock command is missing. Run Setup.exe from the Windows package.".into(),
            );
        }
        Ok(Self {
            root,
            launcher,
            logs_path: windows_host_log_path()?,
        })
    }

    fn initial_status(&self) -> DesktopShellStatus {
        DesktopShellStatus {
            supported: true,
            host_ready: false,
            host_phase: "starting".into(),
            role: None,
            startup_error: None,
            logs_path: Some(self.logs_path.display().to_string()),
            login_start_enabled: false,
            ..Default::default()
        }
    }

    async fn observe(&self) -> DesktopShellStatus {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let observed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let mut pipe = tokio::net::windows::named_pipe::ClientOptions::new()
                .open(r"\\.\pipe\alu-dock-host-lifecycle")?;
            pipe.write_all(b"{\"action\":\"status\"}\n").await?;
            let mut line = String::new();
            BufReader::new(pipe).read_line(&mut line).await?;
            serde_json::from_str::<serde_json::Value>(&line).map_err(std::io::Error::other)
        })
        .await;
        let mut status = self.initial_status();
        match observed {
            Ok(Ok(value)) => {
                status.host_ready = value["ready"].as_bool().unwrap_or(false);
                status.host_phase = value["phase"]
                    .as_str()
                    .unwrap_or(if status.host_ready {
                        "ready"
                    } else {
                        "starting"
                    })
                    .into();
                status.role = value["role"].as_str().map(str::to_owned);
                status.main_connected = value["mainConnected"].as_bool();
                status.restoring_works = value["restoringWorks"].as_bool().unwrap_or(false);
                status.unavailable_works = value["unavailableWorks"].as_u64().unwrap_or(0);
            }
            _ => {
                let exited = windows_local_root()
                    .ok()
                    .and_then(|root| match std::fs::read(root.join("host-owner.json")) {
                        Ok(bytes) => Some(bytes),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            Some(br#"{"pid":0,"exited":true}"#.to_vec())
                        }
                        Err(_) => None,
                    })
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                    .is_some_and(|owner| {
                        match owner["pid"]
                            .as_u64()
                            .and_then(|pid| u32::try_from(pid).ok())
                        {
                            Some(0) => owner["exited"].as_bool() == Some(true),
                            Some(pid) => process_has_exited(pid),
                            None => false,
                        }
                    });
                status.host_phase = if exited { "stopped" } else { "unknown" }.into();
                if !exited {
                    status.startup_error = Some(
                        "暂时无法确认 Alu Dock 的状态。请查看日志或重新运行 Setup.exe。".into(),
                    );
                }
            }
        }
        status
    }

    fn command(&self, arguments: &[&str]) -> std::process::Command {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let command_line = format!(
            "\"\"{}\" {}\"",
            self.launcher.display(),
            arguments.join(" ")
        );
        let mut command = std::process::Command::new("cmd.exe");
        command
            .arg("/D")
            .arg("/S")
            .arg("/C")
            .raw_arg(command_line)
            .current_dir(&self.root)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        command
    }

    fn service(&self, action: &str) -> DesktopShellStatus {
        let result = self.command(&["service", action, "--json"]).output();
        match result {
            Ok(output) if output.status.success() => self
                .project_status(&output.stdout)
                .unwrap_or_else(|error| self.failure_status(error)),
            Ok(output) => self.failure_status(command_failure(&output)),
            Err(_) => {
                self.failure_status("Windows could not start Alu Dock. Run Setup.exe again.".into())
            }
        }
    }

    fn project_status(&self, stdout: &[u8]) -> Result<DesktopShellStatus, String> {
        let service = parse_service_status(stdout)?;
        Ok(DesktopShellStatus {
            supported: true,
            host_ready: service.ready,
            host_phase: if service.ready {
                "ready".into()
            } else {
                service.sub_state
            },
            role: service.role,
            main_connected: service.main_connected,
            restoring_works: service.restoring_works,
            unavailable_works: service.unavailable_works,
            startup_error: None,
            logs_path: service
                .logs_path
                .or_else(|| Some(self.logs_path.display().to_string())),
            login_start_enabled: false,
            auto_start_local_host: false,
        })
    }

    fn failure_status(&self, error: String) -> DesktopShellStatus {
        let mut status = self
            .command(&["service", "status", "--json"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| self.project_status(&output.stdout).ok())
            .unwrap_or_else(|| {
                failed_status(error.clone(), Some(self.logs_path.display().to_string()))
            });
        if !status.host_ready {
            status.startup_error = Some(error);
        }
        status
    }

    fn update_models(&self) -> Result<(), String> {
        let output = self
            .command(&["update", "model"])
            .output()
            .map_err(|_| "无法启动模型更新。请从 Alu Dock 终端重试。".to_owned())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(command_failure(&output))
        }
    }

    fn open_tui(&self) -> Result<(), String> {
        use std::os::windows::process::CommandExt;

        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new("cmd.exe")
            .arg("/D")
            .raw_arg(format!("/K \"{}\"", self.launcher.display()))
            .current_dir(&self.root)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|_| "Windows could not open the Alu Dock terminal. Try again from the package directory.".to_owned())
    }
}

#[cfg(target_os = "windows")]
fn windows_local_root() -> Result<std::path::PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
        "Alu Dock could not locate your local application directory. Run Setup.exe again."
            .to_owned()
    })?;
    Ok(std::path::PathBuf::from(local_app_data).join("Alu Dock"))
}

#[cfg(target_os = "windows")]
fn windows_host_log_path() -> Result<std::path::PathBuf, String> {
    Ok(windows_local_root()?.join("logs").join("host.log"))
}

#[cfg(target_os = "windows")]
fn start_host(runtime: &WindowsRuntime) -> DesktopShellStatus {
    runtime.service("start")
}

#[cfg(target_os = "windows")]
fn stop_host(runtime: &WindowsRuntime) -> DesktopShellStatus {
    runtime.service("stop")
}

#[cfg(target_os = "windows")]
fn failed_status(error: String, logs_path: Option<String>) -> DesktopShellStatus {
    DesktopShellStatus {
        supported: true,
        host_ready: false,
        host_phase: "unknown".into(),
        role: None,
        startup_error: Some(error),
        logs_path,
        login_start_enabled: false,
        ..Default::default()
    }
}

#[cfg(target_os = "windows")]
fn process_has_exited(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    // An exit-intent file is not proof that its process has finished cleanup.
    // Access denied/other failures stay unknown; a reused live PID is conservative.
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            return GetLastError() == ERROR_INVALID_PARAMETER;
        }
        let exited = WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
        CloseHandle(process);
        exited
    }
}

#[cfg(target_os = "windows")]
fn parse_service_status(stdout: &[u8]) -> Result<ServiceStatus, String> {
    let text = String::from_utf8_lossy(stdout);
    let line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "Alu Dock started without returning its readiness result. Open the Host log and try again.".to_owned())?;
    serde_json::from_str(line).map_err(|_| {
        "Alu Dock returned an unreadable readiness result. Open the Host log and try again."
            .to_owned()
    })
}

#[cfg(target_os = "windows")]
fn command_failure(output: &std::process::Output) -> String {
    let source = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let text = String::from_utf8_lossy(source);
    // --json invocations report failures as one machine-readable error line;
    // surface its human message instead of the raw JSON.
    let message = text
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find_map(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|message| message.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('{'))
                .collect::<Vec<_>>()
                .join(" ")
        });
    if message.is_empty() {
        return "Alu Dock did not finish the requested action. Open the Host log and try again."
            .into();
    }
    message.chars().take(2_000).collect()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "windows")]
struct DesktopTray {
    status: tauri::menu::MenuItem<tauri::Wry>,
    action: tauri::menu::MenuItem<tauri::Wry>,
}

#[cfg(target_os = "windows")]
fn update_tray(app: &AppHandle, status: &DesktopShellStatus) {
    let Some(items) = app.try_state::<DesktopTray>() else {
        return;
    };
    let mut text = match status.host_phase.as_str() {
        "ready" if status.role.as_deref() == Some("subhost") => match status.main_connected {
            Some(true) => "SubHost 运行中 · 已连接 Main",
            Some(false) => "SubHost 运行中 · 正在连接 Main",
            None => "SubHost 运行中 · Main 连接待确认",
        },
        "ready" => "本机 Dock：运行中",
        "starting" => "本机 Dock：正在启动…",
        "stopping" => "本机 Dock：正在停止…",
        "stopped" if status.startup_error.is_some() => "本机 Dock：启动失败",
        "stopped" => "本机 Dock：未启动",
        _ => "本机 Dock：状态暂未确认",
    }
    .to_owned();
    if status.host_ready {
        if status.restoring_works {
            text.push_str(" · 正在恢复工作");
        } else if status.unavailable_works > 0 {
            text.push_str(&format!(" · {} 项工作暂不可用", status.unavailable_works));
        }
    }
    let busy = app
        .state::<DesktopShellState>()
        .tray_operation_active
        .load(Ordering::SeqCst);
    let _ = items.status.set_text(&text);
    let action_text = match status.host_phase.as_str() {
        "ready" => "停止本机 Dock",
        "starting" => "正在启动…",
        "stopping" => "正在停止…",
        "stopped" if status.startup_error.is_some() => "重试启动本机 Dock",
        "stopped" => "启动本机 Dock",
        _ => "状态未确认，请查看日志",
    };
    let _ = items.action.set_text(action_text);
    let _ = items
        .action
        .set_enabled(!busy && matches!(status.host_phase.as_str(), "stopped" | "ready"));
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(text));
    }
}

#[cfg(target_os = "windows")]
fn create_tray(app: &mut App) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri_plugin_autostart::ManagerExt;

    let status = MenuItem::with_id(app, "host-status", "Alu Dock 正在启动", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "打开 Alu Dock", true, None::<&str>)?;
    let action = MenuItem::with_id(app, "host-action", "启动本机 Dock", true, None::<&str>)?;
    let auto_start = CheckMenuItem::with_id(
        app,
        "local-start",
        "随客户端启动本机 Dock",
        true,
        app.state::<DesktopShellState>()
            .snapshot()
            .auto_start_local_host,
        None::<&str>,
    )?;
    let update_models = MenuItem::with_id(app, "update-models", "更新模型", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "打开 Host 日志", true, None::<&str>)?;
    let terminal = MenuItem::with_id(app, "terminal", "打开终端设置", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "随 Windows 登录启动",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(app, "exit", "退出 Alu Dock", true, None::<&str>)?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &open,
            &first_separator,
            &action,
            &auto_start,
            &update_models,
            &logs,
            &terminal,
            &login,
            &second_separator,
            &exit,
        ],
    )?;
    app.manage(DesktopTray { status, action });
    let auto_start_for_event = auto_start.clone();
    let login_for_event = login.clone();
    let mut tray = TrayIconBuilder::with_id("main-tray");
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.tooltip("Alu Dock")
        .menu(&menu)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "host-action" => {
                let running = app.state::<DesktopShellState>().snapshot().host_ready;
                run_tray_service(app, !running, false);
            }
            "local-start" => {
                let enabled = auto_start_for_event.is_checked().unwrap_or(true);
                let runtime = app.state::<super::ConnectionRuntimeState>();
                let result = runtime.preferences.snapshot().and_then(|p| {
                    runtime
                        .preferences
                        .update_windows_start_local_host(p.revision, enabled)
                });
                match result {
                    Ok(_) => {
                        let state = app.state::<DesktopShellState>();
                        state
                            .status
                            .lock()
                            .expect("desktop shell status lock poisoned")
                            .auto_start_local_host = enabled;
                        let _ = app.emit("desktop-shell-changed", state.snapshot());
                    }
                    Err(_) => {
                        let _ = auto_start_for_event.set_checked(!enabled);
                        show_tray_notice(app, "设置未保存", "请重试。当前运行的工作不受影响。");
                    }
                }
            }
            "update-models" => run_tray_model_update(app),
            "logs" => {
                let state = app.state::<DesktopShellState>();
                let _ = open_desktop_host_log(app.clone(), state);
            }
            "terminal" => {
                let state = app.state::<DesktopShellState>();
                let _ = open_desktop_tui(state);
            }
            "login" => {
                let enabled = login_for_event.is_checked().unwrap_or(false);
                let state = app.state::<DesktopShellState>();
                if let Err(error) = set_login_start(app.clone(), state.inner(), enabled) {
                    let _ = login_for_event.set_checked(!enabled);
                    let mut status = state.snapshot();
                    status.startup_error = Some(error);
                    state.update(app, status);
                    show_main_window(app);
                }
            }
            "exit" => {
                let state = app.state::<DesktopShellState>();
                if state.manages_local_host.load(Ordering::SeqCst)
                    && (state.tray_operation_active.load(Ordering::SeqCst)
                        || state.snapshot().host_phase != "stopped")
                {
                    run_tray_service(app, false, true);
                } else {
                    state.exit_requested.store(true, Ordering::SeqCst);
                    app.exit(0);
                }
            }
            _ => {}
        })
        .build(app)?;
    update_tray(app.handle(), &app.state::<DesktopShellState>().snapshot());
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_tray_service(app: &AppHandle, start: bool, exit_after_stop: bool) {
    let app = app.clone();
    let state = app.state::<DesktopShellState>().inner().clone();
    if state.tray_operation_active.swap(true, Ordering::SeqCst) {
        show_tray_notice(&app, "Alu Dock 正在处理上一项操作", "完成后可以继续操作。");
        return;
    }
    if start && state.runtime.is_some() {
        state.manages_local_host.store(true, Ordering::SeqCst);
    }
    update_tray(&app, &state.snapshot());
    show_tray_notice(
        &app,
        if start {
            "正在启动 Alu Dock"
        } else {
            "正在停止 Alu Dock"
        },
        "完成后会在这里显示结果。",
    );
    std::thread::spawn(move || {
        let status = match &state.runtime {
            Some(runtime) if start => start_host(runtime),
            Some(runtime) => stop_host(runtime),
            None => failed_status(
                "Alu Dock is not ready on this computer. Run Setup.exe from the Windows package, then try again.".into(),
                windows_host_log_path().ok().map(|path| path.display().to_string()),
            ),
        };
        let complete = if start {
            status.host_ready
        } else {
            status.host_phase == "stopped"
        };
        let error = status.startup_error.clone();
        state.update(&app, status);
        state.tray_operation_active.store(false, Ordering::SeqCst);
        update_tray(&app, &state.snapshot());
        if let Some(error) = error {
            show_tray_notice(
                &app,
                if start {
                    "Alu Dock 启动未完成"
                } else {
                    "Alu Dock 停止未完成"
                },
                &error,
            );
            show_main_window(&app);
        } else if complete {
            if !start {
                state.manages_local_host.store(false, Ordering::SeqCst);
                if exit_after_stop {
                    state.exit_requested.store(true, Ordering::SeqCst);
                    app.exit(0);
                    return;
                }
            }
            show_tray_notice(
                &app,
                if start {
                    "Alu Dock 已启动"
                } else {
                    "Alu Dock 已停止"
                },
                if start {
                    "现在可以继续打开 Work。"
                } else {
                    "需要时可从托盘重新启动。"
                },
            );
        }
    });
}

#[cfg(target_os = "windows")]
fn run_tray_model_update(app: &AppHandle) {
    let app = app.clone();
    let state = app.state::<DesktopShellState>().inner().clone();
    if state.tray_operation_active.swap(true, Ordering::SeqCst) {
        show_tray_notice(&app, "Alu Dock 正在处理上一项操作", "完成后可以继续操作。");
        return;
    }
    update_tray(&app, &state.snapshot());
    show_tray_notice(
        &app,
        "正在更新模型列表",
        "Alu Dock 正在向 Pi 获取最新内容。",
    );
    std::thread::spawn(move || {
        let result = state
            .runtime
            .as_ref()
            .ok_or_else(|| {
                "Alu Dock 安装内容不可用。请重新运行完整 Windows 包中的 Setup.exe。".to_owned()
            })
            .and_then(WindowsRuntime::update_models);
        state.tray_operation_active.store(false, Ordering::SeqCst);
        update_tray(&app, &state.snapshot());
        match result {
            Ok(()) => show_tray_notice(
                &app,
                "模型列表已更新",
                "现有 Work 可使用 /reload 载入最新列表。",
            ),
            Err(error) => show_tray_notice(
                &app,
                "模型列表更新未完成",
                &format!("{error} 请打开终端运行 aludock update model 后重试。"),
            ),
        }
    });
}

#[cfg(target_os = "windows")]
fn show_tray_notice(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}
