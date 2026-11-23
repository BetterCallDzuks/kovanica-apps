import {
  DEFAULT_FEE_BUFFER_MULTIPLIER_BPS,
  DEFAULT_FINALITY_CONFIRMATIONS,
  applyFeeBuffer,
  createFailoverClient,
  sanitizeRpcUrl,
  waitForTransactionFinality,
  type FailoverHttpTransportOptions,
  type FeeBufferEstimate,
  type FinalityProgress,
  type FinalityResult,
  type KovanicaClient,
  type RpcRetryConfig,
  type TransactionReceipt,
  type WaitForFinalityOptions,
} from "kovanica-sdk";

export { DEFAULT_FEE_BUFFER_MULTIPLIER_BPS, DEFAULT_FINALITY_CONFIRMATIONS };

export type WalletFailoverClientOptions = Omit<FailoverHttpTransportOptions, "urls"> & {
  retry?: RpcRetryConfig;
};

export type WalletFailoverClient = {
  /** Underlying `kovanica-sdk` `KovanicaClient` backed by `FailoverHttpTransport`. */
  client: KovanicaClient;
  /** Ordered, deduplicated, credential-sanitized HTTP(S) failover endpoint URLs. */
  endpoints: readonly string[];
};

export type WatchSubmittedTxFinalityOptions = WaitForFinalityOptions & {
  /** Optional transport/retry options forwarded to `createWalletFailoverClient`. */
  clientOptions?: WalletFailoverClientOptions;
};

export type FinalityBadgeTone = "pending" | "included" | "finalized";

export type FinalityProgressBadge = {
  label: string;
  tone: FinalityBadgeTone;
  confirmationsText: string;
};

/**
 * Filters candidate RPC URLs to valid `http:` / `https:` endpoints, deduplicating
 * in order while preserving the raw URLs for transport and producing sanitized URLs
 * safe for UI/logging.
 */
export function normalizeFailoverRpcUrls(
  primaryUrl: string,
  backupUrls: ReadonlyArray<string> = [],
): { urls: string[]; sanitizedEndpoints: readonly string[] } {
  const candidates = [primaryUrl, ...backupUrls];
  const urls: string[] = [];
  const sanitizedEndpoints: string[] = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      continue;
    }
    if (!parsed.hostname) {
      continue;
    }

    const dedupKey = parsed.toString();
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    urls.push(trimmed);
    sanitizedEndpoints.push(sanitizeRpcUrl(trimmed));
  }

  return {
    urls,
    sanitizedEndpoints: Object.freeze(sanitizedEndpoints),
  };
}

/**
 * Creates a multi-RPC failover `KovanicaClient` backed by `kovanica-sdk`'s
 * `createFailoverClient`, filtering out invalid/non-HTTP(S) schemes, deduplicating
 * endpoints, and exposing a credential-sanitized failover endpoint list.
 */
export function createWalletFailoverClient(
  primaryUrl: string,
  backupUrls: ReadonlyArray<string> = [],
  options?: WalletFailoverClientOptions,
): WalletFailoverClient {
  const { urls, sanitizedEndpoints } = normalizeFailoverRpcUrls(primaryUrl, backupUrls);
  if (urls.length === 0) {
    throw new Error("createWalletFailoverClient requires at least one valid http(s) RPC URL");
  }

  const client = createFailoverClient(urls, options);
  return {
    client,
    endpoints: sanitizedEndpoints,
  };
}

/**
 * Watches a submitted transaction until it reaches the requested number of confirmations
 * across one or more failover RPC URLs via `kovanica-sdk`'s `waitForTransactionFinality`.
 */
export async function watchSubmittedTxFinality(
  rpcUrls: string | ReadonlyArray<string>,
  txHash: string,
  options: WatchSubmittedTxFinalityOptions = {},
): Promise<FinalityResult<TransactionReceipt>> {
  const urlList = typeof rpcUrls === "string" ? [rpcUrls] : [...rpcUrls];
  const [primaryUrl = "", ...backupUrls] = urlList;
  const { clientOptions, ...finalityOptions } = options;
  const { client } = createWalletFailoverClient(primaryUrl, backupUrls, clientOptions);

  return waitForTransactionFinality(client, txHash, {
    ...(finalityOptions.confirmations !== undefined
      ? { confirmations: finalityOptions.confirmations }
      : {}),
    ...(finalityOptions.pollIntervalMs !== undefined
      ? { pollIntervalMs: finalityOptions.pollIntervalMs }
      : {}),
    ...(finalityOptions.timeoutMs !== undefined ? { timeoutMs: finalityOptions.timeoutMs } : {}),
    ...(finalityOptions.signal !== undefined ? { signal: finalityOptions.signal } : {}),
    ...(finalityOptions.onProgress !== undefined ? { onProgress: finalityOptions.onProgress } : {}),
    ...(finalityOptions.sleep !== undefined ? { sleep: finalityOptions.sleep } : {}),
    ...(finalityOptions.now !== undefined ? { now: finalityOptions.now } : {}),
  });
}

/**
 * Formats a `kovanica-sdk` `FinalityProgress` update into a UI badge descriptor.
 */
export function formatFinalityProgressBadge(progress: FinalityProgress): FinalityProgressBadge {
  const target =
    Number.isFinite(progress.targetConfirmations) && progress.targetConfirmations >= 1
      ? Math.floor(progress.targetConfirmations)
      : DEFAULT_FINALITY_CONFIRMATIONS;
  const confirmations =
    Number.isFinite(progress.confirmations) && progress.confirmations >= 0
      ? Math.floor(progress.confirmations)
      : 0;
  const unit = target === 1 ? "confirmation" : "confirmations";
  const confirmationsText = `${confirmations}/${target} ${unit}`;

  switch (progress.status) {
    case "finalized":
      return {
        label: "Finalized",
        tone: "finalized",
        confirmationsText,
      };
    case "included":
      return {
        label: "Included",
        tone: "included",
        confirmationsText,
      };
    case "pending":
    default:
      return {
        label: "Pending",
        tone: "pending",
        confirmationsText,
      };
  }
}

/**
 * Computes a ceiling-rounded safety-buffered transaction fee by delegating to
 * `kovanica-sdk`'s `applyFeeBuffer`.
 */
export function computeBufferedTxFee(
  baseFee: bigint,
  safetyMultiplierBps?: number,
): FeeBufferEstimate {
  return applyFeeBuffer(
    baseFee,
    safetyMultiplierBps !== undefined ? { safetyMultiplierBps } : undefined,
  );
}
