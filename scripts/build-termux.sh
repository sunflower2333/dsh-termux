#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_VERSION="${UPSTREAM_VERSION:-$(npm view @deepseek-ai/dsh version)}"
TERMUX_REVISION="${TERMUX_REVISION:-1}"
NODE_TARGET_VERSION="${NODE_TARGET_VERSION:-24.18.0}"
ANDROID_API="${ANDROID_API:-24}"
ANDROID_ABI="${ANDROID_ABI:-arm64-v8a}"
BUILD_ROOT="${BUILD_ROOT:-$PWD/build}"
PACKAGE_DIR="$BUILD_ROOT/package"
OUTPUT_DIR="$PWD/dist"
TERMUX_VERSION="${UPSTREAM_VERSION}-termux.${TERMUX_REVISION}"

: "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must point to an installed Android NDK}"

rm -rf "$BUILD_ROOT" "$OUTPUT_DIR"
mkdir -p "$BUILD_ROOT" "$PACKAGE_DIR" "$OUTPUT_DIR"

cat > "$BUILD_ROOT/package.json" <<JSON
{
  "name": "dsh-termux-build",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "$UPSTREAM_VERSION"
  }
}
JSON

find_lock_version() {
  local package_name="$1"
  local ranges=()
  mapfile -t ranges < <(node -e '
    const lock = require(process.argv[1]);
    const packageName = process.argv[2];
    const versions = Object.entries(lock.packages)
      .filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`))
      .map(([, metadata]) => metadata.version);
    process.stdout.write([...new Set(versions)].sort().join("\n"));
  ' "$BUILD_ROOT/package-lock.json" "$package_name")
  if (( ${#ranges[@]} != 1 )); then
    echo "expected one locked $package_name version, found: ${ranges[*]}" >&2
    return 1
  fi
  printf '%s\n' "${ranges[0]}"
}

npm install --prefix "$BUILD_ROOT" --ignore-scripts --include=optional --os=android --cpu=arm64
ESBUILD_VERSION="$(npm view @esbuild/android-arm64 version)"
SHARP_VERSION="$(find_lock_version sharp)"
npm install --prefix "$BUILD_ROOT/tools" --ignore-scripts "node-gyp@12.4.0"
npm install --prefix "$BUILD_ROOT" --ignore-scripts --no-save --force --os=android --cpu=arm64 \
  "esbuild@$ESBUILD_VERSION" \
  "sharp@$SHARP_VERSION" \
  "@esbuild/android-arm64@$ESBUILD_VERSION" \
  "@img/sharp-wasm32@$SHARP_VERSION"
node - <<NODE
const esbuildPlatform = require("$BUILD_ROOT/node_modules/@esbuild/android-arm64/package.json");
const sharpPlatform = require("$BUILD_ROOT/node_modules/@img/sharp-wasm32/package.json");
if (esbuildPlatform.version !== "$ESBUILD_VERSION") throw new Error("esbuild Android package version mismatch");
if (sharpPlatform.version !== "$SHARP_VERSION") throw new Error("sharp WASM package version mismatch");
NODE

cp -a "$BUILD_ROOT/node_modules/@deepseek-ai/dsh/." "$PACKAGE_DIR/"
cp -a "$BUILD_ROOT/node_modules" "$PACKAGE_DIR/node_modules"
rm -rf "$PACKAGE_DIR/node_modules/@deepseek-ai/dsh"

node scripts/patch-dsh.mjs "$PACKAGE_DIR"

KOFFI="$PACKAGE_DIR/node_modules/koffi"
REAL_CMAKE="$(command -v cmake)"
mkdir -p "$BUILD_ROOT/cmake-wrapper"
cat > "$BUILD_ROOT/cmake-wrapper/cmake" <<WRAPPER
#!/usr/bin/env bash
set -e
if [[ "\${1:-}" == "--version" || "\${1:-}" == "--build" ]]; then
  exec "$REAL_CMAKE" "\$@"
fi
exec "$REAL_CMAKE" "\$@" \\
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \\
  -DANDROID_ABI="$ANDROID_ABI" \\
  -DANDROID_PLATFORM="android-$ANDROID_API" \\
  -DANDROID_STL=c++_shared
WRAPPER
chmod +x "$BUILD_ROOT/cmake-wrapper/cmake"
PATH="$BUILD_ROOT/cmake-wrapper:$PATH" node "$KOFFI/cnoke.cjs" \
  -P "$KOFFI" -D "$KOFFI/src/koffi" -t android_arm64 \
  --runtime "$NODE_TARGET_VERSION" --release

NODE_PTY="$PACKAGE_DIR/node_modules/node-pty"
NODE_HEADERS="$BUILD_ROOT/node-headers"
curl -fsSL "https://nodejs.org/download/release/v${NODE_TARGET_VERSION}/node-v${NODE_TARGET_VERSION}-headers.tar.gz" \
  | tar -xz -C "$BUILD_ROOT"
mv "$BUILD_ROOT/node-v${NODE_TARGET_VERSION}" "$NODE_HEADERS"

TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC="$TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang"
export CXX="$TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang++"
export AR="$TOOLCHAIN/llvm-ar"
export LD="$TOOLCHAIN/ld.lld"
export RANLIB="$TOOLCHAIN/llvm-ranlib"
export npm_config_arch=arm64
export npm_config_target_arch=arm64
export npm_config_nodedir="$NODE_HEADERS"
export GYP_DEFINES="OS=android target_arch=arm64 host_os=linux host_arch=x64 android_ndk_path=$ANDROID_NDK_HOME"

cp "$NODE_PTY/binding.gyp" "$NODE_PTY/binding.gyp.upstream"
node scripts/patch-node-pty-gyp.mjs "$NODE_PTY/binding.gyp"
(cd "$NODE_PTY" && node "$BUILD_ROOT/tools/node_modules/node-gyp/bin/node-gyp.js" rebuild \
  --arch=arm64 --nodedir="$NODE_HEADERS")
mv "$NODE_PTY/binding.gyp.upstream" "$NODE_PTY/binding.gyp"

node scripts/prepare-package.mjs "$PACKAGE_DIR" "$TERMUX_VERSION"
node scripts/verify-package.mjs "$PACKAGE_DIR" "$TERMUX_VERSION"

file "$NODE_PTY/build/Release/pty.node" | grep -F "ARM aarch64"
file "$KOFFI/build/koffi/android_arm64/koffi.node" | grep -F "ARM aarch64"

(cd "$PACKAGE_DIR" && npm pack --pack-destination "$OUTPUT_DIR")
sha256sum "$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz" > "$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz.sha256"
cp "$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz" "$OUTPUT_DIR/dsh-termux.tgz"
printf '%s\n' "$UPSTREAM_VERSION" > "$OUTPUT_DIR/upstream-version.txt"
printf '%s\n' "$TERMUX_VERSION" > "$OUTPUT_DIR/termux-version.txt"
