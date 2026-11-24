import type { AccountTxHistoryEntry } from "kovanica-sdk";
import {
  HISTORY_CSV_COLUMNS,
  HISTORY_EXPORT_SCHEMA_VERSION,
  escapeCsvField,
  exportHistoryCsv,
  exportHistoryJson,
  historyExportFilename,
  sanitizeCsvText,
  triggerHistoryDownload,
  type HistoryExportRow,
  type HistoryJsonExport,
  type HistoryJsonRecord,
} from "../core/export-history.ts";

export {
  HISTORY_CSV_COLUMNS,
  HISTORY_EXPORT_SCHEMA_VERSION,
  escapeCsvField,
  historyExportFilename,
  sanitizeCsvText,
  triggerHistoryDownload,
  type HistoryExportRow,
  type HistoryJsonExport,
  type HistoryJsonRecord,
};

/**
 * Classifies an on-chain `AccountTxHistoryEntry` relative to the inspected account address.
 */
export function classifyAccountTxDirection(
  entry: AccountTxHistoryEntry,
  accountAddress: string,
): "sent" | "received" | "contract" {
  const kind = entry.kind.trim().toLowerCase();
  if (kind && kind !== "transfer" && kind !== "coinbase") {
    return "contract";
  }
  const normalizedAccount = accountAddress.trim().toLowerCase();
  const normalizedFrom = entry.from.trim().toLowerCase();
  const normalizedTo = (entry.to ?? "").trim().toLowerCase();
  if (normalizedAccount && normalizedFrom === normalizedAccount) {
    return "sent";
  }
  if (normalizedAccount && normalizedTo === normalizedAccount) {
    return "received";
  }
  return "sent";
}

function normalizeTimestampMs(timestamp: bigint | null): number {
  if (timestamp == null || timestamp <= 0n) return 0;
  // L1 leader header timestamps are Unix seconds; convert to ms if below 1e12.
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return 0;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function toSafeHeight(height: bigint): number | null {
  const num = Number(height);
  return Number.isSafeInteger(num) ? num : null;
}

/**
 * Maps a lossless `kovanica-sdk` `AccountTxHistoryEntry` into a `HistoryExportRow`.
 */
export function accountTxEntryToExportRow(
  entry: AccountTxHistoryEntry,
  accountAddress: string,
  chainId: number,
): HistoryExportRow {
  const direction = classifyAccountTxDirection(entry, accountAddress);
  const counterparty =
    direction === "received"
      ? entry.from
      : entry.to ?? entry.from;

  return {
    hash: entry.hash,
    status: entry.status === "failed" ? "failed" : "confirmed",
    direction,
    amountAtoms: entry.amount.toString(),
    feeAtoms: entry.fee.toString(),
    counterparty,
    chainId,
    createdAt: normalizeTimestampMs(entry.timestamp),
    height: toSafeHeight(entry.height),
    note: entry.kind,
    code: entry.status === "failed" ? "0x0" : "0x1",
  };
}

/**
 * Exports `AccountTxHistoryEntry[]` as RFC 4180 CSV with spreadsheet formula-injection
 * neutralization and lossless `bigint` KVNC amounts.
 */
export function exportAccountTxHistoryCsv(
  entries: readonly AccountTxHistoryEntry[],
  accountAddress: string,
  chainId: number,
): string {
  const rows = entries.map((entry) => accountTxEntryToExportRow(entry, accountAddress, chainId));
  return exportHistoryCsv(rows);
}

/**
 * Exports `AccountTxHistoryEntry[]` as pretty-printed JSON with schema metadata.
 */
export function exportAccountTxHistoryJson(
  entries: readonly AccountTxHistoryEntry[],
  accountAddress: string,
  chainId: number,
  exportedAt: Date | string | number = new Date(),
): string {
  const rows = entries.map((entry) => accountTxEntryToExportRow(entry, accountAddress, chainId));
  return exportHistoryJson(rows, exportedAt);
}
