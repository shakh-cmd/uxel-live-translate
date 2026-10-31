package com.tourmania.livetranslate

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.media.AudioManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.delay
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

// Uxel colours
private val Navy = Color(0xFF0B2D6B)
private val Blue = Color(0xFF007BFF)
private val Cyan = Color(0xFF00C2E0)
private val Orange = Color(0xFFFF8A00)
private val Red = Color(0xFFE5484D)
private val Paper = Color(0xFFF4F7FC)
private val Muted = Color(0xFF5B6B88)

const val DEFAULT_SERVER = "https://uxel-live-translate.onrender.com"
/** A second tap on the same stop inside this window is ignored (the server also ignores it for 5 s). */
const val STOP_DEBOUNCE_MS = 8_000L

class MainActivity : ComponentActivity() {
    // Render free can take ~50 s to wake up, and preparing a stop renders every language.
    private val http = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS)
        .readTimeout(150, TimeUnit.SECONDS)
        .build()
    private lateinit var prefs: SharedPreferences
    private var server by mutableStateOf("")
    private var pin by mutableStateOf("")
    private var showSettings by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("tourmania", MODE_PRIVATE)
        server = prefs.getString("server", "").orEmpty().ifBlank { DEFAULT_SERVER }
        pin = prefs.getString("pin", "").orEmpty()
        GuideHub.selectedMic = prefs.getInt("mic", -1)
        publishMics()
        val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            if (granted[Manifest.permission.RECORD_AUDIO] != true) {
                GuideHub.onMain { error = "Allow the microphone. The tour cannot start without it." }
                return@registerForActivityResult
            }
            ensureTour { code -> startGuideService(this, server, pin, code) }
        }
        if (pin.isBlank()) showSettings = true else if (!GuideHub.broadcasting) ensureTour {}
        setContent {
            BackHandler(enabled = showSettings) { showSettings = false }
            if (showSettings) {
                SettingsScreen(
                    initialServer = server,
                    initialPin = pin,
                    onSave = { newServer, newPin ->
                        val changed = newServer != server || newPin != pin
                        server = newServer.trim().trimEnd('/')
                        pin = newPin.trim()
                        prefs.edit().putString("server", server).putString("pin", pin).apply()
                        showSettings = false
                        if (changed || GuideHub.code.isBlank()) ensureTour {}
                    },
                    onMic = { id ->
                        GuideHub.selectedMic = id
                        prefs.edit().putInt("mic", id).apply()
                    },
                    onNewTour = {
                        showSettings = false
                        newTour()
                    },
                    onBack = { showSettings = false },
                )
            } else {
                GuideScreen(
                    onSettings = { showSettings = true },
                    onStart = {
                        askPermissions.launch(
                            arrayOf(
                                Manifest.permission.RECORD_AUDIO,
                                Manifest.permission.POST_NOTIFICATIONS,
                                Manifest.permission.BLUETOOTH_CONNECT,
                            ),
                        )
                    },
                    onStop = { startService(Intent(this, GuideService::class.java).setAction(GuideService.ACTION_STOP)) },
                    onRetry = { ensureTour {} },
                    onCreateStop = { name, script -> createStop(name, script) },
                    onPlayStop = { stop -> playStop(stop) },
                    onPlayQuestion = { item -> GuideHub.playQuestion?.invoke(item) },
                )
            }
        }
    }

    private fun publishMics() {
        val manager = getSystemService(AudioManager::class.java)
        GuideHub.mics = manager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .let(::micOptions)
    }

    private fun base() = server.trim().trimEnd('/')

    /**
     * Reuse the remembered tour if the server still has it; open a new one only when it does not.
     * Before, every tap on "Open a tour" made a new session, so guests ended up in a tour without a guide.
     */
    private fun ensureTour(then: (String) -> Unit) {
        if (GuideHub.openingTour) return
        GuideHub.openingTour = true
        GuideHub.error = ""
        val saved = GuideHub.code.ifBlank { prefs.getString("code", "").orEmpty() }
        thread {
            try {
                if (saved.isNotBlank()) {
                    val check = Request.Builder().url("${base()}/api/session/$saved").get().build()
                    http.newCall(check).execute().use { response ->
                        if (response.isSuccessful) {
                            val json = JSONObject(response.body?.string().orEmpty())
                            useTour(json.optString("code", saved), json.optString("joinUrl"))
                            GuideHub.onMain { openingTour = false; then(saved) }
                            return@thread
                        }
                        if (response.code != 404) throw IllegalStateException("Server error ${response.code}")
                    }
                }
                val code = createTour()
                GuideHub.onMain { openingTour = false; if (code != null) then(code) }
            } catch (failure: Exception) {
                GuideHub.onMain {
                    openingTour = false
                    error = "Cannot reach the server. Check the internet connection, then tap Try again."
                }
            }
        }
    }

    private fun newTour() {
        thread {
            try {
                val code = createTour() ?: return@thread
                GuideHub.onMain {
                    questions = emptyList()
                    caption = ""
                    if (broadcasting) startGuideService(this@MainActivity, server, pin, code)
                }
            } catch (failure: Exception) {
                GuideHub.onMain { error = "Cannot reach the server to start a new tour." }
            }
        }
    }

    /** Runs on a worker thread. Returns the new code, or null after showing the error. */
    private fun createTour(): String? {
        val request = Request.Builder()
            .url("${base()}/api/guide/session")
            .header("x-guide-pin", pin)
            .post(ByteArray(0).toRequestBody(null))
            .build()
        http.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val message = if (response.code == 401) "Wrong guide PIN. Fix it in Settings."
                else "The server could not open a tour (${response.code})."
                GuideHub.onMain { error = message }
                return null
            }
            val json = JSONObject(body)
            useTour(json.optString("code"), json.optString("joinUrl"))
            return json.optString("code")
        }
    }

    private fun useTour(newCode: String, newUrl: String) {
        prefs.edit().putString("code", newCode).apply()
        GuideHub.onMain {
            if (code != newCode) forgetTour()
            code = newCode
            joinUrl = newUrl.ifBlank { "${base()}/g/$newCode" }
            error = ""
        }
    }

    private fun createStop(name: String, script: String) {
        val code = GuideHub.code
        if (code.isBlank()) return
        GuideHub.preparingStop = true
        thread {
            try {
                val payload = JSONObject().put("name", name).put("script", script).toString()
                val request = Request.Builder()
                    .url("${base()}/api/guide/session/$code/stops")
                    .header("x-guide-pin", pin)
                    .post(payload.toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        val message = runCatching { JSONObject(body).optString("error") }.getOrDefault("")
                        GuideHub.onMain {
                            preparingStop = false
                            error = message.ifBlank { "Could not prepare that stop (${response.code})." }
                        }
                        return@use
                    }
                    val stop = parseStop(JSONObject(body).getJSONObject("stop"))
                    GuideHub.onMain {
                        preparingStop = false
                        stops = stops.filter { it.id != stop.id } + stop
                        error = if (stop.ready == 0) "“${stop.name}” has no audio yet. ${stop.failure}".trim() else ""
                    }
                }
            } catch (failure: Exception) {
                GuideHub.onMain {
                    preparingStop = false
                    error = "Could not prepare that stop: ${failure.message.orEmpty()}"
                }
            }
        }
    }

    private fun playStop(stop: StopOption) {
        val now = System.currentTimeMillis()
        val last = GuideHub.stopPlayedAt[stop.id] ?: 0L
        if (now - last < STOP_DEBOUNCE_MS) return
        val sent = GuideHub.sendText?.invoke(JSONObject().put("type", "play-stop").put("stopId", stop.id).toString()) == true
        if (!sent) {
            GuideHub.error = "Start the tour first, then play the stop."
            return
        }
        GuideHub.stopPlayedAt = GuideHub.stopPlayedAt + (stop.id to now)
    }
}

@Composable
private fun GuideScreen(
    onSettings: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRetry: () -> Unit,
    onCreateStop: (String, String) -> Unit,
    onPlayStop: (StopOption) -> Unit,
    onPlayQuestion: (QuestionItem) -> Unit,
) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(500)
            now = System.currentTimeMillis()
        }
    }
    val qr = remember(GuideHub.joinUrl) { if (GuideHub.joinUrl.isBlank()) null else qrBitmap(GuideHub.joinUrl, 720) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Paper)
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header: name, connection status, settings
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("UXEL", color = Orange, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp, letterSpacing = 2.sp)
                Text("Live Tour", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 26.sp)
            }
            StatusChip()
            TextButton(onClick = onSettings, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Settings", color = Blue, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
        }
        if (GuideHub.link == Link.RECONNECTING && GuideHub.detail.isNotBlank()) {
            Text(GuideHub.detail, color = Orange, fontWeight = FontWeight.Bold)
        }
        if (GuideHub.error.isNotBlank()) {
            Banner(GuideHub.error, Red) { if (GuideHub.code.isBlank()) onRetry() else GuideHub.error = "" }
        }

        // One big Start / Stop button
        val live = GuideHub.broadcasting
        Button(
            onClick = { if (live) onStop() else onStart() },
            enabled = !GuideHub.openingTour,
            modifier = Modifier.fillMaxWidth().height(96.dp),
            shape = RoundedCornerShape(24.dp),
            colors = ButtonDefaults.buttonColors(containerColor = if (live) Red else Blue),
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    when {
                        GuideHub.openingTour -> "Getting the tour ready…"
                        live -> "Stop tour"
                        else -> "Start tour"
                    },
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 28.sp,
                )
                Text(
                    if (live) "Guests hear you now. Screen can be off." else "Turns on your microphone",
                    fontSize = 14.sp,
                )
            }
        }

        // Guest question: newest first, played automatically, can be replayed
        val latest = GuideHub.questions.firstOrNull()
        if (latest != null) QuestionCard(latest, now, onPlayQuestion)

        // Join card: big QR + big code
        Card {
            if (qr != null) {
                Text("Guests scan to join", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
                Image(
                    bitmap = qr.asImageBitmap(),
                    contentDescription = "QR code for guests to join the tour",
                    modifier = Modifier.fillMaxWidth().aspectRatio(1f),
                )
                Text("or type this code", color = Muted, fontSize = 15.sp, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
                Text(
                    GuideHub.code.chunked(3).joinToString(" "),
                    color = Navy,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 52.sp,
                    letterSpacing = 4.sp,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
            } else {
                Text(
                    if (GuideHub.openingTour) "Getting your tour code… (a sleeping server can take up to a minute)" else "No tour code yet.",
                    color = Navy,
                    fontSize = 18.sp,
                )
                if (!GuideHub.openingTour) BigButton("Try again", Blue, onClick = onRetry)
            }
        }

        // Guests with live indicators
        Card {
            Text("Guests (${GuideHub.guests.size})", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
            if (GuideHub.guests.isEmpty()) {
                Text("No one has joined yet.", color = Muted, fontSize = 16.sp)
            } else {
                GuideHub.guests.forEach { guest -> GuestRow(guest) }
            }
        }

        // What the mic heard
        if (live) {
            Card {
                Text("You said", color = Muted, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text(
                    GuideHub.caption.ifBlank { "Start talking. Your words show up here." },
                    color = Navy,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }

        StopsCard(now, onCreateStop, onPlayStop)

        // Earlier questions
        if (GuideHub.questions.size > 1) {
            Card {
                Text("Earlier questions", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
                GuideHub.questions.drop(1).forEach { item ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.weight(1f)) {
                            Text(languageName(item.language), color = Muted, fontSize = 13.sp)
                            Text(item.english, color = Navy, fontSize = 16.sp)
                        }
                        if (item.wavPath != null) {
                            OutlinedButton(onClick = { onPlayQuestion(item) }, modifier = Modifier.heightIn(min = 48.dp)) {
                                Text("Play", color = Blue, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun StatusChip() {
    val (label, color) = when (GuideHub.link) {
        Link.CONNECTED -> (if (GuideHub.slow) "Slow" else "Connected") to (if (GuideHub.slow) Orange else Cyan)
        Link.CONNECTING -> "Connecting" to Orange
        Link.RECONNECTING -> "Reconnecting" to Orange
        Link.OFFLINE -> "Offline" to Muted
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .background(color.copy(alpha = 0.15f), RoundedCornerShape(50))
            .border(1.dp, color, RoundedCornerShape(50))
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Spacer(Modifier.width(8.dp))
        Text(label, color = Navy, fontWeight = FontWeight.Bold, fontSize = 15.sp)
    }
}

@Composable
private fun QuestionCard(item: QuestionItem, now: Long, onPlay: (QuestionItem) -> Unit) {
    val playing = GuideHub.playingQuestion == item.id
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White, RoundedCornerShape(20.dp))
            .border(3.dp, Orange, RoundedCornerShape(20.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val ago = ((now - item.receivedAt) / 1000).coerceAtLeast(0)
        Text(
            "Guest question · ${languageName(item.language)} · ${if (ago < 60) "${ago}s ago" else "${ago / 60} min ago"}",
            color = Orange,
            fontWeight = FontWeight.ExtraBold,
            fontSize = 15.sp,
        )
        Text(item.english.ifBlank { "(could not translate)" }, color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp)
        if (item.original.isNotBlank()) Text("“${item.original}”", color = Muted, fontSize = 15.sp)
        if (item.wavPath != null) {
            BigButton(if (playing) "Playing in English…" else "Replay in English", if (playing) Cyan else Orange) {
                if (!playing) onPlay(item)
            }
        } else {
            Text("No English audio for this one. Read it above.", color = Muted, fontSize = 14.sp)
        }
    }
}

@Composable
private fun GuestRow(guest: GuestInfo) {
    val asking = guest.id in GuideHub.asking
    val hearing = guest.language != null && guest.language in GuideHub.speaking
    val (label, color) = when {
        asking -> "Asking a question…" to Orange
        hearing -> "Hearing you in ${languageName(guest.language)}" to Cyan
        guest.language == null -> "Choosing a language" to Muted
        GuideHub.broadcasting -> "Listening" to Blue
        else -> "Waiting for the tour to start" to Muted
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    ) {
        Box(Modifier.size(14.dp).background(color, CircleShape))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(languageName(guest.language), color = Navy, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Text(label, color = color, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun StopsCard(now: Long, onCreateStop: (String, String) -> Unit, onPlayStop: (StopOption) -> Unit) {
    var adding by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var script by remember { mutableStateOf("") }
    val ready = GuideHub.stops.filter { it.ready > 0 }
    val notReady = GuideHub.stops.size - ready.size
    Card {
        Text("Pre-recorded stops", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
        if (ready.isEmpty()) Text("None yet. Add one to play a ready-made talk in every language.", color = Muted, fontSize = 15.sp)
        ready.forEach { stop ->
            val playedAt = GuideHub.stopPlayedAt[stop.id] ?: 0L
            val cooling = now - playedAt < STOP_DEBOUNCE_MS
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text(stop.name, color = Navy, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Text("${stop.ready} of ${stop.total} languages ready", color = Muted, fontSize = 14.sp)
                }
                Button(
                    onClick = { onPlayStop(stop) },
                    enabled = !cooling && GuideHub.broadcasting,
                    modifier = Modifier.heightIn(min = 56.dp),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Orange),
                ) { Text(if (cooling) "Playing…" else "Play", fontWeight = FontWeight.ExtraBold, fontSize = 18.sp) }
            }
        }
        if (notReady > 0) Text("$notReady stop(s) hidden: audio could not be made.", color = Muted, fontSize = 13.sp)
        if (GuideHub.preparingStop) {
            Text("Recording the stop in every language… this can take a minute.", color = Blue, fontWeight = FontWeight.Bold)
        } else if (!adding) {
            OutlinedButton(
                onClick = { adding = true },
                enabled = GuideHub.code.isNotBlank(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) { Text("+ Add a stop", color = Blue, fontWeight = FontWeight.Bold, fontSize = 16.sp) }
        } else {
            OutlinedTextField(name, { name = it }, label = { Text("Stop name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(script, { script = it }, label = { Text("What to say, in English") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { adding = false }, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text("Cancel") }
                Button(
                    onClick = {
                        onCreateStop(name.trim(), script.trim())
                        adding = false
                        name = ""
                        script = ""
                    },
                    enabled = name.isNotBlank() && script.isNotBlank(),
                    modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Navy),
                ) { Text("Record it", fontWeight = FontWeight.Bold) }
            }
        }
    }
}

@Composable
private fun SettingsScreen(
    initialServer: String,
    initialPin: String,
    onSave: (String, String) -> Unit,
    onMic: (Int) -> Unit,
    onNewTour: () -> Unit,
    onBack: () -> Unit,
) {
    var server by remember { mutableStateOf(initialServer) }
    var pin by remember { mutableStateOf(initialPin) }
    var confirmNew by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Paper)
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("‹ Back", color = Blue, fontSize = 17.sp) }
            Text("Settings", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp)
        }
        Card {
            Text("Server", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
            OutlinedTextField(server, { server = it }, label = { Text("Server address") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                pin,
                { pin = it },
                label = { Text("Guide PIN") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )
            Text("Saved on this phone. You only enter it once.", color = Muted, fontSize = 13.sp)
            BigButton("Save", Blue, enabled = server.isNotBlank() && pin.isNotBlank()) { onSave(server, pin) }
        }
        Card {
            Text("Microphone", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
            val options = listOf(MicOption(-1, "Automatic")) + GuideHub.mics
            options.forEach { mic ->
                val selected = GuideHub.selectedMic == mic.id
                OutlinedButton(
                    onClick = { onMic(mic.id) },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                    colors = ButtonDefaults.outlinedButtonColors(containerColor = if (selected) Blue.copy(alpha = 0.12f) else Color.Transparent),
                ) { Text((if (selected) "✓  " else "") + mic.label, color = Navy, fontSize = 16.sp) }
            }
        }
        Card {
            Text("Tour", color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
            Text(
                if (GuideHub.code.isBlank()) "No tour code yet." else "Current code: ${GuideHub.code}. It stays the same until you start a new tour, so guests can rejoin.",
                color = Muted,
                fontSize = 14.sp,
            )
            if (!confirmNew) {
                OutlinedButton(onClick = { confirmNew = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Text("Start a new tour (new code)", color = Red, fontWeight = FontWeight.Bold)
                }
            } else {
                Text("Guests on the current code will have to scan the new QR.", color = Red, fontSize = 14.sp)
                BigButton("Yes, new code", Red, onClick = onNewTour)
            }
        }
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White, RoundedCornerShape(20.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) { content() }
}

@Composable
private fun Banner(text: String, color: Color, onTap: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(14.dp))
            .border(1.dp, color, RoundedCornerShape(14.dp))
            .padding(12.dp),
    ) {
        Text(text, color = Navy, fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = Modifier.weight(1f))
        TextButton(onClick = onTap, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(if (GuideHub.code.isBlank()) "Try again" else "OK", color = color, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun BigButton(label: String, color: Color, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp),
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = color),
    ) { Text(label, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp) }
}

private fun qrBitmap(text: String, size: Int): Bitmap {
    val hints = mapOf(EncodeHintType.MARGIN to 1)
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
    val pixels = IntArray(size * size)
    for (y in 0 until size) {
        for (x in 0 until size) pixels[y * size + x] = if (matrix.get(x, y)) 0xFF0B2D6B.toInt() else 0xFFFFFFFF.toInt()
    }
    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
}
