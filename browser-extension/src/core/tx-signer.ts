import { blake3 } from "@noble/hashes/blake3.js";
import {
  DEFAULT_CALL_GAS_LIMIT,
  MIN_BASE_FEE_PER_BYTE,
  STORAGE_DEPOSIT_PER_BYTE,
  TRANSFER_TX_WIRE_SIZE,
  buildCallTxKind,
  bytesToHex,
  computeStorageDepositDelta,
  computeTotalRequiredFee,
  concatBytes,
  formatKvnc,
  hexToBytes,
  parseAddressForChain,
  signBatchTransaction,
  signCallContractTransaction,
  signEd25519,
  signSponsoredTransaction,
  signTransferTransaction,
  signingCallKindBytes,
  u32le,
  u64le,
  verifyEd25519,
  wireCallKindBytes,
  type BaseFeeInfo,
  type BatchAction,
  type KovanicaClient,
} from "kovanica-sdk";

export const DEFAULT_TRANSFER_MIN_FEE_ATOMS = 100_000n;
export const DEFAULT_CALL_MIN_FEE_ATOMS = 1_000_000n;
import {
  decodeContractCallPreview,
  type ContractPreviewCategory,
} from "./contract-preview";
import { validateRecipientAddress, type RecipientValidationResult } from "./networks";
import {
  signRegisterSessionKeyTransaction,
  signRevokeSessionKeyTransaction,
  type SessionKeyPolicyInput,
} from "./session-keys";

export const PERSONAL_SIGN_DOMAIN = new TextEncoder().encode("KVNC/personal-sign/v1");

export interface WaveBFeeEstimate {
  baseFeePerByte: string;
  txBytes: number;
  gasUsed: string;
  gasPriceAtoms: string;
  fixedMinFeeAtoms: string;
  totalFeeAtoms: string;
  totalFeeKvnc: string;
  storageDepositDeltaAtoms: string;
  storageDepositDeltaKvnc: string;
  storageDepositPerByte: string;
}

export interface DAppTransferTxParams {
  kind?: "transfer";
  to: string;
  amount: string | number;
  nonce: string | number;
  fee?: string | number;
  chainId?: number;
}

export interface DAppCallTxParams {
  kind: "call";
  contract: string;
  method: string;
  argsHex?: string;
  value?: string | number;
  gasLimit?: string | number;
  nonce: string | number;
  fee?: string | number;
  chainId?: number;
  storageDeltaBytes?: number;
}

export type DAppTransactionParams = DAppTransferTxParams | DAppCallTxParams;

export interface DAppBatchActionInput {
  kind: "transfer" | "deploy" | "call";
  to?: string;
  amount?: string | number;
  codeHex?: string;
  contract?: string;
  value?: string | number;
  method?: string;
  argsHex?: string;
  gasLimit?: string | number;
}

export interface DAppBatchTxParams {
  actions: DAppBatchActionInput[];
  nonce: string | number;
  fee?: string | number;
  chainId?: number;
}

export interface DAppSponsoredTxParams {
  feePayerPublicKeyHex: string;
  feePayerPrivateKeyHex?: string;
  inner: DAppTransferTxParams | DAppCallTxParams;
  nonce: string | number;
  fee?: string | number;
  chainId?: number;
}

export interface ApprovalPreview {
  method: string;
  title: string;
  summary: string;
  chainId: number;
  category?: ContractPreviewCategory;
  badgeLabel?: string;
  warning?: string;
  recipientCheck?: RecipientValidationResult;
  additionalRecipientChecks?: RecipientValidationResult[];
  feeEstimate?: WaveBFeeEstimate;
  details: Array<{ label: string; value: string }>;
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

export function computePersonalMessageHash(message: string | Uint8Array): Uint8Array {
  const msgBytes =
    typeof message === "string" ? new TextEncoder().encode(message) : message;
  return blake3(concatBytes([PERSONAL_SIGN_DOMAIN, u64le(msgBytes.length), msgBytes]));
}

export function signPersonalMessage(
  message: string | Uint8Array,
  privateKey: Uint8Array,
): {
  messageHashHex: string;
  signatureHex: string;
} {
  const hash = computePersonalMessageHash(message);
  const sig = signEd25519(hash, privateKey);
  return {
    messageHashHex: `0x${bytesToHex(hash)}`,
    signatureHex: `0x${bytesToHex(sig)}`,
  };
}

export function verifyPersonalMessage(
  message: string | Uint8Array,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  try {
    const hash = computePersonalMessageHash(message);
    const sig = hexToBytes(strip0x(signatureHex));
    return verifyEd25519(sig, hash, publicKey);
  } catch {
    return false;
  }
}

export function computeWaveBFeeEstimateLocal(params: {
  txBytes: number;
  gasUsed?: bigint;
  fixedMinFee?: bigint;
  baseFeeInfo?: Partial<BaseFeeInfo>;
  storageDeltaBytes?: number;
}): WaveBFeeEstimate {
  const baseFeePerByte = params.baseFeeInfo?.baseFeePerByte ?? MIN_BASE_FEE_PER_BYTE;
  const gasPriceAtoms = params.baseFeeInfo?.defaultGasPriceAtoms ?? 0n;
  const storageDepositPerByte =
    params.baseFeeInfo?.storageDepositPerByte ?? STORAGE_DEPOSIT_PER_BYTE;
  const fixedMinFee = params.fixedMinFee ?? DEFAULT_TRANSFER_MIN_FEE_ATOMS;
  const gasUsed = params.gasUsed ?? 0n;

  const totalFee = computeTotalRequiredFee({
    fixedMinFee,
    txBytes: params.txBytes,
    baseFeePerByte,
    gasUsed,
    gasPrice: gasPriceAtoms,
  });

  const storageDeltaBytes = params.storageDeltaBytes ?? 0;
  const storageDelta =
    storageDeltaBytes !== 0
      ? computeStorageDepositDelta(0, storageDeltaBytes)
      : 0n;

  return {
    baseFeePerByte: baseFeePerByte.toString(),
    txBytes: params.txBytes,
    gasUsed: gasUsed.toString(),
    gasPriceAtoms: gasPriceAtoms.toString(),
    fixedMinFeeAtoms: fixedMinFee.toString(),
    totalFeeAtoms: totalFee.toString(),
    totalFeeKvnc: formatKvnc(totalFee),
    storageDepositDeltaAtoms: storageDelta.toString(),
    storageDepositDeltaKvnc:
      storageDelta >= 0n ? formatKvnc(storageDelta) : `-${formatKvnc(-storageDelta)}`,
    storageDepositPerByte: storageDepositPerByte.toString(),
  };
}

export async function estimateWaveBFeeFromRpc(
  client: Pick<KovanicaClient, "getBaseFee"> | null,
  params: {
    txBytes: number;
    gasUsed?: bigint;
    fixedMinFee?: bigint;
    storageDeltaBytes?: number;
  },
): Promise<WaveBFeeEstimate> {
  let baseFeeInfo: BaseFeeInfo | undefined;
  if (client) {
    try {
      baseFeeInfo = await client.getBaseFee();
    } catch {
      // Offline or older node fallback uses Wave B protocol defaults.
    }
  }
  return computeWaveBFeeEstimateLocal({ ...params, baseFeeInfo });
}

export function buildBatchActionsForChain(
  actions: DAppBatchActionInput[],
  chainId: number,
): BatchAction[] {
  return actions.map((action, idx) => {
    if (action.kind === "transfer") {
      if (!action.to || action.amount === undefined) {
        throw new Error(`Batch action #${idx} transfer requires 'to' and 'amount'`);
      }
      const check = validateRecipientAddress(action.to, chainId);
      if (!check.valid || !check.payloadBytes) {
        throw new Error(check.error ?? `Invalid recipient in batch action #${idx}`);
      }
      return {
        kind: "transfer",
        to: check.payloadBytes,
        amount: BigInt(action.amount),
      };
    }
    if (action.kind === "deploy") {
      if (!action.codeHex) {
        throw new Error(`Batch action #${idx} deploy requires 'codeHex'`);
      }
      return {
        kind: "deploy",
        code: hexToBytes(strip0x(action.codeHex)),
      };
    }
    if (action.kind === "call") {
      if (!action.contract || !action.method) {
        throw new Error(`Batch action #${idx} call requires 'contract' and 'method'`);
      }
      const contractBytes =
        action.contract === "0x" + "00".repeat(32)
          ? new Uint8Array(32)
          : parseAddressForChain(action.contract, chainId);
      return {
        kind: "call",
        contract: contractBytes,
        value: BigInt(action.value ?? 0),
        method: action.method,
        args: action.argsHex ? hexToBytes(strip0x(action.argsHex)) : new Uint8Array(0),
        gasLimit: BigInt(action.gasLimit ?? DEFAULT_CALL_GAS_LIMIT),
      };
    }
    throw new Error(`Unsupported batch action kind at index ${idx}`);
  });
}

export function signDAppTransaction(params: {
  tx: DAppTransactionParams;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  chainId: number;
}): {
  rawTxHex: string;
  signingHashHex: string;
  signatureHex: string;
} {
  const chainId = params.tx.chainId ?? params.chainId;
  if (params.tx.kind === "call") {
    const check = validateRecipientAddress(params.tx.contract, chainId);
    if (!check.valid || !check.payloadBytes) {
      throw new Error(check.error ?? "Invalid contract address");
    }
    const callKind = buildCallTxKind({
      contract: check.payloadBytes,
      method: params.tx.method,
      args: params.tx.argsHex ? hexToBytes(strip0x(params.tx.argsHex)) : new Uint8Array(0),
      gasLimit: BigInt(params.tx.gasLimit ?? DEFAULT_CALL_GAS_LIMIT),
      call_value: BigInt(params.tx.value ?? 0),
    });
    const signed = signCallContractTransaction({
      sender: params.publicKey,
      secretKey: params.privateKey,
      nonce: BigInt(params.tx.nonce),
      fee: BigInt(params.tx.fee ?? DEFAULT_CALL_MIN_FEE_ATOMS),
      chainId,
      call: callKind,
    });
    return {
      rawTxHex: signed.rawTxHex.startsWith("0x") ? signed.rawTxHex : `0x${signed.rawTxHex}`,
      signingHashHex: signed.sighashHex.startsWith("0x")
        ? signed.sighashHex
        : `0x${signed.sighashHex}`,
      signatureHex: signed.signatureHex.startsWith("0x")
        ? signed.signatureHex
        : `0x${signed.signatureHex}`,
    };
  }

  const check = validateRecipientAddress(params.tx.to, chainId);
  if (!check.valid || !check.payloadBytes) {
    throw new Error(check.error ?? "Invalid recipient address");
  }
  const signed = signTransferTransaction({
    privateKey: params.privateKey,
    to: check.payloadBytes,
    amount: BigInt(params.tx.amount),
    nonce: BigInt(params.tx.nonce),
    fee: BigInt(params.tx.fee ?? DEFAULT_TRANSFER_MIN_FEE_ATOMS),
    chainId,
  });
  return {
    rawTxHex: signed.rawTxHex.startsWith("0x") ? signed.rawTxHex : `0x${signed.rawTxHex}`,
    signingHashHex: signed.signingHashHex.startsWith("0x")
      ? signed.signingHashHex
      : `0x${signed.signingHashHex}`,
    signatureHex: signed.signatureHex.startsWith("0x")
      ? signed.signatureHex
      : `0x${signed.signatureHex}`,
  };
}

export function signDAppBatchTransaction(params: {
  tx: DAppBatchTxParams;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  chainId: number;
}): {
  rawTxHex: string;
  signingHashHex: string;
  signatureHex: string;
  actionCount: number;
} {
  const chainId = params.tx.chainId ?? params.chainId;
  const actions = buildBatchActionsForChain(params.tx.actions, chainId);
  const signed = signBatchTransaction({
    chainId,
    senderPrivateKey: params.privateKey,
    senderPublicKey: params.publicKey,
    nonce: BigInt(params.tx.nonce),
    actions,
    fee: BigInt(params.tx.fee ?? DEFAULT_CALL_MIN_FEE_ATOMS),
  });
  return {
    rawTxHex: signed.rawHex,
    signingHashHex: `0x${bytesToHex(signed.hash)}`,
    signatureHex: `0x${bytesToHex(signed.signature)}`,
    actionCount: actions.length,
  };
}

export function signDAppSponsoredTransaction(params: {
  tx: DAppSponsoredTxParams;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  chainId: number;
}): {
  rawTxHex: string;
  signingHashHex: string;
  senderSignatureHex: string;
  sponsorSignatureHex: string;
} {
  const chainId = params.tx.chainId ?? params.chainId;
  const feePayerPublicKey = hexToBytes(strip0x(params.tx.feePayerPublicKeyHex));
  const feePayerPrivateKey = params.tx.feePayerPrivateKeyHex
    ? hexToBytes(strip0x(params.tx.feePayerPrivateKeyHex))
    : params.privateKey;

  let signingInnerKind: Uint8Array;
  let wireInnerKind: Uint8Array;

  if (params.tx.inner.kind === "call") {
    const check = validateRecipientAddress(params.tx.inner.contract, chainId);
    if (!check.valid || !check.payloadBytes) {
      throw new Error(check.error ?? "Invalid sponsored contract address");
    }
    const callKind = buildCallTxKind({
      contract: check.payloadBytes,
      method: params.tx.inner.method,
      args: params.tx.inner.argsHex
        ? hexToBytes(strip0x(params.tx.inner.argsHex))
        : new Uint8Array(0),
      gasLimit: BigInt(params.tx.inner.gasLimit ?? DEFAULT_CALL_GAS_LIMIT),
      call_value: BigInt(params.tx.inner.value ?? 0),
    });
    signingInnerKind = signingCallKindBytes(callKind);
    wireInnerKind = wireCallKindBytes(callKind);
  } else {
    const check = validateRecipientAddress(params.tx.inner.to, chainId);
    if (!check.valid || !check.payloadBytes) {
      throw new Error(check.error ?? "Invalid sponsored recipient address");
    }
    const amount = BigInt(params.tx.inner.amount);
    signingInnerKind = concatBytes([Uint8Array.of(0), check.payloadBytes, u64le(amount)]);
    wireInnerKind = concatBytes([u32le(0), check.payloadBytes, u64le(amount)]);
  }

  const signed = signSponsoredTransaction({
    chainId,
    senderPrivateKey: params.privateKey,
    senderPublicKey: params.publicKey,
    feePayerPrivateKey,
    feePayerPublicKey,
    nonce: BigInt(params.tx.nonce),
    fee: BigInt(params.tx.fee ?? DEFAULT_TRANSFER_MIN_FEE_ATOMS),
    signingInnerKind,
    wireInnerKind,
  });

  return {
    rawTxHex: signed.rawHex,
    signingHashHex: `0x${bytesToHex(signed.hash)}`,
    senderSignatureHex: `0x${bytesToHex(signed.senderSignature)}`,
    sponsorSignatureHex: `0x${bytesToHex(signed.sponsorSignature)}`,
  };
}

export function buildApprovalPreview(params: {
  method: string;
  requestParams: unknown;
  chainId: number;
  baseFeeInfo?: Partial<BaseFeeInfo>;
}): ApprovalPreview {
  const { method, requestParams, chainId, baseFeeInfo } = params;

  if (method === "connect") {
    return {
      method,
      title: "Connect dApp",
      summary: "Share your active PRO-21 Kovanica address and chain ID with this site.",
      chainId,
      details: [{ label: "Permissions", value: "View active address & chain ID" }],
    };
  }

  if (method === "signMessage") {
    const rawMsg =
      typeof requestParams === "string"
        ? requestParams
        : (requestParams as { message?: string })?.message ?? "";
    return {
      method,
      title: "Sign Message",
      summary: "Sign an off-chain domain-separated Kovanica message.",
      chainId,
      details: [
        { label: "Domain", value: "KVNC/personal-sign/v1" },
        { label: "Message", value: rawMsg.slice(0, 240) },
      ],
    };
  }

  if (method === "signTransaction") {
    const tx = requestParams as DAppTransactionParams;
    if (tx?.kind === "call") {
      const recipientCheck = validateRecipientAddress(tx.contract ?? "", chainId);
      const argsLen = tx.argsHex ? strip0x(tx.argsHex).length / 2 : 0;
      const valueAtoms = BigInt(tx.value ?? 0);
      const decoded = decodeContractCallPreview({
        method: tx.method ?? "",
        argsHex: tx.argsHex,
        chainId,
        valueAtoms,
      });
      const feeEstimate = computeWaveBFeeEstimateLocal({
        txBytes: 220 + argsLen + (tx.method?.length ?? 0),
        gasUsed: BigInt(tx.gasLimit ?? DEFAULT_CALL_GAS_LIMIT),
        fixedMinFee: DEFAULT_CALL_MIN_FEE_ATOMS,
        baseFeeInfo,
        storageDeltaBytes: tx.storageDeltaBytes ?? 0,
      });
      return {
        method,
        title: decoded.title,
        summary: decoded.summary,
        chainId,
        category: decoded.category,
        badgeLabel: decoded.badgeLabel,
        warning: decoded.warning,
        recipientCheck,
        feeEstimate,
        details: [
          { label: "Contract", value: tx.contract },
          { label: "Method", value: tx.method },
          ...decoded.details,
          { label: "Value", value: `${formatKvnc(valueAtoms)} KVNC` },
          { label: "Gas Limit", value: String(tx.gasLimit ?? DEFAULT_CALL_GAS_LIMIT) },
          { label: "Nonce", value: String(tx.nonce) },
        ],
      };
    }

    const transfer = tx as DAppTransferTxParams;
    const recipientCheck = validateRecipientAddress(transfer?.to ?? "", chainId);
    const feeEstimate = computeWaveBFeeEstimateLocal({
      txBytes: TRANSFER_TX_WIRE_SIZE,
      fixedMinFee: DEFAULT_TRANSFER_MIN_FEE_ATOMS,
      baseFeeInfo,
    });
    return {
      method,
      title: "Sign Transfer",
      summary: `Transfer ${formatKvnc(BigInt(transfer?.amount ?? 0))} KVNC`,
      chainId,
      recipientCheck,
      feeEstimate,
      details: [
        { label: "Recipient", value: transfer?.to ?? "" },
        { label: "Amount", value: `${formatKvnc(BigInt(transfer?.amount ?? 0))} KVNC` },
        { label: "Nonce", value: String(transfer?.nonce ?? 0) },
      ],
    };
  }

  if (method === "signBatchTransaction") {
    const batch = requestParams as DAppBatchTxParams;
    const actions = Array.isArray(batch?.actions) ? batch.actions : [];
    const recipientChecks: RecipientValidationResult[] = [];
    const actionDetails: Array<{ label: string; value: string }> = [];
    let batchCategory: ContractPreviewCategory | undefined;
    let batchBadgeLabel: string | undefined;
    let batchWarning: string | undefined;

    for (let i = 0; i < actions.length; i++) {
      const act = actions[i]!;
      if (act.kind === "transfer" && act.to) {
        recipientChecks.push(validateRecipientAddress(act.to, chainId));
        actionDetails.push({
          label: `Action #${i + 1}`,
          value: `Transfer ${formatKvnc(BigInt(act.amount ?? 0))} KVNC`,
        });
      } else if (act.kind === "call") {
        if (act.contract && act.contract !== "0x" + "00".repeat(32)) {
          recipientChecks.push(validateRecipientAddress(act.contract, chainId));
        }
        const decoded = decodeContractCallPreview({
          method: act.method ?? "",
          argsHex: act.argsHex,
          chainId,
          valueAtoms: BigInt(act.value ?? 0),
        });
        if (decoded.category === "amm" || decoded.category === "rwa") {
          batchCategory = decoded.category;
          batchBadgeLabel = `Batch · ${decoded.badgeLabel}`;
        } else if (!batchCategory && decoded.category === "token") {
          batchCategory = "token";
          batchBadgeLabel = `Batch · ${decoded.badgeLabel}`;
        }
        if (decoded.warning && !batchWarning) {
          batchWarning = decoded.warning;
        }
        actionDetails.push({
          label: `Action #${i + 1} (${act.method ?? "call"})`,
          value: decoded.summary,
        });
      } else if (act.kind === "deploy") {
        actionDetails.push({
          label: `Action #${i + 1}`,
          value: "Deploy Wasm contract",
        });
      }
    }
    const feeEstimate = computeWaveBFeeEstimateLocal({
      txBytes: 180 + actions.length * 96,
      fixedMinFee: DEFAULT_CALL_MIN_FEE_ATOMS,
      baseFeeInfo,
    });
    return {
      method,
      title: "Sign Atomic Batch (Wave A)",
      summary: `Execute ${actions.length} atomic action(s) all-or-nothing`,
      chainId,
      category: batchCategory,
      badgeLabel: batchBadgeLabel,
      warning: batchWarning,
      recipientCheck: recipientChecks[0],
      additionalRecipientChecks: recipientChecks,
      feeEstimate,
      details: [
        { label: "Actions", value: `${actions.length} (${actions.map((a) => a.kind).join(", ")})` },
        ...actionDetails,
        { label: "Nonce", value: String(batch?.nonce ?? 0) },
      ],
    };
  }

  if (method === "signSponsoredTransaction") {
    const sponsored = requestParams as DAppSponsoredTxParams;
    const isCall = sponsored?.inner?.kind === "call";
    const innerTarget = isCall
      ? (sponsored.inner as DAppCallTxParams).contract
      : (sponsored?.inner as DAppTransferTxParams | undefined)?.to ?? "";
    const recipientCheck = validateRecipientAddress(innerTarget, chainId);
    const decodedCall = isCall
      ? decodeContractCallPreview({
          method: (sponsored.inner as DAppCallTxParams).method ?? "",
          argsHex: (sponsored.inner as DAppCallTxParams).argsHex,
          chainId,
          valueAtoms: BigInt((sponsored.inner as DAppCallTxParams).value ?? 0),
        })
      : null;
    const feeEstimate = computeWaveBFeeEstimateLocal({
      txBytes: 320,
      fixedMinFee: DEFAULT_TRANSFER_MIN_FEE_ATOMS,
      baseFeeInfo,
    });
    return {
      method,
      title: "Sign Sponsored Transaction (Wave A)",
      summary: decodedCall
        ? `Gasless ${decodedCall.badgeLabel}: ${decodedCall.summary}`
        : "Gasless transaction co-signed by a fee sponsor",
      chainId,
      category: decodedCall?.category,
      badgeLabel: decodedCall ? `Sponsored · ${decodedCall.badgeLabel}` : undefined,
      warning: decodedCall?.warning,
      recipientCheck,
      feeEstimate,
      details: [
        { label: "Fee Payer", value: sponsored?.feePayerPublicKeyHex ?? "" },
        { label: "Inner Kind", value: sponsored?.inner?.kind ?? "transfer" },
        ...(decodedCall ? decodedCall.details : []),
        { label: "Nonce", value: String(sponsored?.nonce ?? 0) },
      ],
    };
  }

  if (method === "registerSessionKey" || method === "revokeSessionKey") {
    const feeEstimate = computeWaveBFeeEstimateLocal({
      txBytes: 280,
      fixedMinFee: DEFAULT_CALL_MIN_FEE_ATOMS,
      baseFeeInfo,
    });
    return {
      method,
      title: method === "registerSessionKey" ? "Register Session Key (Wave C)" : "Revoke Session Key (Wave C)",
      summary:
        method === "registerSessionKey"
          ? "Authorize a scoped temporary session key policy on-chain."
          : "Revoke an active temporary session key on-chain.",
      chainId,
      feeEstimate,
      details: [{ label: "Payload", value: JSON.stringify(requestParams) }],
    };
  }

  return {
    method,
    title: `Approve ${method}`,
    summary: `dApp requested ${method}`,
    chainId,
    details: [{ label: "Params", value: JSON.stringify(requestParams ?? {}) }],
  };
}

export { signRegisterSessionKeyTransaction, signRevokeSessionKeyTransaction, type SessionKeyPolicyInput };
