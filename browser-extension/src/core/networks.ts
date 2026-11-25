import {
  ADDRESS_PREFIX,
  CHAIN_IDS,
  KovanicaClient,
  KovanicaWsClient,
  NETWORK_TAGS,
  TESTNET_ADDRESS_PREFIX,
  inspectAddress,
  isLegacyAddressAllowed,
  isValidAddress,
  parseAddressForChain,
  type AddressInspectionResult,
} from "kovanica-sdk";

export interface NetworkProfile {
  readonly chainId: number;
  readonly id: "mainnet" | "testnet" | "devnet";
  readonly name: string;
  readonly ticker: "KVNC";
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly addressPrefix: string;
  readonly networkTag?: string;
  readonly strictPro21: boolean;
  readonly explorerUrl?: string;
}

export const DEFAULT_NETWORKS: readonly NetworkProfile[] = Object.freeze([
  {
    chainId: CHAIN_IDS.MAINNET,
    id: "mainnet",
    name: "Kovanica Mainnet",
    ticker: "KVNC",
    rpcUrl: "https://rpc.kovanica.online/rpc",
    wsUrl: "wss://rpc.kovanica.online/ws",
    addressPrefix: ADDRESS_PREFIX,
    networkTag: NETWORK_TAGS.MAINNET,
    strictPro21: true,
    explorerUrl: "https://explorer.kovanica.online",
  },
  {
    chainId: CHAIN_IDS.TESTNET,
    id: "testnet",
    name: "Kovanica Testnet",
    ticker: "KVNC",
    rpcUrl: "https://rpc-testnet.kovanica.online/rpc",
    wsUrl: "wss://rpc-testnet.kovanica.online/ws",
    addressPrefix: TESTNET_ADDRESS_PREFIX,
    networkTag: NETWORK_TAGS.TESTNET,
    strictPro21: true,
    explorerUrl: "https://testnet.kovanica.online/explorer",
  },
  {
    chainId: CHAIN_IDS.DEVNET,
    id: "devnet",
    name: "Kovanica Local Devnet",
    ticker: "KVNC",
    rpcUrl: "http://127.0.0.1:8545/rpc",
    wsUrl: "ws://127.0.0.1:8545/ws",
    addressPrefix: ADDRESS_PREFIX,
    strictPro21: false,
  },
]);

export function getNetworkByChainId(chainId: number): NetworkProfile {
  const found = DEFAULT_NETWORKS.find((n) => n.chainId === chainId);
  if (found) return found;
  return DEFAULT_NETWORKS[0]!;
}

export function isSupportedChainId(chainId: number): boolean {
  return DEFAULT_NETWORKS.some((n) => n.chainId === chainId);
}

export interface RecipientValidationResult {
  readonly valid: boolean;
  readonly address: string;
  readonly chainId: number;
  readonly strictPro21: boolean;
  readonly format?: AddressInspectionResult["format"];
  readonly canonicalAddress?: string;
  readonly payloadBytes?: Uint8Array;
  readonly warning?: string;
  readonly error?: string;
}

/**
 * Validates a recipient address against Kovanica chain policy.
 * Enforces strict PRO-21 (`kvnc...dag` / `tknc...dag`) on Mainnet (1) and Testnet (2).
 * Rejects legacy hex addresses on Mainnet and Testnet.
 */
export function validateRecipientAddress(
  address: string,
  chainId: number,
): RecipientValidationResult {
  const trimmed = address.trim();
  const strictPro21 = !isLegacyAddressAllowed(chainId);

  if (!trimmed) {
    return {
      valid: false,
      address: trimmed,
      chainId,
      strictPro21,
      error: "Recipient address is required",
    };
  }

  const inspection = inspectAddress(trimmed, chainId);
  if (!inspection.valid || !isValidAddress(trimmed, chainId)) {
    return {
      valid: false,
      address: trimmed,
      chainId,
      strictPro21,
      format: inspection.format,
      error:
        inspection.error ??
        (strictPro21
          ? `Invalid PRO-21 address for chain ${chainId}. Only canonical 64-char kvnc...dag addresses are accepted.`
          : `Invalid address for chain ${chainId}`),
    };
  }

  const payloadBytes = parseAddressForChain(trimmed, chainId);
  const canonicalAddress =
    chainId === CHAIN_IDS.TESTNET && trimmed.startsWith(TESTNET_ADDRESS_PREFIX)
      ? inspection.canonicalTestnet ?? trimmed
      : inspection.canonicalMainnet ?? trimmed;

  const warning =
    inspection.format !== "pro21-mainnet" && inspection.format !== "pro21-testnet"
      ? "Legacy hex address accepted only on Devnet; prefer canonical PRO-21 kvnc...dag."
      : undefined;

  return {
    valid: true,
    address: trimmed,
    chainId,
    strictPro21,
    format: inspection.format,
    canonicalAddress,
    payloadBytes,
    warning,
  };
}

export function createRpcClient(network: NetworkProfile): KovanicaClient {
  return new KovanicaClient({
    rpcUrl: network.rpcUrl,
  });
}

export function createWsClient(network: NetworkProfile): KovanicaWsClient {
  return new KovanicaWsClient({ url: network.wsUrl, reconnect: true });
}
