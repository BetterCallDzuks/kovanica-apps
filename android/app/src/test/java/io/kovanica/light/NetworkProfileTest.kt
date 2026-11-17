package io.kovanica.light

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkProfileTest {
    @Test
    fun testnetProfileUsesChain2() {
        assertEquals(2L, Networks.TESTNET.chainId)
        assertEquals("testnet", Networks.TESTNET.id)
        assertTrue(Networks.TESTNET.enabled)
        assertEquals("Testnet (chain 2)", Networks.TESTNET.label)
    }

    @Test
    fun theLiveTestnetHasAReachableFaucet() {
        assertEquals("https://seed3.kovanica.online/faucet", Networks.TESTNET.faucetUrl)
    }

    @Test
    fun otherProfilesKeepTheirChainIds() {
        assertEquals(1L, Networks.MAINNET.chainId)
        assertEquals(3L, Networks.DEVNET.chainId)
    }

    @Test
    fun aFreshInstallOpensOnTheLiveTestnet() {
        assertEquals("testnet", Networks.DEFAULT.id)
        assertEquals(Networks.TESTNET, Networks.DEFAULT)
    }
}
