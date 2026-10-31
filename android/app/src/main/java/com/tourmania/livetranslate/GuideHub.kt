package com.tourmania.livetranslate

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

data class MicOption(val id: Int, val label: String)

data class StopOption(val id: String, val name: String, val ready: String)

object GuideHub {
    var status by mutableStateOf("offline")
    var detail by mutableStateOf("Open a tour, then start the broadcast.")
    var caption by mutableStateOf("")
    var guests by mutableStateOf(listOf<String>())
    var questions by mutableStateOf(listOf<String>())
    var mics by mutableStateOf(listOf<MicOption>())
    var stops by mutableStateOf(listOf<StopOption>())
    var broadcasting by mutableStateOf(false)
    var code by mutableStateOf("")
    var joinUrl by mutableStateOf("")
    var error by mutableStateOf("")

    @Volatile var sendText: ((String) -> Boolean)? = null
    @Volatile var selectMic: ((Int) -> Unit)? = null

    private val main by lazy { Handler(Looper.getMainLooper()) }

    fun onMain(block: GuideHub.() -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }
}
