import type { StatusRow } from "./connection";

/** Default loopback base URL for `kovanica-comms-relay`. */
export const DEFAULT_COMMS_RELAY_URL = "http://127.0.0.1:8080";

/** Health status derived from `kovanica-comms-relay`'s `GET /v1/health`. */
export type CommsRelayHealthStatus = "healthy" | "unhealthy";

/** Clean typed view of `kovanica-comms-relay`'s `GET /v1/health` JSON payload. */
export interface CommsRelayHealthView {
  ok: boolean;
  status: CommsRelayHealthStatus;
  version: string;
  queuedEnvelopes: number;
}

/** Clean typed view of `kovanica-comms-relay`'s `GET /metrics` OpenMetrics 1.0 exposition. */
export interface CommsRelayMetricsView {
  queuedEnvelopes: number;
  activeMailboxes: number;
  maxMailboxDepth: number;
  uptimeSeconds: number | null;
  envelopesAcceptedTotal: number;
  envelopesDuplicateTotal: number;
  envelopesDeliveredTotal: number;
  envelopesExpiredTotal: number;
  envelopesRejectedTotal: number;
  envelopesRateLimitedTotal: number;
  inboxRequestsTotal: number;
  ackRejectedTotal: number;
  hasEofMarker: boolean;
}

type CanonicalMetricField =
  | "queuedEnvelopes"
  | "activeMailboxes"
  | "maxMailboxDepth"
  | "uptimeSeconds"
  | "envelopesAcceptedTotal"
  | "envelopesDuplicateTotal"
  | "envelopesDeliveredTotal"
  | "envelopesExpiredTotal"
  | "envelopesRejectedTotal"
  | "envelopesRateLimitedTotal"
  | "inboxRequestsTotal"
  | "ackRejectedTotal";

/**
 * Maps OpenMetrics metric names emitted by `kovanica-comms-relay/src/server.rs`
 * (plus compatible aliases) to typed `CommsRelayMetricsView` fields.
 */
const METRIC_NAME_TO_FIELD: Readonly<Record<string, CanonicalMetricField>> = {
  // Gauges
  kovanica_comms_relay_envelopes_queued: "queuedEnvelopes",
  kovanica_comms_relay_queued_envelopes: "queuedEnvelopes",
  kovanica_comms_relay_active_mailboxes: "activeMailboxes",
  kovanica_comms_relay_max_mailbox_depth: "maxMailboxDepth",
  kovanica_comms_relay_uptime_seconds: "uptimeSeconds",
  // Counters (OpenMetrics 1.0 `_total` suffix + bare fallback)
  kovanica_comms_relay_envelopes_accepted_total: "envelopesAcceptedTotal",
  kovanica_comms_relay_envelopes_accepted: "envelopesAcceptedTotal",
  kovanica_comms_relay_envelopes_duplicate_total: "envelopesDuplicateTotal",
  kovanica_comms_relay_envelopes_duplicate: "envelopesDuplicateTotal",
  kovanica_comms_relay_envelopes_delivered_total: "envelopesDeliveredTotal",
  kovanica_comms_relay_envelopes_delivered: "envelopesDeliveredTotal",
  kovanica_comms_relay_envelopes_expired_total: "envelopesExpiredTotal",
  kovanica_comms_relay_envelopes_expired: "envelopesExpiredTotal",
  kovanica_comms_relay_envelopes_rejected_total: "envelopesRejectedTotal",
  kovanica_comms_relay_envelopes_rejected: "envelopesRejectedTotal",
  kovanica_comms_relay_envelopes_rate_limited_total: "envelopesRateLimitedTotal",
  kovanica_comms_relay_envelopes_rate_limited: "envelopesRateLimitedTotal",
  kovanica_comms_relay_inbox_requests_total: "inboxRequestsTotal",
  kovanica_comms_relay_inbox_requests: "inboxRequestsTotal",
  kovanica_comms_relay_ack_rejected_total: "ackRejectedTotal",
  kovanica_comms_relay_ack_rejected: "ackRejectedTotal",
};

const REQUIRED_METRIC_FIELDS: ReadonlyArray<{
  field: CanonicalMetricField;
  metricName: string;
}> = [
  { field: "queuedEnvelopes", metricName: "kovanica_comms_relay_envelopes_queued" },
  { field: "activeMailboxes", metricName: "kovanica_comms_relay_active_mailboxes" },
  { field: "maxMailboxDepth", metricName: "kovanica_comms_relay_max_mailbox_depth" },
  { field: "envelopesAcceptedTotal", metricName: "kovanica_comms_relay_envelopes_accepted_total" },
  { field: "envelopesDeliveredTotal", metricName: "kovanica_comms_relay_envelopes_delivered_total" },
  { field: "envelopesExpiredTotal", metricName: "kovanica_comms_relay_envelopes_expired_total" },
  { field: "envelopesRejectedTotal", metricName: "kovanica_comms_relay_envelopes_rejected_total" },
  {
    field: "envelopesRateLimitedTotal",
    metricName: "kovanica_comms_relay_envelopes_rate_limited_total",
  },
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Matches an OpenMetrics 1.0 sample line:
 *   `<metric_name>[{label="val",...}] <value>[ <timestamp>][ # <exemplar>]`
 */
const OPENMETRICS_SAMPLE_RE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?[ \t]+([^\s#]+)(?:[ \t]+([^\s#]+))?(?:[ \t]+#.*)?$/;

const NUMERIC_TOKEN_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function assertNonNegativeSafeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Comms relay /v1/health payload has an invalid ${fieldName}.`);
  }
  return value;
}

/**
 * Strictly validates and parses `kovanica-comms-relay`'s `GET /v1/health` JSON payload
 * (`{"ok": true, "version": "0.1.0", "envelopes": 0}`).
 *
 * Accepts either a parsed JSON object or a raw JSON string. Error messages are
 * deliberately static and never echo raw untrusted input.
 */
export function parseCommsRelayHealth(payload: unknown): CommsRelayHealthView {
  let raw: unknown = payload;
  if (typeof payload === "string") {
    if (payload.trim() === "") {
      throw new Error("Comms relay /v1/health returned an empty response.");
    }
    try {
      raw = JSON.parse(payload);
    } catch {
      throw new Error("Comms relay /v1/health returned invalid JSON.");
    }
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Comms relay /v1/health returned an invalid JSON object.");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.ok !== "boolean") {
    throw new Error("Comms relay /v1/health payload is missing a valid ok boolean.");
  }

  if (typeof obj.version !== "string") {
    throw new Error("Comms relay /v1/health payload is missing a valid version string.");
  }
  const version = obj.version.trim();
  if (version === "" || version.length > 128 || CONTROL_CHAR_RE.test(version)) {
    throw new Error("Comms relay /v1/health payload has an invalid version string.");
  }

  const queuedEnvelopes = assertNonNegativeSafeInteger(obj.envelopes, "envelopes");

  return {
    ok: obj.ok,
    status: obj.ok ? "healthy" : "unhealthy",
    version,
    queuedEnvelopes,
  };
}

function parseOpenMetricsCounterOrGaugeValue(rawToken: string, lineNumber: number): number {
  if (!NUMERIC_TOKEN_RE.test(rawToken)) {
    throw new Error(`Comms relay /metrics contains a non-numeric value at line ${lineNumber}.`);
  }
  const value = Number(rawToken);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error(`Comms relay /metrics contains an invalid metric value at line ${lineNumber}.`);
  }
  return value;
}

/**
 * Strictly parses `kovanica-comms-relay`'s `GET /metrics` OpenMetrics 1.0 text exposition
 * into a typed status view.
 *
 * Validates line syntax, rejects malformed/negative/non-integer/duplicate samples,
 * requires core queue depth gauges and envelope lifecycle counters, and never echoes
 * raw input in error messages.
 */
export function parseCommsRelayMetrics(openMetricsText: unknown): CommsRelayMetricsView {
  if (typeof openMetricsText !== "string") {
    throw new Error("Comms relay /metrics payload must be an OpenMetrics text string.");
  }
  if (openMetricsText.trim() === "") {
    throw new Error("Comms relay /metrics payload is empty.");
  }

  const parsed: Partial<Record<CanonicalMetricField, number>> = {};
  let hasEofMarker = false;
  let sampleLineCount = 0;

  const lines = openMetricsText.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNumber = idx + 1;
    const trimmed = lines[idx].trim();
    if (trimmed === "") {
      continue;
    }

    if (trimmed.startsWith("#")) {
      if (trimmed === "# EOF") {
        hasEofMarker = true;
      }
      continue;
    }

    const match = OPENMETRICS_SAMPLE_RE.exec(trimmed);
    if (!match) {
      throw new Error(`Comms relay /metrics contains a malformed sample line at line ${lineNumber}.`);
    }

    const metricName = match[1];
    const valueToken = match[3];
    const timestampToken = match[4];

    if (timestampToken !== undefined && !NUMERIC_TOKEN_RE.test(timestampToken)) {
      throw new Error(
        `Comms relay /metrics contains an invalid sample timestamp at line ${lineNumber}.`,
      );
    }

    sampleLineCount += 1;
    const field = METRIC_NAME_TO_FIELD[metricName];
    if (!field) {
      // Still validate numeric syntax of unknown samples to reject garbage payloads.
      if (!NUMERIC_TOKEN_RE.test(valueToken) || !Number.isFinite(Number(valueToken))) {
        throw new Error(`Comms relay /metrics contains a non-numeric value at line ${lineNumber}.`);
      }
      continue;
    }

    const numericValue = parseOpenMetricsCounterOrGaugeValue(valueToken, lineNumber);
    if (parsed[field] !== undefined) {
      throw new Error(
        `Comms relay /metrics contains a duplicate sample for ${metricName} at line ${lineNumber}.`,
      );
    }
    parsed[field] = numericValue;
  }

  if (sampleLineCount === 0) {
    throw new Error("Comms relay /metrics payload contains no metric samples.");
  }

  for (const required of REQUIRED_METRIC_FIELDS) {
    if (parsed[required.field] === undefined) {
      throw new Error(
        `Comms relay /metrics payload is missing required metric: ${required.metricName}.`,
      );
    }
  }

  return {
    queuedEnvelopes: parsed.queuedEnvelopes!,
    activeMailboxes: parsed.activeMailboxes!,
    maxMailboxDepth: parsed.maxMailboxDepth!,
    uptimeSeconds: parsed.uptimeSeconds ?? null,
    envelopesAcceptedTotal: parsed.envelopesAcceptedTotal!,
    envelopesDuplicateTotal: parsed.envelopesDuplicateTotal ?? 0,
    envelopesDeliveredTotal: parsed.envelopesDeliveredTotal!,
    envelopesExpiredTotal: parsed.envelopesExpiredTotal!,
    envelopesRejectedTotal: parsed.envelopesRejectedTotal!,
    envelopesRateLimitedTotal: parsed.envelopesRateLimitedTotal!,
    inboxRequestsTotal: parsed.inboxRequestsTotal ?? 0,
    ackRejectedTotal: parsed.ackRejectedTotal ?? 0,
    hasEofMarker,
  };
}

/** Display rows for rendering Comms Relay status in console-desktop. */
export function commsRelayStatusRows(
  health: CommsRelayHealthView,
  metrics?: CommsRelayMetricsView | null,
): StatusRow[] {
  const rows: StatusRow[] = [
    { label: "Status", value: health.ok ? "Healthy" : "Unhealthy" },
    { label: "Version", value: health.version },
    { label: "Queued envelopes", value: String(metrics?.queuedEnvelopes ?? health.queuedEnvelopes) },
  ];

  if (metrics) {
    rows.push(
      { label: "Active mailboxes", value: String(metrics.activeMailboxes) },
      { label: "Max mailbox depth", value: String(metrics.maxMailboxDepth) },
      { label: "Accepted envelopes", value: String(metrics.envelopesAcceptedTotal) },
      { label: "Delivered envelopes", value: String(metrics.envelopesDeliveredTotal) },
      { label: "Expired envelopes", value: String(metrics.envelopesExpiredTotal) },
      { label: "Rejected envelopes", value: String(metrics.envelopesRejectedTotal) },
      { label: "Rate-limited envelopes", value: String(metrics.envelopesRateLimitedTotal) },
    );
  }

  return rows;
}
