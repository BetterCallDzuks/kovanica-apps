# kovanica-apps

Client applications for **Kovanica** (KVNC), split out of the L1 monorepo on 2026-11-05.

## HR

Ovdje žive client appovi (Android / iOS / desktop / node-desktop / wallet-web).  
**FFI ostaje u L1:** crate `kovanica-light-ffi` i cijeli Rust workspace ostaju u [KovanicaDAG/kovanica-l1](https://github.com/KovanicaDAG/kovanica-l1).  
Ovaj repo **ne** sadrži consensus, genesis, light-ffi niti server nginx.

Migrirano iz `apps/*` tipa `e98b5e008331056d6bea55014982d4077e745b77` (flatten: svaki app je top-level direktorij).

## EN

Client apps live here (Android / iOS / desktop / node-desktop / wallet-web).  
**FFI stays in L1:** crate `kovanica-light-ffi` and the Rust workspace remain in [KovanicaDAG/kovanica-l1](https://github.com/KovanicaDAG/kovanica-l1).  
This repo does **not** host consensus, genesis, light-ffi, or seed nginx.

Migrated from `apps/*` at tip `e98b5e008331056d6bea55014982d4077e745b77` (flattened: each former `apps/<name>` is a top-level directory).

## Layout

| Directory | Role |
|-----------|------|
| `android` | Light wallet / UniFFI Android app |
| `android-wallet` | Android wallet |
| `android-comms` | Android comms client |
| `android-chain` | Shared Android chain IDs (`1` mainnet, `2` testnet, `3` devnet) |
| `android-node` | Android full-node proof of concept on kovanica testnet (chain ID 2, tag `2-24cdb5fadd98b207`; L1 pin `fecc84cca95b8f0aef5d445999e0e7858e63f326`), with a light-node fallback and a minimal wallet |
| `ios` | iOS light client |
| `desktop` | Desktop Comms shell (Tauri) |
| `console-desktop` | Console desktop wallet & node inspector (Tauri) |
| `node-desktop` | Linux Kovanica Node supervisor (Tauri). External `kovanica-node` binary; no bundled node. |
| `wallet-web` | Web & desktop hybrid wallet (React / TanStack Start; chains `1` mainnet tag `1-f35df34c92001436` read-only, `2` testnet tag `2-24cdb5fadd98b207`, `3` devnet) — see [wallet-web/README.md](wallet-web/README.md) |

Build the native FFI from L1 (`kovanica-light-ffi`) and point `node-desktop` at a `kovanica-node` executable you built yourself. See [node-desktop/README.md](node-desktop/README.md) and [docs/linux-node-package.md](docs/linux-node-package.md) for Debian 12 `.deb` packaging (`npm run tauri -- build --bundles deb` and `scripts/check-deb.sh`).

`console-desktop` and `desktop` resolve L1 crates and packages from a sibling checkout of [KovanicaDAG/kovanica-l1](https://github.com/KovanicaDAG/kovanica-l1) (`../../../kovanica-l1/crates/...` and `../../kovanica-l1/packages/...`). Light-ffi stays in that repo. The local sibling folder must be named `kovanica-l1` (not `kovanica`) for those relative paths.

## Recent Capabilities

- **`wallet-web`**: `kovanica-sdk v0.5.0` RPC failover client, finality tracker, pre-broadcast Call/Transfer/Auto verification, air-gap transaction envelopes (`kvnc-tx:v1:<base64url>`), and mempool fee tiers.
- **`console-desktop`**: Single-POST JSON-RPC 2.0 batch probe with Kovanica identity headers (`X-Kovanica-Network-Tag`, `X-Kovanica-Rpc-Version`, `X-Kovanica-Chain-Id`), node-doctor readiness summary, indexer & lightnode health parsers, and cluster readiness aggregator.
- **`node-desktop`**: Stratum & faucet health parsers and shell-safe CLI command builders for `kovanica snapshot verify`, `kovanica rpc probe`, and `kovanica tx envelope decode`.

## Standing rules

- Branch + PR; no force-push to `main`
- No secrets, `.env`, or private IPs in commits
- Do not reintroduce `kovanica-light-ffi` into this repo

Agent rules and the full-scope plan: [docs/AGENT-RULES.md](https://github.com/KovanicaDAG/kovanica-l1/blob/main/docs/AGENT-RULES.md) and [docs/PLAN-FULL-SCOPE.md](https://github.com/KovanicaDAG/kovanica-l1/blob/main/docs/PLAN-FULL-SCOPE.md) in KovanicaDAG/kovanica-l1.

## Source

- L1: https://github.com/KovanicaDAG/kovanica-l1
- Decision: Toni 2026-11-05 — create `kovanica-apps`; move `apps/*`; light-ffi stays in L1
