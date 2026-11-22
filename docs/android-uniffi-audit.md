# Android UniFFI & JNI FFI Audit (`android-node` & `android-wallet`)

Audit of `kovanica-apps/android-node` and `kovanica-apps/android-wallet` native bindings against the authoritative Rust FFI crates in `kovanica-l1`:

- **JNI crate**: `kovanica-l1/crates/kovanica-ffi/src/lib.rs` (`libkovanica_ffi.so`)
- **UniFFI crate**: `kovanica-l1/crates/kovanica-light-ffi/src/lib.rs` (`libkovanica_light_ffi.so`, scaffolding namespace `kovanica_light`)

---

## Executive Summary

| Component | Target Crate | Exported Surface | Status | Action Required |
|---|---|---|---|---|
| `android-node` JNI (`NativeBridge.kt` + `jniLibs/{arm64-v8a,x86_64}/libkovanica_ffi.so`) | `kovanica-ffi` | 4 JNI methods | **Matched (4/4)** | None (all 4 JNI symbols present in both ABIs; note `kovanica-ffi` in L1 is currently a stub state-holder, not a UniFFI crate). |
| `android-node` UniFFI (`uniffi/kovanica_light/kovanica_light.kt` + `LightFfiBridge.kt`) | `kovanica-light-ffi` | 48 functions, 16 Records, 1 Error | **Bindings Matched (48/48); `.so` Missing** | `kovanica_light.kt` matches L1 100%, but `libkovanica_light_ffi.so` is **not packaged** in `android-node/app/src/main/jniLibs/`. `FfiInstall.install()` catches `UnsatisfiedLinkError` and falls back to `"native library is not packaged"`. Build & bundle `libkovanica_light_ffi.so` for `arm64-v8a` and `x86_64`. |
| `android-wallet` UniFFI (`uniffi/kovanica_light/kovanica_light.kt` + `jniLibs/arm64-v8a/libkovanica_light_ffi.so`) | `kovanica-light-ffi` | 47 / 48 functions, 16 Records, 1 Error | **Stale Drift (1 missing fn, 4 checksum diffs)** | Internally consistent (`.kt` matches its bundled `.so`), so **do not** edit `.kt` alone. Regenerate both `libkovanica_light_ffi.so` (`cargo ndk`) and `kovanica_light.kt` (`uniffi-bindgen`) together from current `kovanica-l1`. |

---

## 1. JNI Audit: `kovanica-ffi` vs `android-node`

`kovanica-l1/crates/kovanica-ffi/src/lib.rs` exports 4 raw JNI functions (it does **not** use UniFFI):

| Rust JNI Export (`kovanica-ffi`) | Kotlin `NativeBridge.kt` Declaration | `arm64-v8a/libkovanica_ffi.so` | `x86_64/libkovanica_ffi.so` | Match |
|---|---|---|---|---|
| `Java_online_kovanica_node_NativeBridge_nodeStart(JString) -> jint` | `@JvmStatic external fun nodeStart(configPath: String): Int` | Present | Present | Exact |
| `Java_online_kovanica_node_NativeBridge_nodeStop() -> jint` | `@JvmStatic external fun nodeStop(): Int` | Present | Present | Exact |
| `Java_online_kovanica_node_NativeBridge_nodeStatus() -> jstring` | `@JvmStatic external fun nodeStatus(): String` | Present | Present | Exact |
| `Java_online_kovanica_node_NativeBridge_nodeSyncProgress() -> jstring` | `@JvmStatic external fun nodeSyncProgress(): String` | Present | Present | Exact |

No JNI drift found.

---

## 2. UniFFI Types Audit: `kovanica-light-ffi` vs `android-node` & `android-wallet`

All **17** UniFFI types (1 `#[derive(uniffi::Error)]` and 16 `#[derive(uniffi::Record)]`) match in field names, order, and Kotlin types across both `android-node` and `android-wallet`:

| Type | Kind | Fields | `android-node` | `android-wallet` |
|---|---|---|---|---|
| `LightFfiError` (`LightFfiException.Failed`) | Error | `reason: String` | Exact | Exact |
| `CreatedWallet` | Record | `address`, `mnemonic`, `keystoreJson` | Exact | Exact |
| `ImportedWallet` | Record | `address`, `keystoreJson` | Exact | Exact |
| `VerifiedHeader` | Record | `committedHeight`, `headerHash`, `leaderDigest`, `stateRoot`, `epoch` | Exact | Exact |
| `AccountSnapshot` | Record | `balance`, `nonce`, `verified` | Exact | Exact |
| `VerifiedPowHeader` | Record | `chainId`, `round`, `preimageDigest`, `powHash`, `work` | Exact | Exact |
| `MobileNodeProfile` | Record | `chainId`, `ghostdagK`, `targetBlockMs`, `pruningWindowRounds`, `maxRedbCacheMb`, `maxPeers`, `wifiAndChargingOnly`, `localRpcBind` | Exact | Exact |
| `PrunedStorageSummary` | Record | `prunedBlocks`, `prunedDagBlocks`, `pruned` | Exact | Exact |
| `LocalStorageStats` | Record | `tipRound`, `totalBlocks`, `totalDagBlocks`, `sizeBytes` | Exact | Exact |
| `LocalAccountInfo` | Record | `balance`, `nonce`, `found` | Exact | Exact |
| `BatchSyncResult` | Record | `syncedCount`, `highestRound`, `totalWork`, `rejectedCount` | Exact | Exact |
| `P2pSyncResult` | Record | `success`, `syncedBlocks`, `newTipRound`, `peer`, `error` | Exact | Exact |
| `P2pPeerStatus` | Record | `peerAddress`, `isConnected`, `tipRound`, `chainId` | Exact | Exact |
| `LocalExecutionReceipt` | Record | `txHash`, `success`, `gasUsed`, `error` | Exact | Exact |
| `BlockExecutionSummary` | Record | `round`, `txCount`, `successCount`, `failedCount`, `totalGasUsed`, `receipts` | Exact | Exact |
| `LocalSimulationResult` | Record | `success`, `returnDataHex`, `gasUsed`, `error` | Exact | Exact |
| `MinedPowResult` | Record | `found`, `nonce`, `powHash`, `hashesComputed`, `headerJson`, `work` | Exact | Exact |

---

## 3. UniFFI Functions Audit (48 Exports)

### Drift Findings in `android-wallet`

1. **Missing exported function (1 of 48)**:
   - Rust: `resolve_dns_seed_peers(dns_seed_host: String, default_port: u16) -> Result<Vec<String>, LightFfiError>`
   - `android-node/app/src/main/java/uniffi/kovanica_light/kovanica_light.kt`: **Present** (`resolveDnsSeedPeers`, `FfiConverterSequenceString`, checksum `53908`).
   - `android-wallet/app/src/main/java/uniffi/kovanica_light/kovanica_light.kt`: **Missing**.
   - `android-wallet/app/src/main/jniLibs/arm64-v8a/libkovanica_light_ffi.so`: **Missing** (`nm -D` reports 47 `uniffi_kovanica_light_ffi_fn_func_*` symbols).

2. **UniFFI API Checksum Drift (4 functions)** between `android-wallet` (older build) and `android-node` (current L1):

   | Function | `android-wallet` Checksum | `android-node` (Current L1) Checksum |
   |---|---|---|
   | `contract_address_for_raw` | `59815` | `58109` |
   | `faucet_allowed` | `22913` | `59470` |
   | `mine_pow_block_header` | `27244` | `39482` |
   | `sign_call_raw` | `38764` | `42135` |

   *(Cause: doc-comment / metadata updates in `kovanica-light-ffi` change UniFFI's per-function API checksums even when parameter types stay identical.)*

3. **Why `android-wallet`'s `kovanica_light.kt` was NOT patched in place**:
   - `android-wallet/app/build.gradle.kts` (`checkNativeSymbols`) and `NativeLibrarySymbolsTest.kt` enforce that every `uniffi_kovanica_light_ffi_*` symbol referenced in `kovanica_light.kt` exists in `app/src/main/jniLibs/arm64-v8a/libkovanica_light_ffi.so`, and UniFFI validates all 48 API checksums at runtime on the first JNA call.
   - Updating `kovanica_light.kt` without rebuilding `libkovanica_light_ffi.so` via `cargo ndk` would immediately break `checkNativeSymbols`, `NativeLibrarySymbolsTest`, and app launch with `UnsatisfiedLinkError` / checksum mismatch.

### Packaging Finding in `android-node`

- `android-node/app/src/main/java/uniffi/kovanica_light/kovanica_light.kt` matches all 48 functions and 17 types of current `kovanica-l1/crates/kovanica-light-ffi`, and `LightFfiBridge.kt` calls 7 of them (`createHdWallet`, `importHdWallet`, `revealMnemonicRaw`, `signTransferHd`, `verifyPowHeaderJson`, `defaultMobileNodeConfig`, `syncMobileNodePeer`) with exact matching signatures.
- However, `android-node/app/src/main/jniLibs/` contains **only** `libkovanica_ffi.so` (`arm64-v8a` and `x86_64`) and **does not** contain `libkovanica_light_ffi.so`. Until `libkovanica_light_ffi.so` is compiled and packaged into `android-node/app/src/main/jniLibs/{arm64-v8a,x86_64}/`, `FfiInstall.install()` will leave `NativeBridge.impl = null`.

---

## 4. Recommended Regeneration Commands (from `kovanica-l1`)

To synchronize both Android apps with current `kovanica-l1`:

```bash
# 1. Build libkovanica_light_ffi.so for Android ABIs (with 16 KB page alignment)
cargo ndk -t arm64-v8a -o ../kovanica-apps/android-wallet/app/src/main/jniLibs \
  build -p kovanica-light-ffi --release

cargo ndk -t arm64-v8a -t x86_64 -o ../kovanica-apps/android-node/app/src/main/jniLibs \
  build -p kovanica-light-ffi --release

# 2. Regenerate Kotlin UniFFI bindings from the newly built library
cargo run -p kovanica-light-ffi --bin uniffi-bindgen -- generate \
  --library target/aarch64-linux-android/release/libkovanica_light_ffi.so \
  --language kotlin \
  --out-dir ../kovanica-apps/android-wallet/app/src/main/java

cp ../kovanica-apps/android-wallet/app/src/main/java/uniffi/kovanica_light/kovanica_light.kt \
   ../kovanica-apps/android-node/app/src/main/java/uniffi/kovanica_light/kovanica_light.kt
```
