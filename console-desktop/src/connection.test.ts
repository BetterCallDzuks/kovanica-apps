import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRpcHeaders,
  clearSessionRpcBearerToken,
  endpointLine,
  getSessionRpcBearerToken,
  hasSessionRpcBearerToken,
  normalizeRpcBearerToken,
  peerLines,
  rpcBearerTokenStatus,
  rpcFetch,
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
