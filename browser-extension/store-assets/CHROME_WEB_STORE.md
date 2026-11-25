# Chrome Web Store Submission Listing — Kovanica Wallet

This document contains the exact, review-ready copy, privacy disclosures, permission justifications, and reviewer test instructions for submitting **Kovanica Wallet** (`@kovanica/browser-extension`) to the Chrome Web Store Developer Dashboard.

---

## 1. Store Listing Copy

| Field | Value |
| --- | --- |
| **Extension Name** | `Kovanica Wallet` |
| **Short Summary** *(<= 132 chars)* | `Self-custodial Kovanica (KVNC) Layer-1 wallet with window.kovanica dApp provider, Passkey unlock, and Wave A-C signing.` *(119 chars)* |
| **Category** | `Productivity` (Tools) |
| **Language** | `English` |
| **Official Website / Homepage** | `https://kovanica.online` |
| **Support URL** | `https://github.com/BetterCallDzuks/kovanica-apps/issues` |
| **Privacy Policy URL** | `https://kovanica.online/privacy` *(canonical text in [PRIVACY_POLICY.md](./PRIVACY_POLICY.md))* |
| **Minimum Chrome Version** | `120` |

### Full Description

```text
Kovanica Wallet is the official self-custodial Manifest V3 browser extension wallet for the Kovanica (KVNC) Layer-1 blockchain.

Manage KVNC accounts, validate canonical PRO-21 addresses, and sign decentralized application (dApp) transactions locally in your browser — with zero telemetry and zero plaintext key storage.

KEY FEATURES
• Encrypted Local Vault: Your BIP-39 recovery phrase and Ed25519 private keys are encrypted locally using the Web Crypto API (PBKDF2-SHA256 with >= 600,000 iterations and AES-256-GCM with random salt and IV). Decrypted secrets stay in memory only while unlocked and are wiped on lock or auto-lock timeout.
• Canonical BIP-44 Derivation & Strict PRO-21 Validation: Derives accounts on Kovanica's registered SLIP-0010 coin type 3007 (m/44'/3007'/0'/0'/0') and enforces canonical 64-character kvnc...dag (Mainnet) and tknc...dag (Testnet) addresses to prevent mistyped or legacy-format transfers.
• window.kovanica dApp Provider: Injects a read-only window.kovanica provider so Kovanica dApps can request connections and transaction signatures. Every request opens an isolated approval window displaying the requesting origin, decoded method, PRO-21 recipient verification, and exact fee estimates before you approve or reject.
• Wave A-C Protocol Support:
  - Wave A: Atomic multi-action Batch transactions (signBatchTransaction) and Sponsored / Gasless transactions (signSponsoredTransaction).
  - Wave B: Dynamic EIP-1559 base fee per byte and refundable storage deposit delta estimates shown before signing.
  - Wave C: Optional Passkey / WebAuthn (Secp256r1WebAuthn) vault unlock and Scoped Session Keys (register & revoke policy-bounded dApp session keys).
• Multi-Network Support: Switch cleanly between Kovanica Mainnet (Chain 1), Kovanica Testnet (Chain 2), and Local Devnet (127.0.0.1:8545).

SECURITY & PRIVACY
• 100% self-custodial — Kovanica never sees or stores your recovery phrase or private keys.
• Zero telemetry, analytics, or third-party tracking.
• No remote code execution — all code is bundled and audited in the open-source repository.
```

---

## 2. Visual Assets Checklist

All store graphics are stored in `store-assets/` and generated from `scripts/generate-store-assets.py`:

- **Store Icon (128x128 PNG)**: `store-assets/icons/icon-128.png`
- **Small Promo Tile (440x280 PNG, opaque RGB)**: `store-assets/images/promo-small-440x280.png`
- **Screenshot 1 (1280x800 PNG)**: `store-assets/images/screenshot-wallet-1280x800.png` — Wallet Overview, PRO-21 Address Guard & Wave B Fee Display
- **Screenshot 2 (1280x800 PNG)**: `store-assets/images/screenshot-approval-1280x800.png` — Isolated dApp Signature Approval & Wave B Breakdown

---

## 3. Privacy Practices & Single-Purpose Statement

### Single-Purpose Description

> Kovanica Wallet has a single purpose: providing a self-custodial cryptocurrency wallet and dApp transaction signer for the Kovanica (KVNC) Layer-1 blockchain.

### Data Usage Disclosures

- **Does this extension collect or transmit any user data?** **No.**
- **Personal / Financial / Authentication / Web History / Location / Website Content**: **Not collected.**
- **Certifications**:
  - [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
  - [x] I do not use or transfer user data for purposes that are unrelated to the item's single purpose.
  - [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Remote Code Statement

- **Are you using remote code?** **No.**
- All JavaScript, CSS, and HTML are bundled at build time via `esbuild` into the extension package. `content_security_policy.extension_pages` enforces `script-src 'self'; object-src 'self'`.

---

## 4. Permission Justifications (Every Manifest Entry)

Use these exact justifications in the Chrome Web Store **Privacy Practices** tab:

| Manifest Field | Value | Justification |
| --- | --- | --- |
| `permissions` | `storage` | Persists the user's locally encrypted wallet vault (`PBKDF2-SHA256 >= 600,000` iterations + `AES-256-GCM`), optional WebAuthn/Passkey wrapped key metadata, and local Wave C session key policy records inside `chrome.storage.local`. No plaintext mnemonic or private key is ever stored. |
| `permissions` | `alarms` | Schedules a local `chrome.alarms` timer (`kovanica_auto_lock`) to automatically lock the wallet and wipe decrypted key material from service worker memory after the user's configured inactivity timeout (default 15 minutes). |
| `host_permissions` | `https://rpc.kovanica.online/*` | Required for the background service worker to query account balances, nonces, dynamic Wave B fee estimates, and broadcast user-signed transactions to Kovanica Mainnet RPC/WebSocket endpoints. |
| `host_permissions` | `https://rpc-testnet.kovanica.online/*` | Required for querying balances, nonces, fee estimates, and broadcasting transactions when the user switches to Kovanica Testnet. |
| `host_permissions` | `http://127.0.0.1:8545/*` | Required for developers and testers who switch the wallet to Local Devnet to interact with a locally running Kovanica L1 node. |
| `content_scripts` | `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` (`inpage.js` in `world: "MAIN"` + `content.js` in isolated world) | Injects the standard read-only `window.kovanica` dApp provider API and isolated message bridge so any Kovanica-compatible dApp (whether hosted on HTTPS or developed locally) can detect the wallet and request explicit user approval to connect or sign transactions. The content script never reads, scrapes, or modifies page DOM content or user browsing history; it strictly forwards `KOVANICA_PROVIDER_V1` `window.postMessage` RPC envelopes initiated by a dApp. |

---

## 5. Reviewer Test Instructions

Provide the following instructions in the **Test Instructions** field for Chrome Web Store reviewers:

```text
No login credentials or real funds are required to test Kovanica Wallet.

1. Install the extension and click the Kovanica Wallet toolbar icon to open popup.html.
2. Create a local test wallet:
   - Enter any password (at least 8 characters, e.g., "TestWallet123!") and click "Create New Wallet".
   - Confirm the generated 12-word BIP-39 recovery phrase and verify the wallet unlocks to Account 1 with a canonical 64-character kvnc...dag PRO-21 address.
3. Test Network Switching & Read-Only RPC:
   - Use the network selector in the header to switch to "Kovanica Testnet" (Chain 2).
   - Confirm the address prefix updates to canonical tknc...dag and the balance / Wave B fee estimate card loads from https://rpc-testnet.kovanica.online/rpc.
4. Test Tabs & Local Security Controls:
   - "Send" tab: Enter an invalid or legacy hex address (e.g., "0x1234") to verify strict PRO-21 validation rejects it before signing.
   - "Sessions" tab: Review the Wave C Scoped Session Key builder UI (contract allowlist, method allowlist, spend cap, expiry round).
   - "Security" tab: Adjust the Auto-Lock timer or click "Lock" to confirm the vault locks immediately and requires the password to unlock.
5. Test window.kovanica dApp Provider & Approval Popup:
   - Open https://testnet.kovanica.online (or any HTTPS page) and open DevTools Console.
   - Run: `await window.kovanica.connect()`
   - An isolated approval popup window (approval.html) opens displaying the requesting origin.
   - Click "Reject" to verify rejection returns an error, or "Approve" to verify the connected account address and chainId are returned to the page.
```
