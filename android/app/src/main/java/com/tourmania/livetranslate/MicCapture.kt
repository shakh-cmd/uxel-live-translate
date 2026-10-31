package com.tourmania.livetranslate

import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.util.UUID

/**
 * 16 kHz mono PCM with a simple energy VAD. Silence is not forwarded.
 * The end-of-speech frame is empty and marked end=true, matching the web guide.
 */
class MicCapture(
    private val device: () -> AudioDeviceInfo?,
    private val running: () -> Boolean,
    private val onFrame: (pcm: ByteArray, utteranceId: String, seq: Int, end: Boolean) -> Unit,
) {
    fun loop() {
        var recorder: AudioRecord? = null
        var speaking = false
        var silenceMs = 0
        var utteranceId = ""
        var seq = 0
        var openId = Int.MIN_VALUE
        val buffer = ByteArray(1600)
        try {
            while (running()) {
                val preferred = device()
                val wanted = preferred?.id ?: -1
                if (recorder == null || wanted != openId) {
                    runCatching { recorder?.stop() }
                    recorder?.release()
                    recorder = open(preferred)
                    recorder.startRecording()
                    openId = wanted
                }
                val read = recorder.read(buffer, 0, buffer.size)
                if (read <= 0) continue
                val hot = rms(buffer, read) >= 0.02
                if (hot) {
                    if (!speaking) {
                        speaking = true
                        utteranceId = UUID.randomUUID().toString()
                        seq = 0
                    }
                    silenceMs = 0
                    seq += 1
                    onFrame(buffer.copyOf(read), utteranceId, seq, false)
                } else if (speaking) {
                    silenceMs += 50
                    if (silenceMs >= 700) {
                        speaking = false
                        silenceMs = 0
                        seq += 1
                        onFrame(ByteArray(0), utteranceId, seq, true)
                    }
                }
            }
        } finally {
            if (speaking && utteranceId.isNotEmpty()) onFrame(ByteArray(0), utteranceId, seq + 1, true)
            runCatching { recorder?.stop() }
            recorder?.release()
        }
    }

    private fun open(preferred: AudioDeviceInfo?): AudioRecord {
        val min = AudioRecord.getMinBufferSize(16_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val recorder = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.MIC)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(16_000)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(min, 3200) * 2)
            .build()
        if (preferred != null) recorder.setPreferredDevice(preferred)
        return recorder
    }

    private fun rms(pcm: ByteArray, length: Int): Double {
        var energy = 0.0
        var count = 0
        var i = 0
        while (i + 1 < length) {
            val sample = (pcm[i].toInt() and 0xff) or (pcm[i + 1].toInt() shl 8)
            val value = sample.toShort().toInt()
            energy += value * value
            count += 1
            i += 2
        }
        if (count == 0) return 0.0
        return Math.sqrt(energy / count) / 32768.0
    }
}
