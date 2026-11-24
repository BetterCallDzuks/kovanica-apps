import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEcosystemDiagnosticBundle,
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  DIAGNOSTIC_BUNDLE_TYPE,
  REDACTED_KEYSTORE_VALUE,
  REDACTED_PEM_VALUE,
  REDACTED_VALUE,
  redactSensitiveString,
  serializeDiagnosticBundle,
} from "../src/diagnostics.ts";

test("buildEcosystemDiagnosticBundle produces versioned structured JSON with defaults", () => {
  const bundle = buildEcosystemDiagnosticBundle({
    clientVersion: "0.2.0",
    generatedAt: "2026-11-24T10:35:00.000Z",
    nodeHealth: {
      state: "running",
      chainId: 2,
      networkTag: "2-24cdb5fadd98b207",
      height: 987654n,
      peers: 11,
    },
    rpcMempool: {
      rpcUrl: "http://127.0.0.1:8545",
      pendingTransactions: 14,
      queuedTransactions: 2,
      baseFeeAtoms: 1000n,
    },
    stratumWorkers: {
      status: "healthy",
      activeWorkers: 4,
      acceptedShares: 512,
      rejectedShares: 3,
    },
    commsRelay: {
      endpoint: "http://127.0.0.1:8080",
      health: { ok: true, status: "healthy", version: "0.1.0", queuedEnvelopes: 9 },
      metrics: {
        queuedEnvelopes: 9,
        activeMailboxes: 3,
        maxMailboxDepth: 4,
        envelopesAcceptedTotal: 80,
        envelopesDeliveredTotal: 70,
        envelopesExpiredTotal: 1,
        envelopesRejectedTotal: 2,
        envelopesRateLimitedTotal: 5,
      },
    },
  });

  assert.equal(bundle.schemaVersion, DIAGNOSTIC_BUNDLE_SCHEMA_VERSION);
  assert.equal(bundle.bundleType, DIAGNOSTIC_BUNDLE_TYPE);
  assert.equal(bundle.source, "node-desktop");
  assert.equal(bundle.clientVersion, "0.2.0");
  assert.equal(bundle.generatedAt, "2026-11-24T10:35:00.000Z");
  assert.equal(bundle.redacted, true);
  assert.equal(bundle.nodeHealth?.height, "987654");
  assert.equal(bundle.rpcMempool?.baseFeeAtoms, "1000");

  const compact = serializeDiagnosticBundle(bundle, { pretty: false });
  assert.equal(compact.includes("\n"), false);
  const parsed = JSON.parse(compact) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.source, "node-desktop");
});

test("recursively strips URL userinfo, auth headers, tokens, passwords, keys, mnemonics, and seeds", () => {
  const leakedSecrets = [
    "alice_admin",
    "hunter2_super_pass",
    "eyJhbGciOiJFZERTQSJ9.payload123.sig456",
    "kvnc_live_api_key_99887766",
    "dXNlcjpwYXNzMTIzNDU2",
    "ultra-secret-passphrase-2026",
    "shared-hmac-secret-xyz",
    "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
    "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
    "raw_seed_entropy_deadbeef",
    "inline_rpc_token_7777",
  ];

  const bundle = buildEcosystemDiagnosticBundle({
    clientVersion: "0.2.0",
    generatedAt: "2026-11-24T10:35:00.000Z",
    nodeHealth: {
      rpcUrl: `https://${leakedSecrets[0]}:${leakedSecrets[1]}@node.kovanica.org:8545/rpc?api_key=${leakedSecrets[3]}`,
      wsUrl: `wss://${leakedSecrets[0]}:${leakedSecrets[1]}@ws.kovanica.org/live`,
      stratumUrl: `stratum+tcp://${leakedSecrets[0]}:${leakedSecrets[1]}@pool.kovanica.org:3333`,
      headers: {
        Authorization: `Bearer ${leakedSecrets[2]}`,
        "Proxy-Authorization": `Basic ${leakedSecrets[4]}`,
        "X-API-Key": leakedSecrets[3],
        "x-auth-token": leakedSecrets[2],
      },
    },
    rpcMempool: {
      credentials: {
        token: leakedSecrets[2],
        password: leakedSecrets[1],
        passphrase: leakedSecrets[5],
        secret: leakedSecrets[6],
        private_key: leakedSecrets[7],
        privateKey: leakedSecrets[7],
        mnemonic: leakedSecrets[8],
        seed: leakedSecrets[10],
        seed_phrase: leakedSecrets[8],
        xprv: leakedSecrets[9],
      },
      logs: [
        `Authorization: Bearer ${leakedSecrets[2]}`,
        `Authorization: Basic ${leakedSecrets[4]}`,
        `X-API-Key: ${leakedSecrets[3]}`,
        `connecting to http://${leakedSecrets[0]}:${leakedSecrets[1]}@127.0.0.1:8545`,
        `rpc_token=${leakedSecrets[11]} password="${leakedSecrets[1]}"`,
      ],
    },
    stratumWorkers: {
      workerErrors: [
        new Error(`upstream failed with Bearer ${leakedSecrets[2]} at https://${leakedSecrets[0]}:${leakedSecrets[1]}@127.0.0.1:8545`),
      ],
    },
    commsRelay: {
      endpoint: `http://${leakedSecrets[0]}:${leakedSecrets[1]}@127.0.0.1:8080/?token=${leakedSecrets[2]}`,
      bearer: leakedSecrets[2],
    },
  });

  const serialized = serializeDiagnosticBundle(bundle);
  for (const secret of leakedSecrets) {
    assert.equal(
      serialized.includes(secret),
      false,
      `Serialized diagnostic bundle must not contain secret: ${secret}`,
    );
  }

  const parsed = JSON.parse(serialized) as Record<string, any>;
  assert.equal(
    parsed.nodeHealth.rpcUrl,
    `https://${REDACTED_VALUE}@node.kovanica.org:8545/rpc?api_key=${REDACTED_VALUE}`,
  );
  assert.equal(parsed.nodeHealth.wsUrl, `wss://${REDACTED_VALUE}@ws.kovanica.org/live`);
  assert.equal(
    parsed.nodeHealth.stratumUrl,
    `stratum+tcp://${REDACTED_VALUE}@pool.kovanica.org:3333`,
  );
  assert.equal(parsed.nodeHealth.headers.Authorization, REDACTED_VALUE);
  assert.equal(parsed.nodeHealth.headers["Proxy-Authorization"], REDACTED_VALUE);
  assert.equal(parsed.nodeHealth.headers["X-API-Key"], REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.token, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.password, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.passphrase, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.secret, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.private_key, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.privateKey, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.mnemonic, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.seed, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.seed_phrase, REDACTED_VALUE);
  assert.equal(parsed.rpcMempool.credentials.xprv, REDACTED_VALUE);
  assert.equal(parsed.commsRelay.bearer, REDACTED_VALUE);
});

test("neutralizes Kovanica v2 keystores, Web3 v3 keystores, stringified keystores, and PEM blocks", () => {
  const kovanicaCiphertext =
    "21406ec83c99222e1a7262d80534b3cf334d5b213654c65efe8b5fb5ea70f8d2c78403778f0d09902a7c9a2b21c4b055";
  const kovanicaSalt = "88e37fe15da91bf57bfa24181fc595d9";
  const web3Ciphertext = "5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46";
  const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7test";

  const kovanicaV2Keystore = {
    version: 2,
    address: "kvnc0d7550754e0800a5d237eef5826035766b9b3e5a15868a940ab289958788e3b07bc9f7e9dag",
    public_key: "0d7550754e0800a5d237eef5826035766b9b3e5a15868a940ab289958788e3b0",
    encrypted: true,
    secret_key: kovanicaCiphertext,
    cipher: "xchacha20poly1305",
    kdf: "argon2id",
    kdf_memory_kib: 65536,
    kdf_iterations: 3,
    kdf_parallelism: 4,
    salt: kovanicaSalt,
    nonce: "1d6b4b4a95293d5a4bf31f16059f032a4acf0c9cf2674e42",
  };

  const web3V3Keystore = {
    version: 3,
    id: "e13b209c-3b2f-4327-bab0-3bef2e51630d",
    address: "008aeeda4d805471df9b2a5b0f38a0c3bcba786b",
    crypto: {
      ciphertext: web3Ciphertext,
      cipherparams: { iv: "83dbcc02d8ccb40e466191a123791e0e" },
      cipher: "aes-128-ctr",
      kdf: "scrypt",
      kdfparams: { dklen: 32, salt: "ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19" },
      mac: "2103ac29920d71da29f15d75b4a16dbe95cfd7ff8faea1056c33131d846e3097",
    },
  };

  const bundle = buildEcosystemDiagnosticBundle({
    clientVersion: "0.2.0",
    generatedAt: "2026-11-24T10:35:00.000Z",
    nodeHealth: {
      // Unnamed/innocuous key holding raw keystore objects
      attachedBlobA: kovanicaV2Keystore,
      attachedBlobB: web3V3Keystore,
      attachedBlobC: JSON.stringify(kovanicaV2Keystore),
      attachedBlobD: JSON.stringify(web3V3Keystore),
      // Explicitly named keystore key
      keystore: { arbitrary: "data", nested: "secret" },
      tlsPem: `-----BEGIN EC PRIVATE KEY-----\n${pemBody}\n-----END EC PRIVATE KEY-----`,
    },
  });

  const serialized = serializeDiagnosticBundle(bundle);
  assert.equal(serialized.includes(kovanicaCiphertext), false);
  assert.equal(serialized.includes(kovanicaSalt), false);
  assert.equal(serialized.includes(web3Ciphertext), false);
  assert.equal(serialized.includes(pemBody), false);

  const parsed = JSON.parse(serialized) as Record<string, any>;
  assert.equal(parsed.nodeHealth.attachedBlobA, REDACTED_KEYSTORE_VALUE);
  assert.equal(parsed.nodeHealth.attachedBlobB, REDACTED_KEYSTORE_VALUE);
  assert.equal(parsed.nodeHealth.attachedBlobC, REDACTED_KEYSTORE_VALUE);
  assert.equal(parsed.nodeHealth.attachedBlobD, REDACTED_KEYSTORE_VALUE);
  assert.equal(parsed.nodeHealth.keystore, REDACTED_KEYSTORE_VALUE);
  assert.equal(parsed.nodeHealth.tlsPem, REDACTED_PEM_VALUE);
});

test("handles circular references, Maps, Sets, Dates, NaN, and post-build mutations safely", () => {
  const cyclic: Record<string, unknown> = { ok: true, count: Number.NaN };
  cyclic.self = cyclic;

  const headerMap = new Map<string, unknown>([
    ["Authorization", "Bearer map-secret-token"],
    ["Accept", "application/json"],
  ]);

  const bundle = buildEcosystemDiagnosticBundle({
    clientVersion: "0.2.0",
    generatedAt: "2026-11-24T10:35:00.000Z",
    nodeHealth: {
      cyclic,
      headers: headerMap,
      tags: new Set(["mainnet", "http://u:p@127.0.0.1:8545"]),
      observedAt: new Date("2026-11-24T10:00:00.000Z"),
    },
  });

  // Mutate bundle after build to verify serializeDiagnosticBundle re-redacts
  (bundle.nodeHealth as Record<string, unknown>).latePassword = "post-mutation-password";

  const serialized = serializeDiagnosticBundle(bundle);
  assert.equal(serialized.includes("map-secret-token"), false);
  assert.equal(serialized.includes("post-mutation-password"), false);
  assert.equal(serialized.includes("u:p@"), false);

  const parsed = JSON.parse(serialized) as Record<string, any>;
  assert.equal(parsed.nodeHealth.cyclic.self, "[CIRCULAR]");
  assert.equal(parsed.nodeHealth.cyclic.count, null);
  assert.equal(parsed.nodeHealth.headers.Authorization, REDACTED_VALUE);
  assert.equal(parsed.nodeHealth.headers.Accept, "application/json");
  assert.deepEqual(parsed.nodeHealth.tags, ["mainnet", `http://${REDACTED_VALUE}@127.0.0.1:8545`]);
  assert.equal(parsed.nodeHealth.observedAt, "2026-11-24T10:00:00.000Z");
  assert.equal(parsed.nodeHealth.latePassword, REDACTED_VALUE);
});

test("redactSensitiveString leaves ordinary diagnostics untouched", () => {
  const clean = "Node synced at height 123456 on http://127.0.0.1:8545 (peers=12)";
  assert.equal(redactSensitiveString(clean), clean);
});
