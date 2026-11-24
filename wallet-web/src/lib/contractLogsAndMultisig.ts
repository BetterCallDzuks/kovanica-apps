import {
  CHAIN_IDS,
  DEFAULT_CONTRACT_LOGS_MAX_PAGES,
  DEFAULT_CONTRACT_LOGS_MAX_SPAN,
  DEFAULT_CONTRACT_LOGS_PAGE_LIMIT,
  MULTISIG_BUNDLE_FORMAT,
  MULTISIG_BUNDLE_VERSION,
  bytesToHex,
  checkMultisigQuorum,
  decodeMultisigProposalBundle,
  encodeMultisigProposalBundle,
  inspectAddress,
  parseContractLogCursor,
  queryContractLogsPaginated,
  type ContractLogEntry,
  type ContractLogKind,
  type DecodedMultisigProposalBundle,
  type DecodedPaginatedContractLog,
  type EncodeMultisigProposalBundleInput,
  type MultisigApprovalEntry,
  type MultisigBundleChainId,
  type MultisigProposalBundle,
  type MultisigQuorumInput,
  type MultisigQuorumResult,
  type PaginatedLogsClient,
} from "kovanica-sdk";

export {
  DEFAULT_CONTRACT_LOGS_MAX_PAGES,
  DEFAULT_CONTRACT_LOGS_MAX_SPAN,
  DEFAULT_CONTRACT_LOGS_PAGE_LIMIT,
  MULTISIG_BUNDLE_FORMAT,
  MULTISIG_BUNDLE_VERSION,
};

export type {
  ContractLogEntry,
  ContractLogKind,
  DecodedMultisigProposalBundle,
  DecodedPaginatedContractLog,
  EncodeMultisigProposalBundleInput,
  MultisigApprovalEntry,
  MultisigBundleChainId,
  MultisigProposalBundle,
  MultisigQuorumInput,
  MultisigQuorumResult,
  PaginatedLogsClient,
};

export interface FetchContractLogsPageParams {
  /** Optional PRO-21 contract address (`kvnc...dag` or `tknc...dag`). */
  contractAddress?: string;
  /** Optional chain ID policy for PRO-21 address validation (1 = Mainnet, 2 = Testnet, 3 = Devnet). */
  chainId?: number;
  /** Inclusive start block height (non-negative bigint, safe integer, or decimal/hex string). */
  fromBlock: bigint | number | string;
  /** Inclusive end block height (must be >= fromBlock). */
  toBlock: bigint | number | string;
  /** Maximum inclusive block span per RPC chunk window (defaults to 500). */
  maxSpan?: number;
  /** Maximum number of RPC page requests per call (defaults to 20). */
  maxPages?: number;
  /** Page size hint per RPC request (defaults to 200). */
  pageLimit?: number;
  /** Optional `<height>:<logIndex>` cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Optional positional topic filters. */
  topics?: ReadonlyArray<string | ReadonlyArray<string> | null>;
  /** Optional contract log kind for typed Bincode decoding. */
  logKind?: ContractLogKind;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

export interface ContractLogSummaryItem {
  index: number;
  blockHeight: string | null;
  logIndex: string | null;
  transactionHash: string | null;
  address: string | null;
  topics: string[];
  rawDataPreview: string;
  decodedKind: ContractLogKind | null;
  decodedSummary: string;
  decodedRecord?: unknown;
  raw: ContractLogEntry;
}

export interface ContractLogsPageResult {
  contractAddress: string | null;
  fromBlock: bigint;
  toBlock: bigint;
  maxSpan: number;
  logs: ContractLogEntry[];
  decodedLogs: Array<DecodedPaginatedContractLog<ContractLogKind>>;
  items: ContractLogSummaryItem[];
  nextCursor: string | null;
  hasMore: boolean;
  pagesFetched: number;
  chunksScanned: number;
}

export interface ExportMultisigBundleResult {
  /** Compact canonical JSON string produced by `encodeMultisigProposalBundle`. */
  json: string;
  /** Indented JSON string for UI display and file download. */
  prettyJson: string;
  bundle: MultisigProposalBundle;
  quorum: MultisigQuorumResult;
  quorumSummary: string;
}

export interface InspectedMultisigBundleResult {
  bundle: MultisigProposalBundle;
  quorum: MultisigQuorumResult;
  quorumSummary: string;
  prettyJson: string;
}

export function parseBlockHeightInput(value: bigint | number | string, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new RangeError(`${label} must be a non-negative integer.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer.`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new RangeError(`${label} is required.`);
    }
    if (/^\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    throw new RangeError(`${label} must be a non-negative integer (decimal or 0x hex).`);
  }
  throw new TypeError(`${label} must be a bigint, number, or integer string.`);
}

export function validatePro21ContractAddress(
  rawAddress: string,
  chainId?: number,
): { ok: true; canonical: string } | { ok: false; message: string } {
  const trimmed = rawAddress.trim();
  if (!trimmed) {
    return { ok: false, message: "Contract address is empty." };
  }
  const inspected = inspectAddress(trimmed, chainId);
  if (
    !inspected.valid ||
    (inspected.format !== "pro21-mainnet" && inspected.format !== "pro21-testnet") ||
    !inspected.canonicalMainnet ||
    !inspected.canonicalTestnet
  ) {
    return {
      ok: false,
      message:
        inspected.error ??
        "Contract address must be a valid PRO-21 address (kvnc…dag or tknc…dag).",
    };
  }
  const canonical =
    inspected.format === "pro21-testnet"
      ? inspected.canonicalTestnet
      : inspected.canonicalMainnet;
  return { ok: true, canonical };
}

function normalizeOptionalBlockField(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      return BigInt(trimmed).toString(10);
    }
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }
    return trimmed;
  }
  return null;
}

function formatRawLogDataPreview(data: ContractLogEntry["data"]): string {
  let hex: string;
  if (typeof data === "string") {
    const trimmed = data.trim();
    hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed : `0x${trimmed}`;
  } else if (data instanceof Uint8Array) {
    hex = `0x${bytesToHex(data)}`;
  } else if (Array.isArray(data)) {
    hex = `0x${bytesToHex(Uint8Array.from(data))}`;
  } else {
    return "0x";
  }
  if (hex.length <= 42) return hex;
  return `${hex.slice(0, 26)}…${hex.slice(-12)} (${Math.max(0, (hex.length - 2) / 2)}B)`;
}

export function formatDecodedLogRecord(record: unknown): string {
  try {
    const json = JSON.stringify(record, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString(10);
      if (value instanceof Uint8Array) return `0x${bytesToHex(value)}`;
      return value;
    });
    if (!json) return String(record);
    return json.length > 260 ? `${json.slice(0, 257)}…` : json;
  } catch {
    return String(record);
  }
}

/**
 * Fetches a paginated page of contract event logs via `kovanica-sdk`'s
 * `queryContractLogsPaginated`, enforcing PRO-21 contract address validation,
 * block range validation, optional cursor resumption, and decoded event summaries.
 */
export async function fetchContractLogsPage(
  client: PaginatedLogsClient,
  params: FetchContractLogsPageParams,
): Promise<ContractLogsPageResult> {
  const fromBlock = parseBlockHeightInput(params.fromBlock, "fromBlock");
  const toBlock = parseBlockHeightInput(params.toBlock, "toBlock");
  if (fromBlock > toBlock) {
    throw new RangeError(
      `Invalid block range: fromBlock (${fromBlock.toString()}) must be <= toBlock (${toBlock.toString()}).`,
    );
  }

  let normalizedContract: string | undefined;
  if (params.contractAddress !== undefined && params.contractAddress.trim().length > 0) {
    const check = validatePro21ContractAddress(params.contractAddress, params.chainId);
    if (!check.ok) {
      throw new Error(check.message);
    }
    normalizedContract = check.canonical;
  }

  const maxSpan = params.maxSpan ?? DEFAULT_CONTRACT_LOGS_MAX_SPAN;
  if (!Number.isSafeInteger(maxSpan) || maxSpan < 1) {
    throw new RangeError(`maxSpan must be a positive integer (>= 1), got ${String(maxSpan)}.`);
  }

  const maxPages = params.maxPages ?? DEFAULT_CONTRACT_LOGS_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError(`maxPages must be a positive integer (>= 1), got ${String(maxPages)}.`);
  }

  const pageLimit = params.pageLimit ?? DEFAULT_CONTRACT_LOGS_PAGE_LIMIT;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) {
    throw new RangeError(`pageLimit must be a positive integer (>= 1), got ${String(pageLimit)}.`);
  }

  let normalizedCursor: string | undefined;
  if (params.cursor !== undefined && params.cursor.trim().length > 0) {
    // Validate cursor syntax fail-closed before any RPC request.
    parseContractLogCursor(params.cursor.trim());
    normalizedCursor = params.cursor.trim();
  }

  const result = await queryContractLogsPaginated(
    client,
    {
      fromBlock,
      toBlock,
      ...(normalizedContract ? { address: normalizedContract } : {}),
      ...(params.topics ? { topics: params.topics } : {}),
      ...(normalizedCursor ? { cursor: normalizedCursor } : {}),
    },
    {
      maxSpan,
      maxPages,
      pageLimit,
      ...(normalizedCursor ? { cursor: normalizedCursor } : {}),
      ...(params.logKind ? { decode: true, kind: params.logKind } : { decode: false }),
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );

  const decodedByIndex = new Map<number, DecodedPaginatedContractLog<ContractLogKind>>();
  const decodedLogs = result.decodedLogs ?? [];
  for (const entry of decodedLogs) {
    decodedByIndex.set(entry.index, entry);
  }

  const items: ContractLogSummaryItem[] = result.logs.map((log, index) => {
    const decoded = decodedByIndex.get(index);
    const rawDataPreview = formatRawLogDataPreview(log.data);
    const topics = Array.isArray(log.topics)
      ? log.topics.map((t) => String(t))
      : typeof log.topic === "string"
        ? [log.topic]
        : [];
    const blockHeight = normalizeOptionalBlockField(log.blockNumber ?? log.blockHeight);
    const logIndex = normalizeOptionalBlockField(log.logIndex);
    const transactionHash =
      typeof log.transactionHash === "string" && log.transactionHash.trim().length > 0
        ? log.transactionHash.trim()
        : null;
    const address =
      typeof log.address === "string" && log.address.trim().length > 0
        ? log.address.trim()
        : normalizedContract ?? null;

    return {
      index,
      blockHeight,
      logIndex,
      transactionHash,
      address,
      topics,
      rawDataPreview,
      decodedKind: decoded ? decoded.kind : null,
      decodedSummary: decoded
        ? `${decoded.kind}: ${formatDecodedLogRecord(decoded.record)}`
        : `raw ${rawDataPreview}`,
      ...(decoded ? { decodedRecord: decoded.record } : {}),
      raw: log,
    };
  });

  return {
    contractAddress: normalizedContract ?? null,
    fromBlock,
    toBlock,
    maxSpan,
    logs: result.logs,
    decodedLogs,
    items,
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    pagesFetched: result.pagesFetched,
    chunksScanned: result.chunksScanned,
  };
}

export function resolveMultisigChainId(chainId: number | null | undefined): MultisigBundleChainId {
  if (
    chainId === CHAIN_IDS.MAINNET ||
    chainId === CHAIN_IDS.TESTNET ||
    chainId === CHAIN_IDS.DEVNET
  ) {
    return chainId;
  }
  return CHAIN_IDS.TESTNET;
}

export function formatQuorumProgress(quorum: MultisigQuorumResult): string {
  const status = quorum.quorumReached
    ? "Quorum reached"
    : `${quorum.remainingNeeded} more approval${quorum.remainingNeeded === 1 ? "" : "s"} needed`;
  return `${quorum.approvedCount} / ${quorum.threshold} valid approvals (${status})`;
}

/**
 * Evaluates multisig quorum progress directly via `kovanica-sdk`'s `checkMultisigQuorum`.
 */
export function evaluateMultisigQuorum(input: MultisigQuorumInput): MultisigQuorumResult {
  return checkMultisigQuorum(input);
}

/**
 * Encodes an air-gapped `kovanica-multisig-bundle-v1` JSON bundle via `kovanica-sdk`'s
 * `encodeMultisigProposalBundle` (rejecting any private key / secret fields) and computes
 * its quorum status via `checkMultisigQuorum`.
 */
export function exportMultisigApprovalBundle(
  input: EncodeMultisigProposalBundleInput,
): ExportMultisigBundleResult {
  const json = encodeMultisigProposalBundle(input);
  const decoded = decodeMultisigProposalBundle(json);
  return {
    json,
    prettyJson: JSON.stringify(decoded.bundle, null, 2),
    bundle: decoded.bundle,
    quorum: decoded.quorum,
    quorumSummary: formatQuorumProgress(decoded.quorum),
  };
}

/**
 * Parses and strictly verifies an air-gapped `kovanica-multisig-bundle-v1` JSON bundle
 * via `kovanica-sdk`'s `decodeMultisigProposalBundle` and `checkMultisigQuorum`.
 * Fails closed on malformed payloads or any embedded private/secret key material.
 */
export function inspectMultisigBundle(rawJson: string): InspectedMultisigBundleResult {
  const decoded = decodeMultisigProposalBundle(rawJson);
  return {
    bundle: decoded.bundle,
    quorum: decoded.quorum,
    quorumSummary: formatQuorumProgress(decoded.quorum),
    prettyJson: JSON.stringify(decoded.bundle, null, 2),
  };
}
