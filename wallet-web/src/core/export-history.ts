import { formatKvnc } from "./format.ts";
import { historyHeading, receiptStatusLine } from "./history-row.ts";

export const HISTORY_EXPORT_SCHEMA_VERSION = 1;

export const HISTORY_CSV_COLUMNS = [
  "timestamp_iso",
  "hash",
  "direction",
  "type",
  "status",
  "receipt_status",
  "amount_kvnc",
  "amount_atoms",
  "fee_kvnc",
  "fee_atoms",
  "counterparty",
  "chain_id",
  "height",
  "gas_used",
  "code",
  "error",
  "logs",
  "events",
  "note",
] as const;

export type HistoryExportRow = {
  hash: string;
  status: string;
  direction: string;
  amountAtoms: string;
  feeAtoms: string;
  counterparty: string;
  chainId: number;
  createdAt: number;
  height: number | null;
  note: string;
  gasUsed?: string | null;
  code?: string | null;
  error?: string | null;
  logs?: number | null;
  events?: string[] | null;
};

export type HistoryJsonRecord = {
  timestampIso: string;
  createdAt: number;
  hash: string;
  direction: string;
  type: string;
  status: string;
  receiptStatus: string;
  amountKvnc: string;
  amountAtoms: string;
  feeKvnc: string;
  feeAtoms: string;
  counterparty: string;
  chainId: number;
  height: number | null;
  gasUsed: string | null;
  code: string | null;
  error: string | null;
  logs: number | null;
  events: string[];
  note: string;
};

export type HistoryJsonExport = {
  schemaVersion: number;
  exportedAt: string;
  count: number;
  transactions: HistoryJsonRecord[];
};

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function parseAtomsSafe(raw: string | null | undefined): bigint {
  const trimmed = (raw ?? "").trim();
  if (!/^-?\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

function toIsoTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizeExportedAt(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** Neutralizes spreadsheet formula injection on untrusted text fields. */
export function sanitizeCsvText(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** Escapes a single field according to RFC 4180. */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toRecord(row: HistoryExportRow): HistoryJsonRecord {
  const amountAtoms = parseAtomsSafe(row.amountAtoms);
  const feeAtoms = parseAtomsSafe(row.feeAtoms);
  return {
    timestampIso: toIsoTimestamp(row.createdAt),
    createdAt: row.createdAt,
    hash: row.hash,
    direction: row.direction,
    type: historyHeading(row.direction, row.note),
    status: row.status,
    receiptStatus: receiptStatusLine(row.code, row.status, row.error),
    amountKvnc: formatKvnc(amountAtoms),
    amountAtoms: amountAtoms.toString(),
    feeKvnc: formatKvnc(feeAtoms),
    feeAtoms: feeAtoms.toString(),
    counterparty: row.counterparty,
    chainId: row.chainId,
    height: row.height,
    gasUsed: row.gasUsed ?? null,
    code: row.code ?? null,
    error: row.error ?? null,
    logs: row.logs ?? null,
    events: row.events ? [...row.events] : [],
    note: row.note,
  };
}

/** Exports transaction history rows as RFC 4180 CSV with lossless KVNC amounts. */
export function exportHistoryCsv(rows: readonly HistoryExportRow[]): string {
  const header = HISTORY_CSV_COLUMNS.join(",");
  const lines = rows.map((row) => {
    const rec = toRecord(row);
    const fields: string[] = [
      rec.timestampIso,
      sanitizeCsvText(rec.hash),
      sanitizeCsvText(rec.direction),
      sanitizeCsvText(rec.type),
      sanitizeCsvText(rec.status),
      sanitizeCsvText(rec.receiptStatus),
      rec.amountKvnc,
      rec.amountAtoms,
      rec.feeKvnc,
      rec.feeAtoms,
      sanitizeCsvText(rec.counterparty),
      String(rec.chainId),
      rec.height == null ? "" : String(rec.height),
      sanitizeCsvText(rec.gasUsed ?? ""),
      sanitizeCsvText(rec.code ?? ""),
      sanitizeCsvText(rec.error ?? ""),
      rec.logs == null ? "" : String(rec.logs),
      sanitizeCsvText(rec.events.join("; ")),
      sanitizeCsvText(rec.note),
    ];
    return fields.map(escapeCsvField).join(",");
  });
  return [header, ...lines].join("\r\n") + "\r\n";
}

/** Exports transaction history rows as pretty-printed JSON with schema metadata. */
export function exportHistoryJson(
  rows: readonly HistoryExportRow[],
  exportedAt: Date | string | number = new Date(),
): string {
  const payload: HistoryJsonExport = {
    schemaVersion: HISTORY_EXPORT_SCHEMA_VERSION,
    exportedAt: normalizeExportedAt(exportedAt),
    count: rows.length,
    transactions: rows.map(toRecord),
  };
  return JSON.stringify(payload, null, 2);
}

/** Builds a dated filename for exported history files. */
export function historyExportFilename(format: "csv" | "json", now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `kovanica-history-${day}.${format}`;
}

/** Triggers a browser file download; safely no-ops in SSR/non-DOM environments. */
export function triggerHistoryDownload(
  content: string,
  filename: string,
  mimeType: string,
): boolean {
  if (
    typeof document === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return false;
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body?.appendChild(link);
  link.click();
  link.remove();
  if (typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
  return true;
}
