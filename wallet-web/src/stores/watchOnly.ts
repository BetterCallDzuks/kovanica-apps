import { create } from "zustand";
import {
  loadWatchOnlyEntries,
  removeWatchOnlyEntry,
  saveWatchOnlyEntry,
  type WatchOnlyEntry,
} from "@/lib/watchOnly";

type WatchOnlyState = {
  active: WatchOnlyEntry | null;
  saved: WatchOnlyEntry[];
  hydrate: () => void;
  enterWatchOnly: (address: string, chainId?: number | null, label?: string) => WatchOnlyEntry;
  selectSaved: (address: string) => void;
  removeSaved: (address: string) => void;
  exitWatchOnly: () => void;
};

export const useWatchOnly = create<WatchOnlyState>((set, get) => ({
  active: null,
  saved: [],
  hydrate: () => set({ saved: loadWatchOnlyEntries() }),
  enterWatchOnly: (address, chainId, label) => {
    const { entry, entries } = saveWatchOnlyEntry(address, chainId, label);
    set({ active: entry, saved: entries });
    return entry;
  },
  selectSaved: (address) => {
    const normalized = address.trim().toLowerCase();
    const found = get().saved.find(
      (item) =>
        item.account.address.toLowerCase() === normalized ||
        item.account.canonicalMainnet.toLowerCase() === normalized ||
        item.account.canonicalTestnet.toLowerCase() === normalized,
    );
    if (found) set({ active: found });
  },
  removeSaved: (address) => {
    const next = removeWatchOnlyEntry(address);
    const active = get().active;
    const normalized = address.trim().toLowerCase();
    const removedActive =
      active != null &&
      (active.account.address.toLowerCase() === normalized ||
        active.account.canonicalMainnet.toLowerCase() === normalized ||
        active.account.canonicalTestnet.toLowerCase() === normalized);
    set({ saved: next, active: removedActive ? null : active });
  },
  exitWatchOnly: () => set({ active: null }),
}));
