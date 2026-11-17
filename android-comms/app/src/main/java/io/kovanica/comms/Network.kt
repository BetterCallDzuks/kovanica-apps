package io.kovanica.comms

import android.content.Context
import android.content.SharedPreferences
import io.kovanica.chain.ChainIds

/**
 * One selectable network profile.
 *
 * @property id stable key persisted as `network_id` (`"testnet"` | `"devnet"`).
 * @property label human-readable name shown in the selector.
 * @property chainId chain id used for signing and address checks (`2` testnet, `3` devnet).
 * @property rpcUrl full JSON-RPC base, including the `/rpc` path ([NodeClient] tolerates either form).
 */
data class Network(
    val id: String,
    val label: String,
    val chainId: Long,
    val rpcUrl: String,
)

/**
 * Built-in network profiles (mirrors `packages/console/src/network.ts`).
 *
 * The live public testnet is chain 2, so it is the default a fresh install
 * opens on. [DEVNET] (`10.0.2.2`, the emulator loopback, chain 3) is the
 * development preset for local single-node testing. Mainnet has no preset yet;
 * it opens with the chain rather than here.
 */
object Networks {
    val TESTNET: Network = Network(
        "testnet", "Testnet (chain 2)", ChainIds.TESTNET,
        "https://rpc-testnet.kovanica.online/rpc",
    )
    val DEVNET: Network = Network(
        "devnet", "Devnet (chain 3)", ChainIds.DEVNET,
        "http://10.0.2.2:8545/rpc",
    )

    val ALL: List<Network> = listOf(TESTNET, DEVNET)
    val DEFAULT: Network = TESTNET

    /** Look up a profile by id; `null` when unknown (including `null`). */
    fun byId(id: String?): Network? = ALL.firstOrNull { it.id == id }

    /** The profile whose RPC matches [rpc], else `null` when the endpoint is custom. */
    fun byRpc(rpc: String): Network? {
        val normalized = rpc.trim().trimEnd('/')
        return ALL.firstOrNull { it.rpcUrl.trimEnd('/') == normalized }
    }
}

/**
 * Reads and writes the selected network in the app's existing `"kvnc"`
 * SharedPreferences file, under the same `network_id` key the wallet uses.
 *
 * The selected profile is pinned by `network_id`; the `rpc` key is the
 * editable override the Relay card writes.
 */
object NetworkPrefs {
    const val PREFS: String = "kvnc"
    const val KEY_NETWORK_ID: String = "network_id"
    const val KEY_RPC: String = "rpc"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Stored `network_id` when it maps to a known profile, else [Networks.DEFAULT]'s id. */
    fun selectedId(ctx: Context): String {
        val stored = prefs(ctx).getString(KEY_NETWORK_ID, null)
        return (Networks.byId(stored) ?: Networks.DEFAULT).id
    }

    /** The selected profile, falling back to [Networks.DEFAULT]. */
    fun selected(ctx: Context): Network =
        Networks.byId(selectedId(ctx)) ?: Networks.DEFAULT

    /** Persist [n] as the selected network and prefill the `rpc` override. */
    fun select(ctx: Context, n: Network) {
        prefs(ctx).edit()
            .putString(KEY_NETWORK_ID, n.id)
            .putString(KEY_RPC, n.rpcUrl)
            .apply()
    }
}
