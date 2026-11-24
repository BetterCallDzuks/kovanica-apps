import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSnapshotInspectCommand,
  buildSnapshotVerifyCommand,
  validateSafeSnapshotPath,
} from "../src/snapshot.ts";

test("buildSnapshotVerifyCommand builds exact kovanica-snapshot verify-manifest CLI command by default", () => {
  const built = buildSnapshotVerifyCommand({
    manifestPath: "  /var/lib/kovanica/snapshots/height-12000/manifest.json  ",
  });

  assert.equal(built.binary, "kovanica-snapshot");
  assert.deepEqual(built.args, [
    "verify-manifest",
    "--path",
    "/var/lib/kovanica/snapshots/height-12000/manifest.json",
  ]);
  assert.equal(
    built.command,
    "kovanica-snapshot verify-manifest --path /var/lib/kovanica/snapshots/height-12000/manifest.json",
  );
});

test("buildSnapshotVerifyCommand supports custom binary override and kovanica-cli mode", () => {
  const customBin = buildSnapshotVerifyCommand({
    manifestPath: "/data/snapshots/testnet",
    binary: "/usr/local/bin/kovanica-snapshot",
  });
  assert.equal(customBin.binary, "/usr/local/bin/kovanica-snapshot");
  assert.equal(
    customBin.command,
    "/usr/local/bin/kovanica-snapshot verify-manifest --path /data/snapshots/testnet",
  );

  const cliWithChain = buildSnapshotVerifyCommand({
    tool: "kovanica-cli",
    manifestPath: "/data/snapshots/testnet/manifest.json",
    expectedChainId: 2,
  });
  assert.equal(cliWithChain.binary, "kovanica");
  assert.deepEqual(cliWithChain.args, [
    "snapshot",
    "verify",
    "/data/snapshots/testnet/manifest.json",
    "--expected-chain-id",
    "2",
    "--json",
  ]);
  assert.equal(
    cliWithChain.command,
    "kovanica snapshot verify /data/snapshots/testnet/manifest.json --expected-chain-id 2 --json",
  );

  const cliPlain = buildSnapshotVerifyCommand({
    tool: "kovanica-cli",
    manifestPath: "./snap-dir",
    json: false,
  });
  assert.equal(cliPlain.command, "kovanica snapshot verify ./snap-dir");
});

test("buildSnapshotInspectCommand builds exact kovanica-snapshot inspect-manifest CLI command", () => {
  const built = buildSnapshotInspectCommand({
    manifestPath: "/var/lib/kovanica/snapshots/snap-100",
  });
  assert.equal(built.binary, "kovanica-snapshot");
  assert.deepEqual(built.args, ["inspect-manifest", "--path", "/var/lib/kovanica/snapshots/snap-100"]);
  assert.equal(
    built.command,
    "kovanica-snapshot inspect-manifest --path /var/lib/kovanica/snapshots/snap-100",
  );
});

test("buildSnapshotVerifyCommand rejects path traversal, metacharacters, leading dashes, control chars, and empty paths", () => {
  // Path traversal
  for (const traversal of [
    "../etc/passwd",
    "/var/lib/kovanica/../../etc/shadow",
    "snapshots/../secret.json",
    "..",
  ]) {
    assert.throws(
      () => buildSnapshotVerifyCommand({ manifestPath: traversal }),
      /path traversal/i,
    );
  }

  // Leading dashes (option injection)
  for (const dashPath of ["-rf", "--help", "-path/manifest.json"]) {
    assert.throws(
      () => buildSnapshotVerifyCommand({ manifestPath: dashPath }),
      /must not start with '-'/i,
    );
  }

  // Empty / whitespace-only
  for (const emptyPath of ["", "   ", "\t\n"]) {
    assert.throws(
      () => buildSnapshotVerifyCommand({ manifestPath: emptyPath }),
      /must not be empty/i,
    );
  }

  // Whitespace & control characters
  for (const ctrlPath of [
    "/tmp/snap with space/manifest.json",
    "/tmp/snap\nwhoami",
    "/tmp/snap\r\nid",
    "/tmp/snap\tmanifest.json",
    "/tmp/snap\u0000manifest.json",
    "/tmp/snap\u001b[31mred",
    "/tmp/snap\u007fdel",
  ]) {
    assert.throws(
      () => buildSnapshotVerifyCommand({ manifestPath: ctrlPath }),
      /whitespace or control/i,
    );
  }

  // Shell metacharacters
  for (const metaPath of [
    "/tmp/snap;rm",
    "/tmp/snap&&id",
    "/tmp/snap|cat",
    "/tmp/snap$(whoami)",
    "/tmp/snap`id`",
    "/tmp/snap>out",
    "/tmp/snap<in",
    "/tmp/snap'quote",
    '/tmp/snap"quote',
    "/tmp/snap\\escape",
    "/tmp/snap*glob",
    "/tmp/snap?glob",
    "/tmp/snap~home",
    "/tmp/snap!bang",
    "/tmp/snap#comment",
  ]) {
    assert.throws(
      () => buildSnapshotVerifyCommand({ manifestPath: metaPath }),
      /shell metacharacters/i,
    );
  }

  // Unsafe binary override rejected too
  assert.throws(
    () =>
      buildSnapshotVerifyCommand({
        manifestPath: "/tmp/manifest.json",
        binary: "/usr/bin/kovanica-snapshot;id",
      }),
    /Binary path.*shell metacharacters/i,
  );
  assert.throws(
    () =>
      buildSnapshotVerifyCommand({
        manifestPath: "/tmp/manifest.json",
        binary: "../kovanica-snapshot",
      }),
    /Binary path.*path traversal/i,
  );
});

test("buildSnapshotVerifyCommand validates tool and expectedChainId combinations", () => {
  assert.throws(
    () =>
      buildSnapshotVerifyCommand({
        manifestPath: "/tmp/manifest.json",
        expectedChainId: 2,
      }),
    /only supported when tool is "kovanica-cli"/i,
  );

  assert.throws(
    () =>
      buildSnapshotVerifyCommand({
        tool: "kovanica-cli",
        manifestPath: "/tmp/manifest.json",
        expectedChainId: 99 as unknown as 1,
      }),
    /expectedChainId must be 1, 2, or 3/i,
  );

  assert.throws(
    () =>
      buildSnapshotVerifyCommand({
        tool: "unknown-tool" as unknown as "kovanica-snapshot",
        manifestPath: "/tmp/manifest.json",
      }),
    /tool must be/i,
  );

  assert.throws(
    () => validateSafeSnapshotPath(null),
    /non-empty string/i,
  );
});
