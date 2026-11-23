import type {
  ContractFacadeClient,
  DryRunCallClient,
  EstimateAndBuildCallClient,
  TransactionReceipt,
  WaitForTransactionReceiptClient,
} from "kovanica-sdk";
import { bytesToHex } from "@/core/bytes";
import { storageBytes } from "@/core/contracts";
import {
  createWalletFailoverClient,
  watchSubmittedTxFinality,
  type WalletFailoverClient,
  type WalletFailoverClientOptions,
  type WatchSubmittedTxFinalityOptions,
} from "@/core/finality";
import { decodeReceipt } from "@/core/receipt";
import { parseNetworkTagChainId } from "@/lib/networks";
import { useNetwork } from "@/stores/network";
import { proxyHealth, proxyIndexer, proxyRpc } from "./rpc.functions";

export type SyncProbe = {
  chainId: number | null;
  networkTag?: string | null;
  height: number | null;
  targetHeight?: number | null;
  syncing?: boolean;
  peerCount: number | null;
  latencyMs: number | null;
  nodeMode?: "full" | "light" | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  }
  return null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function currentRpcToken(): string | undefined {
  const token = useNetwork.getState().rpcToken.replace(/[\r\n]/g, "").trim();
  return token.length > 0 ? token : undefined;
}

async function post(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const rpcToken = currentRpcToken();
  const result = await proxyRpc({
    data: { rpcUrl, method, params, ...(rpcToken ? { rpcToken } : {}) },
  });
  if (!result.ok) throw new Error(`node returned ${result.status}`);
  const parsed = asRecord(parseJson(result.body));
  if (!parsed) throw new Error("node did not return JSON");
  if (parsed.error) {
    const err = asRecord(parsed.error);
    throw new Error(typeof err?.message === "string" ? err.message : "RPC error");
  }
  return parsed.result ?? parsed;
}

function withRpcPath(url: string): string[] {
  const primary = url.replace(/\/$/, "");
  const candidates = [primary];
  if (!primary.endsWith("/rpc")) candidates.push(`${primary}/rpc`);
  return candidates;
}

export async function probeNode(rpcUrl: string): Promise<SyncProbe & { latencyMs: number | null; online: boolean; error: string | null }> {
  let last = "Node did not respond";
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      const health = await proxyHealth({ data: { url: candidate } }).catch(() => null);
      const started = Date.now();
      const result = await post(candidate, "kovanica_syncStatus", []);
      const record = asRecord(result) ?? {};
      const rawTag = record.networkTag ?? record.network_tag;
      const networkTag = typeof rawTag === "string" && rawTag.trim() ? rawTag.trim() : null;
      const chainId = pickNumber(record, ["chainId", "chain_id", "chainID"]) ?? parseNetworkTagChainId(networkTag);
      const height = pickNumber(record, ["committedHeight", "committed_height", "height", "localHeight"]);
      const targetHeight = pickNumber(record, ["targetHeight", "target_height", "target", "highestBlock", "highest_height"]);
      let peerCount = pickNumber(record, ["peerCount", "peer_count", "peers"]);
      if (peerCount == null && health?.body) {
        const healthRec = asRecord(parseJson(health.body));
        if (healthRec) {
          peerCount = pickNumber(healthRec, ["peer_count", "peers", "peerCount"]);
        }
      }
      const isCatchingUp = record.catchingUp === true || record.catching_up === true || record.syncing === true || (targetHeight != null && height != null && targetHeight > height);
      let nodeMode: "full" | "light" | null = null;
      const rawMode = record.mode ?? record.nodeMode ?? record.node_mode;
      if (rawMode === "full" || rawMode === "light") {
        nodeMode = rawMode;
      } else if (record.fullMode === true) {
        nodeMode = "full";
      } else if (record.fullMode === false) {
        nodeMode = "light";
      } else {
        try {
          const status = await post(candidate, "kovanica_nodeStatus", []);
          const rec = asRecord(status);
          const m = rec?.mode ?? rec?.status;
          if (m === "full" || m === "light") {
            nodeMode = m;
          }
        } catch {
          // kovanica_nodeStatus not supported
        }
      }
      return {
        chainId,
        networkTag,
        height,
        targetHeight: targetHeight ?? null,
        syncing: isCatchingUp,
        peerCount,
        nodeMode,
        latencyMs: health?.ms ?? Date.now() - started,
        online: true,
        error: chainId == null ? "Node responded, but it did not report a chain id." : null,
      };
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  return { chainId: null, networkTag: null, height: null, targetHeight: null, syncing: false, peerCount: null, latencyMs: null, nodeMode: null, online: false, error: last };
}

function quantity(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\d+$/.test(text)) return BigInt(text);
    if (/^0x[0-9a-f]+$/i.test(text)) return BigInt(text);
  }
  const record = asRecord(value);
  if (!record) return null;
  return quantity(record.balance ?? record.atoms ?? record.nonce ?? record.fee ?? record.result);
}

export async function readAccount(rpcUrl: string, address: string): Promise<{ balance: bigint | null; nonce: bigint | null; fee: bigint | null }> {
  let balance: bigint | null = null;
  let nonce: bigint | null = null;
  let fee: bigint | null = null;
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      balance = quantity(await post(candidate, "kovanica_getBalance", [address]));
      nonce = quantity(await post(candidate, "kovanica_getNonce", [address]));
      try {
        fee = quantity(await post(candidate, "kovanica_estimateFee", [{ to: address }]));
      } catch {
        fee = quantity(await post(candidate, "kovanica_estimateFee", []));
      }
      return { balance, nonce, fee };
    } catch {
      continue;
    }
  }
  return { balance, nonce, fee };
}

export async function requestAirdrop(rpcUrl: string, address: string, atoms = "100000000000"): Promise<string> {
  let last = "faucet failed";
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      const result = await post(candidate, "kovanica_requestAirdrop", [address, atoms]);
      if (typeof result === "string" && result.trim()) return result.replace(/^0x/, "");
      const record = asRecord(result);
      const hash = record?.hash ?? record?.txHash ?? record?.transactionHash;
      if (typeof hash === "string" && hash.trim()) return hash.replace(/^0x/, "");
      throw new Error("The faucet did not return a transaction hash");
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  throw new Error(last);
}

export async function broadcast(rpcUrl: string, rawHex: string): Promise<string> {
  let last = "broadcast failed";
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      const result = await post(candidate, "kovanica_sendRawTransaction", [rawHex]);
      if (typeof result === "string") return result.replace(/^0x/, "");
      const record = asRecord(result);
      const hash = record?.hash ?? record?.txHash ?? record?.transactionHash;
      if (typeof hash === "string") return hash.replace(/^0x/, "");
      return rawHex.slice(0, 64);
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  throw new Error(last);
}

export type ReceiptView = {
  status: "pending" | "confirmed" | "failed";
  height: number | null;
  gasUsed: string | null;
  code: "0x1" | "0x0" | null;
  error: string | null;
  logs: number;
  events: string[];
};

export async function receipt(rpcUrl: string, hash: string): Promise<ReceiptView | null> {
  const fromReceipt = await receiptOnce(rpcUrl, hash, "kovanica_getTransactionReceipt");
  if (fromReceipt && fromReceipt.status !== "pending") return fromReceipt;
  const fromTx = await receiptOnce(rpcUrl, hash, "kovanica_getTransaction");
  return fromTx ?? fromReceipt;
}

async function receiptOnce(
  rpcUrl: string,
  hash: string,
  method: "kovanica_getTransactionReceipt" | "kovanica_getTransaction",
): Promise<ReceiptView | null> {
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      const result = await post(candidate, method, [hash]);
      const view = decodeReceipt(result);
      const height = view.height == null ? null : Number(view.height);
      const pending = view.status === "pending" || (method === "kovanica_getTransaction" && view.height == null && view.status !== "revert");
      return {
        status: view.status === "revert" ? "failed" : pending ? "pending" : "confirmed",
        height: height != null && Number.isSafeInteger(height) ? height : null,
        gasUsed: view.gasUsed,
        code: view.status === "revert" ? "0x0" : pending ? null : "0x1",
        error: view.error,
        logs: view.logs.length,
        events: view.logs.map((log) => log.topics[0] || "event").slice(0, 4),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function indexerLogs(url: string): Promise<unknown> {
  const result = await proxyIndexer({ data: { url } });
  if (!result.ok) throw new Error("indexer did not respond");
  return parseJson(result.body);
}

export async function readContract(rpcUrl: string, address: string, method: string, storageKey: string): Promise<{ call: string; storage: string }> {
  let call = "not returned";
  let storage = "not returned";
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      call = present(await post(candidate, "kovanica_call", [address, method, storageKey]));
      break;
    } catch (error) {
      call = error instanceof Error ? error.message : "call failed";
    }
  }
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      storage = present(await post(candidate, "kovanica_getStorage", [address, storageKey]));
      break;
    } catch (error) {
      storage = error instanceof Error ? error.message : "storage failed";
    }
  }
  return { call, storage };
}

function present(value: unknown): string {
  const amount = quantity(value);
  if (amount != null && (typeof value !== "object" || value === null)) return amount.toString();
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "unreadable result";
  }
}

async function tryMethod(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  let last = "not returned";
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      return present(await post(candidate, method, params));
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  return last;
}

export async function readNodeWatch(rpcUrl: string): Promise<{ dag: string; template: string; header: string }> {
  const [dag, template, header] = await Promise.all([
    tryMethod(rpcUrl, "kovanica_getDagInfo", []),
    tryMethod(rpcUrl, "kovanica_getBlockTemplate", []),
    tryMethod(rpcUrl, "kovanica_getLeaderHeader", []),
  ]);
  return { dag, template, header };
}

export async function readStorageAt(rpcUrl: string, address: string, slotHex: string): Promise<Uint8Array | null> {
  const slot = slotHex.startsWith("0x") ? slotHex : `0x${slotHex}`;
  let last = "storage was not returned";
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      const rpcToken = currentRpcToken();
      const result = await proxyRpc({
        data: {
          rpcUrl: candidate,
          method: "kovanica_getStorageAt",
          params: [address, slot],
          ...(rpcToken ? { rpcToken } : {}),
        },
      });
      if (!result.ok) throw new Error(`node returned ${result.status}`);
      const parsed = asRecord(parseJson(result.body));
      if (!parsed) throw new Error("node did not return JSON");
      if (parsed.error) {
        const err = asRecord(parsed.error);
        throw new Error(typeof err?.message === "string" ? err.message : "RPC error");
      }
      return storageBytes("result" in parsed ? parsed.result : null);
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  throw new Error(last);
}

export async function estimateGas(
  rpcUrl: string,
  call: { from?: string; to?: string; value?: string | number; data?: string; entry?: string }
): Promise<bigint> {
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      const result = await post(candidate, "kovanica_estimateGas", [call]);
      const qty = quantity(result);
      if (qty != null) return qty;
    } catch {
      // try next candidate
    }
  }
  return 21000n;
}

export async function simulateCall(
  rpcUrl: string,
  call: { from?: string; to?: string; value?: string | number; data?: string; entry?: string }
): Promise<string> {
  for (const candidate of withRpcPath(rpcUrl)) {
    const result = await post(candidate, "kovanica_call", [call]);
    return typeof result === "string" ? result : "0x";
  }
  return "0x";
}

export async function estimateFeeRate(rpcUrl: string): Promise<bigint> {
  let last = "fee estimate unavailable";
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      const raw = await post(candidate, "kovanica_estimateFee", []);
      const rate = quantity(raw);
      if (rate != null) return rate;
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
    try {
      const raw = await post(candidate, "kovanica_estimateFee", [{}]);
      const rate = quantity(raw);
      if (rate != null) return rate;
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  throw new Error(last);
}

export async function getAccountNonce(rpcUrl: string, address: string): Promise<bigint> {
  let last = "nonce unavailable";
  for (const candidate of withRpcPath(rpcUrl)) {
    try {
      const raw = await post(candidate, "kovanica_getNonce", [address]);
      const nonce = quantity(raw);
      if (nonce != null) return nonce;
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  throw new Error(last);
}

export function createCallEstimateClient(rpcUrl: string): EstimateAndBuildCallClient {
  return {
    estimateFee: () => estimateFeeRate(rpcUrl),
    getNonce: (address: string) => getAccountNonce(rpcUrl, address),
  };
}

export function createDryRunCallClient(rpcUrl: string): DryRunCallClient {
  return {
    async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
      const normalizedParams = Array.isArray(params) ? params : params === undefined ? [] : [params];
      let last = "dry-run simulation failed";
      for (const candidate of withRpcPath(rpcUrl)) {
        try {
          return (await post(candidate, method, normalizedParams)) as TResult;
        } catch (error) {
          last = error instanceof Error ? error.message : last;
        }
      }
      throw new Error(last);
    },
  };
}

export function createContractFacadeClient(rpcUrl: string): ContractFacadeClient {
  const dryRun = createDryRunCallClient(rpcUrl);
  const estimator = createCallEstimateClient(rpcUrl);
  return {
    call: dryRun.call,
    estimateFee: estimator.estimateFee,
    getNonce: estimator.getNonce,
    async getStorageAt(address: string, slot: string | number | bigint): Promise<string> {
      const slotHex =
        typeof slot === "string"
          ? slot.startsWith("0x") || slot.startsWith("0X")
            ? slot
            : `0x${slot}`
          : `0x${slot.toString(16)}`;
      const bytes = await readStorageAt(rpcUrl, address, slotHex);
      if (!bytes || bytes.length === 0) return "0x";
      return `0x${bytesToHex(bytes)}`;
    },
  };
}

function normalizeSdkReceipt(raw: unknown): TransactionReceipt | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const txHash = rec.transactionHash ?? rec.txHash ?? rec.hash;
  if (typeof txHash !== "string" || !txHash.trim()) return null;
  const blockHashRaw = rec.blockHash ?? rec.block_hash ?? "";
  const blockNumber = quantity(rec.blockNumber ?? rec.block_number ?? rec.height ?? rec.blockHeight) ?? 0n;
  const txIndexRaw = quantity(rec.transactionIndex ?? rec.transaction_index);
  const gasUsed = quantity(rec.gasUsed ?? rec.gas_used);
  const statusVal = rec.status;
  const reverted =
    rec.success === false ||
    statusVal === 0 ||
    statusVal === "0x0" ||
    statusVal === "0" ||
    (typeof statusVal === "string" && /fail|revert/i.test(statusVal));
  const rawLogs = Array.isArray(rec.logs) ? rec.logs : Array.isArray(rec.events) ? rec.events : [];
  const logs = rawLogs.flatMap((entry) => {
    const item = asRecord(entry);
    if (!item || typeof item.data !== "string") return [];
    const topics = Array.isArray(item.topics) ? item.topics.map((t) => String(t)) : undefined;
    return [
      {
        ...(typeof item.address === "string" ? { address: item.address } : {}),
        ...(topics ? { topics } : {}),
        data: item.data,
      },
    ];
  });

  return {
    transactionHash: txHash,
    blockHash: typeof blockHashRaw === "string" ? blockHashRaw : "",
    blockNumber,
    transactionIndex: txIndexRaw,
    status: reverted ? 0 : 1,
    success: !reverted,
    ...(gasUsed != null ? { gasUsed } : {}),
    logs,
  };
}

export function createReceiptTrackingClient(rpcUrl: string): WaitForTransactionReceiptClient {
  return {
    async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
      for (const candidate of withRpcPath(rpcUrl)) {
        try {
          const result = await post(candidate, "kovanica_getTransactionReceipt", [hash]);
          const normalized = normalizeSdkReceipt(result);
          if (normalized) return normalized;
        } catch {
          continue;
        }
      }
      return null;
    },
  };
}

export {
  createWalletFailoverClient,
  watchSubmittedTxFinality,
  type WalletFailoverClient,
  type WalletFailoverClientOptions,
  type WatchSubmittedTxFinalityOptions,
};
