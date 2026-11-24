/**
 * Shell-safe CLI command builders for Kovanica snapshot manifest verification
 * and inspection, matching:
 * - `kovanica-snapshot` (`kovanica-l1/crates/kovanica-snapshot/src/main.rs`)
 * - `kovanica snapshot verify` (`kovanica-l1/crates/kovanica-cli/src/snapshot_verify.rs`)
 */

export type SnapshotVerifyTool = "kovanica-snapshot" | "kovanica-cli";

export interface SnapshotVerifyCommandOptions {
  /** Path to a snapshot directory (containing `manifest.json`) or a manifest JSON file. */
  manifestPath: string;
  /**
   * Target CLI binary syntax:
   * - `"kovanica-snapshot"` (default): `kovanica-snapshot verify-manifest --path <manifestPath>`
   * - `"kovanica-cli"`: `kovanica snapshot verify <manifestPath> [--expected-chain-id <id>] [--json]`
   */
  tool?: SnapshotVerifyTool;
  /** Optional custom binary path or executable name (validated with the same strict path checks). */
  binary?: string;
  /** Expected chain ID (1 mainnet, 2 testnet, 3 devnet); only supported with `tool: "kovanica-cli"`. */
  expectedChainId?: 1 | 2 | 3;
  /** Emit `--json` flag when `tool: "kovanica-cli"` (defaults to `true`). */
  json?: boolean;
}

export interface SnapshotInspectCommandOptions {
  /** Path to a snapshot directory (containing `manifest.json`) or a manifest JSON file. */
  manifestPath: string;
  /** Optional custom `kovanica-snapshot` binary path or executable name. */
  binary?: string;
}

export interface BuiltSnapshotCommand {
  binary: string;
  args: string[];
  command: string;
}

const MAX_PATH_LENGTH = 4096;

// eslint-disable-next-line no-control-regex
const WHITESPACE_OR_CONTROL_RE = /[\s\u0000-\u001F\u007F]/;

const SHELL_METACHAR_RE = /[;&|$`(){}[\]<>'"\\*?~!#%^=]/;

/**
 * Validates that a filesystem path or binary identifier is shell-safe:
 * non-empty, no leading dash (option injection), no path traversal (`..`),
 * no whitespace or control characters, and no shell metacharacters.
 */
export function validateSafeSnapshotPath(value: unknown, label = "Snapshot path"): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${label} must not be empty.`);
  }
  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new Error(`${label} exceeds maximum allowed length.`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`${label} must not start with '-'.`);
  }
  if (trimmed.includes("..")) {
    throw new Error(`${label} must not contain path traversal ('..').`);
  }
  if (WHITESPACE_OR_CONTROL_RE.test(trimmed)) {
    throw new Error(`${label} must not contain whitespace or control characters.`);
  }
  if (SHELL_METACHAR_RE.test(trimmed)) {
    throw new Error(`${label} contains disallowed shell metacharacters.`);
  }
  return trimmed;
}

/**
 * Builds a shell-safe snapshot verification command for either:
 * - `kovanica-snapshot verify-manifest --path <manifestPath>` (default), or
 * - `kovanica snapshot verify <manifestPath> [--expected-chain-id <1|2|3>] [--json]`
 *
 * Returns both structured `{ binary, args }` (safe for argv-based process spawning)
 * and a shell-safe `command` string.
 */
export function buildSnapshotVerifyCommand(
  options: SnapshotVerifyCommandOptions,
): BuiltSnapshotCommand {
  if (!options || typeof options !== "object") {
    throw new Error("Snapshot verify options must be an object.");
  }

  const tool: SnapshotVerifyTool = options.tool ?? "kovanica-snapshot";
  if (tool !== "kovanica-snapshot" && tool !== "kovanica-cli") {
    throw new Error('tool must be "kovanica-snapshot" or "kovanica-cli".');
  }

  const manifestPath = validateSafeSnapshotPath(options.manifestPath, "Manifest path");
  const defaultBinary = tool === "kovanica-snapshot" ? "kovanica-snapshot" : "kovanica";
  const binary =
    options.binary !== undefined
      ? validateSafeSnapshotPath(options.binary, "Binary path")
      : defaultBinary;

  if (tool === "kovanica-snapshot") {
    if (options.expectedChainId !== undefined) {
      throw new Error(
        'expectedChainId is only supported when tool is "kovanica-cli" (kovanica snapshot verify).',
      );
    }
    const args = ["verify-manifest", "--path", manifestPath];
    return {
      binary,
      args,
      command: [binary, ...args].join(" "),
    };
  }

  const args = ["snapshot", "verify", manifestPath];
  if (options.expectedChainId !== undefined) {
    if (
      options.expectedChainId !== 1 &&
      options.expectedChainId !== 2 &&
      options.expectedChainId !== 3
    ) {
      throw new Error("expectedChainId must be 1, 2, or 3.");
    }
    args.push("--expected-chain-id", String(options.expectedChainId));
  }
  if (options.json !== false) {
    args.push("--json");
  }

  return {
    binary,
    args,
    command: [binary, ...args].join(" "),
  };
}

/**
 * Builds a shell-safe `kovanica-snapshot inspect-manifest --path <manifestPath>` command.
 */
export function buildSnapshotInspectCommand(
  options: SnapshotInspectCommandOptions,
): BuiltSnapshotCommand {
  if (!options || typeof options !== "object") {
    throw new Error("Snapshot inspect options must be an object.");
  }
  const manifestPath = validateSafeSnapshotPath(options.manifestPath, "Manifest path");
  const binary =
    options.binary !== undefined
      ? validateSafeSnapshotPath(options.binary, "Binary path")
      : "kovanica-snapshot";
  const args = ["inspect-manifest", "--path", manifestPath];
  return {
    binary,
    args,
    command: [binary, ...args].join(" "),
  };
}
