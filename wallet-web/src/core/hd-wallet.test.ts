import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAIN_IDS, KOVANICA_COIN_TYPE } from "kovanica-sdk";
import {
  checkAddress,
  decodeAddress,
  encodeAddress,
  formatAddressForChain,
} from "./address.ts";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import {
  bip39Seed,
  deriveBip44,
  deriveHardened,
  entropyFromPhrase,
  formatBip44,
  hdPrivateKey,
  masterFromSeed,
} from "./hd.ts";
import { publicKeyFromSeed } from "./tx.ts";
import { describeAccount } from "./session.ts";
import { openVault, sealVault } from "./keystore.ts";

describe("Canonical HD Wallet & Address Consistency (PRO-45, PRO-46, PRO-47, PRO-55)", () => {
  const goldenMnemonic =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const expectedPubkey =
    "862f70cfafc9b581699f8d67598eac699cbc92bdfc940e95ed7ee1e8d8100e7e";
  const expectedMainnetAddr =
    "kvncschhpna0ex6cz6vl34n4nr4vdxwtey4alj2qa90d0ms73kqspel0nuhe8dag";
  const expectedTestnetAddr =
    "tkncschhpna0ex6cz6vl34n4nr4vdxwtey4alj2qa90d0ms73kqspel0nuhe8dag";

  describe("Coin Type 3007 & Golden Test Vector", () => {
    it("ensures canonical coin type is 3007", () => {
      assert.equal(KOVANICA_COIN_TYPE, 3007);
    });

    it("derives the exact golden public key and address at m/44'/3007'/0'/0'/0'", () => {
      const seed64 = bip39Seed(goldenMnemonic, "");
      const privKey = deriveBip44(seed64, 0, 0, 0);
      const pubKey = publicKeyFromSeed(privKey);
      const pubKeyHex = bytesToHex(pubKey);
      assert.equal(pubKeyHex, expectedPubkey);

      const address = encodeAddress(pubKey);
      assert.equal(address, expectedMainnetAddr);
    });

    it("matches derivation via entropy and hdPrivateKey", () => {
      const entropy = entropyFromPhrase(goldenMnemonic);
      const privKey = hdPrivateKey(entropy, "", 0, 0, 0);
      const pubKey = publicKeyFromSeed(privKey);
      assert.equal(bytesToHex(pubKey), expectedPubkey);
    });
  });

  describe("Multi-Account Derivation", () => {
    it("derives distinct accounts with canonical paths m/44'/3007'/account'/0'/0'", () => {
      const seed64 = bip39Seed(goldenMnemonic, "");
      const path0 = formatBip44(0, 0, 0);
      const path1 = formatBip44(1, 0, 0);
      const path2 = formatBip44(2, 0, 0);

      assert.equal(path0, "m/44'/3007'/0'/0'/0'");
      assert.equal(path1, "m/44'/3007'/1'/0'/0'");
      assert.equal(path2, "m/44'/3007'/2'/0'/0'");

      const priv0 = deriveBip44(seed64, 0, 0, 0);
      const priv1 = deriveBip44(seed64, 1, 0, 0);
      const priv2 = deriveBip44(seed64, 2, 0, 0);

      const pub0 = bytesToHex(publicKeyFromSeed(priv0));
      const pub1 = bytesToHex(publicKeyFromSeed(priv1));
      const pub2 = bytesToHex(publicKeyFromSeed(priv2));

      assert.equal(pub0, expectedPubkey);
      assert.notEqual(pub0, pub1);
      assert.notEqual(pub1, pub2);
      assert.notEqual(pub0, pub2);
    });

    it("enforces hardened derivation under SLIP-0010 Ed25519", () => {
      const seed64 = bip39Seed(goldenMnemonic, "");
      const master = masterFromSeed(seed64);
      assert.throws(() => deriveHardened(master, 0), /non-hardened step/i);
    });
  });

  describe("Network-Aware Address Formatting", () => {
    it("formats Mainnet (chain 1) with kvnc...dag prefix", () => {
      const formatted = formatAddressForChain(expectedMainnetAddr, CHAIN_IDS.MAINNET);
      assert.equal(formatted, expectedMainnetAddr);
      assert.ok(formatted.startsWith("kvnc"));
      assert.ok(formatted.endsWith("dag"));
    });

    it("formats Testnet (chain 2) with tknc...dag prefix", () => {
      const formatted = formatAddressForChain(expectedMainnetAddr, CHAIN_IDS.TESTNET);
      assert.equal(formatted, expectedTestnetAddr);
      assert.ok(formatted.startsWith("tknc"));
      assert.ok(formatted.endsWith("dag"));
    });

    it("round-trips between kvnc and tknc addresses to the same public key", () => {
      const decodedMain = decodeAddress(expectedMainnetAddr);
      const formattedTest = formatAddressForChain(expectedMainnetAddr, CHAIN_IDS.TESTNET);
      const checkTest = checkAddress(formattedTest, CHAIN_IDS.TESTNET);
      assert.ok(checkTest.ok, `checkAddress failed: ${checkTest.message}`);

      const formattedBackToMain = formatAddressForChain(formattedTest, CHAIN_IDS.MAINNET);
      assert.equal(formattedBackToMain, expectedMainnetAddr);
      const decodedBack = decodeAddress(formattedBackToMain);
      assert.equal(bytesToHex(decodedMain), bytesToHex(decodedBack));
      assert.equal(bytesToHex(decodedBack), expectedPubkey);
    });
  });

  describe("Legacy Raw Secret Key Compatibility", () => {
    it("seals and opens legacy 32-byte secret key vault", async () => {
      const rawSeed = hexToBytes("11".repeat(32));
      const password = "correct-horse-battery-staple";
      const pubkey = publicKeyFromSeed(rawSeed);
      const account = describeAccount("legacy", { account: 0, change: 0, index: 0 }, pubkey);

      const vault = await sealVault(
        { kind: "legacy", seed: rawSeed },
        password,
        {
          kind: "legacy",
          wordCount: null,
          usesBip39Passphrase: false,
          accounts: [account],
        },
      );

      assert.equal(vault.kind, "legacy");
      assert.equal(vault.accounts.length, 1);
      assert.equal(vault.accounts[0].pathLabel, "Legacy account");

      const opened = await openVault(vault, password);
      assert.equal(opened.kind, "legacy");
      if (opened.kind === "legacy") {
        assert.equal(bytesToHex(opened.seed), "11".repeat(32));
      }
    });
  });
});
