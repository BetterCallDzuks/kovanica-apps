// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConsoleStratumDiagnostics,
  DEFAULT_STRATUM_HEALTH_URL,
  deriveStratumWorkersUrl,
  evaluateConsoleStratumAlerts,
  fetchStratumHealth,
  fetchStratumWorkers,
  formatUptime,
  normalizeStratumHealthUrl,
  parseStratumHealth,
  parseStratumWorkers,
  parseStratumWorkersSummary,
  stratumHealthRows,
} from "./stratum";
import { mountStratumPanel } from "./stratum-panel";

function sampleHealthPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "healthy",
    uptime_seconds: 3725,
    active_connections: 4,
    current_job_id: "job-00042",
    tls_enabled: true,
    timestamp: "2026-11-22T23:30:00Z",
    ...overrides,
  };
}

function sampleWorkersPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active_workers: 2,
    vardiff_enabled: true,
    workers: [
      {
        session_id: 1,
        worker_name: "rig-alpha",
        authorized: true,
        difficulty: 4.5,
        shares_accepted: 128,
        shares_rejected: 2,
        connected_secs: 3661,
      },
      {
        session_id: 2,
        worker_name: "rig-beta",
        authorized: true,
        difficulty: 2,
        shares_accepted: 64,
        shares_rejected: 0,
        connected_secs: 185,
      },
    ],
    timestamp: 1700000000,
    ...overrides,
  };
}

function mountFixture(): void {
  document.body.innerHTML = `
    <section id="stratum-panel" class="panel">
      <div class="stratum-header">
        <h2 id="stratum-heading">Stratum Gateway Health &amp; Telemetry</h2>
        <span id="stratum-alert-badge" class="stratum-alert-badge" role="status" hidden></span>
      </div>
      <input id="stratum-url" type="text" value="http://127.0.0.1:9100/health" />
      <button id="stratum-save" type="button">Save</button>
      <button id="stratum-reset" type="button">Use default</button>
      <button id="stratum-refresh" type="button">Refresh</button>
      <button id="stratum-copy-diagnostics" type="button">Copy Diagnostics JSON</button>
      <p id="stratum-state" class="muted"></p>
      <div id="stratum-alerts" class="stratum-alerts" role="status" hidden></div>
      <p id="stratum-diagnostics-status" class="muted" hidden></p>
      <p id="stratum-error" class="error" role="alert" hidden></p>
      <dl id="stratum-rows" class="readout"></dl>
      <div id="stratum-workers-section" hidden>
        <h3>Active Workers</h3>
        <p id="stratum-workers-empty" class="muted">No active workers connected.</p>
        <table id="stratum-workers-table" class="workers-table" hidden>
          <thead>
            <tr>
              <th scope="col">Worker</th>
              <th scope="col">Difficulty</th>
              <th scope="col">Accepted</th>
              <th scope="col">Rejected</th>
              <th scope="col">Connected</th>
            </tr>
          </thead>
          <tbody id="stratum-workers-body"></tbody>
        </table>
      </div>
    </section>
  `;
}

describe("stratum health URL & schema helpers", () => {
  it("normalizes loopback URLs and defaults empty input to http://127.0.0.1:9100/health", () => {
    expect(normalizeStratumHealthUrl("")).toBe(DEFAULT_STRATUM_HEALTH_URL);
    expect(normalizeStratumHealthUrl("   ")).toBe(DEFAULT_STRATUM_HEALTH_URL);
    expect(normalizeStratumHealthUrl("http://127.0.0.1:9100")).toBe("http://127.0.0.1:9100/health");
    expect(normalizeStratumHealthUrl("http://localhost:9200/health")).toBe("http://localhost:9200/health");
    expect(normalizeStratumHealthUrl("http://[::1]:9100/health")).toBe("http://[::1]:9100/health");
  });

  it("rejects non-loopback hosts and invalid schemes", () => {
    expect(() => normalizeStratumHealthUrl("http://192.168.1.5:9100/health")).toThrow(/loopback/i);
    expect(() => normalizeStratumHealthUrl("https://example.com/health")).toThrow(/loopback/i);
    expect(() => normalizeStratumHealthUrl("ftp://127.0.0.1:9100/health")).toThrow(/http/i);
    expect(() => normalizeStratumHealthUrl("not a url")).toThrow(/valid Stratum health URL/i);
  });

  it("parses valid kovanica-stratum /health JSON including nullable current_job_id", () => {
    const withJob = parseStratumHealth(sampleHealthPayload());
    expect(withJob).toEqual({
      status: "healthy",
      uptimeSeconds: 3725,
      activeConnections: 4,
      currentJobId: "job-00042",
      tlsEnabled: true,
      timestamp: "2026-11-22T23:30:00Z",
    });

    const withoutJob = parseStratumHealth(sampleHealthPayload({ current_job_id: null, tls_enabled: false }));
    expect(withoutJob.currentJobId).toBeNull();
    expect(withoutJob.tlsEnabled).toBe(false);
  });

  it("rejects malformed /health payloads", () => {
    expect(() => parseStratumHealth(null)).toThrow(/JSON object/i);
    expect(() => parseStratumHealth(sampleHealthPayload({ status: "" }))).toThrow(/status/i);
    expect(() => parseStratumHealth(sampleHealthPayload({ uptime_seconds: -5 }))).toThrow(/uptime_seconds/i);
    expect(() => parseStratumHealth(sampleHealthPayload({ active_connections: "4" }))).toThrow(/active_connections/i);
    expect(() => parseStratumHealth(sampleHealthPayload({ tls_enabled: "yes" }))).toThrow(/tls_enabled/i);
    expect(() => parseStratumHealth(sampleHealthPayload({ timestamp: "" }))).toThrow(/timestamp/i);
  });

  it("formats uptime and display rows", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(65)).toBe("1m 5s");
    expect(formatUptime(3725)).toBe("1h 2m 5s");
    expect(formatUptime(90_061)).toBe("1d 1h 1m 1s");

    const rows = stratumHealthRows(parseStratumHealth(sampleHealthPayload()));
    expect(rows).toEqual([
      { label: "Status", value: "healthy" },
      { label: "Uptime", value: "1h 2m 5s (3725s)" },
      { label: "Active connections", value: "4" },
      { label: "Current job ID", value: "job-00042" },
      { label: "TLS", value: "Enabled" },
      { label: "Timestamp", value: "2026-11-22T23:30:00Z" },
    ]);
  });

  it("fetches /health and surfaces HTTP and network errors cleanly", async () => {
    const okFetch = vi.fn(async () =>
      new Response(JSON.stringify(sampleHealthPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const snap = await fetchStratumHealth("http://127.0.0.1:9100/health", { fetchImpl: okFetch });
    expect(snap.status).toBe("healthy");
    expect(snap.activeConnections).toBe(4);

    const busyFetch = vi.fn(async () => new Response("too many requests", { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchStratumHealth("http://127.0.0.1:9100/health", { fetchImpl: busyFetch }),
    ).rejects.toThrow(/HTTP 503/);

    const offlineFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(
      fetchStratumHealth("http://127.0.0.1:9100/health", { fetchImpl: offlineFetch }),
    ).rejects.toThrow(/Failed to fetch/);
  });

  it("derives loopback /workers URL from /health URL and rejects non-loopback hosts", () => {
    expect(deriveStratumWorkersUrl("")).toBe("http://127.0.0.1:9100/workers");
    expect(deriveStratumWorkersUrl("http://127.0.0.1:9100/health")).toBe("http://127.0.0.1:9100/workers");
    expect(deriveStratumWorkersUrl("http://localhost:9200")).toBe("http://localhost:9200/workers");
    expect(deriveStratumWorkersUrl("http://[::1]:9100/health")).toBe("http://[::1]:9100/workers");
    expect(() => deriveStratumWorkersUrl("http://192.168.1.5:9100/health")).toThrow(/loopback/i);
  });

  it("parses valid kovanica-stratum /workers JSON and rejects malformed items", () => {
    const parsed = parseStratumWorkers(sampleWorkersPayload());
    expect(parsed.active_workers).toBe(2);
    expect(parsed.vardiff_enabled).toBe(true);
    expect(parsed.workers).toEqual([
      {
        session_id: 1,
        worker_name: "rig-alpha",
        authorized: true,
        difficulty: 4.5,
        shares_accepted: 128,
        shares_rejected: 2,
        connected_secs: 3661,
      },
      {
        session_id: 2,
        worker_name: "rig-beta",
        authorized: true,
        difficulty: 2,
        shares_accepted: 64,
        shares_rejected: 0,
        connected_secs: 185,
      },
    ]);

    const fromString = parseStratumWorkers(JSON.stringify(sampleWorkersPayload({ workers: [] })));
    expect(fromString.workers).toEqual([]);

    expect(() => parseStratumWorkers(null)).toThrow(/JSON object/i);
    expect(() => parseStratumWorkers({ workers: "nope" })).toThrow(/workers array/i);
    expect(() =>
      parseStratumWorkers({
        workers: [{ worker_name: "", difficulty: 1, shares_accepted: 0, shares_rejected: 0, connected_secs: 10 }],
      }),
    ).toThrow(/worker_name/i);
    expect(() =>
      parseStratumWorkers({
        workers: [{ worker_name: "rig1", difficulty: -1, shares_accepted: 0, shares_rejected: 0, connected_secs: 10 }],
      }),
    ).toThrow(/difficulty/i);
    expect(() =>
      parseStratumWorkers({
        workers: [{ worker_name: "rig1", difficulty: 1, shares_accepted: -2, shares_rejected: 0, connected_secs: 10 }],
      }),
    ).toThrow(/shares_accepted/i);
    expect(() =>
      parseStratumWorkers({
        workers: [{ worker_name: "rig1", difficulty: 1, shares_accepted: 0, shares_rejected: -1, connected_secs: 10 }],
      }),
    ).toThrow(/shares_rejected/i);
    expect(() =>
      parseStratumWorkers({
        workers: [{ worker_name: "rig1", difficulty: 1, shares_accepted: 0, shares_rejected: 0, connected_secs: -5 }],
      }),
    ).toThrow(/connected_secs/i);
  });

  it("fetches /workers via derived loopback URL", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:9100/workers");
      return new Response(JSON.stringify(sampleWorkersPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const report = await fetchStratumWorkers("http://127.0.0.1:9100/health", mockFetch);
    expect(report.workers).toHaveLength(2);
    expect(report.workers[0]?.worker_name).toBe("rig-alpha");
  });

  it("parseStratumWorkersSummary parses server summary and normalizes per-worker table rows", () => {
    const payload = {
      active_workers: 2,
      vardiff_enabled: true,
      banned_ips: 3,
      summary: {
        min_difficulty: 2,
        median_difficulty: 3.25,
        max_difficulty: 4.5,
        total_accepted_shares: 192,
        total_rejected_shares: 8,
        total_stale_shares: 5,
        stale_ratio: 0.025,
      },
      workers: [
        {
          session_id: 1,
          worker_name: "rig-alpha",
          authorized: true,
          extranonce_subscribed: true,
          difficulty: 4.5,
          shares_accepted: 128,
          shares_rejected: 6,
          shares_stale: 4,
          connected_secs: 3661,
          idle_secs: 12,
        },
        {
          session_id: 2,
          worker_name: "rig-beta",
          authorized: true,
          extranonce_subscribed: false,
          difficulty: 2,
          shares_accepted: 64,
          shares_rejected: 2,
          shares_stale: 1,
          connected_secs: 185,
          idle_secs: 0,
        },
      ],
      timestamp: 1700000123,
    };

    const parsed = parseStratumWorkersSummary(payload);
    expect(parsed.summarySource).toBe("server");
    expect(parsed.activeWorkers).toBe(2);
    expect(parsed.vardiffEnabled).toBe(true);
    expect(parsed.bannedIps).toBe(3);
    expect(parsed.timestamp).toBe(1700000123);
    expect(parsed.summary).toEqual({
      minDifficulty: 2,
      medianDifficulty: 3.25,
      maxDifficulty: 4.5,
      totalAcceptedShares: 192,
      totalRejectedShares: 8,
      totalStaleShares: 5,
      staleRatio: 0.025,
    });
    expect(parsed.rows).toEqual([
      {
        sessionId: 1,
        workerName: "rig-alpha",
        authorized: true,
        extranonceSubscribed: true,
        difficulty: 4.5,
        sharesAccepted: 128,
        sharesRejected: 6,
        sharesStale: 4,
        staleRatio: 4 / 134,
        connectedSecs: 3661,
        connectedLabel: "1h 1m 1s (3661s)",
        idleSecs: 12,
        idleLabel: "12s (12s)",
      },
      {
        sessionId: 2,
        workerName: "rig-beta",
        authorized: true,
        extranonceSubscribed: false,
        difficulty: 2,
        sharesAccepted: 64,
        sharesRejected: 2,
        sharesStale: 1,
        staleRatio: 1 / 66,
        connectedSecs: 185,
        connectedLabel: "3m 5s (185s)",
        idleSecs: 0,
        idleLabel: "0s (0s)",
      },
    ]);

    // Accepts JSON string payloads directly
    const fromJson = parseStratumWorkersSummary(JSON.stringify(payload));
    expect(fromJson).toEqual(parsed);
  });

  it("parseStratumWorkersSummary computes fallback summary for legacy nodes omitting summary", () => {
    // Even number of workers (2 workers: diff 2 and 4.5 -> median 3.25)
    const evenFallback = parseStratumWorkersSummary(sampleWorkersPayload());
    expect(evenFallback.summarySource).toBe("computed");
    expect(evenFallback.summary).toEqual({
      minDifficulty: 2,
      medianDifficulty: 3.25,
      maxDifficulty: 4.5,
      totalAcceptedShares: 192,
      totalRejectedShares: 2,
      totalStaleShares: 0,
      staleRatio: 0,
    });
    expect(evenFallback.rows[0]?.idleSecs).toBeNull();
    expect(evenFallback.rows[0]?.idleLabel).toBe("—");

    // Odd number of workers with shares_stale present
    const oddFallback = parseStratumWorkersSummary({
      active_workers: 3,
      vardiff_enabled: true,
      workers: [
        {
          worker_name: "rig-c",
          difficulty: 16,
          shares_accepted: 50,
          shares_rejected: 10,
          shares_stale: 5,
          connected_secs: 600,
        },
        {
          worker_name: "rig-a",
          difficulty: 1,
          shares_accepted: 20,
          shares_rejected: 0,
          shares_stale: 0,
          connected_secs: 120,
        },
        {
          worker_name: "rig-b",
          difficulty: 4,
          shares_accepted: 15,
          shares_rejected: 5,
          shares_stale: 5,
          connected_secs: 300,
        },
      ],
    });
    expect(oddFallback.summarySource).toBe("computed");
    expect(oddFallback.summary).toEqual({
      minDifficulty: 1,
      medianDifficulty: 4,
      maxDifficulty: 16,
      totalAcceptedShares: 85,
      totalRejectedShares: 15,
      totalStaleShares: 10,
      staleRatio: 0.1,
    });

    // Empty worker list -> null difficulties and 0 stale ratio
    const emptyFallback = parseStratumWorkersSummary({
      active_workers: 0,
      vardiff_enabled: false,
      workers: [],
    });
    expect(emptyFallback.summarySource).toBe("computed");
    expect(emptyFallback.summary).toEqual({
      minDifficulty: null,
      medianDifficulty: null,
      maxDifficulty: null,
      totalAcceptedShares: 0,
      totalRejectedShares: 0,
      totalStaleShares: 0,
      staleRatio: 0,
    });
    expect(emptyFallback.rows).toEqual([]);
  });

  it("parseStratumWorkersSummary rejects malformed summary and shares_stale fields", () => {
    expect(() =>
      parseStratumWorkersSummary(sampleWorkersPayload({ summary: "bad" })),
    ).toThrow(/summary must be a JSON object/i);
    expect(() =>
      parseStratumWorkersSummary(
        sampleWorkersPayload({
          summary: {
            min_difficulty: -1,
            median_difficulty: 2,
            max_difficulty: 4,
            total_accepted_shares: 10,
            total_rejected_shares: 0,
            total_stale_shares: 0,
            stale_ratio: 0,
          },
        }),
      ),
    ).toThrow(/min_difficulty/i);
    expect(() =>
      parseStratumWorkersSummary(
        sampleWorkersPayload({
          summary: {
            min_difficulty: 1,
            median_difficulty: 2,
            max_difficulty: 4,
            total_accepted_shares: 10,
            total_rejected_shares: 0,
            total_stale_shares: 0,
            stale_ratio: 1.5,
          },
        }),
      ),
    ).toThrow(/stale_ratio/i);
    expect(() =>
      parseStratumWorkersSummary({
        workers: [
          {
            worker_name: "rig-1",
            difficulty: 1,
            shares_accepted: 10,
            shares_rejected: 1,
            shares_stale: -1,
            connected_secs: 60,
          },
        ],
      }),
    ).toThrow(/shares_stale/i);
  });
});

describe("Stratum Gateway Health & Telemetry DOM panel", () => {
  beforeEach(() => {
    localStorage.clear();
    mountFixture();
  });

  it("renders telemetry rows and active workers table on manual refresh, and transitions to offline state on error", async () => {
    let online = true;
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!online) throw new Error("Connection refused");
      const url = String(input);
      if (url.endsWith("/workers")) {
        return new Response(JSON.stringify(sampleWorkersPayload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(sampleHealthPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const panel = mountStratumPanel({ fetchImpl: mockFetch });
    expect(panel).not.toBeNull();
    expect(panel!.getState().kind).toBe("idle");

    await panel!.refresh();
    expect(panel!.getState().kind).toBe("online");
    expect(document.querySelector("#stratum-state")?.textContent).toContain("Online (healthy)");
    expect(document.querySelector<HTMLParagraphElement>("#stratum-error")?.hidden).toBe(true);
    const terms = Array.from(document.querySelectorAll("#stratum-rows dt")).map((el) => el.textContent);
    const values = Array.from(document.querySelectorAll("#stratum-rows dd")).map((el) => el.textContent);
    expect(terms).toEqual(["Status", "Uptime", "Active connections", "Current job ID", "TLS", "Timestamp"]);
    expect(values).toEqual([
      "healthy",
      "1h 2m 5s (3725s)",
      "4",
      "job-00042",
      "Enabled",
      "2026-11-22T23:30:00Z",
    ]);

    expect(document.querySelector<HTMLElement>("#stratum-workers-section")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#stratum-workers-empty")?.hidden).toBe(true);
    expect(document.querySelector<HTMLTableElement>("#stratum-workers-table")?.hidden).toBe(false);
    const workerRows = Array.from(document.querySelectorAll("#stratum-workers-body tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent),
    );
    expect(workerRows).toEqual([
      ["rig-alpha", "4.5", "128", "2", "1h 1m 1s (3661s)"],
      ["rig-beta", "2", "64", "0", "3m 5s (185s)"],
    ]);

    // Simulate gateway going offline
    online = false;
    await panel!.refresh();
    expect(panel!.getState().kind).toBe("offline");
    expect(document.querySelector("#stratum-state")?.textContent).toContain("Offline");
    expect(document.querySelector<HTMLParagraphElement>("#stratum-error")?.hidden).toBe(false);
    expect(document.querySelector("#stratum-error")?.textContent).toContain("Connection refused");
    expect(document.querySelectorAll("#stratum-rows dt")).toHaveLength(0);
    expect(document.querySelectorAll("#stratum-workers-body tr")).toHaveLength(0);
    expect(document.querySelector<HTMLElement>("#stratum-workers-section")?.hidden).toBe(true);
  });

  it("gracefully degrades to an empty worker list when /workers returns 404 or error while /health succeeds", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/workers")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(JSON.stringify(sampleHealthPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const panel = mountStratumPanel({ fetchImpl: mockFetch });
    await panel!.refresh();

    const state = panel!.getState();
    expect(state.kind).toBe("online");
    if (state.kind === "online") {
      expect(state.health.status).toBe("healthy");
      expect(state.workers).toEqual([]);
    }
    expect(document.querySelector("#stratum-state")?.textContent).toContain("Online (healthy)");
    expect(document.querySelector<HTMLParagraphElement>("#stratum-error")?.hidden).toBe(true);
    expect(document.querySelectorAll("#stratum-rows dt")).toHaveLength(6);
    expect(document.querySelector<HTMLElement>("#stratum-workers-section")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#stratum-workers-empty")?.hidden).toBe(false);
    expect(document.querySelector<HTMLTableElement>("#stratum-workers-table")?.hidden).toBe(true);
    expect(document.querySelectorAll("#stratum-workers-body tr")).toHaveLength(0);
  });

  it("rejects non-loopback URL on Save without calling fetch, and resets to default", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/workers")) {
        return new Response(JSON.stringify(sampleWorkersPayload({ workers: [], active_workers: 0 })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(sampleHealthPayload({ current_job_id: null })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    mountStratumPanel({ fetchImpl: mockFetch });
    const input = document.querySelector<HTMLInputElement>("#stratum-url")!;
    const save = document.querySelector<HTMLButtonElement>("#stratum-save")!;
    const reset = document.querySelector<HTMLButtonElement>("#stratum-reset")!;

    input.value = "http://10.0.0.5:9100/health";
    save.click();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLParagraphElement>("#stratum-error")?.hidden).toBe(false);
    expect(document.querySelector("#stratum-error")?.textContent).toMatch(/loopback/i);

    reset.click();
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(document.querySelector("#stratum-rows")?.textContent).toContain("None");
    });
    expect(input.value).toBe(DEFAULT_STRATUM_HEALTH_URL);
    expect(document.querySelector<HTMLParagraphElement>("#stratum-error")?.hidden).toBe(true);
  });

  it("evaluates console Stratum alerts and builds sanitized loopback-only diagnostics JSON", () => {
    const healthy = parseStratumHealth(sampleHealthPayload());
    const workers = parseStratumWorkers(sampleWorkersPayload());
    expect(evaluateConsoleStratumAlerts(healthy, workers)).toEqual([]);

    const degraded = parseStratumHealth(
      sampleHealthPayload({ status: "degraded", current_job_id: null, active_connections: 2 }),
    );
    const workersWithBansAndIdle = parseStratumWorkers(
      sampleWorkersPayload({
        banned_ips: 7,
        workers: [
          {
            session_id: 1,
            worker_name: "rig-idle",
            authorized: true,
            difficulty: 4,
            shares_accepted: 5,
            shares_rejected: 1,
            connected_secs: 1200,
            idle_secs: 420,
          },
        ],
      }),
    );

    const alerts = evaluateConsoleStratumAlerts(degraded, workersWithBansAndIdle);
    expect(alerts.map((a) => [a.id, a.severity])).toEqual([
      ["gateway-unhealthy", "critical"],
      ["high-ip-bans", "warning"],
      ["no-current-job", "warning"],
      ["idle-workers", "info"],
    ]);

    const bundle = buildConsoleStratumDiagnostics({
      healthUrl: "http://user:pass@127.0.0.1:9100/health?token=secret#frag",
      health: degraded,
      workers: workersWithBansAndIdle,
      generatedAt: "2026-11-23T09:00:00.000Z",
    });
    expect(bundle.source).toBe("console-desktop");
    expect(bundle.healthUrl).toBe("http://127.0.0.1:9100/health");
    expect(bundle.alerts).toHaveLength(4);
    expect(bundle.workers.bannedIps).toBe(7);
    expect(JSON.stringify(bundle)).not.toContain("secret");
    expect(JSON.stringify(bundle)).not.toContain("pass");

    expect(() =>
      buildConsoleStratumDiagnostics({
        healthUrl: "https://remote.example.com/health",
        health: healthy,
        workers: [],
      }),
    ).toThrow(/loopback/i);
  });

  it("displays alert badge and copies sanitized diagnostics JSON from the Stratum panel", async () => {
    let copied = "";
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/workers")) {
        return new Response(
          JSON.stringify(
            sampleWorkersPayload({
              banned_ips: 5,
              workers: [
                {
                  session_id: 1,
                  worker_name: "rig-idle",
                  authorized: true,
                  difficulty: 4,
                  shares_accepted: 10,
                  shares_rejected: 0,
                  connected_secs: 900,
                  idle_secs: 360,
                },
              ],
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(sampleHealthPayload({ current_job_id: null, active_connections: 1 })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const panel = mountStratumPanel({
      fetchImpl: mockFetch,
      copyText: async (text) => {
        copied = text;
      },
    });
    await panel!.refresh();

    const badge = document.querySelector<HTMLElement>("#stratum-alert-badge")!;
    const alertsBox = document.querySelector<HTMLElement>("#stratum-alerts")!;
    expect(badge.hidden).toBe(false);
    expect(badge.dataset.severity).toBe("warning");
    expect(badge.textContent).toContain("3 alerts (warning)");
    expect(alertsBox.hidden).toBe(false);
    expect(alertsBox.querySelectorAll("p")).toHaveLength(3);

    const copyBtn = document.querySelector<HTMLButtonElement>("#stratum-copy-diagnostics")!;
    copyBtn.click();
    await vi.waitFor(() => {
      expect(copied).not.toBe("");
    });
    const parsed = JSON.parse(copied) as {
      source: string;
      healthUrl: string;
      alerts: Array<{ id: string }>;
    };
    expect(parsed.source).toBe("console-desktop");
    expect(parsed.healthUrl).toBe(DEFAULT_STRATUM_HEALTH_URL);
    expect(parsed.alerts).toHaveLength(3);
    expect(document.querySelector<HTMLParagraphElement>("#stratum-diagnostics-status")?.textContent).toContain(
      "Copied sanitized diagnostics JSON",
    );
  });
});
