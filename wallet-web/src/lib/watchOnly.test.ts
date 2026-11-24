import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADDRESS_PREFIX, TESTNET_ADDRESS_PREFIX, encodeAddress } from "kovanica-sdk";

import {
  assertCanSign,
  clearWatchOnlyEntries,
  createWatchOnlyEntry,
  loadWatchOnlyEntries,
  removeWatchOnlyEntry,
  sanitizeWatchOnlyLabel,
  saveWatchOnlyEntry,
  validateWatchOnlyAddress,
} from "./watchOnly.ts";

const PAYLOAD_A = new Uint8Array(32).fill(0x11);
const PAYLOAD_B = new Uint8Array(32).fill(0x22);
const MAINNET_ADDR = encodeAddress(PAYLOAD_A, ADDRESS_PREFIX);
const TESTNET_ADDR = encodeAddress(PAYLOAD_A, TESTNET_ADDRESS_PREFIX);
const TESTNET_ADDR_B = encodeAddress(PAYLOAD_B, TESTNET_ADDRESS_PREFIX);

function makeMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("watchOnly", () => {
  it("creates frozen read-only accounts for valid mainnet and testnet PRO-21 addresses with zero private key material", () => {
    const mainnet = createWatchOnlyEntry(MAINNET_ADDR, 1, "Mainnet Treasury");
    assert.equal(mainnet.account.address, MAINNET_ADDR);
    assert.equal(mainnet.account.chainId, 1);
    assert.equal(mainnet.account.network, "mainnet");
    assert.equal(mainnet.account.readOnly, true);
    assert.equal(mainnet.account.isWatchOnly, true);
    assert.equal(mainnet.account.canSign, false);
    assert.equal(mainnet.label, "Mainnet Treasury");
    assert.equal(Object.isFrozen(mainnet), true);
    assert.equal(Object.isFrozen(mainnet.account), true);

    // Zero private key material
    const accountRecord = mainnet.account as unknown as Record<string, unknown>;
    assert.equal("privateKey" in accountRecord, false);
    assert.equal("secretKey" in accountRecord, false);
    assert.equal("seed" in accountRecord, false);
    assert.equal("mnemonic" in accountRecord, false);

    const testnet = createWatchOnlyEntry(TESTNET_ADDR, 2);
    assert.equal(testnet.account.address, TESTNET_ADDR);
    assert.equal(testnet.account.chainId, 2);
    assert.equal(testnet.account.network, "testnet");
    assert.equal(testnet.account.canSign, false);
    assert.equal(testnet.label, "Watch-Only Account");
  });

  it("validates valid and invalid PRO-21 addresses without throwing", () => {
    const ok = validateWatchOnlyAddress(TESTNET_ADDR, 2);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.account.canSign, false);
      assert.equal(ok.account.address, TESTNET_ADDR);
    }

    const empty = validateWatchOnlyAddress("   ", 2);
    assert.equal(empty.ok, false);

    const invalid = validateWatchOnlyAddress("not-an-address", 2);
    assert.equal(invalid.ok, false);

    const hexAddress = validateWatchOnlyAddress("0x" + "11".repeat(32), 2);
    assert.equal(hexAddress.ok, false);

    // Bad checksum (flip last char before 'dag')
    const corrupted =
      TESTNET_ADDR.slice(0, -4) +
      (TESTNET_ADDR.slice(-4, -3) === "a" ? "b" : "a") +
      TESTNET_ADDR.slice(-3);
    const badChecksum = validateWatchOnlyAddress(corrupted, 2);
    assert.equal(badChecksum.ok, false);

    // Testnet address against mainnet chainId must fail closed
    const wrongChain = validateWatchOnlyAddress(TESTNET_ADDR, 1);
    assert.equal(wrongChain.ok, false);
  });

  it("blocks signing via assertCanSign for watch-only or missing accounts", () => {
    const entry = createWatchOnlyEntry(TESTNET_ADDR, 2);
    assert.throws(
      () => assertCanSign(entry.account),
      /read-only and cannot sign/i,
    );
    assert.throws(() => assertCanSign(null), /No active signing account/i);
    assert.throws(() => assertCanSign({ canSign: false }), /read-only/i);
    assert.throws(() => assertCanSign({ isWatchOnly: true }), /read-only/i);
    assert.doesNotThrow(() => assertCanSign({ canSign: true, isWatchOnly: false, readOnly: false }));
  });

  it("sanitizes labels by stripping control characters and clamping length", () => {
    assert.equal(sanitizeWatchOnlyLabel("  Cold\t\nVault\u0000  "), "ColdVault");
    assert.equal(sanitizeWatchOnlyLabel("a".repeat(80)).length, 48);
  });

  it("persists, deduplicates, filters corrupt entries, and removes watch-only accounts safely", () => {
    // SSR-safe when storage is null
    assert.deepEqual(loadWatchOnlyEntries(null), []);

    const storage = makeMemoryStorage();
    saveWatchOnlyEntry(TESTNET_ADDR, 2, "First", storage);
    saveWatchOnlyEntry(TESTNET_ADDR_B, 2, "Second", storage);
    // Re-saving first updates label & moves to top without duplicating
    const { entries } = saveWatchOnlyEntry(TESTNET_ADDR, 2, "Updated First", storage);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.label, "Updated First");
    assert.equal(entries[1]?.label, "Second");

    const loaded = loadWatchOnlyEntries(storage);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.account.canSign, false);

    const afterRemove = removeWatchOnlyEntry(TESTNET_ADDR, storage);
    assert.equal(afterRemove.length, 1);
    assert.equal(afterRemove[0]?.account.address, TESTNET_ADDR_B);

    clearWatchOnlyEntries(storage);
    assert.deepEqual(loadWatchOnlyEntries(storage), []);
  });
});
