import { useCallback, useEffect, useRef, useState } from "react";
import type { ContractLogKind } from "kovanica-sdk";
import { checkAddress, decodeRecipient } from "@/core/address";
import { equalBytes } from "@/core/bytes";
import {
  buildContractCall,
  decodeHtlc,
  decodeMultisigState,
  decodeMultisigTx,
  decodeTokenState,
  decodeVault,
  multisigTxSlot,
  prefixedSlot,
  tokenStateSlot,
  type CallDraft,
  type ContractName,
} from "@/core/contracts";
import {
  estimateContractCallBatchPreview,
  estimateContractCallPreview,
  formatBatchCallEstimateSummary,
  formatCallEstimateSummary,
  formatReceiptTrackingSummary,
  inferContractLogKind,
  precheckContractEntityAvailability,
  simulateContractCallBeforeSign,
  trackSubmittedContractReceipt,
  type CallBatchEstimatePreview,
  type CallEstimatePreview,
  type ContractEntityPrecheckResult,
  type SimulateContractCallResult,
  type TrackedContractReceipt,
} from "@/core/call-estimate";
import { parseAtoms } from "@/core/format";
import { callNeed, shortfall } from "@/core/history-row";
import type { TxPreview } from "@/core/session";
import { ContactSelect } from "@/components/contacts/ContactSelect";
import { FaucetButton } from "@/components/home/FaucetButton";
import { presetById } from "@/lib/networks";
import { buildCallPreview } from "@/services/wallet";
import {
  createCallEstimateClient,
  createContractFacadeClient,
  createDryRunCallClient,
  createReceiptTrackingClient,
  readStorageAt,
} from "@/services/rpc";
import { signingLock, useNetwork } from "@/stores/network";
import { useActivity } from "@/stores/activity";

const ACTIONS = {
  token: [
    { id: "balance_of", label: "balance_of", sign: false },
    { id: "token_transfer", label: "transfer", sign: true },
    { id: "token_mint", label: "mint", sign: true },
  ],
  htlc: [
    { id: "htlc_status", label: "status", sign: false },
    { id: "htlc_create", label: "create", sign: true },
    { id: "htlc_claim", label: "claim", sign: true },
    { id: "htlc_refund", label: "refund", sign: true },
  ],
  vault: [
    { id: "vault_create", label: "deposit", sign: true },
    { id: "vault_claim", label: "withdraw", sign: true },
    { id: "status", label: "status", sign: false },
  ],
  multisig: [
    { id: "multisig_status", label: "status", sign: false },
    { id: "multisig_tx", label: "tx_status", sign: false },
    { id: "multisig_create", label: "create", sign: true },
    { id: "multisig_propose", label: "propose", sign: true },
    { id: "multisig_confirm", label: "confirm", sign: true },
    { id: "multisig_execute", label: "execute", sign: true },
  ],
  name: [
    { id: "name_register", label: "register", sign: true },
  ],
  nft: [
    { id: "nft_mint", label: "mint", sign: true },
  ],
  escrow: [
    { id: "escrow_create", label: "create", sign: true },
  ],
} as const;

type ActionId = (typeof ACTIONS)[ContractName][number]["id"];

type QueuedBatchCall = {
  id: number;
  contract: string;
  contractKind: ContractName;
  actionLabel: string;
  method: string;
  args: Uint8Array;
  valueAtoms: bigint;
  gasLimit?: bigint;
};

export function Contracts({
  onReview,
  prefill,
  ownerAddress = "",
}: {
  onReview: (preview: TxPreview) => void;
  prefill?: { address: string; kind: ContractName } | null;
  ownerAddress?: string;
}) {
  const net = useNetwork();
  const lock = signingLock(net);
  const policyChain = net.probedChainId ?? presetById(net.presetId).expectedChainId;
  const [contractId, setContractId] = useState<ContractName>("token");
  const [action, setAction] = useState<ActionId>("balance_of");
  const [contract, setContract] = useState("");
  const [owner, setOwner] = useState(ownerAddress);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [hash, setHash] = useState("");
  const [timelock, setTimelock] = useState("");
  const [secret, setSecret] = useState("");
  const [recordId, setRecordId] = useState("");
  const [proposal, setProposal] = useState("");
  const [callData, setCallData] = useState("");
  const [threshold, setThreshold] = useState("1");
  const [owners, setOwners] = useState("");
  const [name, setName] = useState("");
  const [relayEndpoints, setRelayEndpoints] = useState("");
  const [collection, setCollection] = useState("");
  const [tokenId, setTokenId] = useState("1");
  const [tokenUri, setTokenUri] = useState("");
  const [deadline, setDeadline] = useState("");
  const [value, setValue] = useState("0");
  const [gas, setGas] = useState("100000");
  const [error, setError] = useState<string | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [estimate, setEstimate] = useState<CallEstimatePreview | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [simulation, setSimulation] = useState<SimulateContractCallResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [precheck, setPrecheck] = useState<ContractEntityPrecheckResult | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [precheckId, setPrecheckId] = useState("");
  const [batchQueue, setBatchQueue] = useState<QueuedBatchCall[]>([]);
  const [batchEstimate, setBatchEstimate] = useState<CallBatchEstimatePreview | null>(null);
  const [estimatingBatch, setEstimatingBatch] = useState(false);
  const [nextBatchId, setNextBatchId] = useState(1);
  const selected = ACTIONS[contractId];
  const current = selected.find((item) => item.id === action) ?? selected[0];
  const address = checkAddress(contract, policyChain);

  useEffect(() => {
    if (ownerAddress) setOwner((currentOwner) => currentOwner || ownerAddress);
  }, [ownerAddress]);

  useEffect(() => {
    if (!prefill) return;
    setContract(prefill.address);
    setContractId(prefill.kind);
    setAction(ACTIONS[prefill.kind][0].id);
  }, [prefill]);

  function pickContract(next: ContractName) {
    setContractId(next);
    setAction(ACTIONS[next][0].id);
    setError(null);
    setReadout(null);
    setEstimate(null);
    setSimulation(null);
    setPrecheck(null);
  }

  function needs(name: string): boolean {
    const id = current.id;
    if (name === "owner") return id === "balance_of" || id === "token_mint";
    if (name === "recipient") return id === "token_transfer" || id === "htlc_create" || id === "vault_create" || id === "multisig_propose" || id === "name_register" || id === "nft_mint";
    if (name === "amount") return id === "token_transfer" || id === "token_mint" || id === "htlc_create" || id === "vault_create" || id === "multisig_propose" || id === "escrow_create";
    if (name === "hash") return id === "htlc_create";
    if (name === "timelock") return id === "htlc_create" || id === "vault_create";
    if (name === "secret") return id === "htlc_claim";
    if (name === "record") return id === "htlc_status" || id === "htlc_claim" || id === "htlc_refund" || id === "vault_claim" || id === "status" || id === "multisig_propose" || id === "multisig_confirm" || id === "multisig_execute";
    if (name === "proposal") return id === "multisig_confirm" || id === "multisig_execute" || id === "multisig_tx";
    if (name === "calldata") return id === "multisig_propose";
    if (name === "threshold" || name === "owners") return id === "multisig_create" || id === "escrow_create";
    if (name === "name") return id === "name_register";
    if (name === "endpoints") return id === "name_register";
    if (name === "collection" || name === "token_id" || name === "token_uri") return id === "nft_mint";
    if (name === "deadline") return id === "escrow_create";
    return false;
  }

  function whole(text: string, label: string): bigint {
    const parsed = parseAtoms(text);
    if (parsed == null) throw new Error(`${label} must be a whole number of atoms, not a decimal.`);
    return parsed;
  }

  function hex32(text: string, label: string): string {
    const clean = text.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error(`${label} must be 64 hex characters.`);
    return clean;
  }

  function draft(): CallDraft {
    const amountAtoms = needs("amount") ? whole(amount, "Amount") : null;
    if (amountAtoms != null && amountAtoms <= 0n) throw new Error("Amount must be greater than zero.");
    return buildContractCall({
      contract: contractId,
      method: current.id,
      chainId: policyChain,
      claimer: recipient,
      beneficiary: recipient,
      recipient,
      account: owner,
      hash,
      secret,
      id: recordId,
      timelockMs: needs("timelock") && current.id === "htlc_create" ? whole(timelock, "Timelock") : null,
      lockUntilMs: current.id === "vault_create" ? whole(timelock, "Lock until") : null,
      amountAtoms,
      tokenUnits: current.id === "token_transfer" || current.id === "token_mint" ? amountAtoms : null,
      txId: needs("proposal") ? whole(proposal, "Proposal id") : null,
      callDataHex: callData,
      threshold: needs("threshold") ? Number.parseInt(threshold, 10) : null,
      owners: needs("owners") ? owners : undefined,
      name,
      pubkey: recipient,
      relayEndpoints: relayEndpoints ? relayEndpoints.split(",").map((s) => s.trim()).filter(Boolean) : [],
      collection,
      tokenId: needs("token_id") ? whole(tokenId, "Token ID") : null,
      tokenUri,
      deadline: needs("deadline") ? whole(deadline, "Deadline") : null,
    });
  }

  async function checkOnChainState() {
    setError(null);
    setPrecheck(null);
    if (contractId !== "name" && contractId !== "escrow" && contractId !== "htlc") return;
    if (!address.ok) {
      setError(address.message);
      return;
    }
    if (!net.online) {
      setError("The node is not responding, so on-chain state cannot be checked.");
      return;
    }
    setPrechecking(true);
    try {
      const facadeClient = createContractFacadeClient(net.rpcUrl);
      if (contractId === "name") {
        const trimmed = name.trim();
        if (!trimmed) throw new Error("Enter a name to check its on-chain registration status.");
        const result = await precheckContractEntityAvailability(facadeClient, {
          family: "name",
          contract,
          name: trimmed,
          chainId: policyChain,
        });
        setPrecheck(result);
        return;
      }
      if (contractId === "escrow") {
        const idHex = hex32(precheckId, "Escrow id");
        const result = await precheckContractEntityAvailability(facadeClient, {
          family: "escrow",
          contract,
          id: idHex,
          chainId: policyChain,
        });
        setPrecheck(result);
        return;
      }
      const rawSwapId = needs("record") ? recordId : precheckId;
      const swapIdHex = hex32(rawSwapId, "Swap id");
      const result = await precheckContractEntityAvailability(facadeClient, {
        family: "htlc",
        contract,
        id: swapIdHex,
        chainId: policyChain,
      });
      setPrecheck(result);
    } catch (err) {
      setPrecheck(null);
      setError(err instanceof Error ? err.message : "Could not check on-chain contract state");
    } finally {
      setPrechecking(false);
    }
  }

  async function estimateCall(): Promise<{ built: CallDraft; valueAtoms: bigint; preview: CallEstimatePreview } | null> {
    setError(null);
    setReadout(null);
    if (!current.sign) return null;
    if (lock.locked || net.probedChainId == null) {
      setError(lock.locked ? lock.reason : "Node chain id is not available yet.");
      return null;
    }
    if (!address.ok) {
      setError(address.message);
      return null;
    }
    const valueAtoms = parseAtoms(value);
    const parsedGas = gas.trim() === "" ? undefined : parseAtoms(gas);
    if (valueAtoms == null || (gas.trim() !== "" && parsedGas == null)) {
      setError("Attached value and gas limit must be whole numbers of atoms.");
      return null;
    }
    const gasLimit = parsedGas ?? undefined;
    setEstimating(true);
    try {
      if (needs("hash")) hex32(hash, "Hash");
      if (needs("secret") && !secret.trim()) throw new Error("Enter the secret as hex or text.");
      const built = draft();
      const client = createCallEstimateClient(net.rpcUrl);
      const preview = await estimateContractCallPreview(client, {
        contract,
        method: built.method,
        args: built.args,
        valueAtoms,
        gasLimit,
        sender: ownerAddress || undefined,
        nonce: ownerAddress ? undefined : (net.nonce ?? undefined),
        chainId: net.probedChainId,
      });
      setEstimate(preview);
      return { built, valueAtoms, preview };
    } catch (err) {
      setEstimate(null);
      setError(err instanceof Error ? err.message : "Could not estimate fee and gas for this call");
      return null;
    } finally {
      setEstimating(false);
    }
  }

  async function simulateCurrentCall() {
    setError(null);
    setReadout(null);
    if (!current.sign) return;
    if (lock.locked || net.probedChainId == null) {
      setError(lock.locked ? lock.reason : "Node chain id is not available yet.");
      return;
    }
    if (!address.ok) {
      setError(address.message);
      return;
    }
    const valueAtoms = parseAtoms(value);
    const parsedGas = gas.trim() === "" ? undefined : parseAtoms(gas);
    if (valueAtoms == null || (gas.trim() !== "" && parsedGas == null)) {
      setError("Attached value and gas limit must be whole numbers of atoms.");
      return;
    }
    setSimulating(true);
    try {
      if (needs("hash")) hex32(hash, "Hash");
      if (needs("secret") && !secret.trim()) throw new Error("Enter the secret as hex or text.");
      const built = draft();
      const dryRunClient = createDryRunCallClient(net.rpcUrl);
      const result = await simulateContractCallBeforeSign(
        dryRunClient,
        {
          contract,
          method: built.method,
          args: built.args,
          valueAtoms,
          gasLimit: parsedGas ?? undefined,
          chainId: net.probedChainId,
        },
        {
          from: ownerAddress || undefined,
        },
      );
      setSimulation(result);
    } catch (err) {
      setSimulation(null);
      setError(err instanceof Error ? err.message : "Could not simulate this contract call");
    } finally {
      setSimulating(false);
    }
  }

  function queueCallToBatch() {
    setError(null);
    setReadout(null);
    if (!current.sign) return;
    if (!address.ok) {
      setError(address.message);
      return;
    }
    const valueAtoms = parseAtoms(value);
    const parsedGas = gas.trim() === "" ? undefined : parseAtoms(gas);
    if (valueAtoms == null || (gas.trim() !== "" && parsedGas == null)) {
      setError("Attached value and gas limit must be whole numbers of atoms.");
      return;
    }
    try {
      if (needs("hash")) hex32(hash, "Hash");
      if (needs("secret") && !secret.trim()) throw new Error("Enter the secret as hex or text.");
      const built = draft();
      const item: QueuedBatchCall = {
        id: nextBatchId,
        contract: contract.trim(),
        contractKind: contractId,
        actionLabel: current.label,
        method: built.method,
        args: built.args,
        valueAtoms,
        gasLimit: parsedGas ?? undefined,
      };
      setNextBatchId((n) => n + 1);
      setBatchQueue((prev) => [...prev, item]);
      setBatchEstimate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue call to batch");
    }
  }

  async function estimateQueuedBatch() {
    setError(null);
    setReadout(null);
    if (batchQueue.length === 0) {
      setError("Queue at least one contract call before estimating a batch.");
      return;
    }
    if (lock.locked || net.probedChainId == null) {
      setError(lock.locked ? lock.reason : "Node chain id is not available yet.");
      return;
    }
    setEstimatingBatch(true);
    try {
      const client = createCallEstimateClient(net.rpcUrl);
      const preview = await estimateContractCallBatchPreview(
        client,
        batchQueue.map((item) => ({
          contract: item.contract,
          method: item.method,
          args: item.args,
          valueAtoms: item.valueAtoms,
          gasLimit: item.gasLimit,
        })),
        {
          sender: ownerAddress || undefined,
          startNonce: ownerAddress ? undefined : (net.nonce ?? undefined),
          chainId: net.probedChainId,
        },
      );
      setBatchEstimate(preview);
    } catch (err) {
      setBatchEstimate(null);
      setError(err instanceof Error ? err.message : "Could not estimate fee and gas for batch calls");
    } finally {
      setEstimatingBatch(false);
    }
  }

  function clearBatchQueue() {
    setBatchQueue([]);
    setBatchEstimate(null);
  }

  async function review() {
    const result = await estimateCall();
    if (!result) return;
    const resolvedNonce = result.preview.nonce ?? net.nonce;
    if (resolvedNonce == null) {
      setError("Sender nonce is not available yet.");
      return;
    }
    try {
      onReview(buildCallPreview({
        contract,
        method: result.built.method,
        args: result.built.args,
        valueAtoms: result.valueAtoms,
        gasLimit: result.preview.gasLimit,
        feeAtoms: result.preview.marginedFee,
        nonce: resolvedNonce,
        chainId: result.preview.chainId,
        networkName: lock.networkName,
        details: [{ label: "Action", value: current.label }, ...result.built.details],
        estimatedTxSize: result.preview.estimatedTxSize,
        feeRatePerByte: result.preview.feeRatePerByte?.toString(),
        feeMarginBps: result.preview.feeMarginBps,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the call");
    }
  }

  async function readState() {
    setError(null);
    setReadout(null);
    if (!address.ok) {
      setError(address.message);
      return;
    }
    if (!net.online) {
      setError("The node is not responding, so this contract cannot be read.");
      return;
    }
    setReading(true);
    try {
      if (current.id === "balance_of") {
        const ownerCheck = checkAddress(owner, policyChain);
        if (!ownerCheck.ok) throw new Error(ownerCheck.message);
        const key = decodeRecipient(owner, policyChain);
        const raw = await readStorageAt(net.rpcUrl, contract, tokenStateSlot());
        const state = raw ? decodeTokenState(raw) : null;
        if (!state) throw new Error("This contract has no token state yet.");
        const row = state.balances.find((item) => equalBytes(item.account, key));
        setReadout(`${state.name} (${state.symbol}) balance_of ${owner.trim().toLowerCase()}: ${(row?.amount ?? 0n).toString()} base units. Supply ${state.totalSupply.toString()}. Decimals ${state.decimals}.`);
        return;
      }
      if (current.id === "multisig_status") {
        const raw = await readStorageAt(net.rpcUrl, contract, tokenStateSlot());
        const state = raw ? decodeMultisigState(raw) : null;
        if (!state) throw new Error("This contract has no multisig state yet.");
        setReadout(`Multisig status: threshold ${state.threshold} of ${state.owners.length} owners, next_tx_id ${state.nextTxId.toString()}.\nOwners: ${state.owners.join(", ")}`);
        return;
      }
      if (current.id === "multisig_tx") {
        const txId = whole(proposal, "Proposal id");
        const raw = await readStorageAt(net.rpcUrl, contract, multisigTxSlot(txId));
        const tx = raw ? decodeMultisigTx(raw) : null;
        if (!tx) throw new Error(`No multisig transaction found at proposal id ${txId.toString()}.`);
        setReadout(`Proposal ${tx.id.toString()}: to ${tx.to}, amount ${tx.amount.toString()} atoms, executed ${tx.executed ? "yes" : "no"}, confirmations: ${tx.confirmations.length} [${tx.confirmations.join(", ")}].`);
        return;
      }
      const id = hexToId(recordId);
      if (current.id === "htlc_status") {
        const raw = await readStorageAt(net.rpcUrl, contract, prefixedSlot("kvnc/v1/htlc/", id));
        const htlc = raw ? decodeHtlc(raw) : null;
        if (!htlc) throw new Error("No HTLC record at that swap id.");
        setReadout(`HTLC status: sender ${htlc.sender}, claimer ${htlc.claimer}, amount ${htlc.amount.toString()} atoms, hash ${htlc.hash}, expiry ${htlc.expiry.toString()}, claimed ${htlc.claimed ? "yes" : "no"}, refunded ${htlc.refunded ? "yes" : "no"}.`);
        return;
      }
      const prefix = current.id === "status" ? "kvnc/v1/vault/" : "";
      if (!prefix) throw new Error("That read is not available.");
      const raw = await readStorageAt(net.rpcUrl, contract, prefixedSlot(prefix, id));
      const vault = raw ? decodeVault(raw) : null;
      if (!vault) throw new Error("No vault record at that id.");
      setReadout(`Vault status: total ${vault.total.toString()} atoms, claimed ${vault.claimed.toString()}, schedule ${vault.schedule}, cancelled ${vault.cancelled ? "yes" : "no"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the contract");
    } finally {
      setReading(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (current.sign) void review(); else void readState(); }}>
      <div>
        <h2 className="text-2xl font-semibold">Contracts</h2>
        <p className="mt-2 text-sm text-muted">Canonical WASM entry points. A call is not signed until you confirm the method, arguments, fee, and gas. Reads never ask for the seed.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(ACTIONS) as ContractName[]).map((item) => (
          <button key={item} type="button" className={`min-h-11 rounded-2xl border px-3 text-sm capitalize ${contractId === item ? "border-copper text-paper" : "border-line text-muted"}`} onClick={() => pickContract(item)}>
            {item}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {selected.map((item) => (
          <button key={item.id} type="button" className={`min-h-11 rounded-full border px-4 text-sm ${action === item.id ? "border-copper text-paper" : "border-line text-muted"}`} onClick={() => { setAction(item.id); setError(null); setReadout(null); setEstimate(null); setSimulation(null); setPrecheck(null); }}>
            {item.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-muted">On-chain method: <span className="font-mono text-paper">{current.sign ? current.id : "kovanica_getStorageAt"}</span></p>
      <Field label="Contract address" value={contract} onChange={setContract} mono />
      <ContactSelect onPick={setContract} />
      {contract.trim() ? <p className={address.ok ? "text-sm text-sage" : "text-sm text-clay"}>{address.message}</p> : null}
      {needs("owner") ? (
        <>
          <Field label="Owner" value={owner} onChange={setOwner} mono />
          <ContactSelect onPick={setOwner} />
        </>
      ) : null}
      {needs("recipient") ? (
        <>
          <Field label={current.id === "htlc_create" ? "Recipient (claimer)" : current.id === "vault_create" ? "Beneficiary" : current.id === "name_register" ? "Owner pubkey or address" : current.id === "nft_mint" ? "Recipient address" : "Recipient"} value={recipient} onChange={setRecipient} mono />
          <ContactSelect onPick={setRecipient} />
        </>
      ) : null}
      {needs("name") ? <Field label="Name to register" value={name} onChange={setName} /> : null}
      {needs("endpoints") ? <Field label="Relay endpoints (comma separated)" value={relayEndpoints} onChange={setRelayEndpoints} mono /> : null}
      {needs("collection") ? <Field label="Collection address or 32-byte hex" value={collection} onChange={setCollection} mono /> : null}
      {needs("token_id") ? <Field label="Token ID" value={tokenId} onChange={setTokenId} /> : null}
      {needs("token_uri") ? <Field label="Token URI (metadata IPFS / URL)" value={tokenUri} onChange={setTokenUri} /> : null}
      {needs("amount") ? <Field label="Amount (atoms)" value={amount} onChange={setAmount} /> : null}
      {needs("hash") ? <Field label="Hash (32-byte hex)" value={hash} onChange={setHash} mono /> : null}
      {needs("timelock") ? <Field label={current.id === "vault_create" ? "Lock until (unix ms)" : "Timelock (unix ms)"} value={timelock} onChange={setTimelock} /> : null}
      {needs("deadline") ? <Field label="Deadline (timestamp or block number)" value={deadline} onChange={setDeadline} /> : null}
      {needs("secret") ? <Field label="Secret (hex or text)" value={secret} onChange={setSecret} mono /> : null}
      {needs("threshold") ? <Field label="Threshold (M-of-N, e.g. 2)" value={threshold} onChange={setThreshold} /> : null}
      {needs("owners") ? <Field label={current.id === "escrow_create" ? "Parties (comma or space separated addresses/hex)" : "Owners (comma or space separated addresses)"} value={owners} onChange={setOwners} mono /> : null}
      {needs("record") ? <Field label={contractId === "multisig" ? "Multisig id (32-byte hex)" : contractId === "htlc" ? "Swap id (32-byte hex)" : "Vault id (32-byte hex)"} value={recordId} onChange={setRecordId} mono /> : null}
      {needs("proposal") ? <Field label="Proposal id" value={proposal} onChange={setProposal} /> : null}
      {needs("calldata") ? <Field label="Call data hex, optional" value={callData} onChange={setCallData} mono /> : null}
      {current.id === "vault_claim" ? <p className="text-sm text-muted">Withdraw claims the vested balance. The contract does not take an amount; the beneficiary receives whatever is unlocked.</p> : null}
      {current.id === "htlc_create" || current.id === "vault_create" ? <p className="text-sm text-muted">The contract pulls Amount from your balance. Leave attached value at 0 unless this call also pays Call.value.</p> : null}
      {contractId === "name" || contractId === "escrow" || contractId === "htlc" ? (
        <div className="rounded-3xl border border-line bg-ink px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-paper">On-Chain State Pre-Check</span>
            <button
              type="button"
              className="min-h-9 rounded-full border border-line px-3 text-xs text-paper disabled:opacity-40"
              disabled={!net.online || !address.ok || prechecking}
              onClick={() => void checkOnChainState()}
            >
              {prechecking ? "Checking…" : "Check on-chain state"}
            </button>
          </div>
          {contractId === "escrow" ? (
            <div className="mt-3">
              <Field label="Escrow id to check (32-byte hex, optional)" value={precheckId} onChange={setPrecheckId} mono />
            </div>
          ) : contractId === "htlc" && !needs("record") ? (
            <div className="mt-3">
              <Field label="Swap id to check (32-byte hex, optional)" value={precheckId} onChange={setPrecheckId} mono />
            </div>
          ) : null}
          {precheck ? (
            <div
              role={precheck.family === "name" && precheck.exists ? "alert" : "status"}
              className={`mt-3 rounded-2xl border px-3 py-2 text-xs ${
                precheck.family === "name"
                  ? precheck.exists
                    ? "border-clay bg-clay/10 text-clay"
                    : "border-sage/60 bg-sage/10 text-sage"
                  : precheck.exists
                    ? "border-sage/60 bg-sage/10 text-sage"
                    : "border-line bg-surface text-muted"
              }`}
            >
              <p className="font-medium">
                {precheck.family === "name"
                  ? precheck.exists
                    ? "Name already registered"
                    : "Name available"
                  : precheck.exists
                    ? "On-chain record found"
                    : "No on-chain record"}
              </p>
              <p className="mt-1 break-words text-paper/90">{precheck.summary}</p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">
              {contractId === "name"
                ? "Optionally check whether this name is already registered on-chain before preparing a transaction."
                : contractId === "escrow"
                  ? "Optionally inspect an existing on-chain escrow record by its 32-byte id before preparing a transaction."
                  : "Optionally inspect an existing on-chain HTLC swap record by its 32-byte id before preparing a transaction."}
            </p>
          )}
        </div>
      ) : null}
      {current.sign ? (
        <>
          <Field label="Attached value (atoms)" value={value} onChange={setValue} />
          <Field label="Gas limit" value={gas} onChange={setGas} />
          <div className="rounded-3xl border border-line bg-ink px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-paper">Fee &amp; Gas Preview</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="min-h-9 rounded-full border border-line px-3 text-xs text-paper disabled:opacity-40"
                  disabled={lock.locked || simulating}
                  onClick={() => void simulateCurrentCall()}
                >
                  {simulating ? "Simulating…" : "Simulate call (dry-run)"}
                </button>
                <button
                  type="button"
                  className="min-h-9 rounded-full border border-line px-3 text-xs text-paper disabled:opacity-40"
                  disabled={lock.locked || estimating}
                  onClick={() => void estimateCall()}
                >
                  {estimating ? "Estimating…" : "Estimate fee & gas"}
                </button>
              </div>
            </div>
            {simulation ? (
              simulation.ok ? (
                <div className="mt-3 rounded-2xl border border-sage/60 bg-sage/10 px-3 py-2 text-xs text-sage">
                  <p className="font-medium">Dry-run simulation succeeded</p>
                  <p className="mt-1 break-all text-paper/90">{simulation.decodedSummary}</p>
                </div>
              ) : (
                <div
                  role="alert"
                  className="mt-3 rounded-2xl border border-clay bg-clay/10 px-3 py-2 text-xs text-clay"
                >
                  <p className="font-medium">
                    Dry-run simulation reverted — signing this call is likely to fail
                  </p>
                  <p className="mt-1 break-words">{simulation.reason}</p>
                </div>
              )
            ) : null}
            {estimate ? (
              <dl className="mt-3 grid gap-2">
                {formatCallEstimateSummary(estimate).map((row) => (
                  <div key={row.label} className="flex items-baseline justify-between gap-3 border-t border-line/60 pt-2">
                    <dt className="text-xs text-muted">{row.label}</dt>
                    <dd className="tabular-nums text-right text-paper">{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-2 text-xs text-muted">
                Click &ldquo;Estimate fee &amp; gas&rdquo; or &ldquo;Review call&rdquo; to compute exact wire size, fee rate, +20% safety-margined fee, gas limit, and nonce.
                {net.nonce != null ? ` Current nonce: ${net.nonce.toString()}.` : ""}
              </p>
            )}
          </div>
          <div className="rounded-3xl border border-line bg-ink px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-paper">Batch Call Estimator Queue</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="min-h-9 rounded-full border border-line px-3 text-xs text-paper disabled:opacity-40"
                  disabled={estimatingBatch}
                  onClick={queueCallToBatch}
                >
                  Queue call to batch
                </button>
                <button
                  type="button"
                  className="min-h-9 rounded-full border border-line px-3 text-xs text-paper disabled:opacity-40"
                  disabled={lock.locked || estimatingBatch || batchQueue.length === 0}
                  onClick={() => void estimateQueuedBatch()}
                >
                  {estimatingBatch ? "Estimating batch…" : "Estimate batch"}
                </button>
                <button
                  type="button"
                  className="min-h-9 rounded-full border border-line px-3 text-xs text-muted disabled:opacity-40"
                  disabled={estimatingBatch || batchQueue.length === 0}
                  onClick={clearBatchQueue}
                >
                  Clear batch
                </button>
              </div>
            </div>
            {batchQueue.length > 0 ? (
              <ul className="mt-3 grid gap-2">
                {batchQueue.map((item, idx) => {
                  const callEst = batchEstimate?.calls[idx];
                  return (
                    <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line/60 pt-2 text-xs">
                      <span className="font-mono text-paper">
                        #{idx + 1} {item.contractKind}.{item.method}
                      </span>
                      <span className="tabular-nums text-muted">
                        {callEst
                          ? `nonce=${callEst.nonce?.toString() ?? "auto"} • ${callEst.estimatedTxSize}B • fee=${callEst.marginedFee.toString()} • gas=${callEst.gasLimit.toString()}`
                          : `value=${item.valueAtoms.toString()} atoms • gas=${(item.gasLimit ?? 100000n).toString()}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted">
                Queue multiple contract calls to preview sequential nonces and aggregate wire size, +20% margined fee, and gas limit in one batch RPC lookup.
              </p>
            )}
            {batchEstimate ? (
              <dl className="mt-3 grid gap-2">
                {formatBatchCallEstimateSummary(batchEstimate).map((row) => (
                  <div key={row.label} className="flex items-baseline justify-between gap-3 border-t border-line/60 pt-2">
                    <dt className="text-xs text-muted">{row.label}</dt>
                    <dd className="tabular-nums text-right text-paper">{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </>
      ) : null}
      {lock.locked && current.sign ? <p className="text-sm text-clay">{lock.reason}</p> : null}
      {current.sign && net.balanceAtoms != null && shortfall(net.balanceAtoms, callNeed(current.id, value || "0", (estimate?.marginedFee ?? net.feeAtoms ?? 0n).toString(), amount)) > 0n ? (
        <div className="rounded-2xl border border-clay px-4 py-3 text-sm text-clay">
          <p>Balance is short by {shortfall(net.balanceAtoms, callNeed(current.id, value || "0", (estimate?.marginedFee ?? net.feeAtoms ?? 0n).toString(), amount)).toString()} atoms for this call value and fee.</p>
          {ownerAddress ? <div className="mt-3"><FaucetButton address={ownerAddress} onlyHybrid /></div> : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-clay">{error}</p> : null}
      {readout ? <p className="text-sm break-words text-paper">{readout}</p> : null}
      <button type="submit" className="min-h-12 rounded-full bg-copper font-medium text-copper-ink disabled:opacity-40" disabled={current.sign ? (lock.locked || estimating) : reading}>
        {current.sign ? (estimating ? "Estimating…" : "Review call") : reading ? "Reading…" : "Read"}
      </button>
      <PostBroadcastReceiptTracker contractFamily={contractId} rpcUrl={net.rpcUrl} online={net.online} />
      <ReceiptCard />
    </form>
  );
}

const LOG_KIND_OPTIONS: ReadonlyArray<{ value: ContractLogKind | "none"; label: string }> = [
  { value: "token_metadata", label: "token_metadata" },
  { value: "htlc", label: "htlc" },
  { value: "vault", label: "vault" },
  { value: "multisig_state", label: "multisig_state" },
  { value: "multisig_tx", label: "multisig_tx" },
  { value: "name", label: "name" },
  { value: "nft_metadata", label: "nft_metadata" },
  { value: "escrow", label: "escrow" },
  { value: "token_pool", label: "token_pool" },
  { value: "none", label: "Raw (no decode)" },
];

type ReceiptTrackerState =
  | { phase: "idle" }
  | { phase: "polling"; txHash: string }
  | { phase: "done"; txHash: string; result: TrackedContractReceipt }
  | { phase: "error"; txHash: string; message: string };

function PostBroadcastReceiptTracker({
  contractFamily,
  rpcUrl,
  online,
}: {
  contractFamily: ContractName;
  rpcUrl: string;
  online: boolean;
}) {
  const latestContractRow = useActivity((state) =>
    state.rows.find((item) => item.direction === "contract"),
  );
  const [txHashInput, setTxHashInput] = useState("");
  const [logKindChoice, setLogKindChoice] = useState<ContractLogKind | "none">(
    () => inferContractLogKind(contractFamily) ?? "none",
  );
  const [tracker, setTracker] = useState<ReceiptTrackerState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const lastAutoTrackedRef = useRef<string | null>(null);

  useEffect(() => {
    setLogKindChoice(inferContractLogKind(contractFamily) ?? "none");
  }, [contractFamily]);

  const stopTracking = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTracker((current) => (current.phase === "polling" ? { phase: "idle" } : current));
  }, []);

  const startTracking = useCallback(
    (rawHash: string, chosenLogKind: ContractLogKind | "none") => {
      const cleanHash = rawHash.trim();
      if (!cleanHash) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setTracker({ phase: "polling", txHash: cleanHash });

      const client = createReceiptTrackingClient(rpcUrl);
      const resolvedLogKind = chosenLogKind === "none" ? undefined : chosenLogKind;

      void trackSubmittedContractReceipt(client, cleanHash, {
        logKind: resolvedLogKind,
        signal: controller.signal,
      })
        .then((result) => {
          if (controller.signal.aborted) return;
          if (abortRef.current === controller) abortRef.current = null;
          setTracker({ phase: "done", txHash: cleanHash, result });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (abortRef.current === controller) abortRef.current = null;
          setTracker({
            phase: "error",
            txHash: cleanHash,
            message: err instanceof Error ? err.message : "Could not track transaction receipt.",
          });
        });
    },
    [rpcUrl],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!latestContractRow || !online) return;
    const hash = latestContractRow.hash.trim();
    if (!hash) return;
    if (lastAutoTrackedRef.current === hash) return;
    lastAutoTrackedRef.current = hash;
    setTxHashInput(hash);
    if (latestContractRow.status === "pending") {
      startTracking(hash, inferContractLogKind(contractFamily) ?? "none");
    }
  }, [latestContractRow, online, contractFamily, startTracking]);

  const summaryRows =
    tracker.phase === "done" ? formatReceiptTrackingSummary(tracker.result) : [];

  return (
    <section
      className="rounded-3xl border border-line bg-ink px-4 py-3 text-sm"
      aria-label="Post-Broadcast Receipt Tracker"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-paper">Post-Broadcast Receipt Tracker</h3>
        {tracker.phase === "polling" ? (
          <span className="rounded-full border border-copper/70 bg-copper/10 px-3 py-0.5 text-xs font-medium text-copper">
            Waiting for confirmation...
          </span>
        ) : tracker.phase === "done" ? (
          <span
            className={`rounded-full border px-3 py-0.5 text-xs font-medium ${
              tracker.result.status === "success"
                ? "border-sage/60 bg-sage/10 text-sage"
                : "border-clay bg-clay/10 text-clay"
            }`}
          >
            {tracker.result.status === "success" ? "Confirmed" : "Reverted"}
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2">
        <label className="grid gap-1 text-xs text-muted">
          Submitted transaction hash
          <input
            className="min-h-10 rounded-2xl border border-line bg-surface px-3 font-mono text-xs text-paper"
            value={txHashInput}
            onChange={(event) => setTxHashInput(event.target.value)}
            placeholder="0x... or 64-char tx hash"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label className="grid gap-1 text-xs text-muted">
            Log decoder
            <select
              className="min-h-9 rounded-full border border-line bg-surface px-3 text-xs text-paper"
              value={logKindChoice}
              onChange={(event) => setLogKindChoice(event.target.value as ContractLogKind | "none")}
            >
              {LOG_KIND_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-9 rounded-full border border-line px-3 text-xs text-paper disabled:opacity-40"
              disabled={!online || !txHashInput.trim() || tracker.phase === "polling"}
              onClick={() => startTracking(txHashInput, logKindChoice)}
            >
              {tracker.phase === "polling" ? "Waiting for confirmation..." : "Track receipt"}
            </button>
            {tracker.phase === "polling" ? (
              <button
                type="button"
                className="min-h-9 rounded-full border border-line px-3 text-xs text-muted"
                onClick={stopTracking}
              >
                Stop
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {tracker.phase === "polling" ? (
        <div
          role="status"
          className="mt-3 rounded-2xl border border-copper/50 bg-copper/10 px-3 py-2 text-xs text-paper"
        >
          <p className="font-medium text-copper">Waiting for confirmation...</p>
          <p className="mt-1 break-all font-mono text-muted">tx {tracker.txHash}</p>
        </div>
      ) : null}
      {tracker.phase === "error" ? (
        <div
          role="alert"
          className="mt-3 rounded-2xl border border-clay bg-clay/10 px-3 py-2 text-xs text-clay"
        >
          <p className="font-medium">Receipt tracking error</p>
          <p className="mt-1 break-words">{tracker.message}</p>
        </div>
      ) : null}
      {tracker.phase === "done" ? (
        <div
          role={tracker.result.status === "reverted" ? "alert" : "status"}
          className={`mt-3 rounded-2xl border px-3 py-2 text-xs ${
            tracker.result.status === "success"
              ? "border-sage/60 bg-sage/10"
              : "border-clay bg-clay/10"
          }`}
        >
          <p
            className={`font-medium ${
              tracker.result.status === "success" ? "text-sage" : "text-clay"
            }`}
          >
            {tracker.result.status === "success"
              ? "Contract call confirmed"
              : "Contract call reverted"}
          </p>
          <p className="mt-1 break-all font-mono text-muted">tx {tracker.txHash}</p>
          <dl className="mt-2 grid gap-2">
            {summaryRows.map((row) => (
              <div
                key={row.label}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line/60 pt-2"
              >
                <dt className="text-muted">{row.label}</dt>
                <dd
                  className={`text-right text-paper ${
                    row.label === "Block hash" || row.label === "Decoded logs"
                      ? "max-w-full whitespace-pre-wrap break-all font-mono"
                      : "tabular-nums"
                  }`}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {tracker.phase === "idle" ? (
        <p className="mt-2 text-xs text-muted">
          Automatically polls after broadcasting a contract call, or paste any submitted tx hash to inspect confirmation status, gas used, and decoded Bincode log events.
        </p>
      ) : null}
    </section>
  );
}

function ReceiptCard() {
  const row = useActivity((state) => state.rows.find((item) => item.direction === "contract"));
  const code = row?.code ?? (row?.status === "confirmed" ? "0x1" : row?.status === "failed" ? "0x0" : null);
  const label = !row ? "No contract receipt yet." : row.status === "confirmed" ? `status ${code ?? "0x1"} Success` : row.status === "failed" ? `status ${code ?? "0x0"} Revert` : "status Pending";
  return (
    <section className="rounded-3xl border border-line bg-ink px-4 py-3 text-sm">
      <h3 className="font-medium text-paper">Recent execution receipt</h3>
      <p className="mt-2 whitespace-pre-wrap break-all text-muted">
        {label}
        {row?.gasUsed ? `\ngasUsed ${row.gasUsed}` : ""}
        {row?.height != null ? `\nblock ${row.height}` : ""}
        {row?.hash ? `\ntx ${row.hash}` : ""}
        {row?.error ? `\n${row.error}` : ""}
        {row?.logs ? `\nlogs ${row.logs}` : ""}
      </p>
    </section>
  );
}

function hexToId(value: string): Uint8Array {
  const clean = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("Record id must be 64 hex characters.");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function Field({ label, value, onChange, mono }: { label: string; value: string; onChange: (value: string) => void; mono?: boolean }) {
  return (
    <label className="grid gap-1 text-sm text-muted">
      {label}
      <input className={`min-h-11 rounded-2xl border border-line bg-ink px-4 text-paper ${mono ? "font-mono text-sm" : "tabular-nums"}`} value={value} onChange={(event) => onChange(event.target.value)} autoCapitalize="none" spellCheck={false} />
    </label>
  );
}

