package online.kovanica.node

/**
 * Decides whether this start stays on the full node or switches to the
 * pruned light profile. Each failed check has its own reason. The caller
 * persists that reason and can clear it when the user retries full mode.
 */
object Fallback {
    const val MIN_FREE_DISK_BYTES: Long = 512L * 1024L * 1024L
    const val MIN_TOTAL_RAM_BYTES: Long = 1536L * 1024L * 1024L
    const val CRASH_LIMIT: Int = 3

    val SUPPORTED_ABIS: Set<String> = setOf("arm64-v8a", "x86_64")

    data class Report(
        val freeDiskBytes: Long,
        val totalRamBytes: Long,
        val abi: String,
        val binaryPresent: Boolean,
        val processStarted: Boolean,
        val reachedPeer: Boolean,
        val recentCrashes: Int,
    )

    data class Decision(
        val fullMode: Boolean,
        val reason: String?,
    )

    fun decide(report: Report): Decision {
        if (report.freeDiskBytes < MIN_FREE_DISK_BYTES) {
            return light("Not enough free disk for a full node (need 512 MiB).")
        }
        if (report.totalRamBytes < MIN_TOTAL_RAM_BYTES) {
            return light("Not enough RAM for a full node (need 1536 MiB).")
        }
        if (report.abi !in SUPPORTED_ABIS) {
            return light("This device ABI (${report.abi}) has no full node build.")
        }
        if (!report.binaryPresent) {
            return light("The full node executable is not in this build.")
        }
        if (!report.processStarted) {
            return light("The full node process did not stay up.")
        }
        if (!report.reachedPeer) {
            return light("The full node did not reach a peer in time.")
        }
        if (report.recentCrashes >= CRASH_LIMIT) {
            return light("The full node stopped repeatedly, so light mode is in use.")
        }
        return Decision(fullMode = true, reason = null)
    }

    /**
     * Checks that run before the process is started: free disk, RAM, ABI,
     * the packaged executable, and the crash count. Whether the process stays
     * up and reaches a peer is [decide] after the start attempt.
     */
    fun readyToStart(report: Report): Decision =
        decide(report.copy(processStarted = true, reachedPeer = true))

    private fun light(reason: String) = Decision(fullMode = false, reason = reason)
}

/** Official kovanica testnet bootstrap, reduced to the seed1 DNS name. */
object Bootstrap {
    const val SEED1: String = "seed1.kovanica.online:8000"

    /**
     * Keep only the seed1 DNS name. Drop IP literals and every other host.
     * L1 docs at the pinned commit also name further seed hosts; those are
     * not carried in this list.
     */
    fun select(candidates: List<String>): List<String> {
        val kept = LinkedHashSet<String>()
        for (raw in candidates) {
            val item = raw.trim()
            if (item.isEmpty()) continue
            if (isIpLiteral(item)) continue
            if (isSeed1(item)) kept.add(SEED1)
        }
        if (kept.isEmpty() && candidates.isEmpty()) {
            kept.add(SEED1)
        }
        return kept.toList()
    }

    fun official(): List<String> = listOf(SEED1)

    private fun isSeed1(value: String): Boolean {
        val host = value
            .removePrefix("/dns4/")
            .removePrefix("/dns/")
            .substringBefore("/")
            .substringBefore(":")
            .trim()
            .lowercase()
        return host == "seed1.kovanica.online"
    }

    private fun isIpLiteral(value: String): Boolean {
        val body = value.substringAfter("/ip4/", "").substringBefore("/")
            .ifEmpty { value.substringAfter("/ip6/", "").substringBefore("/") }
            .ifEmpty { value.substringBefore(":").trim('[', ']') }
        if (body.isEmpty()) return false
        if (body.count { it == '.' } == 3 && body.all { it.isDigit() || it == '.' }) return true
        return body.contains(":") && body.all { it.isDigit() || it == ':' || it == '.' }
    }
}
