import { CHAIN_IDS, formatKvnc, type KovanicaWsClient } from "kovanica-sdk";
import {
  DEFAULT_NETWORKS,
  createRpcClient,
  createWsClient,
  getNetworkByChainId,
  validateRecipientAddress,
} from "../core/networks";
import {
  KovanicaProviderController,
  type PendingApprovalRequest,
  type ProviderEventName,
  type ProviderMethod,
} from "../core/provider-protocol";
import {
  generateEphemeralSessionKeypair,
  signRegisterSessionKeyTransaction,
  signRevokeSessionKeyTransaction,
  type LocalSessionKeyRecord,
} from "../core/session-keys";
import {
  estimateWaveBFeeFromRpc,
  signDAppTransaction,
} from "../core/tx-signer";
import {
  ChromeLocalStorageAdapter,
  VaultManager,
  type PasskeyWrappedVaultKey,
} from "../core/vault";

const SESSION_KEYS_STORAGE_KEY = "kovanica_session_keys_v1";
const AUTO_LOCK_ALARM_NAME = "kovanica_auto_lock";

const storage = new ChromeLocalStorageAdapter();
let activeWsClient: KovanicaWsClient | null = null;
let latestHeadHeight: number | null = null;

function broadcastProviderEvent(event: ProviderEventName, payload: unknown): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        chrome.tabs.sendMessage(
          tab.id,
          { type: "KOVANICA_PROVIDER_EVENT", event, payload },
          () => {
            void chrome.runtime.lastError;
          },
        );
      }
    }
  });
}

async function openApprovalWindow(req: PendingApprovalRequest): Promise<void> {
  const url = chrome.runtime.getURL(`approval.html?requestId=${encodeURIComponent(req.id)}`);
  await chrome.windows.create({
    url,
    type: "popup",
    width: 420,
    height: 640,
    focused: true,
  });
}

const vault = new VaultManager(storage, () => {
  broadcastProviderEvent("accountsChanged", []);
});

const providerController = new KovanicaProviderController({
  vault,
  initialChainId: CHAIN_IDS.MAINNET,
  onBroadcast: broadcastProviderEvent,
  onApprovalPrompt: openApprovalWindow,
});

function refreshWsSubscription(): void {
  try {
    activeWsClient?.close();
  } catch {
    // Ignore close errors
  }
  const network = getNetworkByChainId(providerController.getChainId());
  try {
    const ws = createWsClient(network);
    activeWsClient = ws;
    void ws
      .subscribeNewHeads((head) => {
        if (typeof head.height === "number") {
          latestHeadHeight = head.height;
        }
      })
      .catch(() => {
        // Offline / unreachable WS is non-fatal
      });
  } catch {
    activeWsClient = null;
  }
}

async function loadSessionKeys(): Promise<LocalSessionKeyRecord[]> {
  return (await storage.get<LocalSessionKeyRecord[]>(SESSION_KEYS_STORAGE_KEY)) ?? [];
}

async function saveSessionKeys(records: LocalSessionKeyRecord[]): Promise<void> {
  await storage.set(SESSION_KEYS_STORAGE_KEY, records);
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM_NAME) {
    vault.lock();
  }
});

async function scheduleAutoLockAlarm(): Promise<void> {
  const rec = await vault.loadRecord();
  const mins = rec?.autoLockMinutes ?? 15;
  await chrome.alarms?.clear(AUTO_LOCK_ALARM_NAME);
  if (mins > 0 && vault.isUnlocked()) {
    chrome.alarms?.create(AUTO_LOCK_ALARM_NAME, { delayInMinutes: mins });
  }
}

interface BackgroundMessage {
  type: string;
  origin?: string;
  method?: ProviderMethod;
  params?: unknown;
  payload?: Record<string, unknown>;
}

async function handlePopupAction(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  switch (type) {
    case "WALLET_GET_STATE": {
      const hasVault = await vault.hasVault();
      const record = await vault.loadRecord();
      const chainId = providerController.getChainId();
      const network = getNetworkByChainId(chainId);
      const unlocked = vault.isUnlocked();
      const accounts = unlocked ? vault.getAccounts(chainId) : [];
      const activeAccountIndex = vault.getActiveAccountIndex();
      const sessionKeys = await loadSessionKeys();
      return {
        hasVault,
        unlocked,
        chainId,
        network,
        networks: DEFAULT_NETWORKS,
        accounts,
        activeAccountIndex,
        autoLockMinutes: record?.autoLockMinutes ?? 15,
        hasPasskey: Boolean(record?.passkeyUnlock),
        passkeyAddress: record?.passkeyUnlock?.pro21Address,
        passkeyRecord: record?.passkeyUnlock,
        connectedOrigins: providerController.getConnectedOrigins(),
        pendingApprovals: providerController.listPendingApprovals(),
        sessionKeys,
        latestHeadHeight,
      };
    }

    case "WALLET_CREATE": {
      const res = await vault.createVault({
        password: String(payload.password ?? ""),
        mnemonic: payload.mnemonic ? String(payload.mnemonic) : undefined,
        autoLockMinutes:
          typeof payload.autoLockMinutes === "number" ? payload.autoLockMinutes : 15,
      });
      await scheduleAutoLockAlarm();
      refreshWsSubscription();
      return res;
    }

    case "WALLET_UNLOCK": {
      const accounts = await vault.unlock(String(payload.password ?? ""));
      await scheduleAutoLockAlarm();
      providerController.notifyAccountsChanged();
      refreshWsSubscription();
      return { accounts };
    }

    case "WALLET_LOCK": {
      vault.lock();
      await chrome.alarms?.clear(AUTO_LOCK_ALARM_NAME);
      return { locked: true };
    }

    case "WALLET_SET_AUTO_LOCK": {
      await vault.setAutoLockMinutes(Number(payload.minutes ?? 15));
      await scheduleAutoLockAlarm();
      return { ok: true };
    }

    case "WALLET_SAVE_PASSKEY": {
      await vault.setPasskeyUnlock(payload.record as PasskeyWrappedVaultKey | undefined);
      return { ok: true };
    }

    case "WALLET_ADD_ACCOUNT": {
      const acc = await vault.addAccount(
        payload.label ? String(payload.label) : undefined,
      );
      providerController.notifyAccountsChanged();
      return acc;
    }

    case "WALLET_SELECT_ACCOUNT": {
      await vault.setActiveAccountIndex(Number(payload.index ?? 0));
      providerController.notifyAccountsChanged();
      return { ok: true };
    }

    case "WALLET_SWITCH_NETWORK": {
      providerController.setChainId(Number(payload.chainId ?? CHAIN_IDS.MAINNET));
      refreshWsSubscription();
      return { chainId: providerController.getChainId() };
    }

    case "WALLET_DISCONNECT_ORIGIN": {
      providerController.disconnectOrigin(String(payload.origin ?? ""));
      return { ok: true };
    }

    case "WALLET_FETCH_BALANCE": {
      const address = String(payload.address ?? "");
      const network = getNetworkByChainId(providerController.getChainId());
      const client = createRpcClient(network);
      const [balance, nonce, feeEstimate] = await Promise.all([
        client.getBalance(address).catch(() => 0n),
        client.getNonce(address).catch(() => 0n),
        estimateWaveBFeeFromRpc(client, { txBytes: 196 }),
      ]);
      return {
        balanceAtoms: balance.toString(),
        balanceKvnc: formatKvnc(balance),
        nonce: nonce.toString(),
        feeEstimate,
      };
    }

    case "WALLET_SEND_TRANSFER": {
      const chainId = providerController.getChainId();
      const to = String(payload.to ?? "");
      const check = validateRecipientAddress(to, chainId);
      if (!check.valid) {
        throw new Error(check.error ?? "Invalid PRO-21 recipient address");
      }
      const network = getNetworkByChainId(chainId);
      const client = createRpcClient(network);
      const accounts = vault.getAccounts(chainId);
      const active = accounts[vault.getActiveAccountIndex()];
      if (!active) throw new Error("No active account");
      const nonce = await client.getNonce(active.address).catch(() => BigInt(String(payload.nonce ?? 0)));
      const feeEst = await estimateWaveBFeeFromRpc(client, { txBytes: 196 });
      const signed = await vault.withActiveKeypair(({ secretKey, publicKey }) =>
        signDAppTransaction({
          tx: {
            kind: "transfer",
            to,
            amount: String(payload.amountAtoms ?? "0"),
            nonce: nonce.toString(),
            fee: feeEst.totalFeeAtoms,
            chainId,
          },
          privateKey: secretKey,
          publicKey,
          chainId,
        }),
      );
      let txHash: string | undefined;
      if (payload.broadcast !== false) {
        txHash = await client.sendRawTransaction(signed.rawTxHex);
      }
      return { ...signed, txHash };
    }

    case "WALLET_REGISTER_SESSION_KEY": {
      const chainId = providerController.getChainId();
      const accounts = vault.getAccounts(chainId);
      const active = accounts[vault.getActiveAccountIndex()];
      if (!active) throw new Error("No active account");

      const ephemeral = generateEphemeralSessionKeypair(chainId);
      const allowedContracts = Array.isArray(payload.allowedContracts)
        ? payload.allowedContracts.map(String).filter(Boolean)
        : [];
      const allowedMethods = Array.isArray(payload.allowedMethods)
        ? payload.allowedMethods.map(String).filter(Boolean)
        : [];
      const maxSpendAtoms = BigInt(String(payload.maxSpendAtoms ?? "1000000000"));
      const expiresRound = BigInt(String(payload.expiresRound ?? "1000000"));
      const nonce = BigInt(String(payload.nonce ?? "0"));
      const fee = BigInt(String(payload.feeAtoms ?? "1000000"));

      const signed = await vault.withActiveKeypair(({ secretKey, publicKey }) =>
        signRegisterSessionKeyTransaction({
          chainId,
          senderPrivateKey: secretKey,
          senderPublicKey: publicKey,
          nonce,
          fee,
          policy: {
            owner: publicKey,
            sessionPubkey: ephemeral.publicKey,
            allowedContracts,
            allowedMethods,
            maxSpendAtoms,
            expiresRound,
            chainId,
          },
        }),
      );

      const record: LocalSessionKeyRecord = {
        id: `sk_${Date.now()}`,
        label: String(payload.label ?? "dApp Session"),
        ownerAddress: active.address,
        sessionPubkeyHex: ephemeral.publicKeyHex,
        sessionAddress: ephemeral.address,
        allowedContracts,
        allowedMethods,
        maxSpendAtoms: maxSpendAtoms.toString(),
        spentAtoms: "0",
        expiresRound: expiresRound.toString(),
        revoked: false,
        createdAt: Date.now(),
      };
      const existing = await loadSessionKeys();
      await saveSessionKeys([record, ...existing]);
      return { record, signed: { rawHex: signed.rawHex, hashHex: signed.hashHex } };
    }

    case "WALLET_REVOKE_SESSION_KEY": {
      const chainId = providerController.getChainId();
      const id = String(payload.id ?? "");
      const list = await loadSessionKeys();
      const target = list.find((item) => item.id === id);
      if (!target) throw new Error("Session key not found");

      const signed = await vault.withActiveKeypair(({ secretKey, publicKey }) =>
        signRevokeSessionKeyTransaction({
          chainId,
          senderPrivateKey: secretKey,
          senderPublicKey: publicKey,
          nonce: BigInt(String(payload.nonce ?? "0")),
          fee: BigInt(String(payload.feeAtoms ?? "1000000")),
          sessionPubkey: target.sessionAddress,
        }),
      );

      const updated = list.map((item) =>
        item.id === id ? { ...item, revoked: true } : item,
      );
      await saveSessionKeys(updated);
      return { revoked: true, signed: { rawHex: signed.rawHex, hashHex: signed.hashHex } };
    }

    case "APPROVAL_GET_REQUEST": {
      return providerController.getPendingApproval(String(payload.requestId ?? "")) ?? null;
    }

    case "APPROVAL_RESOLVE": {
      await providerController.resolveApproval(
        String(payload.requestId ?? ""),
        Boolean(payload.approved),
        payload.reason ? String(payload.reason) : undefined,
      );
      return { ok: true };
    }

    default:
      throw new Error(`Unknown background action: ${type}`);
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message?.type === "KOVANICA_DAPP_REQUEST" && message.method) {
    providerController
      .handleRequest(message.origin ?? "unknown", message.method, message.params)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (message?.type) {
    handlePopupAction(message.type, message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  return false;
});
