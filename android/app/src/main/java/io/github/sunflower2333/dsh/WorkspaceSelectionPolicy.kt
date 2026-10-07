package io.github.sunflower2333.dsh

import java.io.File

/** Android framework independent rules for returning a real Node/Bash cwd. */
internal object WorkspaceSelectionPolicy {
    const val EXTERNAL_STORAGE_PROVIDER = "com.android.externalstorage.documents"
    private val requestPattern = Regex("[A-Za-z0-9_-]{16,80}")
    private val volumePattern = Regex("[A-Za-z0-9-]{1,80}")

    data class Volume(val id: String, val directory: File)
    data class Selection(val volumeDirectory: File, val directory: File)

    fun validRequestId(value: String) = requestPattern.matches(value)

    fun selection(authority: String?, documentId: String, volumes: List<Volume>): Selection? {
        if (authority != EXTERNAL_STORAGE_PROVIDER) return null
        val separator = documentId.indexOf(':')
        if (separator <= 0 || separator == documentId.lastIndex) return null
        val volumeId = documentId.substring(0, separator)
        if (!volumePattern.matches(volumeId)) return null
        val relative = documentId.substring(separator + 1)
        if (relative.any { it == '\\' || it.code < 32 || it.code == 127 }) return null
        val parts = relative.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) return null
        if (parts.size >= 2 && parts[0].equals("Android", ignoreCase = true) &&
            (parts[1].equals("data", ignoreCase = true) || parts[1].equals("obb", ignoreCase = true))) return null
        val volume = volumes.singleOrNull { it.id.equals(volumeId, ignoreCase = true) } ?: return null
        return Selection(volume.directory, File(volume.directory, relative))
    }

    /** Reject a folder symlink or any symlink component escaping its mapped volume. */
    fun canonicalDirectory(selection: Selection): File? = runCatching {
        val volume = selection.volumeDirectory.canonicalFile
        val proposed = selection.directory.absoluteFile.toPath().normalize().toFile()
        val expected = File(volume, selection.volumeDirectory.absoluteFile.toPath()
            .relativize(proposed.toPath()).toString()).toPath().normalize().toFile()
        val canonical = selection.directory.canonicalFile
        if (canonical == volume || canonical != expected ||
            !canonical.toPath().startsWith(volume.toPath()) || !canonical.isDirectory || !canonical.canRead()) null
        else canonical
    }.getOrNull()

    /** Results from an old runtime or another page cannot affect the current UI. */
    fun canDeliver(requestId: String?, requestedReadyUrl: String?, currentReadyUrl: String?, pageUrl: String?,
                   ready: Boolean): Boolean = validRequestId(requestId.orEmpty()) && ready &&
        requestedReadyUrl != null && requestedReadyUrl == currentReadyUrl &&
        WebNavigation.isCurrentOrigin(pageUrl, currentReadyUrl)
}
