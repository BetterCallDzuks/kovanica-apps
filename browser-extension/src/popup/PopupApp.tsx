import React, { useEffect, useState } from "react";
import { parseKvnc } from "kovanica-sdk";
import type { NetworkProfile } from "../core/networks";
import { validateRecipientAddress } from "../core/networks";
import {
  createBrowserWebAuthnAdapter,
  registerPasskeyForVault,
  unwrapVaultPasswordWithPasskey,
} from "../core/passkey";
import type { LocalSessionKeyRecord } from "../core/session-keys";
import type { WaveBFeeEstimate } from "../core/tx-signer";
import type { PasskeyWrappedVaultKey, WalletAccountSummary } from "../core/vault";

interface WalletStateResponse {
  hasVault: boolean;
  unlocked: boolean;
  chainId: number;
  network: NetworkProfile;
  networks: NetworkProfile[];
  accounts: WalletAccountSummary[];
  activeAccountIndex: number;
  autoLockMinutes: number;
  hasPasskey: boolean;
  passkeyAddress?: string;
  passkeyRecord?: PasskeyWrappedVaultKey;
  connectedOrigins: string[];
  sessionKeys: LocalSessionKeyRecord[];
  latestHeadHeight: number | null;
}

async function sendBg<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (res: { ok?: boolean; result?: T; error?: string }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res?.ok) {
        reject(new Error(res?.error ?? "Background request failed"));
        return;
      }
      resolve(res.result as T);
    });
  });
}

export function PopupApp(): React.JSX.Element {
  const [state, setState] = useState<WalletStateResponse | null>(null);
  const [tab, setTab] = useState<"wallet" | "send" | "sessions" | "security">("wallet");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  // Onboarding / Unlock state
  const [password, setPassword] = useState("");
  const [importMnemonic, setImportMnemonic] = useState("");
  const [createdMnemonic, setCreatedMnemonic] = useState("");

  // Balance state
  const [balanceKvnc, setBalanceKvnc] = useState("0");
  const [feeEst, setFeeEst] = useState<WaveBFeeEstimate | null>(null);

  // Send state
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");

  // Session Key form
  const [skLabel, setSkLabel] = useState("dApp Session");
  const [skContracts, setSkContracts] = useState("");
  const [skMethods, setSkMethods] = useState("transfer,swap");
  const [skMaxKvnc, setSkMaxKvnc] = useState("10");
  const [skExpiresRound, setSkExpiresRound] = useState("500000");

  // Security form
  const [passkeyPassword, setPasskeyPassword] = useState("");

  async function refreshState(): Promise<void> {
    try {
      const next = await sendBg<WalletStateResponse>("WALLET_GET_STATE");
      setState(next);
      if (next.unlocked && next.accounts[next.activeAccountIndex]) {
        const addr = next.accounts[next.activeAccountIndex]!.address;
        const bal = await sendBg<{ balanceKvnc: string; feeEstimate: WaveBFeeEstimate }>(
          "WALLET_FETCH_BALANCE",
          { address: addr },
        ).catch(() => null);
        if (bal) {
          setBalanceKvnc(bal.balanceKvnc);
          setFeeEst(bal.feeEstimate);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refreshState();
  }, []);

  if (!state) {
    return <div className="app-shell">Loading Kovanica Wallet...</div>;
  }

  const activeAccount = state.accounts[state.activeAccountIndex] ?? state.accounts[0];

  async function handleCreateOrImport(isImport: boolean): Promise<void> {
    setError("");
    setNotice("");
    try {
      const res = await sendBg<{ mnemonic: string }>("WALLET_CREATE", {
        password,
        mnemonic: isImport ? importMnemonic : undefined,
      });
      if (!isImport) {
        setCreatedMnemonic(res.mnemonic);
      }
      setPassword("");
      setImportMnemonic("");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUnlock(): Promise<void> {
    setError("");
    try {
      await sendBg("WALLET_UNLOCK", { password });
      setPassword("");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePasskeyUnlock(): Promise<void> {
    setError("");
    try {
      if (!state?.passkeyRecord) {
        throw new Error("No Passkey registered for this vault");
      }
      const adapter = createBrowserWebAuthnAdapter();
      const unwrappedPassword = await unwrapVaultPasswordWithPasskey({
        adapter,
        rpId: window.location.hostname || "localhost",
        record: state.passkeyRecord,
      });
      await sendBg("WALLET_UNLOCK", { password: unwrappedPassword });
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRegisterPasskey(): Promise<void> {
    setError("");
    setNotice("");
    try {
      if (!passkeyPassword) {
        throw new Error("Enter your current vault password to bind a Passkey");
      }
      const adapter = createBrowserWebAuthnAdapter();
      const record = await registerPasskeyForVault({
        adapter,
        rpId: window.location.hostname || "localhost",
        userName: activeAccount?.address ?? "kovanica-user",
        vaultPassword: passkeyPassword,
        chainId: state?.chainId,
      });
      await sendBg("WALLET_SAVE_PASSKEY", { record });
      setPasskeyPassword("");
      setNotice(`Passkey bound (${record.pro21Address.slice(0, 16)}...)`);
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSend(): Promise<void> {
    setError("");
    setNotice("");
    try {
      const atoms = parseKvnc(sendAmount || "0");
      const res = await sendBg<{ signingHashHex: string; txHash?: string }>("WALLET_SEND_TRANSFER", {
        to: sendTo,
        amountAtoms: atoms.toString(),
      });
      setNotice(`Signed & submitted: ${res.txHash ?? res.signingHashHex}`);
      setSendTo("");
      setSendAmount("");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRegisterSessionKey(): Promise<void> {
    setError("");
    setNotice("");
    try {
      const res = await sendBg<{ record: LocalSessionKeyRecord }>("WALLET_REGISTER_SESSION_KEY", {
        label: skLabel,
        allowedContracts: skContracts
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        allowedMethods: skMethods
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        maxSpendAtoms: parseKvnc(skMaxKvnc || "0").toString(),
        expiresRound: skExpiresRound,
      });
      setNotice(`Session key registered: ${res.record.sessionAddress.slice(0, 18)}...`);
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRevokeSessionKey(id: string): Promise<void> {
    setError("");
    try {
      await sendBg("WALLET_REVOKE_SESSION_KEY", { id });
      setNotice("Session key revoked");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const recipientCheck = sendTo ? validateRecipientAddress(sendTo, state.chainId) : null;

  return (
    <div className="app-shell">
      <div className="header">
        <div className="brand">
          <span>Kovanica</span>
          <span className="badge">MV3</span>
        </div>
        <select
          style={{ width: "auto", minWidth: 145 }}
          value={state.chainId}
          onChange={(e) => {
            void sendBg("WALLET_SWITCH_NETWORK", { chainId: Number(e.target.value) }).then(
              refreshState,
            );
          }}
        >
          {state.networks.map((net) => (
            <option key={net.chainId} value={net.chainId}>
              {net.name}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="ok-box">{notice}</div>}

      {!state.hasVault ? (
        <div className="card">
          <strong>Create or Import Kovanica Vault</strong>
          <span className="muted">
            PBKDF2-SHA256 (600,000 iterations) + AES-256-GCM · BIP-44 m/44&apos;/3007&apos;/0&apos;/0&apos;/0&apos;
          </span>
          <input
            type="password"
            placeholder="Vault password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary" onClick={() => void handleCreateOrImport(false)}>
            Create New Wallet
          </button>
          <textarea
            placeholder="Optional: paste 12 or 24-word BIP-39 mnemonic to import"
            value={importMnemonic}
            onChange={(e) => setImportMnemonic(e.target.value)}
          />
          <button
            className="secondary"
            disabled={!importMnemonic.trim()}
            onClick={() => void handleCreateOrImport(true)}
          >
            Import Existing Mnemonic
          </button>
        </div>
      ) : !state.unlocked ? (
        <div className="card">
          <strong>Unlock Kovanica Vault</strong>
          <input
            type="password"
            placeholder="Enter vault password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleUnlock();
            }}
          />
          <button className="primary" onClick={() => void handleUnlock()}>
            Unlock with Password
          </button>
          {state.hasPasskey && (
            <button className="secondary" onClick={() => void handlePasskeyUnlock()}>
              Unlock with Passkey (Secp256r1 / WebAuthn)
            </button>
          )}
        </div>
      ) : (
        <>
          {createdMnemonic && (
            <div className="card">
              <strong>Backup Your Recovery Phrase</strong>
              <span className="muted">Never stored in plaintext. Save offline before dismissing.</span>
              <div className="mono">{createdMnemonic}</div>
              <button className="secondary" onClick={() => setCreatedMnemonic("")}>
                I Saved My Phrase
              </button>
            </div>
          )}

          <div className="tabs">
            <button
              className={`tab-btn ${tab === "wallet" ? "active" : ""}`}
              onClick={() => setTab("wallet")}
            >
              Wallet
            </button>
            <button
              className={`tab-btn ${tab === "send" ? "active" : ""}`}
              onClick={() => setTab("send")}
            >
              Send
            </button>
            <button
              className={`tab-btn ${tab === "sessions" ? "active" : ""}`}
              onClick={() => setTab("sessions")}
            >
              Sessions
            </button>
            <button
              className={`tab-btn ${tab === "security" ? "active" : ""}`}
              onClick={() => setTab("security")}
            >
              Security
            </button>
          </div>

          {tab === "wallet" && activeAccount && (
            <div className="card">
              <div className="row">
                <select
                  value={state.activeAccountIndex}
                  onChange={(e) => {
                    void sendBg("WALLET_SELECT_ACCOUNT", { index: Number(e.target.value) }).then(
                      refreshState,
                    );
                  }}
                >
                  {state.accounts.map((acc) => (
                    <option key={acc.index} value={acc.index}>
                      {acc.label} ({acc.path})
                    </option>
                  ))}
                </select>
                <button
                  className="secondary"
                  onClick={() => void sendBg("WALLET_ADD_ACCOUNT").then(refreshState)}
                >
                  + Account
                </button>
              </div>
              <div className="balance">{balanceKvnc} KVNC</div>
              <div className="mono">{activeAccount.address}</div>
              <div className="row">
                <span className="badge ok">PRO-21 Strict</span>
                {state.latestHeadHeight !== null && (
                  <span className="badge">Head #{state.latestHeadHeight}</span>
                )}
                <button
                  className="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(activeAccount.address);
                    setNotice("Address copied");
                  }}
                >
                  Copy
                </button>
              </div>
              {feeEst && (
                <div className="muted">
                  Wave B base fee: {feeEst.baseFeePerByte} atoms/B · Est transfer fee:{" "}
                  {feeEst.totalFeeKvnc} KVNC
                </div>
              )}
            </div>
          )}

          {tab === "send" && (
            <div className="card">
              <strong>Send KVNC</strong>
              <input
                placeholder="Recipient PRO-21 address (kvnc...dag)"
                value={sendTo}
                onChange={(e) => setSendTo(e.target.value)}
              />
              {recipientCheck && (
                <span className={`badge ${recipientCheck.valid ? "ok" : "danger"}`}>
                  {recipientCheck.valid
                    ? `Valid ${recipientCheck.format}`
                    : recipientCheck.error}
                </span>
              )}
              <input
                placeholder="Amount in KVNC"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
              />
              <button
                className="primary"
                disabled={!recipientCheck?.valid || !sendAmount}
                onClick={() => void handleSend()}
              >
                Sign & Send Transfer
              </button>
            </div>
          )}

          {tab === "sessions" && (
            <div className="card">
              <strong>Wave C Session Keys</strong>
              <input
                placeholder="Session Label"
                value={skLabel}
                onChange={(e) => setSkLabel(e.target.value)}
              />
              <input
                placeholder="Allowed Contracts (comma-separated PRO-21, blank=any)"
                value={skContracts}
                onChange={(e) => setSkContracts(e.target.value)}
              />
              <input
                placeholder="Allowed Methods (comma-separated, e.g. transfer,swap)"
                value={skMethods}
                onChange={(e) => setSkMethods(e.target.value)}
              />
              <div className="row">
                <input
                  placeholder="Max Spend KVNC"
                  value={skMaxKvnc}
                  onChange={(e) => setSkMaxKvnc(e.target.value)}
                />
                <input
                  placeholder="Expires Round"
                  value={skExpiresRound}
                  onChange={(e) => setSkExpiresRound(e.target.value)}
                />
              </div>
              <button className="primary" onClick={() => void handleRegisterSessionKey()}>
                Create & Sign RegisterSessionKey Tx
              </button>
              <div className="kv-list">
                {state.sessionKeys.map((sk) => (
                  <div key={sk.id} className="card" style={{ padding: 8 }}>
                    <div className="row">
                      <strong>{sk.label}</strong>
                      <span className={`badge ${sk.revoked ? "danger" : "ok"}`}>
                        {sk.revoked ? "Revoked" : "Active"}
                      </span>
                    </div>
                    <div className="mono">{sk.sessionAddress}</div>
                    <div className="muted">
                      Methods: {sk.allowedMethods.join(", ") || "*"} · Exp round {sk.expiresRound}
                    </div>
                    {!sk.revoked && (
                      <button className="danger" onClick={() => void handleRevokeSessionKey(sk.id)}>
                        Revoke Session Key
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "security" && (
            <div className="card">
              <strong>Security, Passkey & dApps</strong>
              <label className="muted">Auto-lock timer (minutes)</label>
              <select
                value={state.autoLockMinutes}
                onChange={(e) => {
                  void sendBg("WALLET_SET_AUTO_LOCK", { minutes: Number(e.target.value) }).then(
                    refreshState,
                  );
                }}
              >
                <option value={5}>5 minutes</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>60 minutes</option>
              </select>

              <div className="row">
                <span className="muted">Passkey (Secp256r1WebAuthn)</span>
                <span className={`badge ${state.hasPasskey ? "ok" : ""}`}>
                  {state.hasPasskey ? "Registered" : "Not Set"}
                </span>
              </div>
              {state.passkeyAddress && <div className="mono">{state.passkeyAddress}</div>}
              <input
                type="password"
                placeholder="Confirm vault password to bind Passkey"
                value={passkeyPassword}
                onChange={(e) => setPasskeyPassword(e.target.value)}
              />
              <button className="secondary" onClick={() => void handleRegisterPasskey()}>
                Register Passkey Unlock
              </button>

              <div className="muted">Connected dApps ({state.connectedOrigins.length})</div>
              {state.connectedOrigins.map((origin) => (
                <div key={origin} className="row">
                  <span className="mono">{origin}</span>
                  <button
                    className="danger"
                    onClick={() =>
                      void sendBg("WALLET_DISCONNECT_ORIGIN", { origin }).then(refreshState)
                    }
                  >
                    Revoke
                  </button>
                </div>
              ))}

              <button
                className="danger"
                onClick={() => void sendBg("WALLET_LOCK").then(refreshState)}
              >
                Lock Vault Now
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
