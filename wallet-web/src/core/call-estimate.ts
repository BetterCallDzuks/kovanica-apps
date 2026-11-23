import {
  DEFAULT_FEE_SAFETY_MARGIN_BPS,
  estimateAndBuildCall,
  estimateBatchCalls,
  estimateCallTxSize,
  type EstimateAndBuildCallClient,
  type RequestOptions,
} from "kovanica-sdk";
import { decodeRecipient } from "./address.ts";
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
