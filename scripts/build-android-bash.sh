#!/usr/bin/env bash
# Build GNU Bash for the independent Android app, without Termux's fixed prefix
# or external readline/iconv/gettext libraries. The APK extracts this executable
# from jniLibs into nativeLibraryDir, just like the bundled Node executable.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${BUILD_ROOT:-$ROOT_DIR/build-bash-android}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/dist/bash-android}"
ANDROID_API="${ANDROID_API:-30}"
JOBS="${JOBS:-4}"
BASH_SOURCE_TGZ="${BASH_SOURCE_TGZ:-}"
GNU_BASH_VERSION="5.3"
GNU_SOURCE_URL="https://ftp.gnu.org/gnu/bash/bash-$GNU_BASH_VERSION.tar.gz"
GNU_SOURCE_SHA256="0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba"
# Debian independently publishes the original GNU source using xz compression.
# This checksum is recorded in Debian's signed bash_5.3-4.dsc source manifest.
DEBIAN_SOURCE_URL="https://deb.debian.org/debian/pool/main/b/bash/bash_5.3.orig.tar.xz"
DEBIAN_SOURCE_SHA256="a70de6bb41f5e192534a5a1836b1d7fad9a8d4818a6e1506d70f38441552c17a"

: "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must point to an installed Android NDK}"
[[ "$ANDROID_API" =~ ^[0-9]+$ ]] && (( ANDROID_API >= 24 )) || { echo "ANDROID_API must be >= 24" >&2; exit 2; }
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "JOBS must be positive" >&2; exit 2; }
TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
compiler="$TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang"
[[ -x "$compiler" ]] || { echo "missing Android ARM64 compiler: $compiler" >&2; exit 1; }
mkdir -p "$BUILD_ROOT/downloads"

if [[ -z "$BASH_SOURCE_TGZ" ]]; then
  BASH_SOURCE_TGZ="$BUILD_ROOT/downloads/bash-$GNU_BASH_VERSION.tar.gz"
  if [[ ! -s "$BASH_SOURCE_TGZ" ]]; then
    curl -fL --retry 3 --retry-delay 2 "$GNU_SOURCE_URL" -o "$BASH_SOURCE_TGZ"
  fi
fi
source_hash="$(sha256sum "$BASH_SOURCE_TGZ" | awk '{ print $1 }')"
case "$source_hash" in
  "$GNU_SOURCE_SHA256") source_url="$GNU_SOURCE_URL" ;;
  "$DEBIAN_SOURCE_SHA256") source_url="$DEBIAN_SOURCE_URL" ;;
  *) echo "GNU Bash source checksum mismatch: $BASH_SOURCE_TGZ" >&2; exit 1 ;;
esac

source_dir="$BUILD_ROOT/source/bash-$GNU_BASH_VERSION"
rm -rf "$BUILD_ROOT/source"
mkdir -p "$BUILD_ROOT/source"
tar -xaf "$BASH_SOURCE_TGZ" -C "$BUILD_ROOT/source" --no-same-owner
[[ -x "$source_dir/configure" ]] || { echo "GNU Bash source is missing configure" >&2; exit 1; }

export CC="$compiler"
export AR="$TOOLCHAIN/llvm-ar"
export RANLIB="$TOOLCHAIN/llvm-ranlib"
export STRIP="$TOOLCHAIN/llvm-strip"
export CC_FOR_BUILD="${CC_FOR_BUILD:-cc}"
export CFLAGS="-O2 -fPIE"
export LDFLAGS="-pie -Wl,-z,max-page-size=16384"
(
  cd "$source_dir"
  ./configure \
    --host=aarch64-linux-android \
    --build="$(./support/config.guess)" \
    --prefix=/system \
    --without-bash-malloc \
    --disable-nls \
    --disable-readline \
    bash_cv_job_control_missing=present \
    bash_cv_func_sigsetjmp=present \
    bash_cv_unusable_rtsigs=no \
    bash_cv_dev_fd=whacky \
    bash_cv_getcwd_malloc=yes
  make -j"$JOBS" bash
)

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/lib/arm64-v8a" "$OUTPUT_DIR/licenses"
cp "$source_dir/bash" "$OUTPUT_DIR/lib/arm64-v8a/libdsh_bash.so"
chmod 0755 "$OUTPUT_DIR/lib/arm64-v8a/libdsh_bash.so"
cp "$source_dir/COPYING" "$OUTPUT_DIR/licenses/COPYING"
cp "$source_dir/README" "$OUTPUT_DIR/licenses/README"
cat > "$OUTPUT_DIR/licenses/SOURCE.txt" <<EOF
GNU Bash $GNU_BASH_VERSION, GPL-3.0-or-later
Source: $source_url
Source archive SHA-256: $source_hash
Build recipe: scripts/build-android-bash.sh in the DSH Android source repository
Target: Android ARM64 API $ANDROID_API (Bionic), 16 KiB ELF segment alignment.
Configure flags: --host=aarch64-linux-android --prefix=/system
  --without-bash-malloc --disable-nls --disable-readline
  bash_cv_job_control_missing=present bash_cv_func_sigsetjmp=present
  bash_cv_unusable_rtsigs=no bash_cv_dev_fd=whacky bash_cv_getcwd_malloc=yes
CFLAGS: $CFLAGS
LDFLAGS: $LDFLAGS
The complete source archive is published at the URL above. This executable
preserves GNU Bash command semantics; line editing uses the Android terminal.
EOF
file "$OUTPUT_DIR/lib/arm64-v8a/libdsh_bash.so"
readelf -h "$OUTPUT_DIR/lib/arm64-v8a/libdsh_bash.so" | grep -E 'Machine:.*AArch64' >/dev/null
readelf -d "$OUTPUT_DIR/lib/arm64-v8a/libdsh_bash.so" | awk '/NEEDED/ { print }'
printf 'Built GNU Bash %s for Android API %s in %s\n' "$GNU_BASH_VERSION" "$ANDROID_API" "$OUTPUT_DIR"
