# kovanica-apps

Client applications for **Kovanica** (KVNC), split out of the L1 monorepo on 2026-11-05.

## HR

Ovdje žive client appovi (Android / iOS / desktop / node-desktop / wallet-web).  
**FFI ostaje u L1:** crate `kovanica-light-ffi` i cijeli Rust workspace ostaju u [KovanicaDAG/kovanica](https://github.com/KovanicaDAG/kovanica).  
Ovaj repo **ne** sadrži consensus, genesis, light-ffi niti server nginx.

Migrirano iz `apps/*` tipa `e98b5e008331056d6bea55014982d4077e745b77` (flatten: svaki app je top-level direktorij).

## EN

Client apps live here (Android / iOS / desktop / node-desktop / wallet-web).  
**FFI stays in L1:** crate `kovanica-light-ffi` and the Rust workspace remain in [KovanicaDAG/kovanica](https://github.com/KovanicaDAG/kovanica).  
This repo does **not** host consensus, genesis, light-ffi, or seed nginx.

Migrated from `apps/*` at tip `e98b5e008331056d6bea55014982d4077e745b77` (flattened: each former `apps/<name>` is a top-level directory).

## Layout

| Directory | Role |
|-----------|------|
| `android` | Light wallet / UniFFI Android app |
| `android-wallet` | Android wallet |
| `android-comms` | Android comms client |
| `android-chain` | Shared Android chain IDs |
| `android-node` | Android full-node proof of concept on kovanica testnet, with a light-node fallback and a minimal wallet |
| `ios` | iOS light client |
| `desktop` | Desktop Comms shell (Tauri) |
| `console-desktop` | Console desktop wallet & node inspector (Tauri) |
| `node-desktop` | Linux Kovanica Node supervisor (Tauri). External `kovanica-node` binary; no bundled node. |
| `wallet-web` | Web & desktop hybrid wallet (React / TanStack Start) |

Build the native FFI from L1 (`kovanica-light-ffi`) and point `node-desktop` at a `kovanica-node` executable you built yourself. See [node-desktop/README.md](node-desktop/README.md) and [docs/linux-node-package.md](docs/linux-node-package.md) for Debian 12 `.deb` packaging (`npm run tauri -- build --bundles deb` and `scripts/check-deb.sh`).

`console-desktop` and `desktop` resolve L1 crates and packages via relative sibling paths (`../../../kovanica/crates/...` and `../../kovanica/packages/...`).

## Standing rules

- Branch + PR; no force-push to `main`
- No secrets, `.env`, or private IPs in commits
- Do not reintroduce `kovanica-light-ffi` into this repo

## Source

- L1: https://github.com/KovanicaDAG/kovanica
- Decision: Toni 2026-11-05 — create `kovanica-apps`; move `apps/*`; light-ffi stays in L1
