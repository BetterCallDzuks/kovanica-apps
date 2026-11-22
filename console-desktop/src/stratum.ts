import type { StatusRow } from "./connection";

/** Default loopback observability health endpoint exposed by `kovanica-stratum`. */
export const DEFAULT_STRATUM_HEALTH_URL = "http://127.0.0.1:9100/health";

export const STRATUM_STORAGE_KEY = "kvnc.stratum.health_url.v1";

/** Exact JSON schema returned by `kovanica-stratum`'s `/health` endpoint. */
export interface StratumHealthSnapshot {
  status: string;
  uptimeSeconds: number;
  activeConnections: number;
  currentJobId: string | null;
  tlsEnabled: boolean;
  timestamp: string;
}

export type StratumTelemetryState =
  | { kind: "idle"; endpoint: string }
  | { kind: "loading"; endpoint: string }
  | { kind: "online"; endpoint: string; health: StratumHealthSnapshot }
  | { kind: "offline"; endpoint: string; error: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Validates and normalizes a configurable loopback Stratum `/health` URL.
 * Rejects non-HTTP(S) schemes and non-loopback hosts so telemetry queries
 * never leak outside the local machine.
 */
export function normalizeStratumHealthUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_STRATUM_HEALTH_URL;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid Stratum health URL (e.g. http://127.0.0.1:9100/health).");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Stratum health URL must use http:// or https://.");
  }

  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Stratum health endpoint must be a loopback address (127.0.0.1, localhost, or [::1]).");
  }

  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/health";
  }

  return parsed.toString();
}

/** Validates and parses the JSON body returned by `kovanica-stratum`'s `/health` endpoint. */
export function parseStratumHealth(payload: unknown): StratumHealthSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Stratum /health returned an invalid JSON object.");
  }
  const obj = payload as Record<string, unknown>;

  if (typeof obj.status !== "string" || obj.status.trim() === "") {
    throw new Error("Stratum /health payload is missing a valid status.");
  }
  if (typeof obj.uptime_seconds !== "number" || !Number.isFinite(obj.uptime_seconds) || obj.uptime_seconds < 0) {
    throw new Error("Stratum /health payload is missing a valid uptime_seconds.");
  }
  if (
    typeof obj.active_connections !== "number" ||
    !Number.isFinite(obj.active_connections) ||
    obj.active_connections < 0
  ) {
    throw new Error("Stratum /health payload is missing a valid active_connections.");
  }
  if (obj.current_job_id !== null && obj.current_job_id !== undefined && typeof obj.current_job_id !== "string") {
    throw new Error("Stratum /health payload has an invalid current_job_id.");
  }
  if (typeof obj.tls_enabled !== "boolean") {
    throw new Error("Stratum /health payload is missing a valid tls_enabled boolean.");
  }
  if (typeof obj.timestamp !== "string" || obj.timestamp.trim() === "") {
    throw new Error("Stratum /health payload is missing a valid timestamp.");
  }

  return {
    status: obj.status.trim(),
    uptimeSeconds: Math.floor(obj.uptime_seconds),
    activeConnections: Math.floor(obj.active_connections),
    currentJobId: typeof obj.current_job_id === "string" && obj.current_job_id.trim() !== ""
      ? obj.current_job_id.trim()
      : null,
    tlsEnabled: obj.tls_enabled,
    timestamp: obj.timestamp.trim(),
  };
}

/** Formats an uptime duration in seconds into a compact human-readable string. */
export function formatUptime(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const seconds = safe % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** Display rows for the Stratum Gateway Health & Telemetry panel. */
export function stratumHealthRows(health: StratumHealthSnapshot): StatusRow[] {
  return [
    { label: "Status", value: health.status },
    { label: "Uptime", value: `${formatUptime(health.uptimeSeconds)} (${health.uptimeSeconds}s)` },
    { label: "Active connections", value: String(health.activeConnections) },
    { label: "Current job ID", value: health.currentJobId ?? "None" },
    { label: "TLS", value: health.tlsEnabled ? "Enabled" : "Disabled" },
    { label: "Timestamp", value: health.timestamp },
  ];
}

export interface FetchStratumHealthOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Queries the configured loopback Stratum `/health` endpoint and validates the response. */
export async function fetchStratumHealth(
  endpoint: string,
  options: FetchStratumHealthOptions = {},
): Promise<StratumHealthSnapshot> {
  const url = normalizeStratumHealthUrl(endpoint);
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let signal = options.signal;

  if (!signal && typeof AbortController !== "undefined" && timeoutMs > 0) {
    controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller?.abort(), timeoutMs);
  }

  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Stratum gateway returned HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Stratum gateway did not return valid JSON.");
    }
    return parseStratumHealth(body);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Stratum gateway health request timed out.");
    }
    throw error instanceof Error
      ? error
      : new Error("Stratum gateway is offline or unreachable.");
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
