# Firefox Add-ons (AMO) Submission Guide — Kovanica Wallet

This document contains the AMO listing copy, `browser_specific_settings.gecko` details, data collection disclosures, and exact reproducible build instructions for Mozilla Add-ons (AMO) reviewers.

---

## 1. AMO Listing Copy

| Field | Value |
| --- | --- |
| **Add-on Name** | `Kovanica Wallet` |
| **Add-on ID (`gecko.id`)** | `wallet@kovanica.online` |
| **Minimum Firefox Version** | `128.0` *(supports MV3 `content_scripts` with `world: "MAIN"` and ES module background scripts)* |
| **Summary** *(<= 250 chars)* | `Self-custodial Kovanica (KVNC) Layer-1 browser extension wallet with encrypted local vault, strict PRO-21 address validation, Passkey unlock, Wave A-C signing, and window.kovanica dApp provider.` *(194 chars)* |
| **Categories** | `Privacy & Security`, `Other` |
| **Homepage** | `https://kovanica.online` |
| **Support Site** | `https://github.com/BetterCallDzuks/kovanica-apps/issues` |
| **Privacy Policy** | `https://kovanica.online/privacy` *(also bundled in [PRIVACY_POLICY.md](./PRIVACY_POLICY.md))* |
| **Tags** | `wallet`, `crypto`, `kovanica`, `kvnc`, `web3`, `passkey` |

### Full Description

```text
Kovanica Wallet is the official self-custodial Manifest V3 wallet for the Kovanica (KVNC) Layer-1 blockchain.

Key capabilities:
• Encrypted Local Vault: BIP-39 recovery phrases and Ed25519 keys are encrypted locally using Web Crypto PBKDF2-SHA256 (>= 600,000 iterations) and AES-256-GCM. Plaintext secrets are never written to disk and are wiped from memory on lock.
• Canonical BIP-44 & Strict PRO-21 Validation: Derives accounts on coin type 3007 (m/44'/3007'/0'/0'/0') and validates canonical 64-character kvnc...dag / tknc...dag addresses on Mainnet and Testnet.
• window.kovanica dApp Provider: Injects a read-only window.kovanica provider via MAIN-world content script and isolated message bridge. Every dApp connection or signing request opens a dedicated approval popup with decoded method details and Wave B fee/storage deposit estimates.
• Wave A-C Protocol Support: Atomic batch transactions, sponsored/gasless transactions, dynamic Wave B fee previews, optional Passkey/WebAuthn vault unlock, and Scoped Session Keys.
• Zero Telemetry: No analytics, tracking, or remote code execution.
```

---

## 2. Firefox MV3 Compatibility Details

The Firefox build (`npm run package:firefox`) uses `public/manifest.firefox.json`, which differs from Chrome's `public/manifest.json` in two intentional ways:

1. **Event Page Background (`background.scripts`)**:
   ```json
   "background": {
     "scripts": ["background.js"],
     "type": "module"
   }
   ```
   Firefox MV3 runs ES module background scripts via `background.scripts` (event pages) rather than Chrome's `background.service_worker`.
2. **Gecko Metadata & Data Collection Declaration**:
   ```json
   "browser_specific_settings": {
     "gecko": {
       "id": "wallet@kovanica.online",
       "strict_min_version": "128.0",
       "data_collection_permissions": {
         "required": ["none"]
       }
     }
   }
   ```
   - `strict_min_version: "128.0"` guarantees native support for `content_scripts[].world = "MAIN"` (introduced in Firefox 128).
   - `data_collection_permissions.required: ["none"]` declares zero telemetry/data collection per Mozilla's built-in data collection consent schema.

---

## 3. Data Collection Disclosures (AMO Submission Form)

- **Does your add-on collect or transmit any data?** **No.**
- **Local storage only**: Encrypted vault ciphertext, user preferences (auto-lock interval, active network/account index), and local session key metadata are stored solely in `browser.storage.local` / `chrome.storage.local`.
- **Network requests**: Outbound RPC/WebSocket requests are made exclusively to the user-selected Kovanica network node (`https://rpc.kovanica.online/*`, `https://rpc-testnet.kovanica.online/*`, or `http://127.0.0.1:8545/*`) to query chain state and broadcast user-signed transactions.
- **No third-party trackers, analytics, or remote code.**

---

## 4. Reviewer Notes & Reproducible Build Instructions (Source Code Submission)

Because `esbuild` bundles and minifies TypeScript/React sources into `dist/firefox/*.js`, AMO requires a source-code archive (`dist/kovanica-wallet-firefox-source-v0.1.0.zip`) alongside the built XPI/ZIP (`dist/kovanica-wallet-firefox-v0.1.0.zip`).

Paste the following into the **Notes to Reviewer** field on AMO:

```text
BUILD ENVIRONMENT
- Operating System: Linux / macOS (tested on Ubuntu Linux)
- Node.js: >= 20.0.0 (tested on Node v24.21.0)
- npm: >= 10.0.0
- zip utility (Info-ZIP 3.0)

REPOSITORY & DEPENDENCY NOTE
This extension depends on the local workspace SDK package `kovanica-sdk`
("kovanica-sdk": "file:../../kovanica-sdk") from the open-source Kovanica repositories:
  - Extension repo: https://github.com/BetterCallDzuks/kovanica-apps (subdirectory: browser-extension/)
  - SDK repo:       https://github.com/BetterCallDzuks/kovanica-sdk

EXACT REPRODUCIBLE BUILD STEPS
1. Place `kovanica-sdk` and `kovanica-apps` as sibling directories (matching `file:../../kovanica-sdk`):
     workspace/
       kovanica-sdk/
       kovanica-apps/browser-extension/   (or extract the uploaded source archive here)
2. Build `kovanica-sdk` first if not already built:
     cd workspace/kovanica-sdk
     npm ci && npm run build
3. Install extension dependencies and run tests + Firefox packaging:
     cd workspace/kovanica-apps/browser-extension
     npm ci
     npm run typecheck
     npm test
     npm run package:firefox
4. Output artifacts:
   - Unpacked Firefox MV3 directory: dist/firefox/
   - Reproducible Firefox ZIP:       dist/kovanica-wallet-firefox-v0.1.0.zip
   - SHA-256 checksum:               dist/kovanica-wallet-firefox-v0.1.0.zip.sha256

The packaging script (`scripts/package-store.mjs`) normalizes file timestamps to
2026-01-01T00:00:00Z, sorts paths lexicographically, and invokes `zip -qX` under TZ=UTC
so the resulting ZIP matches the uploaded add-on archive byte-for-byte.

MANUAL TESTING
1. Open the extension popup, enter an 8+ char password, and click "Create New Wallet".
2. Switch to "Kovanica Testnet" (Chain 2) to verify RPC queries and canonical tknc...dag addresses.
3. On any HTTPS tab, run `await window.kovanica.connect()` in the Web Console to trigger the
   isolated approval popup (approval.html) and verify Approve / Reject flows.
```
