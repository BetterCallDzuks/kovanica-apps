/**
 * Structured, versioned JSON Ecosystem Diagnostic Bundle exporter for console-desktop
 * with strict recursive credential, secret, URL userinfo, and keystore redaction.
 */

export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_BUNDLE_TYPE = "kovanica-ecosystem-diagnostics" as const;
export const REDACTED_VALUE = "[REDACTED]" as const;
export const REDACTED_KEYSTORE_VALUE = "[REDACTED_KEYSTORE]" as const;
export const REDACTED_PEM_VALUE = "[REDACTED_PEM_BLOCK]" as const;

const MAX_REDACTION_DEPTH = 32;

export interface EcosystemDiagnosticBundleInput {
  source?: string;
  clientVersion?: string;
  generatedAt?: string;
  nodeHealth?: Record<string, unknown> | null;
  rpcMempool?: Record<string, unknown> | null;
  stratumWorkers?: Record<string, unknown> | null;
  commsRelay?: Record<string, unknown> | null;
  extra?: Record<string, unknown> | null;
}

export interface EcosystemDiagnosticBundle {
  schemaVersion: typeof DIAGNOSTIC_BUNDLE_SCHEMA_VERSION;
  bundleType: typeof DIAGNOSTIC_BUNDLE_TYPE;
  source: string;
  clientVersion: string;
  generatedAt: string;
  redacted: true;
  nodeHealth: Record<string, unknown> | null;
  rpcMempool: Record<string, unknown> | null;
  stratumWorkers: Record<string, unknown> | null;
  commsRelay: Record<string, unknown> | null;
  extra?: Record<string, unknown> | null;
}

export interface SerializeDiagnosticBundleOptions {
  pretty?: boolean;
}

const KEYSTORE_KEY_RE =
  /(?:^|[_-])(keystore(?:[_-]?json)?|encrypted[_-]?key(?:store)?|wallet[_-]?keystore)(?:$|[_-])/i;

const SENSITIVE_KEY_EXACT = new Set([
  "authorization",
  "proxyauthorization",
  "bearer",
  "bearertoken",
  "xapikey",
  "apikey",
  "xauthtoken",
  "xrpcauthtoken",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "rpctoken",
  "writetoken",
  "sessiontoken",
  "idtoken",
  "apitoken",
  "password",
  "passwd",
  "pwd",
  "rpcpassword",
  "passphrase",
  "walletpassphrase",
  "secret",
  "clientsecret",
  "sharedsecret",
  "rpcsecret",
  "apisecret",
  "privatekey",
  "privkey",
  "secretkey",
  "signingkey",
  "spendingkey",
  "viewkey",
  "masterkey",
  "xprv",
  "mnemonic",
  "mnemonicphrase",
  "seed",
  "seedphrase",
  "recoveryphrase",
  "seedhex",
  "entropy",
]);

const SENSITIVE_KEY_TOKEN_RE =
  /(?:^|[_-])(authorization|bearer|x[-_]?api[-_]?key|api[-_]?key|token|password|passwd|passphrase|secret|private[-_]?key|priv[-_]?key|secret[-_]?key|signing[-_]?key|mnemonic|seed(?:[-_]?phrase)?|xprv)(?:$|[_-])/i;

function normalizeKeyForLookup(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitCamelCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

function isKeystoreKey(key: string): boolean {
  const norm = normalizeKeyForLookup(key);
  return (
    norm === "keystore" ||
    norm === "keystorejson" ||
    KEYSTORE_KEY_RE.test(splitCamelCase(key))
  );
}

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_EXACT.has(normalizeKeyForLookup(key))) {
    return true;
  }
  return SENSITIVE_KEY_TOKEN_RE.test(splitCamelCase(key));
}

/**
 * Detects raw Kovanica v2 keystores (`secret_key` + `cipher`/`kdf`/`salt`/`nonce`)
 * as well as Web3/Ethereum v3 keystores (`crypto`/`Crypto` + `ciphertext`/`kdf`/`cipher`).
 */
function isKeystoreLikeObject(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const keySet = new Set(keys);

  // Web3 v3 keystore: { crypto: { ciphertext, cipher, kdf, ... } }
  const cryptoChild = obj.crypto ?? obj.Crypto;
  if (cryptoChild && typeof cryptoChild === "object" && !Array.isArray(cryptoChild)) {
    const childKeys = new Set(Object.keys(cryptoChild as Record<string, unknown>).map((k) => k.toLowerCase()));
    if (
      childKeys.has("ciphertext") ||
      (childKeys.has("cipher") && (childKeys.has("kdf") || childKeys.has("kdfparams")))
    ) {
      return true;
    }
  }

  // Direct crypto block or Web3 crypto object
  if (
    keySet.has("ciphertext") &&
    (keySet.has("kdf") ||
      keySet.has("kdfparams") ||
      keySet.has("cipher") ||
      keySet.has("cipherparams") ||
      keySet.has("salt") ||
      keySet.has("iv") ||
      keySet.has("nonce") ||
      keySet.has("mac"))
  ) {
    return true;
  }

  // Kovanica v2 keystore: { secret_key, cipher, kdf, salt, nonce, ... }
  if (
    (keySet.has("secret_key") || keySet.has("secretkey") || keySet.has("encrypted_key")) &&
    (keySet.has("kdf") ||
      keySet.has("cipher") ||
      keySet.has("salt") ||
      keySet.has("nonce") ||
      keySet.has("encrypted"))
  ) {
    return true;
  }

  return false;
}

function isKeystoreJsonString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  const hasSecretPayload =
    lower.includes('"ciphertext"') ||
    lower.includes('"secret_key"') ||
    lower.includes('"secretkey"') ||
    lower.includes('"encrypted_key"');
  const hasKdfOrCipher =
    lower.includes('"kdf"') ||
    lower.includes('"cipher"') ||
    lower.includes('"crypto"') ||
    lower.includes('"argon2id"') ||
    lower.includes('"xchacha20poly1305"') ||
    lower.includes('"scrypt"') ||
    lower.includes('"pbkdf2"');
  return hasSecretPayload && hasKdfOrCipher;
}

/**
 * Redacts credentials, URL userinfo (`user:pass@`), auth headers, bearer tokens,
 * inline `key=value` secrets, PEM blocks, and raw JSON keystores from any string.
 */
export function redactSensitiveString(input: string): string {
  if (isKeystoreJsonString(input)) {
    return REDACTED_KEYSTORE_VALUE;
  }

  return input
    // PEM blocks
    .replace(
      /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
      REDACTED_PEM_VALUE,
    )
    // Any URL scheme with embedded userinfo: scheme://user:pass@host or scheme://user@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)(?!\[REDACTED\]@)([^@\s/"'<>]+)@/gi, `$1${REDACTED_VALUE}@`)
    // Sensitive URL query parameters
    .replace(
      /([?&](?:token|access[_-]?token|auth[_-]?token|api[_-]?key|x[_-]?api[_-]?key|key|secret|password|passwd|passphrase|auth)=)(?!\[REDACTED\](?:[&\s"'#]|$))[^&\s"'#]+/gi,
      `$1${REDACTED_VALUE}`,
    )
    // Authorization / X-API-Key header lines
    .replace(
      /(\b(?:Proxy-)?Authorization\s*:\s*)(?!\[REDACTED\](?:[\r\n"',;}\]]|$))(?:(?:Bearer|Basic|Token|ApiKey)\s+)?[^\r\n"',;}\]]+/gi,
      `$1${REDACTED_VALUE}`,
    )
    .replace(
      /(\bX-API-Key\s*:\s*)(?!\[REDACTED\](?:[\s"',;}\]]|$))[^\s"',;}\]]+/gi,
      `$1${REDACTED_VALUE}`,
    )
    // Standalone Bearer / Basic credentials
    .replace(/(\bBearer\s+)(?!\[REDACTED\](?:[\s"',;}\]]|$))[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/(\bBasic\s+)(?!\[REDACTED\](?:[\s"',;}\]]|$))[A-Za-z0-9+/=]{8,}/gi, `$1${REDACTED_VALUE}`)
    // Inline secret key=value or key: value pairs
    .replace(
      /(\b(?:x[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|rpc[_-]?token|write[_-]?token|session[_-]?token|token|password|passwd|passphrase|secret|private[_-]?key|priv[_-]?key|secret[_-]?key|mnemonic|seed(?:[_-]?phrase)?)\s*[:=]\s*)(?!\[REDACTED(?:_[A-Z_]+)?\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      `$1${REDACTED_VALUE}`,
    );
}

function redactRecursive(
  value: unknown,
  activeStack: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return redactSensitiveString(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: redactSensitiveString(value.name),
      message: redactSensitiveString(value.message),
    };
  }

  if (depth >= MAX_REDACTION_DEPTH) {
    return "[MAX_DEPTH_EXCEEDED]";
  }

  if (typeof value === "object") {
    if (activeStack.has(value)) {
      return "[CIRCULAR]";
    }
    activeStack.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => {
          const redacted = redactRecursive(item, activeStack, depth + 1);
          return redacted === undefined ? null : redacted;
        });
      }

      if (value instanceof Set) {
        const items: unknown[] = [];
        for (const item of value) {
          const redacted = redactRecursive(item, activeStack, depth + 1);
          items.push(redacted === undefined ? null : redacted);
        }
        return items;
      }

      if (value instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of value.entries()) {
          const keyStr = String(k);
          if (isKeystoreKey(keyStr)) {
            out[keyStr] = REDACTED_KEYSTORE_VALUE;
          } else if (isSensitiveKey(keyStr)) {
            out[keyStr] = REDACTED_VALUE;
          } else {
            const redacted = redactRecursive(v, activeStack, depth + 1);
            if (redacted !== undefined) {
              out[keyStr] = redacted;
            }
          }
        }
        return out;
      }

      const record = value as Record<string, unknown>;
      if (isKeystoreLikeObject(record)) {
        return REDACTED_KEYSTORE_VALUE;
      }

      const out: Record<string, unknown> = {};
      for (const [key, entryVal] of Object.entries(record)) {
        if (entryVal === undefined) {
          continue;
        }
        if (isKeystoreKey(key)) {
          out[key] = REDACTED_KEYSTORE_VALUE;
        } else if (isSensitiveKey(key)) {
          out[key] = REDACTED_VALUE;
        } else {
          const redacted = redactRecursive(entryVal, activeStack, depth + 1);
          if (redacted !== undefined) {
            out[key] = redacted;
          }
        }
      }
      return out;
    } finally {
      activeStack.delete(value);
    }
  }

  return null;
}

function redactSection(
  section: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!section || typeof section !== "object") {
    return null;
  }
  const activeStack = new WeakSet<object>();
  const redacted = redactRecursive(section, activeStack, 0);
  if (redacted === REDACTED_KEYSTORE_VALUE) {
    return { status: REDACTED_KEYSTORE_VALUE };
  }
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) {
    return null;
  }
  return redacted as Record<string, unknown>;
}

/**
 * Builds a structured, versioned JSON ecosystem diagnostic bundle covering
 * node health, RPC/mempool summary, Stratum workers summary, and Comms Relay
 * health/metrics with strict recursive credential and keystore redaction.
 */
export function buildEcosystemDiagnosticBundle(
  input: EcosystemDiagnosticBundleInput = {},
): EcosystemDiagnosticBundle {
  const source =
    typeof input.source === "string" && input.source.trim() !== ""
      ? redactSensitiveString(input.source.trim())
      : "console-desktop";
  const clientVersion =
    typeof input.clientVersion === "string" && input.clientVersion.trim() !== ""
      ? redactSensitiveString(input.clientVersion.trim())
      : "unknown";
  const generatedAt =
    typeof input.generatedAt === "string" && input.generatedAt.trim() !== ""
      ? redactSensitiveString(input.generatedAt.trim())
      : new Date().toISOString();

  const bundle: EcosystemDiagnosticBundle = {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    bundleType: DIAGNOSTIC_BUNDLE_TYPE,
    source,
    clientVersion,
    generatedAt,
    redacted: true,
    nodeHealth: redactSection(input.nodeHealth),
    rpcMempool: redactSection(input.rpcMempool),
    stratumWorkers: redactSection(input.stratumWorkers),
    commsRelay: redactSection(input.commsRelay),
  };

  if (input.extra !== undefined) {
    bundle.extra = redactSection(input.extra);
  }

  return bundle;
}

/**
 * Serializes an ecosystem diagnostic bundle to JSON after running a mandatory
 * defense-in-depth redaction pass so post-build mutations can never leak secrets.
 */
export function serializeDiagnosticBundle(
  bundle: EcosystemDiagnosticBundle | EcosystemDiagnosticBundleInput,
  options: SerializeDiagnosticBundleOptions = {},
): string {
  const sanitized = buildEcosystemDiagnosticBundle(bundle);
  const pretty = options.pretty ?? true;
  return JSON.stringify(sanitized, null, pretty ? 2 : undefined);
}
