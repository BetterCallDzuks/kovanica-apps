import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRpcHealthCommand,
  buildStratumStatusCommand,
  validateSafeEndpointUrl,
} from "../src/operator-cli.ts";

test("buildRpcHealthCommand builds exact kovanica rpc health CLI commands", () => {
  const basic = buildRpcHealthCommand({
    url: "http://127.0.0.1:8545",
  });
  assert.equal(basic.binary, "kovanica");
  assert.deepEqual(basic.args, ["rpc", "health", "http://127.0.0.1:8545", "--json"]);
  assert.equal(basic.command, "kovanica rpc health http://127.0.0.1:8545 --json");

  const full = buildRpcHealthCommand({
    url: "https://rpc.testnet.kovanica.org:8545/rpc",
    timeoutMs: 5000,
    json: true,
    binary: "/usr/local/bin/kovanica",
  });
  assert.equal(full.binary, "/usr/local/bin/kovanica");
  assert.deepEqual(full.args, [
    "rpc",
    "health",
    "https://rpc.testnet.kovanica.org:8545/rpc",
    "--timeout-ms",
    "5000",
    "--json",
  ]);
  assert.equal(
    full.command,
    "/usr/local/bin/kovanica rpc health https://rpc.testnet.kovanica.org:8545/rpc --timeout-ms 5000 --json",
  );

  const plain = buildRpcHealthCommand({
    url: "http://127.0.0.1:8545",
    timeoutMs: 2500,
    json: false,
  });
  assert.deepEqual(plain.args, ["rpc", "health", "http://127.0.0.1:8545", "--timeout-ms", "2500"]);
  assert.equal(plain.command, "kovanica rpc health http://127.0.0.1:8545 --timeout-ms 2500");
});

test("buildStratumStatusCommand builds exact kovanica stratum status CLI commands", () => {
  const basic = buildStratumStatusCommand({
    url: "http://127.0.0.1:9100/status",
  });
  assert.equal(basic.binary, "kovanica");
  assert.deepEqual(basic.args, ["stratum", "status", "http://127.0.0.1:9100/status", "--json"]);
  assert.equal(basic.command, "kovanica stratum status http://127.0.0.1:9100/status --json");

  const full = buildStratumStatusCommand({
    url: "https://pool.kovanica.org:9100/status",
    timeoutMs: 8000,
    json: false,
    binary: "/opt/kovanica/bin/kovanica",
  });
  assert.equal(full.binary, "/opt/kovanica/bin/kovanica");
  assert.deepEqual(full.args, [
    "stratum",
    "status",
    "https://pool.kovanica.org:9100/status",
    "--timeout-ms",
    "8000",
  ]);
  assert.equal(
    full.command,
    "/opt/kovanica/bin/kovanica stratum status https://pool.kovanica.org:9100/status --timeout-ms 8000",
  );
});

test("rejects non-HTTP(S) schemes and malformed URLs", () => {
  for (const badScheme of [
    "ftp://127.0.0.1:8545",
    "file:///etc/passwd",
    "gopher://127.0.0.1:8545",
    "ws://127.0.0.1:8545",
    "stratum+tcp://127.0.0.1:3333",
  ]) {
    assert.throws(
      () => buildRpcHealthCommand({ url: badScheme }),
      /http:\/\/ or https:\/\//i,
    );
  }

  for (const malformed of ["", "not-a-url", "http://", "https://:8545"]) {
    assert.throws(() => validateSafeEndpointUrl(malformed));
  }
});

test("rejects embedded URL credentials without echoing secrets in error messages", () => {
  const secret = "s3cr3t_p4ssw0rd_999";
  for (const credUrl of [
    `http://admin:${secret}@127.0.0.1:8545`,
    `https://operator:${secret}@rpc.kovanica.org:8545`,
    `http://${secret}@127.0.0.1:8545`,
    "http://@127.0.0.1:8545",
    "http://:@127.0.0.1:8545",
  ]) {
    assert.throws(
      () => buildRpcHealthCommand({ url: credUrl }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /embedded credentials/i);
        assert.ok(!err.message.includes(secret), "error message must not echo embedded secret");
        return true;
      },
    );
    assert.throws(
      () => buildStratumStatusCommand({ url: credUrl }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /embedded credentials/i);
        assert.ok(!err.message.includes(secret), "error message must not echo embedded secret");
        return true;
      },
    );
  }
});

test("rejects control chars, whitespace, and shell metacharacters in URLs and binary", () => {
  for (const ctrlUrl of [
    "http://127.0.0.1:8545\nwhoami",
    "http://127.0.0.1:8545\r\nid",
    "http://127.0.0.1:8545\u0000",
    "http://127.0.0.1:8545\u001b[31m",
    "http://127.0.0.1:8545\u007f",
  ]) {
    assert.throws(
      () => buildRpcHealthCommand({ url: ctrlUrl }),
      /control characters/i,
    );
  }

  for (const wsUrl of [
    " http://127.0.0.1:8545",
    "http://127.0.0.1:8545 ",
    "http://127.0.0.1:8545/a b",
    "http://127.0.0.1:8545/\tstatus",
  ]) {
    assert.throws(
      () => buildStratumStatusCommand({ url: wsUrl }),
      /whitespace|control characters/i,
    );
  }

  for (const metaUrl of [
    "http://127.0.0.1:8545;rm",
    "http://127.0.0.1:8545&&id",
    "http://127.0.0.1:8545|cat",
    "http://127.0.0.1:8545/$(whoami)",
    "http://127.0.0.1:8545/`id`",
    "http://127.0.0.1:8545?token=abc",
    "http://127.0.0.1:8545#frag",
    "http://127.0.0.1:8545'quote",
    'http://127.0.0.1:8545"quote',
  ]) {
    assert.throws(
      () => buildRpcHealthCommand({ url: metaUrl }),
      /shell metacharacters/i,
    );
  }

  assert.throws(
    () =>
      buildRpcHealthCommand({
        url: "http://127.0.0.1:8545",
        binary: "/usr/bin/kovanica;id",
      }),
    /Binary path.*shell metacharacters/i,
  );
  assert.throws(
    () =>
      buildStratumStatusCommand({
        url: "http://127.0.0.1:9100/status",
        binary: "../kovanica",
      }),
    /Binary path.*path traversal/i,
  );
});

test("validates timeoutMs as a positive integer and json as a boolean", () => {
  for (const badTimeout of [0, -1, -5000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildRpcHealthCommand({ url: "http://127.0.0.1:8545", timeoutMs: badTimeout }),
      /timeoutMs must be a positive integer/i,
    );
    assert.throws(
      () => buildStratumStatusCommand({ url: "http://127.0.0.1:9100", timeoutMs: badTimeout }),
      /timeoutMs must be a positive integer/i,
    );
  }

  assert.throws(
    () =>
      buildRpcHealthCommand({
        url: "http://127.0.0.1:8545",
        timeoutMs: "5000" as unknown as number,
      }),
    /timeoutMs must be a positive integer/i,
  );

  assert.throws(
    () =>
      buildRpcHealthCommand({
        url: "http://127.0.0.1:8545",
        json: "true" as unknown as boolean,
      }),
    /json must be a boolean/i,
  );
});
