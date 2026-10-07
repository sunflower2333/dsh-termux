#!/usr/bin/env bash
# Assemble the immutable runtime assets consumed by the Android foreground
# service.  The Node binary is built separately because Android extracts it
# from jniLibs; the DSH JavaScript package is kept in an APK asset ZIP.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_DIST="${NODE_DIST:-$ROOT_DIR/dist/node-android}"
BASH_DIST="${BASH_DIST:-$ROOT_DIR/dist/bash-android}"
ANDROID_DIR="${ANDROID_DIR:-$ROOT_DIR/android/app/src/main}"
DSH_PACKAGE_DIR="${DSH_PACKAGE_DIR:-}"
DSH_PACKAGE_TGZ="${DSH_PACKAGE_TGZ:-$ROOT_DIR/dist/dsh-termux.tgz}"
WORK_DIR="${WORK_DIR:-$ROOT_DIR/build/android-runtime}"

manifest="$NODE_DIST/manifest.json"
node_lib="$NODE_DIST/lib/arm64-v8a/libdsh_node.so"
cxx_lib="$NODE_DIST/lib/arm64-v8a/libc++_shared.so"
bash_lib="$BASH_DIST/lib/arm64-v8a/libdsh_bash.so"
for required in "$manifest" "$node_lib" "$cxx_lib" "$bash_lib" "$BASH_DIST/licenses/COPYING" "$BASH_DIST/licenses/SOURCE.txt" \
  "$NODE_DIST/licenses/node-LICENSE.txt" "$NODE_DIST/licenses/libcxx-NOTICE.txt"; do
  [[ -f "$required" ]] || { echo "missing Android runtime output: $required" >&2; exit 1; }
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
esbuild_bin="$DSH_PACKAGE_DIR/node_modules/@esbuild/android-arm64/bin/esbuild"
[[ -f "$esbuild_bin" ]] || { echo "DSH package is missing the Android esbuild executable" >&2; exit 1; }

assets="$ANDROID_DIR/assets/runtime"
libs="$ANDROID_DIR/jniLibs/arm64-v8a"
rm -rf "$assets" "$libs" "$WORK_DIR/staged"
mkdir -p "$assets" "$libs" "$WORK_DIR/staged/runtime"
mkdir -p "$ANDROID_DIR/assets/licenses/native"
cp "$NODE_DIST/licenses/node-LICENSE.txt" "$NODE_DIST/licenses/libcxx-NOTICE.txt" \
  "$ANDROID_DIR/assets/licenses/native/"

cp "$node_lib" "$libs/libdsh_node.so"
cp "$cxx_lib" "$libs/libc++_shared.so"
cp "$bash_lib" "$libs/libdsh_bash.so"
# Android 10+ rejects execve() from writable app data. Like Node, esbuild
# must be extracted by the package manager into nativeLibraryDir.
cp "$esbuild_bin" "$libs/libdsh_esbuild.so"
chmod 0755 "$libs/libdsh_node.so" "$libs/libdsh_esbuild.so" "$libs/libdsh_bash.so"

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

# Refresh the mobile layer even when the input package was staged previously.
# WebView lowering deliberately preserves that layer, so it cannot refresh it.
node "$ROOT_DIR/scripts/patch-android-frontend.mjs" "$WORK_DIR/staged/runtime/dsh" --native-shell
# APK-only: use the app-owned fsync boundary and atomic no-replace publication
# without the hard links Android's untrusted_app SELinux domain forbids.
# Patch the staging copy, never the Termux package or the input source tree.
node "$ROOT_DIR/scripts/patch-android-attachments.mjs" "$WORK_DIR/staged/runtime/dsh"
# File tools keep no-overwrite creation, with exclusive copying on shared FUSE
# filesystems that reject atomic no-replace rename flags.
node "$ROOT_DIR/scripts/patch-android-filesystem.mjs" "$WORK_DIR/staged/runtime/dsh"
node "$ROOT_DIR/scripts/patch-android-settings.mjs" "$WORK_DIR/staged/runtime/dsh"
node "$ROOT_DIR/scripts/patch-android-mobile-tools.mjs" "$WORK_DIR/staged/runtime/dsh"
node "$ROOT_DIR/scripts/patch-android-host-events.mjs" "$WORK_DIR/staged/runtime/dsh"
# Android cannot confine Bash to a desktop workspace. Keep DSH's file policy
# and obtain its existing per-command approval before starting a shell.
node "$ROOT_DIR/scripts/patch-android-sandbox.mjs" "$WORK_DIR/staged/runtime/dsh" --native-shell
node "$ROOT_DIR/scripts/patch-android-workspace.mjs" "$WORK_DIR/staged/runtime/dsh" --native-shell
# Keep every runtime entry, type declaration, license and plugin document.
# JavaScript source maps are optional in DSH's client-module loader; Windows
# PDBs and Koffi compiler objects are not inputs to the Android runtime.
node --input-type=module - "$WORK_DIR/staged/runtime/dsh" <<'PRUNE_ANDROID_DEBUG_ARTIFACTS'
import { readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
const root = process.argv[2];
let count = 0, bytes = 0;
async function prune(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await prune(path, name);
    else if (/\.(?:js|mjs|cjs)\.map$/.test(name) ||
      /^node_modules\/node-pty\/prebuilds\/win32-(?:x64|arm64)\/.*\.pdb$/.test(name) ||
      /^node_modules\/koffi\/build\/koffi\/android_arm64\/.*\/CMakeFiles\/.*\.o$/.test(name)) {
      bytes += (await stat(path)).size;
      await unlink(path);
      count++;
    }
  }
}
await prune(root);
console.log(`Android runtime: omitted ${count} optional debug/build files (${bytes} bytes)`);
PRUNE_ANDROID_DEBUG_ARTIFACTS
mkdir -p "$WORK_DIR/staged/runtime/licenses/bash"
cp "$BASH_DIST/licenses/COPYING" "$BASH_DIST/licenses/SOURCE.txt" "$WORK_DIR/staged/runtime/licenses/bash/"

(
  cd "$WORK_DIR/staged"
  zip -X -q -r "$assets/runtime.zip" runtime
)

unzip -tq "$assets/runtime.zip" >/dev/null
# Node's version alone is not an installation identity: the DSH package and
# Android patches can change while Node stays unchanged. Bind the manifest to
# the exact bundle so upgrades replace a previously extracted runtime.
node --input-type=module - "$manifest" "$assets/runtime.zip" "$assets/manifest.json" <<'NODE_MANIFEST'
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
const [source, bundle, output] = process.argv.slice(2);
const metadata = JSON.parse(await readFile(source, "utf8"));
const hash = createHash("sha256");
for await (const chunk of createReadStream(bundle)) hash.update(chunk);
metadata.bundleSha256 = hash.digest("hex");
await writeFile(output, `${JSON.stringify(metadata, null, 2)}\n`);
NODE_MANIFEST
printf 'Staged Android runtime in %s (DSH package %s)\n' "$ANDROID_DIR" "$DSH_PACKAGE_DIR"
