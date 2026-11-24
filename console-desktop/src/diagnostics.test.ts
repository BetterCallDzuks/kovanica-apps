import { describe, expect, it } from "vitest";
import { parseCommsRelayHealth, parseCommsRelayMetrics } from "./comms-relay";
import {
  buildEcosystemDiagnosticBundle,
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  DIAGNOSTIC_BUNDLE_TYPE,
  REDACTED_KEYSTORE_VALUE,
  REDACTED_PEM_VALUE,
  REDACTED_VALUE,
  serializeDiagnosticBundle,
} from "./diagnostics";

const SAMPLE_RELAY_METRICS = `
kovanica_comms_relay_envelopes_queued 4
kovanica_comms_relay_active_mailboxes 2
kovanica_comms_relay_max_mailbox_depth 3
kovanica_comms_relay_uptime_seconds 600
kovanica_comms_relay_envelopes_accepted_total 25
kovanica_comms_relay_envelopes_delivered_total 20
kovanica_comms_relay_envelopes_expired_total 1
kovanica_comms_relay_envelopes_rejected_total 0
kovanica_comms_relay_envelopes_rate_limited_total 2
# EOF
`;

describe("console-desktop ecosystem diagnostic bundle exporter", () => {
  it("builds a versioned bundle combining node, RPC/mempool, Stratum, and Comms Relay views", () => {
    const relayHealth = parseCommsRelayHealth({ ok: true, version: "0.1.0", envelopes: 4 });
    const relayMetrics = parseCommsRelayMetrics(SAMPLE_RELAY_METRICS);

    const bundle = buildEcosystemDiagnosticBundle({
      clientVersion: "0.1.0",
      generatedAt: "2026-11-24T10:30:00.000Z",
      nodeHealth: { chainId: 2, height: 123456n, peers: 14 },
      rpcMempool: { endpoint: "http://127.0.0.1:8545", pendingTxs: 7, latencyMs: 12 },
      stratumWorkers: { activeWorkers: 3, acceptedShares: 400, rejectedShares: 1 },
      commsRelay: {
        endpoint: "http://127.0.0.1:8080",
        health: { ...relayHealth },
        metrics: { ...relayMetrics },
      },
    });

    expect(bundle.schemaVersion).toBe(DIAGNOSTIC_BUNDLE_SCHEMA_VERSION);
    expect(bundle.bundleType).toBe(DIAGNOSTIC_BUNDLE_TYPE);
    expect(bundle.source).toBe("console-desktop");
    expect(bundle.clientVersion).toBe("0.1.0");
    expect(bundle.generatedAt).toBe("2026-11-24T10:30:00.000Z");
    expect(bundle.redacted).toBe(true);
    expect(bundle.nodeHealth).toEqual({ chainId: 2, height: "123456", peers: 14 });
    expect(bundle.commsRelay).toMatchObject({
      endpoint: "http://127.0.0.1:8080",
      health: { ok: true, status: "healthy", version: "0.1.0", queuedEnvelopes: 4 },
      metrics: { activeMailboxes: 2, maxMailboxDepth: 3, envelopesRateLimitedTotal: 2 },
    });
  });

  it("recursively redacts credentials, URL userinfo, headers, keys, mnemonics, and raw keystores", () => {
    const secrets = [
      "rpcuser_secret",
      "rpcpass_secret_99",
      "eyJhbGciOiJIUzI1NiJ9.supersecretjwt.sig",
      "kvnc_api_key_live_8888",
      "my-wallet-passphrase-42",
      "0xdeadbeefcafebabe11223344556677889900aabbccddeeff0011223344556677",
      "abandon ability able about above absent absorb abstract absurd abuse access accident",
      "21406ec83c99222e1a7262d80534b3cf334d5b213654c65efe8b5fb5ea70f8d2c",
      "88e37fe15da91bf57bfa24181fc595d9",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC",
    ];

    const bundle = buildEcosystemDiagnosticBundle({
      clientVersion: "0.1.0",
      generatedAt: "2026-11-24T10:30:00.000Z",
      nodeHealth: {
        rpcUrl: `https://${secrets[0]}:${secrets[1]}@rpc.kovanica.org:8545/?token=${secrets[2]}`,
        headers: {
          Authorization: `Bearer ${secrets[2]}`,
          "X-API-Key": secrets[3],
        },
        passphrase: secrets[4],
        private_key: secrets[5],
        mnemonic: secrets[6],
        seed: secrets[6],
      },
      rpcMempool: {
        lastError: `Authorization: Bearer ${secrets[2]} failed on http://${secrets[0]}:${secrets[1]}@127.0.0.1:8545`,
        pem: `-----BEGIN PRIVATE KEY-----\n${secrets[9]}\n-----END PRIVATE KEY-----`,
      },
      stratumWorkers: {
        nested: {
          kovanicaKeystore: {
            version: 2,
            address: "kvnc0d7550754e0800a5d237eef5826035766b9b3e5a15868a940ab289958788e3b07bc9f7e9dag",
            encrypted: true,
            secret_key: secrets[7],
            cipher: "xchacha20poly1305",
            kdf: "argon2id",
            salt: secrets[8],
            nonce: "1d6b4b4a95293d5a4bf31f16059f032a4acf0c9cf2674e42",
          },
          web3KeystoreString: JSON.stringify({
            version: 3,
            crypto: {
              cipher: "aes-128-ctr",
              ciphertext: secrets[7],
              kdf: "scrypt",
            },
          }),
        },
      },
    });

    // Simulate post-build mutation to ensure serializeDiagnosticBundle re-redacts
    (bundle.nodeHealth as Record<string, unknown>).injectedSecret = `token=${secrets[2]}`;
    (bundle.nodeHealth as Record<string, unknown>).injectedLog = `token=${secrets[2]}`;

    const json = serializeDiagnosticBundle(bundle);
    for (const secret of secrets) {
      expect(json).not.toContain(secret);
    }

    const parsed = JSON.parse(json) as Record<string, any>;
    expect(parsed.nodeHealth.rpcUrl).toBe(
      `https://${REDACTED_VALUE}@rpc.kovanica.org:8545/?token=${REDACTED_VALUE}`,
    );
    expect(parsed.nodeHealth.headers.Authorization).toBe(REDACTED_VALUE);
    expect(parsed.nodeHealth.headers["X-API-Key"]).toBe(REDACTED_VALUE);
    expect(parsed.nodeHealth.passphrase).toBe(REDACTED_VALUE);
    expect(parsed.nodeHealth.private_key).toBe(REDACTED_VALUE);
    expect(parsed.nodeHealth.mnemonic).toBe(REDACTED_VALUE);
    expect(parsed.nodeHealth.seed).toBe(REDACTED_VALUE);
    expect(parsed.rpcMempool.pem).toBe(REDACTED_PEM_VALUE);
    expect(parsed.stratumWorkers.nested.kovanicaKeystore).toBe(REDACTED_KEYSTORE_VALUE);
    expect(parsed.stratumWorkers.nested.web3KeystoreString).toBe(REDACTED_KEYSTORE_VALUE);
    expect(parsed.nodeHealth.injectedSecret).toBe(REDACTED_VALUE);
    expect(parsed.nodeHealth.injectedLog).toBe(`token=${REDACTED_VALUE}`);
  });
});
