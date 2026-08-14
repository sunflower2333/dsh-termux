# Termux compatibility patches

The release package is generated from the published `@deepseek-ai/dsh` npm package. The build applies these Android-specific changes before packing:

1. **koffi `statx` fallback**
   Android defines `__linux__`, but its Bionic `statx` declarations conflict with koffi's Linux code path. Android is excluded from that branch so koffi uses its existing `fstatat`/`fstat` implementation.
2. **koffi process helper on API 24**
   Bionic only exposes `posix_spawn` file actions from API 28, while the package targets API 24. Koffi's internal command helper is disabled with `ENOSYS` below API 28; dsh's FFI path does not call this helper.
3. **koffi native build**
   The npm package has no Android ARM64 prebuild. It is compiled with Android NDK, API 24, ARM64 and the shared C++ runtime. Node-API symbols remain unresolved in the shared object so Android's dynamic loader can bind them from the Node process when the addon is loaded.
4. **node-pty native build**
   The npm package has no `prebuilds/android-arm64/pty.node`. It is cross-compiled with node-gyp and the NDK. The Linux-only `-lutil` link is disabled because Android provides the PTY APIs through Bionic.
5. **sharp WASM runtime**
   Sharp has no Android native package. `@img/sharp-wasm32` is included and sharp automatically falls back to it.
6. **esbuild Android binary**
   `@esbuild/android-arm64` is included explicitly because optional dependency resolution on a Linux Actions host would otherwise select the host binary.
7. **HMR startup guard**
   Cordis HMR requires Node's `--expose-internals`, which cannot be passed through `NODE_OPTIONS`. The launcher only creates the optional patch-file HMR watcher when Node was explicitly started with this flag.
8. **session publication without hard links**
   Android application sandboxes reject `link(2)` with `EACCES`. Initial JSONL session publication uses same-directory `rename(2)` on Android and retains hard-link publication on other POSIX platforms.

Every source replacement is guarded by an exact one-match assertion. An upstream refactor therefore fails the workflow for review instead of silently producing an unpatched release.
