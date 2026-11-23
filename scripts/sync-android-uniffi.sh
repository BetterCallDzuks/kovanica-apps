#!/usr/bin/env bash
set -euo pipefail

# Turnkey Android UniFFI & native library sync script for kovanica-apps.
# Cross-compiles libkovanica_light_ffi.so from kovanica-l1 (16 KB aligned),
# regenerates Kotlin UniFFI bindings via kovanica-light-bindgen, installs
# into android-wallet and android-node, and verifies symbols + alignment.
#
# Usage:
#   ./scripts/sync-android-uniffi.sh [--l1-dir /path/to/kovanica-l1] [--skip-build]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
L1_DIR="${KOVANICA_L1_DIR:-${APPS_DIR}/../kovanica-l1}"
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --l1-dir)
      L1_DIR="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

L1_DIR="$(cd "${L1_DIR}" && pwd)"

if [[ ! -f "${L1_DIR}/crates/kovanica-light-ffi/Cargo.toml" ]]; then
  echo "ERROR: kovanica-light-ffi not found under ${L1_DIR}" >&2
  exit 1
fi

# Resolve Android NDK
resolve_ndk() {
  if [[ -n "${ANDROID_NDK_HOME:-}" && -d "${ANDROID_NDK_HOME}" ]]; then
    echo "${ANDROID_NDK_HOME}"
    return 0
  fi
  for candidate in \
    "${HOME}/android-ndk-r27b" \
    "${HOME}"/android-ndk-r* \
    "${HOME}/Android/Sdk/ndk"/* \
    "${ANDROID_HOME:-/nonexistent}/ndk"/*; do
    if [[ -d "${candidate}/toolchains/llvm/prebuilt/linux-x86_64" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

NDK_DIR="$(resolve_ndk)" || {
  echo "ERROR: Android NDK not found. Set ANDROID_NDK_HOME (e.g. ~/android-ndk-r27b)." >&2
  exit 1
}

TOOLCHAIN="${NDK_DIR}/toolchains/llvm/prebuilt/linux-x86_64"
LLVM_STRIP="${TOOLCHAIN}/bin/llvm-strip"
LLVM_NM="${TOOLCHAIN}/bin/llvm-nm"
LLVM_READELF="${TOOLCHAIN}/bin/llvm-readelf"

echo "==> Using L1 repo: ${L1_DIR} ($(git -C "${L1_DIR}" rev-parse --short HEAD 2>/dev/null || echo 'unknown'))"
echo "==> Using Android NDK: ${NDK_DIR}"

if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  echo "==> Cross-compiling libkovanica_light_ffi.so (arm64-v8a & x86_64, 16 KB page-aligned)..."
  (
    cd "${L1_DIR}"
    export PATH="${TOOLCHAIN}/bin:${PATH}"
    export CC_aarch64_linux_android="${TOOLCHAIN}/bin/aarch64-linux-android24-clang"
    export AR_aarch64_linux_android="${TOOLCHAIN}/bin/llvm-ar"
    export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="${TOOLCHAIN}/bin/aarch64-linux-android24-clang"
    export CC_x86_64_linux_android="${TOOLCHAIN}/bin/x86_64-linux-android24-clang"
    export AR_x86_64_linux_android="${TOOLCHAIN}/bin/llvm-ar"
    export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="${TOOLCHAIN}/bin/x86_64-linux-android24-clang"
    export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"

    cargo build -p kovanica-light-ffi --release --target aarch64-linux-android
    cargo build -p kovanica-light-ffi --release --target x86_64-linux-android
  )
fi

ARM64_SO="${L1_DIR}/target/aarch64-linux-android/release/libkovanica_light_ffi.so"
X86_64_SO="${L1_DIR}/target/x86_64-linux-android/release/libkovanica_light_ffi.so"

for f in "${ARM64_SO}" "${X86_64_SO}"; do
  if [[ ! -f "${f}" ]]; then
    echo "ERROR: Expected built library missing: ${f}" >&2
    exit 1
  fi
done

echo "==> Installing stripped native libraries into android-wallet and android-node..."
WALLET_ARM64="${APPS_DIR}/android-wallet/app/src/main/jniLibs/arm64-v8a/libkovanica_light_ffi.so"
NODE_ARM64="${APPS_DIR}/android-node/app/src/main/jniLibs/arm64-v8a/libkovanica_light_ffi.so"
NODE_X86_64="${APPS_DIR}/android-node/app/src/main/jniLibs/x86_64/libkovanica_light_ffi.so"

mkdir -p "$(dirname "${WALLET_ARM64}")" "$(dirname "${NODE_ARM64}")" "$(dirname "${NODE_X86_64}")"
cp "${ARM64_SO}" "${WALLET_ARM64}"
cp "${ARM64_SO}" "${NODE_ARM64}"
cp "${X86_64_SO}" "${NODE_X86_64}"

"${LLVM_STRIP}" --strip-unneeded "${WALLET_ARM64}" "${NODE_ARM64}" "${NODE_X86_64}"

echo "==> Regenerating Kotlin UniFFI bindings via kovanica-light-bindgen..."
WALLET_JAVA_DIR="${APPS_DIR}/android-wallet/app/src/main/java"
NODE_KT="${APPS_DIR}/android-node/app/src/main/java/uniffi/kovanica_light/kovanica_light.kt"
WALLET_KT="${WALLET_JAVA_DIR}/uniffi/kovanica_light/kovanica_light.kt"

(
  cd "${L1_DIR}"
  cargo run -p kovanica-light-ffi --features bindgen --bin kovanica-light-bindgen -- generate \
    --library "${ARM64_SO}" \
    --language kotlin \
    --out-dir "${WALLET_JAVA_DIR}"
)

mkdir -p "$(dirname "${NODE_KT}")"
cp "${WALLET_KT}" "${NODE_KT}"

echo "==> Verifying Kotlin bindings parity, exported symbols, and 16 KB alignment..."
cmp -s "${WALLET_KT}" "${NODE_KT}" || {
  echo "ERROR: kovanica_light.kt differs between android-wallet and android-node" >&2
  exit 1
}

python3 - "${WALLET_KT}" "${LLVM_NM}" "${LLVM_READELF}" "${WALLET_ARM64}" "${NODE_ARM64}" "${NODE_X86_64}" <<'PY'
import re
import subprocess
import sys
from pathlib import Path

kt_path = Path(sys.argv[1])
llvm_nm = sys.argv[2]
llvm_readelf = sys.argv[3]
so_paths = [Path(p) for p in sys.argv[4:]]

kt_text = kt_path.read_text(encoding="utf-8")
expected_funcs = sorted(set(re.findall(r"\buniffi_kovanica_light_ffi_fn_func_[A-Za-z0-9_]+\b", kt_text)))
expected_checksums = sorted(set(re.findall(r"\buniffi_kovanica_light_ffi_checksum_func_[A-Za-z0-9_]+\b", kt_text)))

print(f"Kotlin binding references: {len(expected_funcs)} fn symbols, {len(expected_checksums)} checksum symbols")
if len(expected_funcs) == 0 or len(expected_funcs) != len(expected_checksums):
    sys.exit(f"ERROR: Unexpected symbol counts (fn={len(expected_funcs)}, checksum={len(expected_checksums)})")

for so in so_paths:
    nm_out = subprocess.check_output([llvm_nm, "-D", "--defined-only", str(so)], text=True)
    exported = set()
    for line in nm_out.splitlines():
        parts = line.split()
        if parts:
            exported.add(parts[-1])

    missing_fn = [s for s in expected_funcs if s not in exported]
    missing_cs = [s for s in expected_checksums if s not in exported]
    if missing_fn or missing_cs:
        sys.exit(f"ERROR: {so} missing symbols: fn={missing_fn}, checksum={missing_cs}")

    elf_out = subprocess.check_output([llvm_readelf, "-lW", str(so)], text=True)
    load_aligns = []
    for line in elf_out.splitlines():
        if line.strip().startswith("LOAD"):
            align_hex = line.split()[-1]
            load_aligns.append(int(align_hex, 16))
    if not load_aligns or any(a < 16384 for a in load_aligns):
        sys.exit(f"ERROR: {so} has LOAD segment alignment < 16384: {[hex(a) for a in load_aligns]}")

    print(f"OK: {so} ({so.stat().st_size:,} bytes) — {len(expected_funcs)}/{len(expected_funcs)} fn + {len(expected_checksums)}/{len(expected_checksums)} checksum symbols, LOAD align {[hex(a) for a in load_aligns]}")
PY

echo "==> Sync & verification complete!"
