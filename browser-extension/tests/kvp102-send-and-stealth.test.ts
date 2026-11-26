import { describe, expect, it } from "vitest";
import {
  CHAIN_IDS,
  decodeSignedCallTransaction,
  deriveStealthKeypairFromMnemonic,
  encodeAddress,
  formatStealthMetaAddress,
  isValidStealthMetaAddress,
  parseStealthMetaAddress,
  verifyCallTransactionSignature,
} from "kovanica-sdk";
import { KovanicaProviderController } from "../src/core/provider-protocol";
import { parseTokenUnits, signKvp102TokenTransfer } from "../src/core/tokens";
import {
  MemoryStorageAdapter,
  VaultManager,
  deriveKovanicaStealthMetaAddress,
} from "../src/core/vault";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const CONTRACT_BYTES = new Uint8Array(32).fill(0x55);
const CONTRACT_MAINNET = encodeAddress(CONTRACT_BYTES);
const CONTRACT_TESTNET = `tknc${CONTRACT_MAINNET.slice(4)}`;

const RECIPIENT_BYTES = new Uint8Array(32).fill(0x77);
const RECIPIENT_MAINNET = encodeAddress(RECIPIENT_BYTES);
const RECIPIENT_TESTNET = `tknc${RECIPIENT_MAINNET.slice(4)}`;

describe("KVP-102 token transfer parsing & signing (WALLET_SEND_TOKEN)", () => {
  it("parses human decimal token amounts into exact BigInt base units", () => {
    expect(parseTokenUnits("0", 6)).toBe(0n);
    expect(parseTokenUnits("1", 6)).toBe(1_000_000n);
    expect(parseTokenUnits("12.345", 6)).toBe(12_345_000n);
    expect(parseTokenUnits("0.000001", 6)).toBe(1n);
    expect(parseTokenUnits("42", 0)).toBe(42n);
    expect(parseTokenUnits("1000000000000.123456789", 9)).toBe(1_000_000_000_000_123_456_789n);

    expect(() => parseTokenUnits("", 6)).toThrow(/required/i);
    expect(() => parseTokenUnits("-5", 6)).toThrow(/Invalid token amount/);
    expect(() => parseTokenUnits("1.2345678", 6)).toThrow(/exceeds token precision/);
    expect(() => parseTokenUnits("1.5", 0)).toThrow(/exceeds token precision/);
    expect(() => parseTokenUnits("abc", 6)).toThrow(/Invalid token amount/);
  });

  it("builds and signs a verifiable KVP-102 token_transfer call transaction", async () => {
    const storage = new MemoryStorageAdapter();
    const vault = new VaultManager(storage);
    await vault.createVault({
      password: "TokenSendTestPassword!2026",
      mnemonic: TEST_MNEMONIC,
    });

    const amountUnits = parseTokenUnits("25.5", 6);
    const signed = await vault.withActiveKeypair(({ secretKey, publicKey }) =>
      signKvp102TokenTransfer({
        contractAddress: CONTRACT_MAINNET,
        recipientAddress: RECIPIENT_MAINNET,
        amountUnits,
        nonce: 4n,
        fee: 1_000_000n,
        chainId: CHAIN_IDS.MAINNET,
        privateKey: secretKey,
        publicKey,
      }),
    );

    expect(signed.rawTxHex.startsWith("0x")).toBe(true);
    expect(signed.signingHashHex.startsWith("0x")).toBe(true);
    expect(signed.signatureHex.startsWith("0x")).toBe(true);
    expect(signed.call.method).toBe("token_transfer");

    const decoded = decodeSignedCallTransaction(signed.rawTxHex, {
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(verifyCallTransactionSignature(decoded)).toBe(true);
    expect(decoded.method).toBe("token_transfer");
    expect(decoded.nonce).toBe(4n);
    expect(decoded.fee).toBe(1_000_000n);
  });

  it("rejects invalid addresses, cross-network addresses, and zero amounts", async () => {
    const storage = new MemoryStorageAdapter();
    const vault = new VaultManager(storage);
    await vault.createVault({
      password: "TokenSendTestPassword!2026",
      mnemonic: TEST_MNEMONIC,
    });

    await vault.withActiveKeypair(({ secretKey, publicKey }) => {
      // Cross-network recipient (testnet address on mainnet)
      expect(() =>
        signKvp102TokenTransfer({
          contractAddress: CONTRACT_MAINNET,
          recipientAddress: RECIPIENT_TESTNET,
          amountUnits: 100n,
          nonce: 0n,
          chainId: CHAIN_IDS.MAINNET,
          privateKey: secretKey,
          publicKey,
        }),
      ).toThrow();

      // Cross-network contract (testnet contract on mainnet)
      expect(() =>
        signKvp102TokenTransfer({
          contractAddress: CONTRACT_TESTNET,
          recipientAddress: RECIPIENT_MAINNET,
          amountUnits: 100n,
          nonce: 0n,
          chainId: CHAIN_IDS.MAINNET,
          privateKey: secretKey,
          publicKey,
        }),
      ).toThrow();

      // Zero amount
      expect(() =>
        signKvp102TokenTransfer({
          contractAddress: CONTRACT_MAINNET,
          recipientAddress: RECIPIENT_MAINNET,
          amountUnits: 0n,
          nonce: 0n,
          chainId: CHAIN_IDS.MAINNET,
          privateKey: secretKey,
          publicKey,
        }),
      ).toThrow(/greater than zero/i);
    });
  });
});

describe("KVP-103 stealth meta-address derivation & provider exposure", () => {
  it("deterministically derives a valid st:kvnc:... meta-address without leaking private keys", () => {
    const expectedKp = deriveStealthKeypairFromMnemonic(TEST_MNEMONIC);
    const expectedMeta = formatStealthMetaAddress(
      expectedKp.scanPubkeyHex,
      expectedKp.spendPubkeyHex,
    );

    const derived = deriveKovanicaStealthMetaAddress(TEST_MNEMONIC);
    expect(derived.metaAddress).toBe(expectedMeta);
    expect(derived.metaAddress.startsWith("st:kvnc:")).toBe(true);
    expect(isValidStealthMetaAddress(derived.metaAddress)).toBe(true);

    const parsed = parseStealthMetaAddress(derived.metaAddress);
    expect(parsed.scanPubkeyHex).toBe(derived.scanPubkeyHex);
    expect(parsed.spendPubkeyHex).toBe(derived.spendPubkeyHex);

    // Ensure private keys are never present on the returned object
    expect("scanPrivkeyHex" in derived).toBe(false);
    expect("spendPrivkeyHex" in derived).toBe(false);
  });

  it("gates stealth meta-address on vault unlock state and connected dApp origin", async () => {
    const storage = new MemoryStorageAdapter();
    const vault = new VaultManager(storage);
    await vault.createVault({
      password: "StealthTestPassword!2026",
      mnemonic: TEST_MNEMONIC,
    });

    const expectedMeta = deriveKovanicaStealthMetaAddress(TEST_MNEMONIC).metaAddress;
    expect(vault.getStealthMetaAddress()?.metaAddress).toBe(expectedMeta);

    let pendingApprovalId = "";
    const controller = new KovanicaProviderController({
      vault,
      initialChainId: CHAIN_IDS.MAINNET,
      onApprovalPrompt: (req) => {
        pendingApprovalId = req.id;
      },
    });

    const origin = "https://pay.kovanica.online";

    // Unconnected origin cannot read stealth meta-address
    await expect(
      controller.handleRequest(origin, "kovanica_getStealthMetaAddress"),
    ).rejects.toThrow(/not connected/i);

    // Connect origin
    const connectPromise = controller.handleRequest(origin, "connect");
    await controller.resolveApproval(pendingApprovalId, true);
    await connectPromise;

    // Connected + unlocked returns deterministic st:kvnc:... meta-address
    const providerMeta = await controller.handleRequest(
      origin,
      "kovanica_getStealthMetaAddress",
    );
    expect(providerMeta).toBe(expectedMeta);

    // Locking the vault clears stealth meta-address access
    vault.lock();
    expect(vault.getStealthMetaAddress()).toBeNull();
    await expect(
      controller.handleRequest(origin, "kovanica_getStealthMetaAddress"),
    ).rejects.toThrow(/locked/i);
  });
});
