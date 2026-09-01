#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{App, AppHandle, Manager};
#[cfg(target_os = "windows")]
use tauri::{Emitter, WindowEvent};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShellStatus {
    pub supported: bool,
    pub host_ready: bool,
    pub role: Option<String>,
    pub startup_error: Option<String>,
    pub logs_path: Option<String>,
    pub login_start_enabled: bool,
}

#[derive(Clone)]
pub struct DesktopShellState {
    status: Arc<Mutex<DesktopShellStatus>>,
    #[cfg(target_os = "windows")]
    exit_requested: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    runtime: Option<WindowsRuntime>,
}

impl DesktopShellState {
    pub fn initialize(app: &App) -> Self {
        #[cfg(target_os = "windows")]
        {
            use tauri_plugin_autostart::ManagerExt;

            let runtime = WindowsRuntime::discover();
            let mut status = match &runtime {
                Ok(runtime) => start_host(runtime),
                Err(error) => DesktopShellStatus {
                    supported: true,
                    host_ready: false,
                    role: None,
                    startup_error: Some(error.clone()),
                    logs_path: windows_host_log_path()
                        .ok()
                        .map(|path| path.display().to_string()),
                    login_start_enabled: false,
                },
            };
            status.login_start_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            return Self {
                status: Arc::new(Mutex::new(status)),
                exit_requested: Arc::new(AtomicBool::new(false)),
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
                    role: None,
                    startup_error: None,
                    logs_path: None,
                    login_start_enabled: false,
                })),
            }
        }
    }

    pub fn prefer_local_connection(&self) -> bool {
        let status = self
            .status
            .lock()
            .expect("desktop shell status lock poisoned");
        status.host_ready && status.role.as_deref() == Some("main")
    }

    pub fn snapshot(&self) -> DesktopShellStatus {
        self.status
            .lock()
            .expect("desktop shell status lock poisoned")
            .clone()
    }

    #[cfg(target_os = "windows")]
    fn update(&self, app: &AppHandle, mut status: DesktopShellStatus) -> DesktopShellStatus {
        let mut current = self
            .status
            .lock()
            .expect("desktop shell status lock poisoned");
        status.login_start_enabled = current.login_start_enabled;
        *current = status.clone();
        drop(current);
        let _ = app.emit("desktop-shell-changed", status.clone());
        status
    }
}

pub fn finish_setup(app: &mut App) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    {
        create_tray(app)?;
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
            .ok_or_else(|| "Alu Dock runtime is unavailable. Run Setup.cmd from the Windows package, then try again.".to_owned())?;
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
            .ok_or_else(|| "Alu Dock runtime is unavailable. Run Setup.cmd from the Windows package, then try again.".to_owned())?;
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
    node: std::path::PathBuf,
    cli: std::path::PathBuf,
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
}

#[cfg(target_os = "windows")]
impl WindowsRuntime {
    fn discover() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|_| {
            "Alu Dock could not locate its Windows package. Run Setup.cmd again.".to_owned()
        })?;
        let root = executable
            .parent()
            .ok_or_else(|| {
                "Alu Dock could not locate its Windows package. Run Setup.cmd again.".to_owned()
            })?
            .to_path_buf();
        let developer_node =
            std::env::var_os("ALUDOCK_DESKTOP_NODE_PATH").map(std::path::PathBuf::from);
        let developer_cli =
            std::env::var_os("ALUDOCK_DESKTOP_CLI_PATH").map(std::path::PathBuf::from);
        let developer_launcher =
            std::env::var_os("ALUDOCK_DESKTOP_LAUNCHER_PATH").map(std::path::PathBuf::from);
        let (node, cli, launcher) = match (developer_node, developer_cli, developer_launcher) {
            (Some(node), Some(cli), Some(launcher)) => (node, cli, launcher),
            (None, None, None) => {
                require_installed_root(&root)?;
                (
                    root.join("runtime").join("node.exe"),
                    root.join("dock").join("dist").join("src").join("cli.js"),
                    root.join("aludock.cmd"),
                )
            }
            _ => return Err("Alu Dock developer runtime overrides must provide Node, Dock, and terminal paths together.".into()),
        };
        for (path, label) in [
            (&node, "Node runtime"),
            (&cli, "Dock runtime"),
            (&launcher, "terminal entry"),
        ] {
            if !path.is_file() {
                return Err(format!(
                    "The Alu Dock {label} is missing. Run Setup.cmd from a complete Windows package."
                ));
            }
        }
        Ok(Self {
            root,
            node,
            cli,
            launcher,
            logs_path: windows_host_log_path()?,
        })
    }

    fn command(&self, arguments: &[&str]) -> std::process::Command {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = std::process::Command::new(&self.node);
        command
            .arg(&self.cli)
            .args(arguments)
            .current_dir(&self.root)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let runtime_directory = self.node.parent().unwrap_or(&self.root);
        let inherited_path = std::env::var_os("PATH").unwrap_or_default();
        let path = std::iter::once(runtime_directory.to_path_buf())
            .chain(std::env::split_paths(&inherited_path));
        if let Ok(path) = std::env::join_paths(path) {
            command.env("PATH", path);
        }
        command
    }

    fn service(&self, action: &str) -> DesktopShellStatus {
        let result = self.command(&["service", action, "--json"]).output();
        match result {
            Ok(output) if output.status.success() => self
                .project_status(&output.stdout)
                .unwrap_or_else(|error| self.failure_status(error)),
            Ok(output) => self.failure_status(command_failure(&output)),
            Err(_) => self.failure_status(
                "Windows could not start the bundled Alu Dock runtime. Run Setup.cmd again.".into(),
            ),
        }
    }

    fn project_status(&self, stdout: &[u8]) -> Result<DesktopShellStatus, String> {
        let service = parse_service_status(stdout)?;
        Ok(DesktopShellStatus {
            supported: true,
            host_ready: service.ready,
            role: service.role,
            startup_error: None,
            logs_path: service
                .logs_path
                .or_else(|| Some(self.logs_path.display().to_string())),
            login_start_enabled: false,
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
        status.startup_error = Some(error);
        status
    }

    fn open_tui(&self) -> Result<(), String> {
        use std::os::windows::process::CommandExt;

        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new("cmd.exe")
            .arg("/D")
            .arg("/K")
            .arg(format!("\"{}\"", self.launcher.display()))
            .current_dir(&self.root)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|_| "Windows could not open the Alu Dock terminal. Try again from the package directory.".to_owned())
    }
}

#[cfg(target_os = "windows")]
fn require_installed_root(root: &std::path::Path) -> Result<(), String> {
    let installed = windows_local_root()?.join("app");
    let actual = std::fs::canonicalize(root).ok();
    let expected = std::fs::canonicalize(&installed).ok();
    if actual.is_none() || actual != expected {
        return Err(
            "Run Setup.cmd from the complete Windows package before opening AluDock.exe.".into(),
        );
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_local_root() -> Result<std::path::PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
        "Alu Dock could not locate your local application directory. Run Setup.cmd again."
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
        role: None,
        startup_error: Some(error),
        logs_path,
        login_start_enabled: false,
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
fn create_tray(app: &mut App) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri_plugin_autostart::ManagerExt;

    let open = MenuItem::with_id(app, "open", "打开 Alu Dock", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "启动 Alu Dock", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止 Alu Dock", true, None::<&str>)?;
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
    let exit = MenuItem::with_id(app, "exit", "退出 Desktop", true, None::<&str>)?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &first_separator,
            &start,
            &stop,
            &logs,
            &terminal,
            &login,
            &second_separator,
            &exit,
        ],
    )?;
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
            "start" => run_tray_service(app, true),
            "stop" => run_tray_service(app, false),
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
                app.state::<DesktopShellState>()
                    .exit_requested
                    .store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_tray_service(app: &AppHandle, start: bool) {
    let app = app.clone();
    let state = app.state::<DesktopShellState>().inner().clone();
    std::thread::spawn(move || {
        let status = match &state.runtime {
            Some(runtime) if start => start_host(runtime),
            Some(runtime) => stop_host(runtime),
            None => failed_status(
                "Alu Dock runtime is unavailable. Run Setup.cmd from the Windows package, then try again.".into(),
                windows_host_log_path().ok().map(|path| path.display().to_string()),
            ),
        };
        let has_error = status.startup_error.is_some();
        state.update(&app, status);
        if has_error {
            show_main_window(&app);
        }
    });
}
