import { decodeAddress } from "./address";

export const ADDRESS_BOOK_STORAGE_KEY = "kovanica.console.address_book.v1";

export const MAX_LABEL_LENGTH = 64;
export const MAX_NOTE_LENGTH = 240;

export type AddressBookEntry = {
  id: string;
  label: string;
  address: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
};

export type AddAddressBookInput = {
  label: string;
  address: string;
  note?: string;
  id?: string;
  now?: number;
};

export type UpdateAddressBookPatch = {
  label?: string;
  address?: string;
  note?: string | null;
  now?: number;
};

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Strips control characters, collapses internal whitespace, trims, and clamps length.
 */
export function sanitizeLabel(raw: string): string {
  return raw
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

/**
 * Sanitizes an optional note string. Returns undefined if empty after sanitization.
 */
export function sanitizeNote(raw?: string | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Validates that an address is a strict PRO-21 canonical address (`kvnc...dag` or `tknc...dag`)
 * with valid length, base32 body, and 29-bit checksum. Legacy hex formats are rejected.
 */
export function validateCanonicalAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Enter a canonical kvnc…dag or tknc…dag address");
  }
  try {
    decodeAddress(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid PRO-21 address";
    throw new Error(`Invalid canonical address: ${detail}`);
  }
  return trimmed;
}

export function isCanonicalAddress(raw: string): boolean {
  try {
    validateCanonicalAddress(raw);
    return true;
  } catch {
    return false;
  }
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function addAddressBookEntry(
  entries: readonly AddressBookEntry[],
  input: AddAddressBookInput,
): AddressBookEntry[] {
  const label = sanitizeLabel(input.label);
  if (!label) {
    throw new Error("Label is required");
  }
  const address = validateCanonicalAddress(input.address);
  if (entries.some((entry) => entry.address === address)) {
    throw new Error("Address already exists in the address book");
  }
  const note = sanitizeNote(input.note);
  const now = input.now ?? Date.now();
  const entry: AddressBookEntry = {
    id: input.id?.trim() || generateId(),
    label,
    address,
    ...(note !== undefined ? { note } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return [entry, ...entries];
}

export function updateAddressBookEntry(
  entries: readonly AddressBookEntry[],
  id: string,
  patch: UpdateAddressBookPatch,
): AddressBookEntry[] {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new Error("Address book entry not found");
  }
  const current = entries[index]!;

  let nextLabel = current.label;
  if (patch.label !== undefined) {
    nextLabel = sanitizeLabel(patch.label);
    if (!nextLabel) {
      throw new Error("Label is required");
    }
  }

  let nextAddress = current.address;
  if (patch.address !== undefined) {
    nextAddress = validateCanonicalAddress(patch.address);
    if (entries.some((entry) => entry.id !== id && entry.address === nextAddress)) {
      throw new Error("Address already exists in the address book");
    }
  }

  let nextNote = current.note;
  if (patch.note === null) {
    nextNote = undefined;
  } else if (patch.note !== undefined) {
    nextNote = sanitizeNote(patch.note);
  }

  const updated: AddressBookEntry = {
    id: current.id,
    label: nextLabel,
    address: nextAddress,
    ...(nextNote !== undefined ? { note: nextNote } : {}),
    createdAt: current.createdAt,
    updatedAt: patch.now ?? Date.now(),
  };

  return entries.map((entry, i) => (i === index ? updated : entry));
}

export function removeAddressBookEntry(
  entries: readonly AddressBookEntry[],
  id: string,
): AddressBookEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

export function searchAddressBook(
  entries: readonly AddressBookEntry[],
  query: string,
): AddressBookEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (entry) =>
      entry.label.toLowerCase().includes(needle) ||
      entry.address.toLowerCase().includes(needle) ||
      (entry.note ? entry.note.toLowerCase().includes(needle) : false),
  );
}

export function findAddressBookEntry(
  entries: readonly AddressBookEntry[],
  address: string,
): AddressBookEntry | undefined {
  const trimmed = address.trim();
  if (!trimmed) return undefined;
  return entries.find((entry) => entry.address === trimmed);
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) {
      return null;
    }
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseEntry(raw: unknown): AddressBookEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  if (typeof record.label !== "string" || typeof record.address !== "string") return null;
  const label = sanitizeLabel(record.label);
  if (!label) return null;
  if (!isCanonicalAddress(record.address)) return null;
  const address = record.address.trim();
  const note = sanitizeNote(typeof record.note === "string" ? record.note : undefined);
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : 0;
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : createdAt;
  return {
    id: record.id.trim(),
    label,
    address,
    ...(note !== undefined ? { note } : {}),
    createdAt,
    updatedAt,
  };
}

export function loadAddressBook(storage?: Pick<Storage, "getItem"> | null): AddressBookEntry[] {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return [];
  try {
    const raw = store.getItem(ADDRESS_BOOK_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const entries: AddressBookEntry[] = [];
    for (const item of parsed) {
      const entry = parseEntry(item);
      if (!entry || seen.has(entry.address)) continue;
      seen.add(entry.address);
      entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

export function saveAddressBook(
  entries: readonly AddressBookEntry[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.setItem(ADDRESS_BOOK_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage quota / privacy mode failures
  }
}
