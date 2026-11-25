import { CHAIN_IDS, NETWORK_TAGS as SDK_NETWORK_TAGS } from "kovanica-sdk";

export type PresetId = "mainnet" | "testnet" | "hybrid" | "devnet";

export const NETWORK_TAGS = {
  MAINNET: SDK_NETWORK_TAGS.MAINNET,
  TESTNET: SDK_NETWORK_TAGS.TESTNET,
} as const;

export type NetworkPreset = {
  id: PresetId;
  label: string;
  rpcUrl: string;
  /** null means accept the chain id the node reports */
  expectedChainId: number | null;
  /** Official `<chain_id>-<16 hex genesis digest>` wire network tag when frozen. */
  expectedNetworkTag?: string;
  localOnly: boolean;
  /** Mainnet stays visible, but this wallet does not spend on it. */
  frozen?: boolean;
  recommended?: boolean;
};

export const FALLBACK_RPC = "https://rpc-testnet.kovanica.online/rpc";
export const LOCAL_NODE_RPC = "http://127.0.0.1:8545";

export const EXPLORER_BASE_URLS = {
  mainnet: "https://explorer.kovanica.online",
  testnet: "https://testnet.kovanica.online/explorer",
} as const;

export function explorerBaseUrl(chainId: number | null | undefined): string {
  return chainId === CHAIN_IDS.MAINNET ? EXPLORER_BASE_URLS.mainnet : EXPLORER_BASE_URLS.testnet;
}

export function explorerTxUrl(chainId: number | null | undefined, txHash: string): string {
  const base = explorerBaseUrl(chainId);
  const cleanHash = txHash.trim();
  if (!cleanHash) return base;
  return `${base}/tx/${encodeURIComponent(cleanHash)}`;
}

export const PRESETS: NetworkPreset[] = [
  {
    id: "mainnet",
    label: "Mainnet (1) · read-only",
    rpcUrl: "https://rpc.kovanica.online/rpc",
    expectedChainId: CHAIN_IDS.MAINNET,
    expectedNetworkTag: NETWORK_TAGS.MAINNET,
    localOnly: false,
    frozen: true,
  },
  {
    id: "testnet",
    label: "Testnet (2)",
    rpcUrl: FALLBACK_RPC,
    expectedChainId: CHAIN_IDS.TESTNET,
    expectedNetworkTag: NETWORK_TAGS.TESTNET,
    localOnly: false,
    recommended: true,
  },
  {
    id: "hybrid",
    label: "Chain 2 · Hybrid PoW Testnet",
    rpcUrl: "http://127.0.0.1:8545",
    expectedChainId: CHAIN_IDS.TESTNET,
    expectedNetworkTag: NETWORK_TAGS.TESTNET,
    localOnly: true,
  },
  {
    id: "devnet",
    label: "Devnet (3)",
    rpcUrl: "http://127.0.0.1:8545",
    expectedChainId: CHAIN_IDS.DEVNET,
    localOnly: true,
  },
];

export function parseNetworkTagChainId(networkTag: unknown): number | null {
  if (typeof networkTag !== "string") return null;
  const trimmed = networkTag.trim();
  const match = /^(\d+)-[0-9a-f]{16}$/i.exec(trimmed);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export const CHAIN_NAMES: Record<number, string> = {
  [CHAIN_IDS.MAINNET]: "Mainnet",
  [CHAIN_IDS.TESTNET]: "Testnet",
  [CHAIN_IDS.DEVNET]: "Devnet",
};

export function isLocalRpc(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return url.startsWith("http://127.0.0.1:8545") || url.startsWith("http://localhost:8545");
  }
}

export function chainName(chainId: number | null): string {
  if (chainId == null) return "Not probed";
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function presetById(id: PresetId): NetworkPreset {
  const preset = PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error("unknown network");
  return preset;
}

const ALLOWED_HOSTS = new Set(["kovanica.online", "rpc.kovanica.online", "testnet.kovanica.online", "rpc-testnet.kovanica.online", "explorer.kovanica.online", "127.0.0.1", "localhost"]);

export function assertRpcUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RPC URL is not valid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("RPC URL must be http or https");
  const host = url.hostname.toLowerCase();
  const allowed =
    ALLOWED_HOSTS.has(host) || (host.endsWith(".kovanica.online") && !host.includes("..")) || isPrivateHost(host);
  if (!allowed) throw new Error("RPC host is not a Kovanica endpoint");
  if (url.username || url.password) throw new Error("RPC URL cannot contain credentials");
  const port = url.port;
  if (port && !["80", "443", "8545"].includes(port)) throw new Error("RPC port is not allowed");
  if ((isPrivateHost(host)) && url.protocol !== "http:") {
    throw new Error("local node URLs use http");
  }
  return url;
}

export function normalizeRpc(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Enter a host and port");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return assertRpcUrl(withScheme).toString().replace(/\/$/, "");
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1") return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const [a, b] = parts.map((part) => Number(part));
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}
