# Privacy Policy — Kovanica Wallet Browser Extension

**Effective Date:** November 25, 2026  
**Publisher:** Kovanica Protocol (`kovanica.online`)  
**Extension:** Kovanica Wallet (Chrome Web Store & Firefox Add-ons)

---

## 1. Overview

Kovanica Wallet is a **self-custodial**, open-source browser extension wallet for the Kovanica (KVNC) Layer-1 blockchain. Privacy and local custody are core architectural invariants of the extension:

- **Zero Telemetry:** We do not collect, log, or transmit analytics, crash reports, usage metrics, device identifiers, or browsing history.
- **Zero Plaintext Key Storage:** Your BIP-39 mnemonic phrase and Ed25519 private keys are never transmitted to any server and are never stored in plaintext.
- **Zero Third-Party Tracking:** The extension contains no third-party SDKs, advertising pixels, or external script loaders.

---

## 2. Data Stored Locally on Your Device

Kovanica Wallet stores data exclusively inside your browser's local extension storage (`chrome.storage.local` / `browser.storage.local`):

1. **Encrypted Wallet Vault (`kovanica_encrypted_vault_v1`):**
   - Encrypted locally using the browser's Web Crypto API (`PBKDF2-SHA256` with `>= 600,000` iterations and `AES-256-GCM` with random 16-byte salt and 12-byte IV).
   - Stores only ciphertext, KDF parameters, salt/IV, account count, active account index, auto-lock timeout, and optional WebAuthn/Passkey wrapped key metadata.
   - Decrypted secrets exist only in ephemeral extension memory while unlocked and are wiped when you lock the wallet or when the auto-lock alarm fires.
2. **Scoped Session Key Metadata (`kovanica_session_keys_v1`):**
   - Stores public session key identifiers and policy parameters (label, allowed contracts/methods, spend cap, expiry round, revocation status) created by you for Wave C session keys.

This data never leaves your browser profile unless you explicitly export your recovery phrase yourself.

---

## 3. Network & RPC Communications

To display balances, nonces, dynamic Wave B fee estimates, and broadcast transactions you explicitly approve, Kovanica Wallet communicates **only** with the Kovanica network RPC and WebSocket endpoint corresponding to your selected network:

| Network | JSON-RPC Endpoint | WebSocket Endpoint |
| --- | --- | --- |
| **Kovanica Mainnet (Chain 1)** | `https://rpc.kovanica.online/rpc` | `wss://rpc.kovanica.online/ws` |
| **Kovanica Testnet (Chain 2)** | `https://rpc-testnet.kovanica.online/rpc` | `wss://rpc-testnet.kovanica.online/ws` |
| **Local Devnet** | `http://127.0.0.1:8545/rpc` | `ws://127.0.0.1:8545/ws` |

### What Is Sent to RPC Nodes
- **Read queries:** Your public PRO-21 account address (`kvnc...dag` / `tknc...dag`) to fetch balance, nonce, and fee parameters.
- **Broadcasts:** Cryptographically signed transaction payloads **only** when you explicitly initiate a transfer or approve a dApp transaction.
- **Standard network metadata:** As with any direct HTTPS/WebSocket request, the RPC server observes your IP address at the transport layer. Kovanica Wallet does not attach cookies, analytics headers, or cross-session tracking identifiers.

---

## 4. Decentralized Application (`window.kovanica`) Interactions

- The extension injects a read-only `window.kovanica` provider object and an isolated message bridge on HTTPS and localhost pages so Kovanica dApps can detect the wallet.
- The content script **does not** read, scrape, or transmit webpage DOM content or your browsing history.
- A website **cannot** see your wallet address or request signatures silently. Every `connect`, `signTransaction`, `signBatchTransaction`, `signSponsoredTransaction`, or `signMessage` request opens an isolated approval popup showing the requesting origin and decoded payload, requiring your explicit approval.
- You can view and disconnect connected origins at any time in the **Security** tab.

---

## 5. Data Sharing, Sale & Retention

- **No Sale or Sharing:** We do not sell, rent, or transfer user data to any third party.
- **Retention & Deletion:** Because all wallet data is stored locally in your browser, you have complete control over retention. Removing the extension or clearing extension storage permanently deletes all local vault and session data from your device. (Always back up your BIP-39 recovery phrase before uninstalling.)

---

## 6. Open Source & Contact

Kovanica Wallet is open source and auditable at:
- Repository: `https://github.com/BetterCallDzuks/kovanica-apps`
- Security & Privacy Inquiries: `https://github.com/BetterCallDzuks/kovanica-apps/issues` or `https://kovanica.online`
