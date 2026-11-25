import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAIN_IDS,
  KOVANICA_COIN_TYPE,
  bip39Seed,
  bytesToHex,
  deriveBip44,
  encodeAddress,
  getPublicKey,
  masterFromSeed,
} from "kovanica-sdk";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  MemoryStorageAdapter,
  VAULT_STORAGE_KEY,
  VaultManager,
  deriveKovanicaAccount,
  encryptVaultPayload,
} from "../src/core/vault";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("Encrypted Local Vault & BIP-44 (coin type 3007)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces PBKDF2-SHA256 >= 600,000 iterations and AES-256-GCM with zero plaintext storage", async () => {
    const storage = new MemoryStorageAdapter();
    const vault = new VaultManager(storage);

    expect(DEFAULT_PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(MIN_PBKDF2_ITERATIONS).toBe(600_000);

    await expect(
      encryptVaultPayload(
        { mnemonic: TEST_MNEMONIC, passphrase: "", accountLabels: {} },
        "StrongPass123!",
        { iterations: 100_000 },
      ),
    ).rejects.toThrow(/600000/);

    const { accounts } = await vault.createVault({
      password: "StrongVaultPassword!2026",
      mnemonic: TEST_MNEMONIC,
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.path).toBe("m/44'/3007'/0'/0'/0'");
    expect(accounts[0]!.mainnetAddress.startsWith("kvnc")).toBe(true);
    expect(accounts[0]!.mainnetAddress.endsWith("dag")).toBe(true);
    expect(accounts[0]!.mainnetAddress.length).toBe(64);

    // Verify zero plaintext mnemonic or private key in storage
    const rawDump = JSON.stringify(storage.dumpRaw());
    expect(rawDump).not.toContain("abandon");
    expect(rawDump).not.toContain("about");
    expect(rawDump).not.toContain("StrongVaultPassword");

    const derived = deriveKovanicaAccount(TEST_MNEMONIC, 0);
    expect(rawDump).not.toContain(bytesToHex(derived.secretKey));

    const stored = await storage.get<Record<string, unknown>>(VAULT_STORAGE_KEY);
    expect(stored?.kdf).toBe("PBKDF2-SHA256");
    expect(stored?.cipher).toBe("AES-256-GCM");
    expect(stored?.iterations).toBeGreaterThanOrEqual(600_000);

    // Lock, reject wrong password, unlock with correct password
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.getAccounts(CHAIN_IDS.MAINNET)).toEqual([]);

    await expect(vault.unlock("WrongPassword!999")).rejects.toThrow(/Invalid vault password/);

    const unlockedAccounts = await vault.unlock("StrongVaultPassword!2026");
    expect(vault.isUnlocked()).toBe(true);
    expect(unlockedAccounts[0]!.mainnetAddress).toBe(accounts[0]!.mainnetAddress);
  });

  it("derives deterministic SLIP-0010 Ed25519 keys on BIP-44 coin type 3007 matching kovanica-sdk", async () => {
    const derived0 = deriveKovanicaAccount(TEST_MNEMONIC, 0);
    const derived1 = deriveKovanicaAccount(TEST_MNEMONIC, 1);

    const seed = bip39Seed(TEST_MNEMONIC, "");
    const sdkNode0 = deriveBip44(seed, 0, 0, 0, KOVANICA_COIN_TYPE);
    const sdkPub0 = getPublicKey(sdkNode0.key);

    expect(derived0.path).toBe("m/44'/3007'/0'/0'/0'");
    expect(derived1.path).toBe("m/44'/3007'/1'/0'/0'");
    expect(bytesToHex(derived0.publicKey)).toBe(bytesToHex(sdkPub0));
    expect(derived0.mainnetAddress).toBe(encodeAddress(sdkPub0));
    expect(derived0.mainnetAddress).not.toBe(derived1.mainnetAddress);
  });

  it("auto-locks the vault when the inactivity timer fires", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorageAdapter();
    let lockedCount = 0;
    const vault = new VaultManager(storage, () => {
      lockedCount += 1;
    });

    await vault.createVault({
      password: "AutoLockPassword!2026",
      mnemonic: TEST_MNEMONIC,
      autoLockMinutes: 5,
    });
    expect(vault.isUnlocked()).toBe(true);

    vi.advanceTimersByTime(4 * 60_000);
    expect(vault.isUnlocked()).toBe(true);

    // Activity resets timer
    vault.touchActivity();
    vi.advanceTimersByTime(4 * 60_000);
    expect(vault.isUnlocked()).toBe(true);

    vi.advanceTimersByTime(2 * 60_000);
    expect(vault.isUnlocked()).toBe(false);
    expect(lockedCount).toBe(1);
  });
});
