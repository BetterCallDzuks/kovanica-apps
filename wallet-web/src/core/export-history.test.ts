import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
} from "./export-history.ts";

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
    assert.equal(escapeCsvField("plain"), "plain");
    assert.equal(escapeCsvField("a,b"), '"a,b"');
    assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvField("line1\nline2"), '"line1\nline2"');
    assert.equal(escapeCsvField("line1\r\nline2"), '"line1\r\nline2"');
  });

  it("neutralizes CSV formula injection prefixes on untrusted text", () => {
    assert.equal(sanitizeCsvText("=SUM(A1:A2)"), "'=SUM(A1:A2)");
    assert.equal(sanitizeCsvText("+cmd|'/C calc'!A0"), "'+cmd|'/C calc'!A0");
    assert.equal(sanitizeCsvText("-2+3"), "'-2+3");
    assert.equal(sanitizeCsvText("@HYPERLINK()"), "'@HYPERLINK()");
    assert.equal(sanitizeCsvText("\t=1+1"), "'\t=1+1");
    assert.equal(sanitizeCsvText("\r=1+1"), "'\r=1+1");
    assert.equal(sanitizeCsvText("normal text"), "normal text");
    assert.equal(sanitizeCsvText(""), "");
  });

  it("exports deterministic CSV with lossless KVNC amounts and proper escaping", () => {
    const csv = exportHistoryCsv([SAMPLE_TRANSFER, SAMPLE_CONTRACT]);
    assert.ok(csv.endsWith("\r\n"));

    const headerLine = csv.slice(0, csv.indexOf("\r\n"));
    assert.equal(headerLine, HISTORY_CSV_COLUMNS.join(","));

    // Lossless BigInt KVNC decimal conversion (exceeds Number.MAX_SAFE_INTEGER)
    assert.ok(csv.includes(",12345678901234567890.123456789,12345678901234567890123456789,"));
    assert.ok(csv.includes(",0.000001,1000,"));
    assert.ok(csv.includes(",5,5000000000,0.0025,2500000,"));

    // Quoted field with embedded double quotes, comma, and newline
    assert.ok(csv.includes('"insufficient ""balance"", retry\nlater"'));
    assert.ok(csv.includes(",Transfer; Approval,token_transfer\r\n"));
  });

  it("neutralizes formula injection inside CSV export rows without corrupting numeric amounts", () => {
    const malicious: HistoryExportRow = {
      ...SAMPLE_TRANSFER,
      counterparty: "=HYPERLINK(\"http://evil.example\")",
      note: "+1+1",
      error: "-cmd",
      events: ["@evil"],
    };
    const csv = exportHistoryCsv([malicious]);
    assert.ok(csv.includes('"\'=HYPERLINK(""http://evil.example"")"'));
    assert.ok(csv.includes(",'+1+1\r\n"));
    assert.ok(csv.includes(",'-cmd,"));
    assert.ok(csv.includes(",'@evil,"));
    // Numeric KVNC amount remains unprefixed
    assert.ok(csv.includes(",12345678901234567890.123456789,"));
  });

  it("exports empty CSV with just the header row", () => {
    const csv = exportHistoryCsv([]);
    assert.equal(csv, `${HISTORY_CSV_COLUMNS.join(",")}\r\n`);
  });

  it("exports clean pretty-printed JSON with schema version and exported timestamp", () => {
    const exportedAt = new Date("2026-11-22T21:00:00.000Z");
    const json = exportHistoryJson([SAMPLE_TRANSFER, SAMPLE_CONTRACT], exportedAt);

    // Pretty-printed with 2-space indentation
    assert.ok(json.includes('\n  "schemaVersion": 1,'));

    const parsed = JSON.parse(json) as HistoryJsonExport;
    assert.equal(parsed.schemaVersion, HISTORY_EXPORT_SCHEMA_VERSION);
    assert.equal(parsed.exportedAt, "2026-11-22T21:00:00.000Z");
    assert.equal(parsed.count, 2);
    assert.equal(parsed.transactions.length, 2);

    assert.equal(parsed.transactions[0]?.amountKvnc, "12345678901234567890.123456789");
    assert.equal(parsed.transactions[0]?.amountAtoms, "12345678901234567890123456789");
    assert.equal(parsed.transactions[0]?.feeKvnc, "0.000001");
    assert.equal(parsed.transactions[0]?.type, "Sent");
    assert.equal(parsed.transactions[0]?.receiptStatus, "0x1 Success");

    assert.equal(parsed.transactions[1]?.type, "Token");
    assert.equal(parsed.transactions[1]?.receiptStatus, '0x0 Reverted: insufficient "balance", retry\nlater');
    assert.deepEqual(parsed.transactions[1]?.events, ["Transfer", "Approval"]);
  });

  it("builds dated filenames", () => {
    const now = new Date("2026-11-22T21:00:00.000Z");
    assert.equal(historyExportFilename("csv", now), "kovanica-history-2026-11-22.csv");
    assert.equal(historyExportFilename("json", now), "kovanica-history-2026-11-22.json");
  });

  it("safely no-ops triggerHistoryDownload in non-DOM environments", () => {
    assert.equal(triggerHistoryDownload("a,b\r\n", "test.csv", "text/csv"), false);
  });
});
