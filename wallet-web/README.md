# `@kovanica/wallet-web`

Web and desktop hybrid wallet for **Kovanica (KVNC)**, built with React 19, TanStack Start / Router, Vite, Tailwind CSS, and optional Tauri desktop bindings.

- **Package**: `@kovanica/wallet-web` (`v0.2.0`)
- **Supported networks**:
  - Chain `1` — Mainnet (tag `1-f35df34c92001436`, read-only)
  - Chain `2` — Testnet (tag `2-24cdb5fadd98b207`)
  - Chain `3` — Devnet
- **SDK integration**: Integrates `kovanica-sdk` **`v0.5.0`** (referenced via `"kovanica-sdk": "file:../../kovanica-sdk"` in `package.json`) for failover JSON-RPC transport, endpoint probing, transaction finality watching, fee buffering and mempool fee tiers, offline Ed25519 pre-broadcast self-verification, PRO-21 address inspection, typed contract facades, dry-run call simulation, receipt log decoding, and air-gapped transaction envelopes.

---

## Development & Verification

Ensure a sibling checkout of `kovanica-sdk` is available at `../../kovanica-sdk` (built so its exports resolve), then install dependencies:

```bash
npm install
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local Vite dev server on `0.0.0.0:8080` (`node scripts/with-app-env.mjs vite dev --host 0.0.0.0 --port 8080`) |
| `npm run typecheck` | Run TypeScript typechecking (`tsc --noEmit`) |
| `npm run lint` | Run ESLint across the workspace (`eslint .`) |
| `npm test` | Run the Node/TSX unit test suite (`npx tsx --test ...`) across `src/core/*.test.ts` and `src/lib/**/*.test.ts` |
| `npm run build` | Build production bundle and run DB migrations (`vite build && npm run db:migrate`) |
| `npm run build:dev` | Build in development mode |
| `npm run preview` | Preview the production build (`vite preview`) |
| `npm run check:auth` | Verify authentication gate invariants (`node scripts/check-auth-invariant.mjs`) |
| `npm run format` | Format files with Prettier (`prettier --write .`) |

---

## Implemented Core Capabilities

Core wallet primitives live in `src/core/` and wrap `kovanica-sdk v0.5.0` with fail-closed validation, UI-ready formatting, and structured result types.

### 1. Multi-RPC Failover & Header-Aware Endpoint Probing (`src/core/finality.ts`)

- **`normalizeFailoverRpcUrls(primaryUrl, backupUrls?)`**: Filters candidate RPC URLs to valid `http:` / `https:` endpoints, deduplicates in order, preserves raw URLs for transport, and produces credential-sanitized endpoints (`sanitizeRpcUrl`) safe for UI display and logging.
- **`createWalletFailoverClient(primaryUrl, backupUrls?, options?)`**: Instantiates a multi-RPC failover `KovanicaClient` backed by `kovanica-sdk`'s `createFailoverClient` (`FailoverHttpTransport` + retry config) and returns `{ client, endpoints }`.
- **`probeWalletRpcEndpoint(url, expectedChainId?, fetchImpl?)`**: Probes an RPC endpoint via `probeRpcNode` for JSON-RPC batch support, chain metadata, and canonical Kovanica identity headers (`X-Kovanica-Network-Tag`).

### 2. Live Transaction Finality Tracking & Buffered Fee Estimation (`src/core/finality.ts`)

- **`watchSubmittedTxFinality(rpcUrls, txHash, options?)`**: Tracks a submitted transaction across one or more failover RPC URLs via `waitForTransactionFinality` until it reaches the requested confirmation target (`DEFAULT_FINALITY_CONFIRMATIONS`), supporting progress callbacks, timeouts, and `AbortSignal`.
- **`formatFinalityProgressBadge(progress)`**: Formats SDK `FinalityProgress` snapshots into UI badge descriptors (`{ label, tone, confirmationsText }` with tones `"pending" | "included" | "finalized"`).
- **`computeBufferedTxFee(baseFee, safetyMultiplierBps?)`**: Computes a ceiling-rounded safety-buffered transaction fee via `applyFeeBuffer` (`DEFAULT_FEE_BUFFER_MULTIPLIER_BPS`).
- **`fetchWalletFeeTiers(client, options?)`**: Fetches live mempool fee-tier recommendations (`economy`, `standard`, `priority`) using `client.getMempoolStats()` and `computeFeeRecommendations`. Gracefully falls back to `client.estimateFee()` when `getMempoolStats()` fails (for example, legacy nodes returning `-32601 Method not found`) or when the mempool is empty (`p50FeePerByte === null`), returning monotonic `economy <= standard <= priority` tiers with `source: "fallback"`.

### 3. Cryptographic Pre-Broadcast Self-Verification (`src/core/finality.ts`)

All pre-broadcast verifiers decode raw signed transactions offline and **fail closed** on any decode error, invalid public key, signature verification failure, sender mismatch, or target mismatch:

- **`verifySignedCallTxBeforeBroadcast(rawTxHex, expectedPublicKey, options?)`**: Decodes a signed contract Call transaction (`decodeSignedCallTransaction`) and verifies its Ed25519 signature (`verifyCallTransactionSignature`), sender public key binding, optional `chainId`, and optional `expectedContract`.
- **`verifySignedTransferTxBeforeBroadcast(rawTxHex, expectedPublicKey, options?)`**: Decodes a signed native Transfer transaction (`decodeSignedTransferTransaction`) and verifies its Ed25519 signature (`verifyTransferTransactionSignature`), sender public key binding, optional `chainId`, optional `expectedRecipient`, and optional `expectedAmount`.
- **`verifyAnySignedTxBeforeBroadcast(rawTxHex, expectedPublicKey, options?)`**: Auto-detects and decodes any supported signed transaction variant (Transfer or Call) via `decodeSignedTransactionAuto`, verifying its Ed25519 signature (`verifySignedTransactionAuto`) and sender binding prior to broadcast.

### 4. PRO-21 Address-Book Checksum & Chain-Policy Guard (`src/core/finality.ts`)

- **`validateAddressBookEntry(address, chainId)`**: Validates address-book entries against PRO-21 checksum and per-chain policy rules using `inspectAddress`. Fails closed whenever `inspection.valid === false` or `inspection.chainAllowed !== true`, and returns the canonical mainnet or testnet address on success.

### 5. Typed Contract Facade Read-Before-Write Pre-Checks & Call Estimation (`src/core/call-estimate.ts`)

- **`precheckContractEntityAvailability(client, query, options?)`**: Performs typed read-before-write on-chain state pre-checks using `kovanica-sdk` contract facades so the UI can warn before submitting transactions that would revert:
  - **`NameRegistryClient`** (`family: "name"`) — checks existing name registration, owner preview, and relay endpoint count.
  - **`EscrowClient`** (`family: "escrow"`) — inspects escrow status, amount, approval threshold progress, parties, and deadline.
  - **`HtlcClient`** (`family: "htlc"`) — inspects HTLC status, amount, expiry, and claim/refund state.
- **Call estimation, simulation, and receipt decoding**:
  - `computeCallWireSize`, `estimateContractCallPreview`, `estimateContractCallBatchPreview`, `formatCallEstimateSummary`, `formatBatchCallEstimateSummary`, `formatSafetyMarginPercent` (default `+20%` via `DEFAULT_FEE_SAFETY_MARGIN_BPS`).
  - `simulateContractCallBeforeSign` (`dryRunCall` / `kovanica_call` pre-sign revert detection).
  - `trackSubmittedContractReceipt`, `inferContractLogKind`, `formatReceiptTrackingSummary` (`waitForTransactionReceipt` + `decodeTransactionReceiptLogs`).

### 6. Air-Gapped Transaction Envelopes (`src/core/finality.ts`)

- **`exportAirgapTxEnvelope(input)`**: Encodes a signed transaction into a network-tag-pinned, BLAKE3-checksummed air-gap envelope (`kvnc-tx:v1:<base64url(JSON)>`) via `encodeAirgapTxEnvelope`. Never throws; returns `{ ok: true, envelope, encoded }` or `{ ok: false, error }`.
- **`importAirgapTxEnvelope(encodedOrJson, expectedChainId)`**: Decodes and verifies a compact `kvnc-tx:v1:...` string or raw JSON air-gap envelope against `expectedChainId` via `decodeAirgapTxEnvelope`. Never throws; returns `{ ok: true, envelope }` or `{ ok: false, error }`.
