import { create } from "zustand";
import { chainName, isLocalRpc, LOCAL_NODE_RPC, presetById, type PresetId } from "@/lib/networks";

const CHOICE_KEY = "kvnc.network.v1";

export type NodeMode = "full" | "light" | null;

export type NodeStatusBadge = "Syncing DAG" | "Full Node Active" | "Fallback (Light/Remote)";

export function getNodeStatusBadge(state: {
  localNodeMode?: boolean;
  nodeMode?: NodeMode;
  syncing?: boolean;
  committedHeight?: number | null;
  targetHeight?: number | null;
}): NodeStatusBadge | null {
  if (!state.localNodeMode && !state.nodeMode) return null;
  if (state.nodeMode === "light") {
    return "Fallback (Light/Remote)";
  }
  const isSyncing = Boolean(
    state.syncing ||
      (state.targetHeight != null &&
        state.committedHeight != null &&
        state.targetHeight > state.committedHeight)
  );
  if (isSyncing) {
    return "Syncing DAG";
  }
  return "Full Node Active";
}

type NetworkState = {
  presetId: PresetId;
  rpcUrl: string;
  localNodeMode: boolean;
  nodeMode: NodeMode;
  probedChainId: number | null;
  committedHeight: number | null;
  targetHeight: number | null;
  syncing: boolean;
  latencyMs: number | null;
  peerCount: number | null;
  online: boolean;
  probing: boolean;
  error: string | null;
  balanceAtoms: bigint | null;
  nonce: bigint | null;
  feeAtoms: bigint | null;
  indexerUrl: string;
  setIndexerUrl: (indexerUrl: string) => void;
  selectPreset: (presetId: PresetId) => void;
  setRpcUrl: (rpcUrl: string, presetId?: PresetId) => void;
  setLocalNodeMode: (active: boolean) => void;
  setNodeMode: (mode: NodeMode) => void;
  applyProbe: (probe: {
    chainId: number | null;
    height: number | null;
    targetHeight?: number | null;
    syncing?: boolean;
    latencyMs: number | null;
    peerCount: number | null;
    online: boolean;
    error: string | null;
    nodeMode?: NodeMode;
  }) => void;
  setAccountState: (balanceAtoms: bigint | null, nonce: bigint | null, feeAtoms: bigint | null) => void;
  setProbing: (probing: boolean) => void;
};

function persistChoice(presetId: PresetId, rpcUrl: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CHOICE_KEY, JSON.stringify({ presetId, rpcUrl }));
}

export function savedNetworkChoice(): { presetId: PresetId; rpcUrl: string } | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "") as { presetId?: PresetId; rpcUrl?: string };
    if (!parsed?.presetId || !parsed.rpcUrl) return null;
    presetById(parsed.presetId);
    return { presetId: parsed.presetId, rpcUrl: parsed.rpcUrl };
  } catch {
    return null;
  }
}

export const useNetwork = create<NetworkState>((set, get) => ({
  presetId: "testnet",
  rpcUrl: presetById("testnet").rpcUrl,
  localNodeMode: isLocalRpc(presetById("testnet").rpcUrl),
  nodeMode: isLocalRpc(presetById("testnet").rpcUrl) ? "full" : null,
  probedChainId: null,
  committedHeight: null,
  targetHeight: null,
  syncing: false,
  latencyMs: null,
  peerCount: null,
  online: false,
  probing: false,
  error: null,
  balanceAtoms: null,
  nonce: null,
  feeAtoms: null,
  indexerUrl: "",
  setIndexerUrl: (indexerUrl) => set({ indexerUrl }),
  selectPreset: (presetId) => {
    const preset = presetById(presetId);
    const rpcUrl = preset.rpcUrl;
    const isLocal = preset.localOnly || isLocalRpc(rpcUrl);
    persistChoice(presetId, rpcUrl);
    set({
      presetId,
      rpcUrl,
      localNodeMode: isLocal,
      nodeMode: isLocal ? (get().nodeMode ?? "full") : null,
      probedChainId: null,
      committedHeight: null,
      targetHeight: null,
      syncing: false,
      online: false,
      error: null,
      balanceAtoms: null,
      nonce: null,
      feeAtoms: null,
    });
  },
  setRpcUrl: (rpcUrl, presetId) =>
    set((state) => {
      const nextId = presetId ?? state.presetId;
      const isLocal = isLocalRpc(rpcUrl);
      persistChoice(nextId, rpcUrl);
      return {
        presetId: nextId,
        rpcUrl,
        localNodeMode: isLocal,
        nodeMode: isLocal ? (state.nodeMode ?? "full") : null,
        probedChainId: null,
        committedHeight: null,
        targetHeight: null,
        syncing: false,
        online: false,
        error: null,
        balanceAtoms: null,
        nonce: null,
        feeAtoms: null,
      };
    }),
  setLocalNodeMode: (active) =>
    set((state) => {
      if (active) {
        persistChoice(state.presetId, LOCAL_NODE_RPC);
        return {
          localNodeMode: true,
          rpcUrl: LOCAL_NODE_RPC,
          nodeMode: state.nodeMode ?? "full",
          probedChainId: null,
          committedHeight: null,
          targetHeight: null,
          syncing: false,
          online: false,
          error: null,
        };
      }
      const defaultUrl = presetById(state.presetId).rpcUrl;
      const isLocal = isLocalRpc(defaultUrl);
      persistChoice(state.presetId, defaultUrl);
      return {
        localNodeMode: isLocal,
        rpcUrl: defaultUrl,
        nodeMode: isLocal ? (state.nodeMode ?? "full") : null,
        targetHeight: null,
        syncing: false,
      };
    }),
  setNodeMode: (mode) => set({ nodeMode: mode }),
  applyProbe: (probe) =>
    set((state) => ({
      probedChainId: probe.chainId,
      committedHeight: probe.height,
      targetHeight: probe.targetHeight !== undefined ? probe.targetHeight : state.targetHeight,
      syncing: probe.syncing !== undefined ? probe.syncing : (probe.targetHeight != null && probe.height != null && probe.targetHeight > probe.height),
      latencyMs: probe.latencyMs,
      peerCount: probe.peerCount,
      online: probe.online,
      error: probe.error,
      nodeMode: probe.nodeMode !== undefined ? probe.nodeMode : state.nodeMode,
      probing: false,
    })),
  setAccountState: (balanceAtoms, nonce, feeAtoms) => set({ balanceAtoms, nonce, feeAtoms }),
  setProbing: (probing) => set({ probing }),
}));

export function signingLock(state: {
  presetId: PresetId;
  probedChainId: number | null;
  online: boolean;
}): { locked: boolean; reason: string; networkName: string } {
  const preset = presetById(state.presetId);
  const networkName = state.probedChainId == null ? preset.label : chainName(state.probedChainId);
  if (preset.frozen) {
    return { locked: true, reason: "Mainnet is frozen. This wallet can read it, not spend from it.", networkName };
  }
  if (!state.online || state.probedChainId == null) {
    return { locked: true, reason: "Signing is off until a node reports its chain id.", networkName };
  }
  if (preset.expectedChainId != null && state.probedChainId !== preset.expectedChainId) {
    return {
      locked: true,
      reason: `${preset.label} expects chain ${preset.expectedChainId}, but the node reported chain ${state.probedChainId}.`,
      networkName,
    };
  }
  return { locked: false, reason: "", networkName };
}