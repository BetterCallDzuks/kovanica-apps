# Kovanica Browser Extension Wallet (`window.kovanica`)

Self-custodial Manifest V3 (MV3) browser extension wallet for the **Kovanica (KVNC)** Layer-1 blockchain, compatible with **Chrome**, **Brave**, and **Firefox**.

## Features

- **Encrypted Local Vault (Zero Plaintext Storage)**: Uses Web Crypto API `PBKDF2-SHA256` (`>= 600,000` iterations) + `AES-256-GCM` with random 16-byte salt and 12-byte IV. Mnemonics and private keys are never persisted in plaintext and are wiped in memory when locked.
- **Canonical BIP-44 / SLIP-0010 Ed25519 Derivation**: Derives accounts on registered Kovanica coin type `3007` (`m/44'/3007'/0'/0'/0'`) via `kovanica-sdk`.
- **Strict PRO-21 Address Validation**: Enforces canonical 64-character `kvnc...dag` / `tknc...dag` addresses on Mainnet (`1`) and Testnet (`2`), rejecting legacy hex formats.
- **`window.kovanica` dApp Provider**: Injected via MV3 `world: "MAIN"` inpage script + isolated content script + background service worker message bridge, with explicit approval popups displaying decoded method, Wave B base fee & storage deposit estimates, and PRO-21 recipient verification.
- **Wave A–C Protocol Support**:
  - **Wave A**: Atomic Batch (`signBatchTransaction`) and Sponsored/Gasless (`signSponsoredTransaction`) transactions.
  - **Wave B**: Dynamic EIP-1559 base fee per byte & refundable storage deposit delta estimates.
  - **Wave C**: Passkey / WebAuthn (`SignatureScheme.Secp256r1WebAuthn`) vault unlock & Scoped Session Keys (`RegisterSessionKey` / `RevokeSessionKey` builders + policy UI).
- **RPC & WebSocket**: Connects to `https://rpc.kovanica.online/rpc` (Mainnet), `https://rpc-testnet.kovanica.online/rpc` (Testnet), and `http://127.0.0.1:8545/rpc` (Devnet), with `KovanicaWsClient` live head tracking.

---

## Architecture

```text
+--------------------+     postMessage      +--------------------+   chrome.runtime   +------------------------+
|  dApp Page (MAIN)  | <------------------> | Content Script     | <----------------> | Background Service     |
|  window.kovanica   |  KOVANICA_PROVIDER_V1| (Isolated World)   |                    | Worker (Vault + RPC)   |
+--------------------+                      +--------------------+                    +-----------+------------+
                                                                                                  |
                                                                          +-----------------------+----------------------+
                                                                          |                                              |
                                                                          v                                              v
                                                                 +------------------+                           +-------------------+
                                                                 | popup.html       |                           | approval.html     |
                                                                 | Wallet / Send /  |                           | Explicit dApp     |
                                                                 | Sessions / Sec   |                           | Approval & Wave B |
                                                                 +------------------+                           +-------------------+
```

---

## Build & Development

```bash
cd browser-extension
npm install
npm run typecheck
npm test
npm run build
```

The production MV3 bundle is emitted to `browser-extension/dist/`.

---

## Load Unpacked Extension

### Chrome / Brave
1. Run `npm run build` inside `browser-extension/`.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select `browser-extension/dist`.

### Firefox (128+)
1. Run `npm run build` inside `browser-extension/`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select `browser-extension/dist/manifest.json`.

---

## dApp `window.kovanica` API Examples

### Connect & Listen to Events

```ts
if (!window.kovanica) {
  throw new Error("Please install Kovanica Wallet");
}

const { accounts, chainId } = await window.kovanica.connect();
console.log("Connected:", accounts[0], "on chain", chainId);

const onAccountsChanged = (nextAccounts: string[]) => {
  console.log("Accounts updated:", nextAccounts);
};
const onChainChanged = (nextChainId: number) => {
  console.log("Chain switched:", nextChainId);
};

window.kovanica.on("accountsChanged", onAccountsChanged);
window.kovanica.on("chainChanged", onChainChanged);

// Clean up listeners
window.kovanica.removeListener("accountsChanged", onAccountsChanged);
```

### Sign a Native KVNC Transfer

```ts
const signed = await window.kovanica.signTransaction({
  kind: "transfer",
  to: "kvnc...", // canonical 64-char PRO-21 address
  amount: "1000000000", // 1 KVNC in atoms
  nonce: 0,
});
console.log("Signed raw tx:", signed.rawTxHex);
```

### Sign a Wave A Atomic Batch Transaction

```ts
const batch = await window.kovanica.signBatchTransaction({
  nonce: 1,
  actions: [
    { kind: "transfer", to: "kvnc...", amount: "500000000" },
    {
      kind: "call",
      contract: "kvnc...",
      method: "swap",
      argsHex: "0x010203",
      gasLimit: 300_000,
    },
  ],
});
```

### Sign a Wave A Sponsored (Gasless) Transaction

```ts
const sponsored = await window.kovanica.signSponsoredTransaction({
  nonce: 2,
  feePayerPublicKeyHex: "0x...",
  inner: {
    kind: "transfer",
    to: "kvnc...",
    amount: "250000000",
    nonce: 2,
  },
});
```

### Sign an Off-Chain Message

```ts
const { messageHashHex, signatureHex } = await window.kovanica.signMessage(
  "Sign in to Kovanica dApp",
);
```
