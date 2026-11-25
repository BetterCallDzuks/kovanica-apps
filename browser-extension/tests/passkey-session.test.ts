import { describe, expect, it } from "vitest";
import {
  CHAIN_IDS,
  SignatureScheme,
  bytesToHex,
  deriveTypedAddress,
  encodeAddress,
  getPublicKey,
  verifyEd25519,
} from "kovanica-sdk";
import {
  derivePasskeyTypedAddress,
  registerPasskeyForVault,
  unwrapVaultPasswordWithPasskey,
  type WebAuthnAdapter,
} from "../src/core/passkey";
import {
  evaluateSessionPolicy,
  generateEphemeralSessionKeypair,
  signRegisterSessionKeyTransaction,
  signRevokeSessionKeyTransaction,
  type LocalSessionKeyRecord,
} from "../src/core/session-keys";
import { MemoryStorageAdapter, VaultManager } from "../src/core/vault";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("Passkey / WebAuthn (Secp256r1WebAuthn) & Wave C Session Keys", () => {
  it("derives Secp256r1WebAuthn typed address and unlocks vault via wrapped PRF key without plaintext", async () => {
    const mockP256Pub = new Uint8Array(65);
    mockP256Pub[0] = 0x04;
    mockP256Pub.fill(0x55, 1);

    const mockPrf = new Uint8Array(32).fill(0xaa);
    const mockAdapter: WebAuthnAdapter = {
      async createPasskey() {
        return {
          credentialId: "cred_01",
          p256PublicKey: mockP256Pub,
          prfSecret: new Uint8Array(mockPrf),
        };
      },
      async assertPasskey() {
        return {
          credentialId: "cred_01",
          prfSecret: new Uint8Array(mockPrf),
        };
      },
    };

    const typed = derivePasskeyTypedAddress(mockP256Pub, CHAIN_IDS.MAINNET);
    const sdkTyped = deriveTypedAddress(SignatureScheme.Secp256r1WebAuthn, mockP256Pub);
    expect(typed.scheme).toBe(SignatureScheme.Secp256r1WebAuthn);
    expect(typed.typedAddressHex).toBe(`0x${bytesToHex(sdkTyped)}`);
    expect(typed.pro21Address).toBe(encodeAddress(sdkTyped));

    const storage = new MemoryStorageAdapter();
    const vault = new VaultManager(storage);
    const password = "PasskeyVaultPassword!2026";
    await vault.createVault({ password, mnemonic: TEST_MNEMONIC });

    const wrapped = await registerPasskeyForVault({
      adapter: mockAdapter,
      rpId: "kovanica.online",
      userName: "alice@kovanica",
      vaultPassword: password,
      chainId: CHAIN_IDS.MAINNET,
    });
    await vault.setPasskeyUnlock(wrapped);

    // Ensure wrapped passkey record never contains plaintext password
    expect(JSON.stringify(storage.dumpRaw())).not.toContain(password);

    vault.lock();
    expect(vault.isUnlocked()).toBe(false);

    const unwrapped = await unwrapVaultPasswordWithPasskey({
      adapter: mockAdapter,
      rpId: "kovanica.online",
      record: wrapped,
    });
    expect(unwrapped).toBe(password);

    await vault.unlock(unwrapped);
    expect(vault.isUnlocked()).toBe(true);

    // Wrong PRF secret must fail AES-GCM decryption
    const badAdapter: WebAuthnAdapter = {
      ...mockAdapter,
      async assertPasskey() {
        return { credentialId: "cred_01", prfSecret: new Uint8Array(32).fill(0xbb) };
      },
    };
    await expect(
      unwrapVaultPasswordWithPasskey({
        adapter: badAdapter,
        rpId: "kovanica.online",
        record: wrapped,
      }),
    ).rejects.toThrow();
  });

  it("builds & signs RegisterSessionKey / RevokeSessionKey txs and enforces session policies", () => {
    const ownerPriv = new Uint8Array(32).fill(0x11);
    const ownerPub = getPublicKey(ownerPriv);
    const ownerAddr = encodeAddress(ownerPub);
    const contractAddr = encodeAddress(new Uint8Array(32).fill(0x22));
    const ephemeral = generateEphemeralSessionKeypair(CHAIN_IDS.MAINNET);

    const regSigned = signRegisterSessionKeyTransaction({
      chainId: CHAIN_IDS.MAINNET,
      senderPrivateKey: ownerPriv,
      senderPublicKey: ownerPub,
      nonce: 10,
      fee: 1_000_000n,
      policy: {
        owner: ownerPub,
        sessionPubkey: ephemeral.publicKey,
        allowedContracts: [contractAddr],
        allowedMethods: ["swap", "transfer"],
        maxSpendAtoms: 5_000_000_000n,
        expiresRound: 100_000n,
        chainId: CHAIN_IDS.MAINNET,
      },
    });
    expect(regSigned.kind).toBe("RegisterSessionKey");
    expect(verifyEd25519(regSigned.signature, regSigned.hash, ownerPub)).toBe(true);

    const revSigned = signRevokeSessionKeyTransaction({
      chainId: CHAIN_IDS.MAINNET,
      senderPrivateKey: ownerPriv,
      senderPublicKey: ownerPub,
      nonce: 11,
      fee: 1_000_000n,
      sessionPubkey: ephemeral.address,
    });
    expect(revSigned.kind).toBe("RevokeSessionKey");
    expect(verifyEd25519(revSigned.signature, revSigned.hash, ownerPub)).toBe(true);

    const record: LocalSessionKeyRecord = {
      id: "sk_test",
      label: "DEX Session",
      ownerAddress: ownerAddr,
      sessionPubkeyHex: ephemeral.publicKeyHex,
      sessionAddress: ephemeral.address,
      allowedContracts: [contractAddr],
      allowedMethods: ["swap"],
      maxSpendAtoms: "5000000000",
      spentAtoms: "1000000000",
      expiresRound: "100000",
      revoked: false,
      createdAt: Date.now(),
    };

    expect(evaluateSessionPolicy(record, contractAddr, "swap", 2_000_000_000n, 50_000n)).toEqual({
      allowed: true,
    });
    expect(evaluateSessionPolicy(record, contractAddr, "burn", 100n, 50_000n)).toEqual({
      allowed: false,
      reason: "method not allowed",
    });
    expect(evaluateSessionPolicy(record, contractAddr, "swap", 5_000_000_000n, 50_000n)).toEqual({
      allowed: false,
      reason: "spending limit exceeded",
    });
    expect(evaluateSessionPolicy(record, contractAddr, "swap", 100n, 100_000n)).toEqual({
      allowed: false,
      reason: "session key expired",
    });
    expect(
      evaluateSessionPolicy({ ...record, revoked: true }, contractAddr, "swap", 100n, 50_000n),
    ).toEqual({
      allowed: false,
      reason: "session key revoked",
    });
  });
});
