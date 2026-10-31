package com.tourmania.livetranslate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Base64
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * Native guide capture. A microphone foreground service owns the socket and the mic,
 * so audio keeps flowing with the screen off. A WebView getUserMedia call does not.
 */
class GuideService : Service() {
    private val running = AtomicBoolean(false)
    private val socket = AtomicReference<WebSocket?>(null)
    private val micId = AtomicInteger(-1)
    private val clientId = UUID.randomUUID().toString()
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var server = ""
    private var pin = ""
    private var code = ""
    private val http = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopBroadcast()
            return START_NOT_STICKY
        }
        server = intent?.getStringExtra(EXTRA_SERVER).orEmpty().trim().trimEnd('/')
        pin = intent?.getStringExtra(EXTRA_PIN).orEmpty()
        code = intent?.getStringExtra(EXTRA_CODE).orEmpty()
        if (server.isEmpty() || code.isEmpty() || pin.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground("Connecting")
        if (!running.compareAndSet(false, true)) return START_STICKY
        acquireWakeLock()
        audioManager = getSystemService(AudioManager::class.java)
        publishMics()
        audioManager?.registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = publishMics()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = publishMics()
        }, Handler(Looper.getMainLooper()))
        GuideHub.selectMic = { id -> micId.set(id) }
        GuideHub.sendText = { text -> socket.get()?.send(text) == true }
        GuideHub.onMain { broadcasting = true }
        thread(name = "tourmania-mic", isDaemon = true) {
            try {
            MicCapture(device = { selectedDevice() }, running = { running.get() }) { pcm, utteranceId, seq, end ->
                val payload = JSONObject()
                    .put("type", "audio")
                    .put("pcm", if (pcm.isEmpty()) "" else Base64.encodeToString(pcm, Base64.NO_WRAP))
                    .put("seq", seq)
                    .put("utteranceId", utteranceId)
                    .put("end", end)
                socket.get()?.send(payload.toString())
            }.loop()
            } catch (failure: SecurityException) {
                GuideHub.onMain { error = failure.message ?: "Microphone permission is missing." }
            }
        }
        thread(name = "tourmania-link", isDaemon = true) { connectLoop() }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        socket.getAndSet(null)?.close(1000, "stop")
        wakeLock?.let { if (it.isHeld) it.release() }
        GuideHub.sendText = null
        GuideHub.selectMic = null
        GuideHub.onMain {
            broadcasting = false
            status = "offline"
            detail = "Broadcast stopped."
        }
        super.onDestroy()
    }

    private fun connectLoop() {
        var delay = 1000L
        while (running.get()) {
            val done = CountDownLatch(1)
            val request = Request.Builder().url(wsUrl(server, code)).build()
            var opened = false
            val ws = http.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened = true
                    socket.set(webSocket)
                    delay = 1000L
                    webSocket.send(
                        JSONObject()
                            .put("type", "hello")
                            .put("role", "guide")
                            .put("clientId", clientId)
                            .put("pin", pin)
                            .toString(),
                    )
                    webSocket.send(JSONObject().put("type", "broadcast").put("action", "start").toString())
                    GuideHub.onMain {
                        status = "connected"
                        detail = "Live. The mic stays on with the screen off."
                        error = ""
                    }
                    updateNotification("Connected")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handle(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (socket.get() == webSocket) socket.set(null)
                    done.countDown()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (socket.get() == webSocket) socket.set(null)
                    GuideHub.onMain {
                        status = "offline"
                        detail = "Reconnecting…"
                        error = t.message ?: "Connection failed"
                    }
                    updateNotification("Offline — reconnecting")
                    done.countDown()
                }
            })
            done.await()
            ws.cancel()
            if (!running.get()) break
            if (!opened) {
                GuideHub.onMain {
                    status = "offline"
                    detail = "Cannot reach the server. Retrying."
                }
            }
            Thread.sleep(delay)
            delay = (delay * 2).coerceAtMost(15_000L)
        }
    }

    private fun handle(text: String) {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (json.optString("type")) {
            "status" -> {
                val state = json.optString("state", "offline")
                val detailText = json.optString("detail")
                GuideHub.onMain {
                    status = state
                    if (detailText.isNotBlank()) detail = detailText
                }
                updateNotification(state.replaceFirstChar { it.uppercase() })
            }
            "caption" -> if (json.optString("track") == "source") {
                GuideHub.onMain { caption = json.optString("text") }
            }
            "guests" -> GuideHub.onMain { guests = guestLines(json) }
            "welcome" -> GuideHub.onMain {
                guests = guestLines(json)
                stops = stopLines(json)
                val url = json.optString("joinUrl")
                if (url.isNotBlank()) joinUrl = url
            }
            "stops" -> GuideHub.onMain { stops = stopLines(json) }
            "question" -> GuideHub.onMain {
                val line = "${json.optString("language")}: ${json.optString("english")}"
                questions = (listOf(line) + questions).take(8)
            }
            "error" -> GuideHub.onMain { error = json.optString("message") }
            "pong" -> Unit
        }
    }

    private fun guestLines(json: JSONObject): List<String> {
        val array = json.optJSONArray("guests") ?: return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val guest = array.getJSONObject(i)
                val language = guest.optString("language").ifBlank { "choosing" }
                add("$language · ${guest.optInt("cachedStops")} stops saved")
            }
        }
    }

    private fun stopLines(json: JSONObject): List<StopOption> {
        val array = json.optJSONArray("stops") ?: return GuideHub.stops
        return buildList {
            for (i in 0 until array.length()) {
                val stop = array.getJSONObject(i)
                val langs = stop.optJSONArray("languages")
                var ready = 0
                val total = langs?.length() ?: 0
                if (langs != null) {
                    for (j in 0 until langs.length()) if (langs.getJSONObject(j).optBoolean("ok")) ready += 1
                }
                add(StopOption(stop.optString("id"), stop.optString("name"), "$ready/$total"))
            }
        }
    }

    private fun publishMics() {
        val manager = audioManager ?: return
        val options = manager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .filter { it.isSource }
            .map { MicOption(it.id, micLabel(it)) }
        GuideHub.onMain { mics = options }
    }

    private fun selectedDevice(): AudioDeviceInfo? {
        val wanted = micId.get()
        val manager = audioManager ?: return null
        val device = manager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.id == wanted } ?: return null
        if (device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || device.type == AudioDeviceInfo.TYPE_BLE_HEADSET) {
            runCatching {
                manager.mode = AudioManager.MODE_IN_COMMUNICATION
                manager.setCommunicationDevice(device)
            }
        }
        return device
    }

    private fun micLabel(device: AudioDeviceInfo): String {
        val kind = when (device.type) {
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Phone"
            AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired"
            else -> "Input"
        }
        val name = device.productName?.toString().orEmpty().ifBlank { kind }
        return "$kind · $name"
    }

    private fun startInForeground(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL, "Tour broadcast", NotificationManager.IMPORTANCE_LOW)
        channel.description = "Stays up while the guide microphone is live"
        manager.createNotificationChannel(channel)
        startForeground(NOTE_ID, notification(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTE_ID, notification(text))
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            2,
            Intent(this, GuideService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Tourmania Live Translate")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stop)
            .build()
    }

    private fun acquireWakeLock() {
        val power = getSystemService(PowerManager::class.java)
        val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tourmania:guide")
        lock.setReferenceCounted(false)
        lock.acquire(4 * 60 * 60 * 1000L)
        wakeLock = lock
    }

    private fun stopBroadcast() {
        running.set(false)
        socket.getAndSet(null)?.close(1000, "stop")
        wakeLock?.let { if (it.isHeld) it.release() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        const val CHANNEL = "tourmania-guide"
        const val NOTE_ID = 7
        const val ACTION_STOP = "com.tourmania.livetranslate.STOP"
        const val EXTRA_SERVER = "server"
        const val EXTRA_PIN = "pin"
        const val EXTRA_CODE = "code"

        fun wsUrl(base: String, code: String): String {
            val http = base.removePrefix("https://").removePrefix("http://")
            val scheme = if (base.startsWith("https://")) "wss" else "ws"
            return "$scheme://$http/ws?role=guide&code=$code"
        }
    }
}

fun startGuideService(context: Context, server: String, pin: String, code: String) {
    val intent = Intent(context, GuideService::class.java)
        .putExtra(GuideService.EXTRA_SERVER, server)
        .putExtra(GuideService.EXTRA_PIN, pin)
        .putExtra(GuideService.EXTRA_CODE, code)
    context.startForegroundService(intent)
}
