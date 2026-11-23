import { fieldText, type Field } from "./format.ts";
import type { AppHost } from "./ui.ts";

export type StratumProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "exited";

export interface StratumFormInput {
  binary: string;
  bindHost: string;
  bindPort: string;
  rpcUrl: string;
  metricsAddr: string;
  chainId: string;
  difficulty: string;
  tlsEnabled: boolean;
  tlsCertPath: string;
  tlsKeyPath: string;
  tlsSelfSigned: boolean;
  vardiffEnabled?: boolean;
  vardiffMinDifficulty?: string;
  vardiffMaxDifficulty?: string;
  vardiffTargetShareSecs?: string;
  banThresholdInvalidShares?: string;
  banDurationSecs?: string;
}

export interface StratumConfigPayload {
  binary: string;
  bindHost: string;
  bindPort: number;
  rpcUrl: string;
  metricsAddr: string;
  chainId: number;
  difficulty: number;
  tlsEnabled: boolean;
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  tlsSelfSigned: boolean;
  vardiffEnabled: boolean;
  vardiffMinDifficulty: number | null;
  vardiffMaxDifficulty: number | null;
  vardiffTargetShareSecs: number | null;
  banThresholdInvalidShares: number | null;
  banDurationSecs: number | null;
}

export interface CheckedStratumConfig extends StratumConfigPayload {
  binarySha256: string;
  listenAddr: string;
  healthUrl: string;
  workersUrl?: string;
}

export interface StratumWorkerEntry {
  workerName: string;
  difficulty: number;
  sharesAccepted: number;
  sharesRejected: number;
  connectedSecs: number;
  extranonceSubscribed: boolean;
  idleSecs?: number;
}

export type StratumAlertSeverity = "critical" | "warning" | "info";

export interface StratumAlert {
  id: string;
  severity: StratumAlertSeverity;
  message: string;
}

export interface StratumDiagnosticsInput {
  status: StratumProcessStatus | null;
  health: StratumHealthView | null;
  workers?: StratumWorkersSnapshot | null;
  logs?: string[];
  config?: CheckedStratumConfig | null;
  generatedAt?: string;
}

export interface SanitizedStratumDiagnostics {
  schemaVersion: 1;
  source: "node-desktop";
  generatedAt: string;
  alerts: StratumAlert[];
  status: {
    state: StratumProcessState;
    pid: number | null;
    exitCode: number | null;
    lastError: string | null;
    statusSeq: number;
  } | null;
  health: {
    reach: "unknown" | "reachable" | "unreachable";
    status: string;
    uptimeSeconds: string;
    activeConnections: string;
    currentJobId: string | null;
    tlsEnabled: string;
    timestamp: string;
    detail: string | null;
  } | null;
  workers: {
    reach: "unknown" | "reachable" | "unreachable";
    activeCount: number;
    bannedIps: number;
    detail: string | null;
    workers: StratumWorkerEntry[];
  } | null;
  config?: {
    listenAddr: string;
    bindHost: string;
    bindPort: number;
    rpcUrl: string;
    metricsAddr: string;
    healthUrl: string;
    chainId: number;
    difficulty: number;
    tlsEnabled: boolean;
    tlsSelfSigned: boolean;
    vardiffEnabled: boolean;
    vardiffMinDifficulty: number | null;
    vardiffMaxDifficulty: number | null;
    vardiffTargetShareSecs: number | null;
    banThresholdInvalidShares: number | null;
    banDurationSecs: number | null;
    binarySha256: string;
  } | null;
  logs: string[];
}

export interface MountStratumOptions {
  copyText?: (text: string) => Promise<void>;
  exportFile?: (filename: string, content: string) => void;
}

export const STRATUM_DIAGNOSTICS_MAX_LOGS = 200;
export const STRATUM_BAN_ALERT_THRESHOLD = 5;
export const STRATUM_IDLE_WORKER_SECS = 300;

export interface StratumWorkersSnapshot {
  reach: "unknown" | "reachable" | "unreachable";
  workers: StratumWorkerEntry[];
  bannedIps: number;
  detail: string | null;
}

export interface StratumProcessStatus {
  state: StratumProcessState;
  pid: number | null;
  exitCode: number | null;
  lastError: string | null;
  logs: string[];
  statusSeq: number;
}

export interface StratumHealthView {
  reach: "unknown" | "reachable" | "unreachable";
  status: Field;
  uptimeSeconds: Field;
  activeConnections: Field;
  currentJobId: Field;
  tlsEnabled: Field;
  timestamp: Field;
  detail: string | null;
}

export interface StratumSnapshot {
  process: StratumProcessStatus;
  health: StratumHealthView;
  healthSeq: number;
  workers?: StratumWorkersSnapshot;
  config: CheckedStratumConfig | null;
  stopGraceSecs: number;
}

interface TextEl {
  hidden: boolean;
  textContent: string;
  dataset?: Record<string, string | undefined>;
}

interface InputEl {
  value: string;
  disabled?: boolean;
  focus(): void;
  addEventListener(type: string, listener: () => void): void;
}

interface CheckboxEl {
  checked: boolean;
  disabled?: boolean;
  addEventListener(type: string, listener: () => void): void;
}

interface ButtonEl {
  disabled: boolean;
  focus(): void;
  addEventListener(type: string, listener: () => void): void;
}

interface ReadoutEl {
  replaceChildren(): void;
  append(...nodes: Array<{ textContent: string }>): void;
  scrollTop: number;
  scrollHeight: number;
  textContent: string;
}

interface AlertBannerEl {
  hidden: boolean;
  dataset?: Record<string, string | undefined>;
  replaceChildren(): void;
  append(...nodes: Array<{ textContent: string }>): void;
}

function sanitizeDiagnosticText(input: string): string {
  return input
    .replace(
      /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
      "[REDACTED_PEM_BLOCK]",
    )
    .replace(
      /(--tls-(?:cert|key)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED_PEM_PATH]",
    )
    .replace(
      /(?:[A-Za-z]:\\|\/)[^\s"'`]+\.(?:pem|key|crt|p12|pfx)\b/gi,
      "[REDACTED_PEM_PATH]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:token|secret|password|passwd|api[_-]?key|auth[_-]?token|private[_-]?key|rpc[_-]?token|bearer|tls[_-]?cert[_-]?path|tls[_-]?key[_-]?path)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, "$1[REDACTED]@");
}

function sanitizeUrlForDiagnostics(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return sanitizeDiagnosticText(raw);
  }
}

function extractNullableFieldValue(field: Field | null | undefined): string | null {
  if (!field || field.kind !== "value") return null;
  if (field.value === undefined || field.value === null) return null;
  const trimmed = field.value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "null") {
    return null;
  }
  return trimmed;
}

/**
 * Evaluates actionable operator alerts from the current Stratum process,
 * health endpoint, and workers snapshot. Ordered by severity (critical -> warning -> info).
 */
export function evaluateStratumAlerts(
  status: StratumProcessStatus | null | undefined,
  health: StratumHealthView | null | undefined,
  workers: StratumWorkersSnapshot | null | undefined,
): StratumAlert[] {
  const alerts: StratumAlert[] = [];

  if (
    status &&
    (status.state === "exited" || status.state === "stopped") &&
    status.exitCode !== null &&
    status.exitCode !== 0
  ) {
    const suffix = status.lastError ? `: ${sanitizeDiagnosticText(status.lastError)}` : ".";
    alerts.push({
      id: "stratum-crashed",
      severity: "critical",
      message: `Stratum gateway exited with non-zero code ${status.exitCode}${suffix}`,
    });
  }

  if (
    workers &&
    workers.reach !== "unreachable" &&
    typeof workers.bannedIps === "number" &&
    workers.bannedIps >= STRATUM_BAN_ALERT_THRESHOLD
  ) {
    alerts.push({
      id: "high-ip-bans",
      severity: "warning",
      message: `High active IP bans: ${workers.bannedIps} IPs are currently banned.`,
    });
  }

  const workersFromList =
    workers && workers.reach !== "unreachable" ? workers.workers.length : 0;
  const activeConnsFromHealth =
    health &&
    health.reach === "reachable" &&
    health.activeConnections.kind === "value" &&
    Number.isFinite(Number(health.activeConnections.value))
      ? Number(health.activeConnections.value)
      : 0;
  const hasConnectedWorkers = workersFromList > 0 || activeConnsFromHealth > 0;
  const currentJobId =
    health && health.reach === "reachable"
      ? extractNullableFieldValue(health.currentJobId)
      : undefined;

  if (hasConnectedWorkers && health && health.reach === "reachable" && currentJobId === null) {
    alerts.push({
      id: "no-current-job",
      severity: "warning",
      message:
        "Workers are connected but no active mining job is assigned (currentJobId is null).",
    });
  }

  if (workers && workers.reach !== "unreachable") {
    const idleWorkers = workers.workers.filter(
      (entry) =>
        typeof entry.idleSecs === "number" &&
        Number.isFinite(entry.idleSecs) &&
        entry.idleSecs >= STRATUM_IDLE_WORKER_SECS,
    );
    if (idleWorkers.length > 0) {
      const names = idleWorkers.map((entry) => entry.workerName).join(", ");
      alerts.push({
        id: "idle-workers",
        severity: "info",
        message: `${idleWorkers.length} idle worker${idleWorkers.length === 1 ? "" : "s"} (>= ${STRATUM_IDLE_WORKER_SECS}s): ${names}.`,
      });
    }
  }

  return alerts;
}

/**
 * Builds a sanitized, JSON-serializable Stratum diagnostics bundle.
 * Explicitly omits PEM file paths, redacts tokens/secrets, and retains
 * at most the last 200 log lines.
 */
export function buildSanitizedStratumDiagnostics(
  input: StratumDiagnosticsInput,
): SanitizedStratumDiagnostics {
  const rawLogs = input.logs ?? input.status?.logs ?? [];
  const logs = rawLogs.slice(-STRATUM_DIAGNOSTICS_MAX_LOGS).map(sanitizeDiagnosticText);
  const alerts = evaluateStratumAlerts(input.status, input.health, input.workers);

  const sanitizedStatus = input.status
    ? {
        state: input.status.state,
        pid: input.status.pid,
        exitCode: input.status.exitCode,
        lastError: input.status.lastError ? sanitizeDiagnosticText(input.status.lastError) : null,
        statusSeq: input.status.statusSeq,
      }
    : null;

  const sanitizedHealth = input.health
    ? {
        reach: input.health.reach,
        status: fieldText(input.health.status),
        uptimeSeconds: fieldText(input.health.uptimeSeconds),
        activeConnections: fieldText(input.health.activeConnections),
        currentJobId: extractNullableFieldValue(input.health.currentJobId),
        tlsEnabled: fieldText(input.health.tlsEnabled),
        timestamp: fieldText(input.health.timestamp),
        detail: input.health.detail ? sanitizeDiagnosticText(input.health.detail) : null,
      }
    : null;

  const sanitizedWorkers = input.workers
    ? {
        reach: input.workers.reach,
        activeCount: input.workers.workers.length,
        bannedIps: input.workers.bannedIps,
        detail: input.workers.detail ? sanitizeDiagnosticText(input.workers.detail) : null,
        workers: input.workers.workers.map((entry) => ({
          workerName: entry.workerName,
          difficulty: entry.difficulty,
          sharesAccepted: entry.sharesAccepted,
          sharesRejected: entry.sharesRejected,
          connectedSecs: entry.connectedSecs,
          extranonceSubscribed: entry.extranonceSubscribed,
          ...(entry.idleSecs !== undefined ? { idleSecs: entry.idleSecs } : {}),
        })),
      }
    : null;

  const bundle: SanitizedStratumDiagnostics = {
    schemaVersion: 1,
    source: "node-desktop",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    alerts,
    status: sanitizedStatus,
    health: sanitizedHealth,
    workers: sanitizedWorkers,
    logs,
  };

  if (input.config !== undefined) {
    bundle.config = input.config
      ? {
          listenAddr: input.config.listenAddr,
          bindHost: input.config.bindHost,
          bindPort: input.config.bindPort,
          rpcUrl: sanitizeUrlForDiagnostics(input.config.rpcUrl),
          metricsAddr: input.config.metricsAddr,
          healthUrl: sanitizeUrlForDiagnostics(input.config.healthUrl),
          chainId: input.config.chainId,
          difficulty: input.config.difficulty,
          tlsEnabled: input.config.tlsEnabled,
          tlsSelfSigned: input.config.tlsSelfSigned,
          vardiffEnabled: input.config.vardiffEnabled,
          vardiffMinDifficulty: input.config.vardiffMinDifficulty,
          vardiffMaxDifficulty: input.config.vardiffMaxDifficulty,
          vardiffTargetShareSecs: input.config.vardiffTargetShareSecs,
          banThresholdInvalidShares: input.config.banThresholdInvalidShares,
          banDurationSecs: input.config.banDurationSecs,
          binarySha256: input.config.binarySha256,
        }
      : null;
  }

  return bundle;
}

export interface StratumRpcProbeResult {
  url: string;
  ok: boolean;
  chainId: string | null;
  latencyMs: number;
  error: string | null;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Probes an upstream Kovanica node RPC endpoint via `kovanica_chainId` to verify
 * reachability and round-trip latency before starting the Stratum gateway.
 */
export async function probeStratumUpstreamRpc(
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<StratumRpcProbeResult> {
  const trimmed = rpcUrl.trim();
  const safeUrl = sanitizeUrlForDiagnostics(trimmed);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      url: safeUrl,
      ok: false,
      chainId: null,
      latencyMs: 0,
      error: "Upstream node RPC URL must be a valid http:// or https:// URL.",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      url: safeUrl,
      ok: false,
      chainId: null,
      latencyMs: 0,
      error: "Upstream node RPC URL must start with http:// or https://.",
    };
  }

  const fetchFn = fetchImpl ?? fetch;
  const start = nowMs();
  try {
    const response = await fetchFn(trimmed, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "kovanica_chainId",
        params: [],
      }),
    });
    const latencyMs = Math.max(0, Math.round(nowMs() - start));

    if (!response.ok) {
      return {
        url: safeUrl,
        ok: false,
        chainId: null,
        latencyMs,
        error: sanitizeDiagnosticText(`HTTP ${response.status}`),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        url: safeUrl,
        ok: false,
        chainId: null,
        latencyMs,
        error: "Invalid JSON-RPC response.",
      };
    }

    if (!body || typeof body !== "object") {
      return {
        url: safeUrl,
        ok: false,
        chainId: null,
        latencyMs,
        error: "Invalid JSON-RPC response.",
      };
    }

    const record = body as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };

    if (record.error) {
      const errMsg =
        typeof record.error.message === "string" && record.error.message.trim() !== ""
          ? record.error.message
          : `RPC error ${String(record.error.code ?? "unknown")}`;
      return {
        url: safeUrl,
        ok: false,
        chainId: null,
        latencyMs,
        error: sanitizeDiagnosticText(errMsg),
      };
    }

    if (record.result === undefined || record.result === null || String(record.result).trim() === "") {
      return {
        url: safeUrl,
        ok: false,
        chainId: null,
        latencyMs,
        error: "Missing chainId result.",
      };
    }

    return {
      url: safeUrl,
      ok: true,
      chainId: String(record.result),
      latencyMs,
      error: null,
    };
  } catch (err) {
    const latencyMs = Math.max(0, Math.round(nowMs() - start));
    const rawMessage = err instanceof Error ? err.message : String(err);
    return {
      url: safeUrl,
      ok: false,
      chainId: null,
      latencyMs,
      error: sanitizeDiagnosticText(rawMessage || "Request failed."),
    };
  }
}

/** Formats a Stratum upstream RPC probe result into a concise operator status line. */
export function formatRpcProbeResult(probe: StratumRpcProbeResult): string {
  const safeUrl = sanitizeUrlForDiagnostics(probe.url);
  if (probe.ok) {
    return `Upstream RPC reachable (${safeUrl}) · chainId=${probe.chainId ?? "unknown"} · ${probe.latencyMs}ms`;
  }
  const safeError = probe.error ? sanitizeDiagnosticText(probe.error) : "unknown error";
  return `Upstream RPC unreachable (${safeUrl}) · ${probe.latencyMs}ms · ${safeError}`;
}

export function validateStratumForm(input: StratumFormInput): string | null {
  if (input.binary.trim() === "") {
    return "Enter the absolute path to the kovanica-stratum executable.";
  }
  if (input.bindHost.trim() === "") {
    return "Enter a Stratum bind host (for example 127.0.0.1 or 0.0.0.0).";
  }
  const port = Number(input.bindPort.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Stratum bind port must be an integer between 1 and 65535.";
  }
  const rpcUrl = input.rpcUrl.trim();
  if (!rpcUrl.startsWith("http://") && !rpcUrl.startsWith("https://")) {
    return "Upstream node RPC URL must start with http:// or https://.";
  }
  if (input.metricsAddr.trim() === "") {
    return "Enter a loopback metrics/health bind address (for example 127.0.0.1:9090).";
  }
  const chainId = Number(input.chainId.trim());
  if (!Number.isInteger(chainId) || ![1, 2, 3].includes(chainId)) {
    return "Chain ID must be 1 (mainnet), 2 (testnet), or 3 (devnet).";
  }
  const difficulty = Number(input.difficulty.trim());
  if (!Number.isFinite(difficulty) || difficulty <= 0) {
    return "Initial share difficulty must be a positive number.";
  }
  if (input.tlsEnabled && !input.tlsSelfSigned) {
    if (input.tlsCertPath.trim() === "" || input.tlsKeyPath.trim() === "") {
      return "TLS is enabled: enter both certificate and private key paths, or enable self-signed TLS.";
    }
  }
  if (input.vardiffEnabled) {
    const minRaw = (input.vardiffMinDifficulty ?? "").trim();
    const maxRaw = (input.vardiffMaxDifficulty ?? "").trim();
    const targetRaw = (input.vardiffTargetShareSecs ?? "").trim();
    let minVal: number | null = null;
    let maxVal: number | null = null;
    if (minRaw !== "") {
      minVal = Number(minRaw);
      if (!Number.isFinite(minVal) || minVal <= 0) {
        return "VarDiff minimum difficulty must be a positive number.";
      }
    }
    if (maxRaw !== "") {
      maxVal = Number(maxRaw);
      if (!Number.isFinite(maxVal) || maxVal <= 0) {
        return "VarDiff maximum difficulty must be a positive number.";
      }
    }
    if (minVal !== null && maxVal !== null && minVal > maxVal) {
      return "VarDiff minimum difficulty must not exceed maximum difficulty.";
    }
    if (targetRaw !== "") {
      const targetVal = Number(targetRaw);
      if (!Number.isInteger(targetVal) || targetVal <= 0) {
        return "VarDiff target share seconds must be a positive integer.";
      }
    }
  }
  const banThresholdRaw = (input.banThresholdInvalidShares ?? "").trim();
  const banDurationRaw = (input.banDurationSecs ?? "").trim();
  let banThresholdVal: number | null = null;
  if (banThresholdRaw !== "") {
    banThresholdVal = Number(banThresholdRaw);
    if (!Number.isInteger(banThresholdVal) || banThresholdVal < 0) {
      return "Ban invalid share threshold must be a non-negative integer.";
    }
  }
  if (banDurationRaw !== "") {
    const banDurationVal = Number(banDurationRaw);
    if (!Number.isInteger(banDurationVal) || banDurationVal <= 0) {
      return "Ban duration seconds must be a positive integer.";
    }
  } else if (banThresholdVal !== null && banThresholdVal > 0) {
    return "Ban duration seconds is required when ban invalid share threshold is greater than 0.";
  }
  return null;
}

export function toStratumPayload(input: StratumFormInput): StratumConfigPayload {
  const cert = input.tlsCertPath.trim();
  const key = input.tlsKeyPath.trim();
  const vardiffOn = Boolean(input.vardiffEnabled);
  const minRaw = (input.vardiffMinDifficulty ?? "").trim();
  const maxRaw = (input.vardiffMaxDifficulty ?? "").trim();
  const targetRaw = (input.vardiffTargetShareSecs ?? "").trim();
  const banThresholdRaw = (input.banThresholdInvalidShares ?? "").trim();
  const banDurationRaw = (input.banDurationSecs ?? "").trim();
  return {
    binary: input.binary.trim(),
    bindHost: input.bindHost.trim(),
    bindPort: Number(input.bindPort.trim()),
    rpcUrl: input.rpcUrl.trim(),
    metricsAddr: input.metricsAddr.trim(),
    chainId: Number(input.chainId.trim()),
    difficulty: Number(input.difficulty.trim()),
    tlsEnabled: input.tlsEnabled,
    tlsCertPath: cert === "" ? null : cert,
    tlsKeyPath: key === "" ? null : key,
    tlsSelfSigned: input.tlsEnabled && input.tlsSelfSigned,
    vardiffEnabled: vardiffOn,
    vardiffMinDifficulty:
      vardiffOn && minRaw !== "" ? Number(minRaw) : null,
    vardiffMaxDifficulty:
      vardiffOn && maxRaw !== "" ? Number(maxRaw) : null,
    vardiffTargetShareSecs:
      vardiffOn && targetRaw !== "" ? Number(targetRaw) : null,
    banThresholdInvalidShares:
      banThresholdRaw !== "" ? Number(banThresholdRaw) : null,
    banDurationSecs: banDurationRaw !== "" ? Number(banDurationRaw) : null,
  };
}

export function stratumConfigKey(input: StratumFormInput): string {
  return JSON.stringify([
    input.binary,
    input.bindHost,
    input.bindPort,
    input.rpcUrl,
    input.metricsAddr,
    input.chainId,
    input.difficulty,
    input.tlsEnabled,
    input.tlsCertPath,
    input.tlsKeyPath,
    input.tlsSelfSigned,
    Boolean(input.vardiffEnabled),
    input.vardiffMinDifficulty ?? "",
    input.vardiffMaxDifficulty ?? "",
    input.vardiffTargetShareSecs ?? "",
    input.banThresholdInvalidShares ?? "",
    input.banDurationSecs ?? "",
  ]);
}

export function stratumStatusLabel(state: StratumProcessState): string {
  switch (state) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "exited":
      return "Exited";
    case "stopped":
    default:
      return "Stopped";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mount the Stratum Gateway supervisor panel. Returns a dispose function that
 * clears its poll timer and listeners.
 */
export function mountStratumApp(
  host: AppHost,
  options?: MountStratumOptions,
): () => void {
  const binaryInput = control<InputEl>("#stratum-binary-path");
  const bindHostInput = control<InputEl>("#stratum-bind-host");
  const bindPortInput = control<InputEl>("#stratum-bind-port");
  const rpcUrlInput = control<InputEl>("#stratum-rpc-url");
  const metricsAddrInput = control<InputEl>("#stratum-metrics-addr");
  const chainIdInput = control<InputEl>("#stratum-chain-id");
  const difficultyInput = control<InputEl>("#stratum-difficulty");
  const tlsToggle = control<CheckboxEl>("#stratum-tls-toggle");
  const tlsSelfSigned = control<CheckboxEl>("#stratum-tls-self-signed");
  const tlsCertInput = control<InputEl>("#stratum-tls-cert-path");
  const tlsKeyInput = control<InputEl>("#stratum-tls-key-path");
  const vardiffToggle = control<CheckboxEl>("#stratum-vardiff-toggle");
  const vardiffMinInput = control<InputEl>("#stratum-vardiff-min");
  const vardiffMaxInput = control<InputEl>("#stratum-vardiff-max");
  const vardiffTargetInput = control<InputEl>("#stratum-vardiff-target-secs");
  const banThresholdInput = control<InputEl>("#stratum-ban-threshold");
  const banDurationInput = control<InputEl>("#stratum-ban-duration-secs");
  const checkButton = control<ButtonEl>("#stratum-check-button");
  const startButton = control<ButtonEl>("#stratum-start-button");
  const restartButton = control<ButtonEl>("#stratum-restart-button");
  const stopButton = control<ButtonEl>("#stratum-stop-button");
  const exportDiagnosticsButton = optionalControl<ButtonEl>(
    "#stratum-export-diagnostics-button",
  );
  const alertsBanner = optionalControl<AlertBannerEl>("#stratum-alerts");
  const diagnosticsStatus = optionalControl<TextEl>("#stratum-diagnostics-status");
  const statusBadge = control<TextEl>("#stratum-status-badge");
  const errorBanner = control<TextEl>("#stratum-error");
  const summaryBanner = control<TextEl>("#stratum-summary");
  const processReadout = control<ReadoutEl>("#stratum-process-readout");
  const healthReadout = control<ReadoutEl>("#stratum-health-readout");
  const workersReadout = control<ReadoutEl>("#stratum-workers-readout");
  const logViewer = control<ReadoutEl>("#stratum-log-viewer");

  let approvedKey = "";
  let approvedSummary = "";
  let inspectionEpoch = 0;
  let requestSeq = 0;
  let successBarrier = 0;
  let appliedProcessSeq = 0;
  let appliedHealthSeq = 0;
  let lastState: StratumProcessState | null = null;
  let latestSnapshot: StratumSnapshot | null = null;
  let actionBusy = false;
  let refreshInFlight = false;
  let pollTimer = 0;

  function control<T>(selector: string): T {
    const found = host.document.querySelector(selector);
    if (!found) throw new Error(`Stratum UI is missing ${selector}.`);
    return found as T;
  }

  function optionalControl<T>(selector: string): T | null {
    const found = host.document.querySelector(selector);
    return found ? (found as T) : null;
  }

  function currentForm(): StratumFormInput {
    return {
      binary: binaryInput.value,
      bindHost: bindHostInput.value,
      bindPort: bindPortInput.value,
      rpcUrl: rpcUrlInput.value,
      metricsAddr: metricsAddrInput.value,
      chainId: chainIdInput.value,
      difficulty: difficultyInput.value,
      tlsEnabled: tlsToggle.checked,
      tlsCertPath: tlsCertInput.value,
      tlsKeyPath: tlsKeyInput.value,
      tlsSelfSigned: tlsSelfSigned.checked,
      vardiffEnabled: vardiffToggle.checked,
      vardiffMinDifficulty: vardiffMinInput.value,
      vardiffMaxDifficulty: vardiffMaxInput.value,
      vardiffTargetShareSecs: vardiffTargetInput.value,
      banThresholdInvalidShares: banThresholdInput.value,
      banDurationSecs: banDurationInput.value,
    };
  }

  function issueRequest(): number {
    requestSeq += 1;
    return requestSeq;
  }

  function markSuccess(id: number): void {
    if (id > successBarrier) successBarrier = id;
  }

  function showError(message: string): void {
    errorBanner.hidden = false;
    errorBanner.textContent = message;
  }

  function clearError(): void {
    errorBanner.hidden = true;
    errorBanner.textContent = "";
  }

  function reportError(id: number, error: unknown): void {
    if (id < successBarrier) return;
    showError(errorText(error));
  }

  function fill(list: ReadoutEl, rows: Array<[string, string]>): void {
    list.replaceChildren();
    for (const [label, value] of rows) {
      const term = host.document.createElement("dt");
      term.textContent = label;
      const description = host.document.createElement("dd");
      description.textContent = value;
      list.append(term, description);
    }
  }

  function syncTlsFields(): void {
    const tlsOn = tlsToggle.checked;
    tlsSelfSigned.disabled = !tlsOn;
    tlsCertInput.disabled = !tlsOn;
    tlsKeyInput.disabled = !tlsOn;
    const vardiffOn = vardiffToggle.checked;
    vardiffMinInput.disabled = !vardiffOn;
    vardiffMaxInput.disabled = !vardiffOn;
    vardiffTargetInput.disabled = !vardiffOn;
  }

  function syncButtons(): void {
    const live =
      lastState === "running" ||
      lastState === "starting" ||
      lastState === "stopping";
    const approved =
      approvedKey !== "" && approvedKey === stratumConfigKey(currentForm());
    startButton.disabled = actionBusy || live || !approved;
    restartButton.disabled = actionBusy || !live || !approved;
    stopButton.disabled = actionBusy || !live;
  }

  function syncApproval(): void {
    const showing =
      approvedKey !== "" && approvedKey === stratumConfigKey(currentForm());
    summaryBanner.textContent = showing ? approvedSummary : "";
    syncTlsFields();
    syncButtons();
  }

  function summaryText(cfg: CheckedStratumConfig): string {
    const tlsText = cfg.tlsEnabled
      ? cfg.tlsSelfSigned
        ? "TLS enabled (self-signed)."
        : `TLS enabled (cert ${cfg.tlsCertPath ?? "none"}).`
      : "TLS disabled (plain TCP).";
    const vardiffText = cfg.vardiffEnabled
      ? `VarDiff enabled (${cfg.vardiffMinDifficulty ?? "default"}..${cfg.vardiffMaxDifficulty ?? "default"}, target ${cfg.vardiffTargetShareSecs ?? "default"}s).`
      : "VarDiff disabled.";
    const banText =
      cfg.banThresholdInvalidShares && cfg.banThresholdInvalidShares > 0
        ? `IP ban after ${cfg.banThresholdInvalidShares} invalid shares for ${cfg.banDurationSecs ?? 0}s.`
        : "IP ban disabled.";
    return [
      `Listen ${cfg.listenAddr}.`,
      `Upstream RPC ${cfg.rpcUrl}.`,
      `Health ${cfg.healthUrl}.`,
      `Chain ${cfg.chainId}, difficulty ${cfg.difficulty}.`,
      tlsText,
      vardiffText,
      banText,
      `Executable SHA-256 ${cfg.binarySha256}.`,
    ].join(" ");
  }

  function renderLogs(snapshot: StratumSnapshot): void {
    logViewer.replaceChildren();
    for (const line of snapshot.process.logs) {
      const row = host.document.createElement("pre");
      row.textContent = line;
      logViewer.append(row);
    }
    logViewer.scrollTop = logViewer.scrollHeight;
  }

  function renderProcess(snapshot: StratumSnapshot): void {
    const proc = snapshot.process;
    lastState = proc.state;
    statusBadge.textContent = stratumStatusLabel(proc.state);
    if (statusBadge.dataset) {
      statusBadge.dataset.state = proc.state;
    }
    fill(processReadout, [
      ["Gateway", proc.state],
      ["PID", proc.pid === null ? "none" : String(proc.pid)],
      ["Exit code", proc.exitCode === null ? "none" : String(proc.exitCode)],
      ["Last error", proc.lastError ?? "none"],
      ["Listen address", snapshot.config?.listenAddr ?? "not configured"],
      ["Upstream RPC", snapshot.config?.rpcUrl ?? "not configured"],
      [
        "TLS",
        snapshot.config
          ? snapshot.config.tlsEnabled
            ? snapshot.config.tlsSelfSigned
              ? "enabled (self-signed)"
              : "enabled (PEM cert/key)"
            : "disabled"
          : "unknown",
      ],
      ["Stop grace", `${snapshot.stopGraceSecs}s SIGTERM, then SIGKILL`],
    ]);
    renderLogs(snapshot);
    syncButtons();
  }

  function renderHealth(snapshot: StratumSnapshot): void {
    const h = snapshot.health;
    fill(healthReadout, [
      ["Observability", h.reach],
      ["Status", fieldText(h.status)],
      ["Uptime (s)", fieldText(h.uptimeSeconds)],
      ["Active miners", fieldText(h.activeConnections)],
      ["Current job", fieldText(h.currentJobId)],
      ["TLS active", fieldText(h.tlsEnabled)],
      ["Health timestamp", fieldText(h.timestamp)],
      ["Health detail", h.detail ?? "none"],
    ]);
    renderWorkers(snapshot);
  }

  function renderWorkers(snapshot: StratumSnapshot): void {
    const w = snapshot.workers;
    if (!w || w.reach === "unknown") {
      fill(workersReadout, [
        ["Workers endpoint", "unknown"],
        ["Active workers", "0"],
        ["Banned IPs", "0"],
      ]);
      return;
    }
    if (w.reach === "unreachable") {
      fill(workersReadout, [
        ["Workers endpoint", "unreachable"],
        ["Active workers", "unavailable"],
        ["Banned IPs", "unavailable"],
        ["Workers detail", w.detail ?? "none"],
      ]);
      return;
    }
    const rows: Array<[string, string]> = [
      ["Workers endpoint", "reachable"],
      ["Active workers", String(w.workers.length)],
      ["Banned IPs", String(w.bannedIps)],
    ];
    for (const entry of w.workers) {
      const xnsubBadge = entry.extranonceSubscribed ? " [xnsub]" : "";
      rows.push([
        entry.workerName,
        `diff=${entry.difficulty} accepted=${entry.sharesAccepted} rejected=${entry.sharesRejected} connected=${entry.connectedSecs}s${xnsubBadge}`,
      ]);
    }
    fill(workersReadout, rows);
  }

  function renderAlerts(snapshot: StratumSnapshot): void {
    if (!alertsBanner) return;
    const alerts = evaluateStratumAlerts(
      snapshot.process,
      snapshot.health,
      snapshot.workers,
    );
    alertsBanner.replaceChildren();
    if (alerts.length === 0) {
      alertsBanner.hidden = true;
      if (alertsBanner.dataset) {
        delete alertsBanner.dataset.severity;
      }
      return;
    }
    alertsBanner.hidden = false;
    if (alertsBanner.dataset) {
      alertsBanner.dataset.severity = alerts[0].severity;
    }
    for (const alert of alerts) {
      const row = host.document.createElement("p");
      row.textContent = `[${alert.severity.toUpperCase()}] ${alert.message}`;
      alertsBanner.append(row);
    }
  }

  function showDiagnosticsStatus(message: string): void {
    if (!diagnosticsStatus) return;
    diagnosticsStatus.hidden = false;
    diagnosticsStatus.textContent = message;
  }

  async function onExportDiagnostics(): Promise<void> {
    const bundle = buildSanitizedStratumDiagnostics({
      status: latestSnapshot?.process ?? null,
      health: latestSnapshot?.health ?? null,
      workers: latestSnapshot?.workers ?? null,
      logs: latestSnapshot?.process.logs ?? [],
      config: latestSnapshot?.config ?? null,
    });
    const json = JSON.stringify(bundle, null, 2);
    const filename = "kovanica-stratum-diagnostics.json";
    try {
      let copied = false;
      if (options?.copyText) {
        await options.copyText(json);
        copied = true;
      } else if (
        typeof globalThis.navigator !== "undefined" &&
        globalThis.navigator.clipboard &&
        typeof globalThis.navigator.clipboard.writeText === "function"
      ) {
        await globalThis.navigator.clipboard.writeText(json);
        copied = true;
      }

      if (options?.exportFile) {
        options.exportFile(filename, json);
      } else if (
        !copied &&
        typeof Blob !== "undefined" &&
        typeof URL !== "undefined" &&
        typeof URL.createObjectURL === "function" &&
        typeof document !== "undefined"
      ) {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
      }

      showDiagnosticsStatus(
        copied
          ? `Copied sanitized diagnostics JSON (${bundle.logs.length} log lines, ${bundle.alerts.length} alerts).`
          : `Exported sanitized diagnostics JSON (${bundle.logs.length} log lines, ${bundle.alerts.length} alerts).`,
      );
    } catch (error) {
      showError(`Diagnostics export failed: ${errorText(error)}`);
    }
  }

  function applySnapshot(snapshot: StratumSnapshot): boolean {
    let applied = false;
    if (snapshot.process.statusSeq > appliedProcessSeq) {
      appliedProcessSeq = snapshot.process.statusSeq;
      latestSnapshot = snapshot;
      renderProcess(snapshot);
      renderHealth(snapshot);
      renderAlerts(snapshot);
      if (snapshot.healthSeq > appliedHealthSeq) {
        appliedHealthSeq = snapshot.healthSeq;
      }
      applied = true;
    } else if (snapshot.process.statusSeq === appliedProcessSeq) {
      latestSnapshot = snapshot;
      renderLogs(snapshot);
      if (snapshot.healthSeq > appliedHealthSeq) {
        appliedHealthSeq = snapshot.healthSeq;
        renderHealth(snapshot);
        renderAlerts(snapshot);
        applied = true;
      }
    }
    return applied;
  }

  async function refreshStatus(): Promise<void> {
    const id = issueRequest();
    try {
      const snapshot = (await host.invoke("stratum_status")) as StratumSnapshot;
      if (applySnapshot(snapshot)) markSuccess(id);
    } catch (error) {
      reportError(id, error);
    }
  }

  async function refreshHealth(): Promise<void> {
    if (host.document.hidden) return;
    if (refreshInFlight) return;
    refreshInFlight = true;
    const id = issueRequest();
    try {
      const snapshot = (await host.invoke("stratum_refresh")) as StratumSnapshot;
      if (applySnapshot(snapshot)) markSuccess(id);
    } catch (error) {
      reportError(id, error);
    } finally {
      refreshInFlight = false;
    }
  }

  function onInput(): void {
    inspectionEpoch += 1;
    syncApproval();
  }

  async function onCheck(): Promise<void> {
    const epoch = ++inspectionEpoch;
    const form = currentForm();
    const id = issueRequest();
    const validationError = validateStratumForm(form);
    if (validationError !== null) {
      approvedKey = "";
      approvedSummary = "";
      syncApproval();
      if (epoch === inspectionEpoch) {
        showError(validationError);
        checkButton.focus();
      }
      return;
    }
    approvedKey = "";
    approvedSummary = "";
    syncApproval();
    try {
      const checked = (await host.invoke("stratum_inspect", {
        config: toStratumPayload(form),
      })) as CheckedStratumConfig;
      if (epoch !== inspectionEpoch) return;
      if (stratumConfigKey(form) !== stratumConfigKey(currentForm())) return;
      approvedKey = stratumConfigKey(form);
      approvedSummary = summaryText(checked);
      markSuccess(id);
      clearError();
      syncApproval();
      if (!startButton.disabled) startButton.focus();
    } catch (error) {
      if (epoch !== inspectionEpoch) return;
      if (stratumConfigKey(form) !== stratumConfigKey(currentForm())) return;
      approvedKey = "";
      approvedSummary = "";
      syncApproval();
      reportError(id, error);
    }
  }

  async function onStart(): Promise<void> {
    if (startButton.disabled || actionBusy) return;
    const form = currentForm();
    if (stratumConfigKey(form) !== approvedKey) return;
    const id = issueRequest();
    actionBusy = true;
    syncButtons();
    try {
      const snapshot = (await host.invoke("stratum_start", {
        config: toStratumPayload(form),
      })) as StratumSnapshot;
      if (applySnapshot(snapshot)) {
        markSuccess(id);
        clearError();
      }
    } catch (error) {
      reportError(id, error);
    } finally {
      actionBusy = false;
      syncButtons();
    }
  }

  async function onRestart(): Promise<void> {
    if (restartButton.disabled || actionBusy) return;
    const form = currentForm();
    if (stratumConfigKey(form) !== approvedKey) return;
    const id = issueRequest();
    actionBusy = true;
    syncButtons();
    try {
      const snapshot = (await host.invoke("stratum_restart", {
        config: toStratumPayload(form),
      })) as StratumSnapshot;
      if (applySnapshot(snapshot)) {
        markSuccess(id);
        clearError();
      }
    } catch (error) {
      reportError(id, error);
    } finally {
      actionBusy = false;
      syncButtons();
    }
  }

  async function onStop(): Promise<void> {
    if (stopButton.disabled || actionBusy) return;
    const id = issueRequest();
    actionBusy = true;
    syncButtons();
    try {
      const snapshot = (await host.invoke("stratum_stop")) as StratumSnapshot;
      if (applySnapshot(snapshot)) {
        markSuccess(id);
        clearError();
      }
    } catch (error) {
      reportError(id, error);
    } finally {
      actionBusy = false;
      syncButtons();
    }
  }

  function onPoll(): void {
    void refreshStatus();
    if (!host.document.hidden && lastState === "running") {
      void refreshHealth();
    }
  }

  function onUnload(): void {
    host.window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  for (const input of [
    binaryInput,
    bindHostInput,
    bindPortInput,
    rpcUrlInput,
    metricsAddrInput,
    chainIdInput,
    difficultyInput,
    tlsCertInput,
    tlsKeyInput,
    vardiffMinInput,
    vardiffMaxInput,
    vardiffTargetInput,
    banThresholdInput,
    banDurationInput,
  ]) {
    input.addEventListener("input", onInput);
  }
  tlsToggle.addEventListener("change", onInput);
  tlsSelfSigned.addEventListener("change", onInput);
  vardiffToggle.addEventListener("change", onInput);
  checkButton.addEventListener("click", () => {
    void onCheck();
  });
  startButton.addEventListener("click", () => {
    void onStart();
  });
  restartButton.addEventListener("click", () => {
    void onRestart();
  });
  stopButton.addEventListener("click", () => {
    void onStop();
  });
  exportDiagnosticsButton?.addEventListener("click", () => {
    void onExportDiagnostics();
  });
  host.window.addEventListener("beforeunload", onUnload);

  syncApproval();
  pollTimer = host.window.setInterval(onPoll, 2000);
  void refreshStatus();

  return () => {
    onUnload();
    host.window.removeEventListener("beforeunload", onUnload);
  };
}
