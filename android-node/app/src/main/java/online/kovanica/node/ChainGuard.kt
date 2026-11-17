package online.kovanica.node

import io.kovanica.chain.ChainIds

/**
 * Networks this proof of concept will run.
 *
 * kovanica mainnet is refused. kovanica testnet and kovanica devnet are
 * accepted. Any other numeric id is refused and is not given a network name.
 */
object ChainGuard {
    const val MAINNET_NETWORK_TAG: String = "1-4d827d40dd9655db"
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
