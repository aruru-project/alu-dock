package moe.aruru.aludock.client

import android.content.res.Resources
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.webkit.WebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** Keeps visible system bars and IME geometry in one native-to-CSS layout contract. */
class AndroidInsetsBridge(
  private val window: Window,
  private val resources: Resources,
  private val contentRootProvider: () -> View?,
  private val webViewProvider: () -> WebView?,
  private val isDestroyed: () -> Boolean,
  private val mainHandler: Handler,
  private val readinessPoller: WebViewReadinessPoller,
) {
  private var systemBarInsets: Insets = Insets.NONE
  private var imeBottomInset = 0
  private var lastSnapshot: InsetsSnapshot? = null
  private var pushScheduled = false
  private var forcePending = false
  private var pageReady = false
  private var syncScheduled = false
  private var syncPending = false
  private var listenerAttached = false
  private val styleApplier by lazy { WebViewInsetsStyleApplier(resources) }

  fun onCreate() {
    configureSystemBars()
    attachListenerIfNeeded()
    requestInsets()
    scheduleSyncWhenReady()
  }

  fun onWebViewAvailable() {
    resetInjection()
    refresh()
  }

  fun onConfigurationChanged() {
    configureSystemBars()
    resetInjection()
    refresh()
  }

  fun onResume() {
    configureSystemBars()
    refresh()
  }

  private fun refresh() {
    attachListenerIfNeeded()
    requestInsets()
    scheduleSyncWhenReady()
  }

  private fun resetInjection() {
    lastSnapshot = null
    forcePending = false
    pageReady = false
    styleApplier.reset()
  }

  @Suppress("DEPRECATION")
  private fun configureSystemBars() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }

    WindowInsetsControllerCompat(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      show(WindowInsetsCompat.Type.systemBars())
    }
  }

  private fun attachListenerIfNeeded() {
    if (listenerAttached) return
    val contentRoot = contentRootProvider() ?: return
    ViewCompat.setOnApplyWindowInsetsListener(contentRoot) { _, insets ->
      val systemTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val visible = insets.getInsets(systemTypes)
      val stable = insets.getInsetsIgnoringVisibility(systemTypes)
      systemBarInsets = Insets.of(
        maxOf(visible.left, stable.left),
        maxOf(visible.top, stable.top),
        maxOf(visible.right, stable.right),
        maxOf(visible.bottom, stable.bottom),
      )

      val imeType = WindowInsetsCompat.Type.ime()
      imeBottomInset = if (insets.isVisible(imeType)) insets.getInsets(imeType).bottom else 0
      push(force = false)

      // The web shell consumes IME through --aludock-ime-bottom. Prevent WebView
      // from also shrinking its viewport, which would apply the keyboard twice.
      WindowInsetsCompat.Builder(insets)
        .setInsets(imeType, Insets.NONE)
        .setVisible(imeType, false)
        .build()
    }
    listenerAttached = true
  }

  private fun requestInsets() {
    contentRootProvider()?.let(ViewCompat::requestApplyInsets)
  }

  private fun push(force: Boolean) {
    if (isDestroyed()) return
    val target = webViewProvider() ?: return
    forcePending = forcePending || force
    if (pushScheduled) return
    pushScheduled = true

    target.post {
      pushScheduled = false
      val active = webViewProvider() ?: return@post
      val snapshot = InsetsSnapshot(systemBarInsets, imeBottomInset)
      val shouldForce = forcePending
      forcePending = false
      if (!pageReady && !shouldForce) return@post
      if (!shouldForce && snapshot == lastSnapshot) return@post
      styleApplier.apply(active, snapshot)
      lastSnapshot = snapshot
      if (shouldForce) pageReady = true
    }
  }

  private fun scheduleSyncWhenReady() {
    if (webViewProvider() == null) return
    if (syncScheduled) {
      syncPending = true
      return
    }
    syncScheduled = true
    syncPending = false
    readinessPoller.pollUntilReady(
      readinessScript = PAGE_READY_SCRIPT,
      onReady = { push(force = true) },
      onFinished = {
        syncScheduled = false
        if (syncPending) {
          syncPending = false
          scheduleSyncWhenReady()
        } else if (!pageReady) {
          mainHandler.postDelayed(
            { if (!isDestroyed()) scheduleSyncWhenReady() },
            WebViewReadinessPoller.DEFAULT_RETRY_DELAY_MS,
          )
        }
      },
    )
  }

  companion object {
    private val PAGE_READY_SCRIPT =
      """
      (() => location.href !== 'about:blank' && Boolean(document.getElementById('app')))();
      """.trimIndent()
  }
}
