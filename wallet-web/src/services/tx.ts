import type { TxPreview } from "@/core/session";
import { formatSafetyMarginPercent } from "@/core/call-estimate";
import { formatAtoms, formatKvnc } from "@/core/format";

export type ReviewRow = { label: string; value: string; mono?: boolean };

export function reviewRows(preview: TxPreview): ReviewRow[] {
  const feeLabel =
    preview.kind === "call" && preview.feeMarginBps != null
      ? `Margined fee (${formatSafetyMarginPercent(preview.feeMarginBps)})`
      : "Fee";
  const rows: ReviewRow[] = [
    { label: "From", value: preview.sender, mono: true },
    { label: preview.kind === "transfer" ? "To" : "Contract", value: preview.counterparty, mono: true },
    { label: "Account", value: preview.pathLabel },
    {
      label: preview.kind === "transfer" ? "Amount" : "Value",
      value: `${formatKvnc(BigInt(preview.kind === "transfer" ? preview.amountAtoms : preview.valueAtoms))} KVNC (${formatAtoms(BigInt(preview.kind === "transfer" ? preview.amountAtoms : preview.valueAtoms))} atoms)`,
    },
    { label: feeLabel, value: `${formatKvnc(BigInt(preview.feeAtoms))} KVNC (${formatAtoms(BigInt(preview.feeAtoms))} atoms)` },
    { label: "Nonce", value: preview.nonce },
    { label: "Chain", value: `${preview.chainId} · ${preview.networkName}` },
  ];
  if (preview.kind === "call") {
    rows.splice(3, 0, { label: "Method", value: preview.method });
    if (preview.estimatedTxSize != null) {
      rows.push({ label: "Estimated wire size", value: `${preview.estimatedTxSize} bytes` });
    }
    if (preview.feeRatePerByte != null) {
      rows.push({ label: "Fee rate", value: `${formatAtoms(BigInt(preview.feeRatePerByte))} atoms/byte` });
    }
    for (const detail of preview.details) rows.push(detail);
    rows.push({ label: "Args hex", value: preview.argsHex || "none", mono: true });
    rows.push({ label: "Gas limit", value: formatAtoms(BigInt(preview.gasLimit)) });
  }
  return rows;
}
