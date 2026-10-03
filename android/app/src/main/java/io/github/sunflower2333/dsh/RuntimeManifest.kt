package io.github.sunflower2333.dsh

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/** The small, versioned contract emitted by the runtime packaging script. */
data class RuntimeManifest(
    val schemaVersion: Int,
    val version: String,
    val executable: String,
    val entrypoint: String,
    val arguments: List<String>,
    val host: String,
    val port: Int,
    val webPath: String,
) {
    companion object {
        private const val SCHEMA = 1

        fun parse(raw: String): RuntimeManifest {
            val root = JSONObject(raw)
            require(root.optInt("schemaVersion", -1) == SCHEMA) { "unsupported runtime manifest schema" }
            val version = root.getString("version").trim()
            require(version.matches(Regex("[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}"))) { "invalid runtime version" }
            val node = root.getJSONObject("node")
            val executable = node.getString("executable").trim()
            require(executable == "libdsh_node.so") { "runtime executable must be libdsh_node.so" }
            val entrypoint = node.getString("entrypoint").trim()
            requireRelativePath(entrypoint)
            val args = node.optJSONArray("arguments")?.toStringList() ?: emptyList()
            val web = root.getJSONObject("web")
            val host = web.optString("host", "127.0.0.1")
            require(host == "127.0.0.1") { "DSH must bind to loopback" }
            val port = web.optInt("port", 0)
            require(port in 0..65535) { "invalid web port" }
            val path = web.optString("path", "/")
            require(path.startsWith('/') && !path.contains("\\") && !path.contains("..")) { "invalid web path" }
            return RuntimeManifest(SCHEMA, version, executable, entrypoint, args, host, port, path)
        }

        fun requireRelativePath(path: String) {
            require(path.isNotBlank() && !path.startsWith('/') && !path.contains('\\')) { "path must be relative" }
            require(path.split('/').none { it.isEmpty() || it == "." || it == ".." }) { "unsafe relative path" }
        }

        private fun JSONArray.toStringList(): List<String> = buildList(length()) {
            for (i in 0 until length()) {
                val value = getString(i)
                require(value.length <= 4096) { "runtime argument is too long" }
                add(value)
            }
        }
    }
}

object LocalUrl {
    /** Accept only URLs produced by the local DSH server. */
    fun isAllowed(url: String, expectedPath: String = "/"): Boolean {
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        if (uri.scheme != "http" || uri.host != "127.0.0.1" || uri.userInfo != null || uri.port !in 1..65535) return false
        val path = uri.path ?: "/"
        return path == expectedPath || path.startsWith(expectedPath.trimEnd('/') + "/")
    }
}
