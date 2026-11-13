package org.domus.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.io.ByteArrayOutputStream

/**
 * Foreground service of the Domus app with two independent jobs:
 *  - host: keeps the process (and the servers it hosts) alive in the
 *    background, holding a partial wake lock and a Wi-Fi lock
 *  - screen: owns the MediaProjection and turns the screen into JPEG frames
 * The service stops itself when neither job is active.
 */
class DomusService : Service() {
  companion object {
    const val ACTION_STATE = "org.domus.app.STATE"
    const val ACTION_SCREEN_ON = "org.domus.app.SCREEN_ON"
    const val ACTION_SCREEN_OFF = "org.domus.app.SCREEN_OFF"
    private const val CHANNEL = "domus_background"
    private const val NOTIFICATION_ID = 7878
  }

  private var hostOn = false
  private var hostTitle = "Domus-Server läuft"
  private var hostText = "Dein Server bleibt erreichbar, auch wenn Domus im Hintergrund ist."
  private var callOn = false
  private var callTitle = "Domus-Anruf läuft"
  private var callText = "Mikrofon und Lautsprecher bleiben im Hintergrund aktiv."
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  private var reader: ImageReader? = null
  private var thread: HandlerThread? = null
  private var screenTitle = "Domus teilt deinen Bildschirm"
  private var screenText = "Alle im Anruf sehen deinen Bildschirm."
  private var lastFrame = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STATE -> {
        intent.getStringExtra("hostTitle")?.let { hostTitle = it }
        intent.getStringExtra("hostText")?.let { hostText = it }
        intent.getStringExtra("callTitle")?.let { callTitle = it }
        intent.getStringExtra("callText")?.let { callText = it }
        if (intent.hasExtra("host")) hostOn = intent.getBooleanExtra("host", false)
        if (intent.hasExtra("call")) callOn = intent.getBooleanExtra("call", false)
        if (hostOn) acquireLocks() else releaseLocks()
        updateOrStop()
      }
      ACTION_SCREEN_ON -> startScreen(intent)
      ACTION_SCREEN_OFF -> {
        stopScreen("stopped")
        updateOrStop()
      }
      // Restarted by the system after the process was killed: nothing to resume.
      else -> updateOrStop()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopScreen("destroyed")
    releaseLocks()
    super.onDestroy()
  }

  // ------------------------------------------------------------- notification

  private fun notification(): Notification {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Domus im Hintergrund", NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val screen = projection != null
    val title = when { screen -> screenTitle; callOn -> callTitle; else -> hostTitle }
    val text = when { screen -> screenText; callOn -> callText; else -> hostText }
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(if (hostOn && (screen || callOn)) "$text · $hostTitle" else text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open)
      .setCategory(if (screen || callOn) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_SERVICE)
      .build()
  }

  private fun types(screen: Boolean): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
    var t = 0
    if (screen) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
    if (callOn && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    if (hostOn) {
      t = t or if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
    }
    return t
  }

  private fun promote(screen: Boolean = projection != null) {
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), types(screen))
    } catch (e: Exception) {
      // E.g. microphone type without the permission: keep the rest running.
      if (callOn) {
        callOn = false
        try { ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), types(screen)) } catch (e2: Exception) { }
      }
    }
  }

  private fun updateOrStop() {
    if (!hostOn && !callOn && projection == null) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
    } else {
      promote()
    }
  }

  // ------------------------------------------------------------- host

  private fun acquireLocks() {
    if (wakeLock == null) {
      wakeLock = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Domus::Server")
        .apply { setReferenceCounted(false); acquire() }
    }
    if (wifiLock == null) {
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifiLock = applicationContext.getSystemService(WifiManager::class.java)
        .createWifiLock(mode, "Domus::Server")
        .apply { setReferenceCounted(false); acquire() }
    }
  }

  private fun releaseLocks() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    wifiLock?.let { if (it.isHeld) it.release() }
    wifiLock = null
  }

  // ------------------------------------------------------------- screen

  private fun startScreen(intent: Intent) {
    stopScreen("restart")
    intent.getStringExtra("title")?.let { screenTitle = it }
    intent.getStringExtra("text")?.let { screenText = it }
    val resultCode = intent.getIntExtra("resultCode", Activity.RESULT_CANCELED)
    @Suppress("DEPRECATION")
    val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra("data", Intent::class.java) else intent.getParcelableExtra("data")
    if (data == null) {
      DomusPlugin.instance?.emitCaptureStopped("no-permission")
      updateOrStop()
      return
    }
    // The foreground type must be in place before the projection is created.
    promote(screen = true)
    val mpm = getSystemService(MediaProjectionManager::class.java)
    val p = try { mpm.getMediaProjection(resultCode, data) } catch (e: Exception) { null }
    if (p == null) {
      DomusPlugin.instance?.emitCaptureStopped("failed")
      updateOrStop()
      return
    }
    projection = p
    val t = HandlerThread("domus-screen").apply { start() }
    thread = t
    val handler = Handler(t.looper)
    p.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() {
        // Ended from the system UI (status bar chip, lock screen, …).
        handler.post {
          stopScreen("system")
          updateOrStop()
        }
      }
    }, handler)

    val metrics = resources.displayMetrics
    val maxW = intent.getIntExtra("maxWidth", 1280).coerceIn(320, 1920)
    val fps = intent.getIntExtra("fps", 12).coerceIn(1, 30)
    val quality = intent.getIntExtra("quality", 60).coerceIn(30, 90)
    // maxWidth limits the longer side (a portrait phone becomes e.g. 590×1280).
    val scale = minOf(1.0, maxW.toDouble() / maxOf(metrics.widthPixels, metrics.heightPixels).toDouble())
    val w = (metrics.widthPixels * scale).toInt() and 1.inv()
    val h = (metrics.heightPixels * scale).toInt() and 1.inv()
    val r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
    reader = r
    val minGap = 1000L / fps
    r.setOnImageAvailableListener({ ir ->
      val img = try { ir.acquireLatestImage() } catch (e: Exception) { null } ?: return@setOnImageAvailableListener
      try {
        val now = SystemClock.elapsedRealtime()
        if (now - lastFrame < minGap) return@setOnImageAvailableListener
        lastFrame = now
        val plane = img.planes[0]
        val pixelStride = plane.pixelStride
        val rowPadding = plane.rowStride - pixelStride * w
        val bmp = Bitmap.createBitmap(w + rowPadding / pixelStride, h, Bitmap.Config.ARGB_8888)
        bmp.copyPixelsFromBuffer(plane.buffer)
        val frame = if (rowPadding == 0) bmp else Bitmap.createBitmap(bmp, 0, 0, w, h)
        val out = ByteArrayOutputStream(64 * 1024)
        frame.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (frame !== bmp) frame.recycle()
        bmp.recycle()
        DomusPlugin.instance?.emitFrame(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), w, h)
      } catch (e: Exception) {
        // A single broken frame is skipped.
      } finally {
        img.close()
      }
    }, handler)
    display = p.createVirtualDisplay("Domus", w, h, metrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, handler)
  }

  private fun stopScreen(reason: String) {
    val had = projection != null
    display?.release()
    display = null
    reader?.close()
    reader = null
    val p = projection
    projection = null
    try { p?.stop() } catch (e: Exception) { }
    thread?.quitSafely()
    thread = null
    if (had && reason != "restart") DomusPlugin.instance?.emitCaptureStopped(reason)
  }
}
