package online.kovanica.node

import io.kovanica.chain.ChainIds

/**
 * Startup configuration representing the node mode, storage, and validation settings.
 */
data class NodeStartupConfig(
    val chainId: Long,
    val dataDir: String,
    val isFullNode: Boolean = true,
    val storageEnabled: Boolean = true,
    val blockValidationActive: Boolean = true,
    val configText: String = "",
)

/**
 * App-generated node config. RPC and the P2P listener stay on loopback.
 * The L1 default listener is all interfaces on port 8000; this file overrides
 * that so nothing off the device can dial in. Outbound dials still use the
 * seed1 DNS name.
 *
 * Mining stays off. `run_validator` is present and false. kovanica testnet
 * requires the no-stake emission policy or the process refuses to start.
 */
object NodeConfigText {
    const val RPC_PORT: Int = 8545
    const val P2P_PORT: Int = 8000

    fun defaultStartupConfig(dataDir: String, chainId: Long = ChainIds.TESTNET): NodeStartupConfig {
        return NodeStartupConfig(
            chainId = chainId,
            dataDir = dataDir,
            isFullNode = true,
            storageEnabled = true,
            blockValidationActive = true,
            configText = render(dataDir, chainId),
        )
    }

    fun render(dataDir: String, chainId: Long = ChainIds.TESTNET): String {
        val guard = ChainGuard.evaluate(chainId)
        require(guard.allowed) { guard.message }
        val boot = Bootstrap.official().joinToString(", ") { "\"$it\"" }
        val emission = if (chainId == ChainIds.TESTNET || chainId == ChainIds.MAINNET) {
            "emission_policy = \"no-stake-82m\"\n"
        } else {
            ""
        }
        return """
            chain_id = $chainId
            data_dir = "${escape(dataDir)}"
            listen_addr = "127.0.0.1:$P2P_PORT"
            rpc_addr = "127.0.0.1"
            rpc_port = $RPC_PORT
            run_validator = false
            max_peers = 12
            $emission
            bootnodes = [$boot]

            [mining]
            enabled = false
        """.trimIndent().trim() + "\n"
    }

    private fun escape(path: String): String = path.replace("\\", "\\\\").replace("\"", "\\\"")
}

object NodeCommand {
    fun argv(binary: String, configPath: String): List<String> =
        listOf(binary, "--config", configPath)
}

/**
 * Transfer fee shown before send.
 *
 * L1 `kovanica_estimateFee` returns atoms per byte (default rate 1). The
 * transfer wire in `encode_broadcast_tx` is 193 bytes, so the fee is
 * rate × 193 atoms when the node answers, and 193 atoms when it does not.
 */
object TransferFee {
    const val WIRE_BYTES: Long = 193
    const val DEFAULT_RATE: Long = 1

    fun atoms(ratePerByte: Long?): Long {
        val rate = if (ratePerByte == null || ratePerByte < DEFAULT_RATE) DEFAULT_RATE else ratePerByte
        return rate * WIRE_BYTES
    }
}

data class SendReview(
    val networkName: String,
    val chainId: Long,
    val to: String,
    val amountText: String,
    val feeText: String,
    val amountAtoms: java.math.BigInteger,
    val feeAtoms: java.math.BigInteger,
)

object SendFlow {
    fun review(
        chainId: Long,
        toRaw: String,
        amountRaw: String,
        feeRate: Long?,
    ): Result<SendReview> {
        val guard = ChainGuard.evaluate(chainId)
        if (!guard.allowed) return Result.failure(IllegalArgumentException(guard.message))
        val to = KvncAddress.canonical(toRaw) ?: KvncAddress.normalizeHex(toRaw, chainId)?.let {
            KvncAddress.display(it)
        }
        if (to == null || !KvncAddress.isValid(to, chainId)) {
            return Result.failure(IllegalArgumentException("That is not a valid address on ${guard.networkName}."))
        }
        val atoms = Amounts.parse(amountRaw, Amounts.KVNC_DECIMALS)
            ?: return Result.failure(IllegalArgumentException("Enter an amount in KVNC with at most 9 decimal places."))
        if (atoms.signum() <= 0) {
            return Result.failure(IllegalArgumentException("Amount must be greater than zero."))
        }
        if (atoms.bitLength() > 63) {
            return Result.failure(IllegalArgumentException("Amount is too large to sign in this build."))
        }
        val fee = java.math.BigInteger.valueOf(TransferFee.atoms(feeRate))
        return Result.success(
            SendReview(
                networkName = guard.networkName,
                chainId = chainId,
                to = to,
                amountText = Amounts.format(atoms, Amounts.KVNC_DECIMALS) + " KVNC",
                feeText = Amounts.format(fee, Amounts.KVNC_DECIMALS) + " KVNC",
                amountAtoms = atoms,
                feeAtoms = fee,
            ),
        )
    }
}

enum class SubmitKind { ACCEPTED, NEEDS_WRITE_RPC, REJECTED }

object Submission {
    fun classify(httpStatus: Int, body: String): SubmitKind {
        val text = body.lowercase()
        val auth = httpStatus == 401 || httpStatus == 403 ||
            text.contains("unauthor") ||
            text.contains("bearer") ||
            text.contains("write token") ||
            text.contains("write methods are rejected") ||
            text.contains("requires a write")
        if (auth) return SubmitKind.NEEDS_WRITE_RPC
        if (httpStatus in 200..299 && !text.contains("\"error\"")) return SubmitKind.ACCEPTED
        if (text.contains("\"error\"")) return SubmitKind.REJECTED
        if (httpStatus !in 200..299) return SubmitKind.REJECTED
        return SubmitKind.ACCEPTED
    }

    const val WRITE_RPC_MESSAGE: String =
        "The transaction is signed. Submission requires a write-enabled RPC."
}
