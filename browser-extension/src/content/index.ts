import {
  PROVIDER_CHANNEL,
  type ProviderEventEnvelope,
  type ProviderEventName,
  type ProviderRequestEnvelope,
  type ProviderResponseEnvelope,
} from "../core/provider-protocol";

/**
 * MV3 Isolated-world content script bridging `window.kovanica` (MAIN world)
 * to the Kovanica background service worker.
 */
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || !event.data || typeof event.data !== "object") {
    return;
  }
  const msg = event.data as ProviderRequestEnvelope;
  if (msg.channel !== PROVIDER_CHANNEL || msg.direction !== "inpage-to-content") {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "KOVANICA_DAPP_REQUEST",
      origin: window.location.origin,
      method: msg.method,
      params: msg.params,
    },
    (response: { ok?: boolean; result?: unknown; error?: string } | undefined) => {
      const lastError = chrome.runtime.lastError;
      const reply: ProviderResponseEnvelope = {
        channel: PROVIDER_CHANNEL,
        direction: "content-to-inpage",
        id: msg.id,
        ...(lastError
          ? { error: { code: -32603, message: lastError.message ?? "Extension messaging error" } }
          : response?.ok
            ? { result: response.result }
            : { error: { code: 4001, message: response?.error ?? "Request failed" } }),
      };
      window.postMessage(reply, window.location.origin || "*");
    },
  );
});

chrome.runtime.onMessage.addListener((message: { type?: string; event?: ProviderEventName; payload?: unknown }) => {
  if (message?.type !== "KOVANICA_PROVIDER_EVENT" || !message.event) {
    return;
  }
  const envelope: ProviderEventEnvelope = {
    channel: PROVIDER_CHANNEL,
    direction: "content-to-inpage-event",
    event: message.event,
    payload: message.payload,
  };
  window.postMessage(envelope, window.location.origin || "*");
});
