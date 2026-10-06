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

BASH_DOWNLOAD_CONNECT_TIMEOUT="${BASH_DOWNLOAD_CONNECT_TIMEOUT:-20}"
BASH_DOWNLOAD_MAX_TIME="${BASH_DOWNLOAD_MAX_TIME:-120}"
BASH_DOWNLOAD_RETRIES="${BASH_DOWNLOAD_RETRIES:-2}"
BASH_DOWNLOAD_RETRY_MAX_TIME="${BASH_DOWNLOAD_RETRY_MAX_TIME:-240}"
download_only=0
case "${1:-}" in
  "") [[ $# -eq 0 ]] || { echo "usage: $0 [--download-only]" >&2; exit 2; } ;;
  --download-only) [[ $# -eq 1 ]] || { echo "usage: $0 [--download-only]" >&2; exit 2; }; download_only=1 ;;
  *) echo "usage: $0 [--download-only]" >&2; exit 2 ;;
esac
for timeout in "$BASH_DOWNLOAD_CONNECT_TIMEOUT" "$BASH_DOWNLOAD_MAX_TIME" "$BASH_DOWNLOAD_RETRY_MAX_TIME"; do
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || { echo "Bash download timeouts must be positive integer seconds" >&2; exit 2; }
done
[[ "$BASH_DOWNLOAD_RETRIES" =~ ^[0-9]+$ ]] || { echo "BASH_DOWNLOAD_RETRIES must be a nonnegative integer" >&2; exit 2; }
[[ "$ANDROID_API" =~ ^[0-9]+$ ]] && (( ANDROID_API >= 24 )) || { echo "ANDROID_API must be >= 24" >&2; exit 2; }
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "JOBS must be positive" >&2; exit 2; }
if (( download_only == 0 )); then
  : "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must point to an installed Android NDK}"
  TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
  compiler="$TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang"
  [[ -x "$compiler" ]] || { echo "missing Android ARM64 compiler: $compiler" >&2; exit 1; }
fi
mkdir -p "$BUILD_ROOT/downloads"
gnu_archive="$BUILD_ROOT/downloads/bash-$GNU_BASH_VERSION.tar.gz"
debian_archive="$BUILD_ROOT/downloads/bash_$GNU_BASH_VERSION.orig.tar.xz"
if [[ -z "$BASH_SOURCE_TGZ" ]]; then
  trap 'rm -f -- "$gnu_archive.part" "$debian_archive.part" || true' EXIT
fi

archive_matches() {
  local archive="$1" expected="$2" digest
  [[ -f "$archive" && -s "$archive" ]] || return 1
  digest="$(sha256sum < "$archive")" || return 1
  [[ "${digest%% *}" == "$expected" ]]
}

download_verified() {
  local url="$1" expected="$2" destination="$3" status
  local partial="$destination.part"
  rm -f -- "$partial" || return 1
  printf 'Downloading GNU Bash %s source: %s\n' "$GNU_BASH_VERSION" "$url"
  if curl --fail --location --silent --show-error \
    --connect-timeout "$BASH_DOWNLOAD_CONNECT_TIMEOUT" \
    --max-time "$BASH_DOWNLOAD_MAX_TIME" \
    --retry "$BASH_DOWNLOAD_RETRIES" --retry-delay 2 \
    --retry-max-time "$BASH_DOWNLOAD_RETRY_MAX_TIME" \
    "$url" -o "$partial"; then
    if ! archive_matches "$partial" "$expected"; then
      echo "GNU Bash source checksum mismatch from $url; discarding partial download" >&2
      rm -f -- "$partial" || return 1
      return 1
    fi
    mv -f -- "$partial" "$destination" || return 1
    return 0
  else
    status=$?
    echo "GNU Bash source download failed from $url (curl exit $status); discarding partial download" >&2
    rm -f -- "$partial" || return 1
    return "$status"
  fi
}

if [[ -z "$BASH_SOURCE_TGZ" ]]; then
  # Verify both cached formats before attempting the network. A failed or
  # cancelled download is never accepted as a cache entry on the next run.
  for candidate in "$gnu_archive" "$debian_archive"; do
    expected="$GNU_SOURCE_SHA256"
    [[ "$candidate" == "$debian_archive" ]] && expected="$DEBIAN_SOURCE_SHA256"
    if archive_matches "$candidate" "$expected"; then
      if [[ -z "$BASH_SOURCE_TGZ" ]]; then
        BASH_SOURCE_TGZ="$candidate"
      fi
      continue
    fi
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      echo "Discarding invalid GNU Bash source cache: $candidate" >&2
      rm -f -- "$candidate"
    fi
  done
  if [[ -z "$BASH_SOURCE_TGZ" ]]; then
    if download_verified "$GNU_SOURCE_URL" "$GNU_SOURCE_SHA256" "$gnu_archive"; then
      BASH_SOURCE_TGZ="$gnu_archive"
    elif download_verified "$DEBIAN_SOURCE_URL" "$DEBIAN_SOURCE_SHA256" "$debian_archive"; then
      BASH_SOURCE_TGZ="$debian_archive"
    else
      echo "Unable to obtain a checksum-verified GNU Bash $GNU_BASH_VERSION source archive from GNU or Debian" >&2
      exit 1
    fi
  fi
fi
[[ -f "$BASH_SOURCE_TGZ" && -s "$BASH_SOURCE_TGZ" ]] || { echo "GNU Bash source archive is missing or empty: $BASH_SOURCE_TGZ" >&2; exit 1; }
source_hash="$(sha256sum < "$BASH_SOURCE_TGZ")"
source_hash="${source_hash%% *}"
case "$source_hash" in
  "$GNU_SOURCE_SHA256") source_url="$GNU_SOURCE_URL" ;;
  "$DEBIAN_SOURCE_SHA256") source_url="$DEBIAN_SOURCE_URL" ;;
  *) echo "GNU Bash source checksum mismatch: $BASH_SOURCE_TGZ" >&2; exit 1 ;;
esac
printf 'Verified GNU Bash %s source: %s (SHA-256 %s)\n' "$GNU_BASH_VERSION" "$BASH_SOURCE_TGZ" "$source_hash"
if (( download_only == 1 )); then
  exit 0
fi

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
