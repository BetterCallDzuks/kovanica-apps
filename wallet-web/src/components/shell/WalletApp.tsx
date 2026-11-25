import { useEffect, useRef, useState } from "react";
import { formatAddressForChain } from "@/core/address";
import { formatAtoms, formatKvnc } from "@/core/format";
import type { TxPreview } from "@/core/session";
import { AddressBook } from "@/components/contacts/AddressBook";
import { ECOSYSTEM_LINKS } from "@/lib/ecosystem";
import { chainName, explorerBaseUrl, presetById } from "@/lib/networks";
import { broadcast, indexerLogs, probeNode, readAccount, receipt } from "@/services/rpc";
import { onWalletLock, touchSession } from "@/services/tauri";
import { addAccount, clearBackup, forgetDevice, isDesktopShell, loadVault, lock, lockUi, refreshDesktopSession, selectAccount, signReviewed, subscribeBackup } from "@/services/wallet";
import { useActivity } from "@/stores/activity";
import { getNodeStatusBadge, savedNetworkChoice, signingLock, useNetwork } from "@/stores/network";
import { useSession } from "@/stores/session";
import { useWatchOnly } from "@/stores/watchOnly";
import { assertCanSign } from "@/lib/watchOnly";
import { ActivityList } from "@/components/activity/ActivityList";
import { ConfirmTx, type BroadcastNotice } from "@/components/confirm/ConfirmTx";
import { BatchCallBuilder } from "@/components/contracts/BatchCallBuilder";
import { Contracts } from "@/components/contracts/Contracts";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { Receive } from "@/components/receive/Receive";
import { SendForm } from "@/components/send/SendForm";
import { FaucetButton } from "@/components/home/FaucetButton";
import { NetworkChoices } from "@/components/settings/NetworkChoices";
import { SettingsDrawer } from "@/components/settings/SettingsDrawer";
import { Watchlist } from "@/components/watch/Watchlist";
import { useSettings } from "@/stores/settings";
import { useIdle } from "@/stores/idle";
import { remainingMs } from "@/core/idle";
import type { WatchKind } from "@/stores/watch";

import { toast } from "sonner";

type Tab = "home" | "send" | "receive" | "activity" | "contracts" | "watch";

export function WalletApp() {
  const [ready, setReady] = useState(true);
  const [tab, setTab] = useState<Tab>("home");
  const [preview, setPreview] = useState<TxPreview | null>(null);
  const [notice, setNotice] = useState<BroadcastNotice>({ phase: "idle" });
  const [quoteTick, setQuoteTick] = useState(0);
  const [signing, setSigning] = useState(false);
  const warned = useRef("");
  const [backup, setBackup] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [contractPrefill, setContractPrefill] = useState<{ address: string; kind: WatchKind } | null>(null);
  const lockMinutes = useSettings((s) => s.lockMinutes);
  const activityAt = useIdle((s) => s.at);
  const bumpIdle = useIdle((s) => s.bump);
  const session = useSession();
  const watchOnly = useWatchOnly();
  const net = useNetwork();
  const lockState = signingLock(net);
  const nodeStatusBadge = getNodeStatusBadge(net);
  const account = session.accounts[session.active];
  const isWatchOnlyMode = watchOnly.active != null;
  const accountAddress = isWatchOnlyMode ? watchOnly.active?.account.address : account?.address;
  const currentChainId = net.probedChainId ?? presetById(net.presetId).expectedChainId ?? null;
  const displayAddress = accountAddress ? formatAddressForChain(accountAddress, currentChainId) : "";

  useEffect(() => {
    const stopBackup = subscribeBackup(setBackup);
    let stopLock = () => {};
    if (isDesktopShell()) {
      void refreshDesktopSession();
      void onWalletLock(() => lockUi()).then((stop) => {
        stopLock = stop;
      });
      const touch = () => {
        void touchSession().catch(() => undefined);
      };
      window.addEventListener("pointerdown", touch);
      useActivity.getState().hydrate();
      useWatchOnly.getState().hydrate();
      setReady(true);
      return () => {
        stopBackup();
        stopLock();
        window.removeEventListener("pointerdown", touch);
      };
    } else {
      useSession.getState().hydrate(loadVault());
    }
    useActivity.getState().hydrate();
    useWatchOnly.getState().hydrate();
    const saved = savedNetworkChoice();
    if (saved) useNetwork.getState().setRpcUrl(saved.rpcUrl, saved.presetId);
    setReady(true);
    return () => {
      stopBackup();
      stopLock();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const run = async () => {
      useNetwork.getState().setProbing(true);
      const rpcUrl = useNetwork.getState().rpcUrl;
      const probe = await probeNode(rpcUrl);
      if (stop) return;
      useNetwork.getState().applyProbe(probe);
      if (!probe.online) {
        const message = probe.error ?? "The node did not respond.";
        if (warned.current !== message) {
          warned.current = message;
          toast(`${message} You can switch to the testnet fallback or enter a host.`);
        }
      } else {
        warned.current = "";
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 20000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [ready, net.presetId, net.rpcUrl]);

  useEffect(() => {
    if (!ready || (session.status !== "unlocked" && !isWatchOnlyMode) || !accountAddress || !net.online) return;
    void readAccount(net.rpcUrl, accountAddress).then((state) => {
      useNetwork.getState().setAccountState(state.balance, state.nonce, state.fee);
    });
  }, [ready, session.status, isWatchOnlyMode, accountAddress, net.online, net.presetId, net.probedChainId, net.rpcUrl]);

  useEffect(() => {
    const mark = () => bumpIdle();
    window.addEventListener("pointerdown", mark);
    window.addEventListener("keydown", mark);
    return () => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
    };
  }, [bumpIdle]);

  useEffect(() => {
    if (session.status !== "unlocked") return;
    const timer = window.setTimeout(() => void lock(), remainingMs(lockMinutes, activityAt, Date.now()));
    return () => window.clearTimeout(timer);
  }, [session.status, lockMinutes, activityAt]);

  useEffect(() => {
    if (!ready || !net.online) return;
    let stop = false;
    const run = async () => {
      const pending = useActivity.getState().rows.filter((row) => row.status === "pending");
      if (pending.length === 0) return;
      const rpcUrl = useNetwork.getState().rpcUrl;
      await Promise.all(
        pending.map(async (row) => {
          const result = await receipt(rpcUrl, row.hash);
          if (!stop && result && result.status !== "pending") {
            useActivity.getState().mark(row.hash, result.status, result.height, {
              gasUsed: result.gasUsed,
              code: result.code,
              error: result.error,
              logs: result.logs,
              events: result.events,
            });
          }
        }),
      );
    };
    void run();
    const timer = window.setInterval(() => void run(), 5_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [ready, net.online, net.presetId, net.rpcUrl]);

  useEffect(() => {
    if (!net.indexerUrl.trim()) {
      useActivity.getState().setIndexerNote("Outgoing transactions only");
      return;
    }
    const url = net.indexerUrl.includes("?") ? net.indexerUrl : `${net.indexerUrl}?limit=20`;
    void indexerLogs(url)
      .then(() => useActivity.getState().setIndexerNote("Indexer connected. Incoming rows appear when the feed includes this address."))
      .catch(() => useActivity.getState().setIndexerNote("Outgoing transactions only. The indexer did not respond."));
  }, [net.indexerUrl]);

  async function publish(raw: string, hash: string) {
    if (!preview) return;
    const preset = presetById(net.presetId);
    setNotice({ phase: "sending", label: preset.label });
    const broadcastHash = await broadcast(net.rpcUrl, raw);
    const shown = broadcastHash || hash;
    useActivity.getState().push({
      hash: shown,
      status: "pending",
      direction: preview.kind === "transfer" ? "sent" : "contract",
      amountAtoms: preview.kind === "transfer" ? preview.amountAtoms : preview.valueAtoms,
      feeAtoms: preview.feeAtoms,
      counterparty: preview.counterparty,
      chainId: preview.chainId,
      createdAt: Date.now(),
      height: null,
      note: preview.method,
    });
    setNotice({ phase: "ok", label: preset.label, hash: shown });
  }

  async function confirm() {
    if (!preview || lockState.locked) return;
    if (isWatchOnlyMode) {
      assertCanSign(watchOnly.active?.account);
      return;
    }
    setSigning(true);
    try {
      const signed = await signReviewed(preview);
      await publish(signed.raw, signed.hash);
    } catch (error) {
      setNotice({ phase: "error", message: error instanceof Error ? error.message : "Broadcast failed" });
    } finally {
      setSigning(false);
    }
  }

  async function importSigned(signed: { raw: string; hash: string }) {
    if (!preview || lockState.locked) return;
    setSigning(true);
    try {
      await publish(signed.raw, signed.hash);
    } catch (error) {
      setNotice({ phase: "error", message: error instanceof Error ? error.message : "Broadcast failed" });
    } finally {
      setSigning(false);
    }
  }

  function editDraft() {
    setNotice({ phase: "idle" });
    setPreview(null);
  }

  async function requote() {
    try {
      if (account) {
        const state = await readAccount(net.rpcUrl, account.address);
        useNetwork.getState().setAccountState(state.balance, state.nonce, state.fee);
      }
      setQuoteTick((tick) => tick + 1);
      setNotice({ phase: "idle" });
      setPreview(null);
    } catch (error) {
      setNotice({ phase: "error", message: error instanceof Error ? error.message : "Could not re-quote the fee" });
    }
  }

  function finishBroadcast() {
    setNotice({ phase: "idle" });
    setPreview(null);
    setTab("activity");
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && typeof data === "object") {
        if (data.type === "kovanica-fallback-state" || data.type === "node-mode-change") {
          const mode = data.mode;
          if (mode === "full" || mode === "light") {
            useNetwork.getState().setNodeMode(mode);
          }
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  if (session.status !== "unlocked" && !isWatchOnlyMode) {
    return (
      <main className="grid min-h-screen place-items-center bg-ink text-paper">
        <Onboarding key={session.status} mode={session.status === "locked" ? "unlock" : "choose"} />
      </main>
    );
  }

  const dot = lockState.locked ? "bg-clay" : "bg-sage";

  return (
    <main className="min-h-screen bg-ink text-paper">
      <div className="mx-auto grid min-h-screen w-full max-w-5xl md:grid-cols-[240px_1fr]">
        <aside className="min-w-0 border-b border-line px-5 py-6 md:border-r md:border-b-0">
          <p className="text-xs tracking-[0.22em] text-copper uppercase">Kovanica</p>
          <h1 className="mt-2 text-2xl font-semibold">Wallet</h1>
          <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
            <span>{lockState.networkName}</span>
            {nodeStatusBadge ? (
              <span
                data-testid="node-mode-indicator"
                className={`rounded-full px-2 py-0.5 text-xs font-medium border ${
                  nodeStatusBadge === "Fallback (Light/Remote)"
                    ? "bg-amber-950/60 text-amber-400 border-amber-800/80"
                    : nodeStatusBadge === "Syncing DAG"
                      ? "bg-sky-950/60 text-sky-400 border-sky-800/80"
                      : "bg-surface text-copper border-line"
                }`}
              >
                {nodeStatusBadge}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted" data-testid="node-status-text">
            {net.probing
              ? "Probing…"
              : net.online
                ? (net.localNodeMode || net.nodeMode
                    ? `${nodeStatusBadge ?? "Node"} · DAG Height: ${net.committedHeight ?? 0}${net.targetHeight != null && net.targetHeight > (net.committedHeight ?? 0) ? ` / ${net.targetHeight}` : ""} · Peers: ${net.peerCount ?? 0} · ${net.latencyMs ?? "—"} ms`
                    : `${net.nodeMode === "light" ? "Light Mode (fallback) · " : net.nodeMode === "full" ? "Full Node · " : ""}height ${net.committedHeight ?? "—"} · ${net.latencyMs ?? "—"} ms`
                  )
                : (net.error ?? "Offline")}
          </p>
          {lockState.locked ? <p className="mt-3 text-sm text-clay">{lockState.reason}</p> : null}
          <div className="mt-4">
            <NetworkChoices />
          </div>
          <nav className="mt-6 grid grid-cols-3 gap-2 md:grid-cols-1">
            {(["home", "contracts", "send", "activity", "receive", "watch"] as const).map((item) => (
              <button key={item} type="button" className={`min-h-11 rounded-full px-3 text-left capitalize ${tab === item ? "bg-surface text-paper" : "text-muted"}`} onClick={() => setTab(item)}>
                {item}
              </button>
            ))}
          </nav>
          <button type="button" className="mt-4 min-h-11 rounded-full border border-line px-4 text-sm text-paper" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <footer className="mt-6 border-t border-line pt-4" aria-label="Kovanica ecosystem">
            <p className="text-xs tracking-[0.18em] text-muted uppercase">Ecosystem</p>
            <nav className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Kovanica ecosystem links">
              {ECOSYSTEM_LINKS.map((item) => (
                <a
                  key={item.id}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-line bg-surface/60 px-2.5 py-1 text-xs text-muted transition-colors hover:border-copper hover:text-paper"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </footer>
        </aside>
        <section className="min-w-0 px-5 py-6">
          {isWatchOnlyMode && watchOnly.active ? (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-card border border-copper bg-surface px-4 py-3" data-testid="watch-only-banner">
              <div>
                <p className="text-xs tracking-wide text-copper uppercase">Watch-Only · Read-Only (Signing Disabled)</p>
                <p className="text-sm text-paper">{watchOnly.active.label} · {watchOnly.active.account.network}</p>
              </div>
              <button
                type="button"
                className="min-h-10 rounded-full border border-line px-4 text-sm text-paper"
                onClick={() => {
                  watchOnly.exitWatchOnly();
                  setTab("home");
                }}
              >
                Exit watch-only
              </button>
            </div>
          ) : (
            <div className="mb-5 flex gap-2 overflow-x-auto">
              {session.accounts.map((item, index) => {
                const itemDisplayAddress = formatAddressForChain(item.address, currentChainId);
                return (
                  <button
                    key={`${item.pathLabel}-${index}`}
                    type="button"
                    className={`min-h-11 shrink-0 rounded-full border px-4 text-left text-sm ${index === session.active ? "border-copper text-paper" : "border-line text-muted"}`}
                    onClick={() => selectAccount(index)}
                  >
                    <span className="block">{item.pathLabel === "Legacy account" ? "Legacy account" : `Account ${item.account}`}</span>
                    <span className="block text-xs">{item.pathLabel} · {itemDisplayAddress.slice(0, 10)}…{itemDisplayAddress.slice(-6)}</span>
                  </button>
                );
              })}
              {session.kind === "hd" ? (
                <button type="button" className="min-h-11 shrink-0 rounded-full border border-line px-4 text-sm text-paper" onClick={() => void addAccount().catch((error: unknown) => toast(error instanceof Error ? error.message : "Could not add an account"))}>
                  Add account
                </button>
              ) : null}
            </div>
          )}
          {tab === "home" ? (
            <div className="grid gap-5">
              <div className="grid gap-4 rounded-card border border-line bg-surface p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted">
                    {isWatchOnlyMode ? `${watchOnly.active?.label ?? "Watch-Only"} · Read-only` : account?.pathLabel}
                  </p>
                  {!isWatchOnlyMode && session.kind === "legacy" ? <p className="w-fit rounded-full border border-copper px-3 py-1 text-sm text-copper">Legacy account</p> : null}
                </div>
                <div>
                  <p className="text-5xl font-semibold tabular-nums">{net.balanceAtoms == null ? "—" : formatKvnc(net.balanceAtoms)}</p>
                  <p className="mt-1 text-muted">{net.balanceAtoms == null ? "Balance unavailable" : `${formatAtoms(net.balanceAtoms)} atoms`}</p>
                </div>
                <p className="mono text-sm break-all" data-testid="account-address">{displayAddress}</p>
                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  <button
                    type="button"
                    className="min-h-11 rounded-full bg-copper px-5 font-medium text-copper-ink disabled:opacity-40"
                    disabled={isWatchOnlyMode}
                    onClick={() => setTab("send")}
                  >
                    Send
                  </button>
                  <button type="button" className="min-h-11 rounded-full border border-line px-5 text-paper transition-colors hover:border-copper" onClick={() => setTab("receive")}>Receive</button>
                  {accountAddress ? <FaucetButton address={displayAddress} /> : null}
                  <button type="button" className="min-h-11 rounded-full border border-line px-5 text-paper transition-colors hover:border-copper" onClick={() => setTab("contracts")}>Contracts</button>
                  <a
                    href={explorerBaseUrl(currentChainId)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm text-paper transition-colors hover:border-copper"
                  >
                    Explorer
                  </a>
                  {isWatchOnlyMode ? (
                    <button type="button" className="min-h-11 rounded-full border border-line px-5 text-muted transition-colors hover:border-copper hover:text-paper" onClick={() => watchOnly.exitWatchOnly()}>Exit</button>
                  ) : (
                    <button type="button" className="min-h-11 rounded-full border border-line px-5 text-muted transition-colors hover:border-copper hover:text-paper" onClick={() => lock()}>Lock</button>
                  )}
                </div>
              </div>
              <AddressBook />
              {!isWatchOnlyMode ? (
                <button type="button" className="w-fit text-sm text-clay" onClick={() => { forgetDevice(); }}>
                  {isDesktopShell() ? "Lock the desktop wallet" : "Remove wallet from this browser"}
                </button>
              ) : null}
              <p className="text-xs text-muted">Chain {net.probedChainId ?? "—"} · expected {presetById(net.presetId).expectedChainId ?? "reported"} · {chainName(net.probedChainId)}</p>
            </div>
          ) : null}
          {tab === "send" ? (
            isWatchOnlyMode ? (
              <div className="rounded-card border border-line bg-surface p-5 text-sm text-muted">
                Signing is disabled in watch-only mode. Exit watch-only mode and unlock a wallet to send KVNC.
              </div>
            ) : (
              <SendForm onReview={(next) => { setNotice({ phase: "idle" }); setPreview(next); }} prefillTo={sendTo} quoteTick={quoteTick} />
            )
          ) : null}
          {tab === "receive" && accountAddress ? (
            <Receive
              address={displayAddress}
              pathLabel={isWatchOnlyMode ? "Watch-only (read-only)" : (account?.pathLabel ?? "")}
            />
          ) : null}
          {tab === "activity" ? (
            <ActivityList address={accountAddress} chainId={currentChainId ?? undefined} />
          ) : null}
          {tab === "contracts" ? (
            isWatchOnlyMode ? (
              <div className="grid gap-4">
                <div className="rounded-card border border-line bg-surface p-5 text-sm text-muted">
                  Contract signing is disabled in watch-only mode. Exit watch-only mode and unlock a wallet to submit contract calls. Read-only batch estimation and dry-run simulation remain available below.
                </div>
                <BatchCallBuilder senderAddress={accountAddress ?? ""} watchOnly />
              </div>
            ) : (
              <Contracts onReview={(next) => { setNotice({ phase: "idle" }); setPreview(next); }} prefill={contractPrefill} ownerAddress={account?.address ?? ""} />
            )
          ) : null}
          {tab === "watch" ? (
            <Watchlist
              onSend={(address) => { setSendTo(address); setTab("send"); }}
              onContract={(item) => { setContractPrefill({ address: item.address, kind: item.kind }); setTab("contracts"); }}
            />
          ) : null}
        </section>
      </div>
      {preview ? <ConfirmTx preview={preview} busy={signing} notice={notice} onCancel={editDraft} onConfirm={() => void confirm()} onImport={(signed) => void importSigned(signed)} onEdit={editDraft} onRequote={() => void requote()} onDone={finishBroadcast} /> : null}
      {settingsOpen ? <SettingsDrawer onClose={() => setSettingsOpen(false)} /> : null}
      {backup ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-ink/90 p-5">
          <div className="w-full max-w-lg rounded-card border border-line bg-surface p-5">
            <h2 className="text-2xl font-semibold">Write down this phrase</h2>
            <p className="mt-2 text-sm text-muted">This is the only time the desktop signer shows it. It is cleared when the wallet locks.</p>
            <p className="mono mt-4 text-sm break-words text-paper">{backup}</p>
            <button type="button" className="mt-5 min-h-12 w-full rounded-full bg-copper font-medium text-copper-ink" onClick={() => clearBackup()}>
              I wrote it down
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
