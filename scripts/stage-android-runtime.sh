#!/usr/bin/env bash
# Assemble the immutable runtime assets consumed by the Android foreground
# service.  The Node binary is built separately because Android extracts it
# from jniLibs; the DSH JavaScript package is kept in an APK asset ZIP.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_DIST="${NODE_DIST:-$ROOT_DIR/dist/node-android}"
ANDROID_DIR="${ANDROID_DIR:-$ROOT_DIR/android/app/src/main}"
DSH_PACKAGE_DIR="${DSH_PACKAGE_DIR:-}"
DSH_PACKAGE_TGZ="${DSH_PACKAGE_TGZ:-$ROOT_DIR/dist/dsh-termux.tgz}"
WORK_DIR="${WORK_DIR:-$ROOT_DIR/build/android-runtime}"

manifest="$NODE_DIST/manifest.json"
node_lib="$NODE_DIST/lib/arm64-v8a/libdsh_node.so"
cxx_lib="$NODE_DIST/lib/arm64-v8a/libc++_shared.so"
for required in "$manifest" "$node_lib" "$cxx_lib"; do
  [[ -f "$required" ]] || { echo "missing Node runtime output: $required" >&2; exit 1; }
done

if [[ -z "$DSH_PACKAGE_DIR" ]]; then
  [[ -f "$DSH_PACKAGE_TGZ" ]] || {
    echo "set DSH_PACKAGE_DIR or provide $DSH_PACKAGE_TGZ (run build-termux.sh first)" >&2
    exit 1
  }
  DSH_PACKAGE_DIR="$WORK_DIR/package"
  rm -rf "$WORK_DIR"
  mkdir -p "$WORK_DIR/package"
  mapfile -t unsafe < <(tar -tzf "$DSH_PACKAGE_TGZ" | awk '$0 ~ /(^|\/)\.\.\// || $0 ~ /^\// { print; exit }')
  [[ ${#unsafe[@]} -eq 0 ]] || { echo "unsafe path in DSH package archive: ${unsafe[0]}" >&2; exit 1; }
  tar -xzf "$DSH_PACKAGE_TGZ" -C "$DSH_PACKAGE_DIR" --strip-components=1 --no-same-owner
fi

[[ -f "$DSH_PACKAGE_DIR/lib/bin.js" ]] || { echo "DSH package is missing lib/bin.js: $DSH_PACKAGE_DIR" >&2; exit 1; }

assets="$ANDROID_DIR/assets/runtime"
libs="$ANDROID_DIR/jniLibs/arm64-v8a"
rm -rf "$assets" "$libs" "$WORK_DIR/staged"
mkdir -p "$assets" "$libs" "$WORK_DIR/staged/runtime"

cp "$manifest" "$assets/manifest.json"
cp "$node_lib" "$libs/libdsh_node.so"
cp "$cxx_lib" "$libs/libc++_shared.so"
chmod 0755 "$libs/libdsh_node.so"

# Keep the wrapper in the runtime root so the service can invoke the manifest
# entrypoint with a relative path while preserving Node's package resolution.
cat > "$WORK_DIR/staged/runtime/dsh.cjs" <<'NODE_WRAPPER'
"use strict";
(async () => {
  const { runCli } = await import("./dsh/lib/bin.js");
  await runCli();
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
NODE_WRAPPER
cp -a "$DSH_PACKAGE_DIR" "$WORK_DIR/staged/runtime/dsh"

(
  cd "$WORK_DIR/staged"
  zip -X -q -r "$assets/runtime.zip" runtime
)

unzip -tq "$assets/runtime.zip" >/dev/null
printf 'Staged Android runtime in %s (DSH package %s)\n' "$ANDROID_DIR" "$DSH_PACKAGE_DIR"
