import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADDRESS_PREFIX, TESTNET_ADDRESS_PREFIX, encodeAddress } from "kovanica-sdk";

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
} from "./address-book.ts";

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
    assert.equal(isCanonicalAddress(MAINNET_A), true);
    assert.equal(isCanonicalAddress(TESTNET_A), true);
    assert.equal(validateCanonicalAddress(`  ${MAINNET_A}  `), MAINNET_A);
    assert.equal(validateCanonicalAddress(` ${TESTNET_A}\n`), TESTNET_A);
  });

  it("rejects legacy hex, bad checksums, wrong prefixes, and empty strings", () => {
    assert.equal(isCanonicalAddress(""), false);
    assert.equal(isCanonicalAddress("   "), false);
    assert.equal(isCanonicalAddress(`0x${"11".repeat(32)}`), false);
    assert.equal(isCanonicalAddress("11".repeat(32)), false);
    assert.equal(isCanonicalAddress(`kvnc${"11".repeat(32)}dag`), false);
    assert.equal(isCanonicalAddress(MAINNET_A.toUpperCase()), false);

    // Corrupt a character in the checksum tail
    const flippedChar = MAINNET_A[MAINNET_A.length - 4] === "q" ? "p" : "q";
    const badChecksum =
      MAINNET_A.slice(0, MAINNET_A.length - 4) + flippedChar + MAINNET_A.slice(MAINNET_A.length - 3);
    assert.equal(isCanonicalAddress(badChecksum), false);
    assert.throws(() => validateCanonicalAddress(badChecksum), /Invalid canonical address/);
  });
});

describe("address book sanitization", () => {
  it("sanitizes labels by stripping control chars, collapsing spaces, and clamping length", () => {
    assert.equal(sanitizeLabel("  Alice\t\n  Treasury \u0000 "), "Alice Treasury");
    const longLabel = "a".repeat(MAX_LABEL_LENGTH + 20);
    assert.equal(sanitizeLabel(longLabel).length, MAX_LABEL_LENGTH);
  });

  it("sanitizes optional notes and returns undefined for blank values", () => {
    assert.equal(sanitizeNote("   \n\t "), undefined);
    assert.equal(sanitizeNote(undefined), undefined);
    assert.equal(sanitizeNote(null), undefined);
    assert.equal(sanitizeNote("  Cold\u0007  storage "), "Cold storage");
    const longNote = "x".repeat(MAX_NOTE_LENGTH + 30);
    assert.equal(sanitizeNote(longNote)?.length, MAX_NOTE_LENGTH);
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

    assert.equal(initial.length, 0);
    assert.equal(list1.length, 1);
    assert.deepEqual(list1[0], {
      id: "e1",
      label: "Mainnet Vault",
      address: MAINNET_A,
      note: "Primary cold wallet",
      createdAt: 1000,
      updatedAt: 1000,
    });

    assert.throws(
      () => addAddressBookEntry(list1, { label: "Duplicate", address: MAINNET_A }),
      /already exists/i,
    );

    assert.throws(
      () => addAddressBookEntry(list1, { label: "   ", address: MAINNET_B }),
      /Label is required/i,
    );

    const list2 = addAddressBookEntry(list1, {
      id: "e2",
      label: "Testnet Faucet",
      address: TESTNET_A,
      now: 2000,
    });
    assert.equal(list2.length, 2);
    assert.equal(list2[0]?.id, "e2");
    assert.equal("note" in (list2[0] ?? {}), false);
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
    assert.equal(alice?.label, "Alice Updated");
    assert.equal(alice?.note, undefined);
    assert.equal(alice?.createdAt, 1000);
    assert.equal(alice?.updatedAt, 3000);

    assert.throws(
      () => updateAddressBookEntry(updated, "e1", { address: MAINNET_B }),
      /already exists/i,
    );

    assert.throws(
      () => updateAddressBookEntry(updated, "missing", { label: "Ghost" }),
      /not found/i,
    );

    const afterRemove = removeAddressBookEntry(updated, "e1");
    assert.equal(afterRemove.length, 1);
    assert.equal(afterRemove[0]?.id, "e2");
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

    assert.equal(searchAddressBook(entries, "").length, 2);
    assert.equal(searchAddressBook(entries, "berlin").length, 1);
    assert.equal(searchAddressBook(entries, "berlin")[0]?.id, "e1");
    assert.equal(searchAddressBook(entries, "TKNC").length, 1);
    assert.equal(searchAddressBook(entries, "TKNC")[0]?.id, "e2");
    assert.equal(searchAddressBook(entries, "ops")[0]?.id, "e1");
    assert.equal(findAddressBookEntry(entries, ` ${TESTNET_A} `)?.id, "e2");
    assert.equal(findAddressBookEntry(entries, MAINNET_B), undefined);
  });
});

describe("address book SSR-safe persistence", () => {
  it("handles missing storage gracefully in SSR", () => {
    assert.deepEqual(loadAddressBook(null), []);
    assert.doesNotThrow(() => saveAddressBook([], null));
    // In Node without localStorage, default call is also SSR-safe
    assert.deepEqual(loadAddressBook(), []);
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
    assert.ok(store.data.has(ADDRESS_BOOK_STORAGE_KEY));
    assert.deepEqual(loadAddressBook(store), entries);

    // Corrupt JSON
    store.setItem(ADDRESS_BOOK_STORAGE_KEY, "{not-json");
    assert.deepEqual(loadAddressBook(store), []);

    // Mixed valid, invalid, and duplicate entries
    store.setItem(
      ADDRESS_BOOK_STORAGE_KEY,
      JSON.stringify([
        { id: "ok1", label: "Valid", address: TESTNET_A, createdAt: 1, updatedAt: 2 },
        { id: "dup", label: "Duplicate", address: TESTNET_A, createdAt: 3, updatedAt: 4 },
        { id: "bad-addr", label: "Legacy", address: `0x${"aa".repeat(32)}`, createdAt: 1, updatedAt: 1 },
        { id: "bad-label", label: "   ", address: MAINNET_B, createdAt: 1, updatedAt: 1 },
      ]),
    );
    const loaded = loadAddressBook(store);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, "ok1");
    assert.equal(loaded[0]?.address, TESTNET_A);
  });
});
