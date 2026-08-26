package moe.aruru.aludock.client

import android.content.res.Resources
import android.webkit.WebView
import androidx.core.graphics.Insets
import java.util.Locale

data class InsetsSnapshot(val systemBars: Insets, val imeBottom: Int)

/** Publishes Android window geometry as CSS variables instead of padding the WebView host. */
class WebViewInsetsStyleApplier(private val resources: Resources) {
  private var helperInjected = false

  fun reset() {
    helperInjected = false
  }

  fun apply(webView: WebView, snapshot: InsetsSnapshot) {
    if (!helperInjected) {
      webView.evaluateJavascript(INSTALL_HELPER_SCRIPT, null)
      helperInjected = true
    }
    webView.evaluateJavascript(buildApplyScript(snapshot), null)
  }

  private fun buildApplyScript(snapshot: InsetsSnapshot): String {
    val top = toCssPx(snapshot.systemBars.top)
    val right = toCssPx(snapshot.systemBars.right)
    val bottom = toCssPx(snapshot.systemBars.bottom)
    val left = toCssPx(snapshot.systemBars.left)
    val imeBottom = toCssPx(snapshot.imeBottom)
    return """
      (() => {
        const bridge = window.__ALUDOCK_ANDROID_INSETS__;
        if (!bridge || typeof bridge.apply !== 'function') {
          throw new Error('[AluDock] Android insets bridge unavailable.');
        }
        bridge.apply($top, $right, $bottom, $left, $imeBottom);
      })();
    """.trimIndent()
  }

  private fun toCssPx(value: Int): String =
    String.format(Locale.US, "%.4f", value / resources.displayMetrics.density)

  companion object {
    private val INSTALL_HELPER_SCRIPT =
      """
      (() => {
        if (window.__ALUDOCK_ANDROID_INSETS__?.apply) return;

        const state = {
          baseViewportHeight: '',
          insetTop: '',
          insetRight: '',
          insetBottom: '',
          insetLeft: '',
          imeBottom: '',
        };
        const setVar = (root, name, key, value) => {
          if (state[key] === value) return;
          state[key] = value;
          root.style.setProperty(name, value);
        };

        window.__ALUDOCK_ANDROID_INSETS__ = {
          apply(top, right, bottom, left, imeBottom) {
            const root = document.documentElement;
            if (!root) throw new Error('[AluDock] documentElement unavailable.');

            const viewportHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
            if (viewportHeight > 0 && imeBottom <= 0) {
              setVar(root, '--aludock-base-viewport-height', 'baseViewportHeight', viewportHeight.toFixed(2) + 'px');
            } else if (viewportHeight > 0 && !state.baseViewportHeight) {
              setVar(root, '--aludock-base-viewport-height', 'baseViewportHeight', viewportHeight.toFixed(2) + 'px');
            }

            setVar(root, '--aludock-inset-top', 'insetTop', Math.max(0, top).toFixed(2) + 'px');
            setVar(root, '--aludock-inset-right', 'insetRight', Math.max(0, right).toFixed(2) + 'px');
            setVar(root, '--aludock-inset-bottom', 'insetBottom', Math.max(0, bottom).toFixed(2) + 'px');
            setVar(root, '--aludock-inset-left', 'insetLeft', Math.max(0, left).toFixed(2) + 'px');
            setVar(root, '--aludock-ime-bottom', 'imeBottom', Math.max(0, imeBottom).toFixed(2) + 'px');
          },
        };
      })();
      """.trimIndent()
  }
}
