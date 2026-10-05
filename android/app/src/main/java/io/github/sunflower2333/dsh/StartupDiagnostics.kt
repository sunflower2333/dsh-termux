package io.github.sunflower2333.dsh

import java.io.File
import java.io.Reader
import java.util.ArrayDeque

/** A bounded, shareable tail of process output; authentication URLs stay private. */
internal class StartupDiagnostics(
    private val logFile: File? = null,
    private val maxLines: Int = 80,
    private val maxCharacters: Int = 16_384,
) {
    private val lines = ArrayDeque<String>()
    private var characters = 0

    init {
        require(maxLines > 0 && maxCharacters > 0)
        persist()
    }

    @Synchronized
    fun append(line: String): String {
        val safe = sanitize(line).takeLast(maxCharacters - 1)
        lines.addLast(safe)
        characters += safe.length + 1
        while (lines.size > maxLines || characters > maxCharacters) {
            characters -= lines.removeFirst().length + 1
        }
        persist()
        return safe
    }

    @Synchronized
    fun tail(): String = lines.joinToString("\n")

    private fun persist() {
        // A full or unavailable cache must not prevent DSH from starting.
        logFile?.let { file -> runCatching { file.writeText(tail()) } }
    }

    companion object {
        private const val MAX_RAW_LINE_CHARACTERS = 8_192
        private val ansiOsc = Regex("\u001B\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)")
        private val ansiCsi = Regex("\u001B\\[[0-?]*[ -/]*[@-~]")
        private val ansiEscape = Regex("\u001B[ -/]*[@-~]")
        private val urlToken = Regex("([?&#](?:token|access_token|auth_token|api_key)=)[^\\s&#]+", RegexOption.IGNORE_CASE)

        internal fun sanitize(value: String): String {
            val plain = value.replace(ansiOsc, "").replace(ansiCsi, "").replace(ansiEscape, "")
                .filter { it == '\n' || it == '\t' || !it.isISOControl() }
            return urlToken.replace(plain) { "${it.groupValues[1]}[REDACTED]" }
        }

        /** Unlike BufferedReader.readLine(), even a child that never emits LF is bounded. */
        internal fun readLines(reader: Reader, onLine: (String) -> Unit) {
            val buffer = CharArray(2_048)
            val line = StringBuilder(MAX_RAW_LINE_CHARACTERS)
            var truncated = false
            fun emit() {
                onLine((if (truncated) "[…truncated…] " else "") + line.toString().trimEnd('\r'))
                line.setLength(0)
                truncated = false
            }
            while (true) {
                val count = reader.read(buffer)
                if (count == -1) break
                for (index in 0 until count) {
                    val char = buffer[index]
                    if (char == '\n') {
                        emit()
                    } else {
                        if (line.length == MAX_RAW_LINE_CHARACTERS) {
                            line.delete(0, MAX_RAW_LINE_CHARACTERS / 2)
                            truncated = true
                        }
                        line.append(char)
                    }
                }
            }
            if (line.isNotEmpty()) emit()
        }
    }
}
