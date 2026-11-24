import {
  CHAIN_IDS,
  DEFAULT_FEE_SAFETY_MARGIN_BPS,
  MAX_TX_GAS_LIMIT,
  decodeAddress,
  dryRunBatchCalls,
  estimateBatchCalls,
  parseAddressForChain,
  type DryRunBatchCallItem,
  type DryRunCallClient,
  type EstimateAndBuildCallClient,
  type RequestOptions,
} from "kovanica-sdk";
import { formatAtoms, formatKvnc } from "../core/format.ts";

export type BatchCallArgsFormat = "hex" | "json";

export type BatchCallDraft = {
  id: string;
  contract: string;
  method: string;
  argsFormat: BatchCallArgsFormat;
  argsInput: string;
  valueAtoms?: string;
  gasLimit?: string;
};

export type ValidatedBatchCall = {
  id: string;
  contract: string;
  contractBytes: Uint8Array;
  method: string;
  args: Uint8Array;
  argsHex: string;
  valueAtoms: bigint;
  gasLimit?: bigint;
};

export type BatchCallValidationField =
  | "contract"
  | "method"
  | "args"
  | "valueAtoms"
  | "gasLimit";

export type BatchCallValidationError = {
  field: BatchCallValidationField;
  message: string;
};

export type BatchCallValidationResult =
  | { ok: true; call: ValidatedBatchCall }
  | { ok: false; errors: BatchCallValidationError[] };

export type BatchContractCallClient = EstimateAndBuildCallClient & DryRunCallClient;

export type PreviewBatchContractCallsOptions = {
  /** Optional sender address (PRO-21) used for nonce lookup and default simulated `from` caller. */
  sender?: string;
  /** Optional explicit simulated caller address override for `dryRunBatchCalls`. */
  from?: string;
  /** Optional explicit starting nonce override (skips `getNonce` RPC when provided). */
  startNonce?: bigint;
  /** Optional explicit fee rate override in atoms/byte (skips `estimateFee` RPC when provided). */
  feeRatePerByte?: bigint;
  /** Fee safety margin in basis points (default: `DEFAULT_FEE_SAFETY_MARGIN_BPS`, i.e. 12000 = +20%). */
  feeMarginBps?: number;
  /** Optional gas safety margin in basis points. */
  gasMarginBps?: number;
  /** Optional minimum fee floor per individual call in atoms. */
  minFeePerCall?: bigint;
  /** Optional aggregate fee cap across the entire batch in atoms. */
  maxTotalFee?: bigint;
  /** Optional default gas limit override for dry-run items without an explicit gasLimit. */
  defaultGasLimit?: bigint;
  /** Execute dry-run RPC calls concurrently when true (default: false = sequential). */
  parallel?: boolean;
  /** Chain ID for PRO-21 validation and prepared call metadata (default: `CHAIN_IDS.MAINNET`). */
  chainId?: number;
  /** Optional RPC request options (`timeoutMs`, `signal`). */
  requestOptions?: RequestOptions;
};

export type BatchCallDryRunOutcome =
  | {
      status: "success";
      rawHex: string;
      rawBytes: Uint8Array;
      returnSummary: string;
    }
  | {
      status: "reverted";
      revertReason: string;
    };

export type BatchCallItemPreview = {
  index: number;
  id: string;
  contract: string;
  method: string;
  valueAtoms: bigint;
  valueKvnc: string;
  estimatedTxSize: number;
  marginedFeeAtoms: bigint;
  marginedFeeKvnc: string;
  gasLimit: bigint;
  nonce: bigint | null;
  dryRun: BatchCallDryRunOutcome;
};

export type BatchContractCallsPreview = {
  calls: BatchCallItemPreview[];
  totalCalls: number;
  passedCount: number;
  revertedCount: number;
  allSucceeded: boolean;
  totalEstimatedTxSize: number;
  totalFeeAtoms: bigint;
  totalFeeKvnc: string;
  totalValueAtoms: bigint;
  totalValueKvnc: string;
  totalCostAtoms: bigint;
  totalCostKvnc: string;
  totalGasLimit: bigint;
  feeRatePerByte: bigint;
  feeMarginBps: number;
  startNonce: bigint | null;
  chainId: number;
};

const U64_MAX = 0xffffffffffffffffn;
const TEXT_ENCODER = new TextEncoder();

let draftCounter = 0;

export function createEmptyBatchCallDraft(id?: string): BatchCallDraft {
  draftCounter += 1;
  return {
    id: id ?? `batch-call-${draftCounter}`,
    contract: "",
    method: "",
    argsFormat: "hex",
    argsInput: "",
    valueAtoms: "0",
    gasLimit: "",
  };
}

export function reorderBatchCalls<T>(
  items: ReadonlyArray<T>,
  fromIndex: number,
  toIndex: number,
): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

function bytesToHexPrefixed(bytes: Uint8Array): string {
  if (bytes.length === 0) return "0x";
  let out = "0x";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Parses contract call arguments from either hex (`0x...` or bare hex) or JSON (UTF-8 encoded).
 */
export function parseBatchCallArgs(
  input: string,
  format: BatchCallArgsFormat,
): { ok: true; bytes: Uint8Array; hex: string } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: true, bytes: new Uint8Array(0), hex: "0x" };
  }

  if (format === "hex") {
    const clean =
      trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
    if (clean.length === 0) {
      return { ok: true, bytes: new Uint8Array(0), hex: "0x" };
    }
    if (clean.length % 2 !== 0) {
      return { ok: false, message: "Hex arguments must have an even number of characters." };
    }
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
      return { ok: false, message: "Hex arguments may only contain 0-9 and a-f characters." };
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return { ok: true, bytes, hex: `0x${clean.toLowerCase()}` };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const canonical = JSON.stringify(parsed);
    const bytes = TEXT_ENCODER.encode(canonical);
    return { ok: true, bytes, hex: bytesToHexPrefixed(bytes) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid syntax";
    return { ok: false, message: `Arguments must be valid JSON (${detail}).` };
  }
}

function validatePro21Address(
  address: string,
  chainId?: number | null,
): { ok: true; canonical: string; bytes: Uint8Array } | { ok: false; message: string } {
  const trimmed = address.trim();
  if (!trimmed) {
    return { ok: false, message: "Contract address is required." };
  }
  try {
    const bytes =
      typeof chainId === "number" && Number.isInteger(chainId)
        ? parseAddressForChain(trimmed, chainId)
        : decodeAddress(trimmed);
    return { ok: true, canonical: trimmed, bytes };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Invalid PRO-21 contract address.",
    };
  }
}

function parseNonNegativeU64(
  raw: string | undefined,
  label: string,
  defaultValue: bigint,
): { ok: true; value: bigint } | { ok: false; message: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: true, value: defaultValue };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: `${label} must be a whole non-negative integer.` };
  }
  const value = BigInt(trimmed);
  if (value > U64_MAX) {
    return { ok: false, message: `${label} exceeds maximum u64 value.` };
  }
  return { ok: true, value };
}

function parseOptionalGasLimit(
  raw: string | undefined,
): { ok: true; value: bigint | undefined } | { ok: false; message: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "Gas limit must be a positive whole integer." };
  }
  const value = BigInt(trimmed);
  if (value <= 0n) {
    return { ok: false, message: "Gas limit must be greater than zero." };
  }
  if (value > MAX_TX_GAS_LIMIT) {
    return {
      ok: false,
      message: `Gas limit exceeds maximum allowed (${formatAtoms(MAX_TX_GAS_LIMIT)}).`,
    };
  }
  return { ok: true, value };
}

/**
 * Validates a single `BatchCallDraft` into a typed `ValidatedBatchCall` without throwing.
 */
export function validateBatchCallDraft(
  draft: BatchCallDraft,
  chainId?: number | null,
): BatchCallValidationResult {
  const errors: BatchCallValidationError[] = [];

  const addrCheck = validatePro21Address(draft.contract, chainId);
  if (!addrCheck.ok) {
    errors.push({ field: "contract", message: addrCheck.message });
  }

  const trimmedMethod = draft.method.trim();
  if (!trimmedMethod) {
    errors.push({ field: "method", message: "Method name is required." });
  } else if (/[\r\n\t\0]/.test(trimmedMethod)) {
    errors.push({ field: "method", message: "Method name cannot contain control characters." });
  }

  const argsCheck = parseBatchCallArgs(draft.argsInput, draft.argsFormat);
  if (!argsCheck.ok) {
    errors.push({ field: "args", message: argsCheck.message });
  }

  const valueCheck = parseNonNegativeU64(draft.valueAtoms, "Attached value", 0n);
  if (!valueCheck.ok) {
    errors.push({ field: "valueAtoms", message: valueCheck.message });
  }

  const gasCheck = parseOptionalGasLimit(draft.gasLimit);
  if (!gasCheck.ok) {
    errors.push({ field: "gasLimit", message: gasCheck.message });
  }

  if (
    errors.length > 0 ||
    !addrCheck.ok ||
    !argsCheck.ok ||
    !valueCheck.ok ||
    !gasCheck.ok
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    call: {
      id: draft.id,
      contract: addrCheck.canonical,
      contractBytes: addrCheck.bytes,
      method: trimmedMethod,
      args: argsCheck.bytes,
      argsHex: argsCheck.hex,
      valueAtoms: valueCheck.value,
      ...(gasCheck.value !== undefined ? { gasLimit: gasCheck.value } : {}),
    },
  };
}

function isValidatedBatchCall(
  item: BatchCallDraft | ValidatedBatchCall,
): item is ValidatedBatchCall {
  return (
    typeof item === "object" &&
    item !== null &&
    "contractBytes" in item &&
    item.contractBytes instanceof Uint8Array &&
    "args" in item &&
    item.args instanceof Uint8Array &&
    typeof item.valueAtoms === "bigint"
  );
}

function summarizeDryRunReturn(rawHex: string, rawBytes: Uint8Array): string {
  if (rawBytes.length === 0) {
    return "Succeeded (0 bytes returned)";
  }
  const preview = rawHex.length > 66 ? `${rawHex.slice(0, 66)}…` : rawHex;
  return `Returned ${rawBytes.length} ${rawBytes.length === 1 ? "byte" : "bytes"} (${preview})`;
}

/**
 * Estimates fees/gas/wire sizes (`estimateBatchCalls`) and executes read-only simulations
 * (`dryRunBatchCalls`) for a non-empty batch of contract calls.
 *
 * - Rejects empty batches or invalid items fail-closed before any RPC I/O.
 * - Preserves per-call success/revert outcomes even when some calls revert (`continueOnError: true`).
 * - Computes all KVNC fee, value, and total cost aggregates using lossless `bigint` arithmetic.
 */
export async function previewBatchContractCalls(
  client: BatchContractCallClient,
  calls: ReadonlyArray<BatchCallDraft | ValidatedBatchCall>,
  options: PreviewBatchContractCallsOptions = {},
): Promise<BatchContractCallsPreview> {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new RangeError("Batch preview requires at least one contract call.");
  }

  const resolvedChainId = options.chainId ?? CHAIN_IDS.MAINNET;
  const feeMarginBps = options.feeMarginBps ?? DEFAULT_FEE_SAFETY_MARGIN_BPS;

  // Validate all items fail-closed before performing any RPC I/O.
  const validatedCalls: ValidatedBatchCall[] = calls.map((item, idx) => {
    if (isValidatedBatchCall(item)) {
      const addrCheck = validatePro21Address(item.contract, resolvedChainId);
      if (!addrCheck.ok) {
        throw new Error(`Call #${idx + 1} contract: ${addrCheck.message}`);
      }
      const method = item.method.trim();
      if (!method) {
        throw new Error(`Call #${idx + 1} method: Method name is required.`);
      }
      if (item.valueAtoms < 0n || item.valueAtoms > U64_MAX) {
        throw new RangeError(`Call #${idx + 1} valueAtoms out of range for u64.`);
      }
      if (item.gasLimit !== undefined && (item.gasLimit <= 0n || item.gasLimit > MAX_TX_GAS_LIMIT)) {
        throw new RangeError(`Call #${idx + 1} gasLimit out of allowed range.`);
      }
      return {
        ...item,
        contract: addrCheck.canonical,
        contractBytes: addrCheck.bytes,
        method,
      };
    }

    const res = validateBatchCallDraft(item, resolvedChainId);
    if (!res.ok) {
      const first = res.errors[0]!;
      throw new Error(`Call #${idx + 1} (${first.field}): ${first.message}`);
    }
    return res.call;
  });

  // Validate optional sender / from addresses before RPC I/O
  const senderTrimmed = options.sender?.trim() || undefined;
  const fromTrimmed = options.from?.trim() || senderTrimmed;
  let fromBytes: Uint8Array | undefined;
  if (fromTrimmed) {
    const check = validatePro21Address(fromTrimmed, resolvedChainId);
    if (!check.ok) {
      throw new Error(`Simulated caller address: ${check.message}`);
    }
    fromBytes = check.bytes;
  }

  const sdkCallInputs = validatedCalls.map((item) => ({
    contract: item.contractBytes,
    method: item.method,
    args: item.args,
    value: item.valueAtoms,
    ...(item.gasLimit !== undefined ? { gasLimit: item.gasLimit } : {}),
  }));

  const dryRunItems: DryRunBatchCallItem[] = sdkCallInputs;

  const [estimated, dryRun] = await Promise.all([
    estimateBatchCalls(client, sdkCallInputs, {
      sender: senderTrimmed,
      startNonce: options.startNonce,
      feeRatePerByte: options.feeRatePerByte,
      feeMarginBps,
      gasMarginBps: options.gasMarginBps,
      minFeePerCall: options.minFeePerCall,
      maxTotalFee: options.maxTotalFee,
      chainId: resolvedChainId,
      requestOptions: options.requestOptions,
    }),
    dryRunBatchCalls(client, dryRunItems, {
      parallel: options.parallel ?? false,
      continueOnError: true,
      ...(fromBytes !== undefined ? { from: fromBytes } : {}),
      ...(options.defaultGasLimit !== undefined ? { gasLimit: options.defaultGasLimit } : {}),
      ...(options.requestOptions !== undefined ? { requestOptions: options.requestOptions } : {}),
    }),
  ]);

  let totalValueAtoms = 0n;
  const items: BatchCallItemPreview[] = validatedCalls.map((validated, idx) => {
    const est = estimated.calls[idx]!;
    const sim = dryRun.results[idx]!;
    totalValueAtoms += validated.valueAtoms;

    const outcome: BatchCallDryRunOutcome = sim.ok
      ? {
          status: "success",
          rawHex: sim.result.rawHex,
          rawBytes: sim.result.rawBytes,
          returnSummary: summarizeDryRunReturn(sim.result.rawHex, sim.result.rawBytes),
        }
      : {
          status: "reverted",
          revertReason:
            sim.error.message.trim() || "Contract call reverted during dry-run simulation.",
        };

    return {
      index: idx,
      id: validated.id,
      contract: validated.contract,
      method: validated.method,
      valueAtoms: validated.valueAtoms,
      valueKvnc: formatKvnc(validated.valueAtoms),
      estimatedTxSize: est.estimatedTxSize,
      marginedFeeAtoms: est.fee,
      marginedFeeKvnc: formatKvnc(est.fee),
      gasLimit: est.gasLimit,
      nonce: est.nonce ?? null,
      dryRun: outcome,
    };
  });

  const totalFeeAtoms = estimated.totalFee;
  const totalCostAtoms = totalFeeAtoms + totalValueAtoms;

  return {
    calls: items,
    totalCalls: items.length,
    passedCount: dryRun.passedCount,
    revertedCount: dryRun.failedCount,
    allSucceeded: dryRun.failedCount === 0,
    totalEstimatedTxSize: estimated.totalEstimatedTxSize,
    totalFeeAtoms,
    totalFeeKvnc: formatKvnc(totalFeeAtoms),
    totalValueAtoms,
    totalValueKvnc: formatKvnc(totalValueAtoms),
    totalCostAtoms,
    totalCostKvnc: formatKvnc(totalCostAtoms),
    totalGasLimit: estimated.totalGasLimit,
    feeRatePerByte: estimated.feeRatePerByte,
    feeMarginBps,
    startNonce: estimated.startNonce ?? null,
    chainId: estimated.chainId,
  };
}
