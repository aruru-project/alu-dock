package moe.aruru.aludock.client

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.annotation.Keep
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var destroyed = false
  private var appearance = ClientAppearance.CLASSIC
  private val mainHandler = Handler(Looper.getMainLooper())
  private val readinessPoller by lazy {
    WebViewReadinessPoller(webViewProvider = { webView }, isDestroyed = { destroyed })
  }
  private val networkBridge by lazy {
    AndroidNetworkBridge(
      context = this,
      webViewProvider = { webView },
      isDestroyed = { destroyed },
      mainHandler = mainHandler,
      readinessPoller = readinessPoller,
    )
  }
  private val insetsBridge by lazy {
    AndroidInsetsBridge(
      window = window,
      resources = resources,
      contentRootProvider = { window.decorView.findViewById(android.R.id.content) },
      webViewProvider = { webView },
      lightBarsProvider = { appearance.lightBars },
      isDestroyed = { destroyed },
      mainHandler = mainHandler,
      readinessPoller = readinessPoller,
    )
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // The window takes its background from the theme, so pick it before anything draws.
    appearance = ClientAppearance.load(this)
    setTheme(appearance.styleRes)
    val transparent = Color.TRANSPARENT
    val barStyle = if (appearance.lightBars) {
      SystemBarStyle.light(transparent, LEGACY_DARK_SCRIM)
    } else {
      SystemBarStyle.dark(transparent)
    }
    enableEdgeToEdge(statusBarStyle = barStyle, navigationBarStyle = barStyle)
    super.onCreate(savedInstanceState)
    networkBridge.onCreate()
    insetsBridge.onCreate()
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.setBackgroundColor(getColor(appearance.backgroundRes))
    this.webView = webView
    networkBridge.onWebViewAvailable()
    insetsBridge.onWebViewAvailable()
  }

  @Keep
  fun describePickedFile(uriText: String): String =
    AndroidPickedFileBridge.describe(this, uriText)

  /**
   * Called from Rust when the page shows a color theme: at every start, on a switch and on a retry.
   * Reports which part could not follow, so the page can say so: the window and system bars now, or
   * (Android 13+) the splash screen of the next start.
   */
  @Keep
  fun applyAppearance(themeId: String): Int {
    val next = ClientAppearance.fromId(themeId)
    if (ClientAppearance.load(this) != next) ClientAppearance.save(this, next)
    var windowFollowed = true
    if (!destroyed) {
      try {
        appearance = next
        val background = getColor(next.backgroundRes)
        window.setBackgroundDrawable(ColorDrawable(background))
        webView?.setBackgroundColor(background)
        insetsBridge.onAppearanceChanged()
      } catch (_: Exception) {
        windowFollowed = false
      }
    }
    // Android 13+ draws the next cold start's splash screen from this theme. Set it on every call so a
    // failed attempt is tried again on a retry and at the next start.
    var splashFollowed = true
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      try {
        splashScreen.setSplashScreenTheme(next.styleRes)
      } catch (_: Exception) {
        splashFollowed = false
      }
    }
    return when {
      !windowFollowed -> APPEARANCE_WINDOW_FAILED
      !splashFollowed -> APPEARANCE_SPLASH_FAILED
      else -> APPEARANCE_APPLIED
    }
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    insetsBridge.onConfigurationChanged()
  }

  override fun onResume() {
    super.onResume()
    networkBridge.onResume()
    insetsBridge.onResume()
  }

  override fun onPause() {
    networkBridge.onPause()
    super.onPause()
  }

  override fun onDestroy() {
    networkBridge.onDestroy()
    destroyed = true
    mainHandler.removeCallbacksAndMessages(null)
    webView = null
    super.onDestroy()
  }

  companion object {
    /** What applyAppearance reports; src-tauri/src/appearance.rs reads the same numbers. */
    const val APPEARANCE_APPLIED = 0
    const val APPEARANCE_WINDOW_FAILED = 1
    const val APPEARANCE_SPLASH_FAILED = 2

    /** Behind white navigation icons on Android 7, which cannot draw them dark. */
    val LEGACY_DARK_SCRIM: Int = Color.argb(0x80, 0x1b, 0x1b, 0x1b)
  }
}
