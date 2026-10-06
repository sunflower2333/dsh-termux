# DeepSeek Harness Android

This is a small native Android client for the existing DeepSeek Harness web UI.
It requires Android 11 (API 30) or newer on an ARM64 device.
`MainActivity` hosts the UI in a loopback-only `WebView`; `DshService` starts DSH in an Android
foreground service and keeps a resident notification while the app is in the
background. The service does not expose a LAN listener and does not enable
Full Access or change DSH's approval policy.

## Runtime bundle

The Android runtime packaging step must provide all of these files before an
APK is built:

```text
app/src/main/assets/runtime/manifest.json
app/src/main/assets/runtime/runtime.zip
app/src/main/jniLibs/arm64-v8a/libdsh_node.so
app/src/main/jniLibs/arm64-v8a/libc++_shared.so
app/src/main/jniLibs/arm64-v8a/libdsh_esbuild.so
app/src/main/jniLibs/arm64-v8a/libdsh_bash.so
```

The Gradle `verifyRuntimeAssets` task deliberately fails when these files are
missing. It must never produce an APK containing an empty or fake runtime.

`manifest.json` uses schema version 1:

```json
{
  "schemaVersion": 1,
  "version": "24.18.0",
  "node": {
    "executable": "libdsh_node.so",
    "entrypoint": "runtime/dsh.cjs",
    "arguments": ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"]
  },
  "web": { "host": "127.0.0.1", "port": 0, "path": "/" },
  "bundleSha256": "<SHA-256 of runtime.zip>"
}
```

`runtime.zip` is extracted into app-private storage and is checked for path
traversal before any entry is written. The entrypoint is checked after
extraction. The bundle checksum also identifies the installation, so APK
updates replace DSH files even when Node's version is unchanged. Node, Bash and
esbuild execute from Android's extracted native library directory; modern
Android does not permit execution from writable app data.
Private command-name symlinks expose `node`, `bash` and `esbuild` on PATH and
are rebound after APK updates. DSH's Bash executor runs GNU Bash rather than
Android's system shell. Bash's license and source information are bundled.
Node's complete third-party license notices and the NDK libc++ notices are
included in APK assets alongside the upstream icon license.
No startup pass walks or chmods the JavaScript dependency tree; executable
permissions are checked on the package-manager-installed native commands.
Android staging omits optional JavaScript source maps, Windows debug symbols
and Koffi compiler objects. Type declarations, declaration maps, licenses and
plugin documents remain included; the full Termux package retains all files.

Opening the app starts DSH automatically and reveals its real WebView UI.
The official desktop icon is used for the launcher and standard Android launch window;
there is no native start screen, spinner, or retry button. Startup failures
appear in a bottom message whose details can be selected or copied. Sanitized
process and WebView logs are retained in the private cache directory.
The desktop PNG is copied from
[`apps/desktop/resources/icon-windows.png`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/desktop/resources/icon-windows.png).
The notification uses the official `FishLogo` silhouette. The upstream MIT
license is also included in APK assets.

The launcher enables `--expose-internals` for DSH's main and Worker module
resolvers, since its upstream native resolver helper has no Bionic support.
The default workspace lives under the app-private Documents directory.
The app remembers the successfully bound local port so restarting DSH preserves
the WebView origin, current session and unsent draft. A genuine port conflict
allows one automatic-port fallback; server-side session history stays on disk.
Each process still supplies a fresh authenticated launch URL. The single Activity
receives repeated launcher and notification opens without creating another view,
and hides plugin bootstrap content during a fresh host reload.

The native launcher supplies its Android App UID to attachment validation,
because Android Node does not expose `process.getuid()`. Every checked private
directory must have that owner, stay within the canonical app data directory,
and contain no symbolic link. File and directory fsync barriers remain enabled.

The browser bundles target Android 11's WebView 83. Pinned compatibility
libraries load before DSH's bootstrap, with their licenses included in the
runtime. Its URL feature check covers DSH resource addresses, so old WebViews
use complete URL and URLSearchParams implementations for file previews and
subagent links. Newer WebViews keep their native implementations. File inputs use
Android's system document picker. Session exports use Android's Save As picker
and retain DSH's local authentication without forwarding it through redirects.
Rotation preserves the existing WebView and pending picker callbacks.
Attachment persistence syncs the app-owned directory chain up to Android's
private data directory, using canonical paths. Android 11 forbids hard links
for app processes, so Android publishes complete files with
`renameat2(RENAME_NOREPLACE)` and creates filename aliases by bounded copying.
File and directory sync, atomic publication without overwriting existing files,
and digest-verified deduplication remain enabled. Termux keeps its original
hard-link publication. Attachment filenames are bounded
and leave a separate 44px area for the Remove button.
When the keyboard leaves a short viewport, the chat header and composer use a
compact layout while keeping Chat, Trajectory and the workspace panel available.
Attachment menus fit inside the actual conversation area and scroll their
remaining options. Pane tabs reserve space for their 44px Close buttons and
support horizontal touch scrolling when several tabs are open.

Document previews also adapt to WebView 83's CSS support. Image and PDF zoom
controls use physical positioning when logical insets are unavailable. PDF text
layers preserve selectable glyph positions using supported dimensions and
transforms. Excel's stylesheet uses selectors scoped to its preview container
when native CSS `@scope` is unavailable; newer WebViews retain native scoping.
Excel waits for its Worker to finish initialization before sending the workbook
and starting the existing parse deadline. Initialization has a separate bounded
deadline, and success, errors or cancellation release the Worker and Blob URL.
Workbooks that omit an optional default row height use a visible 20px default;
explicit row heights and hidden rows remain unchanged.

Android 11 does not provide DSH's desktop Bash sandbox. The default workspace
policy remains enabled; a Bash command that requires unsandboxed execution
must request DSH's existing single-command approval. The app does not silently
grant full access or label the Android app UID as workspace isolation.

Generate the runtime from the real package and Node build before assembling an
APK (the staging script fails if either input is missing):

```bash
ANDROID_NDK_HOME=/path/to/ndk \
  ../scripts/build-android-node.sh
ANDROID_NDK_HOME=/path/to/ndk \
  ../scripts/build-android-bash.sh
../scripts/stage-android-runtime.sh   # consumes dist/dsh-termux.tgz
```

`dist/dsh-termux.tgz` is produced by the existing `scripts/build-termux.sh`
flow. The staged package includes the native `node-pty`/`koffi` artifacts from
that build; it is not a placeholder runtime.

## Build

Use JDK 17 or newer, Android SDK 35, and Gradle 8.9 (AGP 8.7.3). From this directory:

```bash
./gradlew --no-daemon --max-workers=3 :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The unit tests cover loopback URL filtering, ZIP traversal rejection, runtime
bundle identity, sanitized startup diagnostics, and authenticated export
streaming with redirect rejection and cancellation. The
APK tasks intentionally stop at `verifyRuntimeAssets` when the real bundle is
not staged. A device or emulator is still required to validate Android process
lifetime, WebView JavaScript behavior, notification permission, and
foreground-service survival across app switching.

For a GitHub build, open a successful **Build DSH Android** run from the
`android` branch and download its `dsh-android-<run number>` artifact from the
Artifacts section. GitHub requires a signed-in account for artifact downloads.
Unzip the artifact to obtain the signed APK and its SHA-256 file.
The Android workflow defaults to the verified DSH `0.2.0-rc.2` and esbuild
`0.28.2`; its manual version input can select another upstream DSH release.
CI currently generates a fresh testing signing key for each run. To install an
APK from a different run, export any needed sessions and uninstall the previous
CI build first; Android does not allow updates signed by a different key.

For the real WebUI, run a disposable DSH service with a temporary HOME and
save its authenticated launch URL in a private text file. With Python Playwright
and Chromium installed:

```bash
python ../scripts/verify-live-android-ui.py \
  --url-file /path/to/private-test-url.txt \
  --output-dir /path/to/ui-results \
  --chromium /usr/bin/chromium
```

This verifies the actual DSH page at phone widths, menus, and saved theme/language
settings. It does not substitute for APK Activity/WebView or model-request tests.

For controlled chat and Bash approval tests, start the loopback-only Messages
fixture and use another disposable DSH HOME:

```bash
python ../scripts/test-support/messages-fixture-server.py --help
python ../scripts/test-support/verify-controlled-chat.py \
  --url-file /path/to/private-test-url.txt \
  --fixture-file /path/to/fixture/server.json \
  --output-dir /path/to/chat-results \
  --chromium /usr/bin/chromium
```

This drives DSH's real provider settings, streams, Stop button, queue,
single-command approval, rejection, and saved conversations. Responses come
from the fixture; it does not verify real DeepSeek inference. APK lifecycle,
IME, file dialogs, and native addons must also be tested on Android.
