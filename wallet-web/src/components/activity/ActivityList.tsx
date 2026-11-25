import { useMemo } from "react";
import {
  exportHistoryCsv,
  exportHistoryJson,
  historyExportFilename,
  triggerHistoryDownload,
} from "@/core/export-history";
import { formatKvnc } from "@/core/format";
import { historyHeading, receiptStatusLine } from "@/core/history-row";
import { useAccountTxHistory, type AccountTxDirection } from "@/hooks/useAccountTxHistory";
import { explorerTxUrl, presetById } from "@/lib/networks";
import {
  classifyAccountTxDirection,
  exportAccountTxHistoryCsv,
  exportAccountTxHistoryJson,
} from "@/lib/txHistoryExport";
import { createAccountTxHistoryClient } from "@/services/rpc";
import { useActivity, type ActivityRow } from "@/stores/activity";
import { useNetwork } from "@/stores/network";
import { useSession } from "@/stores/session";
import { useWatchOnly } from "@/stores/watchOnly";

const DIRECTIONS: readonly AccountTxDirection[] = ["all", "sent", "received"];

function badge(row: ActivityRow): string {
  if (
    row.direction === "contract" ||
    row.note.startsWith("token_") ||
    row.note.startsWith("htlc_") ||
    row.note.startsWith("vault_") ||
    row.note.startsWith("multisig_")
  ) {
    return receiptStatusLine(row.code, row.status, row.error);
  }
  if (row.status === "confirmed") return row.height == null ? "Confirmed" : `Confirmed (${row.height})`;
  if (row.status === "failed") return "Failed";
  return "Pending";
}

function formatEntryTimestamp(ts: bigint | null): string | null {
  if (ts == null || ts <= 0n) return null;
  const num = Number(ts);
  if (!Number.isFinite(num)) return null;
  const ms = num < 1_000_000_000_000 ? num * 1000 : num;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export function ActivityList({
  address: propAddress,
  chainId: propChainId,
}: {
  address?: string;
  chainId?: number;
} = {}) {
  const rows = useActivity((s) => s.rows);
  const note = useActivity((s) => s.indexerNote);
  const net = useNetwork();
  const sessionAccount = useSession((s) => s.accounts[s.active]);
  const watchOnly = useWatchOnly((s) => s.active);

  const activeAddress = propAddress ?? watchOnly?.account.address ?? sessionAccount?.address ?? "";
  const activeChainId =
    propChainId ??
    net.probedChainId ??
    presetById(net.presetId).expectedChainId ??
    watchOnly?.account.chainId ??
    2;

  const historyClient = useMemo(
    () => (net.online ? createAccountTxHistoryClient(net.rpcUrl) : null),
    [net.online, net.rpcUrl],
  );

  const history = useAccountTxHistory({
    client: historyClient,
    address: activeAddress,
    enabled: Boolean(activeAddress && net.online),
  });

  return (
    <div className="grid gap-5">
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-paper">On-chain history</h2>
            <p className="text-xs text-muted">
              Paginated via <span className="mono">kovanica_getTransactionHistory</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="min-h-11 rounded-full border border-line px-4 text-sm text-paper disabled:opacity-40"
              disabled={!net.online || !activeAddress || history.loading}
              onClick={() => void history.refresh()}
            >
              {history.loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className="min-h-11 rounded-full border border-line px-4 text-sm text-paper disabled:opacity-40"
              disabled={history.entries.length === 0}
              onClick={() => {
                triggerHistoryDownload(
                  exportAccountTxHistoryCsv(history.entries, activeAddress, activeChainId),
                  historyExportFilename("csv"),
                  "text/csv;charset=utf-8",
                );
              }}
            >
              Export CSV
            </button>
            <button
              type="button"
              className="min-h-11 rounded-full border border-line px-4 text-sm text-paper disabled:opacity-40"
              disabled={history.entries.length === 0}
              onClick={() => {
                triggerHistoryDownload(
                  exportAccountTxHistoryJson(history.entries, activeAddress, activeChainId),
                  historyExportFilename("json"),
                  "application/json;charset=utf-8",
                );
              }}
            >
              Export JSON
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Transaction direction filter">
          {DIRECTIONS.map((dir) => (
            <button
              key={dir}
              type="button"
              className={`min-h-10 rounded-full border px-4 text-sm capitalize ${
                history.direction === dir ? "border-copper text-paper" : "border-line text-muted"
              }`}
              onClick={() => history.setDirection(dir)}
            >
              {dir}
            </button>
          ))}
        </div>

        {!net.online ? (
          <p className="rounded-card border border-line bg-ink px-4 py-4 text-sm text-muted">
            Node is offline. Connect to a node to fetch on-chain transaction history.
          </p>
        ) : history.error ? (
          <p className="rounded-card border border-clay bg-ink px-4 py-4 text-sm text-clay">
            {history.error}
          </p>
        ) : history.loading && history.entries.length === 0 ? (
          <p className="rounded-card border border-line bg-ink px-4 py-4 text-sm text-muted">
            Loading on-chain transactions…
          </p>
        ) : history.entries.length === 0 ? (
          <p className="rounded-card border border-line bg-ink px-4 py-4 text-sm text-muted">
            No on-chain transactions found for this filter.
          </p>
        ) : (
          <div className="grid gap-3">
            {history.entries.map((entry) => {
              const dir = classifyAccountTxDirection(entry, activeAddress);
              const heading = historyHeading(dir, entry.kind);
              const counterparty = dir === "received" ? entry.from : (entry.to ?? entry.from);
              const formattedTime = formatEntryTimestamp(entry.timestamp);
              return (
                <article key={entry.hash} className="rounded-card border border-line bg-ink px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-paper">
                      {heading}
                      {entry.kind ? ` · ${entry.kind}` : ""}
                    </p>
                    <p
                      className={`rounded-full border px-2 py-1 text-xs tracking-wide uppercase ${
                        entry.status === "failed"
                          ? "border-clay text-clay"
                          : "border-sage text-sage"
                      }`}
                    >
                      {entry.status === "failed"
                        ? "Failed"
                        : `Confirmed (${entry.height.toString()})`}
                    </p>
                  </div>
                  <p className="mt-2 tabular-nums text-paper">{formatKvnc(entry.amount)} KVNC</p>
                  <p className="mt-1 text-sm text-muted">
                    {dir === "received" ? "From" : "To"} {counterparty || "—"} · fee{" "}
                    {formatKvnc(entry.fee)} KVNC
                  </p>
                  {formattedTime ? <p className="mt-1 text-xs text-muted">{formattedTime}</p> : null}
                  <p className="mono mt-2 text-xs break-all text-muted">{entry.hash}</p>
                  <a
                    className="mt-2 inline-block text-sm text-copper"
                    href={explorerTxUrl(activeChainId, entry.hash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Explorer
                  </a>
                </article>
              );
            })}
            {history.hasMore ? (
              <button
                type="button"
                className="min-h-11 rounded-full border border-copper px-5 text-sm text-copper disabled:opacity-40"
                disabled={history.loadingMore}
                onClick={() => void history.loadMore()}
              >
                {history.loadingMore ? "Loading more…" : "Load more"}
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-paper">Local device activity</h3>
            <p className="text-sm text-muted">{note}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="min-h-11 rounded-full border border-line px-4 text-sm text-paper disabled:opacity-40"
              disabled={rows.length === 0}
              onClick={() => {
                triggerHistoryDownload(
                  exportHistoryCsv(rows),
                  historyExportFilename("csv"),
                  "text/csv;charset=utf-8",
                );
              }}
            >
              Export CSV
            </button>
            <button
              type="button"
              className="min-h-11 rounded-full border border-line px-4 text-sm text-paper disabled:opacity-40"
              disabled={rows.length === 0}
              onClick={() => {
                triggerHistoryDownload(
                  exportHistoryJson(rows),
                  historyExportFilename("json"),
                  "application/json;charset=utf-8",
                );
              }}
            >
              Export JSON
            </button>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-card border border-line bg-ink px-4 py-6 text-sm text-muted">
            No transactions from this device yet.
          </p>
        ) : null}
        {rows.map((row) => {
          const title = historyHeading(row.direction, row.note);
          const contract = title !== "Sent" && title !== "Received" && title !== "Self";
          return (
            <article key={row.hash} className="rounded-card border border-line bg-ink px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-paper">
                  {title}
                  {row.note && contract ? ` · ${row.note}` : ""}
                </p>
                <p
                  className={`rounded-full border px-2 py-1 text-xs tracking-wide uppercase ${
                    row.status === "pending"
                      ? "border-copper text-copper"
                      : row.status === "failed"
                        ? "border-clay text-clay"
                        : "border-sage text-sage"
                  }`}
                >
                  {badge(row)}
                </p>
              </div>
              <p className="mt-2 tabular-nums text-paper">
                {formatKvnc(BigInt(row.amountAtoms || "0"))} KVNC
              </p>
              <p className="mt-1 text-sm text-muted">
                To {row.counterparty || "—"} · fee {formatKvnc(BigInt(row.feeAtoms || "0"))} KVNC
                {row.gasUsed ? ` · gas ${row.gasUsed}` : ""}
              </p>
              {row.events && row.events.length > 0 ? (
                <p className="mt-1 text-sm text-muted">Events {row.events.join(", ")}</p>
              ) : null}
              <p className="mt-1 text-xs text-muted">{new Date(row.createdAt).toLocaleString()}</p>
              <p className="mono mt-2 text-xs break-all text-muted">{row.hash}</p>
              <a
                className="mt-2 inline-block text-sm text-copper"
                href={explorerTxUrl(row.chainId || activeChainId, row.hash)}
                target="_blank"
                rel="noreferrer"
              >
                Explorer
              </a>
            </article>
          );
        })}
      </section>
    </div>
  );
}
