import { CHAIN_IDS } from "kovanica-sdk";
import { isSupportedChainId } from "./networks";
import {
  buildApprovalPreview,
  signDAppBatchTransaction,
  signDAppSponsoredTransaction,
  signDAppTransaction,
  signPersonalMessage,
  signRegisterSessionKeyTransaction,
  signRevokeSessionKeyTransaction,
  type ApprovalPreview,
  type DAppBatchTxParams,
  type DAppSponsoredTxParams,
  type DAppTransactionParams,
  type SessionKeyPolicyInput,
} from "./tx-signer";
import type { VaultManager } from "./vault";

export const PROVIDER_CHANNEL = "KOVANICA_PROVIDER_V1";

export type ProviderMethod =
  | "connect"
  | "disconnect"
  | "getAccounts"
  | "getChainId"
  | "switchChain"
  | "signTransaction"
  | "signBatchTransaction"
  | "signSponsoredTransaction"
  | "signMessage"
  | "registerSessionKey"
  | "revokeSessionKey"
  | "kovanica_getStealthMetaAddress";

export type ProviderEventName = "accountsChanged" | "chainChanged" | "connect" | "disconnect";

export interface ProviderRequestEnvelope {
  channel: typeof PROVIDER_CHANNEL;
  direction: "inpage-to-content";
  id: string;
  method: ProviderMethod;
  params?: unknown;
}

export interface ProviderResponseEnvelope {
  channel: typeof PROVIDER_CHANNEL;
  direction: "content-to-inpage";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ProviderEventEnvelope {
  channel: typeof PROVIDER_CHANNEL;
  direction: "content-to-inpage-event";
  event: ProviderEventName;
  payload: unknown;
}

export interface PendingApprovalRequest {
  id: string;
  origin: string;
  method: ProviderMethod;
  params: unknown;
  preview: ApprovalPreview;
  createdAt: number;
}

interface InternalPendingApproval extends PendingApprovalRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type ProviderEventBroadcaster = (event: ProviderEventName, payload: unknown) => void;
export type ApprovalPromptHook = (req: PendingApprovalRequest) => void | Promise<void>;

export class KovanicaProviderController {
  private readonly vault: VaultManager;
  private chainId: number;
  private readonly connectedOrigins = new Set<string>();
  private readonly pendingApprovals = new Map<string, InternalPendingApproval>();
  private readonly onBroadcast?: ProviderEventBroadcaster;
  private readonly onApprovalPrompt?: ApprovalPromptHook;
  private nextApprovalSeq = 1;

  constructor(options: {
    vault: VaultManager;
    initialChainId?: number;
    onBroadcast?: ProviderEventBroadcaster;
    onApprovalPrompt?: ApprovalPromptHook;
  }) {
    this.vault = options.vault;
    this.chainId = options.initialChainId ?? CHAIN_IDS.MAINNET;
    this.onBroadcast = options.onBroadcast;
    this.onApprovalPrompt = options.onApprovalPrompt;
  }

  getChainId(): number {
    return this.chainId;
  }

  setChainId(chainId: number): void {
    if (!isSupportedChainId(chainId)) {
      throw new Error(`Unsupported Kovanica chainId: ${chainId}`);
    }
    if (this.chainId !== chainId) {
      this.chainId = chainId;
      this.onBroadcast?.("chainChanged", chainId);
      if (this.vault.isUnlocked()) {
        this.onBroadcast?.("accountsChanged", this.getActiveAddresses());
      }
    }
  }

  getConnectedOrigins(): string[] {
    return Array.from(this.connectedOrigins);
  }

  disconnectOrigin(origin: string): void {
    if (this.connectedOrigins.delete(origin)) {
      this.onBroadcast?.("accountsChanged", []);
      this.onBroadcast?.("disconnect", { origin });
    }
  }

  getActiveAddresses(): string[] {
    if (!this.vault.isUnlocked()) return [];
    const accounts = this.vault.getAccounts(this.chainId);
    const activeIdx = this.vault.getActiveAccountIndex();
    const active = accounts[activeIdx] ?? accounts[0];
    return active ? [active.address] : [];
  }

  notifyAccountsChanged(): void {
    this.onBroadcast?.("accountsChanged", this.getActiveAddresses());
  }

  listPendingApprovals(): PendingApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).map(
      ({ id, origin, method, params, preview, createdAt }) => ({
        id,
        origin,
        method,
        params,
        preview,
        createdAt,
      }),
    );
  }

  getPendingApproval(id: string): PendingApprovalRequest | undefined {
    const found = this.pendingApprovals.get(id);
    if (!found) return undefined;
    return {
      id: found.id,
      origin: found.origin,
      method: found.method,
      params: found.params,
      preview: found.preview,
      createdAt: found.createdAt,
    };
  }

  async handleRequest(
    origin: string,
    method: ProviderMethod,
    params?: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "getChainId":
        return this.chainId;

      case "getAccounts":
        if (!this.connectedOrigins.has(origin) || !this.vault.isUnlocked()) {
          return [];
        }
        return this.getActiveAddresses();

      case "kovanica_getStealthMetaAddress": {
        if (!this.connectedOrigins.has(origin)) {
          throw new Error(`Origin ${origin} is not connected. Call window.kovanica.connect() first.`);
        }
        if (!this.vault.isUnlocked()) {
          throw new Error("Wallet vault is locked. Unlock Kovanica Wallet first.");
        }
        return this.vault.getStealthMetaAddress()?.metaAddress ?? null;
      }

      case "disconnect":
        this.disconnectOrigin(origin);
        return { disconnected: true };

      case "switchChain": {
        const targetChainId = Number(
          typeof params === "object" && params !== null && "chainId" in params
            ? (params as { chainId: number }).chainId
            : params,
        );
        if (!isSupportedChainId(targetChainId)) {
          throw new Error(`Unsupported Kovanica chainId: ${targetChainId}`);
        }
        this.setChainId(targetChainId);
        return { chainId: this.chainId };
      }

      case "connect": {
        if (this.connectedOrigins.has(origin) && this.vault.isUnlocked()) {
          return {
            accounts: this.getActiveAddresses(),
            chainId: this.chainId,
          };
        }
        return this.enqueueApproval(origin, "connect", params);
      }

      case "signTransaction":
      case "signBatchTransaction":
      case "signSponsoredTransaction":
      case "signMessage":
      case "registerSessionKey":
      case "revokeSessionKey": {
        if (!this.connectedOrigins.has(origin)) {
          throw new Error(`Origin ${origin} is not connected. Call window.kovanica.connect() first.`);
        }
        return this.enqueueApproval(origin, method, params);
      }

      default:
        throw new Error(`Unsupported window.kovanica method: ${String(method)}`);
    }
  }

  private enqueueApproval(
    origin: string,
    method: ProviderMethod,
    params: unknown,
  ): Promise<unknown> {
    const id = `req_${Date.now()}_${this.nextApprovalSeq++}`;
    const preview = buildApprovalPreview({
      method,
      requestParams: params,
      chainId: this.chainId,
    });

    return new Promise((resolve, reject) => {
      const entry: InternalPendingApproval = {
        id,
        origin,
        method,
        params,
        preview,
        createdAt: Date.now(),
        resolve,
        reject,
      };
      this.pendingApprovals.set(id, entry);
      void this.onApprovalPrompt?.({
        id: entry.id,
        origin: entry.origin,
        method: entry.method,
        params: entry.params,
        preview: entry.preview,
        createdAt: entry.createdAt,
      });
    });
  }

  async resolveApproval(id: string, approved: boolean, rejectionReason?: string): Promise<void> {
    const entry = this.pendingApprovals.get(id);
    if (!entry) {
      throw new Error(`Unknown approval request: ${id}`);
    }
    this.pendingApprovals.delete(id);

    if (!approved) {
      entry.reject(new Error(rejectionReason || "User rejected the request"));
      return;
    }

    if (!this.vault.isUnlocked()) {
      entry.reject(new Error("Wallet vault is locked. Unlock Kovanica Wallet first."));
      return;
    }

    try {
      const result = await this.executeApprovedMethod(entry.origin, entry.method, entry.params);
      entry.resolve(result);
    } catch (err) {
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async executeApprovedMethod(
    origin: string,
    method: ProviderMethod,
    params: unknown,
  ): Promise<unknown> {
    if (method === "connect") {
      this.connectedOrigins.add(origin);
      const accounts = this.getActiveAddresses();
      this.onBroadcast?.("connect", { chainId: this.chainId, accounts });
      this.onBroadcast?.("accountsChanged", accounts);
      return { accounts, chainId: this.chainId };
    }

    return this.vault.withActiveKeypair(({ secretKey, publicKey }) => {
      switch (method) {
        case "signMessage": {
          const message =
            typeof params === "string"
              ? params
              : (params as { message?: string })?.message ?? "";
          return signPersonalMessage(message, secretKey);
        }
        case "signTransaction":
          return signDAppTransaction({
            tx: params as DAppTransactionParams,
            privateKey: secretKey,
            publicKey,
            chainId: this.chainId,
          });
        case "signBatchTransaction":
          return signDAppBatchTransaction({
            tx: params as DAppBatchTxParams,
            privateKey: secretKey,
            publicKey,
            chainId: this.chainId,
          });
        case "signSponsoredTransaction":
          return signDAppSponsoredTransaction({
            tx: params as DAppSponsoredTxParams,
            privateKey: secretKey,
            publicKey,
            chainId: this.chainId,
          });
        case "registerSessionKey": {
          const input = params as {
            policy: SessionKeyPolicyInput;
            nonce: number | string;
            fee: number | string;
          };
          const signed = signRegisterSessionKeyTransaction({
            chainId: this.chainId,
            senderPrivateKey: secretKey,
            senderPublicKey: publicKey,
            nonce: BigInt(input.nonce),
            fee: BigInt(input.fee),
            policy: input.policy,
          });
          return {
            rawTxHex: signed.rawHex,
            signingHashHex: signed.hashHex,
            signatureHex: signed.signatureHex,
          };
        }
        case "revokeSessionKey": {
          const input = params as {
            sessionPubkey: string;
            nonce: number | string;
            fee: number | string;
          };
          const signed = signRevokeSessionKeyTransaction({
            chainId: this.chainId,
            senderPrivateKey: secretKey,
            senderPublicKey: publicKey,
            nonce: BigInt(input.nonce),
            fee: BigInt(input.fee),
            sessionPubkey: input.sessionPubkey,
          });
          return {
            rawTxHex: signed.rawHex,
            signingHashHex: signed.hashHex,
            signatureHex: signed.signatureHex,
          };
        }
        default:
          throw new Error(`Cannot execute unsupported method: ${method}`);
      }
    });
  }
}
