import {
  PROVIDER_CHANNEL,
  type ProviderEventEnvelope,
  type ProviderEventName,
  type ProviderMethod,
  type ProviderRequestEnvelope,
  type ProviderResponseEnvelope,
} from "../core/provider-protocol";
import type {
  DAppBatchTxParams,
  DAppSponsoredTxParams,
  DAppTransactionParams,
} from "../core/tx-signer";

type EventListener = (payload: unknown) => void;

export interface KovanicaWindowProvider {
  readonly isKovanica: true;
  readonly version: string;
  connect(): Promise<{ accounts: string[]; chainId: number }>;
  disconnect(): Promise<{ disconnected: true }>;
  getAccounts(): Promise<string[]>;
  getChainId(): Promise<number>;
  getStealthMetaAddress(): Promise<string | null>;
  switchChain(chainId: number): Promise<{ chainId: number }>;
  signTransaction(tx: DAppTransactionParams): Promise<{
    rawTxHex: string;
    signingHashHex: string;
    signatureHex: string;
  }>;
  signBatchTransaction(tx: DAppBatchTxParams): Promise<{
    rawTxHex: string;
    signingHashHex: string;
    signatureHex: string;
    actionCount: number;
  }>;
  signSponsoredTransaction(tx: DAppSponsoredTxParams): Promise<{
    rawTxHex: string;
    signingHashHex: string;
    senderSignatureHex: string;
    sponsorSignatureHex: string;
  }>;
  signMessage(message: string): Promise<{
    messageHashHex: string;
    signatureHex: string;
  }>;
  request<T = unknown>(args: { method: ProviderMethod; params?: unknown }): Promise<T>;
  on(event: ProviderEventName, listener: EventListener): void;
  removeListener(event: ProviderEventName, listener: EventListener): void;
  off(event: ProviderEventName, listener: EventListener): void;
}

declare global {
  interface Window {
    kovanica?: KovanicaWindowProvider;
  }
}

export function createInpageProvider(targetWindow: Window = window): KovanicaWindowProvider {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  const listeners = new Map<ProviderEventName, Set<EventListener>>();
  let seq = 1;

  targetWindow.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== targetWindow || !event.data || typeof event.data !== "object") {
      return;
    }
    const data = event.data as ProviderResponseEnvelope | ProviderEventEnvelope;
    if (data.channel !== PROVIDER_CHANNEL) return;

    if (data.direction === "content-to-inpage") {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) {
        const err = new Error(data.error.message) as Error & { code?: number };
        err.code = data.error.code;
        entry.reject(err);
      } else {
        entry.resolve(data.result);
      }
      return;
    }

    if (data.direction === "content-to-inpage-event") {
      const set = listeners.get(data.event);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(data.payload);
        } catch {
          // Isolate dApp listener errors from provider dispatch loop
        }
      }
    }
  });

  function sendRequest<T>(method: ProviderMethod, params?: unknown): Promise<T> {
    const id = `kvnc_${Date.now()}_${seq++}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      const envelope: ProviderRequestEnvelope = {
        channel: PROVIDER_CHANNEL,
        direction: "inpage-to-content",
        id,
        method,
        params,
      };
      targetWindow.postMessage(envelope, targetWindow.location?.origin || "*");
    });
  }

  function on(event: ProviderEventName, listener: EventListener): void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener);
  }

  function removeListener(event: ProviderEventName, listener: EventListener): void {
    listeners.get(event)?.delete(listener);
  }

  const provider: KovanicaWindowProvider = {
    isKovanica: true,
    version: "0.1.0",
    connect: () => sendRequest("connect"),
    disconnect: () => sendRequest("disconnect"),
    getAccounts: () => sendRequest("getAccounts"),
    getChainId: () => sendRequest("getChainId"),
    getStealthMetaAddress: () => sendRequest("kovanica_getStealthMetaAddress"),
    switchChain: (chainId) => sendRequest("switchChain", { chainId }),
    signTransaction: (tx) => sendRequest("signTransaction", tx),
    signBatchTransaction: (tx) => sendRequest("signBatchTransaction", tx),
    signSponsoredTransaction: (tx) => sendRequest("signSponsoredTransaction", tx),
    signMessage: (message) => sendRequest("signMessage", { message }),
    request: ({ method, params }) => sendRequest(method, params),
    on,
    removeListener,
    off: removeListener,
  };

  return Object.freeze(provider);
}

if (typeof window !== "undefined" && !window.kovanica) {
  const provider = createInpageProvider(window);
  Object.defineProperty(window, "kovanica", {
    value: provider,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  window.dispatchEvent(new Event("kovanica#initialized"));
}
