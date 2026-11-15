package online.kovanica.node

import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** One HTTP reply. A transport failure has a null status. */
data class HttpReply(val status: Int?, val body: String, val failure: String?)

object NodeHttp {
    const val DEFAULT_RPC: String = "https://rpc-testnet.kovanica.online"

    fun healthUrl(base: String): String = join(base, "health")

    fun rpcUrl(base: String): String {
        val trimmed = base.trim().trimEnd('/')
        return if (trimmed.endsWith("/rpc")) trimmed else "$trimmed/rpc"
    }

    fun get(url: String): HttpReply = exchange("GET", url, null)

    fun postJson(url: String, json: String): HttpReply = exchange("POST", url, json)

    fun rpc(base: String, method: String, paramsJson: String): HttpReply {
        val body = """{"jsonrpc":"2.0","id":1,"method":"$method","params":$paramsJson}"""
        return postJson(rpcUrl(base), body)
    }

    private fun join(base: String, leaf: String): String {
        val trimmed = base.trim().trimEnd('/')
        val root = if (trimmed.endsWith("/rpc")) trimmed.removeSuffix("/rpc") else trimmed
        return "$root/$leaf"
    }

    private fun exchange(method: String, url: String, json: String?): HttpReply {
        return try {
            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 12_000
                readTimeout = 20_000
                instanceFollowRedirects = true
                if (json != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (json != null) {
                connection.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            HttpReply(status, text, null)
        } catch (error: Exception) {
            HttpReply(null, "", error.javaClass.simpleName)
        }
    }
}

object DiskUse {
    fun bytes(root: File): Long {
        if (!root.exists()) return 0
        if (root.isFile) return root.length()
        var total = 0L
        val children = root.listFiles() ?: return 0
        for (child in children) total += bytes(child)
        return total
    }

    fun format(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val kib = bytes / 1024.0
        if (kib < 1024) return String.format(java.util.Locale.US, "%.1f KiB", kib)
        val mib = kib / 1024.0
        if (mib < 1024) return String.format(java.util.Locale.US, "%.1f MiB", mib)
        return String.format(java.util.Locale.US, "%.2f GiB", mib / 1024.0)
    }
}
