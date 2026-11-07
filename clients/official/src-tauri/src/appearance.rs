use crate::errors::CommandError;
use serde::Deserialize;

/// The page's color themes (`src/lib/theme.ts`). The page keeps the choice;
/// Android also keeps a copy so its next start draws the window and the
/// system bars in that theme before the page has loaded.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClientTheme {
    Classic,
    Dusk,
    Dawn,
}

impl ClientTheme {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    fn as_str(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::Dusk => "dusk",
            Self::Dawn => "dawn",
        }
    }
}

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

#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
fn appearance_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

/// Matches Android's status and navigation bars, its window background and
/// the next start's splash screen to the page's color theme. Desktop windows
/// have nothing to match.
#[tauri::command]
pub(crate) async fn set_native_appearance(
    app: tauri::AppHandle,
    theme: ClientTheme,
) -> Result<(), CommandError> {
    #[cfg(target_os = "android")]
    {
        appearance_outcome(apply_android_appearance(&app, theme).await)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, theme);
        Ok(())
    }
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
    use super::appearance_outcome;

    #[test]
    fn android_reports_which_part_of_the_theme_did_not_follow() {
        assert!(appearance_outcome(0).is_ok());
        assert_eq!(
            appearance_outcome(1).unwrap_err().code,
            "appearance_unavailable"
        );
        assert_eq!(
            appearance_outcome(2).unwrap_err().code,
            "splash_theme_unavailable"
        );
        assert_eq!(
            appearance_outcome(7).unwrap_err().code,
            "appearance_unavailable"
        );
    }
}
