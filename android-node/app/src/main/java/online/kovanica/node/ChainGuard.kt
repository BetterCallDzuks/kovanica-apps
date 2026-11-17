package online.kovanica.node

import io.kovanica.chain.ChainIds

/**
 * Networks this proof of concept will run.
 *
 * kovanica mainnet is refused. kovanica testnet and kovanica devnet are
 * accepted. Any other numeric id is refused and is not given a network name.
 */
object ChainGuard {
    const val MAINNET_NETWORK_TAG: String = "1-f35df34c92001436"
    const val TESTNET_NETWORK_TAG: String = "2-acfdf6a6c80fd28a"

    data class Decision(
        val allowed: Boolean,
        val chainId: Long,
        /** Empty when the id is not a named network. */
        val networkName: String,
        val message: String,
    )

    fun networkName(chainId: Long): String? = when (chainId) {
        ChainIds.MAINNET -> "kovanica mainnet"
        ChainIds.TESTNET -> "kovanica testnet"
        ChainIds.DEVNET -> "kovanica devnet"
        else -> null
    }

    fun officialNetworkTag(chainId: Long): String? = when (chainId) {
        ChainIds.MAINNET -> MAINNET_NETWORK_TAG
        ChainIds.TESTNET -> TESTNET_NETWORK_TAG
        else -> null
    }

    /**
     * Validates a peer genesis digest against official network tags.
     * Matches if the hex digest starts with the tag's 16-hex prefix.
     */
    fun validatePeerGenesis(chainId: Long, genesisDigestHex: String): Boolean {
        val expectedTag = officialNetworkTag(chainId) ?: return false
        val expectedPrefix = expectedTag.substringAfter("-").lowercase()
        val cleaned = genesisDigestHex.trim().removePrefix("0x").removePrefix("0X").lowercase()
        return cleaned.startsWith(expectedPrefix)
    }

    /**
     * Validates a peer's network tag (e.g. "1-f35df34c92001436" or "2-acfdf6a6c80fd28a").
     */
    fun validatePeerNetworkTag(chainId: Long, tag: String): Boolean {
        val expectedTag = officialNetworkTag(chainId) ?: return false
        return tag.trim().equals(expectedTag, ignoreCase = true)
    }

    fun evaluate(chainId: Long): Decision {
        val name = networkName(chainId)
        return when (chainId) {
            ChainIds.TESTNET, ChainIds.DEVNET -> Decision(
                allowed = true,
                chainId = chainId,
                networkName = name!!,
                message = name,
            )
            ChainIds.MAINNET -> Decision(
                allowed = false,
                chainId = chainId,
                networkName = "kovanica mainnet",
                message = "kovanica mainnet is not available in this proof of concept.",
            )
            else -> Decision(
                allowed = false,
                chainId = chainId,
                networkName = "",
                message = "chain ID $chainId is not a supported network. It was not relabelled.",
            )
        }
    }

    /**
     * The config and the live node must name the same allowed network.
     * A missing live id uses the config id. A disagreement is a refusal.
     */
    fun agree(configChainId: Long, liveChainId: Long?): Decision {
        val config = evaluate(configChainId)
        if (!config.allowed) return config
        if (liveChainId == null) return config
        val live = evaluate(liveChainId)
        if (!live.allowed) return live
        if (live.chainId != config.chainId) {
            return Decision(
                allowed = false,
                chainId = live.chainId,
                networkName = "",
                message = "The node reports ${live.networkName} (chain ID ${live.chainId}) " +
                    "but the config is ${config.networkName} (chain ID ${config.chainId}).",
            )
        }
        return live
    }
}
