// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STRATUM_HEALTH_URL,
  fetchStratumHealth,
  formatUptime,
  normalizeStratumHealthUrl,
  parseStratumHealth,
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

function mountFixture(): void {
  document.body.innerHTML = `
    <section id="stratum-panel" class="panel">
      <h2 id="stratum-heading">Stratum Gateway Health &amp; Telemetry</h2>
      <input id="stratum-url" type="text" value="http://127.0.0.1:9100/health" />
      <button id="stratum-save" type="button">Save</button>
      <button id="stratum-reset" type="button">Use default</button>
      <button id="stratum-refresh" type="button">Refresh</button>
      <p id="stratum-state" class="muted"></p>
      <p id="stratum-error" class="error" role="alert" hidden></p>
      <dl id="stratum-rows" class="readout"></dl>
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
});

describe("Stratum Gateway Health & Telemetry DOM panel", () => {
  beforeEach(() => {
    localStorage.clear();
    mountFixture();
  });

  it("renders telemetry rows on manual refresh and transitions to offline state on error", async () => {
    let online = true;
    const mockFetch = vi.fn(async () => {
      if (!online) throw new Error("Connection refused");
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

    // Simulate gateway going offline
    online = false;
    await panel!.refresh();
    expect(panel!.getState().kind).toBe("offline");
    expect(document.querySelector("#stratum-state")?.textContent).toContain("Offline");
    expect(document.querySelector<HTMLParagraphElement>("#stratum-error")?.hidden).toBe(false);
    expect(document.querySelector("#stratum-error")?.textContent).toContain("Connection refused");
    expect(document.querySelectorAll("#stratum-rows dt")).toHaveLength(0);
  });

  it("rejects non-loopback URL on Save without calling fetch, and resets to default", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify(sampleHealthPayload({ current_job_id: null })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

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
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(document.querySelector("#stratum-rows")?.textContent).toContain("None");
    });
    expect(input.value).toBe(DEFAULT_STRATUM_HEALTH_URL);
    expect(document.querySelector<HTMLParagraphElement>("#stratum-error")?.hidden).toBe(true);
  });
});
