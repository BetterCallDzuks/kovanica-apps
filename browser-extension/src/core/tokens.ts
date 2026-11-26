import {
  DEFAULT_CALL_GAS_LIMIT,
  buildTokenTransferCall,
  bytesToHex,
  decodeTokenState,
  deriveStorageSlotHex,
  hexToBytes,
  signCallContractTransaction,
  type CallTxKind,
  type KovanicaClient,
} from "kovanica-sdk";
import { validateRecipientAddress } from "./networks";
import type { VaultStorageAdapter } from "./vault";

export const DEFAULT_TOKEN_TRANSFER_FEE_ATOMS = 1_000_000n;

export const TOKEN_WATCHLIST_STORAGE_KEY = "kovanica_token_watchlist_v1";
export const KVP102_STATE_KEY = "kvnc/v1/state";

export interface WatchedTokenEntry {
  contract: string;
  addedAt: number;
}

export type TokenBalanceStatus = "ok" | "not_a_token" | "unreadable" | "error";

export interface WatchedTokenBalance {
  contract: string;
  status: TokenBalanceStatus;
  name?: string;
  symbol?: string;
  decimals?: number;
  balanceUnits?: string;
  balanceFormatted?: string;
  totalSupplyUnits?: string;
  paused?: boolean;
  icon?: string;
  error?: string;
}

type PersistedWatchlistByChain = Record<string, WatchedTokenEntry[]>;

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Formats an integer token amount in base units using exact BigInt arithmetic
 * (zero floating-point loss).
 */
export function formatTokenUnits(amount: bigint, decimals: number): string {
  if (amount < 0n) {
    return `-${formatTokenUnits(-amount, decimals)}`;
  }
  const safeDecimals = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 0;
  if (safeDecimals === 0) {
    return amount.toString();
  }
  const scale = 10n ** BigInt(safeDecimals);
  const whole = amount / scale;
  const frac = amount % scale;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracStr = frac.toString().padStart(safeDecimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

/**
 * Parses a human-readable decimal token amount string into exact BigInt base
 * units (zero floating-point loss). Rejects negative values, malformed strings,
 * or fractional precision exceeding `decimals`.
 */
export function parseTokenUnits(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Token amount is required");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid token amount: "${input}"`);
  }
  const wholePart = match[1]!;
  const fracPart = match[2] ?? "";
  if (fracPart.length > decimals) {
    throw new Error(
      `Amount "${input}" exceeds token precision (${decimals} decimal place${decimals === 1 ? "" : "s"})`,
    );
  }
  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(wholePart) * scale;
  const frac = fracPart.length > 0 ? BigInt(fracPart.padEnd(decimals, "0")) : 0n;
  return whole + frac;
}

export interface SignKvp102TokenTransferParams {
  contractAddress: string;
  recipientAddress: string;
  amountUnits: bigint;
  nonce: bigint;
  fee?: bigint;
  gasLimit?: bigint;
  chainId: number;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface SignedKvp102TokenTransfer {
  rawTxHex: string;
  signingHashHex: string;
  signatureHex: string;
  call: CallTxKind;
}

/**
 * Builds and signs a KVP-102 `token_transfer` contract call transaction via
 * `kovanica-sdk`, enforcing strict PRO-21 validation for both contract and
 * recipient addresses on the active chain.
 */
export function signKvp102TokenTransfer(
  params: SignKvp102TokenTransferParams,
): SignedKvp102TokenTransfer {
  const {
    contractAddress,
    recipientAddress,
    amountUnits,
    nonce,
    fee = DEFAULT_TOKEN_TRANSFER_FEE_ATOMS,
    gasLimit = DEFAULT_CALL_GAS_LIMIT,
    chainId,
    privateKey,
    publicKey,
  } = params;

  const contractCheck = validateRecipientAddress(contractAddress, chainId);
  if (!contractCheck.valid || !contractCheck.payloadBytes) {
    throw new Error(contractCheck.error ?? "Invalid KVP-102 token contract address");
  }

  const recipientCheck = validateRecipientAddress(recipientAddress, chainId);
  if (!recipientCheck.valid || !recipientCheck.payloadBytes) {
    throw new Error(recipientCheck.error ?? "Invalid PRO-21 recipient address");
  }

  if (amountUnits <= 0n) {
    throw new Error("Token transfer amount must be greater than zero");
  }

  const call = buildTokenTransferCall(
    contractCheck.payloadBytes,
    recipientCheck.payloadBytes,
    amountUnits,
    gasLimit,
  );

  const signed = signCallContractTransaction({
    sender: publicKey,
    secretKey: privateKey,
    nonce,
    fee,
    chainId,
    call,
  });

  return {
    rawTxHex: signed.rawTxHex.startsWith("0x") ? signed.rawTxHex : `0x${signed.rawTxHex}`,
    signingHashHex: signed.sighashHex.startsWith("0x")
      ? signed.sighashHex
      : `0x${signed.sighashHex}`,
    signatureHex: signed.signatureHex.startsWith("0x")
      ? signed.signatureHex
      : `0x${signed.signatureHex}`,
    call,
  };
}

/**
 * Returns the `0x`-prefixed 32-byte storage slot for KVP-102 `Token` state
 * (`blake3("kvnc/v1/state")`).
 */
export function getKvp102StateSlotHex(): string {
  const slot = deriveStorageSlotHex("token");
  return slot.startsWith("0x") ? slot : `0x${slot}`;
}

/**
 * Per-chain KVP-102 token watchlist backed by `VaultStorageAdapter`.
 * Enforces strict PRO-21 contract address validation for the active chain.
 */
export class TokenWatchlistManager {
  private readonly storage: VaultStorageAdapter;

  constructor(storage: VaultStorageAdapter) {
    this.storage = storage;
  }

  private async loadAll(): Promise<PersistedWatchlistByChain> {
    const raw = await this.storage.get<PersistedWatchlistByChain>(TOKEN_WATCHLIST_STORAGE_KEY);
    if (!raw || typeof raw !== "object") {
      return {};
    }
    return raw;
  }

  async list(chainId: number): Promise<WatchedTokenEntry[]> {
    const all = await this.loadAll();
    const list = all[String(chainId)];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (item): item is WatchedTokenEntry =>
        Boolean(item) && typeof item.contract === "string" && item.contract.length > 0,
    );
  }

  async add(chainId: number, contractAddress: string): Promise<WatchedTokenEntry> {
    const trimmed = contractAddress.trim();
    const check = validateRecipientAddress(trimmed, chainId);
    const normalized = check.canonicalAddress;
    if (!check.valid || !normalized) {
      throw new Error(check.error ?? "Invalid PRO-21 token contract address");
    }

    const all = await this.loadAll();
    const key = String(chainId);
    const existing = Array.isArray(all[key]) ? all[key]! : [];
    const already = existing.find((item) => item.contract === normalized);
    if (already) {
      return already;
    }

    const entry: WatchedTokenEntry = {
      contract: normalized,
      addedAt: Date.now(),
    };
    all[key] = [entry, ...existing];
    await this.storage.set(TOKEN_WATCHLIST_STORAGE_KEY, all);
    return entry;
  }

  async remove(chainId: number, contractAddress: string): Promise<boolean> {
    const target = contractAddress.trim().toLowerCase();
    const all = await this.loadAll();
    const key = String(chainId);
    const existing = Array.isArray(all[key]) ? all[key]! : [];
    const next = existing.filter((item) => item.contract.toLowerCase() !== target);
    if (next.length === existing.length) {
      return false;
    }
    all[key] = next;
    await this.storage.set(TOKEN_WATCHLIST_STORAGE_KEY, all);
    return true;
  }
}

export interface StorageRpcClient {
  getStorageAt: Pick<KovanicaClient, "getStorageAt">["getStorageAt"];
}

/**
 * Reads and decodes a KVP-102 token contract's singleton state via
 * `kovanica_getStorageAt` and resolves the holder's exact balance.
 */
export async function readKvp102TokenBalance(params: {
  client: StorageRpcClient;
  contractAddress: string;
  holderAddress: string;
  chainId: number;
}): Promise<WatchedTokenBalance> {
  const { client, contractAddress, holderAddress, chainId } = params;

  const holderCheck = validateRecipientAddress(holderAddress, chainId);
  if (!holderCheck.valid || !holderCheck.payloadBytes) {
    return {
      contract: contractAddress,
      status: "error",
      error: holderCheck.error ?? "Invalid holder address",
    };
  }
  const holderHex = bytesToHex(holderCheck.payloadBytes).toLowerCase();

  let rawHex: string;
  try {
    rawHex = await client.getStorageAt(contractAddress, getKvp102StateSlotHex());
  } catch (err) {
    return {
      contract: contractAddress,
      status: "error",
      error: err instanceof Error ? err.message : "RPC storage read failed",
    };
  }

  const clean = strip0x((rawHex ?? "").trim());
  if (!clean) {
    return { contract: contractAddress, status: "not_a_token" };
  }
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    return { contract: contractAddress, status: "unreadable" };
  }

  try {
    const state = decodeTokenState(hexToBytes(clean));
    if (!state || !state.symbol.trim()) {
      return { contract: contractAddress, status: "unreadable" };
    }
    const found = state.balances.find(
      (entry) => entry.accountHex.toLowerCase() === holderHex,
    );
    const balance = found?.amount ?? 0n;
    const safeIcon =
      state.icon.startsWith("https://") || state.icon.startsWith("data:image/")
        ? state.icon
        : "";
    return {
      contract: contractAddress,
      status: "ok",
      name: state.name,
      symbol: state.symbol,
      decimals: state.decimals,
      balanceUnits: balance.toString(),
      balanceFormatted: formatTokenUnits(balance, state.decimals),
      totalSupplyUnits: state.totalSupply.toString(),
      paused: state.paused,
      icon: safeIcon || undefined,
    };
  } catch {
    return { contract: contractAddress, status: "unreadable" };
  }
}
