package io.kovanica.comms

import io.kovanica.chain.ChainIds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkProfileTest {
    @Test
    fun testnetProfileIsTheLiveChain2() {
        assertEquals("testnet", Networks.TESTNET.id)
        assertEquals(ChainIds.TESTNET, Networks.TESTNET.chainId)
        assertEquals(2L, Networks.TESTNET.chainId)
        assertEquals("Testnet (chain 2)", Networks.TESTNET.label)
        assertEquals("https://rpc-testnet.kovanica.online/rpc", Networks.TESTNET.rpcUrl)
    }

    @Test
    fun aFreshInstallOpensOnTheTestnet() {
        assertEquals("testnet", Networks.DEFAULT.id)
        assertEquals(Networks.TESTNET, Networks.DEFAULT)
    }

    @Test
    fun devnetStaysSelectableForDevelopment() {
        assertEquals(3L, Networks.DEVNET.chainId)
        assertTrue(Networks.ALL.contains(Networks.DEVNET))
    }

    @Test
    fun byRpcMatchesTheBuiltInEndpointsAndIgnoresATrailingSlash() {
        assertEquals(Networks.TESTNET, Networks.byRpc("https://rpc-testnet.kovanica.online/rpc"))
        assertEquals(Networks.TESTNET, Networks.byRpc(" https://rpc-testnet.kovanica.online/rpc/ "))
        assertEquals(Networks.DEVNET, Networks.byRpc("http://10.0.2.2:8545/rpc"))
        assertNull(Networks.byRpc("https://example.invalid/rpc"))
    }
}
