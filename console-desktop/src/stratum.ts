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

/** Per-worker session item returned by `kovanica-stratum`'s `/workers` endpoint. */
export interface StratumWorkerItem {
  session_id?: number;
  worker_name: string;
  authorized?: boolean;
  difficulty: number;
  shares_accepted: number;
  shares_rejected: number;
  connected_secs: number;
  idle_secs?: number;
}

/** Sanitized `/workers` payload returned by `kovanica-stratum`. */
export interface StratumWorkersReport {
  active_workers: number;
  vardiff_enabled: boolean;
  banned_ips?: number;
  workers: StratumWorkerItem[];
  timestamp?: number | string;
}

export type ConsoleStratumAlertSeverity = "critical" | "warning" | "info";

export interface ConsoleStratumAlert {
  id: string;
  severity: ConsoleStratumAlertSeverity;
  message: string;
}

export interface ConsoleStratumDiagnosticsInput {
  healthUrl: string;
  health: StratumHealthSnapshot | null;
  workers?: StratumWorkerItem[] | StratumWorkersReport | null;
  generatedAt?: string;
}

export interface ConsoleStratumDiagnosticsBundle {
  schemaVersion: 1;
  source: "console-desktop";
  generatedAt: string;
  healthUrl: string;
  alerts: ConsoleStratumAlert[];
  health: StratumHealthSnapshot | null;
  workers: {
    activeCount: number;
    bannedIps: number | null;
    workers: Array<{
      worker_name: string;
      difficulty: number;
      shares_accepted: number;
      shares_rejected: number;
      connected_secs: number;
      idle_secs?: number;
      authorized?: boolean;
    }>;
  };
}

export const CONSOLE_STRATUM_BAN_ALERT_THRESHOLD = 5;
export const CONSOLE_STRATUM_IDLE_WORKER_SECS = 300;

export type StratumTelemetryState =
  | { kind: "idle"; endpoint: string }
  | { kind: "loading"; endpoint: string }
  | {
      kind: "online";
      endpoint: string;
      health: StratumHealthSnapshot;
      workers: StratumWorkerItem[];
    }
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

/**
 * Derives the loopback Stratum `/workers` endpoint URL from a configured `/health` URL.
 * Validates the loopback address first and replaces `/health` with `/workers`.
 */
export function deriveStratumWorkersUrl(healthUrl: string): string {
  const normalized = normalizeStratumHealthUrl(healthUrl);
  const parsed = new URL(normalized);
  if (parsed.pathname.endsWith("/health")) {
    parsed.pathname = `${parsed.pathname.slice(0, -"/health".length)}/workers` || "/workers";
  } else {
    parsed.pathname = "/workers";
  }
  return parsed.toString();
}

/** Validates and parses the JSON body returned by `kovanica-stratum`'s `/workers` endpoint. */
export function parseStratumWorkers(raw: unknown): StratumWorkersReport {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("Stratum /workers returned invalid JSON.");
    }
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Stratum /workers returned an invalid JSON object.");
  }
  const obj = payload as Record<string, unknown>;

  if (!Array.isArray(obj.workers)) {
    throw new Error("Stratum /workers payload is missing a valid workers array.");
  }

  const workers: StratumWorkerItem[] = obj.workers.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Stratum /workers item at index ${idx} is not an object.`);
    }
    const item = entry as Record<string, unknown>;

    if (typeof item.worker_name !== "string" || item.worker_name.trim() === "") {
      throw new Error(`Stratum /workers item at index ${idx} is missing a valid worker_name.`);
    }
    if (typeof item.difficulty !== "number" || !Number.isFinite(item.difficulty) || item.difficulty < 0) {
      throw new Error(`Stratum /workers item at index ${idx} is missing a valid difficulty.`);
    }
    if (
      typeof item.shares_accepted !== "number" ||
      !Number.isFinite(item.shares_accepted) ||
      item.shares_accepted < 0
    ) {
      throw new Error(`Stratum /workers item at index ${idx} is missing a valid shares_accepted.`);
    }
    if (
      typeof item.shares_rejected !== "number" ||
      !Number.isFinite(item.shares_rejected) ||
      item.shares_rejected < 0
    ) {
      throw new Error(`Stratum /workers item at index ${idx} is missing a valid shares_rejected.`);
    }
    if (
      typeof item.connected_secs !== "number" ||
      !Number.isFinite(item.connected_secs) ||
      item.connected_secs < 0
    ) {
      throw new Error(`Stratum /workers item at index ${idx} is missing a valid connected_secs.`);
    }

    const parsedItem: StratumWorkerItem = {
      worker_name: item.worker_name.trim(),
      difficulty: item.difficulty,
      shares_accepted: Math.floor(item.shares_accepted),
      shares_rejected: Math.floor(item.shares_rejected),
      connected_secs: Math.floor(item.connected_secs),
    };

    if (item.session_id !== undefined) {
      if (typeof item.session_id !== "number" || !Number.isFinite(item.session_id) || item.session_id < 0) {
        throw new Error(`Stratum /workers item at index ${idx} has an invalid session_id.`);
      }
      parsedItem.session_id = Math.floor(item.session_id);
    }

    if (item.authorized !== undefined) {
      if (typeof item.authorized !== "boolean") {
        throw new Error(`Stratum /workers item at index ${idx} has an invalid authorized flag.`);
      }
      parsedItem.authorized = item.authorized;
    }

    if (item.idle_secs !== undefined) {
      if (typeof item.idle_secs !== "number" || !Number.isFinite(item.idle_secs) || item.idle_secs < 0) {
        throw new Error(`Stratum /workers item at index ${idx} has an invalid idle_secs.`);
      }
      parsedItem.idle_secs = Math.floor(item.idle_secs);
    }

    return parsedItem;
  });

  let activeWorkers = workers.length;
  if (obj.active_workers !== undefined) {
    if (
      typeof obj.active_workers !== "number" ||
      !Number.isFinite(obj.active_workers) ||
      obj.active_workers < 0
    ) {
      throw new Error("Stratum /workers payload has an invalid active_workers count.");
    }
    activeWorkers = Math.floor(obj.active_workers);
  }

  let vardiffEnabled = false;
  if (obj.vardiff_enabled !== undefined) {
    if (typeof obj.vardiff_enabled !== "boolean") {
      throw new Error("Stratum /workers payload has an invalid vardiff_enabled boolean.");
    }
    vardiffEnabled = obj.vardiff_enabled;
  }

  const report: StratumWorkersReport = {
    active_workers: activeWorkers,
    vardiff_enabled: vardiffEnabled,
    workers,
  };

  if (obj.banned_ips !== undefined) {
    if (typeof obj.banned_ips !== "number" || !Number.isFinite(obj.banned_ips) || obj.banned_ips < 0) {
      throw new Error("Stratum /workers payload has an invalid banned_ips count.");
    }
    report.banned_ips = Math.floor(obj.banned_ips);
  }

  if (obj.timestamp !== undefined) {
    if (
      (typeof obj.timestamp === "number" && Number.isFinite(obj.timestamp) && obj.timestamp >= 0) ||
      (typeof obj.timestamp === "string" && obj.timestamp.trim() !== "")
    ) {
      report.timestamp = typeof obj.timestamp === "string" ? obj.timestamp.trim() : Math.floor(obj.timestamp);
    } else {
      throw new Error("Stratum /workers payload has an invalid timestamp.");
    }
  }

  return report;
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

function unwrapWorkers(
  workers: StratumWorkerItem[] | StratumWorkersReport | null | undefined,
): { list: StratumWorkerItem[]; bannedIps: number | null } {
  if (!workers) return { list: [], bannedIps: null };
  if (Array.isArray(workers)) return { list: workers, bannedIps: null };
  return {
    list: workers.workers,
    bannedIps: typeof workers.banned_ips === "number" ? workers.banned_ips : null,
  };
}

/**
 * Evaluates actionable operator alerts for the console-desktop Stratum telemetry panel.
 * Ordered by severity (critical -> warning -> info).
 */
export function evaluateConsoleStratumAlerts(
  health: StratumHealthSnapshot | null | undefined,
  workers?: StratumWorkerItem[] | StratumWorkersReport | null,
): ConsoleStratumAlert[] {
  const alerts: ConsoleStratumAlert[] = [];
  const { list, bannedIps } = unwrapWorkers(workers);

  if (health) {
    const normalizedStatus = health.status.trim().toLowerCase();
    if (normalizedStatus !== "healthy" && normalizedStatus !== "ok") {
      alerts.push({
        id: "gateway-unhealthy",
        severity: "critical",
        message: `Stratum gateway reported non-healthy status: ${health.status}.`,
      });
    }
  }

  if (bannedIps !== null && bannedIps >= CONSOLE_STRATUM_BAN_ALERT_THRESHOLD) {
    alerts.push({
      id: "high-ip-bans",
      severity: "warning",
      message: `High active IP bans: ${bannedIps} IPs are currently banned.`,
    });
  }

  const hasConnectedWorkers =
    list.length > 0 || (health !== null && health !== undefined && health.activeConnections > 0);
  if (health && hasConnectedWorkers && health.currentJobId === null) {
    alerts.push({
      id: "no-current-job",
      severity: "warning",
      message:
        "Workers are connected but no active mining job is assigned (currentJobId is null).",
    });
  }

  const idleWorkers = list.filter(
    (w) =>
      typeof w.idle_secs === "number" &&
      Number.isFinite(w.idle_secs) &&
      w.idle_secs >= CONSOLE_STRATUM_IDLE_WORKER_SECS,
  );
  if (idleWorkers.length > 0) {
    const names = idleWorkers.map((w) => w.worker_name).join(", ");
    alerts.push({
      id: "idle-workers",
      severity: "info",
      message: `${idleWorkers.length} idle worker${idleWorkers.length === 1 ? "" : "s"} (>= ${CONSOLE_STRATUM_IDLE_WORKER_SECS}s): ${names}.`,
    });
  }

  return alerts;
}

/**
 * Builds a sanitized, loopback-only JSON-serializable diagnostics bundle
 * for console-desktop Stratum telemetry. Rejects non-loopback URLs and strips
 * any URL credentials, query parameters, or fragments.
 */
export function buildConsoleStratumDiagnostics(
  input: ConsoleStratumDiagnosticsInput,
): ConsoleStratumDiagnosticsBundle {
  const normalizedUrl = normalizeStratumHealthUrl(input.healthUrl);
  const parsed = new URL(normalizedUrl);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const sanitizedHealthUrl = parsed.toString();

  const { list, bannedIps } = unwrapWorkers(input.workers);
  const alerts = evaluateConsoleStratumAlerts(input.health, input.workers);

  return {
    schemaVersion: 1,
    source: "console-desktop",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    healthUrl: sanitizedHealthUrl,
    alerts,
    health: input.health
      ? {
          status: input.health.status,
          uptimeSeconds: input.health.uptimeSeconds,
          activeConnections: input.health.activeConnections,
          currentJobId: input.health.currentJobId,
          tlsEnabled: input.health.tlsEnabled,
          timestamp: input.health.timestamp,
        }
      : null,
    workers: {
      activeCount: list.length,
      bannedIps,
      workers: list.map((w) => ({
        worker_name: w.worker_name,
        difficulty: w.difficulty,
        shares_accepted: w.shares_accepted,
        shares_rejected: w.shares_rejected,
        connected_secs: w.connected_secs,
        ...(w.idle_secs !== undefined ? { idle_secs: w.idle_secs } : {}),
        ...(w.authorized !== undefined ? { authorized: w.authorized } : {}),
      })),
    },
  };
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

/**
 * Queries the loopback Stratum `/workers` endpoint derived from `healthUrl`
 * and validates the returned worker session report.
 */
export async function fetchStratumWorkers(
  healthUrl: string,
  fetchImplOrOptions?: typeof fetch | FetchStratumHealthOptions,
): Promise<StratumWorkersReport> {
  const url = deriveStratumWorkersUrl(healthUrl);
  const options: FetchStratumHealthOptions =
    typeof fetchImplOrOptions === "function"
      ? { fetchImpl: fetchImplOrOptions }
      : (fetchImplOrOptions ?? {});
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
      throw new Error(`Stratum gateway /workers returned HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Stratum gateway /workers did not return valid JSON.");
    }
    return parseStratumWorkers(body);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Stratum gateway /workers request timed out.");
    }
    throw error instanceof Error
      ? error
      : new Error("Stratum gateway /workers endpoint is offline or unreachable.");
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
