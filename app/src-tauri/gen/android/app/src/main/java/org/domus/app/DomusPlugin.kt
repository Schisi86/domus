package org.domus.app

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class KeepAliveArgs {
  /** Hosted servers are running (null = unchanged). */
  var host: Boolean? = null
  /** A call is active: keeps the microphone working in the background (null = unchanged). */
  var call: Boolean? = null
  var hostTitle: String? = null
  var hostText: String? = null
  var callTitle: String? = null
  var callText: String? = null
}

@InvokeArg
class CaptureArgs {
  var maxWidth: Int = 1280
  var fps: Int = 12
  var quality: Int = 60
  var title: String? = null
  var text: String? = null
}

/**
 * Native helpers for the Domus UI (registered as plugin "domus"):
 *  - keepAlive: a foreground service keeps hosted servers running while the
 *    app is in the background (with a wake and Wi-Fi lock)
 *  - startScreenCapture / stopScreenCapture: the screen via MediaProjection,
 *    delivered to the web view as JPEG frames ("frame" events); the UI turns
 *    them into a video track for the call.
 */
@TauriPlugin
class DomusPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    @Volatile var instance: DomusPlugin? = null
  }

  init {
    instance = this
  }

  private var pendingCapture: CaptureArgs? = null

  @Command
  fun keepAlive(invoke: Invoke) {
    val args = invoke.parseArgs(KeepAliveArgs::class.java)
    val i = Intent(activity, DomusService::class.java)
      .setAction(DomusService.ACTION_STATE)
      .putExtra("hostTitle", args.hostTitle)
      .putExtra("hostText", args.hostText)
      .putExtra("callTitle", args.callTitle)
      .putExtra("callText", args.callText)
    args.host?.let { i.putExtra("host", it) }
    args.call?.let { i.putExtra("call", it) }
    try {
      if (args.host == true || args.call == true) ContextCompat.startForegroundService(activity, i) else activity.startService(i)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Dienst konnte nicht gestartet werden")
    }
  }

  @Command
  fun startScreenCapture(invoke: Invoke) {
    pendingCapture = invoke.parseArgs(CaptureArgs::class.java)
    val mpm = activity.getSystemService(MediaProjectionManager::class.java)
    startActivityForResult(invoke, mpm.createScreenCaptureIntent(), "onProjection")
  }

  @ActivityCallback
  fun onProjection(invoke: Invoke, result: ActivityResult) {
    val data = result.data
    val args = pendingCapture ?: CaptureArgs()
    pendingCapture = null
    if (result.resultCode != Activity.RESULT_OK || data == null) {
      invoke.reject("Bildschirmfreigabe abgelehnt")
      return
    }
    // Android 14+: the projection may only be created inside a running
    // foreground service of type "mediaProjection".
    val i = Intent(activity, DomusService::class.java)
      .setAction(DomusService.ACTION_SCREEN_ON)
      .putExtra("resultCode", result.resultCode)
      .putExtra("data", data)
      .putExtra("maxWidth", args.maxWidth)
      .putExtra("fps", args.fps)
      .putExtra("quality", args.quality)
      .putExtra("title", args.title)
      .putExtra("text", args.text)
    try {
      ContextCompat.startForegroundService(activity, i)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Bildschirmfreigabe konnte nicht gestartet werden")
    }
  }

  @Command
  fun stopScreenCapture(invoke: Invoke) {
    val i = Intent(activity, DomusService::class.java).setAction(DomusService.ACTION_SCREEN_OFF)
    activity.startService(i)
    invoke.resolve()
  }

  fun emitFrame(data: String, width: Int, height: Int) {
    val o = JSObject()
    o.put("data", data)
    o.put("width", width)
    o.put("height", height)
    trigger("frame", o)
  }

  fun emitCaptureStopped(reason: String) {
    val o = JSObject()
    o.put("reason", reason)
    trigger("captureStopped", o)
  }
}
