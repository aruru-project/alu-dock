package moe.aruru.aludock.client

import android.content.Context

/**
 * The page's color themes (src/lib/theme.ts). The page keeps the choice; this
 * copy lets the next start open its window and system bars in that theme before
 * the page has loaded. Backgrounds match --alu-bg in src/styles/tokens.css.
 */
enum class ClientAppearance(
  val id: String,
  val styleRes: Int,
  val backgroundRes: Int,
  /** Light backgrounds need dark status and navigation bar icons. */
  val lightBars: Boolean,
) {
  CLASSIC("classic", R.style.Theme_aludock_client_app, R.color.aludock_background, false),
  DUSK("dusk", R.style.Theme_aludock_client_app_Dusk, R.color.aludock_background_dusk, false),
  DAWN("dawn", R.style.Theme_aludock_client_app_Dawn, R.color.aludock_background_dawn, true);

  companion object {
    private const val PREFERENCES = "aludock_appearance"
    private const val THEME_KEY = "theme"

    fun fromId(id: String?): ClientAppearance = values().firstOrNull { it.id == id } ?: CLASSIC

    fun load(context: Context): ClientAppearance =
      fromId(context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(THEME_KEY, null))

    fun save(context: Context, appearance: ClientAppearance) {
      context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .edit()
        .putString(THEME_KEY, appearance.id)
        .apply()
    }
  }
}
