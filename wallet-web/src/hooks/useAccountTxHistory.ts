import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_ACCOUNT_TX_HISTORY_LIMIT,
  getAccountTxHistory,
  type AccountTxDirection,
  type AccountTxHistoryClient,
  type AccountTxHistoryEntry,
  type AccountTxHistoryResult,
} from "kovanica-sdk";

export type { AccountTxDirection, AccountTxHistoryClient, AccountTxHistoryEntry, AccountTxHistoryResult };

export interface FetchAccountTxHistoryPageOptions {
  address: string;
  direction?: AccountTxDirection;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

/**
 * Fetches a single page of paginated account transaction history using
 * `kovanica-sdk`'s `getAccountTxHistory`.
 */
export async function fetchAccountTxHistoryPage(
  client: AccountTxHistoryClient,
  options: FetchAccountTxHistoryPageOptions,
): Promise<AccountTxHistoryResult> {
  const trimmedAddress = options.address.trim();
  if (!trimmedAddress) {
    return { items: [], nextCursor: null, hasMore: false, pagesFetched: 0 };
  }
  return getAccountTxHistory(client, {
    address: trimmedAddress,
    direction: options.direction ?? "all",
    limit: options.limit ?? DEFAULT_ACCOUNT_TX_HISTORY_LIMIT,
    maxPages: 1,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Appends incoming entries to existing entries while deduplicating by transaction hash.
 */
export function mergeUniqueTxHistoryEntries(
  existing: readonly AccountTxHistoryEntry[],
  incoming: readonly AccountTxHistoryEntry[],
): AccountTxHistoryEntry[] {
  if (existing.length === 0) return [...incoming];
  const seen = new Set(existing.map((entry) => entry.hash.toLowerCase()));
  const merged = [...existing];
  for (const entry of incoming) {
    const key = entry.hash.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

export interface UseAccountTxHistoryOptions {
  client: AccountTxHistoryClient | null;
  address: string | null | undefined;
  initialDirection?: AccountTxDirection;
  limit?: number;
  enabled?: boolean;
}

export interface UseAccountTxHistoryState {
  entries: AccountTxHistoryEntry[];
  direction: AccountTxDirection;
  setDirection: (direction: AccountTxDirection) => void;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  pagesFetched: number;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * React hook for paginated account transaction history powered by `kovanica-sdk`'s
 * `getAccountTxHistory`, with direction filtering (`all` / `sent` / `received`),
 * cursor pagination (`loadMore`), and `AbortController` cancellation.
 */
export function useAccountTxHistory(
  options: UseAccountTxHistoryOptions,
): UseAccountTxHistoryState {
  const {
    client,
    address,
    initialDirection = "all",
    limit = DEFAULT_ACCOUNT_TX_HISTORY_LIMIT,
    enabled = true,
  } = options;

  const [direction, setDirectionState] = useState<AccountTxDirection>(initialDirection);
  const [entries, setEntries] = useState<AccountTxHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pagesFetched, setPagesFetched] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const normalizedAddress = (address ?? "").trim();

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    if (!enabled || !client || !normalizedAddress) {
      setEntries([]);
      setNextCursor(null);
      setHasMore(false);
      setPagesFetched(0);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setError(null);

    try {
      const result = await fetchAccountTxHistoryPage(client, {
        address: normalizedAddress,
        direction,
        limit,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setEntries(result.items);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
      setPagesFetched(result.pagesFetched);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Could not load transaction history.");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [client, direction, enabled, limit, normalizedAddress]);

  useEffect(() => {
    void fetchFirstPage();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchFirstPage]);

  const loadMore = useCallback(async () => {
    if (!enabled || !client || !normalizedAddress || !hasMore || !nextCursor || loading || loadingMore) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadingMore(true);
    setError(null);

    try {
      const result = await fetchAccountTxHistoryPage(client, {
        address: normalizedAddress,
        direction,
        limit,
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setEntries((prev) => mergeUniqueTxHistoryEntries(prev, result.items));
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
      setPagesFetched((prev) => prev + result.pagesFetched);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Could not load more transactions.");
    } finally {
      if (!controller.signal.aborted) {
        setLoadingMore(false);
      }
    }
  }, [client, direction, enabled, hasMore, limit, loading, loadingMore, nextCursor, normalizedAddress]);

  const setDirection = useCallback((nextDirection: AccountTxDirection) => {
    setDirectionState(nextDirection);
  }, []);

  return {
    entries,
    direction,
    setDirection,
    loading,
    loadingMore,
    error,
    hasMore,
    nextCursor,
    pagesFetched,
    loadMore,
    refresh: fetchFirstPage,
  };
}
