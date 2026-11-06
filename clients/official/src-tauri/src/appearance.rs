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

/// Matches Android's status and navigation bars and its window background to
/// the page's color theme. Desktop windows have nothing to match.
#[tauri::command]
pub(crate) async fn set_native_appearance(
    app: tauri::AppHandle,
    theme: ClientTheme,
) -> Result<(), CommandError> {
    #[cfg(target_os = "android")]
    {
        apply_android_appearance(&app, theme).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, theme);
        Ok(())
    }
}

#[cfg(target_os = "android")]
async fn apply_android_appearance(
    app: &tauri::AppHandle,
    theme: ClientTheme,
) -> Result<(), CommandError> {
    use jni::objects::{JObject, JValue};
    use tauri::Manager;

    let webview = app
        .get_webview_window("main")
        .ok_or_else(appearance_unavailable)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            platform_webview
                .jni_handle()
                .exec(move |env, activity, _webview| {
                    let result = (|| -> jni::errors::Result<()> {
                        let theme = JObject::from(env.new_string(theme.as_str())?);
                        env.call_method(
                            activity,
                            "applyAppearance",
                            "(Ljava/lang/String;)V",
                            &[JValue::Object(&theme)],
                        )?;
                        Ok(())
                    })();
                    if result.is_err() && env.exception_check().unwrap_or(false) {
                        let _ = env.exception_clear();
                    }
                    let _ = sender.send(result.is_ok());
                });
        })
        .map_err(|_| appearance_unavailable())?;
    match tokio::time::timeout(std::time::Duration::from_secs(5), receiver).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err(appearance_unavailable()),
    }
}

#[cfg(target_os = "android")]
fn appearance_unavailable() -> CommandError {
    CommandError {
        code: "appearance_unavailable".into(),
        message: "状态栏没能跟着换配色，重新打开客户端后会恢复一致。".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}
