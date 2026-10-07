package io.github.sunflower2333.dsh

import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileDescriptor
import java.util.UUID

internal enum class WorkspaceStorageFailure { PERMISSION_REQUIRED, UNSUPPORTED_PROVIDER, INVALID_FOLDER, NOT_WRITABLE }
internal class WorkspaceStorageException(val failure: WorkspaceStorageFailure) : Exception(failure.name)

/** SAF selects a folder; only Android's separate all-files capability authorizes native filesystem IO. */
internal object WorkspaceStorage {
    fun validate(context: Context, uri: Uri): File {
        if (!Environment.isExternalStorageManager()) throw WorkspaceStorageException(WorkspaceStorageFailure.PERMISSION_REQUIRED)
        if (uri.scheme != "content" || uri.authority != WorkspaceSelectionPolicy.EXTERNAL_STORAGE_PROVIDER ||
            uri.query != null || uri.fragment != null) throw WorkspaceStorageException(WorkspaceStorageFailure.UNSUPPORTED_PROVIDER)
        if (uri.pathSegments.size != 2 || uri.pathSegments[0] != "tree")
            throw WorkspaceStorageException(WorkspaceStorageFailure.INVALID_FOLDER)
        val documentId = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()
            ?: throw WorkspaceStorageException(WorkspaceStorageFailure.INVALID_FOLDER)
        val volumes = context.getSystemService(StorageManager::class.java).storageVolumes.mapNotNull { volume ->
            val directory = volume.directory ?: return@mapNotNull null
            val id = if (volume.isPrimary) "primary" else volume.uuid ?: return@mapNotNull null
            WorkspaceSelectionPolicy.Volume(id, directory)
        }
        val selection = WorkspaceSelectionPolicy.selection(uri.authority, documentId, volumes)
            ?: throw WorkspaceStorageException(WorkspaceStorageFailure.INVALID_FOLDER)
        val folder = WorkspaceSelectionPolicy.canonicalDirectory(selection)
            ?: throw WorkspaceStorageException(WorkspaceStorageFailure.INVALID_FOLDER)
        proveWritable(folder)
        // A removable volume or special permission can change while probing.
        if (!Environment.isExternalStorageManager()) throw WorkspaceStorageException(WorkspaceStorageFailure.PERMISSION_REQUIRED)
        if (WorkspaceSelectionPolicy.canonicalDirectory(selection) != folder)
            throw WorkspaceStorageException(WorkspaceStorageFailure.INVALID_FOLDER)
        return folder
    }

    private fun proveWritable(folder: File) {
        val probe = File(folder, ".dsh-workspace-check-${UUID.randomUUID()}")
        val payload = UUID.randomUUID().toString().toByteArray(Charsets.UTF_8)
        var descriptor: FileDescriptor? = null
        var identity: android.system.StructStat? = null
        try {
            // Exclusive/no-follow open never truncates an existing file or follows a replaced link.
            val fd = Os.open(probe.path, OsConstants.O_RDWR or OsConstants.O_CREAT or
                OsConstants.O_EXCL or OsConstants.O_NOFOLLOW, 0x180)
            descriptor = fd
            val owned = Os.fstat(fd)
            identity = owned
            if (!OsConstants.S_ISREG(owned.st_mode) || probe.canonicalFile.parentFile != folder)
                throw WorkspaceStorageException(WorkspaceStorageFailure.NOT_WRITABLE)
            var written = 0
            while (written < payload.size) {
                val count = Os.write(fd, payload, written, payload.size - written)
                if (count <= 0) throw WorkspaceStorageException(WorkspaceStorageFailure.NOT_WRITABLE)
                written += count
            }
            Os.fsync(fd)
            Os.lseek(fd, 0, OsConstants.SEEK_SET)
            val observed = ByteArray(payload.size)
            var read = 0
            while (read < observed.size) {
                val count = Os.read(fd, observed, read, observed.size - read)
                if (count <= 0) throw WorkspaceStorageException(WorkspaceStorageFailure.NOT_WRITABLE)
                read += count
            }
            val current = Os.lstat(probe.path)
            if (!observed.contentEquals(payload) || !OsConstants.S_ISREG(current.st_mode) ||
                current.st_dev != owned.st_dev || current.st_ino != owned.st_ino)
                throw WorkspaceStorageException(WorkspaceStorageFailure.NOT_WRITABLE)
            Os.remove(probe.path)
            identity = null
        } catch (error: Exception) {
            if (error is WorkspaceStorageException) throw error
            throw WorkspaceStorageException(WorkspaceStorageFailure.NOT_WRITABLE)
        } finally {
            // Only the unique inode we created is eligible for cleanup.
            identity?.let { owned -> runCatching {
                val current = Os.lstat(probe.path)
                if (OsConstants.S_ISREG(current.st_mode) &&
                    current.st_dev == owned.st_dev && current.st_ino == owned.st_ino) Os.remove(probe.path)
            } }
            descriptor?.let { runCatching { Os.close(it) } }
        }
    }
}
