import type { StatusRow } from "./connection";

/** Health status derived from `kovanica-indexer`'s `StoreIntegrityReport`. */
export type IndexerIntegrityStatus = "healthy" | "unhealthy";

/**
 * Clean typed view of `kovanica-indexer`'s `StoreIntegrityReport` JSON payload
 * (`kovanica-l1/crates/kovanica-indexer/src/types.rs`).
 */
export interface IndexerIntegrityReportView {
  ok: boolean;
  status: IndexerIntegrityStatus;
  checkedAtMs: number;
  backend: string;
  latestIndexedHeight: number;
  nextId: number;
  eventCount: number;
  heightBucketCount: number;
  addressBucketCount: number;
  topicBucketCount: number;
  issues: string[];
}

/**
 * Clean typed view of `kovanica-indexer`'s `PruneDryRunReport` JSON payload
 * (`kovanica-l1/crates/kovanica-indexer/src/types.rs`).
 */
export interface PruneDryRunReportView {
  checkedAtMs: number;
  keepHeights: number;
  latestIndexedHeight: number;
  cutoffHeight: number;
  prunableHeights: number;
  prunableEvents: number;
  prunableTxs: number;
  prunableBytes: number;
  retainedHeights: number;
  retainedEvents: number;
  mutated: false;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

const MAX_BACKEND_LENGTH = 128;
const MAX_ISSUE_LENGTH = 1024;
const MAX_ISSUES_COUNT = 1000;

function parseJsonObjectPayload(
  payload: unknown,
  contextLabel: string,
): Record<string, unknown> {
  let raw: unknown = payload;
  if (typeof payload === "string") {
    if (payload.trim() === "") {
      throw new Error(`${contextLabel} returned an empty response.`);
    }
    try {
      raw = JSON.parse(payload);
    } catch {
      throw new Error(`${contextLabel} returned invalid JSON.`);
    }
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${contextLabel} returned an invalid JSON object.`);
  }

  return raw as Record<string, unknown>;
}

function assertNonNegativeSafeInteger(
  value: unknown,
  fieldName: string,
  contextLabel: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${contextLabel} payload has an invalid ${fieldName}.`);
  }
  return value;
}

/**
 * Strictly validates and parses `kovanica-indexer`'s `StoreIntegrityReport` JSON payload.
 *
 * Accepts either a parsed JSON object or a raw JSON string. Error messages are
 * deliberately static and never echo raw untrusted input.
 */
export function parseIndexerIntegrityReport(payload: unknown): IndexerIntegrityReportView {
  const ctx = "Indexer integrity report";
  const obj = parseJsonObjectPayload(payload, ctx);

  if (typeof obj.ok !== "boolean") {
    throw new Error(`${ctx} payload is missing a valid ok boolean.`);
  }

  const checkedAtMs = assertNonNegativeSafeInteger(obj.checked_at_ms, "checked_at_ms", ctx);

  if (typeof obj.backend !== "string") {
    throw new Error(`${ctx} payload is missing a valid backend string.`);
  }
  const backend = obj.backend.trim();
  if (
    backend === "" ||
    backend.length > MAX_BACKEND_LENGTH ||
    CONTROL_CHAR_RE.test(backend)
  ) {
    throw new Error(`${ctx} payload has an invalid backend string.`);
  }

  const latestIndexedHeight = assertNonNegativeSafeInteger(
    obj.latest_indexed_height,
    "latest_indexed_height",
    ctx,
  );
  const nextId = assertNonNegativeSafeInteger(obj.next_id, "next_id", ctx);
  const eventCount = assertNonNegativeSafeInteger(obj.event_count, "event_count", ctx);
  const heightBucketCount = assertNonNegativeSafeInteger(
    obj.height_bucket_count,
    "height_bucket_count",
    ctx,
  );
  const addressBucketCount = assertNonNegativeSafeInteger(
    obj.address_bucket_count,
    "address_bucket_count",
    ctx,
  );
  const topicBucketCount = assertNonNegativeSafeInteger(
    obj.topic_bucket_count,
    "topic_bucket_count",
    ctx,
  );

  if (!Array.isArray(obj.issues)) {
    throw new Error(`${ctx} payload is missing a valid issues array.`);
  }
  if (obj.issues.length > MAX_ISSUES_COUNT) {
    throw new Error(`${ctx} payload exceeds maximum supported issues count.`);
  }

  const issues: string[] = [];
  for (const item of obj.issues) {
    if (typeof item !== "string") {
      throw new Error(`${ctx} payload contains a non-string issue entry.`);
    }
    const trimmed = item.trim();
    if (
      trimmed === "" ||
      trimmed.length > MAX_ISSUE_LENGTH ||
      CONTROL_CHAR_RE.test(trimmed)
    ) {
      throw new Error(`${ctx} payload contains an invalid issue entry.`);
    }
    issues.push(trimmed);
  }

  if (obj.ok && issues.length > 0) {
    throw new Error(
      `${ctx} payload is contradictory: ok is true while issues are present.`,
    );
  }

  return {
    ok: obj.ok,
    status: obj.ok ? "healthy" : "unhealthy",
    checkedAtMs,
    backend,
    latestIndexedHeight,
    nextId,
    eventCount,
    heightBucketCount,
    addressBucketCount,
    topicBucketCount,
    issues,
  };
}

/**
 * Strictly validates and parses `kovanica-indexer`'s `PruneDryRunReport` JSON payload.
 *
 * Enforces `mutated === false` to fail closed if a payload claims store mutation.
 * Accepts either a parsed JSON object or a raw JSON string. Error messages are
 * deliberately static and never echo raw untrusted input.
 */
export function parsePruneDryRunReport(payload: unknown): PruneDryRunReportView {
  const ctx = "Indexer prune dry-run report";
  const obj = parseJsonObjectPayload(payload, ctx);

  const checkedAtMs = assertNonNegativeSafeInteger(obj.checked_at_ms, "checked_at_ms", ctx);
  const keepHeights = assertNonNegativeSafeInteger(obj.keep_heights, "keep_heights", ctx);
  const latestIndexedHeight = assertNonNegativeSafeInteger(
    obj.latest_indexed_height,
    "latest_indexed_height",
    ctx,
  );
  const cutoffHeight = assertNonNegativeSafeInteger(obj.cutoff_height, "cutoff_height", ctx);
  const prunableHeights = assertNonNegativeSafeInteger(
    obj.prunable_heights,
    "prunable_heights",
    ctx,
  );
  const prunableEvents = assertNonNegativeSafeInteger(
    obj.prunable_events,
    "prunable_events",
    ctx,
  );
  const prunableTxs = assertNonNegativeSafeInteger(obj.prunable_txs, "prunable_txs", ctx);
  const prunableBytes = assertNonNegativeSafeInteger(
    obj.prunable_bytes,
    "prunable_bytes",
    ctx,
  );
  const retainedHeights = assertNonNegativeSafeInteger(
    obj.retained_heights,
    "retained_heights",
    ctx,
  );
  const retainedEvents = assertNonNegativeSafeInteger(
    obj.retained_events,
    "retained_events",
    ctx,
  );

  if (typeof obj.mutated !== "boolean") {
    throw new Error(`${ctx} payload is missing a valid mutated boolean.`);
  }
  if (obj.mutated !== false) {
    throw new Error(`${ctx} payload indicates store mutation (mutated must be false).`);
  }

  return {
    checkedAtMs,
    keepHeights,
    latestIndexedHeight,
    cutoffHeight,
    prunableHeights,
    prunableEvents,
    prunableTxs,
    prunableBytes,
    retainedHeights,
    retainedEvents,
    mutated: false,
  };
}

/** Display rows for rendering `StoreIntegrityReport` in console-desktop. */
export function indexerIntegrityStatusRows(report: IndexerIntegrityReportView): StatusRow[] {
  return [
    { label: "Status", value: report.ok ? "Healthy" : "Unhealthy" },
    { label: "Backend", value: report.backend },
    { label: "Latest indexed height", value: String(report.latestIndexedHeight) },
    { label: "Events", value: String(report.eventCount) },
    { label: "Height buckets", value: String(report.heightBucketCount) },
    { label: "Address buckets", value: String(report.addressBucketCount) },
    { label: "Topic buckets", value: String(report.topicBucketCount) },
    { label: "Issues", value: String(report.issues.length) },
  ];
}

/** Display rows for rendering `PruneDryRunReport` in console-desktop. */
export function pruneDryRunStatusRows(report: PruneDryRunReportView): StatusRow[] {
  return [
    { label: "Keep heights", value: String(report.keepHeights) },
    { label: "Cutoff height", value: String(report.cutoffHeight) },
    { label: "Prunable heights", value: String(report.prunableHeights) },
    { label: "Prunable events", value: String(report.prunableEvents) },
    { label: "Prunable txs", value: String(report.prunableTxs) },
    { label: "Prunable bytes", value: String(report.prunableBytes) },
    { label: "Retained heights", value: String(report.retainedHeights) },
    { label: "Retained events", value: String(report.retainedEvents) },
    { label: "Mutated", value: "No (dry-run)" },
  ];
}
