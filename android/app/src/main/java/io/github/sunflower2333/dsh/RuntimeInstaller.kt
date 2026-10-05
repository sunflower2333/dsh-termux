package io.github.sunflower2333.dsh

import android.content.Context
import android.system.Os
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/** Installs the immutable JS runtime from the APK asset into app-private storage. */
object RuntimeInstaller {
    private const val ASSET_ROOT = "runtime"
    private const val ZIP_ASSET = "$ASSET_ROOT/runtime.zip"

    fun loadManifest(context: Context): RuntimeManifest {
        context.assets.open("$ASSET_ROOT/manifest.json").use { return RuntimeManifest.parse(it.readBytes().toString(Charsets.UTF_8)) }
    }

    @Synchronized
    fun ensureInstalled(context: Context, manifest: RuntimeManifest): File {
        checkNotInterrupted()
        val root = File(context.filesDir, "dsh-runtime/${manifest.version}")
        val marker = File(root, ".installed")
        val bundleSha256 = manifest.bundleSha256
            ?: context.assets.open(ZIP_ASSET).use { sha256(it) }
        val identity = "${manifest.version}:$bundleSha256"
        if (!marker.isFile || marker.readText() != identity || !File(root, manifest.entrypoint).isFile) {
            context.assets.open(ZIP_ASSET).use {
                check(sha256(it) == bundleSha256) { "runtime bundle checksum mismatch" }
            }
            root.deleteRecursively()
            check(root.mkdirs() || root.isDirectory) { "unable to create runtime directory" }
            context.assets.open(ZIP_ASSET).use { unzipSafely(it, root) }
            checkNotInterrupted()
            check(File(root, manifest.entrypoint).isFile) { "runtime entrypoint missing after install" }
            marker.writeText(identity)
        }
        return root
    }

    /** Command names resolve to package-manager-installed executables. */
    fun ensureCommandDirectory(context: Context, manifest: RuntimeManifest): File {
        val directory = File(context.filesDir, "dsh-bin")
        check(directory.mkdirs() || directory.isDirectory) { "unable to create command directory" }
        for ((command, library) in mapOf(
            "node" to manifest.executable,
            "bash" to "libdsh_bash.so",
            "esbuild" to "libdsh_esbuild.so",
        )) {
            val executable = File(context.applicationInfo.nativeLibraryDir, library)
            check(executable.isFile && executable.canExecute()) { "missing executable $library" }
            val link = File(directory, command)
            // The native directory changes with APK upgrades. Rebind stale
            // links without copying executables into writable app data.
            if (runCatching { Os.readlink(link.absolutePath) }.getOrNull() != executable.absolutePath) {
                link.delete()
                Os.symlink(executable.absolutePath, link.absolutePath)
            }
        }
        return directory
    }

    internal fun sha256(input: InputStream): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        while (true) {
            checkNotInterrupted()
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /** Reject absolute paths, `..`, symlinks, and entries escaping [destination]. */
    internal fun unzipSafely(input: InputStream, destination: File) {
        val canonicalRoot = destination.canonicalFile
        ZipInputStream(input.buffered()).use { zip ->
            while (true) {
                checkNotInterrupted()
                val entry = zip.nextEntry ?: break
                // ZIP directory entries conventionally end in '/'; normalize
                // that marker before validating the relative path.
                val name = entry.name.trimEnd('/')
                check(name.isNotEmpty()) { "runtime archive contains an empty entry" }
                RuntimeManifest.requireRelativePath(name)
                val output = File(canonicalRoot, name).canonicalFile
                check(output.path == canonicalRoot.path || output.path.startsWith(canonicalRoot.path + File.separator)) {
                    "runtime archive entry escapes install directory"
                }
                if (entry.isDirectory) {
                    output.mkdirs()
                } else {
                    output.parentFile?.mkdirs()
                    output.outputStream().use { zip.copyTo(it) }
                }
                zip.closeEntry()
            }
        }
    }

    private fun checkNotInterrupted() {
        if (Thread.currentThread().isInterrupted) throw InterruptedException("DSH runtime installation cancelled")
    }
}
