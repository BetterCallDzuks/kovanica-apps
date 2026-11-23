/**
 * Display model for the connection screen.
 *
 * Amounts and counters arrive as decimal strings from the Rust backend.
 * This module never parses them into numbers.
 */

export interface PeerRow {
  peerId: string;
  reportedTipRound: string | null;
}

export interface NodeStatus {
  chainId: string | null;
  chainNote: string;
  height: string;
  leaderRound: string | null;
  epoch: string | null;
  peerCount: string;
  peers: PeerRow[];
}

export interface ConnectionConfig {
  rpcUrl: string;
  endpointLabel: string;
}

export interface StatusRow {
  label: string;
  value: string;
}

/** A value the console did not prove. The screen says where it came from. */
function reportedByNode(label: string): string {
  return `${label} (reported by node)`;
}

/** Rows for the node panel, in the order the screen shows them. */
export function statusRows(status: NodeStatus): StatusRow[] {
  const proven = status.chainId !== null;
  return [
    { label: "Chain id", value: status.chainId ?? "Unknown" },
    { label: "Chain check", value: status.chainNote },
    { label: reportedByNode("Height"), value: status.height },
    {
      label: proven ? "Leader round" : reportedByNode("Leader round"),
      value: status.leaderRound ?? "—",
    },
    { label: proven ? "Epoch" : reportedByNode("Epoch"), value: status.epoch ?? "—" },
    { label: reportedByNode("Peers"), value: status.peerCount },
  ];
}

/** One line per connected peer. An empty list is a sentence, not a blank. */
export function peerLines(peers: PeerRow[]): string[] {
  if (peers.length === 0) {
    return ["No connected peers"];
  }
  return peers.map((peer) =>
    peer.reportedTipRound === null
      ? peer.peerId
      : `${peer.peerId} · tip ${peer.reportedTipRound}`,
  );
}

/** Where the status screen says it is talking, without parsing the URL. */
export function endpointLine(label: string): string {
  return `Talking to ${label}`;
}

/**
 * Session-scoped optional RPC Bearer Token.
 * Kept strictly in memory for the current session and never logged or persisted.
 */
let sessionRpcBearerToken: string | null = null;

/** Trims a bearer token candidate and rejects blank or control-character values. */
export function normalizeRpcBearerToken(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new Error("RPC bearer token must not contain control characters.");
  }
  return trimmed;
}

/** Stores or clears the session-scoped RPC bearer token in memory. */
export function setSessionRpcBearerToken(token: string | null | undefined): void {
  sessionRpcBearerToken = normalizeRpcBearerToken(token);
}

/** Returns the current session-scoped RPC bearer token, if configured. */
export function getSessionRpcBearerToken(): string | null {
  return sessionRpcBearerToken;
}

/** Clears the session-scoped RPC bearer token from memory. */
export function clearSessionRpcBearerToken(): void {
  sessionRpcBearerToken = null;
}

/** Whether a session-scoped RPC bearer token is currently configured. */
export function hasSessionRpcBearerToken(): boolean {
  return sessionRpcBearerToken !== null;
}

/** Safe status text for UI display or diagnostics; never reveals the raw token. */
export function rpcBearerTokenStatus(token: string | null | undefined = sessionRpcBearerToken): string {
  return normalizeRpcBearerToken(token) ? "RPC bearer token configured (session only)" : "No RPC bearer token configured";
}

/**
 * Builds HTTP headers for JSON-RPC requests.
 * Attaches `Authorization: Bearer <token>` only when a token is configured.
 */
export function buildRpcHeaders(
  extraHeaders?: Record<string, string>,
  tokenOverride?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders ?? {}),
  };
  const token =
    tokenOverride !== undefined ? normalizeRpcBearerToken(tokenOverride) : sessionRpcBearerToken;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export interface RpcFetchOptions {
  headers?: Record<string, string>;
  token?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Sends a JSON-RPC POST request, attaching the session (or overridden)
 * `Authorization: Bearer <token>` header when configured. Never logs the token.
 */
export async function rpcFetch(
  url: string,
  payload: unknown,
  options: RpcFetchOptions = {},
): Promise<Response> {
  const fetchFn = options.fetchImpl ?? fetch;
  const headers = buildRpcHeaders(options.headers, options.token);
  return fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  });
}

export const MAX_FALLBACK_RPC_URLS = 8;

export const CANONICAL_NETWORK_TAGS: Readonly<Record<number, string>> = {
  1: "1-f35df34c92001436",
  2: "2-24cdb5fadd98b207",
};

export interface NetworkTagVerificationResult {
  valid: boolean;
  chainId: number | null;
  expectedTag: string | null;
  actualTag: string | null;
  reason?: string;
}

function parseChainIdNumber(chainId: number | string): number | null {
  if (typeof chainId === "number") {
    return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null;
  }
  if (typeof chainId !== "string") {
    return null;
  }
  const trimmed = chainId.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed.slice(2), 16);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Verifies a reported network tag against the canonical tag for a given chain ID.
 */
export function verifyNetworkTagForChain(
  chainId: number | string,
  networkTag: string | null | undefined,
): NetworkTagVerificationResult {
  const actualTag =
    typeof networkTag === "string" && networkTag.trim() !== "" ? networkTag.trim() : null;
  const parsedChainId = parseChainIdNumber(chainId);

  if (parsedChainId === null) {
    return {
      valid: false,
      chainId: null,
      expectedTag: null,
      actualTag,
      reason: "Invalid chainId.",
    };
  }

  const expectedTag = CANONICAL_NETWORK_TAGS[parsedChainId] ?? null;
  if (expectedTag === null) {
    return {
      valid: false,
      chainId: parsedChainId,
      expectedTag: null,
      actualTag,
      reason: `No canonical network tag registered for chainId ${parsedChainId}.`,
    };
  }

  if (actualTag === null) {
    return {
      valid: false,
      chainId: parsedChainId,
      expectedTag,
      actualTag: null,
      reason: `Missing network tag for chainId ${parsedChainId} (expected ${expectedTag}).`,
    };
  }

  if (actualTag !== expectedTag) {
    return {
      valid: false,
      chainId: parsedChainId,
      expectedTag,
      actualTag,
      reason: `Network tag mismatch for chainId ${parsedChainId}: expected ${expectedTag}, got ${actualTag}.`,
    };
  }

  return {
    valid: true,
    chainId: parsedChainId,
    expectedTag,
    actualTag,
  };
}

export interface RpcProbeResult {
  url: string;
  ok: boolean;
  chainId?: string;
  latencyMs: number;
  error?: string;
}

export interface RpcBatchHealthProbeResult {
  url: string;
  ok: boolean;
  chainId?: string;
  blockHeight?: string;
  feeRate?: string;
  networkTag?: string;
  rpcVersion?: string;
  headerChainId?: string;
  batchSupported: boolean;
  latencyMs: number;
  error?: string;
}

export type RpcBatchHealthResult = RpcBatchHealthProbeResult;

/** Redacts embedded URL credentials and bearer tokens from display/error text. */
export function sanitizeRpcText(input: string): string {
  return input
    .replace(/(https?:\/\/)([^:@\s/]+)(?::[^@\s/]*)?@/gi, "$1[REDACTED]@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
}

/** Returns a display-safe URL with any embedded username/password removed. */
export function sanitizeRpcUrlForDisplay(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    const hadCredentials = parsed.username !== "" || parsed.password !== "";
    parsed.username = "";
    parsed.password = "";
    if (!hadCredentials) {
      return trimmed;
    }
    const formatted = parsed.toString();
    // Preserve no-trailing-slash style when original root URL had no trailing slash.
    if (parsed.pathname === "/" && !trimmed.endsWith("/") && formatted.endsWith("/")) {
      return formatted.slice(0, -1);
    }
    return formatted;
  } catch {
    return sanitizeRpcText(trimmed);
  }
}

/**
 * Parses newline- or comma-separated fallback RPC URLs.
 * Trims entries, validates `http://` or `https://` URLs, deduplicates, and caps at 8 endpoints.
 */
export function parseFallbackRpcUrls(rawText: string): string[] {
  if (typeof rawText !== "string" || rawText.trim() === "") {
    return [];
  }
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const part of rawText.split(/[\r\n,]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(trimmed)) continue;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      continue;
    }
    if (!parsed.hostname) {
      continue;
    }

    const dedupKey = parsed.toString();
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    urls.push(trimmed);
    if (urls.length >= MAX_FALLBACK_RPC_URLS) {
      break;
    }
  }

  return urls;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Queries `kovanica_chainId` against each RPC URL in parallel, measuring round-trip
 * latency in milliseconds and sanitizing any embedded credentials in displayed URLs or errors.
 */
export async function probeRpcEndpoints(
  urls: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<RpcProbeResult[]> {
  if (urls.length === 0) {
    return [];
  }

  return Promise.all(
    urls.map(async (rawUrl): Promise<RpcProbeResult> => {
      const displayUrl = sanitizeRpcUrlForDisplay(rawUrl);
      const start = nowMs();
      try {
        const parsed = new URL(rawUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return {
            url: displayUrl,
            ok: false,
            latencyMs: 0,
            error: "RPC URL must start with http:// or https://.",
          };
        }
      } catch {
        return {
          url: displayUrl,
          ok: false,
          latencyMs: 0,
          error: "Invalid RPC URL.",
        };
      }

      try {
        const response = await rpcFetch(
          rawUrl.trim(),
          { jsonrpc: "2.0", id: 1, method: "kovanica_chainId", params: [] },
          { fetchImpl },
        );
        const latencyMs = Math.max(0, Math.round(nowMs() - start));

        if (!response.ok) {
          return {
            url: displayUrl,
            ok: false,
            latencyMs,
            error: sanitizeRpcText(`HTTP ${response.status}`),
          };
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return {
            url: displayUrl,
            ok: false,
            latencyMs,
            error: "Invalid JSON-RPC response.",
          };
        }

        if (!body || typeof body !== "object") {
          return {
            url: displayUrl,
            ok: false,
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
            url: displayUrl,
            ok: false,
            latencyMs,
            error: sanitizeRpcText(errMsg),
          };
        }

        if (record.result === undefined || record.result === null || String(record.result).trim() === "") {
          return {
            url: displayUrl,
            ok: false,
            latencyMs,
            error: "Missing chainId result.",
          };
        }

        return {
          url: displayUrl,
          ok: true,
          chainId: String(record.result),
          latencyMs,
        };
      } catch (err) {
        const latencyMs = Math.max(0, Math.round(nowMs() - start));
        const rawMessage = err instanceof Error ? err.message : String(err);
        return {
          url: displayUrl,
          ok: false,
          latencyMs,
          error: sanitizeRpcText(rawMessage || "Request failed."),
        };
      }
    }),
  );
}

interface JsonRpcBatchItemResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function formatBatchRpcValue(value: unknown, preferFeeField = false): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (preferFeeField && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const candidate = obj.feeRate ?? obj.fee_rate ?? obj.baseFee ?? obj.fee;
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      return String(candidate).trim();
    }
  }
  return null;
}

function readOptionalResponseHeader(
  headers: Headers | undefined,
  name: string,
): string | undefined {
  if (!headers || typeof headers.get !== "function") {
    return undefined;
  }
  const raw = headers.get(name);
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Probes an RPC endpoint using a single-POST JSON-RPC 2.0 batch request for
 * `kovanica_chainId`, `kovanica_blockNumber`, and `kovanica_estimateFee`.
 * Correlates responses by `id`, measures latency in ms, sanitizes credentials,
 * extracts optional Kovanica identity headers, and gracefully reports
 * `batchSupported: false` if a legacy node rejects batching.
 */
export async function probeRpcBatchHealth(
  rpcUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RpcBatchHealthProbeResult> {
  const trimmed = rpcUrl.trim();
  const displayUrl = sanitizeRpcUrlForDisplay(trimmed);

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        url: displayUrl,
        ok: false,
        batchSupported: false,
        latencyMs: 0,
        error: "RPC URL must start with http:// or https://.",
      };
    }
  } catch {
    return {
      url: displayUrl,
      ok: false,
      batchSupported: false,
      latencyMs: 0,
      error: "Invalid RPC URL.",
    };
  }

  const batchPayload = [
    { jsonrpc: "2.0", id: 1, method: "kovanica_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "kovanica_blockNumber", params: [] },
    { jsonrpc: "2.0", id: 3, method: "kovanica_estimateFee", params: [] },
  ];

  const start = nowMs();
  try {
    const response = await rpcFetch(trimmed, batchPayload, { fetchImpl });
    const latencyMs = Math.max(0, Math.round(nowMs() - start));
    const networkTag = readOptionalResponseHeader(response.headers, "X-Kovanica-Network-Tag");
    const rpcVersion = readOptionalResponseHeader(response.headers, "X-Kovanica-Rpc-Version");
    const headerChainId = readOptionalResponseHeader(response.headers, "X-Kovanica-Chain-Id");
    const identityHeaders = {
      ...(networkTag !== undefined ? { networkTag } : {}),
      ...(rpcVersion !== undefined ? { rpcVersion } : {}),
      ...(headerChainId !== undefined ? { headerChainId } : {}),
    };

    if (!response.ok) {
      return {
        url: displayUrl,
        ok: false,
        ...identityHeaders,
        batchSupported: false,
        latencyMs,
        error: sanitizeRpcText(`HTTP ${response.status}`),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        url: displayUrl,
        ok: false,
        ...identityHeaders,
        batchSupported: false,
        latencyMs,
        error: "Invalid JSON-RPC batch response.",
      };
    }

    if (!Array.isArray(body)) {
      if (body && typeof body === "object") {
        const legacy = body as JsonRpcBatchItemResponse;
        if (legacy.error) {
          const errMsg =
            typeof legacy.error.message === "string" && legacy.error.message.trim() !== ""
              ? legacy.error.message
              : `RPC error ${String(legacy.error.code ?? "unknown")}`;
          return {
            url: displayUrl,
            ok: false,
            ...identityHeaders,
            batchSupported: false,
            latencyMs,
            error: sanitizeRpcText(errMsg),
          };
        }
      }
      return {
        url: displayUrl,
        ok: false,
        ...identityHeaders,
        batchSupported: false,
        latencyMs,
        error: "Endpoint does not support JSON-RPC 2.0 batch requests.",
      };
    }

    const byId = new Map<number, JsonRpcBatchItemResponse>();
    for (const item of body) {
      if (item && typeof item === "object") {
        const record = item as JsonRpcBatchItemResponse;
        if (typeof record.id === "number") {
          byId.set(record.id, record);
        }
      }
    }

    const errors: string[] = [];
    const extractItem = (
      id: number,
      method: string,
      preferFeeField = false,
    ): string | undefined => {
      const item = byId.get(id);
      if (!item) {
        errors.push(`Missing response for ${method}.`);
        return undefined;
      }
      if (item.error) {
        const errMsg =
          typeof item.error.message === "string" && item.error.message.trim() !== ""
            ? item.error.message
            : `RPC error ${String(item.error.code ?? "unknown")}`;
        errors.push(`${method}: ${sanitizeRpcText(errMsg)}`);
        return undefined;
      }
      const formatted = formatBatchRpcValue(item.result, preferFeeField);
      if (formatted === null) {
        errors.push(`Missing result for ${method}.`);
        return undefined;
      }
      return formatted;
    };

    const chainId = extractItem(1, "kovanica_chainId");
    const blockHeight = extractItem(2, "kovanica_blockNumber");
    const feeRate = extractItem(3, "kovanica_estimateFee", true);

    if (errors.length > 0) {
      return {
        url: displayUrl,
        ok: false,
        ...(chainId !== undefined ? { chainId } : {}),
        ...(blockHeight !== undefined ? { blockHeight } : {}),
        ...(feeRate !== undefined ? { feeRate } : {}),
        ...identityHeaders,
        batchSupported: true,
        latencyMs,
        error: sanitizeRpcText(errors.join("; ")),
      };
    }

    return {
      url: displayUrl,
      ok: true,
      chainId,
      blockHeight,
      feeRate,
      ...identityHeaders,
      batchSupported: true,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.max(0, Math.round(nowMs() - start));
    const rawMessage = err instanceof Error ? err.message : String(err);
    return {
      url: displayUrl,
      ok: false,
      batchSupported: false,
      latencyMs,
      error: sanitizeRpcText(rawMessage || "Request failed."),
    };
  }
}

export type NodeDoctorSeverity = "ok" | "warn" | "error";

export interface NodeDoctorSummary {
  ready: boolean;
  severity: NodeDoctorSeverity;
  canonicalTagValid: boolean;
  batchSupported: boolean;
  latencyMs: number;
  headline: string;
  warnings: string[];
}

/**
 * Combines `probeRpcBatchHealth` output with `verifyNetworkTagForChain` into a
 * concise operator readiness summary. Sanitizes credentials from URLs and errors.
 */
export function formatNodeDoctorSummary(
  batchProbeResult: RpcBatchHealthProbeResult,
  networkTag?: string,
): NodeDoctorSummary {
  const safeUrl = sanitizeRpcUrlForDisplay(batchProbeResult.url);
  const latencyMs =
    Number.isFinite(batchProbeResult.latencyMs) && batchProbeResult.latencyMs >= 0
      ? Math.round(batchProbeResult.latencyMs)
      : 0;
  const batchSupported = Boolean(batchProbeResult.batchSupported);
  const warnings: string[] = [];

  let canonicalTagValid = false;
  let tagMismatch = false;

  const effectiveNetworkTag = networkTag ?? batchProbeResult.networkTag;

  if (batchProbeResult.chainId !== undefined && batchProbeResult.chainId.trim() !== "") {
    const tagCheck = verifyNetworkTagForChain(batchProbeResult.chainId, effectiveNetworkTag);
    canonicalTagValid = tagCheck.valid;
    if (!tagCheck.valid) {
      if (tagCheck.reason) {
        warnings.push(tagCheck.reason);
      }
      if (
        tagCheck.actualTag !== null &&
        tagCheck.expectedTag !== null &&
        tagCheck.actualTag !== tagCheck.expectedTag
      ) {
        tagMismatch = true;
      }
    }
  } else if (batchProbeResult.ok) {
    warnings.push("Missing chainId in batch probe result; cannot verify canonical network tag.");
  }

  if (!batchSupported) {
    warnings.push("Endpoint does not support JSON-RPC 2.0 batch requests.");
  }

  if (!batchProbeResult.ok) {
    const safeError = batchProbeResult.error
      ? sanitizeRpcText(batchProbeResult.error)
      : "RPC batch health probe failed.";
    if (!warnings.includes(safeError)) {
      warnings.push(safeError);
    }
    return {
      ready: false,
      severity: "error",
      canonicalTagValid,
      batchSupported,
      latencyMs,
      headline: `Node not ready (${safeUrl}) · ${latencyMs}ms · ${safeError}`,
      warnings,
    };
  }

  if (tagMismatch) {
    return {
      ready: false,
      severity: "error",
      canonicalTagValid: false,
      batchSupported,
      latencyMs,
      headline: `Node network tag mismatch (${safeUrl}) · chainId=${batchProbeResult.chainId ?? "unknown"} · ${latencyMs}ms`,
      warnings,
    };
  }

  if (!canonicalTagValid || !batchSupported) {
    return {
      ready: true,
      severity: "warn",
      canonicalTagValid,
      batchSupported,
      latencyMs,
      headline: `Node reachable with warnings (${safeUrl}) · chainId=${batchProbeResult.chainId ?? "unknown"} · height=${batchProbeResult.blockHeight ?? "unknown"} · ${latencyMs}ms`,
      warnings,
    };
  }

  return {
    ready: true,
    severity: "ok",
    canonicalTagValid: true,
    batchSupported: true,
    latencyMs,
    headline: `Node ready (${safeUrl}) · chainId=${batchProbeResult.chainId ?? "unknown"} · height=${batchProbeResult.blockHeight ?? "unknown"} · ${latencyMs}ms`,
    warnings,
  };
}

export type IndexerSyncState = "synced" | "lagging" | "stalled" | "offline";

export interface IndexerHealthSummary {
  syncState: IndexerSyncState;
  indexedHeight: number;
  nodeHeadHeight: number;
  lagBlocks: number;
  eventCount: number;
  alerts: string[];
}

export const INDEXER_SYNCED_MAX_LAG_BLOCKS = 2;
export const INDEXER_LAGGING_MAX_LAG_BLOCKS = 50;

function readNonNegativeInt(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return Math.floor(raw);
    }
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return null;
}

function classifyIndexerLag(lagBlocks: number): Exclude<IndexerSyncState, "offline"> {
  if (lagBlocks <= INDEXER_SYNCED_MAX_LAG_BLOCKS) {
    return "synced";
  }
  if (lagBlocks <= INDEXER_LAGGING_MAX_LAG_BLOCKS) {
    return "lagging";
  }
  return "stalled";
}

/**
 * Parses `kovanica-indexer` `/health` JSON payloads into a normalized sync-lag
 * summary. Fails safe to `syncState: "offline"` on null, primitive, or malformed
 * inputs, and raises actionable alerts when `lagging`, `stalled`, or `offline`.
 */
export function parseIndexerHealthSummary(healthJson: unknown): IndexerHealthSummary {
  if (!healthJson || typeof healthJson !== "object" || Array.isArray(healthJson)) {
    return {
      syncState: "offline",
      indexedHeight: 0,
      nodeHeadHeight: 0,
      lagBlocks: 0,
      eventCount: 0,
      alerts: ["Indexer health payload is unavailable or malformed."],
    };
  }

  const record = healthJson as Record<string, unknown>;
  const rawStatus =
    typeof record.status === "string" ? record.status.trim().toLowerCase() : null;
  const rawSyncState =
    typeof record.sync_state === "string"
      ? record.sync_state.trim().toLowerCase()
      : typeof record.syncState === "string"
        ? record.syncState.trim().toLowerCase()
        : null;

  const indexedHeightVal = readNonNegativeInt(record, [
    "indexed_height",
    "indexedHeight",
    "latest_indexed_height",
    "latestIndexedHeight",
  ]);
  const nodeHeadHeightVal = readNonNegativeInt(record, [
    "node_head_height",
    "nodeHeadHeight",
    "latest_node_height",
    "latestNodeHeight",
  ]);
  const lagBlocksVal = readNonNegativeInt(record, ["lag_blocks", "lagBlocks"]);
  const eventCountVal = readNonNegativeInt(record, ["event_count", "eventCount"]);

  const hasRecognizedField =
    rawStatus !== null ||
    rawSyncState !== null ||
    indexedHeightVal !== null ||
    nodeHeadHeightVal !== null ||
    lagBlocksVal !== null ||
    eventCountVal !== null;

  if (!hasRecognizedField) {
    return {
      syncState: "offline",
      indexedHeight: 0,
      nodeHeadHeight: 0,
      lagBlocks: 0,
      eventCount: 0,
      alerts: ["Indexer health payload is unavailable or malformed."],
    };
  }

  const indexedHeight = indexedHeightVal ?? 0;
  const nodeHeadHeight = nodeHeadHeightVal ?? 0;
  const lagBlocks =
    lagBlocksVal !== null ? lagBlocksVal : Math.max(0, nodeHeadHeight - indexedHeight);
  const eventCount = eventCountVal ?? 0;

  const isOffline =
    rawSyncState === "offline" ||
    rawStatus === "offline" ||
    rawStatus === "down" ||
    rawStatus === "stopped" ||
    rawStatus === "unreachable" ||
    rawStatus === "error";

  let syncState: IndexerSyncState;
  if (isOffline) {
    syncState = "offline";
  } else if (
    rawSyncState === "synced" ||
    rawSyncState === "lagging" ||
    rawSyncState === "stalled"
  ) {
    syncState = rawSyncState;
  } else if (
    indexedHeightVal !== null ||
    nodeHeadHeightVal !== null ||
    lagBlocksVal !== null
  ) {
    syncState = classifyIndexerLag(lagBlocks);
  } else {
    syncState = "offline";
  }

  const alerts: string[] = [];
  if (syncState === "offline") {
    alerts.push("Indexer is offline or unreachable.");
  } else if (syncState === "lagging") {
    alerts.push(
      `Indexer is lagging behind node head by ${lagBlocks} block${lagBlocks === 1 ? "" : "s"} (indexed=${indexedHeight}, head=${nodeHeadHeight}).`,
    );
  } else if (syncState === "stalled") {
    alerts.push(
      `Indexer is stalled behind node head by ${lagBlocks} block${lagBlocks === 1 ? "" : "s"} (indexed=${indexedHeight}, head=${nodeHeadHeight}).`,
    );
  }

  return {
    syncState,
    indexedHeight,
    nodeHeadHeight,
    lagBlocks,
    eventCount,
    alerts,
  };
}

export type LightnodeSyncState = "synced" | "catching_up" | "stalled" | "offline";

export interface LightnodeHealthSummary {
  syncState: LightnodeSyncState;
  headerHeight: number;
  networkHeadHeight: number;
  lagHeaders: number;
  verifiedPeers: number;
  networkTag: string | null;
  alerts: string[];
}

export const LIGHTNODE_SYNCED_MAX_LAG_HEADERS = 2;
export const LIGHTNODE_CATCHING_UP_MAX_LAG_HEADERS = 50;

function classifyLightnodeLag(lagHeaders: number): Exclude<LightnodeSyncState, "offline"> {
  if (lagHeaders <= LIGHTNODE_SYNCED_MAX_LAG_HEADERS) {
    return "synced";
  }
  if (lagHeaders <= LIGHTNODE_CATCHING_UP_MAX_LAG_HEADERS) {
    return "catching_up";
  }
  return "stalled";
}

/**
 * Parses `kovanica-lightnode` sync summary JSON (snake_case & camelCase) into a
 * normalized health summary. Raises alerts on `catching_up`, `stalled`, `offline`,
 * or `verifiedPeers === 0`, and fails safe to `syncState: "offline"` on null,
 * primitive, or malformed inputs.
 */
export function parseLightnodeSyncSummary(payload: unknown): LightnodeHealthSummary {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      syncState: "offline",
      headerHeight: 0,
      networkHeadHeight: 0,
      lagHeaders: 0,
      verifiedPeers: 0,
      networkTag: null,
      alerts: ["Lightnode sync summary payload is unavailable or malformed."],
    };
  }

  const record = payload as Record<string, unknown>;
  const rawStatus =
    typeof record.status === "string" ? record.status.trim().toLowerCase() : null;
  const rawSyncState =
    typeof record.sync_state === "string"
      ? record.sync_state.trim().toLowerCase()
      : typeof record.syncState === "string"
        ? record.syncState.trim().toLowerCase()
        : null;

  const headerHeightVal = readNonNegativeInt(record, [
    "header_height",
    "headerHeight",
    "verified_header_height",
    "verifiedHeaderHeight",
    "local_height",
    "localHeight",
  ]);
  const networkHeadHeightVal = readNonNegativeInt(record, [
    "network_head_height",
    "networkHeadHeight",
    "head_height",
    "headHeight",
    "remote_head_height",
    "remoteHeadHeight",
  ]);
  const lagHeadersVal = readNonNegativeInt(record, [
    "lag_headers",
    "lagHeaders",
    "header_lag",
    "headerLag",
  ]);
  const verifiedPeersVal = readNonNegativeInt(record, [
    "verified_peers",
    "verifiedPeers",
    "peer_count",
    "peerCount",
  ]);
  const rawNetworkTag = record.network_tag ?? record.networkTag;
  const networkTag =
    typeof rawNetworkTag === "string" && rawNetworkTag.trim() !== ""
      ? rawNetworkTag.trim()
      : null;

  const hasRecognizedField =
    rawStatus !== null ||
    rawSyncState !== null ||
    headerHeightVal !== null ||
    networkHeadHeightVal !== null ||
    lagHeadersVal !== null ||
    verifiedPeersVal !== null ||
    networkTag !== null;

  if (!hasRecognizedField) {
    return {
      syncState: "offline",
      headerHeight: 0,
      networkHeadHeight: 0,
      lagHeaders: 0,
      verifiedPeers: 0,
      networkTag: null,
      alerts: ["Lightnode sync summary payload is unavailable or malformed."],
    };
  }

  const headerHeight = headerHeightVal ?? 0;
  const networkHeadHeight = networkHeadHeightVal ?? 0;
  const lagHeaders =
    lagHeadersVal !== null ? lagHeadersVal : Math.max(0, networkHeadHeight - headerHeight);
  const verifiedPeers = verifiedPeersVal ?? 0;

  const isOffline =
    rawSyncState === "offline" ||
    rawStatus === "offline" ||
    rawStatus === "down" ||
    rawStatus === "stopped" ||
    rawStatus === "unreachable" ||
    rawStatus === "error";

  let syncState: LightnodeSyncState;
  if (isOffline) {
    syncState = "offline";
  } else if (
    rawSyncState === "synced" ||
    rawSyncState === "catching_up" ||
    rawSyncState === "stalled"
  ) {
    syncState = rawSyncState;
  } else if (rawSyncState === "catching-up" || rawSyncState === "syncing") {
    syncState = "catching_up";
  } else if (
    headerHeightVal !== null ||
    networkHeadHeightVal !== null ||
    lagHeadersVal !== null
  ) {
    syncState = classifyLightnodeLag(lagHeaders);
  } else {
    syncState = "offline";
  }

  const alerts: string[] = [];
  if (syncState === "offline") {
    alerts.push("Lightnode is offline or unreachable.");
  } else if (syncState === "catching_up") {
    alerts.push(
      `Lightnode is catching up by ${lagHeaders} header${lagHeaders === 1 ? "" : "s"} (header=${headerHeight}, head=${networkHeadHeight}).`,
    );
  } else if (syncState === "stalled") {
    alerts.push(
      `Lightnode is stalled behind network head by ${lagHeaders} header${lagHeaders === 1 ? "" : "s"} (header=${headerHeight}, head=${networkHeadHeight}).`,
    );
  }

  if (syncState !== "offline" && verifiedPeers === 0) {
    alerts.push("Lightnode has 0 verified peers.");
  }

  return {
    syncState,
    headerHeight,
    networkHeadHeight,
    lagHeaders,
    verifiedPeers,
    networkTag,
    alerts,
  };
}

export type ClusterOverallStatus = "healthy" | "degraded" | "critical";

export interface ClusterServiceHealthInput {
  status: string;
  alerts?: string[];
}

export interface ClusterReadinessInput {
  rpc?: NodeDoctorSummary;
  indexer?: IndexerHealthSummary;
  stratum?: ClusterServiceHealthInput;
  faucet?: ClusterServiceHealthInput;
}

export interface ClusterReadinessSummary {
  status: ClusterOverallStatus;
  ready: boolean;
  servicesChecked: number;
  alerts: string[];
  headline: string;
}

const CRITICAL_SERVICE_STATUSES = new Set([
  "offline",
  "critical",
  "error",
  "down",
  "stopped",
  "unreachable",
]);

const DEGRADED_SERVICE_STATUSES = new Set([
  "degraded",
  "draining",
  "low_balance",
  "warn",
  "warning",
  "lagging",
  "unhealthy",
]);

const HEALTHY_SERVICE_STATUSES = new Set([
  "healthy",
  "ok",
  "synced",
  "ready",
]);

/**
 * Aggregates provided service readiness summaries (RPC node doctor, indexer,
 * Stratum gateway, and faucet) into a single cluster readiness verdict with
 * ordered, deduplicated, credential-sanitized alerts.
 */
export function aggregateClusterReadiness(
  input: ClusterReadinessInput,
): ClusterReadinessSummary {
  let servicesChecked = 0;
  let hasCritical = false;
  let hasDegraded = false;
  const alerts: string[] = [];
  const seenAlerts = new Set<string>();

  const pushAlert = (raw: string): void => {
    const sanitized = sanitizeRpcText(raw).trim();
    if (!sanitized || seenAlerts.has(sanitized)) {
      return;
    }
    seenAlerts.add(sanitized);
    alerts.push(sanitized);
  };

  if (input.rpc !== undefined) {
    servicesChecked += 1;
    const rpcCritical = !input.rpc.ready || input.rpc.severity === "error";
    const rpcDegraded = !rpcCritical && input.rpc.severity === "warn";
    if (rpcCritical) {
      hasCritical = true;
    } else if (rpcDegraded) {
      hasDegraded = true;
    }

    const beforeCount = alerts.length;
    for (const warning of input.rpc.warnings) {
      pushAlert(warning);
    }
    if (rpcCritical && alerts.length === beforeCount) {
      pushAlert(input.rpc.headline || "RPC node is not ready.");
    }
  }

  if (input.indexer !== undefined) {
    servicesChecked += 1;
    const indexerCritical =
      input.indexer.syncState === "stalled" || input.indexer.syncState === "offline";
    const indexerDegraded = input.indexer.syncState === "lagging";
    if (indexerCritical) {
      hasCritical = true;
    } else if (indexerDegraded) {
      hasDegraded = true;
    }

    const beforeCount = alerts.length;
    for (const alert of input.indexer.alerts) {
      pushAlert(alert);
    }
    if ((indexerCritical || indexerDegraded) && alerts.length === beforeCount) {
      pushAlert(`Indexer is ${input.indexer.syncState}.`);
    }
  }

  const evaluateGenericService = (
    label: string,
    service: ClusterServiceHealthInput | undefined,
  ): void => {
    if (service === undefined) {
      return;
    }
    servicesChecked += 1;
    const normalized = service.status.trim().toLowerCase();
    const isCritical = CRITICAL_SERVICE_STATUSES.has(normalized);
    const isDegraded =
      !isCritical &&
      (DEGRADED_SERVICE_STATUSES.has(normalized) ||
        !HEALTHY_SERVICE_STATUSES.has(normalized));

    if (isCritical) {
      hasCritical = true;
    } else if (isDegraded) {
      hasDegraded = true;
    }

    const beforeCount = alerts.length;
    for (const alert of service.alerts ?? []) {
      pushAlert(alert);
    }
    if (isCritical && alerts.length === beforeCount) {
      pushAlert(`${label} service is ${normalized || "offline"}.`);
    } else if (isDegraded && alerts.length === beforeCount) {
      pushAlert(`${label} service is ${normalized || "degraded"}.`);
    }
  };

  evaluateGenericService("Stratum", input.stratum);
  evaluateGenericService("Faucet", input.faucet);

  if (servicesChecked === 0) {
    return {
      status: "critical",
      ready: false,
      servicesChecked: 0,
      alerts: ["No cluster services provided for readiness check."],
      headline: "Cluster not ready: no services checked.",
    };
  }

  const status: ClusterOverallStatus = hasCritical
    ? "critical"
    : hasDegraded
      ? "degraded"
      : "healthy";
  const ready = status !== "critical";
  const serviceLabel = `${servicesChecked} service${servicesChecked === 1 ? "" : "s"} checked`;
  const alertLabel = `${alerts.length} alert${alerts.length === 1 ? "" : "s"}`;

  let headline: string;
  if (status === "healthy") {
    headline = `Cluster healthy (${serviceLabel})`;
  } else if (status === "degraded") {
    headline = `Cluster degraded (${serviceLabel} · ${alertLabel})`;
  } else {
    headline = `Cluster critical (${serviceLabel} · ${alertLabel})`;
  }

  return {
    status,
    ready,
    servicesChecked,
    alerts,
    headline,
  };
}
