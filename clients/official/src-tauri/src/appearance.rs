use crate::errors::CommandError;
use serde::Deserialize;

/// The page's color themes (`src/lib/theme.ts`). The page keeps the choice;
/// Android and Windows also keep a copy so their next start draws the window
/// in that theme before the page has loaded: Android its background and system
/// bars, Windows the light or dark of its title bar.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClientTheme {
    Classic,
    Dusk,
    Dawn,
}

impl ClientTheme {
    #[cfg_attr(not(any(target_os = "android", desktop)), allow(dead_code))]
    fn as_str(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::Dusk => "dusk",
            Self::Dawn => "dawn",
        }
    }

    /// A device that never chose, or whose copy is unreadable, uses the
    /// page's default (`DEFAULT_THEME` in `src/lib/theme.ts`).
    #[cfg(any(desktop, test))]
    fn from_saved(saved: &str) -> Self {
        [Self::Classic, Self::Dusk, Self::Dawn]
            .into_iter()
            .find(|theme| theme.as_str() == saved.trim())
            .unwrap_or(Self::Classic)
    }

    /// Dawn is the only light theme; the Windows title bar follows its light or dark.
    #[cfg(any(desktop, test))]
    fn window_theme(self) -> tauri::Theme {
        match self {
            Self::Dawn => tauri::Theme::Light,
            Self::Classic | Self::Dusk => tauri::Theme::Dark,
        }
    }
}

/// Windows' copy of the choice, read before the window first shows.
#[cfg(desktop)]
const TITLE_BAR_THEME_FILE: &str = "color-theme";

/// What `MainActivity.applyAppearance` reports; MainActivity.kt keeps the same numbers.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
const APPEARANCE_APPLIED: i32 = 0;
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
const APPEARANCE_WINDOW_FAILED: i32 = 1;
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
const APPEARANCE_SPLASH_FAILED: i32 = 2;

/// The page tells the person which part did not follow: the window and system
/// bars now, or only the splash screen of the next start.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
fn appearance_outcome(status: i32) -> Result<(), CommandError> {
    match status {
        APPEARANCE_APPLIED => Ok(()),
        APPEARANCE_SPLASH_FAILED => Err(appearance_error(
            "splash_theme_unavailable",
            "配色已经换好，只是下次打开时最先出现的启动画面可能还是原来的配色。",
        )),
        _ => Err(appearance_error(
            "appearance_unavailable",
            "状态栏和窗口底色没能跟着换配色。",
        )),
    }
}

#[cfg_attr(not(any(target_os = "android", desktop)), allow(dead_code))]
fn appearance_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

/// Matches the parts of the window the page cannot draw to its color theme:
/// Android's status and navigation bars, window background and next start's
/// splash screen.
#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn set_native_appearance(
    app: tauri::AppHandle,
    theme: ClientTheme,
) -> Result<(), CommandError> {
    appearance_outcome(apply_android_appearance(&app, theme).await)
}

/// Matches the Windows title bar's light or dark to the color theme, now and at
/// the next start. Not async, so it runs on the main thread in the order the
/// page chose: the last choice is the one shown and kept.
///
/// Other desktops keep following the system: there the call would set the
/// whole App's native look, and Linux puts the system's light or dark back
/// whenever the system changes.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn set_native_appearance(
    app: tauri::AppHandle,
    theme: ClientTheme,
) -> Result<(), CommandError> {
    if !cfg!(windows) {
        return Ok(());
    }
    apply_title_bar_theme(&app, theme)
}

#[cfg(not(any(target_os = "android", desktop)))]
#[tauri::command]
pub(crate) async fn set_native_appearance(
    app: tauri::AppHandle,
    theme: ClientTheme,
) -> Result<(), CommandError> {
    let _ = (app, theme);
    Ok(())
}

/// Gives the title bar the theme's light or dark and keeps a copy for the
/// next start. Windows hands WebView2 the same preference, so its own menus and
/// prompts follow too; the page declares its own color-scheme and does not
/// change. The page has switched either way; the error says which part did not
/// follow.
#[cfg(desktop)]
fn apply_title_bar_theme(app: &tauri::AppHandle, theme: ClientTheme) -> Result<(), CommandError> {
    use tauri::Manager;

    let shown = app
        .get_webview_window("main")
        .is_some_and(|window| window.set_theme(Some(theme.window_theme())).is_ok());
    let saved = save_title_bar_theme(app.path(), theme).is_ok();
    if !shown {
        return Err(appearance_error(
            "title_bar_unavailable",
            "窗口标题栏没能跟着换配色。",
        ));
    }
    if !saved {
        return Err(appearance_error(
            "title_bar_next_start_unavailable",
            "配色已经换好，只是下次打开时窗口标题栏一开始可能还是原来的深浅。",
        ));
    }
    Ok(())
}

/// Before the window first shows, gives its Windows title bar the light or dark
/// of the theme this device chose last; the page confirms it once loaded.
#[cfg(desktop)]
pub(crate) fn show_saved_title_bar_theme(app: &tauri::App) {
    use tauri::Manager;

    if !cfg!(windows) {
        return;
    }
    let theme = title_bar_theme_path(app.path())
        .and_then(std::fs::read_to_string)
        .map(|saved| ClientTheme::from_saved(&saved))
        .unwrap_or(ClientTheme::Classic);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_theme(Some(theme.window_theme()));
    }
}

#[cfg(desktop)]
fn save_title_bar_theme<R: tauri::Runtime>(
    paths: &tauri::path::PathResolver<R>,
    theme: ClientTheme,
) -> std::io::Result<()> {
    let path = title_bar_theme_path(paths)?;
    // Every page start confirms the theme; only a change is written.
    if std::fs::read_to_string(&path).is_ok_and(|saved| saved == theme.as_str()) {
        return Ok(());
    }
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    std::fs::write(path, theme.as_str())
}

#[cfg(desktop)]
fn title_bar_theme_path<R: tauri::Runtime>(
    paths: &tauri::path::PathResolver<R>,
) -> std::io::Result<std::path::PathBuf> {
    paths
        .app_local_data_dir()
        .map(|directory| directory.join(TITLE_BAR_THEME_FILE))
        .map_err(std::io::Error::other)
}

/// Runs `MainActivity.applyAppearance` on the UI thread and returns its status.
/// A call that cannot reach the activity counts as the window not following.
#[cfg(target_os = "android")]
async fn apply_android_appearance(app: &tauri::AppHandle, theme: ClientTheme) -> i32 {
    use jni::objects::{JObject, JValue};
    use tauri::Manager;

    let Some(webview) = app.get_webview_window("main") else {
        return APPEARANCE_WINDOW_FAILED;
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let dispatched = webview.with_webview(move |platform_webview| {
        platform_webview
            .jni_handle()
            .exec(move |env, activity, _webview| {
                let result = (|| -> jni::errors::Result<i32> {
                    let theme = JObject::from(env.new_string(theme.as_str())?);
                    env.call_method(
                        activity,
                        "applyAppearance",
                        "(Ljava/lang/String;)I",
                        &[JValue::Object(&theme)],
                    )?
                    .i()
                })();
                if result.is_err() && env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(result.unwrap_or(APPEARANCE_WINDOW_FAILED));
            });
    });
    if dispatched.is_err() {
        return APPEARANCE_WINDOW_FAILED;
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), receiver).await {
        Ok(Ok(status)) => status,
        _ => APPEARANCE_WINDOW_FAILED,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        APPEARANCE_APPLIED, APPEARANCE_SPLASH_FAILED, APPEARANCE_WINDOW_FAILED, ClientTheme,
        appearance_outcome,
    };

    #[test]
    fn a_saved_title_bar_theme_reads_back_and_anything_else_is_classic() {
        for theme in [ClientTheme::Classic, ClientTheme::Dusk, ClientTheme::Dawn] {
            assert_eq!(ClientTheme::from_saved(theme.as_str()), theme);
        }
        assert_eq!(ClientTheme::from_saved("dawn\n"), ClientTheme::Dawn);
        assert_eq!(ClientTheme::from_saved(""), ClientTheme::Classic);
        assert_eq!(ClientTheme::from_saved("sepia"), ClientTheme::Classic);
    }

    #[test]
    fn only_dawn_gives_the_windows_title_bar_its_light() {
        assert_eq!(ClientTheme::Dawn.window_theme(), tauri::Theme::Light);
        assert_eq!(ClientTheme::Dusk.window_theme(), tauri::Theme::Dark);
        assert_eq!(ClientTheme::Classic.window_theme(), tauri::Theme::Dark);
    }

    #[test]
    fn android_reports_which_part_of_the_theme_did_not_follow() {
        assert_eq!(
            (
                APPEARANCE_APPLIED,
                APPEARANCE_WINDOW_FAILED,
                APPEARANCE_SPLASH_FAILED
            ),
            (0, 1, 2),
            "MainActivity.applyAppearance reports these numbers"
        );
        assert!(appearance_outcome(APPEARANCE_APPLIED).is_ok());
        assert_eq!(
            appearance_outcome(APPEARANCE_WINDOW_FAILED)
                .unwrap_err()
                .code,
            "appearance_unavailable"
        );
        assert_eq!(
            appearance_outcome(APPEARANCE_SPLASH_FAILED)
                .unwrap_err()
                .code,
            "splash_theme_unavailable"
        );
        assert_eq!(
            appearance_outcome(7).unwrap_err().code,
            "appearance_unavailable"
        );
    }
}
