package io.github.sunflower2333.dsh

import android.content.Context
import java.io.File
import java.io.InputStream
import java.util.zip.ZipInputStream

/** Installs the immutable JS runtime from the APK asset into app-private storage. */
object RuntimeInstaller {
    private const val ASSET_ROOT = "runtime"
    private const val ZIP_ASSET = "$ASSET_ROOT/runtime.zip"

    fun loadManifest(context: Context): RuntimeManifest {
        context.assets.open("$ASSET_ROOT/manifest.json").use { return RuntimeManifest.parse(it.readBytes().toString(Charsets.UTF_8)) }
    }

    fun ensureInstalled(context: Context, manifest: RuntimeManifest): File {
        val root = File(context.filesDir, "dsh-runtime/${manifest.version}")
        val marker = File(root, ".installed")
        if (!marker.isFile || marker.readText() != manifest.version || !File(root, manifest.entrypoint).isFile) {
            root.deleteRecursively()
            root.mkdirs()
            context.assets.open(ZIP_ASSET).use { unzipSafely(it, root) }
            check(File(root, manifest.entrypoint).isFile) { "runtime entrypoint missing after install" }
            marker.writeText(manifest.version)
        }
        // ZipInputStream does not restore Unix mode bits. Run this on every
        // launch so an upgrade from an older APK also repairs existing files.
        markRuntimeExecutables(root)
        return root
    }

    /** Reject absolute paths, `..`, symlinks, and entries escaping [destination]. */
    internal fun unzipSafely(input: InputStream, destination: File) {
        val canonicalRoot = destination.canonicalFile
        ZipInputStream(input.buffered()).use { zip ->
            while (true) {
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

    private fun markRuntimeExecutables(root: File) {
        root.walkTopDown()
            .filter { it.isFile && it.parentFile?.name == "bin" }
            .forEach { file ->
                check(file.setExecutable(true, false)) {
                    "unable to make runtime tool executable: ${file.relativeTo(root)}"
                }
            }
    }
}
