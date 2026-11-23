import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRpcHeaders,
  clearSessionRpcBearerToken,
  endpointLine,
  getSessionRpcBearerToken,
  hasSessionRpcBearerToken,
  MAX_FALLBACK_RPC_URLS,
  normalizeRpcBearerToken,
  parseFallbackRpcUrls,
  peerLines,
  probeRpcEndpoints,
  rpcBearerTokenStatus,
  rpcFetch,
  sanitizeRpcUrlForDisplay,
  setSessionRpcBearerToken,
  statusRows,
  type NodeStatus,
} from "./connection";

function status(overrides: Partial<NodeStatus> = {}): NodeStatus {
  return {
    chainId: "2",
    chainNote: "Proven by commit seals.",
    height: "1200",
    leaderRound: "3600",
    epoch: "0",
    peerCount: "2",
    peers: [{ peerId: "12D3KooWexample", reportedTipRound: "3601" }],
    ...overrides,
  };
}

describe("connection screen", () => {
  it("shows chain id, height, leader round, epoch, and peers as text", () => {
    const rows = statusRows(status());
    expect(rows.map((row) => row.label)).toEqual([
      "Chain id",
      "Chain check",
      "Height (reported by node)",
      "Leader round",
      "Epoch",
      "Peers (reported by node)",
    ]);
    expect(rows.map((row) => row.value)).toEqual([
      "2",
      "Proven by commit seals.",
      "1200",
      "3600",
      "0",
      "2",
    ]);
  });

  it("keeps a height that does not fit in a safe integer", () => {
    const height = "9007199254740993";
    const rows = statusRows(status({ height }));
    expect(rows.find((row) => row.label === "Height (reported by node)")?.value).toBe(height);
  });

  it("does not invent a chain id or a leader round", () => {
    const rows = statusRows(
      status({
        chainId: null,
        chainNote: "The node has not sealed a leader yet, so the chain id is not proven.",
        leaderRound: null,
        epoch: null,
        peers: [],
      }),
    );
    expect(rows.find((row) => row.label === "Chain id")?.value).toBe("Unknown");
    expect(rows.find((row) => row.label === "Leader round (reported by node)")?.value).toBe("—");
    expect(rows.find((row) => row.label === "Epoch (reported by node)")?.value).toBe("—");
    expect(rows.find((row) => row.label === "Height (reported by node)")?.value).toBe("1200");
    expect(rows.find((row) => row.label === "Peers (reported by node)")?.value).toBe("2");
    expect(peerLines([])).toEqual(["No connected peers"]);
  });

  it("prints a peer tip only when the node reported one", () => {
    expect(
      peerLines([
        { peerId: "12D3KooWexample", reportedTipRound: "3601" },
        { peerId: "12D3KooWother", reportedTipRound: null },
      ]),
    ).toEqual(["12D3KooWexample · tip 3601", "12D3KooWother"]);
  });

  it("names the endpoint from the label the backend already chose", () => {
    expect(endpointLine("rpc-testnet.kovanica.online")).toBe(
      "Talking to rpc-testnet.kovanica.online",
    );
  });
});

describe("optional RPC bearer token", () => {
  afterEach(() => {
    clearSessionRpcBearerToken();
    vi.restoreAllMocks();
  });

  it("keeps the bearer token session-scoped in memory and normalizes whitespace", () => {
    expect(getSessionRpcBearerToken()).toBeNull();
    expect(hasSessionRpcBearerToken()).toBe(false);

    setSessionRpcBearerToken("  secret-rpc-token-123  ");
    expect(getSessionRpcBearerToken()).toBe("secret-rpc-token-123");
    expect(hasSessionRpcBearerToken()).toBe(true);

    setSessionRpcBearerToken("   ");
    expect(getSessionRpcBearerToken()).toBeNull();
    expect(hasSessionRpcBearerToken()).toBe(false);

    expect(() => normalizeRpcBearerToken("bad\ntoken")).toThrow(/control characters/i);
  });

  it("attaches Authorization: Bearer header only when a token is configured", () => {
    const withoutToken = buildRpcHeaders();
    expect(withoutToken).toEqual({ "Content-Type": "application/json" });
    expect("Authorization" in withoutToken).toBe(false);

    setSessionRpcBearerToken("session-token-xyz");
    const withSession = buildRpcHeaders({ "X-Client": "console" });
    expect(withSession).toEqual({
      "Content-Type": "application/json",
      "X-Client": "console",
      Authorization: "Bearer session-token-xyz",
    });

    const withOverride = buildRpcHeaders(undefined, "override-token");
    expect(withOverride.Authorization).toBe("Bearer override-token");

    const clearedOverride = buildRpcHeaders(undefined, null);
    expect("Authorization" in clearedOverride).toBe(false);
  });

  it("sends Authorization: Bearer on rpcFetch when configured and never logs the token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const secret = "kvnc_live_super_secret_token";
    setSessionRpcBearerToken(secret);

    await rpcFetch("https://rpc.example", { jsonrpc: "2.0", id: 1, method: "kovanica_chainId", params: [] }, {
      fetchImpl: mockFetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://rpc.example");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)?.Authorization).toBe(
      `Bearer ${secret}`,
    );

    // Status text never exposes the raw token
    expect(rpcBearerTokenStatus()).not.toContain(secret);
    expect(rpcBearerTokenStatus()).toContain("configured");

    // Token is never logged to console
    for (const spy of [logSpy, infoSpy, warnSpy, errorSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }

    clearSessionRpcBearerToken();
    await rpcFetch("https://rpc.example", { jsonrpc: "2.0", id: 2, method: "kovanica_chainId", params: [] }, {
      fetchImpl: mockFetch,
    });
    expect(calls).toHaveLength(2);
    expect("Authorization" in ((calls[1]?.init?.headers as Record<string, string>) ?? {})).toBe(
      false,
    );
  });
});

describe("fallback RPC URL parsing and latency probe", () => {
  afterEach(() => {
    clearSessionRpcBearerToken();
    vi.restoreAllMocks();
  });

  it("parses newline and comma separated URLs, validates http/https, deduplicates, and caps at 8", () => {
    const raw = [
      "  https://rpc1.kovanica.online  , http://127.0.0.1:8545",
      "https://rpc1.kovanica.online/",
      "ws://invalid.example:8546",
      "ftp://invalid.example",
      "not a url",
      "https://rpc2.kovanica.online",
      "https://rpc3.kovanica.online, https://rpc4.kovanica.online",
      "https://rpc5.kovanica.online",
      "https://rpc6.kovanica.online",
      "https://rpc7.kovanica.online",
      "https://rpc8.kovanica.online",
      "https://rpc9.kovanica.online",
    ].join("\n");

    const parsed = parseFallbackRpcUrls(raw);
    expect(parsed).toHaveLength(MAX_FALLBACK_RPC_URLS);
    expect(parsed).toEqual([
      "https://rpc1.kovanica.online",
      "http://127.0.0.1:8545",
      "https://rpc2.kovanica.online",
      "https://rpc3.kovanica.online",
      "https://rpc4.kovanica.online",
      "https://rpc5.kovanica.online",
      "https://rpc6.kovanica.online",
      "https://rpc7.kovanica.online",
    ]);
    expect(parseFallbackRpcUrls("")).toEqual([]);
    expect(parseFallbackRpcUrls("   \n , \t ")).toEqual([]);
  });

  it("probes RPC endpoints in parallel, measures latency, and sanitizes credentials", async () => {
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      expect(body.method).toBe("kovanica_chainId");

      if (url.includes("rpc-ok.example")) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("rpc-http-err.example")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      if (url.includes("rpc-json-err.example")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "upstream auth failed for https://alice:s3cr3t@rpc-json-err.example" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`connect ECONNREFUSED https://bob:hunter2@rpc-down.example:8545`);
    }) as typeof fetch;

    const results = await probeRpcEndpoints(
      [
        "https://alice:topsecret@rpc-ok.example:8545",
        "https://rpc-http-err.example",
        "https://rpc-json-err.example",
        "https://bob:hunter2@rpc-down.example:8545",
      ],
      mockFetch,
    );

    expect(results).toHaveLength(4);

    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.chainId).toBe("0x2");
    expect(results[0]?.url).toBe("https://rpc-ok.example:8545");
    expect(results[0]?.url).not.toContain("topsecret");
    expect(results[0]?.latencyMs).toBeGreaterThanOrEqual(0);

    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.error).toBe("HTTP 503");

    expect(results[2]?.ok).toBe(false);
    expect(results[2]?.error).not.toContain("s3cr3t");
    expect(results[2]?.error).toContain("[REDACTED]@");

    expect(results[3]?.ok).toBe(false);
    expect(results[3]?.url).toBe("https://rpc-down.example:8545");
    expect(results[3]?.url).not.toContain("hunter2");
    expect(results[3]?.error).not.toContain("hunter2");
    expect(results[3]?.error).toContain("[REDACTED]@");

    expect(sanitizeRpcUrlForDisplay("https://user:pass@rpc.example:8545/v1")).toBe(
      "https://rpc.example:8545/v1",
    );
    expect(await probeRpcEndpoints([], mockFetch)).toEqual([]);
  });
});
