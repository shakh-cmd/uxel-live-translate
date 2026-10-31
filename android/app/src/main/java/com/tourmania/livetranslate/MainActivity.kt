package com.tourmania.livetranslate

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import kotlin.concurrent.thread

class MainActivity : ComponentActivity() {
    private val http = OkHttpClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("tourmania", MODE_PRIVATE)
        val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            val mic = granted[Manifest.permission.RECORD_AUDIO] == true
            if (!mic) {
                GuideHub.onMain { error = "Allow the microphone. The broadcast cannot start without it." }
                return@registerForActivityResult
            }
            val server = prefs.getString("server", "").orEmpty()
            val pin = prefs.getString("pin", "").orEmpty()
            val code = GuideHub.code
            if (server.isNotBlank() && pin.isNotBlank() && code.isNotBlank()) {
                startGuideService(this, server, pin, code)
            }
        }
        setContent {
            GuideScreen(
                initialServer = prefs.getString("server", "https://").orEmpty(),
                initialPin = prefs.getString("pin", "").orEmpty(),
                onSave = { server, pin ->
                    prefs.edit().putString("server", server).putString("pin", pin).apply()
                },
                onOpenTour = { server, pin -> openTour(server, pin) },
                onStart = { server, pin ->
                    prefs.edit().putString("server", server).putString("pin", pin).apply()
                    askPermissions.launch(
                        arrayOf(
                            Manifest.permission.RECORD_AUDIO,
                            Manifest.permission.POST_NOTIFICATIONS,
                            Manifest.permission.BLUETOOTH_CONNECT,
                        ),
                    )
                },
                onStop = {
                    startService(Intent(this, GuideService::class.java).setAction(GuideService.ACTION_STOP))
                },
                onCreateStop = { server, pin, name, script -> createStop(server, pin, name, script) },
                onPlayStop = { id ->
                    val sent = GuideHub.sendText?.invoke(JSONObject().put("type", "play-stop").put("stopId", id).toString()) == true
                    if (!sent) GuideHub.onMain { error = "Start the broadcast before playing a stop." }
                },
            )
        }
    }

    private fun openTour(server: String, pin: String) {
        thread {
            try {
                val request = Request.Builder()
                    .url("${server.trim().trimEnd('/')}/api/guide/session")
                    .header("x-guide-pin", pin)
                    .post(ByteArray(0).toRequestBody(null))
                    .build()
                http.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        val message = runCatching { JSONObject(body).optString("error") }.getOrDefault(body)
                        GuideHub.onMain { error = message.ifBlank { "Could not open a tour (${response.code})." } }
                        return@use
                    }
                    val json = JSONObject(body)
                    GuideHub.onMain {
                        code = json.optString("code")
                        joinUrl = json.optString("joinUrl")
                        error = ""
                        detail = "Tour is open. Start the broadcast when the group is ready."
                    }
                }
            } catch (failure: Exception) {
                GuideHub.onMain { error = failure.message ?: "Could not reach the server." }
            }
        }
    }

    private fun createStop(server: String, pin: String, name: String, script: String) {
        val code = GuideHub.code
        if (code.isBlank()) {
            GuideHub.onMain { error = "Open a tour first." }
            return
        }
        thread {
            try {
                val payload = JSONObject().put("name", name).put("script", script).toString()
                val request = Request.Builder()
                    .url("${server.trim().trimEnd('/')}/api/guide/session/$code/stops")
                    .header("x-guide-pin", pin)
                    .post(payload.toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        GuideHub.onMain { error = "Could not prepare that stop (${response.code})." }
                        return@use
                    }
                    val stop = JSONObject(body).getJSONObject("stop")
                    val option = StopOption(stop.optString("id"), stop.optString("name"), "preparing")
                    GuideHub.onMain {
                        stops = stops.filter { it.id != option.id } + option
                        error = ""
                    }
                }
            } catch (failure: Exception) {
                GuideHub.onMain { error = failure.message ?: "Could not prepare that stop." }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GuideScreen(
    initialServer: String,
    initialPin: String,
    onSave: (String, String) -> Unit,
    onOpenTour: (String, String) -> Unit,
    onStart: (String, String) -> Unit,
    onStop: () -> Unit,
    onCreateStop: (String, String, String, String) -> Unit,
    onPlayStop: (String) -> Unit,
) {
    var server by remember { mutableStateOf(initialServer) }
    var pin by remember { mutableStateOf(initialPin) }
    var stopName by remember { mutableStateOf("Basilica Cistern") }
    var stopScript by remember {
        mutableStateOf("This is the Basilica Cistern in Istanbul. Emperor Justinian built it in the sixth century to store water for the palace. Mind the wet floor.")
    }
    var micOpen by remember { mutableStateOf(false) }
    val navy = Color(0xFF0B2D6B)
    val blue = Color(0xFF007BFF)
    val red = Color(0xFFFF3B30)
    val yellow = Color(0xFFFFC700)
    val statusBg = when (GuideHub.status) {
        "connected" -> blue
        "lagging" -> yellow
        else -> red
    }
    val statusFg = if (GuideHub.status == "lagging") navy else Color.White
    val qr = remember(GuideHub.joinUrl) { if (GuideHub.joinUrl.isBlank()) null else qrBitmap(GuideHub.joinUrl, 560) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("TOURMANIA", color = yellow, fontWeight = FontWeight.ExtraBold, fontSize = 12.sp)
        Text("Live Translate", color = navy, fontWeight = FontWeight.ExtraBold, fontSize = 28.sp)
        Text("Guide app · screen can be off while you talk", color = navy, fontSize = 14.sp)
        OutlinedTextField(server, { server = it; onSave(it, pin) }, label = { Text("Server URL") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(pin, { pin = it; onSave(server, it) }, label = { Text("Guide PIN") }, modifier = Modifier.fillMaxWidth())
        Button(
            onClick = { onOpenTour(server, pin) },
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = navy),
        ) { Text("Open a tour", fontWeight = FontWeight.ExtraBold) }
        Box(Modifier.fillMaxWidth().background(statusBg, RoundedCornerShape(20.dp)).padding(20.dp)) {
            Text(GuideHub.status.replaceFirstChar { it.uppercase() }, color = statusFg, fontWeight = FontWeight.ExtraBold, fontSize = 28.sp)
        }
        Text(GuideHub.detail, color = navy)
        if (GuideHub.error.isNotBlank()) Text(GuideHub.error, color = red, fontWeight = FontWeight.Bold)
        Button(
            onClick = { if (GuideHub.broadcasting) onStop() else onStart(server, pin) },
            modifier = Modifier.fillMaxWidth().height(64.dp),
            colors = ButtonDefaults.buttonColors(containerColor = if (GuideHub.broadcasting) red else blue),
            shape = RoundedCornerShape(16.dp),
        ) {
            Text(if (GuideHub.broadcasting) "Stop broadcast" else "Start broadcast", fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
        }
        Text("The notification stays up. The microphone keeps running with the screen locked.", color = navy, fontSize = 13.sp)
        if (GuideHub.mics.isNotEmpty()) {
            ExposedDropdownMenuBox(expanded = micOpen, onExpandedChange = { micOpen = it }) {
                OutlinedTextField(
                    value = GuideHub.mics.firstOrNull()?.label ?: "Microphone",
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Microphone") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = micOpen) },
                    modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
                )
                ExposedDropdownMenu(expanded = micOpen, onDismissRequest = { micOpen = false }) {
                    GuideHub.mics.forEach { mic ->
                        DropdownMenuItem(
                            text = { Text(mic.label) },
                            onClick = {
                                GuideHub.selectMic?.invoke(mic.id)
                                micOpen = false
                            },
                        )
                    }
                }
            }
        }
        Text("English", color = navy, fontWeight = FontWeight.ExtraBold)
        Text(GuideHub.caption.ifBlank { "Captions appear here while you speak." }, color = navy, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
        Text("Guests", color = navy, fontWeight = FontWeight.ExtraBold)
        if (GuideHub.guests.isEmpty()) Text("Waiting for the first phone.", color = navy) else GuideHub.guests.forEach { Text(it, color = navy, fontWeight = FontWeight.Bold) }
        if (qr != null) {
            Text(GuideHub.code, color = navy, fontWeight = FontWeight.ExtraBold, fontSize = 32.sp)
            Image(bitmap = qr.asImageBitmap(), contentDescription = "QR code for guests", modifier = Modifier.fillMaxWidth().height(240.dp))
            Text(GuideHub.joinUrl, color = blue, fontSize = 12.sp)
        }
        OutlinedTextField(stopName, { stopName = it }, label = { Text("Stop name") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(stopScript, { stopScript = it }, label = { Text("English script") }, modifier = Modifier.fillMaxWidth())
        Button(
            onClick = { onCreateStop(server, pin, stopName, stopScript) },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = yellow, contentColor = navy),
        ) { Text("Prepare this stop", fontWeight = FontWeight.ExtraBold) }
        GuideHub.stops.forEach { stop ->
            Button(
                onClick = { onPlayStop(stop.id) },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = yellow, contentColor = navy),
            ) { Text("${stop.name} · ${stop.ready}", fontWeight = FontWeight.ExtraBold) }
        }
        Text("Questions", color = navy, fontWeight = FontWeight.ExtraBold)
        if (GuideHub.questions.isEmpty()) Text("None yet.", color = navy) else GuideHub.questions.forEach { Text(it, color = navy, fontWeight = FontWeight.Bold) }
        Text("info@tourmania.com", color = blue, modifier = Modifier.padding(bottom = 24.dp))
    }
}

private fun qrBitmap(text: String, size: Int): Bitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    for (x in 0 until size) {
        for (y in 0 until size) bitmap.setPixel(x, y, if (matrix.get(x, y)) 0xFF0B2D6B.toInt() else 0xFFFFFFFF.toInt())
    }
    return bitmap
}
