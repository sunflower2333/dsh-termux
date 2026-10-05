# Termux compatibility patches

The release package is generated from the published `@deepseek-ai/dsh` npm package. The build applies these Android-specific changes before packing:

1. **koffi `statx` fallback**
   Android defines `__linux__`, but its Bionic `statx` declarations conflict with koffi's Linux code path. Android is excluded from that branch so koffi uses its existing `fstatat`/`fstat` implementation.
2. **koffi process helper on API 24**
   Bionic only exposes `posix_spawn` file actions from API 28, while the package targets API 24. Koffi's internal command helper is disabled with `ENOSYS` below API 28; dsh's FFI path does not call this helper.
3. **koffi native build**
   The npm package has no Android ARM64 prebuild. It is compiled with Android NDK, API 24, ARM64 and the shared C++ runtime. Node-API symbols remain unresolved in the shared object so Android's dynamic loader can bind them from the Node process when the addon is loaded.
4. **node-pty native build**
   The npm package has no `prebuilds/android-arm64/pty.node`. It is cross-compiled with node-gyp and the NDK, then copied into that npm-whitelisted prebuild directory so the final tarball retains it. The Linux-only `-lutil` link is disabled because Android provides the PTY APIs through Bionic.
5. **sharp WASM runtime**
   Sharp has no Android native package. `@img/sharp-wasm32` is included and sharp automatically falls back to it.
6. **esbuild Android binary**
   `@esbuild/android-arm64` is included explicitly because optional dependency resolution on a Linux Actions host would otherwise select the host binary.
7. **HMR startup guard**
   Older upstream launchers include a Cordis HMR path that requires Node's `--expose-internals`, which cannot be passed through `NODE_OPTIONS`. The patch guards that optional watcher when it is present; newer upstream launchers that no longer ship the patch-file watcher are accepted without this compatibility patch.
8. **session publication without hard links**
   Android application sandboxes reject `link(2)` with `EACCES`. Initial JSONL session publication uses same-directory `rename(2)` on Android and retains hard-link publication on other POSIX platforms.
9. **Android subprocess and shell compatibility**
   Android reports `process.platform === "android"` even though its `/proc`, process-group and ARM64 syscall interfaces follow Linux. The subprocess terminal inspector reuses the Linux implementation, and shell defaults/ENOEXEC fallback use `/system/bin/sh` instead of the unavailable `/bin/sh` path.
10. **Android WebView responsive surface**
   The published web frontend is desktop-first. The mobile stylesheet turns the sidebar into a toolbar and drawer, keeps the composer inside the viewport, and puts settings sections above the full-width form. It also adapts DockKit panes, menus and dialogs, increases touch targets, and preserves local scrolling for code. CSS-module selectors are resolved and checked against the actual plugin bundles; incompatible upstream styles fail packaging. Existing mobile layers are replaced rather than duplicated.

   Browser bundles and embedded PDF workers are also lowered for Android 11's WebView 83. Pinned core-js and inert compatibility libraries load before every bootstrap script, and their licenses are bundled. Audited DOM, cancellation and upload gaps receive feature-detected fallbacks; native APIs remain in use on newer WebViews. Garbage collection APIs are not globally emulated.

   Android's unavailable Bash sandbox error explains the existing single-command approval parameters. It still refuses to execute without enforcement or explicit approval, and does not change the session permission preset.

   Session JSONL write leases use Bionic's real nonblocking `flock` through Koffi on Android, retaining the upstream stable-inode check and descriptor lifetime. Contention and invalid descriptors retain their errno values; close or process exit releases the lock. The original platform bindings remain unchanged elsewhere.
11. **Node internal module resolution**
   Upstream `node-addon-require-builtin` has no usable Android binding. The launcher enables `--expose-internals`, and the main and Worker resolvers use Node's actual internal CommonJS loader. Other launch modes retain the upstream addon path. Verification exercises the real plugin-package and runtime-resolution APIs in both the main process and a Worker.
12. **Android default workspace**
   Android has no desktop Documents-directory lookup. The Android service supplies an app-private Documents directory; standalone Android CLI launches fall back to Documents under the user's home. Explicit upstream workspace overrides retain precedence.

The offline package removes development dependency classifications before `npm pack`, since runtime packages classified as development dependencies are otherwise omitted from the bundled archive. Verification checks every declared dependency in the source tree and packed tarball.

Every source replacement is guarded by an exact one-match assertion. An upstream refactor therefore fails the workflow for review instead of silently producing an unpatched release.
