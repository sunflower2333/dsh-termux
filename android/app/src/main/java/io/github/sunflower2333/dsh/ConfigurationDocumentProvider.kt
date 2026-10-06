package io.github.sunflower2333.dsh

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileNotFoundException

/** A grant exposes exactly the active Web profile's patch, never its containing directory. */
class ConfigurationDocumentProvider : ContentProvider() {
    override fun onCreate() = true

    private fun document(uri: Uri): File {
        val app = context ?: throw FileNotFoundException("Configuration unavailable")
        if (!ConfigurationDocumentPolicy.isAllowedUri(uri.toString(), app.packageName)) {
            throw FileNotFoundException("Unknown configuration document")
        }
        val root = app.filesDir.canonicalFile
        val relative = ConfigurationDocumentPolicy.RELATIVE_PATH
        var current = root
        val expectedUid = android.os.Process.myUid()
        val components = relative.split('/')
        for ((index, component) in listOf("").plus(components).withIndex()) {
            if (component.isNotEmpty()) current = File(current, component)
            val stat = Os.lstat(current.path)
            if (stat.st_uid != expectedUid || OsConstants.S_ISLNK(stat.st_mode) ||
                (index < components.size && !OsConstants.S_ISDIR(stat.st_mode)) ||
                (index == components.size && !OsConstants.S_ISREG(stat.st_mode))) {
                throw FileNotFoundException("Configuration document is not an owned regular file")
            }
        }
        if (current.canonicalFile != File(root, relative)) {
            throw FileNotFoundException("Configuration path changed")
        }
        return current
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val file = document(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply {
            addRow(columns.map { column -> when (column) {
                OpenableColumns.DISPLAY_NAME -> ConfigurationDocumentPolicy.FILENAME
                OpenableColumns.SIZE -> file.length()
                else -> null
            } }.toTypedArray())
        }
    }

    override fun getType(uri: Uri): String {
        document(uri)
        return "text/plain"
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val file = document(uri)
        val requested = ParcelFileDescriptor.parseMode(mode)
        val access = requested and ParcelFileDescriptor.MODE_READ_WRITE
        var flags = when (access) {
            ParcelFileDescriptor.MODE_READ_ONLY -> OsConstants.O_RDONLY
            ParcelFileDescriptor.MODE_WRITE_ONLY -> OsConstants.O_WRONLY
            ParcelFileDescriptor.MODE_READ_WRITE -> OsConstants.O_RDWR
            else -> throw FileNotFoundException("Unsupported configuration file mode")
        }
        if (requested and ParcelFileDescriptor.MODE_APPEND != 0) flags = flags or OsConstants.O_APPEND
        // The provider never creates a file. Validate the opened descriptor before truncating it.
        val descriptor = Os.open(file.path, flags or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
        try {
            val stat = Os.fstat(descriptor)
            if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_uid != android.os.Process.myUid()) {
                throw FileNotFoundException("Configuration document ownership changed")
            }
            if (requested and ParcelFileDescriptor.MODE_TRUNCATE != 0) Os.ftruncate(descriptor, 0)
            return ParcelFileDescriptor.dup(descriptor)
        } finally {
            Os.close(descriptor)
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) =
        throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) =
        throw UnsupportedOperationException()

    companion object {
        fun uri(context: Context): Uri = Uri.parse(ConfigurationDocumentPolicy.uri(context.packageName))
    }
}

internal object ConfigurationDocumentPolicy {
    const val RELATIVE_PATH = "dsh-home/.dsh/profiles/web/cordis.patch.yml"
    const val FILENAME = "cordis.patch.yml"

    fun uri(packageName: String): String = "content://$packageName.configuration/configuration"

    fun isAllowedUri(value: String, packageName: String): Boolean = value == uri(packageName)
}
