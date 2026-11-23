import { useState } from "react";
import {
  addAddressBookEntry,
  loadAddressBook,
  removeAddressBookEntry,
  saveAddressBook,
  searchAddressBook,
  type AddressBookEntry,
} from "@/core/address-book";

export function AddressBookSection() {
  const [entries, setEntries] = useState<AddressBookEntry[]>(() => loadAddressBook());
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const visible = searchAddressBook(entries, query);

  function handleAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const next = addAddressBookEntry(entries, { label, address, note });
      saveAddressBook(next);
      setEntries(next);
      setLabel("");
      setAddress("");
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add address");
    }
  }

  function handleRemove(id: string) {
    setError(null);
    const next = removeAddressBookEntry(entries, id);
    saveAddressBook(next);
    setEntries(next);
  }

  return (
    <div className="mt-3 grid gap-3">
      <p className="text-sm text-muted">
        Save labeled canonical PRO-21 addresses (<span className="mono">kvnc…dag</span> or{" "}
        <span className="mono">tknc…dag</span>) locally in this browser.
      </p>
      <form className="grid gap-2" onSubmit={handleAdd}>
        <input
          className="min-h-11 rounded-2xl border border-line bg-ink px-4 text-sm text-paper"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Treasury)"
          aria-label="Address book label"
          maxLength={64}
        />
        <input
          className="min-h-11 rounded-2xl border border-line bg-ink px-4 font-mono text-sm text-paper"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="kvnc…dag or tknc…dag"
          aria-label="Canonical PRO-21 address"
          autoCapitalize="none"
          spellCheck={false}
        />
        <input
          className="min-h-11 rounded-2xl border border-line bg-ink px-4 text-sm text-paper"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          aria-label="Address book note"
          maxLength={240}
        />
        <button
          type="submit"
          className="min-h-11 rounded-full border border-line px-4 text-sm text-paper"
        >
          Add address
        </button>
      </form>
      {error ? <p className="text-sm text-clay">{error}</p> : null}
      {entries.length > 1 ? (
        <input
          className="min-h-11 rounded-2xl border border-line bg-ink px-4 text-sm text-paper"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter saved addresses…"
          aria-label="Filter saved addresses"
        />
      ) : null}
      {visible.length === 0 ? (
        <p className="text-xs text-muted">
          {entries.length === 0 ? "No saved addresses yet." : "No addresses match your filter."}
        </p>
      ) : (
        <div className="grid gap-2">
          {visible.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-3 rounded-2xl border border-line bg-ink/40 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-paper">{entry.label}</p>
                <p className="mono mt-0.5 text-xs break-all text-muted">{entry.address}</p>
                {entry.note ? <p className="mt-1 text-xs text-muted">{entry.note}</p> : null}
              </div>
              <button
                type="button"
                className="min-h-11 shrink-0 px-2 text-xs text-clay"
                onClick={() => handleRemove(entry.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
