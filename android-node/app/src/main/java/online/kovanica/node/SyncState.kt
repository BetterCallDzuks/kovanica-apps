package online.kovanica.node

/**
 * What the node screen shows for sync.
 *
 * HTTP 503 from `/health` is stalled, including a commit stall whose component
 * lines still say running. A failed read is unavailable. HTTP 200 follows
 * `kovanica_syncStatus.catchingUp`.
 */
enum class SyncPhase {
    SYNCING,
    SYNCED,
    STALLED,
    UNAVAILABLE,
}

object SyncState {
    fun label(phase: SyncPhase): String = when (phase) {
        SyncPhase.SYNCING -> "syncing"
        SyncPhase.SYNCED -> "synced"
        SyncPhase.STALLED -> "stalled"
        SyncPhase.UNAVAILABLE -> "unavailable"
    }

    fun fromHealth(httpStatus: Int?, catchingUp: Boolean?): SyncPhase {
        if (httpStatus == null) return SyncPhase.UNAVAILABLE
        if (httpStatus == 503) return SyncPhase.STALLED
        if (httpStatus != 200) return SyncPhase.UNAVAILABLE
        return if (catchingUp == true) SyncPhase.SYNCING else SyncPhase.SYNCED
    }
}

/** Fields the screen reads from a JSON-RPC body. Missing fields stay null. */
data class RpcSnapshot(
    val httpStatus: Int?,
    val catchingUp: Boolean?,
    val committedHeight: Long?,
    val peerCount: Long?,
    val tipHash: String?,
    val chainId: Long?,
    val balanceAtoms: Long?,
    val feeRate: Long?,
    val error: String?,
)

object RpcJson {
    fun snapshot(healthStatus: Int?, healthBody: String?, rpcBody: String?): RpcSnapshot {
        val health = healthBody.orEmpty()
        val rpc = rpcBody.orEmpty()
        val catching = boolField(rpc, "catchingUp") ?: boolField(health, "catchingUp")
        return RpcSnapshot(
            httpStatus = healthStatus,
            catchingUp = catching,
            committedHeight = longField(rpc, "committedHeight")
                ?: longField(rpc, "localHeight"),
            peerCount = longField(rpc, "peerCount") ?: longField(health, "peer_count"),
            tipHash = firstHash(rpc),
            chainId = longField(rpc, "chain_id") ?: longField(rpc, "chainId"),
            balanceAtoms = longField(rpc, "balance"),
            feeRate = longField(rpc, "feeRate"),
            error = stringField(rpc, "message"),
        )
    }

    fun boolField(json: String, name: String): Boolean? {
        val match = Regex(""""$name"\s*:\s*(true|false)""").find(json) ?: return null
        return match.groupValues[1] == "true"
    }

    fun longField(json: String, name: String): Long? {
        val match = Regex(""""$name"\s*:\s*(-?\d+)""").find(json) ?: return null
        return match.groupValues[1].toLongOrNull()
    }

    fun stringField(json: String, name: String): String? {
        val match = Regex(""""$name"\s*:\s*"([^"]*)"""").find(json) ?: return null
        return match.groupValues[1]
    }

    /** First 0x-prefixed or bare hex hash of at least 8 digits. */
    fun firstHash(json: String): String? {
        val match = Regex("""(?i)"(?:tips|hash|powHash)"\s*:\s*\[?\s*"(0x)?([0-9a-f]{8,})"""").find(json)
            ?: return null
        return match.groupValues[2]
    }

    /**
     * The JSON value of the first `"result"` field when it is an object,
     * an array, or a quoted string. `null` and numbers return null.
     */
    fun resultValue(json: String): String? {
        val key = Regex(""""result"\s*:""").find(json) ?: return null
        var index = key.range.last + 1
        while (index < json.length && json[index].isWhitespace()) index++
        if (index >= json.length || json.startsWith("null", index)) return null
        val start = json[index]
        if (start == '"') {
            val end = indexOfStringEnd(json, index)
            if (end < 0) return null
            return json.substring(index + 1, end)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
        }
        if (start != '{' && start != '[') return null
        val close = if (start == '{') '}' else ']'
        var depth = 0
        var inString = false
        var escaped = false
        for (cursor in index until json.length) {
            val char = json[cursor]
            if (inString) {
                if (escaped) escaped = false
                else if (char == '\\') escaped = true
                else if (char == '"') inString = false
                continue
            }
            if (char == '"') {
                inString = true
                continue
            }
            if (char == start) depth++
            if (char == close) {
                depth--
                if (depth == 0) return json.substring(index, cursor + 1)
            }
        }
        return null
    }

    private fun indexOfStringEnd(json: String, openQuote: Int): Int {
        var escaped = false
        for (cursor in openQuote + 1 until json.length) {
            val char = json[cursor]
            if (escaped) {
                escaped = false
                continue
            }
            if (char == '\\') escaped = true
            else if (char == '"') return cursor
        }
        return -1
    }

    /** A JSON-RPC `result` that is a decimal or 0x quantity. */
    fun quantityResult(json: String): Long? {
        val match = Regex(""""result"\s*:\s*("?)(0x[0-9a-fA-F]+|\d+)\1""").find(json) ?: return null
        val raw = match.groupValues[2]
        return if (raw.startsWith("0x") || raw.startsWith("0X")) {
            raw.drop(2).toLongOrNull(16)
        } else {
            raw.toLongOrNull()
        }
    }

    fun shortHash(hash: String?, keep: Int = 8): String {
        if (hash.isNullOrBlank()) return "—"
        val bare = hash.removePrefix("0x").removePrefix("0X")
        if (bare.length <= keep * 2) return bare
        return bare.take(keep) + "…" + bare.takeLast(keep)
    }
}
