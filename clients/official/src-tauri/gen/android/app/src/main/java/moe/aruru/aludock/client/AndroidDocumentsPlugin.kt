package moe.aruru.aludock.client

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class DocumentUriArgs {
  lateinit var uri: String
  var mediaType: String? = null
}

@InvokeArg
class SaveDocumentArgs {
  lateinit var name: String
}

@TauriPlugin
class AndroidDocumentsPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun pickRecentFiles(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    startActivityForResult(invoke, intent, "pickRecentFilesResult")
  }

  @ActivityCallback
  fun pickRecentFilesResult(invoke: Invoke, result: androidx.activity.result.ActivityResult) {
    val response = JSObject()
    if (result.resultCode != Activity.RESULT_OK || result.data == null) {
      response.put("files", JSArray())
      invoke.resolve(response)
      return
    }

    val data = result.data!!
    val uris = mutableListOf<String>()
    data.data?.let { uris.add(it.toString()) }
    data.clipData?.let { clip ->
      for (index in 0 until clip.itemCount) {
        uris.add(clip.getItemAt(index).uri.toString())
      }
    }
    response.put("files", JSArray.from(uris.distinct().toTypedArray()))
    invoke.resolve(response)
  }

  @Command
  fun saveDocument(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SaveDocumentArgs::class.java)
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = MimeTypeMap.getSingleton()
          .getMimeTypeFromExtension(args.name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
        putExtra(Intent.EXTRA_TITLE, args.name)
      }
      startActivityForResult(invoke, intent, "saveDocumentResult")
    } catch (_: Exception) {
      invoke.reject("无法打开保存位置选择器，请重试。")
    }
  }

  @ActivityCallback
  fun saveDocumentResult(invoke: Invoke, result: androidx.activity.result.ActivityResult) {
    // Only the user's Back/Cancel action is cancellation. Native failures must reach the UI.
    when (result.resultCode) {
      Activity.RESULT_CANCELED -> invoke.resolve(JSObject().put("status", "cancelled"))
      Activity.RESULT_OK -> {
        val uri = result.data?.data
        if (uri == null) {
          invoke.reject("未取得保存位置，请重新选择。")
        } else {
          invoke.resolve(JSObject().put("status", "selected").put("file", uri.toString()))
        }
      }
      else -> invoke.reject("无法选择保存位置，请重试。")
    }
  }

  @Command
  fun retainDocumentAccess(invoke: Invoke) {
    val args = invoke.parseArgs(DocumentUriArgs::class.java)
    val response = JSObject()
    val retained = try {
      val uri = Uri.parse(args.uri)
      if (uri.scheme != "content") {
        false
      } else {
        activity.contentResolver.takePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        true
      }
    } catch (_: Exception) {
      false
    }
    response.put("retained", retained)
    invoke.resolve(response)
  }

  @Command
  fun openDocument(invoke: Invoke) {
    val args = invoke.parseArgs(DocumentUriArgs::class.java)
    val response = JSObject()
    val uri = Uri.parse(args.uri)
    if (uri.scheme != "content") {
      response.put("outcome", "unavailable")
      invoke.resolve(response)
      return
    }

    val resolver = activity.contentResolver
    val readable = try {
      resolver.openFileDescriptor(uri, "r")?.use { true } ?: false
    } catch (_: Exception) {
      false
    }
    if (!readable) {
      response.put("outcome", "unavailable")
      invoke.resolve(response)
      return
    }

    val mediaType = resolver.getType(uri) ?: args.mediaType ?: "*/*"
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, mediaType)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      clipData = ClipData.newUri(resolver, "AluDock file", uri)
    }
    try {
      activity.startActivity(intent)
      response.put("outcome", "opened")
    } catch (_: ActivityNotFoundException) {
      response.put("outcome", "noHandler")
    } catch (_: Exception) {
      response.put("outcome", "failed")
    }
    invoke.resolve(response)
  }
}
