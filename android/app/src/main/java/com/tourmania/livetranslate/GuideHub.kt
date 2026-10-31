package com.tourmania.livetranslate

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

data class MicOption(val id: Int, val label: String)

/** A pre-recorded stop. Only stops with [ready] > 0 have audio a guest can hear. */
data class StopOption(val id: String, val name: String, val ready: Int, val total: Int, val failure: String = "")

data class GuestInfo(val id: String, val language: String?)

/** A guest question, translated to English. [wavPath] is the English voice, saved in the app cache. */
data class QuestionItem(
    val id: Long,
    val guestId: String,
    val language: String,
    val original: String,
    val english: String,
    val wavPath: String?,
    val receivedAt: Long,
)

/** What the big status chip shows. */
enum class Link { OFFLINE, CONNECTING, CONNECTED, RECONNECTING }

object GuideHub {
    var link by mutableStateOf(Link.OFFLINE)
    /** "lagging" from the server: connected, but slow. */
    var slow by mutableStateOf(false)
    var detail by mutableStateOf("")
    var caption by mutableStateOf("")
    var guests by mutableStateOf(listOf<GuestInfo>())
    /** Languages whose translation is playing right now. */
    var speaking by mutableStateOf(setOf<String>())
    /** Guest ids who are asking a question right now. */
    var asking by mutableStateOf(setOf<String>())
    var questions by mutableStateOf(listOf<QuestionItem>())
    var playingQuestion by mutableStateOf<Long?>(null)
    var mics by mutableStateOf(listOf<MicOption>())
    var selectedMic by mutableStateOf(-1)
    var stops by mutableStateOf(listOf<StopOption>())
    var preparingStop by mutableStateOf(false)
    /** stopId -> time the guide last tapped Play, so a double tap does not play twice. */
    var stopPlayedAt by mutableStateOf(mapOf<String, Long>())
    var broadcasting by mutableStateOf(false)
    var code by mutableStateOf("")
    var joinUrl by mutableStateOf("")
    var openingTour by mutableStateOf(false)
    var error by mutableStateOf("")

    @Volatile var sendText: ((String) -> Boolean)? = null
    @Volatile var playQuestion: ((QuestionItem) -> Unit)? = null

    private val main by lazy { Handler(Looper.getMainLooper()) }

    fun onMain(block: GuideHub.() -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }

    fun forgetTour() {
        code = ""
        joinUrl = ""
        guests = emptyList()
        stops = emptyList()
        questions = emptyList()
        caption = ""
        speaking = emptySet()
        asking = emptySet()
    }
}

/** English names for the language codes the server offers. */
fun languageName(code: String?): String = when (code) {
    null, "" -> "Choosing a language"
    "de" -> "German"
    "es" -> "Spanish"
    "fr" -> "French"
    "it" -> "Italian"
    "ru" -> "Russian"
    "ar" -> "Arabic"
    "tr" -> "Turkish"
    "pl" -> "Polish"
    "ms" -> "Malay"
    "ja" -> "Japanese"
    "zh" -> "Chinese"
    "pt" -> "Portuguese"
    else -> code.uppercase()
}
