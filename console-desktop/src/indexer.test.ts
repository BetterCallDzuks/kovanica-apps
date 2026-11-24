import { describe, expect, it } from "vitest";
import {
  indexerIntegrityStatusRows,
  parseIndexerIntegrityReport,
  parsePruneDryRunReport,
  pruneDryRunStatusRows,
} from "./indexer";

/** Exact `StoreIntegrityReport` shape from `kovanica-l1/crates/kovanica-indexer/src/types.rs`. */
const SAMPLE_HEALTHY_INTEGRITY = {
  ok: true,
  checked_at_ms: 1732450000000,
  backend: "redb",
  latest_indexed_height: 48210,
  next_id: 9125,
  event_count: 9124,
  height_bucket_count: 1420,
  address_bucket_count: 318,
  topic_bucket_count: 64,
  issues: [],
};

/** Exact `PruneDryRunReport` shape from `kovanica-l1/crates/kovanica-indexer/src/types.rs`. */
const SAMPLE_PRUNE_DRY_RUN = {
  checked_at_ms: 1732450123456,
  keep_heights: 10000,
  latest_indexed_height: 48210,
  cutoff_height: 38211,
  prunable_heights: 980,
  prunable_events: 5400,
  prunable_txs: 2150,
  prunable_bytes: 1843200,
  retained_heights: 440,
  retained_events: 3724,
  mutated: false,
};

describe("parseIndexerIntegrityReport", () => {
  it("parses a valid healthy StoreIntegrityReport JSON object", () => {
    const view = parseIndexerIntegrityReport({
      ...SAMPLE_HEALTHY_INTEGRITY,
      backend: " redb ",
    });

    expect(view).toEqual({
      ok: true,
      status: "healthy",
      checkedAtMs: 1732450000000,
      backend: "redb",
      latestIndexedHeight: 48210,
      nextId: 9125,
      eventCount: 9124,
      heightBucketCount: 1420,
      addressBucketCount: 318,
      topicBucketCount: 64,
      issues: [],
    });
  });

  it("parses a valid unhealthy StoreIntegrityReport JSON string with issues", () => {
    const payload = JSON.stringify({
      ...SAMPLE_HEALTHY_INTEGRITY,
      ok: false,
      issues: [
        "idx_heights bucket 48100 references missing event id 9001",
        "  idx_by_addr orphan index entry for address 0xabc  ",
      ],
    });

    const view = parseIndexerIntegrityReport(payload);
    expect(view.ok).toBe(false);
    expect(view.status).toBe("unhealthy");
    expect(view.issues).toEqual([
      "idx_heights bucket 48100 references missing event id 9001",
      "idx_by_addr orphan index entry for address 0xabc",
    ]);
  });

  it("rejects contradictory ok=true reports that still contain issues", () => {
    expect(() =>
      parseIndexerIntegrityReport({
        ...SAMPLE_HEALTHY_INTEGRITY,
        ok: true,
        issues: ["orphan height bucket detected"],
      }),
    ).toThrow("contradictory");
  });

  it("rejects malformed JSON and non-object inputs without echoing untrusted text", () => {
    const secret = "indexer-secret-bearer-token-98765";
    expect(() => parseIndexerIntegrityReport(`{broken ${secret}`)).toThrow(
      "Indexer integrity report returned invalid JSON.",
    );
    try {
      parseIndexerIntegrityReport(`{broken ${secret}`);
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }

    expect(() => parseIndexerIntegrityReport("")).toThrow("empty response");
    expect(() => parseIndexerIntegrityReport("   ")).toThrow("empty response");
    expect(() => parseIndexerIntegrityReport(null)).toThrow("invalid JSON object");
    expect(() => parseIndexerIntegrityReport([])).toThrow("invalid JSON object");
    expect(() => parseIndexerIntegrityReport(123)).toThrow("invalid JSON object");
  });

  it("validates required fields, numeric bounds, backend string, and issues array strictly", () => {
    expect(() =>
      parseIndexerIntegrityReport({ ...SAMPLE_HEALTHY_INTEGRITY, ok: "true" }),
    ).toThrow("missing a valid ok boolean");

    expect(() =>
      parseIndexerIntegrityReport({ ...SAMPLE_HEALTHY_INTEGRITY, checked_at_ms: -1 }),
    ).toThrow("invalid checked_at_ms");

    expect(() =>
      parseIndexerIntegrityReport({ ...SAMPLE_HEALTHY_INTEGRITY, backend: "" }),
    ).toThrow("invalid backend string");

    expect(() =>
      parseIndexerIntegrityReport({ ...SAMPLE_HEALTHY_INTEGRITY, backend: "redb\nInject: 1" }),
    ).toThrow("invalid backend string");

    expect(() =>
      parseIndexerIntegrityReport({ ...SAMPLE_HEALTHY_INTEGRITY, event_count: 1.5 }),
    ).toThrow("invalid event_count");

    expect(() =>
      parseIndexerIntegrityReport({ ...SAMPLE_HEALTHY_INTEGRITY, next_id: Number.NaN }),
    ).toThrow("invalid next_id");

    expect(() =>
      parseIndexerIntegrityReport({ ...SAMPLE_HEALTHY_INTEGRITY, issues: "none" }),
    ).toThrow("missing a valid issues array");

    expect(() =>
      parseIndexerIntegrityReport({ ...SAMPLE_HEALTHY_INTEGRITY, ok: false, issues: [42] }),
    ).toThrow("non-string issue entry");

    expect(() =>
      parseIndexerIntegrityReport({
        ...SAMPLE_HEALTHY_INTEGRITY,
        ok: false,
        issues: ["bad\u0000control"],
      }),
    ).toThrow("invalid issue entry");

    expect(() =>
      parseIndexerIntegrityReport({
        ...SAMPLE_HEALTHY_INTEGRITY,
        ok: false,
        issues: ["   "],
      }),
    ).toThrow("invalid issue entry");
  });
});

describe("parsePruneDryRunReport", () => {
  it("parses a valid PruneDryRunReport JSON object and JSON string", () => {
    const fromObj = parsePruneDryRunReport(SAMPLE_PRUNE_DRY_RUN);
    const fromStr = parsePruneDryRunReport(JSON.stringify(SAMPLE_PRUNE_DRY_RUN));

    const expected = {
      checkedAtMs: 1732450123456,
      keepHeights: 10000,
      latestIndexedHeight: 48210,
      cutoffHeight: 38211,
      prunableHeights: 980,
      prunableEvents: 5400,
      prunableTxs: 2150,
      prunableBytes: 1843200,
      retainedHeights: 440,
      retainedEvents: 3724,
      mutated: false,
    };

    expect(fromObj).toEqual(expected);
    expect(fromStr).toEqual(expected);
  });

  it("rejects payloads where mutated is true or missing", () => {
    expect(() =>
      parsePruneDryRunReport({ ...SAMPLE_PRUNE_DRY_RUN, mutated: true }),
    ).toThrow("mutated must be false");

    expect(() =>
      parsePruneDryRunReport({ ...SAMPLE_PRUNE_DRY_RUN, mutated: "false" }),
    ).toThrow("missing a valid mutated boolean");
  });

  it("rejects malformed JSON, non-objects, and invalid candidate counts without echoing raw input", () => {
    const secret = "prune-secret-value-xyz";
    try {
      parsePruneDryRunReport(`{invalid ${secret}`);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("Indexer prune dry-run report returned invalid JSON.");
      expect((err as Error).message).not.toContain(secret);
    }

    expect(() => parsePruneDryRunReport("")).toThrow("empty response");
    expect(() => parsePruneDryRunReport(null)).toThrow("invalid JSON object");
    expect(() => parsePruneDryRunReport([])).toThrow("invalid JSON object");

    for (const field of [
      "checked_at_ms",
      "keep_heights",
      "latest_indexed_height",
      "cutoff_height",
      "prunable_heights",
      "prunable_events",
      "prunable_txs",
      "prunable_bytes",
      "retained_heights",
      "retained_events",
    ] as const) {
      expect(() =>
        parsePruneDryRunReport({ ...SAMPLE_PRUNE_DRY_RUN, [field]: -1 }),
      ).toThrow(`invalid ${field}`);
      expect(() =>
        parsePruneDryRunReport({ ...SAMPLE_PRUNE_DRY_RUN, [field]: 2.5 }),
      ).toThrow(`invalid ${field}`);
      expect(() =>
        parsePruneDryRunReport({ ...SAMPLE_PRUNE_DRY_RUN, [field]: "100" }),
      ).toThrow(`invalid ${field}`);
    }
  });
});

describe("indexer status row helpers", () => {
  it("formats concise status rows for integrity and prune dry-run reports", () => {
    const integrity = parseIndexerIntegrityReport(SAMPLE_HEALTHY_INTEGRITY);
    expect(indexerIntegrityStatusRows(integrity)).toContainEqual({
      label: "Status",
      value: "Healthy",
    });
    expect(indexerIntegrityStatusRows(integrity)).toContainEqual({
      label: "Events",
      value: "9124",
    });

    const prune = parsePruneDryRunReport(SAMPLE_PRUNE_DRY_RUN);
    expect(pruneDryRunStatusRows(prune)).toContainEqual({
      label: "Prunable bytes",
      value: "1843200",
    });
    expect(pruneDryRunStatusRows(prune)).toContainEqual({
      label: "Mutated",
      value: "No (dry-run)",
    });
  });
});
