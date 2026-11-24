import {
  DEFAULT_RBF_BUMP_BPS,
  DEFAULT_RBF_MIN_BUMP_ATOMS,
  KovanicaClient,
  MAX_RBF_BUMP_BPS,
  MIN_RBF_BUMP_BPS,
  TRANSFER_TX_WIRE_SIZE,
  computeRbfFeeBump,
  estimatePriorityFeeTiers,
  formatKvnc,
  type EstimatePriorityFeeTiersOptions,
  type MempoolCongestionLevel,
  type PriorityFeeTier,
  type PriorityFeeTierName,
  type PriorityFeeTiersClient,
  type PriorityFeeTiersEstimate,
  type RbfFeeBumpOptions,
  type RbfFeeBumpResult,
} from "kovanica-sdk";

export {
  DEFAULT_RBF_BUMP_BPS,
  DEFAULT_RBF_MIN_BUMP_ATOMS,
  MAX_RBF_BUMP_BPS,
  MIN_RBF_BUMP_BPS,
  TRANSFER_TX_WIRE_SIZE,
};

export type {
  EstimatePriorityFeeTiersOptions,
  MempoolCongestionLevel,
  PriorityFeeTier,
  PriorityFeeTierName,
  PriorityFeeTiersClient,
  PriorityFeeTiersEstimate,
  RbfFeeBumpOptions,
  RbfFeeBumpResult,
};

export const PRIORITY_FEE_TIER_KEYS: readonly PriorityFeeTierName[] = [
  "slow",
  "standard",
  "fast",
] as const;

/** Standard RBF bump presets in basis points (+15%, +25%, +50%). */
export const RBF_BUMP_PRESETS_BPS = [1_500, 2_500, 5_000] as const;

export type RbfBumpPresetBps = (typeof RBF_BUMP_PRESETS_BPS)[number];

export type FetchPriorityFeeTiersOptions = EstimatePriorityFeeTiersOptions;

export interface RbfFeeBumpPreview {
  /** Original transaction fee in atomic units (lossless bigint). */
  previousFeeAtoms: bigint;
  /** Replacement transaction fee in atomic units (lossless bigint). */
  bumpedFeeAtoms: bigint;
  /** Absolute fee increase in atomic units (`bumpedFeeAtoms - previousFeeAtoms`). */
  deltaAtoms: bigint;
  /** Applied bump percentage in basis points (`1_500` = +15%). */
  bumpBps: number;
  /** Human-readable percentage label (e.g. `"+15%"`, `"+25%"`, `"+50%"`). */
  bumpPercentLabel: string;
  /** Original fee formatted as a decimal KVNC string. */
  previousFeeKvnc: string;
  /** Replacement fee formatted as a decimal KVNC string. */
  bumpedFeeKvnc: string;
  /** Fee delta formatted as a decimal KVNC string. */
  deltaKvnc: string;
}

function assertValidRpcUrl(rpcUrl: string): string {
  const trimmed = rpcUrl.trim();
  if (!trimmed) {
    throw new RangeError("RPC URL must be a non-empty http(s) URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RangeError(`Invalid RPC URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError(`RPC URL must use http:// or https://, got ${parsed.protocol}`);
  }
  if (!parsed.hostname) {
    throw new RangeError(`RPC URL must include a hostname: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Formats basis points into a concise percentage label (e.g. `1_500` -> `"+15%"`, `1_250` -> `"+12.5%"`).
 */
export function formatBumpBpsPercent(bumpBps: number): string {
  if (typeof bumpBps !== "number" || !Number.isSafeInteger(bumpBps) || bumpBps < 0) {
    throw new RangeError(`bumpBps must be a non-negative safe integer, got ${bumpBps}`);
  }
  const whole = Math.floor(bumpBps / 100);
  const remainder = bumpBps % 100;
  if (remainder === 0) {
    return `+${whole}%`;
  }
  const frac = remainder.toString().padStart(2, "0").replace(/0+$/, "");
  return `+${whole}.${frac}%`;
}

/**
 * Fetches live mempool priority fee tiers (`slow`, `standard`, `fast`) via `kovanica-sdk`'s
 * `estimatePriorityFeeTiers`.
 *
 * Accepts either an HTTP(S) `rpcUrl` string (instantiating a `KovanicaClient`) or a
 * pre-configured `PriorityFeeTiersClient` (e.g. the wallet's proxied RPC client).
 */
export async function fetchPriorityFeeTiers(
  rpcUrl: string | PriorityFeeTiersClient,
  options: FetchPriorityFeeTiersOptions = {},
): Promise<PriorityFeeTiersEstimate> {
  if (typeof rpcUrl === "string") {
    const validatedUrl = assertValidRpcUrl(rpcUrl);
    const client = new KovanicaClient({ rpcUrl: validatedUrl });
    return estimatePriorityFeeTiers(client, options);
  }

  if (rpcUrl === null || typeof rpcUrl !== "object") {
    throw new TypeError("rpcUrl must be a valid http(s) URL string or PriorityFeeTiersClient");
  }

  return estimatePriorityFeeTiers(rpcUrl, options);
}

/**
 * Selects a single priority fee tier (`"slow" | "standard" | "fast"`) from a
 * {@link PriorityFeeTiersEstimate}, failing closed on invalid tier keys.
 */
export function selectFeeTier(
  tiers: PriorityFeeTiersEstimate,
  tierKey: PriorityFeeTierName,
): PriorityFeeTier {
  if (tiers === null || typeof tiers !== "object") {
    throw new TypeError("tiers must be a PriorityFeeTiersEstimate object");
  }
  if (tierKey !== "slow" && tierKey !== "standard" && tierKey !== "fast") {
    throw new RangeError(
      `Invalid priority fee tier "${String(tierKey)}": expected "slow", "standard", or "fast"`,
    );
  }
  const selected = tiers[tierKey];
  if (!selected || typeof selected !== "object" || typeof selected.feeAtoms !== "bigint") {
    throw new TypeError(`Priority fee tier "${tierKey}" is missing or malformed`);
  }
  return selected;
}

/**
 * Computes a lossless Replace-By-Fee (RBF) fee bump preview powered by `kovanica-sdk`'s
 * `computeRbfFeeBump`, returning exact `bigint` atoms and formatted KVNC strings.
 */
export function previewRbfBump(
  previousFeeAtoms: bigint,
  bumpBps?: number,
  options?: { minBumpAtoms?: bigint },
): RbfFeeBumpPreview {
  const bumpOptions: RbfFeeBumpOptions = {};
  if (bumpBps !== undefined) {
    bumpOptions.bumpBps = bumpBps;
  }
  if (options?.minBumpAtoms !== undefined) {
    bumpOptions.minBumpAtoms = options.minBumpAtoms;
  }

  const result = computeRbfFeeBump(previousFeeAtoms, bumpOptions);

  return {
    previousFeeAtoms: result.previousFee,
    bumpedFeeAtoms: result.bumpedFee,
    deltaAtoms: result.delta,
    bumpBps: result.bumpBps,
    bumpPercentLabel: formatBumpBpsPercent(result.bumpBps),
    previousFeeKvnc: formatKvnc(result.previousFee),
    bumpedFeeKvnc: formatKvnc(result.bumpedFee),
    deltaKvnc: formatKvnc(result.delta),
  };
}
