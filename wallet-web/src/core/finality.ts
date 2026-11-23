import {
  DEFAULT_FEE_BUFFER_MULTIPLIER_BPS,
  DEFAULT_FINALITY_CONFIRMATIONS,
  applyFeeBuffer,
  bytesToHex,
  createFailoverClient,
  decodeSignedCallTransaction,
  decodeSignedTransferTransaction,
  hexToBytes,
  inspectAddress,
  parseContractAddress,
  probeRpcNode,
  sanitizeRpcUrl,
  verifyCallTransactionSignature,
  verifyTransferTransactionSignature,
  waitForTransactionFinality,
  type AddressInspectionResult,
  type DecodedSignedCallTransaction,
  type DecodedSignedTransferTransaction,
  type FailoverHttpTransportOptions,
  type FeeBufferEstimate,
  type FinalityProgress,
  type FinalityResult,
  type KovanicaClient,
  type RpcNodeProbeResult,
  type RpcRetryConfig,
  type TransactionReceipt,
  type WaitForFinalityOptions,
} from "kovanica-sdk";

export { DEFAULT_FEE_BUFFER_MULTIPLIER_BPS, DEFAULT_FINALITY_CONFIRMATIONS };
export type {
  AddressInspectionResult,
  DecodedSignedCallTransaction,
  DecodedSignedTransferTransaction,
  RpcNodeProbeResult,
};

export type PreBroadcastVerificationOptions = {
  chainId?: bigint | number;
  expectedContract?: string;
};

export type PreBroadcastVerificationResult = {
  ok: boolean;
  signatureValid: boolean;
  decoded?: DecodedSignedCallTransaction;
  error?: string;
};

export type PreBroadcastTransferVerificationOptions = {
  chainId?: bigint | number;
  expectedRecipient?: string;
  expectedAmount?: bigint;
};

export type PreBroadcastTransferVerificationResult = {
  ok: boolean;
  signatureValid: boolean;
  decoded?: DecodedSignedTransferTransaction;
  error?: string;
};

export type AddressBookValidationResult = {
  ok: boolean;
  inspection: AddressInspectionResult;
  canonicalAddress?: string;
  error?: string;
};

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Decodes a signed Call contract transaction offline and self-verifies its Ed25519
 * signature against `expectedPublicKey` (and optional `expectedContract` / `chainId`)
 * prior to broadcast. Fails closed on any decode error, signature failure, or mismatch.
 */
export function verifySignedCallTxBeforeBroadcast(
  rawTxHex: string,
  expectedPublicKey: Uint8Array,
  options?: PreBroadcastVerificationOptions,
): PreBroadcastVerificationResult {
  let resolvedChainId: number | undefined;
  if (options?.chainId !== undefined) {
    if (typeof options.chainId === "bigint") {
      if (options.chainId < 0n || options.chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
        return {
          ok: false,
          signatureValid: false,
          error: `Invalid chainId: ${options.chainId.toString()}`,
        };
      }
      resolvedChainId = Number(options.chainId);
    } else if (Number.isSafeInteger(options.chainId) && options.chainId >= 0) {
      resolvedChainId = options.chainId;
    } else {
      return {
        ok: false,
        signatureValid: false,
        error: `Invalid chainId: ${String(options.chainId)}`,
      };
    }
  }

  let decoded: DecodedSignedCallTransaction;
  try {
    decoded = decodeSignedCallTransaction(
      rawTxHex,
      resolvedChainId !== undefined ? { chainId: resolvedChainId } : undefined,
    );
  } catch (err: unknown) {
    return {
      ok: false,
      signatureValid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!(expectedPublicKey instanceof Uint8Array) || expectedPublicKey.length !== 32) {
    return {
      ok: false,
      signatureValid: false,
      decoded,
      error: "Expected 32-byte Ed25519 public key",
    };
  }

  const signatureValid = verifyCallTransactionSignature(decoded, expectedPublicKey);
  if (!signatureValid) {
    return {
      ok: false,
      signatureValid: false,
      decoded,
      error: "Signed call transaction Ed25519 signature verification failed",
    };
  }

  if (!bytesEqual(decoded.senderBytes, expectedPublicKey)) {
    return {
      ok: false,
      signatureValid,
      decoded,
      error: "Signed call transaction sender does not match expected public key",
    };
  }

  if (options?.expectedContract !== undefined) {
    let expectedContractBytes: Uint8Array;
    try {
      expectedContractBytes = parseContractAddress(options.expectedContract);
    } catch (err: unknown) {
      return {
        ok: false,
        signatureValid,
        decoded,
        error: `Invalid expectedContract: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!bytesEqual(decoded.contractBytes, expectedContractBytes)) {
      return {
        ok: false,
        signatureValid,
        decoded,
        error: `Contract address mismatch: expected 0x${bytesToHex(expectedContractBytes)}, got ${decoded.contractHex}`,
      };
    }
  }

  return {
    ok: true,
    signatureValid: true,
    decoded,
  };
}

/**
 * Decodes a signed native Transfer transaction offline and self-verifies its Ed25519
 * signature against `expectedPublicKey` (and optional `chainId`, `expectedRecipient`,
 * and `expectedAmount`) prior to broadcast. Fails closed on any decode error,
 * signature failure, or mismatch.
 */
export function verifySignedTransferTxBeforeBroadcast(
  rawTxHex: string,
  expectedPublicKey: Uint8Array,
  options?: PreBroadcastTransferVerificationOptions,
): PreBroadcastTransferVerificationResult {
  let resolvedChainId: bigint | undefined;
  if (options?.chainId !== undefined) {
    if (typeof options.chainId === "bigint") {
      if (options.chainId < 0n || options.chainId > 0xffffffffffffffffn) {
        return {
          ok: false,
          signatureValid: false,
          error: `Invalid chainId: ${options.chainId.toString()}`,
        };
      }
      resolvedChainId = options.chainId;
    } else if (Number.isSafeInteger(options.chainId) && options.chainId >= 0) {
      resolvedChainId = BigInt(options.chainId);
    } else {
      return {
        ok: false,
        signatureValid: false,
        error: `Invalid chainId: ${String(options.chainId)}`,
      };
    }
  }

  let decoded: DecodedSignedTransferTransaction;
  try {
    decoded = decodeSignedTransferTransaction(
      rawTxHex,
      resolvedChainId !== undefined ? { chainId: resolvedChainId } : undefined,
    );
  } catch (err: unknown) {
    return {
      ok: false,
      signatureValid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!(expectedPublicKey instanceof Uint8Array) || expectedPublicKey.length !== 32) {
    return {
      ok: false,
      signatureValid: false,
      decoded,
      error: "Expected 32-byte Ed25519 public key",
    };
  }

  const signatureValid = verifyTransferTransactionSignature(decoded, expectedPublicKey);
  if (!signatureValid) {
    return {
      ok: false,
      signatureValid: false,
      decoded,
      error: "Signed transfer transaction Ed25519 signature verification failed",
    };
  }

  if (!bytesEqual(decoded.senderBytes, expectedPublicKey)) {
    return {
      ok: false,
      signatureValid,
      decoded,
      error: "Signed transfer transaction sender does not match expected public key",
    };
  }

  if (options?.expectedRecipient !== undefined) {
    const inspected = inspectAddress(options.expectedRecipient);
    if (!inspected.valid || !inspected.payloadHex) {
      return {
        ok: false,
        signatureValid,
        decoded,
        error: `Invalid expectedRecipient: ${inspected.error ?? "invalid address"}`,
      };
    }

    const expectedRecipientBytes = hexToBytes(inspected.payloadHex.slice(2));
    if (!bytesEqual(decoded.recipientBytes, expectedRecipientBytes)) {
      return {
        ok: false,
        signatureValid,
        decoded,
        error: `Recipient address mismatch: expected ${inspected.payloadHex}, got ${decoded.recipientHex}`,
      };
    }
  }

  if (options?.expectedAmount !== undefined) {
    if (typeof options.expectedAmount !== "bigint" || options.expectedAmount < 0n) {
      return {
        ok: false,
        signatureValid,
        decoded,
        error: `Invalid expectedAmount: ${String(options.expectedAmount)}`,
      };
    }

    if (decoded.amount !== options.expectedAmount) {
      return {
        ok: false,
        signatureValid,
        decoded,
        error: `Transfer amount mismatch: expected ${options.expectedAmount.toString()}, got ${decoded.amount.toString()}`,
      };
    }
  }

  return {
    ok: true,
    signatureValid: true,
    decoded,
  };
}

/**
 * Validates an address-book entry against PRO-21 checksum and chain-policy rules
 * by delegating to `kovanica-sdk`'s `inspectAddress`. Fails closed whenever
 * `valid === false` or `chainAllowed !== true`.
 */
export function validateAddressBookEntry(
  address: string,
  chainId: number | bigint,
): AddressBookValidationResult {
  const inspection = inspectAddress(address, chainId);
  if (!inspection.valid || inspection.chainAllowed !== true) {
    return {
      ok: false,
      inspection,
      error: inspection.error ?? "Address is not valid or not allowed on the selected chain",
    };
  }

  const canonicalAddress =
    inspection.format === "pro21-testnet"
      ? inspection.canonicalTestnet
      : inspection.canonicalMainnet;

  return {
    ok: true,
    inspection,
    ...(canonicalAddress !== undefined ? { canonicalAddress } : {}),
  };
}

/**
 * Probes a wallet RPC endpoint for batch support, chain metadata, and canonical
 * `X-Kovanica-Network-Tag` header verification by delegating to `kovanica-sdk`'s `probeRpcNode`.
 */
export async function probeWalletRpcEndpoint(
  url: string,
  expectedChainId?: number | bigint,
  fetchImpl?: typeof fetch,
): Promise<RpcNodeProbeResult> {
  return probeRpcNode(url, {
    ...(expectedChainId !== undefined ? { expectedChainId } : {}),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });
}
