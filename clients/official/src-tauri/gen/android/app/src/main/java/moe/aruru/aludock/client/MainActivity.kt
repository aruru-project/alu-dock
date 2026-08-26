package moe.aruru.aludock.client

import android.graphics.Color
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
  private val mainHandler = Handler(Looper.getMainLooper())
  private val readinessPoller by lazy {
    WebViewReadinessPoller(webViewProvider = { webView }, isDestroyed = { destroyed })
  }
  private val insetsBridge by lazy {
    AndroidInsetsBridge(
      window = window,
      resources = resources,
      contentRootProvider = { window.decorView.findViewById(android.R.id.content) },
      webViewProvider = { webView },
      isDestroyed = { destroyed },
      mainHandler = mainHandler,
      readinessPoller = readinessPoller,
    )
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val transparent = Color.TRANSPARENT
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(transparent),
      navigationBarStyle = SystemBarStyle.dark(transparent),
    )
    super.onCreate(savedInstanceState)
    insetsBridge.onCreate()
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.setBackgroundColor(getColor(R.color.aludock_background))
    this.webView = webView
    insetsBridge.onWebViewAvailable()
  }

  @Keep
  fun describePickedFile(uriText: String): String =
    AndroidPickedFileBridge.describe(this, uriText)

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    insetsBridge.onConfigurationChanged()
  }

  override fun onResume() {
    super.onResume()
    insetsBridge.onResume()
  }

  override fun onDestroy() {
    destroyed = true
    mainHandler.removeCallbacksAndMessages(null)
    webView = null
    super.onDestroy()
  }
}
