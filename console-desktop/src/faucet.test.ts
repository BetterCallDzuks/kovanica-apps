import { describe, expect, it } from "vitest";
import { faucetMetricsStatusRows, parseFaucetMetrics } from "./faucet";

/** Exact OpenMetrics 1.0 output shape from `kovanica-l1/crates/kovanica-faucet/src/main.rs`. */
const SAMPLE_FAUCET_OPENMETRICS = `# HELP kovanica_faucet_requests Total faucet drip requests received.
# TYPE kovanica_faucet_requests counter
kovanica_faucet_requests_total 42
# HELP kovanica_faucet_drips_succeeded Total successful faucet drips submitted.
# TYPE kovanica_faucet_drips_succeeded counter
kovanica_faucet_drips_succeeded_total 30
# HELP kovanica_faucet_dispensed_atoms Total KVNC atoms dispensed by successful faucet drips.
# TYPE kovanica_faucet_dispensed_atoms counter
kovanica_faucet_dispensed_atoms_total 300000000000
# HELP kovanica_faucet_drips_rejected Total faucet drip requests rejected due to validation, low balance, or RPC errors.
# TYPE kovanica_faucet_drips_rejected counter
kovanica_faucet_drips_rejected_total 4
# HELP kovanica_faucet_rate_limited Total faucet drip requests rejected by IP rate-limit or address cooldown.
# TYPE kovanica_faucet_rate_limited counter
kovanica_faucet_rate_limited_total 8
# HELP kovanica_faucet_ip_rate_limited Total faucet drip requests rejected by the per-IP rate limiter.
# TYPE kovanica_faucet_ip_rate_limited counter
kovanica_faucet_ip_rate_limited_total 5
# HELP kovanica_faucet_address_cooldown_hits Total faucet drip requests rejected by the per-address cooldown limiter.
# TYPE kovanica_faucet_address_cooldown_hits counter
kovanica_faucet_address_cooldown_hits_total 3
# HELP kovanica_faucet_invalid_address Total faucet drip requests rejected due to an invalid destination address.
# TYPE kovanica_faucet_invalid_address counter
kovanica_faucet_invalid_address_total 2
# HELP kovanica_faucet_low_balance_rejected Total faucet drip requests rejected by the low-balance guard.
# TYPE kovanica_faucet_low_balance_rejected counter
kovanica_faucet_low_balance_rejected_total 1
# HELP kovanica_faucet_rpc_errors Total faucet drip requests that failed during node RPC nonce fetch or transaction submission.
# TYPE kovanica_faucet_rpc_errors counter
kovanica_faucet_rpc_errors_total 1
# HELP kovanica_faucet_balance_atoms Last known faucet account balance in atoms.
# TYPE kovanica_faucet_balance_atoms gauge
kovanica_faucet_balance_atoms 15000000000000000
# HELP kovanica_faucet_active_ip_entries Current number of active client IP entries tracked by the IP rate limiter.
# TYPE kovanica_faucet_active_ip_entries gauge
kovanica_faucet_active_ip_entries 9
# HELP kovanica_faucet_active_address_cooldowns Current number of active destination address entries tracked by the cooldown limiter.
# TYPE kovanica_faucet_active_address_cooldowns gauge
kovanica_faucet_active_address_cooldowns 14
# HELP kovanica_faucet_uptime_seconds Seconds elapsed since the faucet service initialized.
# TYPE kovanica_faucet_uptime_seconds gauge
kovanica_faucet_uptime_seconds 7205
# HELP faucet_drips_succeeded Total number of successful faucet drips.
# TYPE faucet_drips_succeeded counter
faucet_drips_succeeded_total 30
# HELP faucet_drips_rejected Total number of rejected faucet drip requests.
# TYPE faucet_drips_rejected counter
faucet_drips_rejected_total 4
# HELP faucet_rate_limited Total number of rate-limited faucet drip requests.
# TYPE faucet_rate_limited counter
faucet_rate_limited_total 8
# HELP faucet_balance_atoms Last known faucet account balance in atoms.
# TYPE faucet_balance_atoms gauge
faucet_balance_atoms 15000000000000000
# EOF
`;

describe("parseFaucetMetrics", () => {
  it("parses full OpenMetrics 1.0 exposition emitted by kovanica-faucet (including u64 atoms > MAX_SAFE_INTEGER)", () => {
    const view = parseFaucetMetrics(SAMPLE_FAUCET_OPENMETRICS);
    expect(view).toEqual({
      requestsTotal: 42,
      dripsSucceededTotal: 30,
      dispensedAtomsTotal: 300000000000n,
      dripsRejectedTotal: 4,
      rateLimitedTotal: 8,
      ipRateLimitedTotal: 5,
      addressCooldownHitsTotal: 3,
      invalidAddressTotal: 2,
      lowBalanceRejectedTotal: 1,
      rpcErrorsTotal: 1,
      balanceAtoms: 15000000000000000n,
      activeIpEntries: 9,
      activeAddressCooldowns: 14,
      uptimeSeconds: 7205,
      hasEofMarker: true,
    });
  });

  it("handles missing optional series, labels, timestamps, unknown gauges, and CRLF line endings", () => {
    const minimal = [
      'kovanica_faucet_requests_total{network="testnet"} 10 1700000000',
      "kovanica_faucet_drips_succeeded_total 7",
      "kovanica_faucet_dispensed_atoms_total 70000000000",
      "kovanica_faucet_drips_rejected_total 1",
      "kovanica_faucet_rate_limited_total 2",
      "kovanica_faucet_balance_atoms 500000000000",
      "custom_faucet_extra_gauge 12.5",
    ].join("\r\n");

    const view = parseFaucetMetrics(minimal);
    expect(view).toEqual({
      requestsTotal: 10,
      dripsSucceededTotal: 7,
      dispensedAtomsTotal: 70000000000n,
      dripsRejectedTotal: 1,
      rateLimitedTotal: 2,
      ipRateLimitedTotal: 0,
      addressCooldownHitsTotal: 0,
      invalidAddressTotal: 0,
      lowBalanceRejectedTotal: 0,
      rpcErrorsTotal: 0,
      balanceAtoms: 500000000000n,
      activeIpEntries: null,
      activeAddressCooldowns: null,
      uptimeSeconds: null,
      hasEofMarker: false,
    });
  });

  it("rejects non-string, empty, comments-only, malformed, negative, float, out-of-range, and duplicate metrics without echoing secrets", () => {
    expect(() => parseFaucetMetrics(null)).toThrow("must be an OpenMetrics text string");
    expect(() => parseFaucetMetrics("   \n\t ")).toThrow("payload is empty");
    expect(() => parseFaucetMetrics("# HELP foo bar\n# EOF\n")).toThrow(
      "contains no metric samples",
    );

    const secret = "KOVANICA_RPC_WRITE_TOKEN_SUPER_SECRET_999";
    try {
      parseFaucetMetrics(`malformed line containing ${secret}`);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("malformed sample line at line 1");
      expect((err as Error).message).not.toContain(secret);
    }

    try {
      parseFaucetMetrics(`kovanica_faucet_requests_total ${secret}`);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("non-numeric value at line 1");
      expect((err as Error).message).not.toContain(secret);
    }

    expect(() => parseFaucetMetrics("kovanica_faucet_requests_total -1")).toThrow(
      "invalid metric value at line 1",
    );
    expect(() => parseFaucetMetrics("kovanica_faucet_requests_total 3.14")).toThrow(
      "invalid metric value at line 1",
    );
    expect(() => parseFaucetMetrics("kovanica_faucet_balance_atoms -5")).toThrow(
      "invalid atom value at line 1",
    );
    expect(() => parseFaucetMetrics("kovanica_faucet_balance_atoms 1.5")).toThrow(
      "invalid atom value at line 1",
    );
    expect(() =>
      parseFaucetMetrics("kovanica_faucet_balance_atoms 18446744073709551616"),
    ).toThrow("out-of-range atom value at line 1");

    expect(() =>
      parseFaucetMetrics(
        `${SAMPLE_FAUCET_OPENMETRICS}\nkovanica_faucet_requests_total 99\n`,
      ),
    ).toThrow("duplicate sample for kovanica_faucet_requests_total");
  });

  it("rejects payloads missing required faucet metrics", () => {
    const missingDispensed = SAMPLE_FAUCET_OPENMETRICS.replace(
      "kovanica_faucet_dispensed_atoms_total 300000000000",
      "",
    );
    expect(() => parseFaucetMetrics(missingDispensed)).toThrow(
      "missing required metric: kovanica_faucet_dispensed_atoms_total",
    );
  });
});

describe("faucetMetricsStatusRows", () => {
  it("formats balance, dispensed total, counters, and optional gauges into concise status rows", () => {
    const metrics = parseFaucetMetrics(SAMPLE_FAUCET_OPENMETRICS);
    expect(faucetMetricsStatusRows(metrics)).toEqual([
      { label: "Faucet balance", value: "15000000 KVNC" },
      { label: "Total requests", value: "42" },
      { label: "Drips succeeded", value: "30" },
      { label: "Dispensed total", value: "300 KVNC" },
      { label: "Drips rejected", value: "4" },
      { label: "Rate-limited", value: "8" },
      { label: "Address cooldown hits", value: "3" },
      { label: "Active address cooldowns", value: "14" },
      { label: "Uptime", value: "7205s" },
    ]);
  });

  it("omits optional gauge rows when absent", () => {
    const metrics = parseFaucetMetrics(
      [
        "kovanica_faucet_requests_total 1",
        "kovanica_faucet_drips_succeeded_total 1",
        "kovanica_faucet_dispensed_atoms_total 10500000000",
        "kovanica_faucet_drips_rejected_total 0",
        "kovanica_faucet_rate_limited_total 0",
        "kovanica_faucet_balance_atoms 2500000000",
      ].join("\n"),
    );

    expect(faucetMetricsStatusRows(metrics)).toEqual([
      { label: "Faucet balance", value: "2.5 KVNC" },
      { label: "Total requests", value: "1" },
      { label: "Drips succeeded", value: "1" },
      { label: "Dispensed total", value: "10.5 KVNC" },
      { label: "Drips rejected", value: "0" },
      { label: "Rate-limited", value: "0" },
      { label: "Address cooldown hits", value: "0" },
    ]);
  });
});
