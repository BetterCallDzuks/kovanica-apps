# Android UniFFI & JNI FFI Audit (`android-node` & `android-wallet`)

Audit and synchronization record for `kovanica-apps/android-node` and `kovanica-apps/android-wallet` native bindings against the authoritative Rust FFI crates in `kovanica-l1`:

- **JNI crate**: `kovanica-l1/crates/kovanica-ffi/src/lib.rs` (`libkovanica_ffi.so`)
- **UniFFI crate**: `kovanica-l1/crates/kovanica-light-ffi/src/lib.rs` (`libkovanica_light_ffi.so`, scaffolding namespace `kovanica_light`)
- **Synced from `kovanica-l1` commit**: `1e46c32`

---

## Executive Summary

| Component | Target Crate | Exported Surface | Status | Verification |
|---|---|---|---|---|
| `android-node` JNI (`NativeBridge.kt` + `jniLibs/{arm64-v8a,x86_64}/libkovanica_ffi.so`) | `kovanica-ffi` | 4 JNI methods | **Matched (4/4)** | All 4 JNI symbols present in both ABIs (`kovanica-ffi` in L1 is a raw JNI state-holder, not a UniFFI crate). |
| `android-node` UniFFI (`uniffi/kovanica_light/kovanica_light.kt` + `jniLibs/{arm64-v8a,x86_64}/libkovanica_light_ffi.so`) | `kovanica-light-ffi` | 48 functions, 16 Records, 1 Error | **Synced (48/48, `.so` Bundled)** | Both `arm64-v8a` (4,107,832 bytes) and `x86_64` (4,830,960 bytes) stripped, 16 KB ELF LOAD-aligned (`0x4000`), 48/48 fn + 48/48 checksum symbols verified; `./gradlew testDebugUnitTest` passed. |
| `android-wallet` UniFFI (`uniffi/kovanica_light/kovanica_light.kt` + `jniLibs/arm64-v8a/libkovanica_light_ffi.so`) | `kovanica-light-ffi` | 48 functions, 16 Records, 1 Error | **Synced (48/48)** | `arm64-v8a` (4,107,832 bytes) rebuilt & stripped, 16 KB ELF LOAD-aligned (`0x4000`), `kovanica_light.kt` byte-identical to `android-node`, 48/48 fn + 48/48 checksum symbols verified; `./gradlew checkNativeSymbols testDebugUnitTest` passed. |

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

## 3. UniFFI Functions & Native Library Sync Status (48/48 Exports)

Both previously identified gaps have been resolved:

1. **`android-wallet` drift resolved**:
   - Rebuilt `android-wallet/app/src/main/jniLibs/arm64-v8a/libkovanica_light_ffi.so` from `kovanica-l1` (`1e46c32`) with Android NDK r27b and 16 KB page alignment (`-Wl,-z,max-page-size=16384`).
   - Regenerated `android-wallet/app/src/main/java/uniffi/kovanica_light/kovanica_light.kt` using `cargo run -p kovanica-light-ffi --features bindgen --bin kovanica-light-bindgen`.
   - `resolve_dns_seed_peers` (`resolveDnsSeedPeers`, checksum `53908`) and all 4 previously drifted checksums (`contract_address_for_raw`, `faucet_allowed`, `mine_pow_block_header`, `sign_call_raw`) are now aligned with `kovanica-l1`.
   - Verified via `./gradlew checkNativeSymbols testDebugUnitTest --no-daemon` (JDK 17): **BUILD SUCCESSFUL**.

2. **`android-node` native library packaging resolved**:
   - Bundled stripped 16 KB-aligned `libkovanica_light_ffi.so` for both `arm64-v8a` and `x86_64` under `android-node/app/src/main/jniLibs/`.
   - Synced `android-node/app/src/main/java/uniffi/kovanica_light/kovanica_light.kt` (byte-identical to `android-wallet`).
   - Verified via `./gradlew testDebugUnitTest --no-daemon` (JDK 17): **BUILD SUCCESSFUL**.

3. **Android CI workflow repository references fixed**:
   - Updated stale `KovanicaDAG/kovanica-l1` checkout references to `KovanicaProtokol/kovanica-l1` in:
     - `.github/workflows/android-ci.yml`
     - `.github/workflows/android-node.yml`
     - `.github/workflows/android-release.yml`

---

## 4. Turnkey Regeneration & Verification Script

Use `scripts/sync-android-uniffi.sh` whenever `kovanica-l1/crates/kovanica-light-ffi` changes:

```bash
./scripts/sync-android-uniffi.sh
```

The script automatically:
1. Locates the Android NDK (`ANDROID_NDK_HOME`, `~/android-ndk-r27b`, or `~/Android/Sdk/ndk/*`).
2. Cross-compiles `kovanica-light-ffi` (`--release`) for `aarch64-linux-android` (`arm64-v8a`) and `x86_64-linux-android` (`x86_64`) with `-C link-arg=-Wl,-z,max-page-size=16384`.
3. Installs and `llvm-strip --strip-unneeded` strips `libkovanica_light_ffi.so` into `android-wallet` (`arm64-v8a`) and `android-node` (`arm64-v8a`, `x86_64`).
4. Runs `kovanica-light-bindgen` (`--features bindgen`) to regenerate `kovanica_light.kt` and copies it identically to both Android apps.
5. Verifies Kotlin parity (`cmp -s`), 48/48 exported `uniffi_kovanica_light_ffi_fn_func_*` and `uniffi_kovanica_light_ffi_checksum_func_*` symbols (`llvm-nm -D`), and 16 KB ELF LOAD alignment (`llvm-readelf -lW`).

To run Gradle checks locally (using JDK 17):

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=~/android-sdk
(cd android-wallet && ./gradlew checkNativeSymbols testDebugUnitTest --no-daemon)
(cd android-node && ./gradlew testDebugUnitTest --no-daemon)
```
