import {
  DEFAULT_FEE_SAFETY_MARGIN_BPS,
  EscrowClient,
  HtlcClient,
  NameRegistryClient,
  decodeTransactionReceiptLogs,
  dryRunCall,
  estimateAndBuildCall,
  estimateBatchCalls,
  estimateCallTxSize,
  waitForTransactionReceipt,
  type ContractFacadeClient,
  type ContractLogKind,
  type ContractLogKindResolver,
  type DecodedTransactionReceiptLogByKind,
  type DryRunCallClient,
  type EscrowRecord,
  type EstimateAndBuildCallClient,
  type HtlcRecord,
  type NameRecord,
  type ReadContractStorageOptions,
  type RequestOptions,
  type TransactionReceipt,
  type WaitForTransactionReceiptClient,
} from "kovanica-sdk";
import { decodeRecipient } from "./address.ts";
import { bytesToHex } from "./bytes.ts";
import { formatAtoms, formatKvnc } from "./format.ts";
import type { PreviewDetail } from "./session.ts";

export { DEFAULT_FEE_SAFETY_MARGIN_BPS };

export type CallEstimatePreview = {
  estimatedTxSize: number;
  feeRatePerByte: bigint | null;
  marginedFee: bigint;
  feeMarginBps: number;
  gasLimit: bigint;
  nonce: bigint | null;
  chainId: number;
};

export type EstimateContractCallInput = {
  contract: string;
  method: string;
  args: Uint8Array;
  valueAtoms: bigint;
  gasLimit?: bigint;
  sender?: string;
  nonce?: bigint;
  feeMarginBps?: number;
  gasMarginBps?: number;
  minFee?: bigint;
  maxFee?: bigint;
  chainId: number;
};

export type BatchContractCallItemInput = {
  contract: string | Uint8Array;
  method: string;
  args: Uint8Array;
  valueAtoms?: bigint;
  value?: bigint;
  gasLimit?: bigint;
  chainId?: number;
};

export type EstimateContractCallBatchOptions = {
  sender?: string;
  startNonce?: bigint;
  feeRatePerByte?: bigint;
  feeMarginBps?: number;
  gasMarginBps?: number;
  minFeePerCall?: bigint;
  maxTotalFee?: bigint;
  chainId?: number;
  requestOptions?: RequestOptions;
};

export type CallBatchEstimatePreview = {
  calls: CallEstimatePreview[];
  totalEstimatedTxSize: number;
  totalMarginedFee: bigint;
  totalGasLimit: bigint;
  feeRatePerByte: bigint;
  startNonce: bigint | null;
  chainId: number;
};

/**
 * Computes the exact canonical serialized wire size (in bytes) for a signed Call transaction.
 */
export function computeCallWireSize(input: {
  contract: string;
  method: string;
  args: Uint8Array;
  valueAtoms: bigint;
  gasLimit: bigint;
  chainId: number | null;
}): number {
  const contractBytes = decodeRecipient(input.contract, input.chainId);
  return estimateCallTxSize({
    contract: contractBytes,
    method: input.method,
    args: input.args,
    value: input.valueAtoms,
    gasLimit: input.gasLimit,
  });
}

/**
 * Estimates wire size, fee rate, margined fee (+20% default safety margin), gas limit,
 * and sender nonce for a smart contract call via `kovanica-sdk`'s `estimateAndBuildCall`.
 */
export async function estimateContractCallPreview(
  client: EstimateAndBuildCallClient,
  input: EstimateContractCallInput,
): Promise<CallEstimatePreview> {
  const contractBytes = decodeRecipient(input.contract, input.chainId);
  const feeMarginBps = input.feeMarginBps ?? DEFAULT_FEE_SAFETY_MARGIN_BPS;
  const prepared = await estimateAndBuildCall(
    client,
    {
      contract: contractBytes,
      method: input.method,
      args: input.args,
      value: input.valueAtoms,
      ...(input.gasLimit !== undefined ? { gasLimit: input.gasLimit } : {}),
    },
    {
      sender: input.sender,
      nonce: input.nonce,
      feeMarginBps,
      gasMarginBps: input.gasMarginBps,
      minFee: input.minFee,
      maxFee: input.maxFee,
      chainId: input.chainId,
    },
  );

  return {
    estimatedTxSize: prepared.estimatedTxSize,
    feeRatePerByte: prepared.feeRatePerByte ?? null,
    marginedFee: prepared.fee,
    feeMarginBps,
    gasLimit: prepared.gasLimit,
    nonce: prepared.nonce ?? null,
    chainId: prepared.chainId,
  };
}

/**
 * Estimates wire sizes, +20% margined fees, gas limits, and sequential nonces (`startNonce + BigInt(i)`)
 * for a batch of contract calls in a single parallel `estimateFee` + `getNonce` RPC lookup.
 */
export async function estimateContractCallBatchPreview(
  client: EstimateAndBuildCallClient,
  calls: ReadonlyArray<BatchContractCallItemInput>,
  options: EstimateContractCallBatchOptions = {},
): Promise<CallBatchEstimatePreview> {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new RangeError("estimateContractCallBatchPreview requires a non-empty array of calls");
  }

  const resolvedChainId = options.chainId ?? calls[0]?.chainId ?? 1;
  const feeMarginBps = options.feeMarginBps ?? DEFAULT_FEE_SAFETY_MARGIN_BPS;

  const normalizedCalls = calls.map((item) => {
    const contractBytes =
      typeof item.contract === "string"
        ? decodeRecipient(item.contract, item.chainId ?? resolvedChainId)
        : item.contract;
    const value = item.valueAtoms ?? item.value ?? 0n;
    return {
      contract: contractBytes,
      method: item.method,
      args: item.args,
      value,
      ...(item.gasLimit !== undefined ? { gasLimit: item.gasLimit } : {}),
    };
  });

  const preparedBatch = await estimateBatchCalls(client, normalizedCalls, {
    sender: options.sender,
    startNonce: options.startNonce,
    feeRatePerByte: options.feeRatePerByte,
    feeMarginBps,
    gasMarginBps: options.gasMarginBps,
    minFeePerCall: options.minFeePerCall,
    maxTotalFee: options.maxTotalFee,
    chainId: resolvedChainId,
    requestOptions: options.requestOptions,
  });

  const previewCalls: CallEstimatePreview[] = preparedBatch.calls.map((prepared) => ({
    estimatedTxSize: prepared.estimatedTxSize,
    feeRatePerByte: prepared.feeRatePerByte ?? preparedBatch.feeRatePerByte,
    marginedFee: prepared.fee,
    feeMarginBps,
    gasLimit: prepared.gasLimit,
    nonce: prepared.nonce ?? null,
    chainId: prepared.chainId,
  }));

  return {
    calls: previewCalls,
    totalEstimatedTxSize: preparedBatch.totalEstimatedTxSize,
    totalMarginedFee: preparedBatch.totalFee,
    totalGasLimit: preparedBatch.totalGasLimit,
    feeRatePerByte: preparedBatch.feeRatePerByte,
    startNonce: preparedBatch.startNonce ?? null,
    chainId: preparedBatch.chainId,
  };
}

/** Formats basis-points safety margin as a human percentage string (e.g. `12000` -> `"+20%"`). */
export function formatSafetyMarginPercent(marginBps: number): string {
  const deltaBps = Math.max(0, marginBps - 10_000);
  if (deltaBps === 0) return "0%";
  const pct = deltaBps / 100;
  return Number.isInteger(pct) ? `+${pct}%` : `+${pct.toFixed(2)}%`;
}

/** Formats a `CallEstimatePreview` into human-readable detail rows for pre-sign review. */
export function formatCallEstimateSummary(estimate: CallEstimatePreview): PreviewDetail[] {
  const rows: PreviewDetail[] = [
    { label: "Estimated wire size", value: `${estimate.estimatedTxSize} bytes` },
    {
      label: "Fee rate",
      value:
        estimate.feeRatePerByte != null
          ? `${formatAtoms(estimate.feeRatePerByte)} atoms/byte`
          : "explicit",
    },
    {
      label: `Margined fee (${formatSafetyMarginPercent(estimate.feeMarginBps)})`,
      value: `${formatKvnc(estimate.marginedFee)} KVNC (${formatAtoms(estimate.marginedFee)} atoms)`,
    },
    { label: "Gas limit", value: formatAtoms(estimate.gasLimit) },
  ];
  if (estimate.nonce != null) {
    rows.push({ label: "Nonce", value: estimate.nonce.toString() });
  }
  return rows;
}

/** Formats a `CallBatchEstimatePreview` into human-readable summary rows for multi-call batch review. */
export function formatBatchCallEstimateSummary(preview: CallBatchEstimatePreview): PreviewDetail[] {
  const count = preview.calls.length;
  const feeMarginBps = preview.calls[0]?.feeMarginBps ?? DEFAULT_FEE_SAFETY_MARGIN_BPS;
  const firstNonce = preview.startNonce ?? preview.calls[0]?.nonce ?? null;
  const lastNonce =
    firstNonce != null && count > 0 ? firstNonce + BigInt(count - 1) : null;
  const nonceRange =
    firstNonce == null
      ? "auto"
      : count <= 1 || lastNonce === firstNonce
        ? firstNonce.toString()
        : `${firstNonce.toString()}..${lastNonce!.toString()}`;

  return [
    { label: "Batch size", value: `${count} ${count === 1 ? "call" : "calls"}` },
    { label: "Total wire size", value: `${preview.totalEstimatedTxSize} bytes` },
    { label: "Fee rate", value: `${formatAtoms(preview.feeRatePerByte)} atoms/byte` },
    {
      label: `Total margined fee (${formatSafetyMarginPercent(feeMarginBps)})`,
      value: `${formatKvnc(preview.totalMarginedFee)} KVNC (${formatAtoms(preview.totalMarginedFee)} atoms)`,
    },
    { label: "Total gas limit", value: formatAtoms(preview.totalGasLimit) },
    { label: "Nonce range", value: nonceRange },
  ];
}

export type SimulateContractCallInput = {
  contract: string | Uint8Array;
  method: string;
  args: Uint8Array;
  valueAtoms?: bigint;
  value?: bigint;
  gasLimit?: bigint;
  chainId?: number | null;
};

export type SimulateContractCallOptions<TDecoded = undefined> = {
  from?: string | Uint8Array;
  value?: bigint | number;
  gasLimit?: bigint | number;
  decoder?: (bytes: Uint8Array) => TDecoded;
  formatDecoded?: (decoded: TDecoded) => string;
  requestOptions?: RequestOptions;
};

export type SimulateContractCallResult<TDecoded = undefined> =
  | {
      ok: true;
      reverted: false;
      rawHex: string;
      rawBytes: Uint8Array;
      decodedSummary: string;
      decoded?: TDecoded;
    }
  | {
      ok: false;
      reverted: true;
      reason: string;
    };

function summarizeSimulationReturn<TDecoded>(
  rawHex: string,
  rawBytes: Uint8Array,
  decoded: TDecoded | undefined,
  formatDecoded?: (value: TDecoded) => string,
): string {
  if (decoded !== undefined) {
    if (formatDecoded) return formatDecoded(decoded);
    if (typeof decoded === "string") return decoded;
    if (typeof decoded === "bigint" || typeof decoded === "number" || typeof decoded === "boolean") {
      return String(decoded);
    }
    try {
      return JSON.stringify(decoded, (_key, val) => (typeof val === "bigint" ? val.toString() : val));
    } catch {
      return `Decoded return (${rawBytes.length} bytes)`;
    }
  }
  if (rawBytes.length === 0) {
    return "Succeeded (0 bytes returned)";
  }
  const previewHex = rawHex.length > 66 ? `${rawHex.slice(0, 66)}…` : rawHex;
  return `Returned ${rawBytes.length} ${rawBytes.length === 1 ? "byte" : "bytes"} (${previewHex})`;
}

/**
 * Simulates a contract call via `kovanica-sdk`'s `dryRunCall` (`kovanica_call`) before signing.
 * Returns `{ ok: true, reverted: false, rawHex, rawBytes, decodedSummary, decoded? }` on success,
 * or `{ ok: false, reverted: true, reason }` so the UI can warn the user before signing if the call would revert.
 */
export async function simulateContractCallBeforeSign<TDecoded = undefined>(
  client: DryRunCallClient,
  call: SimulateContractCallInput,
  options: SimulateContractCallOptions<TDecoded> = {},
): Promise<SimulateContractCallResult<TDecoded>> {
  try {
    const chainId = call.chainId ?? null;
    const contractBytes =
      typeof call.contract === "string"
        ? decodeRecipient(call.contract, chainId)
        : call.contract;
    const fromArg =
      typeof options.from === "string"
        ? options.from.trim()
          ? decodeRecipient(options.from, chainId)
          : undefined
        : options.from;

    const dryRunOptions = {
      ...(fromArg !== undefined ? { from: fromArg } : {}),
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.gasLimit !== undefined ? { gasLimit: options.gasLimit } : {}),
      ...(options.decoder !== undefined ? { decoder: options.decoder } : {}),
      ...(options.requestOptions !== undefined ? { requestOptions: options.requestOptions } : {}),
    };

    const result = await dryRunCall<TDecoded>(
      client,
      {
        contract: contractBytes,
        method: call.method,
        args: call.args,
        value: call.valueAtoms ?? call.value ?? 0n,
        ...(call.gasLimit !== undefined ? { gasLimit: call.gasLimit } : {}),
      },
      dryRunOptions,
    );

    const decodedSummary = summarizeSimulationReturn(
      result.rawHex,
      result.rawBytes,
      result.decoded,
      options.formatDecoded,
    );

    return {
      ok: true,
      reverted: false,
      rawHex: result.rawHex,
      rawBytes: result.rawBytes,
      decodedSummary,
      ...(result.decoded !== undefined ? { decoded: result.decoded } : {}),
    };
  } catch (error) {
    const rawReason = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
    return {
      ok: false,
      reverted: true,
      reason: rawReason || "Contract call reverted during dry-run simulation.",
    };
  }
}

export type TrackContractReceiptOptions<K extends ContractLogKind = ContractLogKind> = {
  logKind?: K | ContractLogKindResolver<K>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  throwOnRevert?: boolean;
};

export type TrackedContractReceipt<K extends ContractLogKind = ContractLogKind> = {
  receipt: TransactionReceipt;
  status: "success" | "reverted";
  gasUsed: bigint | null;
  decodedLogs: Array<DecodedTransactionReceiptLogByKind<K>>;
};

/**
 * Waits for a submitted contract call transaction receipt via `kovanica-sdk`'s `waitForTransactionReceipt`
 * and optionally decodes contract logs with `decodeTransactionReceiptLogs`.
 */
export async function trackSubmittedContractReceipt<K extends ContractLogKind = ContractLogKind>(
  client: WaitForTransactionReceiptClient,
  txHash: string,
  options: TrackContractReceiptOptions<K> = {},
): Promise<TrackedContractReceipt<K>> {
  const receipt = await waitForTransactionReceipt(client, txHash, {
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.throwOnRevert !== undefined ? { throwOnRevert: options.throwOnRevert } : {}),
  });

  const isSuccess = receipt.success && receipt.status !== 0;
  const decodedLogs = options.logKind
    ? decodeTransactionReceiptLogs(receipt, options.logKind)
    : [];

  return {
    receipt,
    status: isSuccess ? "success" : "reverted",
    gasUsed: receipt.gasUsed ?? null,
    decodedLogs,
  };
}

/**
 * Maps a wallet contract family name to its corresponding `kovanica-sdk` `ContractLogKind`.
 */
export function inferContractLogKind(
  contractFamily: string | null | undefined,
): ContractLogKind | undefined {
  switch (contractFamily?.trim().toLowerCase()) {
    case "name":
      return "name";
    case "token":
      return "token_metadata";
    case "nft":
      return "nft_metadata";
    case "escrow":
      return "escrow";
    case "htlc":
      return "htlc";
    case "vault":
      return "vault";
    case "multisig":
      return "multisig_state";
    default:
      return undefined;
  }
}

function formatDecodedReceiptLogEntry(log: {
  index: number;
  topics?: ReadonlyArray<string>;
  kind: ContractLogKind;
  record: unknown;
}): string {
  const topic = log.topics && log.topics.length > 0 ? ` (${log.topics[0]})` : "";
  let serialized: string;
  try {
    serialized = JSON.stringify(log.record, (_key, val: unknown) => {
      if (typeof val === "bigint") return val.toString();
      if (val instanceof Uint8Array) return `0x${bytesToHex(val)}`;
      return val;
    });
  } catch {
    serialized = "[unserializable record]";
  }
  return `#${log.index} [${log.kind}]${topic}: ${serialized}`;
}

/**
 * Formats a `TrackedContractReceipt` into structured display rows (`Status`, `Gas used`,
 * `Block height`, `Block hash`, `Decoded logs`) for post-broadcast receipt tracking banners.
 */
export function formatReceiptTrackingSummary<K extends ContractLogKind = ContractLogKind>(
  result: TrackedContractReceipt<K>,
): PreviewDetail[] {
  const rows: PreviewDetail[] = [
    {
      label: "Status",
      value: result.status === "success" ? "Confirmed" : "Reverted",
    },
    {
      label: "Gas used",
      value: result.gasUsed != null ? formatAtoms(result.gasUsed) : "—",
    },
    {
      label: "Block height",
      value: result.receipt.blockNumber.toString(),
    },
  ];

  const blockHash = result.receipt.blockHash.trim();
  if (blockHash) {
    rows.push({
      label: "Block hash",
      value: blockHash,
    });
  }

  const rawLogCount = result.receipt.logs?.length ?? 0;
  const decodedValue =
    result.decodedLogs.length > 0
      ? result.decodedLogs.map((entry) => formatDecodedReceiptLogEntry(entry)).join("\n")
      : rawLogCount > 0
        ? `0 decoded (${rawLogCount} raw)`
        : "None";

  rows.push({
    label: "Decoded logs",
    value: decodedValue,
  });

  return rows;
}

export type ContractEntityPrecheckQuery =
  | { family: "name"; contract: string | Uint8Array; name: string; chainId?: number | null }
  | { family: "escrow"; contract: string | Uint8Array; id: string | Uint8Array; chainId?: number | null }
  | { family: "htlc"; contract: string | Uint8Array; id: string | Uint8Array; chainId?: number | null };

export type ContractEntityPrecheckResult =
  | {
      family: "name";
      exists: true;
      summary: string;
      record: NameRecord;
    }
  | {
      family: "name";
      exists: false;
      summary: string;
    }
  | {
      family: "escrow";
      exists: true;
      summary: string;
      record: EscrowRecord;
    }
  | {
      family: "escrow";
      exists: false;
      summary: string;
    }
  | {
      family: "htlc";
      exists: true;
      summary: string;
      record: HtlcRecord;
    }
  | {
      family: "htlc";
      exists: false;
      summary: string;
    };

/**
 * Performs a typed read-before-write on-chain state pre-check using `kovanica-sdk`
 * contract facades (`NameRegistryClient`, `EscrowClient`, `HtlcClient`).
 */
export async function precheckContractEntityAvailability(
  client: ContractFacadeClient,
  query: ContractEntityPrecheckQuery,
  options?: ReadContractStorageOptions,
): Promise<ContractEntityPrecheckResult> {
  const contractBytes =
    typeof query.contract === "string"
      ? decodeRecipient(query.contract, query.chainId ?? null)
      : query.contract;

  if (query.family === "name") {
    const trimmedName = query.name.trim();
    const facade = new NameRegistryClient(client, contractBytes);
    const record = await facade.getRecord(trimmedName, options);
    if (!record) {
      return {
        family: "name",
        exists: false,
        summary: "Available (not registered)",
      };
    }
    const ownerPreview = `0x${record.ownerHex.slice(0, 12)}…`;
    const endpointCount = record.relayEndpoints.length;
    const endpointsNote =
      endpointCount > 0
        ? `, ${endpointCount} relay ${endpointCount === 1 ? "endpoint" : "endpoints"}`
        : "";
    return {
      family: "name",
      exists: true,
      summary: `Already registered (owner ${ownerPreview}${endpointsNote}) — registering "${trimmedName}" may revert.`,
      record,
    };
  }

  if (query.family === "escrow") {
    const facade = new EscrowClient(client, contractBytes);
    const record = await facade.getEscrow(query.id, options);
    if (!record) {
      return {
        family: "escrow",
        exists: false,
        summary: "Not found (no on-chain escrow at this id)",
      };
    }
    return {
      family: "escrow",
      exists: true,
      summary: `Escrow found (${record.status}): ${formatAtoms(record.amount)} atoms, ${record.approvals.length}/${record.threshold} approvals (${record.parties.length} parties), deadline ${record.deadline.toString()}.`,
      record,
    };
  }

  const facade = new HtlcClient(client, contractBytes);
  const record = await facade.getHtlc(query.id, options);
  if (!record) {
    return {
      family: "htlc",
      exists: false,
      summary: "Not found (no on-chain HTLC at this id)",
    };
  }
  return {
    family: "htlc",
    exists: true,
    summary: `HTLC found (${record.status}): ${formatAtoms(record.amount)} atoms, expiry ${record.expiry.toString()}, claimed ${record.claimed ? "yes" : "no"}, refunded ${record.refunded ? "yes" : "no"}.`,
    record,
  };
}
