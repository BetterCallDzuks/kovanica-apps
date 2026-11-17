package online.kovanica.node

import io.kovanica.chain.ChainIds
import java.math.BigInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NodePolicyTest {
    private val zero = "kvncqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz4k5rcdag"
    private val sample = "kvncqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc07228f2dag"
    private val legacy = "kvncea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c0871f3aadag"

    @Test
    fun chainGuardAcceptsTestnetAndDevnet() {
        val testnet = ChainGuard.evaluate(ChainIds.TESTNET)
        assertTrue(testnet.allowed)
        assertEquals("kovanica testnet", testnet.networkName)
        val devnet = ChainGuard.evaluate(ChainIds.DEVNET)
        assertTrue(devnet.allowed)
        assertEquals("kovanica devnet", devnet.networkName)
    }

    @Test
    fun chainGuardRefusesMainnetAndRetiredIds() {
        val mainnet = ChainGuard.evaluate(ChainIds.MAINNET)
        assertFalse(mainnet.allowed)
        assertEquals("kovanica mainnet", mainnet.networkName)
        assertTrue(mainnet.message.contains("kovanica mainnet"))
        assertEquals("1-4d827d40dd9655db", ChainGuard.officialNetworkTag(ChainIds.MAINNET))
        assertEquals("2-acfdf6a6c80fd28a", ChainGuard.officialNetworkTag(ChainIds.TESTNET))
        assertNull(ChainGuard.officialNetworkTag(ChainIds.DEVNET))
        for (id in listOf(4L, 5L, 0L, 99L)) {
            val decision = ChainGuard.evaluate(id)
            assertFalse(decision.allowed)
            assertEquals("", decision.networkName)
            assertTrue(decision.message.contains("chain ID $id"))
            assertFalse(decision.message.contains("Chain "))
        }
    }

    @Test
    fun liveChainIdMustMatchConfig() {
        val ok = ChainGuard.agree(ChainIds.TESTNET, ChainIds.TESTNET)
        assertTrue(ok.allowed)
        assertEquals("kovanica testnet", ok.networkName)
        val missingLive = ChainGuard.agree(ChainIds.DEVNET, null)
        assertTrue(missingLive.allowed)
        assertEquals("kovanica devnet", missingLive.networkName)
        val refused = ChainGuard.agree(ChainIds.TESTNET, ChainIds.MAINNET)
        assertFalse(refused.allowed)
        val mismatch = ChainGuard.agree(ChainIds.TESTNET, ChainIds.DEVNET)
        assertFalse(mismatch.allowed)
        assertTrue(mismatch.message.contains("kovanica devnet"))
        assertTrue(mismatch.message.contains("kovanica testnet"))
    }

    @Test
    fun health503IsStalledAndOtherFailuresAreUnavailable() {
        assertEquals(SyncPhase.STALLED, SyncState.fromHealth(503, false))
        assertEquals(SyncPhase.STALLED, SyncState.fromHealth(503, true))
        assertEquals(SyncPhase.STALLED, SyncState.fromHealth(503, null))
        assertEquals("stalled", SyncState.label(SyncPhase.STALLED))
        assertEquals(SyncPhase.SYNCING, SyncState.fromHealth(200, true))
        assertEquals(SyncPhase.SYNCED, SyncState.fromHealth(200, false))
        assertEquals(SyncPhase.SYNCED, SyncState.fromHealth(200, null))
        assertEquals(SyncPhase.UNAVAILABLE, SyncState.fromHealth(null, null))
        assertEquals(SyncPhase.UNAVAILABLE, SyncState.fromHealth(500, false))
        assertEquals("unavailable", SyncState.label(SyncPhase.UNAVAILABLE))
    }

    @Test
    fun rpcJsonReadsSyncFieldsAndTip() {
        val tip = "abcdef01" + "0".repeat(48) + "456789ab"
        val body = """
            {"committedHeight":1200,"catchingUp":true,"peerCount":3,
             "tips":["0x$tip"],"chain_id":2}
        """.trimIndent()
        val snap = RpcJson.snapshot(503, """{"status":"degraded","peer_count":3}""", body)
        assertEquals(503, snap.httpStatus)
        assertEquals(true, snap.catchingUp)
        assertEquals(1200L, snap.committedHeight)
        assertEquals(3L, snap.peerCount)
        assertEquals(tip, snap.tipHash)
        assertEquals(2L, snap.chainId)
        assertEquals(SyncPhase.STALLED, SyncState.fromHealth(snap.httpStatus, snap.catchingUp))
        assertEquals("abcdef01…456789ab", RpcJson.shortHash(snap.tipHash))
        assertEquals(16L, RpcJson.quantityResult("""{"result":"0x10"}"""))
        assertEquals(9L, RpcJson.quantityResult("""{"result":9}"""))
        val header = """{"jsonrpc":"2.0","id":1,"result":{"round":4,"chain_id":2}}"""
        assertEquals("""{"round":4,"chain_id":2}""", RpcJson.resultValue(header))
        assertNull(RpcJson.resultValue("""{"result":null}"""))
    }

    @Test
    fun eachPreflightFailureSelectsLightMode() {
        val ok = Fallback.Report(
            freeDiskBytes = Fallback.MIN_FREE_DISK_BYTES,
            totalRamBytes = Fallback.MIN_TOTAL_RAM_BYTES,
            abi = "arm64-v8a",
            binaryPresent = true,
            processStarted = true,
            reachedPeer = true,
            recentCrashes = 0,
        )
        assertTrue(Fallback.decide(ok).fullMode)
        assertNull(Fallback.decide(ok).reason)
        assertLight(ok.copy(freeDiskBytes = Fallback.MIN_FREE_DISK_BYTES - 1), "disk")
        assertLight(ok.copy(totalRamBytes = Fallback.MIN_TOTAL_RAM_BYTES - 1), "RAM")
        assertLight(ok.copy(abi = "armeabi-v7a"), "ABI")
        assertLight(ok.copy(binaryPresent = false), "executable")
        assertLight(ok.copy(processStarted = false), "did not stay up")
        assertLight(ok.copy(reachedPeer = false), "peer")
        assertLight(ok.copy(recentCrashes = Fallback.CRASH_LIMIT), "repeatedly")
        assertTrue(Fallback.decide(ok.copy(abi = "x86_64")).fullMode)
        val beforeStart = ok.copy(processStarted = false, reachedPeer = false)
        assertFalse(Fallback.decide(beforeStart).fullMode)
        assertTrue(Fallback.readyToStart(beforeStart).fullMode)
        assertNull(Fallback.readyToStart(beforeStart).reason)
        assertFalse(Fallback.readyToStart(beforeStart.copy(binaryPresent = false)).fullMode)
    }

    @Test
    fun bootstrapKeepsOnlyTheSeed1DnsName() {
        val selected = Bootstrap.select(
            listOf(
                "seed1.kovanica.online:8000",
                "/dns4/seed1.kovanica.online/tcp/8000",
                "192.0.2.1:8000",
                "/ip4/192.0.2.1/tcp/8000",
                "other.example:8000",
                "",
            ),
        )
        assertEquals(listOf(Bootstrap.SEED1), selected)
        assertEquals(listOf(Bootstrap.SEED1), Bootstrap.official())
        assertFalse(Bootstrap.official().any { it.contains("192.0.2.") })
    }

    @Test
    fun generatedConfigIsLoopbackAndDoesNotMine() {
        val text = NodeConfigText.render("/data/user/0/online.kovanica.node.android/files/chaindata")
        assertTrue(text.contains("chain_id = ${ChainIds.TESTNET}"))
        assertTrue(text.contains("listen_addr = \"127.0.0.1:8000\""))
        assertTrue(text.contains("rpc_addr = \"127.0.0.1\""))
        assertTrue(text.contains("run_validator = false"))
        assertTrue(text.contains("enabled = false"))
        assertTrue(text.contains("emission_policy = \"no-stake-82m\""))
        assertTrue(text.contains("seed1.kovanica.online:8000"))
        assertFalse(text.contains("0.0.0.0"))
        assertEquals(
            listOf("/usr/bin/kovanica-node", "--config", "/tmp/node.toml"),
            NodeCommand.argv("/usr/bin/kovanica-node", "/tmp/node.toml"),
        )
    }

    @Test
    fun addressValidationMatchesTheCanonicalVectors() {
        assertTrue(KvncAddress.isValid(zero, ChainIds.TESTNET))
        assertTrue(KvncAddress.isValid(sample, ChainIds.MAINNET))
        assertEquals(zero, KvncAddress.display(zero))
        assertFalse(KvncAddress.isValid(zero.dropLast(1) + "c", ChainIds.TESTNET))
        assertFalse(KvncAddress.isValid(legacy, ChainIds.TESTNET))
        assertFalse(KvncAddress.isValid(legacy, ChainIds.MAINNET))
        assertTrue(KvncAddress.isValid(legacy, ChainIds.DEVNET))
        assertFalse(KvncAddress.isValid(legacy, 1337))
        assertFalse(KvncAddress.isValid("not-an-address", ChainIds.DEVNET))
    }

    @Test
    fun amountParsingRejectsExtraFractionDigits() {
        assertEquals(BigInteger("12500000000"), Amounts.parse("12.5", 9))
        assertEquals(BigInteger("1000000000"), Amounts.parse("1", 9))
        assertNull(Amounts.parse("1.1234567890", 9))
        assertNull(Amounts.parse("-1", 9))
        assertNull(Amounts.parse("", 9))
        assertEquals("12.5", Amounts.format(BigInteger("12500000000"), 9))
    }

    @Test
    fun sendReviewShowsNetworkAmountAndFee() {
        val review = SendFlow.review(ChainIds.TESTNET, sample, "1.5", 2).getOrThrow()
        assertEquals("kovanica testnet", review.networkName)
        assertEquals(sample, review.to)
        assertEquals("1.5 KVNC", review.amountText)
        assertEquals("0.000000386 KVNC", review.feeText)
        assertEquals(193L * 2, review.feeAtoms.toLong())
        assertTrue(SendFlow.review(ChainIds.MAINNET, sample, "1", 1).isFailure)
        assertTrue(SendFlow.review(ChainIds.TESTNET, "nope", "1", 1).isFailure)
        assertTrue(SendFlow.review(ChainIds.TESTNET, sample, "0", 1).isFailure)
        assertTrue(SendFlow.review(ChainIds.TESTNET, sample, "10000000000", 1).isFailure)
        assertEquals(193L, TransferFee.atoms(null))
    }

    @Test
    fun writeRpcAuthIsNotTreatedAsASuccessfulSend() {
        assertEquals(SubmitKind.NEEDS_WRITE_RPC, Submission.classify(401, "unauthorized"))
        assertEquals(SubmitKind.NEEDS_WRITE_RPC, Submission.classify(403, ""))
        assertEquals(
            SubmitKind.NEEDS_WRITE_RPC,
            Submission.classify(200, """{"error":{"message":"missing bearer write token"}}"""),
        )
        assertEquals(SubmitKind.REJECTED, Submission.classify(200, """{"error":{"message":"nonce"}}"""))
        assertEquals(SubmitKind.ACCEPTED, Submission.classify(200, """{"result":"0xabc"}"""))
        assertTrue(Submission.WRITE_RPC_MESSAGE.contains("write-enabled RPC"))
    }

    private fun assertLight(report: Fallback.Report, needle: String) {
        val decision = Fallback.decide(report)
        assertFalse(decision.fullMode)
        assertTrue(decision.reason!!.contains(needle))
    }
}
