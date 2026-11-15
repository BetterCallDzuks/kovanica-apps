package online.kovanica.node

import io.kovanica.chain.ChainIds
import java.math.BigInteger
import java.util.Locale

/**
 * Account addresses, bit-identical to `kovanica_types::Address` (PRO-21).
 *
 * Canonical form: `kvnc` + 57 lowercase bech32 characters + `dag` (64 characters).
 * Those 57 characters are 285 bits, most significant first: the 32-byte key,
 * then the first 29 bits of unkeyed BLAKE3 over it.
 *
 * Legacy hex is accepted only on kovanica devnet and local.
 */
object KvncAddress {
    const val PREFIX: String = "kvnc"
    const val SUFFIX: String = "dag"
    const val CANONICAL_LENGTH: Int = 64
    private const val BODY_CHARS: Int = 57
    private const val CHECKSUM_BITS: Int = 29
    private const val KEY_BYTES: Int = 32
    private const val ALPHABET: String = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

    fun legacyAllowed(chainId: Long): Boolean = ChainIds.legacyAllowed(chainId)

    fun normalizeHex(raw: String?, chainId: Long): String? {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return null
        if (value.length == CANONICAL_LENGTH && value.startsWith(PREFIX) && value.endsWith(SUFFIX)) {
            return decodeCanonical(value)?.let { hexEncode(it) }
        }
        val legacy = decodeLegacy(value) ?: return null
        if (!legacyAllowed(chainId)) return null
        return hexEncode(legacy)
    }

    fun isValid(raw: String?, chainId: Long): Boolean = normalizeHex(raw, chainId) != null

    fun display(value: String): String {
        val key = keyBytes(value) ?: return value.trim()
        return encode(key)
    }

    fun canonical(value: String): String? {
        val key = storedKey(value)?.let { hexDecode(it) } ?: return null
        return encode(key)
    }

    fun short(value: String, keep: Int = 6): String {
        val shown = display(value)
        if (shown.length != CANONICAL_LENGTH || !shown.startsWith(PREFIX) || !shown.endsWith(SUFFIX)) {
            return shown
        }
        val body = shown.substring(PREFIX.length, shown.length - SUFFIX.length)
        if (body.length <= keep * 2 + 1) return shown
        return "$PREFIX${body.take(keep)}…${body.takeLast(keep)}$SUFFIX"
    }

    private fun storedKey(raw: String?): String? {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return null
        if (value.length == CANONICAL_LENGTH && value.startsWith(PREFIX) && value.endsWith(SUFFIX)) {
            return decodeCanonical(value)?.let { hexEncode(it) }
        }
        val bare = if (value.startsWith("0x")) value.substring(2) else value
        if (bare.length == KEY_BYTES * 2 && bare.all { hexNibble(it) != null }) {
            return bare.lowercase(Locale.US)
        }
        return null
    }

    private fun keyBytes(value: String): ByteArray? {
        val stored = storedKey(value)
        if (stored != null) return hexDecode(stored)
        return decodeLegacy(value.trim())
    }

    private fun decodeCanonical(value: String): ByteArray? {
        if (value.length != CANONICAL_LENGTH || !value.startsWith(PREFIX) || !value.endsWith(SUFFIX)) {
            return null
        }
        val body = value.substring(PREFIX.length, value.length - SUFFIX.length)
        var acc = 0L
        var nbits = 0
        val payload = ByteArray(KEY_BYTES)
        var filled = 0
        for (ch in body) {
            val symbol = ALPHABET.indexOf(ch)
            if (symbol < 0) return null
            acc = (acc shl 5) or symbol.toLong()
            nbits += 5
            if (filled < KEY_BYTES && nbits >= 8) {
                nbits -= 8
                payload[filled] = ((acc ushr nbits) and 0xff).toByte()
                filled += 1
                acc = acc and ((1L shl nbits) - 1)
            }
        }
        if (filled != KEY_BYTES || nbits != CHECKSUM_BITS) return null
        if (acc.toInt() != checksum29(payload)) return null
        return payload
    }

    private fun decodeLegacy(value: String): ByteArray? {
        if (value.startsWith(PREFIX) || value.endsWith(SUFFIX)) {
            if (!value.startsWith(PREFIX) || !value.endsWith(SUFFIX)) return null
            val body = value.substring(PREFIX.length, value.length - SUFFIX.length)
            if (body.any { hexNibble(it) == null }) return null
            val bytes = hexDecode(body) ?: return null
            if (bytes.size != KEY_BYTES + 4) return null
            val payload = bytes.copyOf(KEY_BYTES)
            val check = bytes.copyOfRange(KEY_BYTES, bytes.size)
            if (!check.contentEquals(blake3(payload).copyOf(4))) return null
            return payload
        }
        if (value.startsWith("0X")) return null
        val raw = if (value.startsWith("0x")) value.substring(2) else value
        val bytes = hexDecode(raw) ?: return null
        if (bytes.size != KEY_BYTES) return null
        return bytes
    }

    private fun encode(payload: ByteArray): String {
        require(payload.size == KEY_BYTES)
        val chars = CharArray(BODY_CHARS)
        var acc = 0L
        var nbits = 0
        var out = 0
        fun push(symbol: Int, bits: Int) {
            acc = (acc shl bits) or (symbol.toLong() and ((1L shl bits) - 1))
            nbits += bits
            while (nbits >= 5) {
                nbits -= 5
                chars[out] = ALPHABET[((acc ushr nbits) and 31).toInt()]
                out += 1
                acc = acc and ((1L shl nbits) - 1)
            }
        }
        for (byte in payload) push(byte.toInt() and 0xff, 8)
        push(checksum29(payload), CHECKSUM_BITS)
        check(out == BODY_CHARS && nbits == 0)
        return PREFIX + String(chars) + SUFFIX
    }

    private fun checksum29(payload: ByteArray): Int {
        val digest = blake3(payload)
        val word = ((digest[0].toInt() and 0xff) shl 24) or
            ((digest[1].toInt() and 0xff) shl 16) or
            ((digest[2].toInt() and 0xff) shl 8) or
            (digest[3].toInt() and 0xff)
        return word ushr (32 - CHECKSUM_BITS)
    }
}

private const val CHUNK_START: Int = 1
private const val CHUNK_END: Int = 2
private const val ROOT: Int = 8

private val BLAKE3_IV: IntArray = intArrayOf(
    0x6A09E667,
    0xBB67AE85L.toInt(),
    0x3C6EF372,
    0xA54FF53AL.toInt(),
    0x510E527F,
    0x9B05688CL.toInt(),
    0x1F83D9AB,
    0x5BE0CD19,
)

private val MSG_PERMUTATION: IntArray = intArrayOf(
    2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8,
)

private fun blake3(data: ByteArray): ByteArray {
    require(data.size <= 1024) { "blake3 input longer than one chunk" }
    var cv = BLAKE3_IV.copyOf()
    val blocks = maxOf(1, (data.size + 63) / 64)
    var state = IntArray(16)
    for (index in 0 until blocks) {
        val start = index * 64
        val len = minOf(64, maxOf(0, data.size - start))
        val block = ByteArray(64)
        if (len > 0) data.copyInto(block, destinationOffset = 0, startIndex = start, endIndex = start + len)
        var flags = 0
        if (index == 0) flags = flags or CHUNK_START
        if (index == blocks - 1) flags = flags or CHUNK_END or ROOT
        state = blake3Compress(cv, wordsOf(block), len, flags)
        cv = state.copyOf(8)
    }
    val out = ByteArray(32)
    for (index in 0 until 8) {
        val word = state[index]
        val offset = index * 4
        out[offset] = word.toByte()
        out[offset + 1] = (word ushr 8).toByte()
        out[offset + 2] = (word ushr 16).toByte()
        out[offset + 3] = (word ushr 24).toByte()
    }
    return out
}

private fun blake3Compress(cv: IntArray, block: IntArray, blockLen: Int, flags: Int): IntArray {
    val state = IntArray(16)
    for (index in 0 until 8) state[index] = cv[index]
    state[8] = BLAKE3_IV[0]
    state[9] = BLAKE3_IV[1]
    state[10] = BLAKE3_IV[2]
    state[11] = BLAKE3_IV[3]
    state[12] = 0
    state[13] = 0
    state[14] = blockLen
    state[15] = flags
    val message = block.copyOf()
    repeat(7) {
        blake3Mix(state, 0, 4, 8, 12, message[0], message[1])
        blake3Mix(state, 1, 5, 9, 13, message[2], message[3])
        blake3Mix(state, 2, 6, 10, 14, message[4], message[5])
        blake3Mix(state, 3, 7, 11, 15, message[6], message[7])
        blake3Mix(state, 0, 5, 10, 15, message[8], message[9])
        blake3Mix(state, 1, 6, 11, 12, message[10], message[11])
        blake3Mix(state, 2, 7, 8, 13, message[12], message[13])
        blake3Mix(state, 3, 4, 9, 14, message[14], message[15])
        val next = IntArray(16)
        for (index in 0 until 16) next[index] = message[MSG_PERMUTATION[index]]
        for (index in 0 until 16) message[index] = next[index]
    }
    for (index in 0 until 8) {
        state[index] = state[index] xor state[index + 8]
        state[index + 8] = state[index + 8] xor cv[index]
    }
    return state
}

private fun blake3Mix(state: IntArray, a: Int, b: Int, c: Int, d: Int, mx: Int, my: Int) {
    state[a] = state[a] + state[b] + mx
    state[d] = rotr32(state[d] xor state[a], 16)
    state[c] = state[c] + state[d]
    state[b] = rotr32(state[b] xor state[c], 12)
    state[a] = state[a] + state[b] + my
    state[d] = rotr32(state[d] xor state[a], 8)
    state[c] = state[c] + state[d]
    state[b] = rotr32(state[b] xor state[c], 7)
}

private fun rotr32(value: Int, bits: Int): Int = (value ushr bits) or (value shl (32 - bits))

private fun wordsOf(block: ByteArray): IntArray {
    val out = IntArray(16)
    for (index in 0 until 16) {
        val offset = index * 4
        out[index] = (block[offset].toInt() and 0xff) or
            ((block[offset + 1].toInt() and 0xff) shl 8) or
            ((block[offset + 2].toInt() and 0xff) shl 16) or
            ((block[offset + 3].toInt() and 0xff) shl 24)
    }
    return out
}

private fun hexNibble(ch: Char): Int? = when (ch) {
    in '0'..'9' -> ch - '0'
    in 'a'..'f' -> ch - 'a' + 10
    in 'A'..'F' -> ch - 'A' + 10
    else -> null
}

private fun hexDecode(text: String): ByteArray? {
    if (text.length % 2 != 0) return null
    val out = ByteArray(text.length / 2)
    for (index in out.indices) {
        val hi = hexNibble(text[index * 2]) ?: return null
        val lo = hexNibble(text[index * 2 + 1]) ?: return null
        out[index] = ((hi shl 4) or lo).toByte()
    }
    return out
}

private fun hexEncode(bytes: ByteArray): String = buildString(bytes.size * 2) {
    for (byte in bytes) append("%02x".format(Locale.US, byte.toInt() and 0xff))
}

object Amounts {
    const val KVNC_DECIMALS: Int = 9
    private const val MAX_DECIMALS = 30

    fun parse(text: String, decimals: Int): BigInteger? {
        if (decimals < 0 || decimals > MAX_DECIMALS) return null
        val value = text.trim()
        if (value.isEmpty()) return null
        val parts = value.split('.')
        if (parts.size > 2) return null
        val whole = parts[0]
        val fraction = if (parts.size == 2) parts[1] else ""
        if (whole.isEmpty() && fraction.isEmpty()) return null
        if (!whole.all { it in '0'..'9' } || !fraction.all { it in '0'..'9' }) return null
        if (fraction.length > decimals) return null
        val scaled = whole.ifEmpty { "0" } + fraction.padEnd(decimals, '0')
        return scaled.toBigIntegerOrNull()
    }

    fun format(value: BigInteger, decimals: Int): String {
        if (decimals <= 0) return value.toString()
        if (decimals > MAX_DECIMALS) return value.toString()
        val negative = value.signum() < 0
        val magnitude = value.abs()
        val base = BigInteger.TEN.pow(decimals)
        val whole = magnitude / base
        val fraction = (magnitude % base).toString().padStart(decimals, '0').trimEnd('0')
        return buildString {
            if (negative) append('-')
            append(whole)
            if (fraction.isNotEmpty()) {
                append('.')
                append(fraction)
            }
        }
    }
}
