import { describe, expect, it } from "vitest";

import { ADDRESS_PREFIX, TESTNET_ADDRESS_PREFIX, encodeAddress } from "./address";
import {
  ADDRESS_BOOK_STORAGE_KEY,
  MAX_LABEL_LENGTH,
  MAX_NOTE_LENGTH,
  addAddressBookEntry,
  findAddressBookEntry,
  isCanonicalAddress,
  loadAddressBook,
  removeAddressBookEntry,
  sanitizeLabel,
  sanitizeNote,
  saveAddressBook,
  searchAddressBook,
  updateAddressBookEntry,
  validateCanonicalAddress,
  type AddressBookEntry,
  type StorageLike,
} from "./address-book";

function makeCanonicalAddress(seedByte: number, prefix = ADDRESS_PREFIX): string {
  const pubkey = new Uint8Array(32).fill(seedByte);
  return encodeAddress(pubkey, prefix);
}

function makeMemoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const MAINNET_A = makeCanonicalAddress(0x11, ADDRESS_PREFIX);
const MAINNET_B = makeCanonicalAddress(0x22, ADDRESS_PREFIX);
const TESTNET_A = makeCanonicalAddress(0x33, TESTNET_ADDRESS_PREFIX);

describe("address book canonical validation", () => {
  it("accepts valid mainnet kvnc...dag and testnet tknc...dag PRO-21 addresses", () => {
    expect(isCanonicalAddress(MAINNET_A)).toBe(true);
    expect(isCanonicalAddress(TESTNET_A)).toBe(true);
    expect(validateCanonicalAddress(`  ${MAINNET_A}  `)).toBe(MAINNET_A);
    expect(validateCanonicalAddress(` ${TESTNET_A}\n`)).toBe(TESTNET_A);
  });

  it("rejects legacy hex, bad checksums, wrong prefixes, and empty strings", () => {
    expect(isCanonicalAddress("")).toBe(false);
    expect(isCanonicalAddress("   ")).toBe(false);
    expect(isCanonicalAddress(`0x${"11".repeat(32)}`)).toBe(false);
    expect(isCanonicalAddress("11".repeat(32))).toBe(false);
    expect(isCanonicalAddress(`kvnc${"11".repeat(32)}dag`)).toBe(false);
    expect(isCanonicalAddress(MAINNET_A.toUpperCase())).toBe(false);

    const flippedChar = MAINNET_A[MAINNET_A.length - 4] === "q" ? "p" : "q";
    const badChecksum =
      MAINNET_A.slice(0, MAINNET_A.length - 4) + flippedChar + MAINNET_A.slice(MAINNET_A.length - 3);
    expect(isCanonicalAddress(badChecksum)).toBe(false);
    expect(() => validateCanonicalAddress(badChecksum)).toThrow(/Invalid canonical address/);
  });
});

describe("address book sanitization", () => {
  it("sanitizes labels by stripping control chars, collapsing spaces, and clamping length", () => {
    expect(sanitizeLabel("  Alice\t\n  Treasury \u0000 ")).toBe("Alice Treasury");
    const longLabel = "a".repeat(MAX_LABEL_LENGTH + 20);
    expect(sanitizeLabel(longLabel).length).toBe(MAX_LABEL_LENGTH);
  });

  it("sanitizes optional notes and returns undefined for blank values", () => {
    expect(sanitizeNote("   \n\t ")).toBeUndefined();
    expect(sanitizeNote(undefined)).toBeUndefined();
    expect(sanitizeNote(null)).toBeUndefined();
    expect(sanitizeNote("  Cold\u0007  storage ")).toBe("Cold storage");
    const longNote = "x".repeat(MAX_NOTE_LENGTH + 30);
    expect(sanitizeNote(longNote)?.length).toBe(MAX_NOTE_LENGTH);
  });
});

describe("address book CRUD and search", () => {
  it("adds entries, prevents duplicates, and preserves immutability", () => {
    const initial: AddressBookEntry[] = [];
    const list1 = addAddressBookEntry(initial, {
      id: "e1",
      label: "  Mainnet Vault  ",
      address: ` ${MAINNET_A} `,
      note: "Primary cold wallet",
      now: 1000,
    });

    expect(initial).toHaveLength(0);
    expect(list1).toHaveLength(1);
    expect(list1[0]).toEqual({
      id: "e1",
      label: "Mainnet Vault",
      address: MAINNET_A,
      note: "Primary cold wallet",
      createdAt: 1000,
      updatedAt: 1000,
    });

    expect(() => addAddressBookEntry(list1, { label: "Duplicate", address: MAINNET_A })).toThrow(
      /already exists/i,
    );

    expect(() => addAddressBookEntry(list1, { label: "   ", address: MAINNET_B })).toThrow(
      /Label is required/i,
    );

    const list2 = addAddressBookEntry(list1, {
      id: "e2",
      label: "Testnet Faucet",
      address: TESTNET_A,
      now: 2000,
    });
    expect(list2).toHaveLength(2);
    expect(list2[0]?.id).toBe("e2");
    expect("note" in (list2[0] ?? {})).toBe(false);
  });

  it("updates entries, prevents duplicate address collisions, and removes entries", () => {
    let entries = addAddressBookEntry([], {
      id: "e1",
      label: "Alice",
      address: MAINNET_A,
      note: "Old note",
      now: 1000,
    });
    entries = addAddressBookEntry(entries, {
      id: "e2",
      label: "Bob",
      address: MAINNET_B,
      now: 1500,
    });

    const updated = updateAddressBookEntry(entries, "e1", {
      label: "Alice Updated",
      note: null,
      now: 3000,
    });
    const alice = updated.find((e) => e.id === "e1");
    expect(alice?.label).toBe("Alice Updated");
    expect(alice?.note).toBeUndefined();
    expect(alice?.createdAt).toBe(1000);
    expect(alice?.updatedAt).toBe(3000);

    expect(() => updateAddressBookEntry(updated, "e1", { address: MAINNET_B })).toThrow(
      /already exists/i,
    );

    expect(() => updateAddressBookEntry(updated, "missing", { label: "Ghost" })).toThrow(
      /not found/i,
    );

    const afterRemove = removeAddressBookEntry(updated, "e1");
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0]?.id).toBe("e2");
  });

  it("searches by label, address, and note case-insensitively and finds exact address", () => {
    let entries = addAddressBookEntry([], {
      id: "e1",
      label: "Validator Ops",
      address: MAINNET_A,
      note: "Berlin datacenter",
      now: 1000,
    });
    entries = addAddressBookEntry(entries, {
      id: "e2",
      label: "Testnet QA",
      address: TESTNET_A,
      now: 2000,
    });

    expect(searchAddressBook(entries, "")).toHaveLength(2);
    expect(searchAddressBook(entries, "berlin")).toHaveLength(1);
    expect(searchAddressBook(entries, "berlin")[0]?.id).toBe("e1");
    expect(searchAddressBook(entries, "TKNC")).toHaveLength(1);
    expect(searchAddressBook(entries, "TKNC")[0]?.id).toBe("e2");
    expect(searchAddressBook(entries, "ops")[0]?.id).toBe("e1");
    expect(findAddressBookEntry(entries, ` ${TESTNET_A} `)?.id).toBe("e2");
    expect(findAddressBookEntry(entries, MAINNET_B)).toBeUndefined();
  });
});

describe("address book persistence", () => {
  it("uses the console storage key and handles missing storage gracefully", () => {
    expect(ADDRESS_BOOK_STORAGE_KEY).toBe("kovanica.console.address_book.v1");
    expect(loadAddressBook(null)).toEqual([]);
    expect(() => saveAddressBook([], null)).not.toThrow();
    expect(loadAddressBook()).toEqual([]);
  });

  it("saves, loads, filters corrupt records, and deduplicates addresses", () => {
    const store = makeMemoryStorage();
    const entries = addAddressBookEntry([], {
      id: "e1",
      label: "Treasury",
      address: MAINNET_A,
      note: "Multisig",
      now: 5000,
    });

    saveAddressBook(entries, store);
    expect(store.data.has(ADDRESS_BOOK_STORAGE_KEY)).toBe(true);
    expect(loadAddressBook(store)).toEqual(entries);

    store.setItem(ADDRESS_BOOK_STORAGE_KEY, "{not-json");
    expect(loadAddressBook(store)).toEqual([]);

    store.setItem(
      ADDRESS_BOOK_STORAGE_KEY,
      JSON.stringify([
        { id: "ok1", label: "Valid", address: TESTNET_A, createdAt: 1, updatedAt: 2 },
        { id: "dup", label: "Duplicate", address: TESTNET_A, createdAt: 3, updatedAt: 4 },
        {
          id: "bad-addr",
          label: "Legacy",
          address: `0x${"aa".repeat(32)}`,
          createdAt: 1,
          updatedAt: 1,
        },
        { id: "bad-label", label: "   ", address: MAINNET_B, createdAt: 1, updatedAt: 1 },
      ]),
    );
    const loaded = loadAddressBook(store);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("ok1");
    expect(loaded[0]?.address).toBe(TESTNET_A);
  });
});
