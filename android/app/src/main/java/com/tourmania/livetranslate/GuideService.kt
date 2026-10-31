package com.tourmania.livetranslate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
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
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * Native guide capture. A microphone foreground service owns the socket and the mic,
 * so audio keeps flowing with the screen off. A WebView getUserMedia call does not.
 *
 * Every start bumps [generation]. The mic and link threads exit as soon as the generation
 * they were started with is no longer current. Before this, a quick Stop → Start left the
 * old threads running next to the new ones: two mics sent every word twice (the "repeating
 * phrase") and two sockets with the same client id kept kicking each other off (reconnect churn).
 */
class GuideService : Service() {
    private val generation = AtomicInteger(0)
    private val socket = AtomicReference<WebSocket?>(null)
    private val muted = AtomicBoolean(false)
    private val questionIds = AtomicLong(System.currentTimeMillis())
    private val clientId = UUID.randomUUID().toString()
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var deviceCallback: AudioDeviceCallback? = null
    private var player: MediaPlayer? = null
    @Volatile private var server = ""
    @Volatile private var pin = ""
    @Volatile private var code = ""
    private val http = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopBroadcast()
            return START_NOT_STICKY
        }
        val newServer = intent?.getStringExtra(EXTRA_SERVER).orEmpty().trim().trimEnd('/')
        val newPin = intent?.getStringExtra(EXTRA_PIN).orEmpty()
        val newCode = intent?.getStringExtra(EXTRA_CODE).orEmpty()
        if (newServer.isEmpty() || newCode.isEmpty() || newPin.isEmpty()) {
            if (generation.get() == 0) stopSelf()
            return START_NOT_STICKY
        }
        startInForeground("Connecting")
        val alreadyLive = generation.get() > 0 && socketThreadsAlive
        if (alreadyLive && newServer == server && newPin == pin && newCode == code) return START_STICKY
        server = newServer
        pin = newPin
        code = newCode
        // New generation: any older mic or link thread stops on its next loop.
        val gen = generation.incrementAndGet()
        socket.getAndSet(null)?.close(1000, "restart")
        acquireWakeLock()
        if (audioManager == null) {
            audioManager = getSystemService(AudioManager::class.java)
            val callback = object : AudioDeviceCallback() {
                override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = publishMics()
                override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = publishMics()
            }
            audioManager?.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
            deviceCallback = callback
        }
        publishMics()
        GuideHub.sendText = { text -> socket.get()?.send(text) == true }
        GuideHub.playQuestion = { item -> Handler(Looper.getMainLooper()).post { play(item) } }
        GuideHub.onMain {
            broadcasting = true
            link = Link.CONNECTING
            error = ""
        }
        socketThreadsAlive = true
        thread(name = "tourmania-mic-$gen", isDaemon = true) {
            try {
                MicCapture(
                    device = { selectedDevice() },
                    running = { generation.get() == gen },
                    muted = { muted.get() },
                ) { pcm, utteranceId, seq, end ->
                    val payload = JSONObject()
                        .put("type", "audio")
                        .put("pcm", if (pcm.isEmpty()) "" else Base64.encodeToString(pcm, Base64.NO_WRAP))
                        .put("seq", seq)
                        .put("utteranceId", utteranceId)
                        .put("end", end)
                    socket.get()?.send(payload.toString())
                }.loop()
            } catch (failure: SecurityException) {
                GuideHub.onMain { error = "Allow the microphone in Android settings. ${failure.message.orEmpty()}" }
            } catch (failure: Exception) {
                GuideHub.onMain { error = "The microphone stopped: ${failure.message.orEmpty()}" }
            }
        }
        thread(name = "tourmania-link-$gen", isDaemon = true) { connectLoop(gen) }
        return START_STICKY
    }

    @Volatile private var socketThreadsAlive = false

    override fun onDestroy() {
        generation.incrementAndGet()
        socketThreadsAlive = false
        socket.getAndSet(null)?.close(1000, "stop")
        wakeLock?.let { if (it.isHeld) it.release() }
        deviceCallback?.let { audioManager?.unregisterAudioDeviceCallback(it) }
        releasePlayer()
        GuideHub.sendText = null
        GuideHub.playQuestion = null
        GuideHub.onMain {
            broadcasting = false
            link = Link.OFFLINE
            slow = false
            speaking = emptySet()
            asking = emptySet()
            playingQuestion = null
        }
        super.onDestroy()
    }

    private fun connectLoop(gen: Int) {
        var delay = 1000L
        var everConnected = false
        while (generation.get() == gen) {
            val done = CountDownLatch(1)
            val request = Request.Builder().url(wsUrl(server, code)).build()
            var fatal = ""
            val ws = http.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (generation.get() != gen) {
                        webSocket.close(1000, "stale")
                        return
                    }
                    socket.set(webSocket)
                    delay = 1000L
                    everConnected = true
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
                        link = Link.CONNECTED
                        detail = ""
                        error = ""
                    }
                    updateNotification("Live · guests hear you")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (generation.get() == gen) handle(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    if (reason == "bad pin") fatal = "Wrong guide PIN. Fix it in Settings."
                    if (code == 4004) fatal = "This tour has ended on the server. Start a new tour."
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    socket.compareAndSet(webSocket, null)
                    done.countDown()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    socket.compareAndSet(webSocket, null)
                    if (response?.code == 404) fatal = "This tour has ended on the server. Start a new tour."
                    done.countDown()
                }
            })
            done.await()
            ws.cancel()
            if (generation.get() != gen) break
            if (fatal.isNotEmpty()) {
                GuideHub.onMain {
                    error = fatal
                    link = Link.OFFLINE
                }
                stopBroadcast()
                break
            }
            GuideHub.onMain {
                link = Link.RECONNECTING
                detail = if (everConnected) "Signal lost. Reconnecting to the same tour…" else "Cannot reach the server yet. Retrying…"
            }
            updateNotification("Reconnecting…")
            Thread.sleep(delay)
            delay = (delay * 2).coerceAtMost(8_000L)
        }
    }

    private fun handle(text: String) {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (json.optString("type")) {
            "status" -> {
                val state = json.optString("state", "connected")
                GuideHub.onMain { slow = state == "lagging" }
            }
            "caption" -> if (json.optString("track") == "source") {
                GuideHub.onMain { caption = json.optString("text") }
            }
            "guests" -> GuideHub.onMain { guests = guestList(json) }
            "welcome" -> GuideHub.onMain {
                guests = guestList(json)
                stops = stopList(json)
                val url = json.optString("joinUrl")
                if (url.isNotBlank()) joinUrl = url
            }
            "stops" -> GuideHub.onMain {
                stops = stopList(json)
                preparingStop = false
            }
            "activity" -> {
                val talking = stringSet(json, "speaking")
                val asks = stringSet(json, "asking")
                GuideHub.onMain {
                    speaking = talking
                    asking = asks
                }
            }
            "question" -> onQuestion(json)
            "error" -> GuideHub.onMain { error = json.optString("message") }
            "pong" -> Unit
        }
    }

    private fun onQuestion(json: JSONObject) {
        val id = questionIds.incrementAndGet()
        val audio = json.optString("audio")
        val path = if (audio.isBlank()) null else runCatching {
            val dir = File(cacheDir, "questions").apply { mkdirs() }
            // Keep the cache small: only the last 10 questions.
            dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(9)?.forEach { it.delete() }
            val file = File(dir, "q-$id.wav")
            file.writeBytes(Base64.decode(audio, Base64.DEFAULT))
            file.absolutePath
        }.getOrNull()
        val item = QuestionItem(
            id = id,
            guestId = json.optString("guestId"),
            language = json.optString("language"),
            original = json.optString("original"),
            english = json.optString("english"),
            wavPath = path,
            receivedAt = System.currentTimeMillis(),
        )
        GuideHub.onMain { questions = (listOf(item) + questions).take(10) }
        if (path != null) Handler(Looper.getMainLooper()).post { play(item) }
    }

    /** Plays a guest question in English on the guide's speaker or headset. The mic is muted meanwhile. */
    private fun play(item: QuestionItem) {
        val path = item.wavPath ?: return
        releasePlayer()
        val media = MediaPlayer()
        try {
            media.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            media.setDataSource(path)
            media.setOnCompletionListener { finishPlayback(it) }
            media.setOnErrorListener { player, _, _ ->
                finishPlayback(player)
                true
            }
            media.prepare()
            muted.set(true)
            player = media
            GuideHub.onMain { playingQuestion = item.id }
            media.start()
        } catch (failure: Exception) {
            media.release()
            muted.set(false)
            GuideHub.onMain {
                playingQuestion = null
                error = "Could not play the question: ${failure.message.orEmpty()}"
            }
        }
    }

    private fun finishPlayback(media: MediaPlayer) {
        if (player == media) player = null
        media.release()
        muted.set(false)
        GuideHub.onMain { playingQuestion = null }
    }

    private fun releasePlayer() {
        player?.let { runCatching { it.stop() }; it.release() }
        player = null
        muted.set(false)
    }

    private fun stringSet(json: JSONObject, key: String): Set<String> {
        val array = json.optJSONArray(key) ?: return emptySet()
        return (0 until array.length()).map { array.optString(it) }.toSet()
    }

    private fun guestList(json: JSONObject): List<GuestInfo> {
        val array = json.optJSONArray("guests") ?: return emptyList()
        return (0 until array.length()).map { i ->
            val guest = array.getJSONObject(i)
            GuestInfo(guest.optString("id"), guest.optString("language").takeIf { it.isNotBlank() && it != "null" })
        }
    }

    private fun stopList(json: JSONObject): List<StopOption> {
        val array = json.optJSONArray("stops") ?: return GuideHub.stops
        return (0 until array.length()).map { i -> parseStop(array.getJSONObject(i)) }
    }

    private fun publishMics() {
        val manager = audioManager ?: return
        val options = manager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .let(::micOptions)
        GuideHub.onMain { mics = options }
    }

    private fun selectedDevice(): AudioDeviceInfo? {
        val wanted = GuideHub.selectedMic
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
            .setContentTitle("Tour $code")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_media_pause, "Stop tour", stop)
            .build()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val power = getSystemService(PowerManager::class.java)
        val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tourmania:guide")
        lock.setReferenceCounted(false)
        lock.acquire(4 * 60 * 60 * 1000L)
        wakeLock = lock
    }

    private fun stopBroadcast() {
        generation.incrementAndGet()
        socketThreadsAlive = false
        socket.getAndSet(null)?.let {
            it.send(JSONObject().put("type", "broadcast").put("action", "stop").toString())
            it.close(1000, "stop")
        }
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

fun parseStop(stop: JSONObject): StopOption {
    val langs = stop.optJSONArray("languages")
    var ready = 0
    var failure = ""
    val total = langs?.length() ?: 0
    if (langs != null) {
        for (j in 0 until langs.length()) {
            val lang = langs.getJSONObject(j)
            if (lang.optBoolean("ok")) ready += 1 else if (failure.isEmpty()) failure = lang.optString("error")
        }
    }
    return StopOption(stop.optString("id"), stop.optString("name"), ready, total, failure)
}

private val MIC_TYPES = setOf(
    AudioDeviceInfo.TYPE_BUILTIN_MIC,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_USB_DEVICE,
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
)

/** Real microphones only (no telephony, FM or echo-reference inputs), one entry per label. */
fun micOptions(devices: Array<AudioDeviceInfo>): List<MicOption> =
    devices.filter { it.isSource && it.type in MIC_TYPES }
        .map { MicOption(it.id, micLabel(it)) }
        .distinctBy { it.label }

fun micLabel(device: AudioDeviceInfo): String {
    val kind = when (device.type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Phone microphone"
        AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB microphone"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth headset"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired headset"
        else -> "Microphone"
    }
    val name = device.productName?.toString().orEmpty()
    return if (name.isBlank() || device.type == AudioDeviceInfo.TYPE_BUILTIN_MIC) kind else "$kind · $name"
}

fun startGuideService(context: Context, server: String, pin: String, code: String) {
    val intent = Intent(context, GuideService::class.java)
        .putExtra(GuideService.EXTRA_SERVER, server)
        .putExtra(GuideService.EXTRA_PIN, pin)
        .putExtra(GuideService.EXTRA_CODE, code)
    context.startForegroundService(intent)
}
