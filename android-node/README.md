# Kovanica Node (Android proof of concept)

Android app `online.kovanica.node.android` ("Kovanica Node"). It tries to run a full node on **kovanica testnet** (chain ID 2) on the device: outbound P2P, full header validation, and local chain storage. A minimal KVNC wallet can show a receive address and sign a send. Mining is not part of this app.

The native code is built in CI from [KovanicaDAG/kovanica](https://github.com/KovanicaDAG/kovanica) at `6fba95d0d66027c0d4e257a8960e1a12758a45bd`. This repository does not vendor that Rust workspace.

## Full node

The full node is the `kovanica-node` executable, packaged as `libkovanica_node.so` and started from the app by a foreground service ("Full node is running on this device"). The app talks to it only at `http://127.0.0.1:8545`.

The generated config sets:

- `chain_id` 2 (kovanica testnet)
- `data_dir` under app-private storage
- `listen_addr` `127.0.0.1:8000` (the L1 default at this pin is `0.0.0.0:8000`; the app overrides it so the inbound listener is not reachable off the device)
- `rpc_addr` `127.0.0.1` and `rpc_port` 8545
- `run_validator` false
- `[mining] enabled` false
- `bootnodes` only `seed1.kovanica.online:8000`
- `dns_seeds` left empty
- `emission_policy` `no-stake-82m`

Official kovanica testnet genesis files from that L1 pin are copied into the data directory on first start (`genesis_validators.toml`, `funded_accounts.toml`, `founder_premine.hex`). No validator key is shipped. The process environment strips every `KOVANICA_*` variable, so no write token is injected.

L1 docs at this pin also name further seed hosts. Those hosts are dropped. The app never dials an IP literal.

## Light node (fallback)

If the full node cannot be used, the screen says `Light node (fallback): <reason>` and can sync the pruned profile from `libkovanica_light_ffi.so` (`default_mobile_node_config`, then `sync_mobile_node_peer` against the saved RPC URL).

Preflight, before the process starts:

- at least 512 MiB free in app storage
- at least 1536 MiB total RAM
- ABI `arm64-v8a` or `x86_64`
- `libkovanica_node.so` present in the build
- fewer than 3 recent full-node failures

After start, the process must answer `/health` within 25 seconds (HTTP 200 or 503) and report a peer within 60 seconds. Any miss switches to light mode, stores the reason, and increments the failure count. **Retry full node** clears that count and tries again. **Stop** stops the service and the light sync.

Sync status on both modes: `syncing` when `/health` is 200 and `catchingUp` is true, `synced` when `/health` is 200 and the node is not catching up, `stalled` when `/health` is 503, `unavailable` otherwise.

## Chain guard

The app reads `chain_id` from the node and compares it with the config. It allows kovanica testnet (chain ID 2), kovanica devnet (chain ID 3), and local (chain ID 1337). It refuses kovanica mainnet (chain ID 1) and every other id, including 4 and 5, with a screen that does not relabel them. This build always configures kovanica testnet.

## Wallet

Create or import uses the light FFI HD wallet (24 words). The keystore JSON and the passphrase that encrypts it are sealed with Android Keystore (AES-GCM). The recovery words are not stored. **Show recovery words** is the only way to see them, and only after an explicit tap.

Send asks for a recipient and an amount, shows the network name, the amount, and the fee (estimate from `kovanica_estimateFee` when the node answers, otherwise 1 atom per byte times 193 bytes), then signs. If the RPC rejects the write (`kovanica_sendRawTransaction` needs a bearer on this L1 pin), the app shows: "The transaction is signed. Submission requires a write-enabled RPC." No token is embedded or requested.

## Pointing the light client at a node

The **Fallback RPC URL** field defaults to `https://rpc-testnet.kovanica.online`. Save replaces it. Light sync and the light-mode balance and header checks use that origin: the app posts JSON-RPC to `<origin>/rpc` and reads `<origin>/health`. Full mode ignores the field and uses the loopback RPC.

## Build

From `android-node/`:

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Unit tests do not need the native libraries. CI (`.github/workflows/android-node.yml`) checks out L1 at the pin above, cross-compiles `kovanica-node` and `libkovanica_light_ffi.so` for `arm64-v8a` and `x86_64`, strips unneeded symbols, then runs those Gradle tasks and writes the debug APK name, size, and SHA-256 to the job summary. The APK is not uploaded and is not signed for release. A local debug arm64 build of the node was 374 MiB before strip and 23 MiB after; CI ships the stripped release build.

## Known limits

- `sync_mobile_node_peer` in the pinned light library opens a cleartext TCP socket and only strips an `http://` prefix (`crates/kovanica-light-ffi/src/lib.rs` around the `http_json_rpc` helper). It cannot speak TLS. The default public RPC is HTTPS, so the status screen (height, tip, peers, balance) uses the app's own HTTPS client, and pruned block ingest does not run against that URL. An `http://` RPC, including the on-device node at `http://127.0.0.1:8545`, can be used for pruned sync. Fixing TLS would be an L1 change; this repo does not patch it.
- On 2026-11-15 the public RPC answered `/health` with HTTP 503 (`degraded`, commit stall) and `kovanica_getBlockHeaderByNumber` / `kovanica_getBlockByNumber` / `kovanica_getBlockByHash` with a null result, so there was no header to pass to `verify_pow_header_json`. `kovanica_sendRawTransaction` without a bearer returned HTTP 401, message "Unauthorized: authentication required for write method".
- The full node has to cross-compile and stay within device RAM. If it does not, the app stays on the light profile and the reason is on screen. A failure that needs an L1 change is not patched here.
- Header checks call `verify_pow_header_json` from the pinned FFI (the header format that carries a payout address). A rejection is shown as returned. L1 is not patched.
- Write submission on the public RPC and on the local node stays auth-gated. This app does not disable that.
- The inbound P2P port is loopback only. Outbound dials use the seed1 DNS name.
- There is no mining, payout-address, stake, validator, bond, delegate, or reward UI.
- Emulator measurements are indicative. A physical device run is still required before treating RAM, heat, or battery as device truth. The emulator does not report battery drain.
