package io.kovanica.chain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChainIdsTest {
    @Test
    fun legacySetMatchesRust() {
        assertTrue(ChainIds.legacyAllowed(ChainIds.DEVNET))
        assertFalse(ChainIds.legacyAllowed(ChainIds.TESTNET))
        assertFalse(ChainIds.legacyAllowed(ChainIds.HYBRID))
        assertTrue(ChainIds.legacyAllowed(ChainIds.LOCAL))
        assertFalse(ChainIds.legacyAllowed(ChainIds.MAINNET))
        assertFalse(ChainIds.legacyAllowed(ChainIds.UNSPECIFIED))
        assertFalse(ChainIds.legacyAllowed(0))
        assertFalse(ChainIds.legacyAllowed(4))
    }

    @Test
    fun blankOrGarbageFieldUsesTheProfileNotZero() {
        assertEquals(ChainIds.TESTNET.toULong(), ChainIds.resolve("", ChainIds.TESTNET))
        assertEquals(ChainIds.TESTNET.toULong(), ChainIds.resolve("   ", ChainIds.TESTNET))
        assertEquals(ChainIds.TESTNET.toULong(), ChainIds.resolve("nope", ChainIds.TESTNET))
        assertEquals(ChainIds.LOCAL.toULong(), ChainIds.resolve("", ChainIds.LOCAL))
        assertEquals(1UL, ChainIds.resolve("1", ChainIds.TESTNET))
        assertEquals(0UL, ChainIds.resolve("0", ChainIds.TESTNET))
    }
}
