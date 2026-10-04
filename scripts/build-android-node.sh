#!/usr/bin/env bash
# Build the Node.js executable used by the Android host.
#
# This intentionally lives next to (rather than inside) build-termux.sh.  The
# Termux package runs the normal Node executable.  The Android APK puts this
# executable in its nativeLibraryDir (where Android permits execution) and
# invokes it from its foreground service.  The .so filename is intentional:
# Android only extracts native libraries into that executable directory.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

NODE_VERSION="${NODE_VERSION:-24.18.0}"
ANDROID_API="${ANDROID_API:-24}"
ANDROID_ABI="${ANDROID_ABI:-arm64-v8a}"
JOBS="${JOBS:-}"
BUILD_ROOT="${BUILD_ROOT:-$PWD/build/node-android}"
OUTPUT_DIR="${OUTPUT_DIR:-$PWD/dist/node-android}"
NODE_SOURCE_DIR="${NODE_SOURCE_DIR:-$BUILD_ROOT/src/node-v${NODE_VERSION}}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-$BUILD_ROOT/downloads}"

: "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must point to an installed Android NDK}"

case "$ANDROID_ABI" in
  arm64-v8a) NODE_ARCH=arm64; TOOLCHAIN_PREFIX=aarch64-linux-android ;;
  *) echo "unsupported ANDROID_ABI=$ANDROID_ABI (only arm64-v8a is supported)" >&2; exit 2 ;;
esac

if [[ ! "$ANDROID_API" =~ ^[0-9]+$ ]] || (( ANDROID_API < 24 )); then
  echo "ANDROID_API must be an integer >= 24" >&2
  exit 2
fi

if [[ -z "$JOBS" ]]; then
  JOBS="$(nproc 2>/dev/null || printf '2')"
  (( JOBS > 4 )) && JOBS=4
fi

mkdir -p "$DOWNLOAD_DIR" "$OUTPUT_DIR"

archive="$DOWNLOAD_DIR/node-v${NODE_VERSION}.tar.gz"
checksums="$DOWNLOAD_DIR/SHASUMS256.txt"
source_parent="$(dirname -- "$NODE_SOURCE_DIR")"

if [[ ! -s "$archive" ]]; then
  curl -fL --retry 3 --retry-delay 2 \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.tar.gz" \
    -o "$archive"
fi
if [[ ! -s "$checksums" ]]; then
  curl -fL --retry 3 --retry-delay 2 \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    -o "$checksums"
fi

# Verify the source against Node's signed release checksum list before
# extracting it.  Keep this check enabled in CI and local builds alike.
expected="$(awk -v file="node-v${NODE_VERSION}.tar.gz" '$2 == file { print $1; exit }' "$checksums")"
if [[ ! "$expected" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "Node release checksum is missing for $archive" >&2
  exit 1
fi
actual="$(sha256sum "$archive" | awk '{print $1}')"
if [[ "$actual" != "$expected" ]]; then
  echo "Node source checksum mismatch for $archive" >&2
  exit 1
fi

if [[ ! -f "$NODE_SOURCE_DIR/android-configure" ]]; then
  mkdir -p "$source_parent"
  rm -rf "$NODE_SOURCE_DIR"
  tar -xzf "$archive" -C "$source_parent"
  extracted="$source_parent/node-v${NODE_VERSION}"
  if [[ "$extracted" != "$NODE_SOURCE_DIR" ]]; then
    rm -rf "$NODE_SOURCE_DIR"
    mv "$extracted" "$NODE_SOURCE_DIR"
  fi
fi

TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
if [[ ! -x "$TOOLCHAIN/${TOOLCHAIN_PREFIX}${ANDROID_API}-clang" ]]; then
  echo "Android NDK toolchain is missing for API $ANDROID_API: $TOOLCHAIN" >&2
  exit 1
fi

# android-configure is the upstream-supported cross-build entry point, but its
# Python helper mutates only its child process environment.  Export the same
# target settings here so the configure and make processes receive them.
pushd "$NODE_SOURCE_DIR" >/dev/null

# Node's Android configure script selects V8 trap-handler sources using GYP's
# target OS for both toolsets. Extend the host conditions so Linux arm64
# simulator support is linked into mksnapshot; the Android target remains
# trap-handler disabled.
python3 - "tools/v8_gypfiles/v8.gyp" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
replacements = {
    'OS in "linux mac ios freebsd openharmony"':
        'OS in "linux mac ios freebsd openharmony" or (_toolset=="host" and host_os=="linux")',
    '((_toolset=="host" and host_arch=="arm64" or _toolset=="target" and target_arch=="arm64") and (OS in "linux mac ios openharmony")) or ((_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64") and (OS in "linux mac openharmony"))':
        '((_toolset=="host" and host_arch=="arm64" or _toolset=="target" and target_arch=="arm64") and (OS in "linux mac ios openharmony")) or ((_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64") and (OS in "linux mac openharmony")) or (_toolset=="host" and host_os=="linux")',
    '(_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64") and (OS in "linux mac win openharmony")':
        '(_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64") and (OS in "linux mac win openharmony") or (_toolset=="host" and host_os=="linux")',
}
for old, new in replacements.items():
    if new in source:
        continue
    if old in source:
        source = source.replace(old, new)
    else:
        raise SystemExit(f"V8 GYP trap-handler condition not found: {old[:70]}")
path.write_text(source)
PY

# The NDK no longer ships the old cpufeatures archive as a linkable library,
# while Node's bundled zlib still calls android_getCpuFeatures(). Android
# exposes the same ARM64 capability bits through getauxval instead.
python3 "$SCRIPT_DIR/patch-android-zlib.py" "$NODE_SOURCE_DIR/deps/zlib/cpu_features.c"
export PATH="$TOOLCHAIN:$PATH"
export CC="$TOOLCHAIN/${TOOLCHAIN_PREFIX}${ANDROID_API}-clang"
export CXX="$TOOLCHAIN/${TOOLCHAIN_PREFIX}${ANDROID_API}-clang++"
# Cross builds also compile host-side generators (Torque, ICU tools, etc.).
# Keep those on the executor's native compiler; inheriting the target CXX makes
# the host tools Android binaries and fails as soon as a POSIX-only header is
# used.
export CC_host="${CC_host:-cc}"
export CXX_host="${CXX_host:-c++}"
export LINK_host="${LINK_host:-$CXX_host}"
# Keep the GYP target OS as Android; the host_os conditions above add the
# Linux-only simulator sources needed by host-side mksnapshot.
export GYP_DEFINES="target_arch=$NODE_ARCH v8_target_arch=$NODE_ARCH android_target_arch=$NODE_ARCH host_os=linux OS=android android_ndk_path=$ANDROID_NDK_HOME"
./configure \
  --dest-cpu="$NODE_ARCH" \
  --dest-os=android \
  --openssl-no-asm \
  --cross-compiling \
  --without-npm \
  --without-corepack \
  --without-inspector

make -C out -j"$JOBS" node BUILDTYPE=Release
popd >/dev/null

node_bin="$NODE_SOURCE_DIR/out/Release/node"
if [[ ! -x "$node_bin" ]]; then
  echo "Node executable was not produced: $node_bin" >&2
  exit 1
fi

ndk_libcxx="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so"
[[ -f "$ndk_libcxx" ]] || { echo "NDK libc++_shared.so not found: $ndk_libcxx" >&2; exit 1; }

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/lib/$ANDROID_ABI" "$OUTPUT_DIR/include/node"
cp "$node_bin" "$OUTPUT_DIR/lib/$ANDROID_ABI/libdsh_node.so"
chmod 0755 "$OUTPUT_DIR/lib/$ANDROID_ABI/libdsh_node.so"
cp "$ndk_libcxx" "$OUTPUT_DIR/lib/$ANDROID_ABI/libc++_shared.so"

# The JNI bridge needs the public Node and V8 headers.  Keep the tree under a
# stable include/node path so the Android project can compile against this
# output without depending on the temporary source checkout.
cp "$NODE_SOURCE_DIR/src"/*.h "$OUTPUT_DIR/include/node/"
cp -a "$NODE_SOURCE_DIR/deps/v8/include/." "$OUTPUT_DIR/include/node/"
cp "$NODE_SOURCE_DIR/out/Release/obj/gen/node_version.h" "$OUTPUT_DIR/include/node/" 2>/dev/null || true

cat > "$OUTPUT_DIR/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "version": "$NODE_VERSION",
  "nodeVersion": "$NODE_VERSION",
  "androidApi": $ANDROID_API,
  "abi": "$ANDROID_ABI",
  "node": {
    "executable": "libdsh_node.so",
    "entrypoint": "runtime/dsh.cjs",
    "arguments": ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"]
  },
  "web": {"host": "127.0.0.1", "port": 0, "path": "/"},
  "cxxRuntime": "lib/$ANDROID_ABI/libc++_shared.so"
}
EOF

file "$OUTPUT_DIR/lib/$ANDROID_ABI/libdsh_node.so" | grep -E 'ARM aarch64|ELF 64-bit' >/dev/null
if command -v readelf >/dev/null; then
  readelf -d "$OUTPUT_DIR/lib/$ANDROID_ABI/libdsh_node.so" | grep -E 'NEEDED.*(libc\+\+_shared|liblog|libandroid)' || true
fi
printf 'Built Node %s Android %s (%s) in %s\n' "$NODE_VERSION" "$ANDROID_API" "$ANDROID_ABI" "$OUTPUT_DIR"
