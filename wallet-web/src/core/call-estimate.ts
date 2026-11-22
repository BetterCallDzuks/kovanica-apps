import {
  DEFAULT_FEE_SAFETY_MARGIN_BPS,
  estimateAndBuildCall,
  estimateCallTxSize,
  type EstimateAndBuildCallClient,
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
