/**
 * Shell-safe operator CLI command builders for Kovanica node/pool diagnostics:
 * - `kovanica rpc health <url> [--timeout-ms <ms>] [--json]`
 * - `kovanica stratum status <url> [--timeout-ms <ms>] [--json]`
 */

import { validateSafeSnapshotPath } from "./snapshot.ts";

export interface OperatorCliEndpointOptions {
  /** Target HTTP or HTTPS endpoint URL (no credentials, whitespace, control chars, or shell metacharacters). */
  url: string;
  /** Optional request timeout in milliseconds (positive safe integer). */
  timeoutMs?: number;
  /** Emit `--json` flag (defaults to `true`). */
  json?: boolean;
  /** Optional custom `kovanica` binary path or executable name. */
  binary?: string;
}

export interface BuiltOperatorCliCommand {
  binary: string;
  args: string[];
  command: string;
}

const MAX_URL_LENGTH = 2048;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

const WHITESPACE_RE = /\s/;

const SHELL_METACHAR_RE = /[;&|$`(){}[\]<>'"\\*?~!#%^=]/;

/**
 * Strictly validates an operator endpoint URL (`http://` or `https://`).
 *
 * Rejects embedded URL credentials (`user:pass@`), control characters, whitespace,
 * shell metacharacters, and non-HTTP(S) schemes. Error messages are static and never
 * echo the raw URL so accidental credentials cannot leak into logs or UI banners.
 */
export function validateSafeEndpointUrl(value: unknown, label = "Endpoint URL"): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (value.length > MAX_URL_LENGTH) {
    throw new Error(`${label} exceeds maximum allowed length.`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (WHITESPACE_RE.test(value)) {
    throw new Error(`${label} must not contain whitespace.`);
  }
  if (SHELL_METACHAR_RE.test(value)) {
    throw new Error(`${label} contains disallowed shell metacharacters.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid http:// or https:// URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use the http:// or https:// scheme.`);
  }
  if (parsed.username !== "" || parsed.password !== "" || value.includes("@")) {
    throw new Error(`${label} must not contain embedded credentials.`);
  }
  if (parsed.hostname === "") {
    throw new Error(`${label} must include a valid host.`);
  }

  return value;
}

function validateTimeoutMs(timeoutMs: unknown): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  return timeoutMs;
}

function buildEndpointSubcommand(
  subcommand: readonly [string, string],
  options: OperatorCliEndpointOptions,
  contextLabel: string,
): BuiltOperatorCliCommand {
  if (!options || typeof options !== "object") {
    throw new Error(`${contextLabel} options must be an object.`);
  }
  if (options.json !== undefined && typeof options.json !== "boolean") {
    throw new Error("json must be a boolean.");
  }

  const url = validateSafeEndpointUrl(options.url, `${contextLabel} URL`);
  const timeoutMs = validateTimeoutMs(options.timeoutMs);
  const binary =
    options.binary !== undefined
      ? validateSafeSnapshotPath(options.binary, "Binary path")
      : "kovanica";

  const args: string[] = [...subcommand, url];
  if (timeoutMs !== undefined) {
    args.push("--timeout-ms", String(timeoutMs));
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
 * Builds a shell-safe `kovanica rpc health <url> [--timeout-ms <ms>] [--json]` command.
 */
export function buildRpcHealthCommand(
  options: OperatorCliEndpointOptions,
): BuiltOperatorCliCommand {
  return buildEndpointSubcommand(["rpc", "health"], options, "RPC health");
}

/**
 * Builds a shell-safe `kovanica stratum status <url> [--timeout-ms <ms>] [--json]` command.
 */
export function buildStratumStatusCommand(
  options: OperatorCliEndpointOptions,
): BuiltOperatorCliCommand {
  return buildEndpointSubcommand(["stratum", "status"], options, "Stratum status");
}
