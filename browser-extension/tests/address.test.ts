import { describe, expect, it } from "vitest";
import { ADDRESS_PREFIX, CHAIN_IDS, TESTNET_ADDRESS_PREFIX, bytesToHex, encodeAddress } from "kovanica-sdk";
import { validateRecipientAddress } from "../src/core/networks";

const SAMPLE_PUBKEY = new Uint8Array(32).fill(0x42);
const MAINNET_PRO21 = encodeAddress(SAMPLE_PUBKEY, ADDRESS_PREFIX);
const TESTNET_PRO21 = encodeAddress(SAMPLE_PUBKEY, TESTNET_ADDRESS_PREFIX);
const LEGACY_HEX = `0x${bytesToHex(SAMPLE_PUBKEY)}`;

describe("PRO-21 Address Validation", () => {
  it("accepts canonical kvnc...dag on Mainnet and rejects tknc...dag and legacy hex", () => {
    const ok = validateRecipientAddress(MAINNET_PRO21, CHAIN_IDS.MAINNET);
    expect(ok.valid).toBe(true);
    expect(ok.strictPro21).toBe(true);
    expect(ok.format).toBe("pro21-mainnet");

    const badTestnet = validateRecipientAddress(TESTNET_PRO21, CHAIN_IDS.MAINNET);
    expect(badTestnet.valid).toBe(false);

    const badLegacy = validateRecipientAddress(LEGACY_HEX, CHAIN_IDS.MAINNET);
    expect(badLegacy.valid).toBe(false);
  });

  it("accepts tknc...dag and kvnc...dag on Testnet while strictly rejecting legacy hex", () => {
    expect(validateRecipientAddress(TESTNET_PRO21, CHAIN_IDS.TESTNET).valid).toBe(true);
    expect(validateRecipientAddress(MAINNET_PRO21, CHAIN_IDS.TESTNET).valid).toBe(true);
    expect(validateRecipientAddress(LEGACY_HEX, CHAIN_IDS.TESTNET).valid).toBe(false);
  });

  it("accepts legacy hex only on Devnet with a warning and rejects corrupted PRO-21 checksums", () => {
    const devLegacy = validateRecipientAddress(LEGACY_HEX, CHAIN_IDS.DEVNET);
    expect(devLegacy.valid).toBe(true);
    expect(devLegacy.strictPro21).toBe(false);
    expect(devLegacy.warning).toBeTruthy();

    const corrupted = MAINNET_PRO21.slice(0, 20) + (MAINNET_PRO21[20] === "q" ? "p" : "q") + MAINNET_PRO21.slice(21);
    expect(validateRecipientAddress(corrupted, CHAIN_IDS.MAINNET).valid).toBe(false);
  });
});
