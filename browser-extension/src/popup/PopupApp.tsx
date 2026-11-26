import React, { useEffect, useState } from "react";
import { parseKvnc } from "kovanica-sdk";
import { ECOSYSTEM_LINKS, resolveEcosystemHref } from "../core/ecosystem";
import type { NetworkProfile } from "../core/networks";
import { validateRecipientAddress } from "../core/networks";
import {
  createBrowserWebAuthnAdapter,
  registerPasskeyForVault,
  unwrapVaultPasswordWithPasskey,
} from "../core/passkey";
import { renderQrSvg } from "../core/qr";
import type { LocalSessionKeyRecord } from "../core/session-keys";
import { parseTokenUnits, type WatchedTokenBalance, type WatchedTokenEntry } from "../core/tokens";
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
  watchedTokens?: WatchedTokenEntry[];
  stealthMetaAddress?: string | null;
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

  // Balance & KVP-102 token watchlist state
  const [balanceKvnc, setBalanceKvnc] = useState("0");
  const [feeEst, setFeeEst] = useState<WaveBFeeEstimate | null>(null);
  const [tokenBalances, setTokenBalances] = useState<WatchedTokenBalance[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [newTokenContract, setNewTokenContract] = useState("");

  // Inline KVP-102 token send state
  const [sendingTokenContract, setSendingTokenContract] = useState<string | null>(null);
  const [tokenSendTo, setTokenSendTo] = useState("");
  const [tokenSendAmount, setTokenSendAmount] = useState("");
  const [tokenSendSubmitting, setTokenSendSubmitting] = useState(false);

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

  // Inline SVG QR toggles (PRO-21 address + KVP-103 stealth meta-address)
  const [showAddressQr, setShowAddressQr] = useState(false);
  const [showStealthQr, setShowStealthQr] = useState(false);

  async function refreshState(): Promise<void> {
    try {
      const next = await sendBg<WalletStateResponse>("WALLET_GET_STATE");
      setState(next);
      if (next.unlocked && next.accounts[next.activeAccountIndex]) {
        const addr = next.accounts[next.activeAccountIndex]!.address;
        const [bal, tokRes] = await Promise.all([
          sendBg<{ balanceKvnc: string; feeEstimate: WaveBFeeEstimate }>(
            "WALLET_FETCH_BALANCE",
            { address: addr },
          ).catch(() => null),
          (next.watchedTokens ?? []).length > 0
            ? (setTokensLoading(true),
              sendBg<{ tokens: WatchedTokenBalance[] }>("WALLET_FETCH_TOKEN_BALANCES", {
                address: addr,
              })
                .catch(() => null)
                .finally(() => setTokensLoading(false)))
            : Promise.resolve({ tokens: [] }),
        ]);
        if (bal) {
          setBalanceKvnc(bal.balanceKvnc);
          setFeeEst(bal.feeEstimate);
        }
        if (tokRes) {
          setTokenBalances(tokRes.tokens);
        }
      } else {
        setTokenBalances([]);
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

  async function handleAddToken(): Promise<void> {
    setError("");
    setNotice("");
    try {
      await sendBg("WALLET_ADD_TOKEN", { contract: newTokenContract.trim() });
      setNewTokenContract("");
      setNotice("KVP-102 token added to watchlist");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveToken(contract: string): Promise<void> {
    setError("");
    try {
      await sendBg("WALLET_REMOVE_TOKEN", { contract });
      if (sendingTokenContract === contract) {
        setSendingTokenContract(null);
        setTokenSendTo("");
        setTokenSendAmount("");
      }
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleToggleTokenSend(contract: string): void {
    setError("");
    if (sendingTokenContract === contract) {
      setSendingTokenContract(null);
      setTokenSendTo("");
      setTokenSendAmount("");
    } else {
      setSendingTokenContract(contract);
      setTokenSendTo("");
      setTokenSendAmount("");
    }
  }

  async function handleSendToken(token: WatchedTokenBalance): Promise<void> {
    setError("");
    setNotice("");
    setTokenSendSubmitting(true);
    try {
      const decimals = token.decimals ?? 0;
      const amountUnits = parseTokenUnits(tokenSendAmount, decimals);
      if (amountUnits <= 0n) {
        throw new Error("Token amount must be greater than zero");
      }
      const res = await sendBg<{ signingHashHex: string; txHash?: string }>("WALLET_SEND_TOKEN", {
        contract: token.contract,
        to: tokenSendTo.trim(),
        amountUnits: amountUnits.toString(),
      });
      setNotice(
        `Sent ${tokenSendAmount.trim()} ${token.symbol ?? "tokens"} · tx: ${res.txHash ?? res.signingHashHex}`,
      );
      setSendingTokenContract(null);
      setTokenSendTo("");
      setTokenSendAmount("");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTokenSendSubmitting(false);
    }
  }

  const recipientCheck = sendTo ? validateRecipientAddress(sendTo, state.chainId) : null;
  const newTokenCheck = newTokenContract.trim()
    ? validateRecipientAddress(newTokenContract.trim(), state.chainId)
    : null;

  return (
    <div className="app-shell">
      <div className="header">
        <div className="brand">
          <img
            src="icons/kvnc-coin-128.png"
            alt="KVNC"
            className="coin-logo-sm"
            width={22}
            height={22}
          />
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
            <>
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
                <div className="balance-row">
                  <img
                    src="icons/kvnc-coin-128.png"
                    alt="KVNC coin"
                    className="coin-logo"
                    width={36}
                    height={36}
                  />
                  <div className="balance">{balanceKvnc} KVNC</div>
                </div>
                <div className="mono">{activeAccount.address}</div>
                <div className="row">
                  <span className="badge ok">PRO-21 Strict</span>
                  {state.latestHeadHeight !== null && (
                    <span className="badge">Head #{state.latestHeadHeight}</span>
                  )}
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className="secondary"
                      onClick={() => setShowAddressQr((prev) => !prev)}
                    >
                      {showAddressQr ? "Hide QR" : "Show QR"}
                    </button>
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
                </div>
                {showAddressQr && (
                  <div className="qr-panel">
                    <div
                      className="qr-frame"
                      dangerouslySetInnerHTML={{
                        __html: renderQrSvg(activeAccount.address, {
                          ariaLabel: `PRO-21 receive QR for ${activeAccount.label}`,
                          sizePx: 176,
                        }),
                      }}
                    />
                    <span className="muted">Scan to receive KVNC (PRO-21)</span>
                  </div>
                )}
                {feeEst && (
                  <div className="muted">
                    Wave B base fee: {feeEst.baseFeePerByte} atoms/B · Est transfer fee:{" "}
                    {feeEst.totalFeeKvnc} KVNC
                  </div>
                )}
              </div>

              {state.stealthMetaAddress && (
                <div className="card">
                  <div className="row">
                    <strong>Stealth Meta-Address (KVP-103)</strong>
                    <span className="badge ok">Dual-Key</span>
                  </div>
                  <div className="muted">
                    Share this meta-address to receive unlinkable one-time payments.
                  </div>
                  <div className="mono">{state.stealthMetaAddress}</div>
                  <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                    <button
                      className="secondary"
                      onClick={() => setShowStealthQr((prev) => !prev)}
                    >
                      {showStealthQr ? "Hide QR" : "Show QR"}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => {
                        void navigator.clipboard?.writeText(state.stealthMetaAddress ?? "");
                        setNotice("Stealth meta-address copied");
                      }}
                    >
                      Copy Stealth Address
                    </button>
                  </div>
                  {showStealthQr && (
                    <div className="qr-panel">
                      <div
                        className="qr-frame"
                        dangerouslySetInnerHTML={{
                          __html: renderQrSvg(state.stealthMetaAddress, {
                            ariaLabel: "KVP-103 stealth meta-address QR",
                            sizePx: 176,
                          }),
                        }}
                      />
                      <span className="muted">Scan to receive private KVP-103 stealth payments</span>
                    </div>
                  )}
                </div>
              )}

              <div className="card">
                <div className="row">
                  <strong>KVP-102 Tokens</strong>
                  <button
                    className="secondary"
                    disabled={tokensLoading}
                    onClick={() => void refreshState()}
                  >
                    {tokensLoading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>

                {(state.watchedTokens ?? []).length === 0 ? (
                  <div className="muted">
                    No watched KVP-102 tokens on {state.network.name}. Add a contract address below.
                  </div>
                ) : (
                  <div className="token-list">
                    {(state.watchedTokens ?? []).map((entry) => {
                      const info = tokenBalances.find((t) => t.contract === entry.contract);
                      const isSending = sendingTokenContract === entry.contract;
                      const tokenRecipientCheck =
                        isSending && tokenSendTo.trim()
                          ? validateRecipientAddress(tokenSendTo.trim(), state.chainId)
                          : null;
                      let parsedUnitsPreview: bigint | null = null;
                      let amountParseError = "";
                      if (isSending && tokenSendAmount.trim() && info?.status === "ok") {
                        try {
                          parsedUnitsPreview = parseTokenUnits(tokenSendAmount, info.decimals ?? 0);
                          if (parsedUnitsPreview <= 0n) {
                            amountParseError = "Amount must be greater than zero";
                          }
                        } catch (err) {
                          amountParseError = err instanceof Error ? err.message : String(err);
                        }
                      }

                      return (
                        <div key={entry.contract} className="token-row">
                          <div className="token-row-header">
                            <div className="token-meta">
                              <div className="row" style={{ justifyContent: "flex-start", gap: 6 }}>
                                <strong>
                                  {info?.status === "ok"
                                    ? `${info.symbol} · ${info.name}`
                                    : `${entry.contract.slice(0, 12)}...${entry.contract.slice(-6)}`}
                                </strong>
                                {info?.paused && <span className="badge warn">Paused</span>}
                              </div>
                              <div className="muted">
                                {info?.status === "ok"
                                  ? `${info.balanceFormatted ?? "0"} ${info.symbol}`
                                  : info?.status === "not_a_token"
                                    ? "No KVP-102 state at contract"
                                    : info?.status === "unreadable"
                                      ? "Unreadable token state"
                                      : info?.status === "error"
                                        ? info.error ?? "RPC read failed"
                                        : "Loading balance..."}
                              </div>
                            </div>
                            <div className="token-actions">
                              {info?.status === "ok" && !info.paused && (
                                <button
                                  className="secondary"
                                  onClick={() => handleToggleTokenSend(entry.contract)}
                                >
                                  {isSending ? "Close" : "Send"}
                                </button>
                              )}
                              <button
                                className="danger"
                                onClick={() => void handleRemoveToken(entry.contract)}
                              >
                                Remove
                              </button>
                            </div>
                          </div>

                          {isSending && info?.status === "ok" && (
                            <div className="token-send-form">
                              <input
                                placeholder="Recipient PRO-21 address (kvnc...dag)"
                                value={tokenSendTo}
                                onChange={(e) => setTokenSendTo(e.target.value)}
                              />
                              {tokenRecipientCheck && !tokenRecipientCheck.valid && (
                                <span className="badge danger">{tokenRecipientCheck.error}</span>
                              )}
                              <input
                                placeholder={`Amount in ${info.symbol ?? "tokens"} (${info.decimals ?? 0} dec)`}
                                value={tokenSendAmount}
                                onChange={(e) => setTokenSendAmount(e.target.value)}
                              />
                              {amountParseError && (
                                <span className="badge danger">{amountParseError}</span>
                              )}
                              {parsedUnitsPreview !== null && !amountParseError && (
                                <div className="muted">
                                  Base units: {parsedUnitsPreview.toString()}
                                </div>
                              )}
                              <div className="row">
                                <button
                                  className="primary"
                                  disabled={
                                    tokenSendSubmitting ||
                                    !tokenRecipientCheck?.valid ||
                                    !parsedUnitsPreview ||
                                    Boolean(amountParseError)
                                  }
                                  onClick={() => void handleSendToken(info)}
                                >
                                  {tokenSendSubmitting
                                    ? "Sending..."
                                    : `Send ${info.symbol ?? "Token"}`}
                                </button>
                                <button
                                  className="secondary"
                                  disabled={tokenSendSubmitting}
                                  onClick={() => handleToggleTokenSend(entry.contract)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="row">
                  <input
                    placeholder="KVP-102 contract (kvnc...dag)"
                    value={newTokenContract}
                    onChange={(e) => setNewTokenContract(e.target.value)}
                  />
                  <button
                    className="secondary"
                    disabled={!newTokenCheck?.valid}
                    onClick={() => void handleAddToken()}
                  >
                    + Watch
                  </button>
                </div>
                {newTokenCheck && !newTokenCheck.valid && (
                  <span className="badge danger">{newTokenCheck.error}</span>
                )}
              </div>
            </>
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

      <footer className="ecosystem-footer" aria-label="Kovanica Ecosystem">
        <span className="muted">Ecosystem</span>
        <nav className="ecosystem-links" aria-label="Ecosystem links">
          {ECOSYSTEM_LINKS.map((item) => (
            <a
              key={item.id}
              className="ecosystem-link"
              href={resolveEcosystemHref(item, state.network.explorerUrl)}
              target="_blank"
              rel="noreferrer"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </footer>
    </div>
  );
}
