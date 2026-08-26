package moe.aruru.aludock.client

import android.app.Activity
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject

object AndroidPickedFileBridge {
  @JvmStatic
  fun describe(activity: Activity, uriText: String): String {
    val uri = Uri.parse(uriText)
    val resolver = activity.contentResolver
    var displayName: String? = null

    resolver.query(
      uri,
      arrayOf(OpenableColumns.DISPLAY_NAME),
      null,
      null,
      null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (nameColumn >= 0 && !cursor.isNull(nameColumn)) {
          displayName = cursor.getString(nameColumn)
        }
      }
    }

    return JSONObject()
      .put("name", displayName)
      .put("mediaType", resolver.getType(uri))
      .toString()
  }
}
