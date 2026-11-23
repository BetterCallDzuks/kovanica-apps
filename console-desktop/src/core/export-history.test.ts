import { describe, expect, it } from "vitest";

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
} from "./export-history";

const SAMPLE_TRANSFER: HistoryExportRow = {
  hash: "0xabc123",
  status: "confirmed",
  direction: "sent",
  amountAtoms: "12345678901234567890123456789",
  feeAtoms: "1000",
  counterparty: "kvnc1receiver",
  chainId: 2,
  createdAt: Date.UTC(2026, 10, 22, 12, 34, 56),
  height: 4201,
  note: "",
};

const SAMPLE_CONTRACT: HistoryExportRow = {
  hash: "0xdef456",
  status: "failed",
  direction: "contract",
  amountAtoms: "5000000000",
  feeAtoms: "2500000",
  counterparty: "kvnc1contract",
  chainId: 2,
  createdAt: Date.UTC(2026, 10, 22, 13, 0, 0),
  height: 4205,
  note: "token_transfer",
  gasUsed: "21000",
  code: "0x0",
  error: 'insufficient "balance", retry\nlater',
  logs: 2,
  events: ["Transfer", "Approval"],
};

describe("export-history", () => {
  it("escapes RFC 4180 fields with commas, quotes, and newlines", () => {
    expect(escapeCsvField("plain")).toBe("plain");
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("neutralizes CSV formula injection prefixes on untrusted text", () => {
    expect(sanitizeCsvText("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(sanitizeCsvText("+cmd|'/C calc'!A0")).toBe("'+cmd|'/C calc'!A0");
    expect(sanitizeCsvText("-2+3")).toBe("'-2+3");
    expect(sanitizeCsvText("@HYPERLINK()")).toBe("'@HYPERLINK()");
    expect(sanitizeCsvText("\t=1+1")).toBe("'\t=1+1");
    expect(sanitizeCsvText("\r=1+1")).toBe("'\r=1+1");
    expect(sanitizeCsvText("normal text")).toBe("normal text");
    expect(sanitizeCsvText("")).toBe("");
  });

  it("exports deterministic CSV with lossless KVNC amounts and proper escaping", () => {
    const csv = exportHistoryCsv([SAMPLE_TRANSFER, SAMPLE_CONTRACT]);
    expect(csv.endsWith("\r\n")).toBe(true);

    const headerLine = csv.slice(0, csv.indexOf("\r\n"));
    expect(headerLine).toBe(HISTORY_CSV_COLUMNS.join(","));

    // Lossless BigInt KVNC decimal conversion (exceeds Number.MAX_SAFE_INTEGER)
    expect(csv).toContain(",12345678901234567890.123456789,12345678901234567890123456789,");
    expect(csv).toContain(",0.000001,1000,");
    expect(csv).toContain(",5,5000000000,0.0025,2500000,");

    // Quoted field with embedded double quotes, comma, and newline
    expect(csv).toContain('"insufficient ""balance"", retry\nlater"');
    expect(csv).toContain(",Transfer; Approval,token_transfer\r\n");
  });

  it("neutralizes formula injection inside CSV export rows without corrupting numeric amounts", () => {
    const malicious: HistoryExportRow = {
      ...SAMPLE_TRANSFER,
      counterparty: '=HYPERLINK("http://evil.example")',
      note: "+1+1",
      error: "-cmd",
      events: ["@evil"],
    };
    const csv = exportHistoryCsv([malicious]);
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.example"")"');
    expect(csv).toContain(",'+1+1\r\n");
    expect(csv).toContain(",'-cmd,");
    expect(csv).toContain(",'@evil,");
    // Numeric KVNC amount remains unprefixed
    expect(csv).toContain(",12345678901234567890.123456789,");
  });

  it("exports empty CSV with just the header row", () => {
    const csv = exportHistoryCsv([]);
    expect(csv).toBe(`${HISTORY_CSV_COLUMNS.join(",")}\r\n`);
  });

  it("exports clean pretty-printed JSON with schema version and exported timestamp", () => {
    const exportedAt = new Date("2026-11-22T21:00:00.000Z");
    const json = exportHistoryJson([SAMPLE_TRANSFER, SAMPLE_CONTRACT], exportedAt);

    expect(json).toContain('\n  "schemaVersion": 1,');

    const parsed = JSON.parse(json) as HistoryJsonExport;
    expect(parsed.schemaVersion).toBe(HISTORY_EXPORT_SCHEMA_VERSION);
    expect(parsed.exportedAt).toBe("2026-11-22T21:00:00.000Z");
    expect(parsed.count).toBe(2);
    expect(parsed.transactions).toHaveLength(2);

    expect(parsed.transactions[0]?.amountKvnc).toBe("12345678901234567890.123456789");
    expect(parsed.transactions[0]?.amountAtoms).toBe("12345678901234567890123456789");
    expect(parsed.transactions[0]?.feeKvnc).toBe("0.000001");
    expect(parsed.transactions[0]?.type).toBe("Sent");
    expect(parsed.transactions[0]?.receiptStatus).toBe("0x1 Success");

    expect(parsed.transactions[1]?.type).toBe("Token");
    expect(parsed.transactions[1]?.receiptStatus).toBe(
      '0x0 Reverted: insufficient "balance", retry\nlater',
    );
    expect(parsed.transactions[1]?.events).toEqual(["Transfer", "Approval"]);
  });

  it("builds dated filenames", () => {
    const now = new Date("2026-11-22T21:00:00.000Z");
    expect(historyExportFilename("csv", now)).toBe("kovanica-history-2026-11-22.csv");
    expect(historyExportFilename("json", now)).toBe("kovanica-history-2026-11-22.json");
  });

  it("safely no-ops triggerHistoryDownload in non-DOM environments", () => {
    expect(triggerHistoryDownload("a,b\r\n", "test.csv", "text/csv")).toBe(false);
  });
});
