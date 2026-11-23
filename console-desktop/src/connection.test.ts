import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRpcHeaders,
  CANONICAL_NETWORK_TAGS,
  clearSessionRpcBearerToken,
  endpointLine,
  formatNodeDoctorSummary,
  getSessionRpcBearerToken,
  hasSessionRpcBearerToken,
  MAX_FALLBACK_RPC_URLS,
  normalizeRpcBearerToken,
  parseFallbackRpcUrls,
  peerLines,
  probeRpcBatchHealth,
  probeRpcEndpoints,
  rpcBearerTokenStatus,
  rpcFetch,
  sanitizeRpcUrlForDisplay,
  setSessionRpcBearerToken,
  statusRows,
  verifyNetworkTagForChain,
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

describe("single-POST JSON-RPC 2.0 batch health probe and network tag verification", () => {
  afterEach(() => {
    clearSessionRpcBearerToken();
    vi.restoreAllMocks();
  });

  it("verifies canonical network tags for mainnet and testnet (decimal and hex chain IDs)", () => {
    expect(CANONICAL_NETWORK_TAGS).toEqual({
      1: "1-f35df34c92001436",
      2: "2-24cdb5fadd98b207",
    });

    const mainnetOk = verifyNetworkTagForChain(1, "1-f35df34c92001436");
    expect(mainnetOk).toEqual({
      valid: true,
      chainId: 1,
      expectedTag: "1-f35df34c92001436",
      actualTag: "1-f35df34c92001436",
    });

    const testnetHexOk = verifyNetworkTagForChain("0x2", "  2-24cdb5fadd98b207  ");
    expect(testnetHexOk.valid).toBe(true);
    expect(testnetHexOk.chainId).toBe(2);
    expect(testnetHexOk.expectedTag).toBe("2-24cdb5fadd98b207");

    const mismatch = verifyNetworkTagForChain("2", "2-deadbeefdeadbeef");
    expect(mismatch.valid).toBe(false);
    expect(mismatch.reason).toMatch(/mismatch/i);

    const missing = verifyNetworkTagForChain(1, "");
    expect(missing.valid).toBe(false);
    expect(missing.reason).toMatch(/missing/i);

    const unknownChain = verifyNetworkTagForChain(99, "99-abc");
    expect(unknownChain.valid).toBe(false);
    expect(unknownChain.reason).toMatch(/No canonical network tag/i);

    const invalidChain = verifyNetworkTagForChain("not-a-chain", "1-f35df34c92001436");
    expect(invalidChain.valid).toBe(false);
    expect(invalidChain.chainId).toBeNull();
  });

  it("sends a single-POST JSON-RPC 2.0 batch and correlates out-of-order response IDs", async () => {
    let callCount = 0;
    const mockFetch: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      expect(init?.method).toBe("POST");
      const batch = JSON.parse(String(init?.body ?? "[]")) as Array<{
        jsonrpc: string;
        id: number;
        method: string;
        params: unknown[];
      }>;
      expect(Array.isArray(batch)).toBe(true);
      expect(batch).toEqual([
        { jsonrpc: "2.0", id: 1, method: "kovanica_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "kovanica_blockNumber", params: [] },
        { jsonrpc: "2.0", id: 3, method: "kovanica_estimateFee", params: [] },
      ]);

      // Return responses intentionally out of order
      return new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 3, result: "1250" },
          { jsonrpc: "2.0", id: 1, result: "0x2" },
          { jsonrpc: "2.0", id: 2, result: "0x4b0" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await probeRpcBatchHealth(
      "https://alice:supersecret@rpc-batch.example:8545",
      mockFetch,
    );

    expect(callCount).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.batchSupported).toBe(true);
    expect(result.chainId).toBe("0x2");
    expect(result.blockHeight).toBe("0x4b0");
    expect(result.feeRate).toBe("1250");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.url).toBe("https://rpc-batch.example:8545");
    expect(result.url).not.toContain("supersecret");
    expect(result.error).toBeUndefined();
  });

  it("reports partial item errors while preserving batchSupported=true and successful fields", async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 1, result: "2" },
          { jsonrpc: "2.0", id: 2, result: "9901" },
          {
            jsonrpc: "2.0",
            id: 3,
            error: {
              code: -32000,
              message: "fee oracle unavailable for https://bob:hunter2@rpc.example Bearer tok_secret_123",
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await probeRpcBatchHealth("https://rpc.example", mockFetch);

    expect(result.ok).toBe(false);
    expect(result.batchSupported).toBe(true);
    expect(result.chainId).toBe("2");
    expect(result.blockHeight).toBe("9901");
    expect(result.feeRate).toBeUndefined();
    expect(result.error).toContain("kovanica_estimateFee");
    expect(result.error).not.toContain("hunter2");
    expect(result.error).not.toContain("tok_secret_123");
    expect(result.error).toContain("[REDACTED]");
  });

  it("gracefully reports batchSupported=false when a legacy node returns a non-array error", async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Batch requests are not supported on legacy node" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await probeRpcBatchHealth("https://legacy.example:8545", mockFetch);

    expect(result.ok).toBe(false);
    expect(result.batchSupported).toBe(false);
    expect(result.error).toContain("Batch requests are not supported");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sanitizes credentials on network failures and rejects non-http URLs", async () => {
    const mockThrowFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED https://ops:s3cr3t@node.example:8545 Bearer live_key_999");
    }) as typeof fetch;

    const failed = await probeRpcBatchHealth(
      "https://ops:s3cr3t@node.example:8545",
      mockThrowFetch,
    );
    expect(failed.ok).toBe(false);
    expect(failed.batchSupported).toBe(false);
    expect(failed.url).toBe("https://node.example:8545");
    expect(failed.url).not.toContain("s3cr3t");
    expect(failed.error).not.toContain("s3cr3t");
    expect(failed.error).not.toContain("live_key_999");
    expect(failed.error).toContain("[REDACTED]");

    const invalid = await probeRpcBatchHealth("ws://node.example:8546", mockThrowFetch);
    expect(invalid.ok).toBe(false);
    expect(invalid.batchSupported).toBe(false);
    expect(invalid.error).toMatch(/http/i);
  });

  it("formats NodeDoctorSummary for healthy mainnet/testnet nodes, missing tags, tag mismatches, and failed probes", () => {
    const mainnetOk = formatNodeDoctorSummary(
      {
        url: "https://rpc-mainnet.kovanica.online:8545",
        ok: true,
        chainId: "1",
        blockHeight: "1024",
        feeRate: "500",
        batchSupported: true,
        latencyMs: 42,
      },
      "1-f35df34c92001436",
    );
    expect(mainnetOk).toEqual({
      ready: true,
      severity: "ok",
      canonicalTagValid: true,
      batchSupported: true,
      latencyMs: 42,
      headline: "Node ready (https://rpc-mainnet.kovanica.online:8545) · chainId=1 · height=1024 · 42ms",
      warnings: [],
    });

    const testnetHexOk = formatNodeDoctorSummary(
      {
        url: "https://rpc-testnet.kovanica.online:8545",
        ok: true,
        chainId: "0x2",
        blockHeight: "0x4b0",
        feeRate: "1250",
        batchSupported: true,
        latencyMs: 18,
      },
      "2-24cdb5fadd98b207",
    );
    expect(testnetHexOk.ready).toBe(true);
    expect(testnetHexOk.severity).toBe("ok");
    expect(testnetHexOk.canonicalTagValid).toBe(true);
    expect(testnetHexOk.warnings).toEqual([]);

    // Omitted network tag -> reachable with warning
    const missingTag = formatNodeDoctorSummary({
      url: "https://rpc-testnet.kovanica.online:8545",
      ok: true,
      chainId: "2",
      blockHeight: "9901",
      feeRate: "1000",
      batchSupported: true,
      latencyMs: 25,
    });
    expect(missingTag.ready).toBe(true);
    expect(missingTag.severity).toBe("warn");
    expect(missingTag.canonicalTagValid).toBe(false);
    expect(missingTag.batchSupported).toBe(true);
    expect(missingTag.warnings.some((w) => /missing network tag/i.test(w))).toBe(true);

    // Explicit canonical tag mismatch -> not ready (error)
    const mismatch = formatNodeDoctorSummary(
      {
        url: "https://rpc-testnet.kovanica.online:8545",
        ok: true,
        chainId: "2",
        blockHeight: "9901",
        feeRate: "1000",
        batchSupported: true,
        latencyMs: 30,
      },
      "2-deadbeefdeadbeef",
    );
    expect(mismatch.ready).toBe(false);
    expect(mismatch.severity).toBe("error");
    expect(mismatch.canonicalTagValid).toBe(false);
    expect(mismatch.headline).toMatch(/mismatch/i);
    expect(mismatch.warnings.some((w) => /mismatch/i.test(w))).toBe(true);

    // Failed legacy / unreachable probe -> error with credential sanitization
    const failed = formatNodeDoctorSummary(
      {
        url: "https://ops:supersecret@legacy.example:8545",
        ok: false,
        batchSupported: false,
        latencyMs: 120,
        error: "ECONNREFUSED https://ops:supersecret@legacy.example:8545 Bearer tok_999",
      },
      "2-24cdb5fadd98b207",
    );
    expect(failed.ready).toBe(false);
    expect(failed.severity).toBe("error");
    expect(failed.canonicalTagValid).toBe(false);
    expect(failed.batchSupported).toBe(false);
    expect(failed.latencyMs).toBe(120);
    expect(failed.headline).not.toContain("supersecret");
    expect(failed.headline).not.toContain("tok_999");
    expect(failed.warnings.join(" ")).not.toContain("supersecret");
    expect(failed.warnings.join(" ")).not.toContain("tok_999");
    expect(failed.warnings.some((w) => /batch/i.test(w))).toBe(true);
  });
});
