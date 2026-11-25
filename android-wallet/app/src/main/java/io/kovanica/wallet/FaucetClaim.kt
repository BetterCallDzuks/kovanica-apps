package io.kovanica.wallet

/** Testnet airdrop rules and the seed quiz. Mainnet is never allowed. */
object FaucetClaim {
    const val ATOMS: String = "100000000000"
    const val COOLDOWN_MS: Long = 60_000L

    fun allowed(chainId: Long): Boolean = chainId == 2L || chainId == 3L

    fun remaining(now: Long, until: Long): Long = (until - now).coerceAtLeast(0L)
}

object SeedCheck {
    private val LEADING_INDEX = Regex("^#?\\d+[.):\\s-]+")

    fun positions(wordCount: Int): List<Int> = if (wordCount >= 14) listOf(3, 8, 14) else listOf(3, 8, 12)

    fun normalizeAnswer(raw: String): String =
        raw.trim().replace(LEADING_INDEX, "").trim().lowercase()

    fun matches(mnemonic: String, answers: List<String>): Boolean {
        val words = mnemonic.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val spots = positions(words.size)
        if (answers.size != spots.size) return false
        return spots.zip(answers).all { (position, answer) ->
            val cleaned = normalizeAnswer(answer)
            cleaned.isNotEmpty() && words.getOrNull(position - 1)?.equals(cleaned, ignoreCase = true) == true
        }
    }
}
