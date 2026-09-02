package moe.aruru.aludock.client

import android.webkit.WebView

/** Retries native-to-web setup across the initial about:blank -> app navigation. */
class WebViewReadinessPoller(
  private val webViewProvider: () -> WebView?,
  private val isDestroyed: () -> Boolean,
  private val maxAttempts: Int = DEFAULT_MAX_ATTEMPTS,
  private val retryDelayMs: Long = DEFAULT_RETRY_DELAY_MS,
) {
  fun pollUntilReady(
    readinessScript: String,
    onReady: () -> Unit,
    onFinished: () -> Unit,
    shouldContinue: () -> Boolean = { true },
    attempt: Int = 0,
  ) {
    val target = webViewProvider()
    if (target == null || isDestroyed() || !shouldContinue()) {
      onFinished()
      return
    }

    target.post {
      val active = webViewProvider()
      if (active == null || isDestroyed() || !shouldContinue()) {
        onFinished()
        return@post
      }

      active.evaluateJavascript(readinessScript) { value ->
        if (isDestroyed() || !shouldContinue()) {
          onFinished()
          return@evaluateJavascript
        }
        if (value == "true") {
          onReady()
          onFinished()
          return@evaluateJavascript
        }
        if (attempt >= maxAttempts) {
          onFinished()
          return@evaluateJavascript
        }
        active.postDelayed(
          {
            pollUntilReady(
              readinessScript,
              onReady,
              onFinished,
              shouldContinue,
              attempt + 1,
            )
          },
          retryDelayMs,
        )
      }
    }
  }

  companion object {
    const val DEFAULT_MAX_ATTEMPTS = 100
    const val DEFAULT_RETRY_DELAY_MS = 80L
  }
}
