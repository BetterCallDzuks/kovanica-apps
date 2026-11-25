import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  ADDRESS_PREFIX,
  BIP44_PURPOSE,
  CHAIN_IDS,
  KOVANICA_COIN_TYPE,
  TESTNET_ADDRESS_PREFIX,
  bip39Seed,
  bytesToHex,
  deriveBip44,
  encodeAddress,
  getPublicKey,
  hexToBytes,
  masterFromSeed,
  wipe,
} from "kovanica-sdk";

export const VAULT_STORAGE_KEY = "kovanica_encrypted_vault_v1";
export const VAULT_VERSION = 1;
export const MIN_PBKDF2_ITERATIONS = 600_000;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

export interface VaultStorageAdapter {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryStorageAdapter implements VaultStorageAdapter {
  private readonly store = new Map<string, string>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }

  dumpRaw(): Record<string, string> {
    return Object.fromEntries(this.store.entries());
  }
}

export class ChromeLocalStorageAdapter implements VaultStorageAdapter {
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const result = await chrome.storage.local.get(key);
    return result[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  }
}

export interface PasskeyWrappedVaultKey {
  credentialId: string;
  p256PublicKeyHex: string;
  typedAddressHex: string;
  pro21Address: string;
  ivHex: string;
  wrappedPasswordHex: string;
  createdAt: number;
}

/**
 * Encrypted envelope persisted in storage.
 * NEVER contains plaintext mnemonic, seed, or private keys.
 */
export interface EncryptedVaultRecord {
  version: number;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  cipher: "AES-256-GCM";
  saltHex: string;
  ivHex: string;
  ciphertextHex: string;
  autoLockMinutes: number;
  accountCount: number;
  activeAccountIndex: number;
  createdAt: number;
  passkeyUnlock?: PasskeyWrappedVaultKey;
}

interface DecryptedVaultPayload {
  mnemonic: string;
  passphrase: string;
  accountLabels: Record<number, string>;
}

export interface WalletAccountSummary {
  index: number;
  label: string;
  path: string;
  publicKeyHex: string;
  mainnetAddress: string;
  testnetAddress: string;
  address: string;
}

export interface VaultEncryptionOptions {
  /** Must be >= 600,000 for production; defaults to 600,000. */
  iterations?: number;
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required for vault encryption");
  }
  return subtle;
}

function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveAesGcmKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS) {
    throw new Error(
      `PBKDF2 iterations must be >= ${MIN_PBKDF2_ITERATIONS}, got ${iterations}`,
    );
  }
  const subtle = getSubtleCrypto();
  const baseKey = await subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(password)),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVaultPayload(
  payload: DecryptedVaultPayload,
  password: string,
  options: VaultEncryptionOptions = {},
): Promise<Pick<EncryptedVaultRecord, "version" | "kdf" | "iterations" | "cipher" | "saltHex" | "ivHex" | "ciphertextHex">> {
  if (password.length < 8) {
    throw new Error("Vault password must be at least 8 characters");
  }
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesGcmKey(password, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  try {
    const ciphertextBuf = await getSubtleCrypto().encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(plaintext),
    );
    return {
      version: VAULT_VERSION,
      kdf: "PBKDF2-SHA256",
      iterations,
      cipher: "AES-256-GCM",
      saltHex: bytesToHex(salt),
      ivHex: bytesToHex(iv),
      ciphertextHex: bytesToHex(new Uint8Array(ciphertextBuf)),
    };
  } finally {
    wipe(plaintext);
  }
}

export async function decryptVaultPayload(
  record: EncryptedVaultRecord,
  password: string,
): Promise<DecryptedVaultPayload> {
  if (record.version !== VAULT_VERSION || record.kdf !== "PBKDF2-SHA256" || record.cipher !== "AES-256-GCM") {
    throw new Error("Unsupported vault format");
  }
  const salt = hexToBytes(record.saltHex);
  const iv = hexToBytes(record.ivHex);
  const ciphertext = hexToBytes(record.ciphertextHex);
  const key = await deriveAesGcmKey(password, salt, record.iterations);

  try {
    const plainBuf = await getSubtleCrypto().decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
    const plainBytes = new Uint8Array(plainBuf);
    try {
      const parsed = JSON.parse(new TextDecoder().decode(plainBytes)) as DecryptedVaultPayload;
      if (!parsed || typeof parsed.mnemonic !== "string") {
        throw new Error("Corrupted vault payload");
      }
      return parsed;
    } finally {
      wipe(plainBytes);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "Corrupted vault payload") {
      throw err;
    }
    throw new Error("Invalid vault password or corrupted ciphertext");
  }
}

export function generateWalletMnemonic(strength: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strength);
}

export function isValidWalletMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim().replace(/\s+/g, " "), wordlist);
}

/**
 * Derives a Kovanica Ed25519 keypair at canonical SLIP-0010 / BIP-44 path
 * `m/44'/3007'/<accountIndex>'/0'/0'`.
 */
export function deriveKovanicaAccount(
  mnemonic: string,
  accountIndex = 0,
  passphrase = "",
): {
  path: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  mainnetAddress: string;
  testnetAddress: string;
} {
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid account index: ${accountIndex}`);
  }
  const seed = bip39Seed(mnemonic, passphrase);
  try {
    const node = deriveBip44(seed, accountIndex, 0, 0, KOVANICA_COIN_TYPE);
    const secretKey = new Uint8Array(node.key);
    const publicKey = getPublicKey(secretKey);
    wipe(node.key);
    wipe(node.chainCode);
    return {
      path: `m/${BIP44_PURPOSE}'/${KOVANICA_COIN_TYPE}'/${accountIndex}'/0'/0'`,
      secretKey,
      publicKey,
      mainnetAddress: encodeAddress(publicKey, ADDRESS_PREFIX),
      testnetAddress: encodeAddress(publicKey, TESTNET_ADDRESS_PREFIX),
    };
  } finally {
    wipe(seed);
  }
}

export class VaultManager {
  private readonly storage: VaultStorageAdapter;
  private decrypted: DecryptedVaultPayload | null = null;
  private cachedRecord: EncryptedVaultRecord | null = null;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  private onLockCallback?: () => void;

  constructor(storage: VaultStorageAdapter, onLock?: () => void) {
    this.storage = storage;
    this.onLockCallback = onLock;
  }

  async hasVault(): Promise<boolean> {
    const rec = await this.loadRecord();
    return rec !== null;
  }

  async loadRecord(): Promise<EncryptedVaultRecord | null> {
    const rec = await this.storage.get<EncryptedVaultRecord>(VAULT_STORAGE_KEY);
    this.cachedRecord = rec ?? null;
    return this.cachedRecord;
  }

  isUnlocked(): boolean {
    return this.decrypted !== null;
  }

  async createVault(params: {
    password: string;
    mnemonic?: string;
    passphrase?: string;
    autoLockMinutes?: number;
    iterations?: number;
  }): Promise<{ mnemonic: string; accounts: WalletAccountSummary[] }> {
    const mnemonic = (params.mnemonic?.trim().replace(/\s+/g, " ") || generateWalletMnemonic(128));
    if (!isValidWalletMnemonic(mnemonic)) {
      throw new Error("Invalid BIP-39 mnemonic phrase");
    }

    const payload: DecryptedVaultPayload = {
      mnemonic,
      passphrase: params.passphrase ?? "",
      accountLabels: { 0: "Account 1" },
    };

    const encrypted = await encryptVaultPayload(payload, params.password, {
      iterations: params.iterations,
    });

    const record: EncryptedVaultRecord = {
      ...encrypted,
      autoLockMinutes: params.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES,
      accountCount: 1,
      activeAccountIndex: 0,
      createdAt: Date.now(),
    };

    await this.storage.set(VAULT_STORAGE_KEY, record);
    this.cachedRecord = record;
    this.decrypted = payload;
    this.resetAutoLockTimer();

    return {
      mnemonic,
      accounts: this.getAccounts(CHAIN_IDS.MAINNET),
    };
  }

  async unlock(password: string): Promise<WalletAccountSummary[]> {
    const record = await this.loadRecord();
    if (!record) {
      throw new Error("No wallet vault found. Create or import a wallet first.");
    }
    this.decrypted = await decryptVaultPayload(record, password);
    this.resetAutoLockTimer();
    return this.getAccounts(CHAIN_IDS.MAINNET);
  }

  lock(): void {
    if (this.autoLockTimer !== null) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    this.decrypted = null;
    this.onLockCallback?.();
  }

  touchActivity(): void {
    if (this.decrypted) {
      this.resetAutoLockTimer();
    }
  }

  private resetAutoLockTimer(): void {
    if (this.autoLockTimer !== null) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    const mins = this.cachedRecord?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES;
    if (mins > 0) {
      this.autoLockTimer = setTimeout(() => {
        this.lock();
      }, mins * 60_000);
    }
  }

  async setAutoLockMinutes(minutes: number): Promise<void> {
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      throw new Error("Auto-lock minutes must be between 0 and 1440");
    }
    const record = await this.loadRecord();
    if (!record) throw new Error("No vault initialized");
    const updated: EncryptedVaultRecord = { ...record, autoLockMinutes: minutes };
    await this.storage.set(VAULT_STORAGE_KEY, updated);
    this.cachedRecord = updated;
    if (this.decrypted) {
      this.resetAutoLockTimer();
    }
  }

  async setPasskeyUnlock(wrapped: PasskeyWrappedVaultKey | undefined): Promise<void> {
    const record = await this.loadRecord();
    if (!record) throw new Error("No vault initialized");
    const updated: EncryptedVaultRecord = { ...record, passkeyUnlock: wrapped };
    await this.storage.set(VAULT_STORAGE_KEY, updated);
    this.cachedRecord = updated;
  }

  async getPasskeyUnlock(): Promise<PasskeyWrappedVaultKey | undefined> {
    const record = await this.loadRecord();
    return record?.passkeyUnlock;
  }

  getAccounts(chainId: number = CHAIN_IDS.MAINNET): WalletAccountSummary[] {
    if (!this.decrypted || !this.cachedRecord) {
      return [];
    }
    const count = Math.max(1, this.cachedRecord.accountCount);
    const list: WalletAccountSummary[] = [];
    for (let i = 0; i < count; i++) {
      const derived = deriveKovanicaAccount(
        this.decrypted.mnemonic,
        i,
        this.decrypted.passphrase,
      );
      try {
        list.push({
          index: i,
          label: this.decrypted.accountLabels[i] ?? `Account ${i + 1}`,
          path: derived.path,
          publicKeyHex: `0x${bytesToHex(derived.publicKey)}`,
          mainnetAddress: derived.mainnetAddress,
          testnetAddress: derived.testnetAddress,
          address:
            chainId === CHAIN_IDS.TESTNET ? derived.testnetAddress : derived.mainnetAddress,
        });
      } finally {
        wipe(derived.secretKey);
      }
    }
    return list;
  }

  getActiveAccountIndex(): number {
    return this.cachedRecord?.activeAccountIndex ?? 0;
  }

  async setActiveAccountIndex(index: number): Promise<void> {
    const record = await this.loadRecord();
    if (!record) throw new Error("No vault initialized");
    if (index < 0 || index >= record.accountCount) {
      throw new Error(`Account index ${index} out of range`);
    }
    const updated: EncryptedVaultRecord = { ...record, activeAccountIndex: index };
    await this.storage.set(VAULT_STORAGE_KEY, updated);
    this.cachedRecord = updated;
  }

  async addAccount(label?: string): Promise<WalletAccountSummary> {
    if (!this.decrypted || !this.cachedRecord) {
      throw new Error("Vault is locked");
    }
    const nextIndex = this.cachedRecord.accountCount;
    this.decrypted.accountLabels[nextIndex] = label ?? `Account ${nextIndex + 1}`;
    const updated: EncryptedVaultRecord = {
      ...this.cachedRecord,
      accountCount: nextIndex + 1,
      activeAccountIndex: nextIndex,
    };
    await this.storage.set(VAULT_STORAGE_KEY, updated);
    this.cachedRecord = updated;
    return this.getAccounts(CHAIN_IDS.MAINNET)[nextIndex]!;
  }

  /**
   * Executes a synchronous or asynchronous callback with the active account's
   * derived Ed25519 keypair, wiping the secret key immediately after use.
   */
  async withActiveKeypair<T>(
    fn: (kp: {
      secretKey: Uint8Array;
      publicKey: Uint8Array;
      path: string;
      mainnetAddress: string;
      testnetAddress: string;
    }) => T | Promise<T>,
  ): Promise<T> {
    if (!this.decrypted || !this.cachedRecord) {
      throw new Error("Vault is locked");
    }
    this.touchActivity();
    const derived = deriveKovanicaAccount(
      this.decrypted.mnemonic,
      this.cachedRecord.activeAccountIndex,
      this.decrypted.passphrase,
    );
    try {
      return await fn(derived);
    } finally {
      wipe(derived.secretKey);
    }
  }
}
