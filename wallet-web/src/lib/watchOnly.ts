import { createWatchOnlyAccount, type WatchOnlyAccount } from "kovanica-sdk";

export type { WatchOnlyAccount };

export type WatchOnlyValidationResult =
  | { readonly ok: true; readonly account: WatchOnlyAccount }
  | { readonly ok: false; readonly error: string };

export interface WatchOnlyEntry {
  readonly account: WatchOnlyAccount;
  readonly label: string;
  readonly addedAt: number;
}

const WATCH_ONLY_STORAGE_KEY = "kvnc.watch-only.v1";
const MAX_SAVED_WATCH_ONLY = 32;
const MAX_LABEL_LENGTH = 48;

export function sanitizeWatchOnlyLabel(label: string | undefined): string {
  if (!label) return "";
  let cleaned = "";
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += label[i];
    }
  }
  return cleaned.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * Validates a Kovanica PRO-21 address and optional chain ID compatibility
 * using `kovanica-sdk`'s `createWatchOnlyAccount` without throwing.
 */
export function validateWatchOnlyAddress(
  address: string,
  chainId?: number | null,
): WatchOnlyValidationResult {
  const trimmed = address.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter a Kovanica PRO-21 address to watch." };
  }
  try {
    const account = createWatchOnlyAccount(
      trimmed,
      typeof chainId === "number" && Number.isInteger(chainId) ? chainId : undefined,
    );
    return { ok: true, account };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid Kovanica PRO-21 address.",
    };
  }
}

/**
 * Creates a frozen watch-only entry backed by `kovanica-sdk`'s `createWatchOnlyAccount`.
 * Guarantees `canSign === false`, `readOnly === true`, `isWatchOnly === true`,
 * and zero private key material.
 */
export function createWatchOnlyEntry(
  address: string,
  chainId?: number | null,
  label?: string,
  addedAt: number = Date.now(),
): WatchOnlyEntry {
  const account = createWatchOnlyAccount(
    address.trim(),
    typeof chainId === "number" && Number.isInteger(chainId) ? chainId : undefined,
  );
  const cleanLabel = sanitizeWatchOnlyLabel(label) || "Watch-Only Account";
  return Object.freeze({
    account,
    label: cleanLabel,
    addedAt: Number.isFinite(addedAt) ? addedAt : Date.now(),
  });
}

/**
 * Guards signing entry points so watch-only accounts can never sign transactions.
 */
export function assertCanSign(
  account: { canSign?: boolean; isWatchOnly?: boolean; readOnly?: boolean } | null | undefined,
): void {
  if (!account) {
    throw new Error("No active signing account.");
  }
  if (account.canSign === false || account.isWatchOnly === true || account.readOnly === true) {
    throw new Error("Watch-only accounts are read-only and cannot sign transactions.");
  }
}

type StoredWatchOnlyRecord = {
  address: string;
  chainId: number;
  label: string;
  addedAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export function loadWatchOnlyEntries(storage?: StorageLike | null): WatchOnlyEntry[] {
  const target = resolveStorage(storage);
  if (!target) return [];
  try {
    const raw = target.getItem(WATCH_ONLY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: WatchOnlyEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Partial<StoredWatchOnlyRecord>;
      if (typeof rec.address !== "string") continue;
      const check = validateWatchOnlyAddress(
        rec.address,
        typeof rec.chainId === "number" ? rec.chainId : undefined,
      );
      if (!check.ok) continue;
      const key = `${check.account.payloadHex}:${check.account.chainId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        Object.freeze({
          account: check.account,
          label: sanitizeWatchOnlyLabel(typeof rec.label === "string" ? rec.label : "") || "Watch-Only Account",
          addedAt: typeof rec.addedAt === "number" && Number.isFinite(rec.addedAt) ? rec.addedAt : 0,
        }),
      );
      if (out.length >= MAX_SAVED_WATCH_ONLY) break;
    }
    return out;
  } catch {
    return [];
  }
}

function persistWatchOnlyEntries(entries: readonly WatchOnlyEntry[], storage?: StorageLike | null): void {
  const target = resolveStorage(storage);
  if (!target) return;
  const serialized: StoredWatchOnlyRecord[] = entries.slice(0, MAX_SAVED_WATCH_ONLY).map((entry) => ({
    address: entry.account.address,
    chainId: entry.account.chainId,
    label: entry.label,
    addedAt: entry.addedAt,
  }));
  target.setItem(WATCH_ONLY_STORAGE_KEY, JSON.stringify(serialized));
}

export function saveWatchOnlyEntry(
  address: string,
  chainId?: number | null,
  label?: string,
  storage?: StorageLike | null,
): { entry: WatchOnlyEntry; entries: WatchOnlyEntry[] } {
  const entry = createWatchOnlyEntry(address, chainId, label);
  const existing = loadWatchOnlyEntries(storage);
  const key = `${entry.account.payloadHex}:${entry.account.chainId}`;
  const entries = [
    entry,
    ...existing.filter((item) => `${item.account.payloadHex}:${item.account.chainId}` !== key),
  ].slice(0, MAX_SAVED_WATCH_ONLY);
  persistWatchOnlyEntries(entries, storage);
  return { entry, entries };
}

export function removeWatchOnlyEntry(
  address: string,
  storage?: StorageLike | null,
): WatchOnlyEntry[] {
  const normalized = address.trim().toLowerCase();
  const existing = loadWatchOnlyEntries(storage);
  const next = existing.filter(
    (item) =>
      item.account.address.toLowerCase() !== normalized &&
      item.account.canonicalMainnet.toLowerCase() !== normalized &&
      item.account.canonicalTestnet.toLowerCase() !== normalized,
  );
  persistWatchOnlyEntries(next, storage);
  return next;
}

export function clearWatchOnlyEntries(storage?: StorageLike | null): void {
  const target = resolveStorage(storage);
  if (!target) return;
  target.removeItem(WATCH_ONLY_STORAGE_KEY);
}
