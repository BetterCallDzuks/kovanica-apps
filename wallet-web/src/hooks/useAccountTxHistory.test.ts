import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountTxHistoryClient, GetTransactionHistoryParams, RawAccountTxHistoryPage } from "kovanica-sdk";

import {
  fetchAccountTxHistoryPage,
  mergeUniqueTxHistoryEntries,
} from "./useAccountTxHistory.ts";

const ACCOUNT = "tknc1testaccount0000000000000000000000000000000000000000000dag";
const PEER = "tknc1peeraccount0000000000000000000000000000000000000000000dag";

describe("useAccountTxHistory helpers", () => {
  it("fetches paginated transaction history pages and supports cursor pagination", async () => {
    const calls: GetTransactionHistoryParams[] = [];
    const client: AccountTxHistoryClient = {
      async getTransactionHistory(params: GetTransactionHistoryParams): Promise<RawAccountTxHistoryPage> {
        calls.push(params);
        if (!params.cursor) {
          return {
            entries: [
              {
                hash: "0x1111",
                height: "200",
                timestamp: "1763890000",
                from: ACCOUNT,
                to: PEER,
                amount: "1000000000",
                fee: "1000",
                kind: "transfer",
                status: "success",
              },
            ],
            next_cursor: "cursor-page-2",
          };
        }
        return {
          entries: [
            {
              hash: "0x2222",
              height: "199",
              timestamp: "1763889000",
              from: PEER,
              to: ACCOUNT,
              amount: "2000000000",
              fee: "1000",
              kind: "transfer",
              status: "success",
            },
          ],
          next_cursor: null,
        };
      },
    };

    const page1 = await fetchAccountTxHistoryPage(client, {
      address: ACCOUNT,
      direction: "all",
      limit: 1,
    });
    assert.equal(page1.items.length, 1);
    assert.equal(page1.items[0]?.hash, "0x1111");
    assert.equal(page1.items[0]?.amount, 1_000_000_000n);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextCursor, "cursor-page-2");
    assert.equal(page1.pagesFetched, 1);

    const page2 = await fetchAccountTxHistoryPage(client, {
      address: ACCOUNT,
      direction: "all",
      limit: 1,
      cursor: page1.nextCursor ?? undefined,
    });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0]?.hash, "0x2222");
    assert.equal(page2.hasMore, false);
    assert.equal(page2.nextCursor, null);

    const combined = mergeUniqueTxHistoryEntries(page1.items, page2.items);
    assert.equal(combined.length, 2);
    assert.deepEqual(
      combined.map((item) => item.hash),
      ["0x1111", "0x2222"],
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.direction, "all");
    assert.equal(calls[1]?.cursor, "cursor-page-2");
  });

  it("forwards sent and received direction filters to kovanica_getTransactionHistory", async () => {
    const observedDirections: Array<string | undefined> = [];
    const client: AccountTxHistoryClient = {
      async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
        assert.equal(method, "kovanica_getTransactionHistory");
        const first = Array.isArray(params) ? (params[0] as GetTransactionHistoryParams) : (params as GetTransactionHistoryParams);
        observedDirections.push(first.direction);
        return { entries: [], next_cursor: null } as TResult;
      },
    };

    await fetchAccountTxHistoryPage(client, { address: ACCOUNT, direction: "sent" });
    await fetchAccountTxHistoryPage(client, { address: ACCOUNT, direction: "received" });

    assert.deepEqual(observedDirections, ["sent", "received"]);
  });

  it("returns empty result without calling RPC when address is blank", async () => {
    let called = false;
    const client: AccountTxHistoryClient = {
      async getTransactionHistory(): Promise<RawAccountTxHistoryPage> {
        called = true;
        return { entries: [], next_cursor: null };
      },
    };

    const result = await fetchAccountTxHistoryPage(client, { address: "   " });
    assert.equal(called, false);
    assert.deepEqual(result, { items: [], nextCursor: null, hasMore: false, pagesFetched: 0 });
  });

  it("deduplicates overlapping transaction hashes when merging pages", () => {
    const a = {
      hash: "0xaaaa" as const,
      height: 10n,
      timestamp: null,
      from: ACCOUNT,
      to: PEER,
      amount: 1n,
      fee: 1n,
      kind: "transfer",
      status: "success" as const,
    };
    const b = { ...a, hash: "0xAAAA" as const };
    const c = { ...a, hash: "0xbbbb" as const };

    const merged = mergeUniqueTxHistoryEntries([a], [b, c]);
    assert.deepEqual(
      merged.map((item) => item.hash),
      ["0xaaaa", "0xbbbb"],
    );
  });

  it("respects AbortSignal cancellation before RPC invocation", async () => {
    const controller = new AbortController();
    controller.abort();
    const client: AccountTxHistoryClient = {
      async getTransactionHistory(): Promise<RawAccountTxHistoryPage> {
        throw new Error("should not be called when aborted");
      },
    };

    await assert.rejects(() =>
      fetchAccountTxHistoryPage(client, {
        address: ACCOUNT,
        signal: controller.signal,
      }),
    );
  });
});
