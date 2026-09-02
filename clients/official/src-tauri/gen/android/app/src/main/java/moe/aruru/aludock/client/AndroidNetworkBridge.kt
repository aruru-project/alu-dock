package moe.aruru.aludock.client

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.webkit.WebView

/** Notifies the web shell when Android's usable default route changes. */
class AndroidNetworkBridge(
  context: Context,
  private val webViewProvider: () -> WebView?,
  private val isDestroyed: () -> Boolean,
  private val mainHandler: Handler,
  private val readinessPoller: WebViewReadinessPoller,
) {
  private val connectivityManager =
    context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private var registered = false
  private var resumed = false
  private var dispatchScheduled = false
  private var observedSnapshot: NetworkSnapshot? = null
  private var deliveredSnapshot: NetworkSnapshot? = null
  private val observeRunnable = Runnable { observeCurrentNetwork() }
  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = scheduleObservation()
    override fun onLost(network: Network) = scheduleObservation()
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
      scheduleObservation()
    override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) =
      scheduleObservation()
  }

  fun onCreate() {
    val initial = currentSnapshot()
    observedSnapshot = initial
    deliveredSnapshot = initial
  }

  fun onWebViewAvailable() {
    dispatchIfNeeded()
  }

  fun onResume() {
    resumed = true
    registerCallback()
    mainHandler.removeCallbacks(observeRunnable)
    observeCurrentNetwork()
  }

  fun onPause() {
    resumed = false
    mainHandler.removeCallbacks(observeRunnable)
    unregisterCallback()
  }

  fun onDestroy() {
    resumed = false
    mainHandler.removeCallbacks(observeRunnable)
    unregisterCallback()
  }

  private fun registerCallback() {
    if (registered) return
    connectivityManager.registerDefaultNetworkCallback(callback)
    registered = true
  }

  private fun unregisterCallback() {
    if (!registered) return
    connectivityManager.unregisterNetworkCallback(callback)
    registered = false
  }

  private fun scheduleObservation() {
    mainHandler.removeCallbacks(observeRunnable)
    mainHandler.postDelayed(observeRunnable, NETWORK_SETTLE_DELAY_MS)
  }

  private fun observeCurrentNetwork() {
    if (isDestroyed()) return
    val current = currentSnapshot()
    if (current != observedSnapshot) observedSnapshot = current
    dispatchIfNeeded()
  }

  private fun dispatchIfNeeded() {
    if (isDestroyed() || !resumed || dispatchScheduled) return
    val observed = observedSnapshot ?: return
    if (observed == deliveredSnapshot || webViewProvider() == null) return
    dispatchScheduled = true
    readinessPoller.pollUntilReady(
      readinessScript = PAGE_READY_SCRIPT,
      onReady = {
        if (isDestroyed() || !resumed) return@pollUntilReady
        val delivered = observedSnapshot ?: return@pollUntilReady
        webViewProvider()?.evaluateJavascript(DISPATCH_SCRIPT, null)
        deliveredSnapshot = delivered
      },
      onFinished = { dispatchScheduled = false },
      shouldContinue = { resumed && !isDestroyed() },
    )
  }

  private fun currentSnapshot(): NetworkSnapshot {
    val network = connectivityManager.activeNetwork
      ?: return NetworkSnapshot(null, emptyList(), false, false, null, emptyList(), emptyList())
    val capabilities = connectivityManager.getNetworkCapabilities(network)
    val properties = connectivityManager.getLinkProperties(network)
    val transports = listOf(
      NetworkCapabilities.TRANSPORT_WIFI,
      NetworkCapabilities.TRANSPORT_CELLULAR,
      NetworkCapabilities.TRANSPORT_VPN,
      NetworkCapabilities.TRANSPORT_ETHERNET,
      NetworkCapabilities.TRANSPORT_BLUETOOTH,
    ).filter { capabilities?.hasTransport(it) == true }
    return NetworkSnapshot(
      networkId = network.toString(),
      transports = transports,
      hasInternet = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
      validated = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
      interfaceName = properties?.interfaceName,
      addresses = properties?.linkAddresses?.map { it.toString() }?.sorted().orEmpty(),
      routes = properties?.routes?.map { it.toString() }?.sorted().orEmpty(),
    )
  }

  private data class NetworkSnapshot(
    val networkId: String?,
    val transports: List<Int>,
    val hasInternet: Boolean,
    val validated: Boolean,
    val interfaceName: String?,
    val addresses: List<String>,
    val routes: List<String>,
  )

  companion object {
    private const val NETWORK_SETTLE_DELAY_MS = 350L
    private const val DISPATCH_SCRIPT =
      "window.dispatchEvent(new Event('aludock:network-changed'));"
    private const val PAGE_READY_SCRIPT =
      "document.documentElement.dataset.aludockNetworkReady === 'true';"
  }
}
