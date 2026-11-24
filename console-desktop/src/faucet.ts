import { formatKunaAtoms } from "./amount";
import type { StatusRow } from "./connection";

/** Default loopback base URL for `kovanica-faucet`. */
export const DEFAULT_FAUCET_URL = "http://127.0.0.1:8080";

/** Clean typed view of `kovanica-faucet`'s `GET /metrics` OpenMetrics 1.0 exposition. */
export interface FaucetMetricsView {
  requestsTotal: number;
  dripsSucceededTotal: number;
  dispensedAtomsTotal: bigint;
  dripsRejectedTotal: number;
  rateLimitedTotal: number;
  ipRateLimitedTotal: number;
  addressCooldownHitsTotal: number;
  invalidAddressTotal: number;
  lowBalanceRejectedTotal: number;
  rpcErrorsTotal: number;
  balanceAtoms: bigint;
  activeIpEntries: number | null;
  activeAddressCooldowns: number | null;
  uptimeSeconds: number | null;
  hasEofMarker: boolean;
}

type NumberMetricField =
  | "requestsTotal"
  | "dripsSucceededTotal"
  | "dripsRejectedTotal"
  | "rateLimitedTotal"
  | "ipRateLimitedTotal"
  | "addressCooldownHitsTotal"
  | "invalidAddressTotal"
  | "lowBalanceRejectedTotal"
  | "rpcErrorsTotal"
  | "activeIpEntries"
  | "activeAddressCooldowns"
  | "uptimeSeconds";

type BigIntMetricField = "dispensedAtomsTotal" | "balanceAtoms";

type CanonicalMetricField = NumberMetricField | BigIntMetricField;

interface MetricMapping {
  field: CanonicalMetricField;
  kind: "number" | "bigint";
  legacy?: boolean;
}

/**
 * Maps OpenMetrics 1.0 metric names emitted by `kovanica-faucet/src/main.rs`
 * (including legacy `faucet_*` compatibility aliases emitted alongside the
 * canonical `kovanica_faucet_*` series) to typed `FaucetMetricsView` fields.
 */
const METRIC_NAME_TO_MAPPING: Readonly<Record<string, MetricMapping>> = {
  // Canonical counters (`kovanica-faucet/src/main.rs`)
  kovanica_faucet_requests_total: { field: "requestsTotal", kind: "number" },
  kovanica_faucet_drips_succeeded_total: { field: "dripsSucceededTotal", kind: "number" },
  kovanica_faucet_dispensed_atoms_total: { field: "dispensedAtomsTotal", kind: "bigint" },
  kovanica_faucet_drips_rejected_total: { field: "dripsRejectedTotal", kind: "number" },
  kovanica_faucet_rate_limited_total: { field: "rateLimitedTotal", kind: "number" },
  kovanica_faucet_ip_rate_limited_total: { field: "ipRateLimitedTotal", kind: "number" },
  kovanica_faucet_address_cooldown_hits_total: {
    field: "addressCooldownHitsTotal",
    kind: "number",
  },
  kovanica_faucet_invalid_address_total: { field: "invalidAddressTotal", kind: "number" },
  kovanica_faucet_low_balance_rejected_total: {
    field: "lowBalanceRejectedTotal",
    kind: "number",
  },
  kovanica_faucet_rpc_errors_total: { field: "rpcErrorsTotal", kind: "number" },
  // Canonical gauges (`kovanica-faucet/src/main.rs`)
  kovanica_faucet_balance_atoms: { field: "balanceAtoms", kind: "bigint" },
  kovanica_faucet_active_ip_entries: { field: "activeIpEntries", kind: "number" },
  kovanica_faucet_active_address_cooldowns: {
    field: "activeAddressCooldowns",
    kind: "number",
  },
  kovanica_faucet_uptime_seconds: { field: "uptimeSeconds", kind: "number" },
  // Legacy aliases emitted in the same exposition by `kovanica-faucet/src/main.rs`
  faucet_drips_succeeded_total: { field: "dripsSucceededTotal", kind: "number", legacy: true },
  faucet_drips_rejected_total: { field: "dripsRejectedTotal", kind: "number", legacy: true },
  faucet_rate_limited_total: { field: "rateLimitedTotal", kind: "number", legacy: true },
  faucet_balance_atoms: { field: "balanceAtoms", kind: "bigint", legacy: true },
};

const REQUIRED_METRIC_FIELDS: ReadonlyArray<{
  field: CanonicalMetricField;
  metricName: string;
}> = [
  { field: "requestsTotal", metricName: "kovanica_faucet_requests_total" },
  { field: "dripsSucceededTotal", metricName: "kovanica_faucet_drips_succeeded_total" },
  { field: "dispensedAtomsTotal", metricName: "kovanica_faucet_dispensed_atoms_total" },
  { field: "dripsRejectedTotal", metricName: "kovanica_faucet_drips_rejected_total" },
  { field: "rateLimitedTotal", metricName: "kovanica_faucet_rate_limited_total" },
  { field: "balanceAtoms", metricName: "kovanica_faucet_balance_atoms" },
];

const MAX_U64 = 18446744073709551615n;

/**
 * Matches an OpenMetrics 1.0 sample line:
 *   `<metric_name>[{label="val",...}] <value>[ <timestamp>][ # <exemplar>]`
 */
const OPENMETRICS_SAMPLE_RE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?[ \t]+([^\s#]+)(?:[ \t]+([^\s#]+))?(?:[ \t]+#.*)?$/;

const NUMERIC_TOKEN_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const UNSIGNED_INT_TOKEN_RE = /^\d+$/;

function parseOpenMetricsSafeInteger(rawToken: string, lineNumber: number): number {
  if (!NUMERIC_TOKEN_RE.test(rawToken)) {
    throw new Error(`Faucet /metrics contains a non-numeric value at line ${lineNumber}.`);
  }
  const value = Number(rawToken);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error(`Faucet /metrics contains an invalid metric value at line ${lineNumber}.`);
  }
  return value;
}

function parseOpenMetricsAtoms(rawToken: string, lineNumber: number): bigint {
  if (!NUMERIC_TOKEN_RE.test(rawToken)) {
    throw new Error(`Faucet /metrics contains a non-numeric value at line ${lineNumber}.`);
  }
  if (!UNSIGNED_INT_TOKEN_RE.test(rawToken)) {
    throw new Error(`Faucet /metrics contains an invalid atom value at line ${lineNumber}.`);
  }
  const value = BigInt(rawToken);
  if (value < 0n || value > MAX_U64) {
    throw new Error(`Faucet /metrics contains an out-of-range atom value at line ${lineNumber}.`);
  }
  return value;
}

/**
 * Strictly parses `kovanica-faucet`'s `GET /metrics` OpenMetrics 1.0 text exposition
 * into a typed status view.
 *
 * Validates line syntax, rejects malformed/negative/non-integer/duplicate samples,
 * requires core faucet counters and balance gauge, tolerates legacy `faucet_*` aliases
 * emitted in the same exposition, and never echoes raw input in error messages.
 */
export function parseFaucetMetrics(openMetricsText: unknown): FaucetMetricsView {
  if (typeof openMetricsText !== "string") {
    throw new Error("Faucet /metrics payload must be an OpenMetrics text string.");
  }
  if (openMetricsText.trim() === "") {
    throw new Error("Faucet /metrics payload is empty.");
  }

  const parsedNumbers: Partial<Record<NumberMetricField, number>> = {};
  const parsedBigInts: Partial<Record<BigIntMetricField, bigint>> = {};
  const canonicalFieldsSet = new Set<CanonicalMetricField>();
  const seenMetricNames = new Set<string>();
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
      throw new Error(`Faucet /metrics contains a malformed sample line at line ${lineNumber}.`);
    }

    const metricName = match[1];
    const valueToken = match[3];
    const timestampToken = match[4];

    if (timestampToken !== undefined && !NUMERIC_TOKEN_RE.test(timestampToken)) {
      throw new Error(`Faucet /metrics contains an invalid sample timestamp at line ${lineNumber}.`);
    }

    sampleLineCount += 1;
    const mapping = METRIC_NAME_TO_MAPPING[metricName];
    if (!mapping) {
      if (!NUMERIC_TOKEN_RE.test(valueToken) || !Number.isFinite(Number(valueToken))) {
        throw new Error(`Faucet /metrics contains a non-numeric value at line ${lineNumber}.`);
      }
      continue;
    }

    if (seenMetricNames.has(metricName)) {
      throw new Error(
        `Faucet /metrics contains a duplicate sample for ${metricName} at line ${lineNumber}.`,
      );
    }
    seenMetricNames.add(metricName);

    if (mapping.kind === "bigint") {
      const atomValue = parseOpenMetricsAtoms(valueToken, lineNumber);
      const field = mapping.field as BigIntMetricField;
      if (!mapping.legacy || !canonicalFieldsSet.has(field)) {
        parsedBigInts[field] = atomValue;
        if (!mapping.legacy) {
          canonicalFieldsSet.add(field);
        }
      }
    } else {
      const numericValue = parseOpenMetricsSafeInteger(valueToken, lineNumber);
      const field = mapping.field as NumberMetricField;
      if (!mapping.legacy || !canonicalFieldsSet.has(field)) {
        parsedNumbers[field] = numericValue;
        if (!mapping.legacy) {
          canonicalFieldsSet.add(field);
        }
      }
    }
  }

  if (sampleLineCount === 0) {
    throw new Error("Faucet /metrics payload contains no metric samples.");
  }

  for (const required of REQUIRED_METRIC_FIELDS) {
    const present =
      required.field === "dispensedAtomsTotal" || required.field === "balanceAtoms"
        ? parsedBigInts[required.field] !== undefined
        : parsedNumbers[required.field] !== undefined;
    if (!present) {
      throw new Error(
        `Faucet /metrics payload is missing required metric: ${required.metricName}.`,
      );
    }
  }

  return {
    requestsTotal: parsedNumbers.requestsTotal!,
    dripsSucceededTotal: parsedNumbers.dripsSucceededTotal!,
    dispensedAtomsTotal: parsedBigInts.dispensedAtomsTotal!,
    dripsRejectedTotal: parsedNumbers.dripsRejectedTotal!,
    rateLimitedTotal: parsedNumbers.rateLimitedTotal!,
    ipRateLimitedTotal: parsedNumbers.ipRateLimitedTotal ?? 0,
    addressCooldownHitsTotal: parsedNumbers.addressCooldownHitsTotal ?? 0,
    invalidAddressTotal: parsedNumbers.invalidAddressTotal ?? 0,
    lowBalanceRejectedTotal: parsedNumbers.lowBalanceRejectedTotal ?? 0,
    rpcErrorsTotal: parsedNumbers.rpcErrorsTotal ?? 0,
    balanceAtoms: parsedBigInts.balanceAtoms!,
    activeIpEntries: parsedNumbers.activeIpEntries ?? null,
    activeAddressCooldowns: parsedNumbers.activeAddressCooldowns ?? null,
    uptimeSeconds: parsedNumbers.uptimeSeconds ?? null,
    hasEofMarker,
  };
}

/** Display rows for rendering Faucet OpenMetrics status in console-desktop. */
export function faucetMetricsStatusRows(metrics: FaucetMetricsView): StatusRow[] {
  const rows: StatusRow[] = [
    { label: "Faucet balance", value: `${formatKunaAtoms(metrics.balanceAtoms)} KVNC` },
    { label: "Total requests", value: String(metrics.requestsTotal) },
    { label: "Drips succeeded", value: String(metrics.dripsSucceededTotal) },
    { label: "Dispensed total", value: `${formatKunaAtoms(metrics.dispensedAtomsTotal)} KVNC` },
    { label: "Drips rejected", value: String(metrics.dripsRejectedTotal) },
    { label: "Rate-limited", value: String(metrics.rateLimitedTotal) },
    { label: "Address cooldown hits", value: String(metrics.addressCooldownHitsTotal) },
  ];

  if (metrics.activeAddressCooldowns !== null) {
    rows.push({
      label: "Active address cooldowns",
      value: String(metrics.activeAddressCooldowns),
    });
  }

  if (metrics.uptimeSeconds !== null) {
    rows.push({ label: "Uptime", value: `${metrics.uptimeSeconds}s` });
  }

  return rows;
}
