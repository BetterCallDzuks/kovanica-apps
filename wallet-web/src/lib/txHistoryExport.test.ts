import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountTxHistoryEntry } from "kovanica-sdk";

import {
  HISTORY_CSV_COLUMNS,
  HISTORY_EXPORT_SCHEMA_VERSION,
  accountTxEntryToExportRow,
  classifyAccountTxDirection,
  exportAccountTxHistoryCsv,
  exportAccountTxHistoryJson,
  type HistoryJsonExport,
} from "./txHistoryExport.ts";

const SELF_ADDR = "tknc1selfaddress0000000000000000000000000000000000000000000dag";
const OTHER_ADDR = "tknc1otheraddress000000000000000000000000000000000000000000dag";

const SENT_TX: AccountTxHistoryEntry = {
  hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  height: 1050n,
  timestamp: 1_763_890_000n,
  from: SELF_ADDR,
  to: OTHER_ADDR,
  amount: 12_345_678_901_234_567_890_123_456_789n,
  fee: 1_000n,
  kind: "transfer",
  status: "success",
};

const RECEIVED_TX: AccountTxHistoryEntry = {
  hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  height: 1049n,
  timestamp: null,
  from: OTHER_ADDR,
  to: SELF_ADDR,
  amount: 5_000_000_000n,
  fee: 500n,
  kind: "transfer",
  status: "success",
};

const CONTRACT_TX: AccountTxHistoryEntry = {
  hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  height: 1048n,
  timestamp: 1_763_880_000_000n,
  from: SELF_ADDR,
  to: "=HYPERLINK(\"http://evil.example\")",
  amount: 0n,
  fee: 2_500_000n,
  kind: "+cmd|'/C calc'!A0",
  status: "failed",
};

describe("txHistoryExport", () => {
  it("classifies sent, received, and contract directions accurately", () => {
    assert.equal(classifyAccountTxDirection(SENT_TX, SELF_ADDR), "sent");
    assert.equal(classifyAccountTxDirection(RECEIVED_TX, SELF_ADDR), "received");
    assert.equal(classifyAccountTxDirection(CONTRACT_TX, SELF_ADDR), "contract");
  });

  it("maps AccountTxHistoryEntry to HistoryExportRow with lossless bigint strings", () => {
    const row = accountTxEntryToExportRow(SENT_TX, SELF_ADDR, 2);
    assert.equal(row.direction, "sent");
    assert.equal(row.status, "confirmed");
    assert.equal(row.code, "0x1");
    assert.equal(row.amountAtoms, "12345678901234567890123456789");
    assert.equal(row.feeAtoms, "1000");
    assert.equal(row.counterparty, OTHER_ADDR);
    assert.equal(row.height, 1050);
    assert.equal(row.createdAt, 1_763_890_000_000);

    const failed = accountTxEntryToExportRow(CONTRACT_TX, SELF_ADDR, 2);
    assert.equal(failed.status, "failed");
    assert.equal(failed.code, "0x0");
    assert.equal(failed.createdAt, 1_763_880_000_000);
  });

  it("exports sanitized CSV with formula-injection neutralization and lossless KVNC amounts", () => {
    const csv = exportAccountTxHistoryCsv([SENT_TX, RECEIVED_TX, CONTRACT_TX], SELF_ADDR, 2);
    assert.ok(csv.endsWith("\r\n"));
    const header = csv.slice(0, csv.indexOf("\r\n"));
    assert.equal(header, HISTORY_CSV_COLUMNS.join(","));

    // Lossless large bigint KVNC decimal formatting
    assert.ok(csv.includes(",12345678901234567890.123456789,12345678901234567890123456789,"));
    // Formula injection payloads neutralized with leading single quote
    assert.ok(csv.includes('"\'=HYPERLINK(""http://evil.example"")"'));
    assert.ok(csv.includes(",'+cmd|'/C calc'!A0\r\n"));
  });

  it("exports structured pretty-printed JSON with schema metadata", () => {
    const exportedAt = new Date("2026-11-24T10:00:00.000Z");
    const json = exportAccountTxHistoryJson([SENT_TX, RECEIVED_TX], SELF_ADDR, 2, exportedAt);
    const parsed = JSON.parse(json) as HistoryJsonExport;

    assert.equal(parsed.schemaVersion, HISTORY_EXPORT_SCHEMA_VERSION);
    assert.equal(parsed.exportedAt, "2026-11-24T10:00:00.000Z");
    assert.equal(parsed.count, 2);
    assert.equal(parsed.transactions[0]?.direction, "sent");
    assert.equal(parsed.transactions[0]?.amountKvnc, "12345678901234567890.123456789");
    assert.equal(parsed.transactions[1]?.direction, "received");
    assert.equal(parsed.transactions[1]?.counterparty, OTHER_ADDR);
  });
});
