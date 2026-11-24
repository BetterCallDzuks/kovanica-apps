import { describe, expect, it } from "vitest";
import {
  commsRelayStatusRows,
  parseCommsRelayHealth,
  parseCommsRelayMetrics,
} from "./comms-relay";

/** Exact OpenMetrics 1.0 output shape from `kovanica-l1/crates/kovanica-comms-relay/src/server.rs`. */
const SAMPLE_SERVER_OPENMETRICS = `# HELP kovanica_comms_relay_envelopes_queued Current number of queued undelivered envelopes across all mailboxes.
# TYPE kovanica_comms_relay_envelopes_queued gauge
kovanica_comms_relay_envelopes_queued 17
# HELP kovanica_comms_relay_active_mailboxes Current number of mailboxes holding at least one queued envelope.
# TYPE kovanica_comms_relay_active_mailboxes gauge
kovanica_comms_relay_active_mailboxes 5
# HELP kovanica_comms_relay_max_mailbox_depth Current maximum queued envelope depth of any single mailbox.
# TYPE kovanica_comms_relay_max_mailbox_depth gauge
kovanica_comms_relay_max_mailbox_depth 6
# HELP kovanica_comms_relay_uptime_seconds Seconds elapsed since the relay HTTP router started.
# TYPE kovanica_comms_relay_uptime_seconds gauge
kovanica_comms_relay_uptime_seconds 8421
# HELP kovanica_comms_relay_envelopes_accepted Total unique envelopes accepted into the relay store.
# TYPE kovanica_comms_relay_envelopes_accepted counter
kovanica_comms_relay_envelopes_accepted_total 120
# HELP kovanica_comms_relay_envelopes_duplicate Total duplicate envelope submissions deduplicated by id.
# TYPE kovanica_comms_relay_envelopes_duplicate counter
kovanica_comms_relay_envelopes_duplicate_total 4
# HELP kovanica_comms_relay_envelopes_delivered Total envelopes acknowledged and removed from mailboxes.
# TYPE kovanica_comms_relay_envelopes_delivered counter
kovanica_comms_relay_envelopes_delivered_total 98
# HELP kovanica_comms_relay_envelopes_expired Total envelopes dropped due to TTL expiration during sweeps.
# TYPE kovanica_comms_relay_envelopes_expired counter
kovanica_comms_relay_envelopes_expired_total 5
# HELP kovanica_comms_relay_envelopes_rejected Total envelope submissions rejected as invalid, malformed, or oversized.
# TYPE kovanica_comms_relay_envelopes_rejected counter
kovanica_comms_relay_envelopes_rejected_total 3
# HELP kovanica_comms_relay_envelopes_rate_limited Total envelope submissions rejected due to rate limiting, quota, or missing/replayed PoW.
# TYPE kovanica_comms_relay_envelopes_rate_limited counter
kovanica_comms_relay_envelopes_rate_limited_total 9
# HELP kovanica_comms_relay_inbox_requests Total valid inbox read requests served.
# TYPE kovanica_comms_relay_inbox_requests counter
kovanica_comms_relay_inbox_requests_total 210
# HELP kovanica_comms_relay_ack_rejected Total ack requests rejected as invalid or unauthorized.
# TYPE kovanica_comms_relay_ack_rejected counter
kovanica_comms_relay_ack_rejected_total 2
# EOF
`;

describe("parseCommsRelayHealth", () => {
  it("parses a valid /v1/health JSON object", () => {
    const view = parseCommsRelayHealth({
      ok: true,
      version: " 0.1.0 ",
      envelopes: 42,
    });
    expect(view).toEqual({
      ok: true,
      status: "healthy",
      version: "0.1.0",
      queuedEnvelopes: 42,
    });
  });

  it("parses a valid /v1/health JSON string and handles ok=false", () => {
    const view = parseCommsRelayHealth(
      JSON.stringify({ ok: false, version: "0.2.1", envelopes: 0 }),
    );
    expect(view).toEqual({
      ok: false,
      status: "unhealthy",
      version: "0.2.1",
      queuedEnvelopes: 0,
    });
  });

  it("rejects malformed JSON and non-object inputs without echoing untrusted text", () => {
    const secret = "super-secret-token-value-123";
    expect(() => parseCommsRelayHealth(`{invalid ${secret}`)).toThrow(
      "Comms relay /v1/health returned invalid JSON.",
    );
    try {
      parseCommsRelayHealth(`{invalid ${secret}`);
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }

    expect(() => parseCommsRelayHealth("")).toThrow("empty response");
    expect(() => parseCommsRelayHealth(null)).toThrow("invalid JSON object");
    expect(() => parseCommsRelayHealth([])).toThrow("invalid JSON object");
    expect(() => parseCommsRelayHealth(42)).toThrow("invalid JSON object");
  });

  it("validates ok, version, and envelopes strictly", () => {
    expect(() => parseCommsRelayHealth({ version: "0.1.0", envelopes: 0 })).toThrow(
      "missing a valid ok boolean",
    );
    expect(() => parseCommsRelayHealth({ ok: "true", version: "0.1.0", envelopes: 0 })).toThrow(
      "missing a valid ok boolean",
    );
    expect(() => parseCommsRelayHealth({ ok: true, version: "", envelopes: 0 })).toThrow(
      "invalid version string",
    );
    expect(() => parseCommsRelayHealth({ ok: true, version: "0.1.0\nX-Inject: 1", envelopes: 0 })).toThrow(
      "invalid version string",
    );
    expect(() => parseCommsRelayHealth({ ok: true, version: "0.1.0", envelopes: -1 })).toThrow(
      "invalid envelopes",
    );
    expect(() => parseCommsRelayHealth({ ok: true, version: "0.1.0", envelopes: 1.5 })).toThrow(
      "invalid envelopes",
    );
    expect(() => parseCommsRelayHealth({ ok: true, version: "0.1.0", envelopes: Number.NaN })).toThrow(
      "invalid envelopes",
    );
  });
});

describe("parseCommsRelayMetrics", () => {
  it("parses full OpenMetrics 1.0 exposition emitted by kovanica-comms-relay", () => {
    const view = parseCommsRelayMetrics(SAMPLE_SERVER_OPENMETRICS);
    expect(view).toEqual({
      queuedEnvelopes: 17,
      activeMailboxes: 5,
      maxMailboxDepth: 6,
      uptimeSeconds: 8421,
      envelopesAcceptedTotal: 120,
      envelopesDuplicateTotal: 4,
      envelopesDeliveredTotal: 98,
      envelopesExpiredTotal: 5,
      envelopesRejectedTotal: 3,
      envelopesRateLimitedTotal: 9,
      inboxRequestsTotal: 210,
      ackRejectedTotal: 2,
      hasEofMarker: true,
    });
  });

  it("supports queued_envelopes alias, bare counter names, optional omissions, labels, and CRLF", () => {
    const minimal = [
      'kovanica_comms_relay_queued_envelopes{instance="local"} 12 1700000000',
      "kovanica_comms_relay_active_mailboxes 3",
      "kovanica_comms_relay_max_mailbox_depth 4",
      "kovanica_comms_relay_envelopes_accepted 50",
      "kovanica_comms_relay_envelopes_delivered 30",
      "kovanica_comms_relay_envelopes_expired 2",
      "kovanica_comms_relay_envelopes_rejected 1",
      "kovanica_comms_relay_envelopes_rate_limited 7",
      "custom_extra_gauge 99.5",
    ].join("\r\n");

    const view = parseCommsRelayMetrics(minimal);
    expect(view).toEqual({
      queuedEnvelopes: 12,
      activeMailboxes: 3,
      maxMailboxDepth: 4,
      uptimeSeconds: null,
      envelopesAcceptedTotal: 50,
      envelopesDuplicateTotal: 0,
      envelopesDeliveredTotal: 30,
      envelopesExpiredTotal: 2,
      envelopesRejectedTotal: 1,
      envelopesRateLimitedTotal: 7,
      inboxRequestsTotal: 0,
      ackRejectedTotal: 0,
      hasEofMarker: false,
    });
  });

  it("rejects non-string, empty, comments-only, malformed, negative, float, and duplicate metrics", () => {
    expect(() => parseCommsRelayMetrics(null)).toThrow("must be an OpenMetrics text string");
    expect(() => parseCommsRelayMetrics("   \n\t ")).toThrow("payload is empty");
    expect(() => parseCommsRelayMetrics("# HELP foo bar\n# EOF\n")).toThrow(
      "contains no metric samples",
    );

    const secret = "Bearer_TOP_SECRET_999";
    try {
      parseCommsRelayMetrics(`not a valid metric line ${secret}`);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("malformed sample line at line 1");
      expect((err as Error).message).not.toContain(secret);
    }

    expect(() =>
      parseCommsRelayMetrics("kovanica_comms_relay_envelopes_queued NaN"),
    ).toThrow("non-numeric value at line 1");

    expect(() =>
      parseCommsRelayMetrics("kovanica_comms_relay_envelopes_queued -5"),
    ).toThrow("invalid metric value at line 1");

    expect(() =>
      parseCommsRelayMetrics("kovanica_comms_relay_envelopes_queued 3.14"),
    ).toThrow("invalid metric value at line 1");

    expect(() =>
      parseCommsRelayMetrics(
        `${SAMPLE_SERVER_OPENMETRICS}\nkovanica_comms_relay_envelopes_queued 99\n`,
      ),
    ).toThrow("duplicate sample");
  });

  it("rejects payloads missing required relay metrics", () => {
    const missingRateLimited = SAMPLE_SERVER_OPENMETRICS.replace(
      "kovanica_comms_relay_envelopes_rate_limited_total 9",
      "",
    );
    expect(() => parseCommsRelayMetrics(missingRateLimited)).toThrow(
      "missing required metric: kovanica_comms_relay_envelopes_rate_limited_total",
    );
  });
});

describe("commsRelayStatusRows", () => {
  it("builds concise status rows with and without metrics", () => {
    const health = parseCommsRelayHealth({ ok: true, version: "0.1.0", envelopes: 17 });
    expect(commsRelayStatusRows(health)).toEqual([
      { label: "Status", value: "Healthy" },
      { label: "Version", value: "0.1.0" },
      { label: "Queued envelopes", value: "17" },
    ]);

    const metrics = parseCommsRelayMetrics(SAMPLE_SERVER_OPENMETRICS);
    const rows = commsRelayStatusRows(health, metrics);
    expect(rows).toContainEqual({ label: "Active mailboxes", value: "5" });
    expect(rows).toContainEqual({ label: "Max mailbox depth", value: "6" });
    expect(rows).toContainEqual({ label: "Rate-limited envelopes", value: "9" });
  });
});
