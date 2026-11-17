package io.kovanica.chain

/**
 * The only chain-id constants for the Android apps.
 *
 * Network profiles, the legacy-address policy, and the chain text field all
 * read this object.
 */
object ChainIds {
    const val MAINNET: Long = 1
    const val TESTNET: Long = 2
    const val HYBRID: Long = 2
    const val DEVNET: Long = 3

    /** No chain was configured. Legacy hex stays refused. */
    const val UNSPECIFIED: Long = -1

    /** Devnet 3 only. Same set as Rust `legacy_address_allowed`. */
    fun legacyAllowed(chainId: Long): Boolean = chainId == DEVNET

    /**
     * Chain id for signing and address checks.
     *
     * A typed integer wins, including `0`. A blank or unparseable field uses
     * [profileChainId] from the network profile. It does not become 0.
     */
    fun resolve(fieldText: String, profileChainId: Long): ULong {
        val typed = fieldText.trim()
        val parsed = if (typed.isEmpty()) null else typed.toULongOrNull()
        return parsed ?: profileChainId.toULong()
    }
}
