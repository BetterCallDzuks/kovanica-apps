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

export interface RpcProbeResult {
  url: string;
  ok: boolean;
  chainId?: string;
  latencyMs: number;
  error?: string;
}

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
