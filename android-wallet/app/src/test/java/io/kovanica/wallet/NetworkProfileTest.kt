package io.kovanica.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkProfileTest {
    @Test
    fun testnetProfileUsesChain2() {
        assertEquals(2L, Networks.TESTNET.chainId)
        assertEquals("testnet", Networks.TESTNET.id)
        assertTrue(Networks.TESTNET.enabled)
        assertEquals("Testnet", Networks.TESTNET.label)
    }

    @Test
    fun theLiveTestnetHasAReachableFaucet() {
        assertEquals("https://faucet-testnet.kovanica.online/faucet", Networks.TESTNET.faucetUrl)
    }

    @Test
    fun onlyTestnetAndMainnetAreExposed() {
        assertEquals(listOf(Networks.TESTNET, Networks.MAINNET), Networks.ALL)
        assertEquals(1L, Networks.MAINNET.chainId)
        assertEquals("Mainnet", Networks.MAINNET.label)
    }

    @Test
    fun aFreshInstallOpensOnTheLiveTestnet() {
        assertEquals("testnet", Networks.DEFAULT.id)
        assertEquals(Networks.TESTNET, Networks.DEFAULT)
    }
}
