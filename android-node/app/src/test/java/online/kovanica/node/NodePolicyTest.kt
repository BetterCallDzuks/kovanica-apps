package online.kovanica.node

import io.kovanica.chain.ChainIds
import java.io.File
import java.math.BigInteger
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
        assertEquals("1-f35df34c92001436", ChainGuard.officialNetworkTag(ChainIds.MAINNET))
        assertEquals("2-24cdb5fadd98b207", ChainGuard.officialNetworkTag(ChainIds.TESTNET))
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
    fun chainGuardValidatesPeerGenesisDigestsAgainstOfficialTags() {
        // Tag format: <chain_id>-<16 hex chars of genesis digest>
        // Mainnet tag: 1-f35df34c92001436
        // Testnet tag: 2-24cdb5fadd98b207
        assertEquals("1-f35df34c92001436", ChainGuard.MAINNET_NETWORK_TAG)
        assertEquals("2-24cdb5fadd98b207", ChainGuard.TESTNET_NETWORK_TAG)

        // Peer network tag validation
        assertTrue(ChainGuard.validatePeerNetworkTag(ChainIds.MAINNET, "1-f35df34c92001436"))
        assertTrue(ChainGuard.validatePeerNetworkTag(ChainIds.TESTNET, "2-24cdb5fadd98b207"))
        assertFalse(ChainGuard.validatePeerNetworkTag(ChainIds.MAINNET, "2-24cdb5fadd98b207"))
        assertFalse(ChainGuard.validatePeerNetworkTag(ChainIds.TESTNET, "1-f35df34c92001436"))
        assertFalse(ChainGuard.validatePeerNetworkTag(ChainIds.DEVNET, "3-0000000000000000"))

        // Peer genesis digest validation (32 bytes hex = 64 characters)
        val mainnetGenesisHex = "f35df34c92001436" + "ab".repeat(24)
        val testnetGenesisHex = "24cdb5fadd98b207" + "cd".repeat(24)
        val tamperedGenesisHex = "deadbeefcafebabe" + "00".repeat(24)

        assertTrue(ChainGuard.validatePeerGenesis(ChainIds.MAINNET, mainnetGenesisHex))
        assertTrue(ChainGuard.validatePeerGenesis(ChainIds.MAINNET, "0x$mainnetGenesisHex"))
        assertFalse(ChainGuard.validatePeerGenesis(ChainIds.MAINNET, testnetGenesisHex))
        assertFalse(ChainGuard.validatePeerGenesis(ChainIds.MAINNET, tamperedGenesisHex))

        assertTrue(ChainGuard.validatePeerGenesis(ChainIds.TESTNET, testnetGenesisHex))
        assertTrue(ChainGuard.validatePeerGenesis(ChainIds.TESTNET, "0x$testnetGenesisHex"))
        assertFalse(ChainGuard.validatePeerGenesis(ChainIds.TESTNET, mainnetGenesisHex))
        assertFalse(ChainGuard.validatePeerGenesis(ChainIds.TESTNET, tamperedGenesisHex))
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
    fun defaultStartupConfigSetsFullNodeMode() {
        val path = "/data/user/0/online.kovanica.node.android/files/chaindata"
        val config = NodeConfigText.defaultStartupConfig(path, ChainIds.TESTNET)

        // Verifies Locked Product Truth: full-node mode by default, storage enabled, block validation active
        assertTrue("Startup config must set full-node mode by default", config.isFullNode)
        assertTrue("Storage must be enabled for full-node mode", config.storageEnabled)
        assertTrue("Block validation must be active for full-node mode", config.blockValidationActive)
        assertEquals(ChainIds.TESTNET, config.chainId)
        assertEquals(path, config.dataDir)
        assertTrue(config.configText.contains("chain_id = ${ChainIds.TESTNET}"))
        assertTrue(config.configText.contains("data_dir = \"$path\""))
        assertTrue(config.configText.contains("listen_addr = \"127.0.0.1:8000\""))
        assertTrue(config.configText.contains("rpc_port = 8545"))
    }

    @Test
    fun fallbackTriggersLightOnLowMemoryThermalBattery() {
        val ok = Fallback.Report(
            freeDiskBytes = Fallback.MIN_FREE_DISK_BYTES,
            totalRamBytes = Fallback.MIN_TOTAL_RAM_BYTES,
            abi = "arm64-v8a",
            binaryPresent = true,
            processStarted = true,
            reachedPeer = true,
            recentCrashes = 0,
            freeRamBytes = Fallback.MIN_FREE_RAM_BYTES,
            thermalThrottling = false,
            lowBattery = false,
        )
        assertTrue(Fallback.decide(ok).fullMode)
        assertNull(Fallback.decide(ok).reason)

        // Memory threshold fallback: < 256MB free RAM triggers light mode
        assertLight(ok.copy(freeRamBytes = Fallback.MIN_FREE_RAM_BYTES - 1), "256 MiB free RAM")
        assertLight(ok.copy(freeRamBytes = 100L * 1024L * 1024L), "256 MiB free RAM")

        // Thermal throttling triggers light mode
        assertLight(ok.copy(thermalThrottling = true), "thermal throttling")

        // Low battery triggers light mode
        assertLight(ok.copy(lowBattery = true), "Low battery")
    }

    @Test
    fun fallbackRecoversToFullNodeWhenConditionsNormalize() {
        // Degraded report due to resource constraints
        val degraded = Fallback.Report(
            freeDiskBytes = Fallback.MIN_FREE_DISK_BYTES,
            totalRamBytes = Fallback.MIN_TOTAL_RAM_BYTES,
            abi = "arm64-v8a",
            binaryPresent = true,
            processStarted = true,
            reachedPeer = true,
            recentCrashes = 0,
            freeRamBytes = 128L * 1024L * 1024L, // low memory
            thermalThrottling = true,             // thermal throttling
            lowBattery = true,                    // battery warning
        )
        assertFalse(Fallback.decide(degraded).fullMode)

        // Conditions normalize: free RAM >= 256MB, thermal throttling ceases, battery restored
        val normalized = degraded.copy(
            freeRamBytes = 512L * 1024L * 1024L,
            thermalThrottling = false,
            lowBattery = false,
        )
        val recovery = Fallback.evaluateRecovery(normalized)
        assertTrue("Node should recover back to full mode once conditions normalize", recovery.fullMode)
        assertNull(recovery.reason)
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
            freeRamBytes = Fallback.MIN_FREE_RAM_BYTES,
            thermalThrottling = false,
            lowBattery = false,
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
    fun jniNativeBridgeExportedDeclarations() {
        // Verifies that NativeBridge declares the 4 required JNI methods:
        // nodeStart, nodeStop, nodeStatus, nodeSyncProgress
        val methods = NativeBridge::class.java.declaredMethods
        val names = methods.map { it.name }.toSet()

        assertTrue("NativeBridge must declare nodeStart", names.contains("nodeStart"))
        assertTrue("NativeBridge must declare nodeStop", names.contains("nodeStop"))
        assertTrue("NativeBridge must declare nodeStatus", names.contains("nodeStatus"))
        assertTrue("NativeBridge must declare nodeSyncProgress", names.contains("nodeSyncProgress"))

        val nodeStart = methods.first { it.name == "nodeStart" }
        assertEquals(Int::class.javaPrimitiveType, nodeStart.returnType)
        assertEquals(listOf(String::class.java), nodeStart.parameterTypes.toList())

        val nodeStop = methods.first { it.name == "nodeStop" }
        assertEquals(Int::class.javaPrimitiveType, nodeStop.returnType)
        assertEquals(0, nodeStop.parameterTypes.size)

        val nodeStatus = methods.first { it.name == "nodeStatus" }
        assertEquals(String::class.java, nodeStatus.returnType)
        assertEquals(0, nodeStatus.parameterTypes.size)

        val nodeSyncProgress = methods.first { it.name == "nodeSyncProgress" }
        assertEquals(String::class.java, nodeSyncProgress.returnType)
        assertEquals(0, nodeSyncProgress.parameterTypes.size)
    }

    @Test
    fun nativeLibrarySymbolsVerification() {
        // Inspects compiled libkovanica_ffi.so libraries across supported ABIs (arm64-v8a, x86_64)
        for (abi in listOf("arm64-v8a", "x86_64")) {
            val so = File("src/main/jniLibs/$abi/libkovanica_ffi.so")
            if (so.exists()) {
                val process = ProcessBuilder("nm", "-D", "--defined-only", so.absolutePath)
                    .redirectErrorStream(true)
                    .start()
                val text = process.inputStream.bufferedReader().readText()
                val code = process.waitFor()
                if (code == 0) {
                    val symbols = text.lines().mapNotNull { line ->
                        line.trim().split(Regex("\\s+")).lastOrNull()
                    }.toSet()

                    assertTrue(
                        "libkovanica_ffi.so ($abi) missing Java_online_kovanica_node_NativeBridge_nodeStart",
                        symbols.contains("Java_online_kovanica_node_NativeBridge_nodeStart"),
                    )
                    assertTrue(
                        "libkovanica_ffi.so ($abi) missing Java_online_kovanica_node_NativeBridge_nodeStop",
                        symbols.contains("Java_online_kovanica_node_NativeBridge_nodeStop"),
                    )
                    assertTrue(
                        "libkovanica_ffi.so ($abi) missing Java_online_kovanica_node_NativeBridge_nodeStatus",
                        symbols.contains("Java_online_kovanica_node_NativeBridge_nodeStatus"),
                    )
                    assertTrue(
                        "libkovanica_ffi.so ($abi) missing Java_online_kovanica_node_NativeBridge_nodeSyncProgress",
                        symbols.contains("Java_online_kovanica_node_NativeBridge_nodeSyncProgress"),
                    )
                }
            }
        }
    }

    @Test
    fun nodeServiceInitializesNativeBridgeWithInternalFilesDir() {
        val tempDir = java.nio.file.Files.createTempDirectory("kovanica-node-test").toFile()
        try {
            val result = NodeService.initNativeBridge(tempDir, ChainIds.TESTNET)
            assertEquals(0, result)

            val chaindata = File(tempDir, "chaindata")
            assertTrue("chaindata directory should be created in files dir", chaindata.exists() && chaindata.isDirectory)

            val configFile = File(tempDir, "node.toml")
            assertTrue("node.toml configuration file should exist in files dir", configFile.exists() && configFile.isFile)
            val configText = configFile.readText()
            assertTrue(configText.contains("chain_id = ${ChainIds.TESTNET}"))
            assertTrue(configText.contains("data_dir = \"${chaindata.absolutePath}\""))
            assertTrue(configText.contains("127.0.0.1"))
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun nodeServiceForegroundNotificationDisplaysProgressHeightAndPeers() {
        val text = NodeService.formatNotificationText(
            syncProgress = "syncing",
            committedHeight = 7890L,
            peerCount = 6L,
        )
        assertTrue("Notification must display sync progress", text.contains("syncing"))
        assertTrue("Notification must display committed DAG height", text.contains("7890"))
        assertTrue("Notification must display peer count", text.contains("6"))
        assertTrue("Notification text must label sync progress", text.contains("Sync progress"))
        assertTrue("Notification text must label committed DAG height", text.contains("Committed DAG height"))
        assertTrue("Notification text must label peer count", text.contains("Peer count"))

        val syncedText = NodeService.formatNotificationText(
            syncProgress = "synced",
            committedHeight = 8000L,
            peerCount = 10L,
        )
        assertTrue(syncedText.contains("synced"))
        assertTrue(syncedText.contains("8000"))
        assertTrue(syncedText.contains("10"))
    }

    @Test
    fun nodeSyncProgressCleanlyReturnsJsonPayloadWithHeightTargetPeers() {
        // Verifies NativeBridge safe progress returns clean JSON payload with height, target, peers
        val json = NativeBridge.safeNodeSyncProgress()
        assertNotNull(json)
        assertTrue(json.contains("\"height\":"))
        assertTrue(json.contains("\"target\":"))
        assertTrue(json.contains("\"peers\":"))

        // Verifies parsing of canonical sync progress JSON payload: { "height": <u64>, "target": <u64>, "peers": <u32> }
        val samplePayload = """{"height":14200,"target":15000,"peers":8,"syncing":true,"catching_up":true}"""
        val height = RpcJson.longField(samplePayload, "height")
        val target = RpcJson.longField(samplePayload, "target")
        val peers = RpcJson.longField(samplePayload, "peers")
        assertEquals(14200L, height)
        assertEquals(15000L, target)
        assertEquals(8L, peers)

        // Verify syncing vs idle notifications formatting
        val syncingNotification = NodeService.formatNotificationText(
            syncProgress = if (target != null && height != null && target > height) "syncing" else "synced",
            committedHeight = height ?: 0L,
            peerCount = peers ?: 0L,
        )
        assertTrue(syncingNotification.contains("Sync progress: syncing"))
        assertTrue(syncingNotification.contains("Committed DAG height: 14200"))
        assertTrue(syncingNotification.contains("Peer count: 8"))

        val idlePayload = """{"height":15000,"target":15000,"peers":8,"syncing":false,"catching_up":false}"""
        val idleHeight = RpcJson.longField(idlePayload, "height")!!
        val idleTarget = RpcJson.longField(idlePayload, "target")!!
        val idlePeers = RpcJson.longField(idlePayload, "peers")!!
        val idleNotification = NodeService.formatNotificationText(
            syncProgress = if (idleTarget > idleHeight) "syncing" else "synced",
            committedHeight = idleHeight,
            peerCount = idlePeers,
        )
        assertTrue(idleNotification.contains("Sync progress: synced"))
        assertTrue(idleNotification.contains("Committed DAG height: 15000"))
        assertTrue(idleNotification.contains("Peer count: 8"))
    }

    @Test
    fun nodeServiceGracefulTeardownCallsNodeStop() {
        val result = NodeService.stopNativeNode()
        assertEquals(0, result)
    }

    @Test
    fun ipcSmokeOverLoopbackRpcPort() {
        // Smoke test verifying JSON-RPC IPC communication between wallet-web (webview)
        // and local Android node service over 127.0.0.1:8545
        var server: ServerSocket? = null
        val running = AtomicBoolean(true)
        val port = NodeConfigText.RPC_PORT
        try {
            server = try {
                ServerSocket().apply {
                    bind(InetSocketAddress("127.0.0.1", port))
                }
            } catch (_: Exception) {
                ServerSocket().apply {
                    bind(InetSocketAddress("127.0.0.1", 0))
                }
            }

            val actualPort = server.localPort
            val base = "http://127.0.0.1:$actualPort"

            val serverThread = Thread {
                while (running.get()) {
                    try {
                        val socket = server.accept()
                        Thread {
                            socket.use { s ->
                                val reader = s.getInputStream().bufferedReader()
                                val firstLine = reader.readLine() ?: return@use
                                var contentLength = 0
                                while (true) {
                                    val header = reader.readLine() ?: break
                                    if (header.isEmpty()) break
                                    if (header.lowercase().startsWith("content-length:")) {
                                        contentLength = header.substringAfter(":").trim().toIntOrNull() ?: 0
                                    }
                                }
                                val body = if (contentLength > 0) {
                                    val chars = CharArray(contentLength)
                                    var read = 0
                                    while (read < contentLength) {
                                        val count = reader.read(chars, read, contentLength - read)
                                        if (count < 0) break
                                        read += count
                                    }
                                    String(chars, 0, read)
                                } else ""

                                val responseBody = when {
                                    firstLine.startsWith("GET /health") ->
                                        """{"status":"healthy","network":"kovanica testnet","peer_count":8}"""
                                    body.contains("kovanica_chainId") ->
                                        """{"jsonrpc":"2.0","id":1,"result":"0x2"}"""
                                    body.contains("kovanica_syncStatus") ->
                                        """{"jsonrpc":"2.0","id":1,"result":{"committedHeight":5400,"catchingUp":false,"peerCount":8,"tips":["0xabcdef0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d"]}}"""
                                    body.contains("kovanica_getBalance") ->
                                        """{"jsonrpc":"2.0","id":1,"result":"0x3b9aca00"}""" // 1 KVNC
                                    else ->
                                        """{"jsonrpc":"2.0","id":1,"result":"ok"}"""
                                }
                                val bytes = responseBody.toByteArray(Charsets.UTF_8)
                                val out = s.getOutputStream()
                                out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.UTF_8))
                                out.write(bytes)
                                out.flush()
                            }
                        }.start()
                    } catch (_: Exception) {
                        break
                    }
                }
            }
            serverThread.isDaemon = true
            serverThread.start()

            // 1. Health endpoint check
            val healthReply = NodeHttp.get(NodeHttp.healthUrl(base))
            assertEquals(200, healthReply.status)
            assertTrue(healthReply.body.contains("healthy"))

            // 2. Chain ID RPC check
            val chainReply = NodeHttp.rpc(base, "kovanica_chainId", "[]")
            assertEquals(200, chainReply.status)
            assertTrue(chainReply.body.contains("0x2"))

            // 3. Sync status RPC check
            val syncReply = NodeHttp.rpc(base, "kovanica_syncStatus", "[]")
            assertEquals(200, syncReply.status)
            val snap = RpcJson.snapshot(healthReply.status, healthReply.body, syncReply.body)
            assertEquals(5400L, snap.committedHeight)
            assertEquals(8L, snap.peerCount)
            assertEquals(false, snap.catchingUp)

            // 4. Balance query check
            val balReply = NodeHttp.rpc(base, "kovanica_getBalance", "[\"$sample\"]")
            assertEquals(200, balReply.status)
            assertEquals(1_000_000_000L, RpcJson.quantityResult(balReply.body))
        } finally {
            running.set(false)
            try {
                server?.close()
            } catch (_: Exception) {}
        }
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
