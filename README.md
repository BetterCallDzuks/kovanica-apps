# kovanica-apps

Cross-platform client applications for the **Kovanica (KVNC)** Layer-1 blockchain — covering Web Wallet (`wallet-web`), MV3 Browser Extension (`browser-extension`), Desktop Console (`console-desktop`), Linux Node Supervisor (`node-desktop`), Desktop Comms (`desktop`), Android, and iOS.

> [!IMPORTANT]
> **Repository Boundaries (HR / EN):**
> - **EN:** Client apps live here (`wallet-web`, `console-desktop`, `node-desktop`, `desktop`, `android*`, `ios`). Native Rust FFI (`kovanica-light-ffi`), consensus, genesis, and node binaries remain in [`BetterCallDzuks/kovanica-l1`](https://github.com/BetterCallDzuks/kovanica-l1). Never reintroduce `kovanica-light-ffi`, secrets, `.env` files, or private IPs into this repository.
> - **HR:** Ovdje žive klijentske aplikacije (`wallet-web`, `console-desktop`, `node-desktop`, `desktop`, `android*`, `ios`). Rust FFI (`kovanica-light-ffi`), consensus, genesis i node binarni kod ostaju u [`BetterCallDzuks/kovanica-l1`](https://github.com/BetterCallDzuks/kovanica-l1).

---

## Repository Layout

| Directory | Platform / Stack | Role | Documentation |
| :--- | :--- | :--- | :--- |
| `wallet-web` | React / TanStack Start + `kovanica-sdk v0.9.0` | Hybrid web & desktop wallet with Ecosystem Switcher, 3-sub-tab Contracts workspace, and canonical `rpc-testnet.kovanica.online` defaults | [`wallet-web/README.md`](wallet-web/README.md) |
| `browser-extension` | Chrome / Brave / Firefox MV3 + `window.kovanica` | Non-custodial browser extension wallet with `window.kovanica` dApp provider, Wave A batch signing, dual Chrome/Firefox MV3 manifests & Chrome Web Store / Firefox AMO release kit (`store-assets/`) | [`browser-extension/README.md`](browser-extension/README.md) |
| `console-desktop` | Tauri + React + TypeScript | Desktop wallet, operator node inspector & cluster readiness console | [`console-desktop/README.md`](console-desktop/README.md) |
| `node-desktop` | Tauri + Vite (Linux `.deb`) | External `kovanica-node` supervisor & operator CLI helper (no bundled node binary) | [`node-desktop/README.md`](node-desktop/README.md) |
| `desktop` | Tauri | Desktop E2E encrypted Comms shell | [`desktop/README.md`](desktop/README.md) |
| `android` / `android-wallet` | Kotlin / UniFFI | Streamlined 2-tab Wallet/Account app (`Testnet` / `Mainnet` only, dark 24-word seed confirmation, BIP-44 `m/44'/3007'/0'/0'/0'` parity) | [`docs/android-release-build.md`](docs/android-release-build.md) |
| `android-comms` | Kotlin | Android E2E encrypted Comms client | — |
| `android-chain` | Kotlin | Shared canonical Chain IDs (`1` Mainnet, `2` Testnet, `3` Devnet) | — |
| `android-node` | Kotlin / Rust | Android Testnet node (`START_STICKY` + WakeLock/WifiLock keep-alive, embedded `127.0.0.1:8545` RPC, thermal-safe `1..4`-thread PoW miner) | [`android-node/README.md`](android-node/README.md) |
| `ios` | Swift / UniFFI | iOS light client | — |

---

## Key Capabilities

1. **Web Wallet (`wallet-web`, powered by `kovanica-sdk v0.9.0`):**
   - Multi-endpoint RPC failover (`createWalletFailoverClient`, `normalizeFailoverRpcUrls`) and header-aware RPC probing (`probeWalletRpcEndpoint`).
   - Live transaction finality tracking (`watchSubmittedTxFinality`, `formatFinalityProgressBadge`) and mempool fee-tier estimation (`fetchWalletFeeTiers` with automatic legacy `-32601` fallback to `estimateFee`).
   - Cryptographic pre-broadcast self-verification for native Transfer, Wasmi Call, and universal auto-decoded transactions (`verifySignedTransferTxBeforeBroadcast`, `verifySignedCallTxBeforeBroadcast`, `verifyAnySignedTxBeforeBroadcast`).
   - PRO-21 address-book checksum & chain-policy guard (`validateAddressBookEntry`), typed contract facade pre-checks (`NameRegistryClient`, `EscrowClient`, `HtlcClient`), and BLAKE3-checksummed air-gap envelopes (`exportAirgapTxEnvelope`, `importAirgapTxEnvelope`).

2. **Desktop Console (`console-desktop`):**
   - Single-POST JSON-RPC 2.0 batch health probe (`probeRpcBatchHealth`) with `X-Kovanica-Network-Tag`, `X-Kovanica-Rpc-Version`, and `X-Kovanica-Chain-Id` extraction and canonical tag verification (`1-f35df34c92001436`, `2-24cdb5fadd98b207`).
   - Operator summaries and health parsers: `formatNodeDoctorSummary`, `parseIndexerHealthSummary`, `parseLightnodeSyncSummary`, and `aggregateClusterReadiness` (`healthy` / `degraded` / `critical`).

3. **Node Supervisor (`node-desktop`):**
   - Stratum & faucet health parsers (`parseStratumHealthSummary`, `parseFaucetHealthSummary`) with draining, zero-worker, rejection-ratio, and balance-floor alarms.
   - Shell-safe operator CLI builders: `buildSnapshotVerifyCommand`, `parseSnapshotVerifyReport`, `buildRpcProbeCommand`, and `buildAirgapEnvelopeDecodeCommand`.
   - Debian 12 `.deb` packaging (`npm run tauri -- build --bundles deb` and `scripts/check-deb.sh`; see [`docs/linux-node-package.md`](docs/linux-node-package.md)).

---

## Local Development & Verification

> [!NOTE]
> `console-desktop` and `desktop` resolve L1 crates/packages from a sibling checkout named `kovanica-l1` (`../../kovanica-l1/...`), and `wallet-web` resolves `kovanica-sdk` from a sibling checkout named `kovanica-sdk` (`../../kovanica-sdk`).

```bash
# wallet-web
cd wallet-web && npm ci && npm run typecheck && npm run lint && npm test && npm run build

# browser-extension (Chrome + Firefox MV3 builds & deterministic store .zip bundles)
cd browser-extension && npm ci && npm run typecheck && npm test && npm run package

# console-desktop
cd console-desktop && npm ci && npm run lint && npm test && npm run build

# node-desktop
cd node-desktop && npm ci && npm run lint && npm test && npm run build
```

---

## KVP & RFC Standards Reference

> The `001`–`008` numbers belong to the companion **`RFC-001`–`RFC-008`** specs (ordered sequentially below); protocol proposals use **`KVP-101`–`KVP-106`** (plus **`KVP-20`** and **`PRO-21`**).

| RFC | KVP | Name | Purpose |
| :--- | :--- | :--- | :--- |
| **`RFC-001`** | `KVP-101` | Multisig Wallets | M-of-N shared custody & spend proposals |
| **`RFC-002`** | `KVP-102` | Native Multi-Asset Tokens | On-chain fungible tokens, balances, transfers & AMM pools |
| **`RFC-003`** | `KVP-103` | Stealth Addresses | Privacy-preserving one-time stealth addresses |
| **`RFC-004`** | `KVP-104` | HTLC Atomic Swaps | Hash Time-Locked Contracts (redeem / refund) |
| **`RFC-005`** | `KVP-105` | Time-Lock Vaults | CLTV / CSV vaults & treasury vesting |
| **`RFC-006`** | — | Fee Floor & Wave B Base Fee | Atoms/byte fee floor + EIP-1559 dynamic base fee |
| **`RFC-007`** | `KVP-106` | Real-World Assets (RWA) & Native NFTs | Institutional RWA (`kvp106:rwa:v1`, allowlist, freeze, coupons) & Native NFTs |
| **`RFC-008`** | — | On-Chain Name Registry | Human-readable name resolution (`NameRegistryClient`; no KVP #) |
| — | **`KVP-20`** | Fungible Contract Token | Standard `approve`/`transfer`/`transfer_from` interface for AMM DEX & bridge tokens |
| — | **`PRO-21`** | Canonical Address Format | 64-char `kvnc…dag` (Ed25519 + 29-bit BLAKE3 checksum) |

---

## Ecosystem Repositories

| Repository | Role |
| :--- | :--- |
| **[BetterCallDzuks/kovanica-l1](https://github.com/BetterCallDzuks/kovanica-l1)** | Rust Layer-1 node, Hybrid PoW + GHOSTDAG consensus, Wasmi runtime, RPC, Stratum, Faucet, Indexer, Lightnode & CLI |
| **[BetterCallDzuks/kovanica-sdk](https://github.com/BetterCallDzuks/kovanica-sdk)** | Official TypeScript SDK (`v0.9.0`) — browser & Node.js client, failover transport, Wave A–D facades, offline codecs & air-gap envelopes |
| **[BetterCallDzuks/kovanica-web](https://github.com/BetterCallDzuks/kovanica-web)** | Public site, BlockDAG Explorer, AMM DEX, RWA Portal, Mining Pool, Faucet, API Reference & Pricing (`kovanica.online`) |
| **[BetterCallDzuks/kovanica-apps](https://github.com/BetterCallDzuks/kovanica-apps)** | Client apps — `wallet-web`, `browser-extension` (MV3), `console-desktop`, `node-desktop`, `desktop`, Android & iOS |
| **[BetterCallDzuks/kovanica-playground](https://github.com/BetterCallDzuks/kovanica-playground)** | Interactive developer RPC console & 4-group `kovanica-sdk v0.9.0` studios |
| **[BetterCallDzuks/Kovanica-Vault](https://github.com/BetterCallDzuks/Kovanica-Vault)** | Interactive Obsidian Vault presentation (Canvases, Bubble Graph, Pitch Deck & Standards Registry) |

Standing PR workflow & agent rules: [`docs/AGENT-RULES.md`](https://github.com/BetterCallDzuks/kovanica-l1/blob/main/docs/AGENT-RULES.md) and [`docs/PLAN-FULL-SCOPE.md`](https://github.com/BetterCallDzuks/kovanica-l1/blob/main/docs/PLAN-FULL-SCOPE.md).
