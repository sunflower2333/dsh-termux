# DSH Android POC

This is a small Android shell for the existing DSH web UI. `MainActivity` hosts
the UI in a loopback-only `WebView`; `DshService` starts DSH in an Android
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
  "web": { "host": "127.0.0.1", "port": 0, "path": "/" }
}
```

`runtime.zip` is extracted into app-private storage and is checked for path
traversal before any entry is written. The entrypoint is checked after
extraction. The native executable is loaded from Android's extracted native
library directory so it is not copied from writable storage and executed.

Generate the runtime from the real package and Node build before assembling an
APK (the staging script fails if either input is missing):

```bash
ANDROID_NDK_HOME=/path/to/ndk \
  ../scripts/build-android-node.sh
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

The unit tests cover loopback URL filtering and ZIP traversal rejection. The
APK tasks intentionally stop at `verifyRuntimeAssets` when the real bundle is
not staged. A device or emulator is still required to validate Android process
lifetime, WebView JavaScript behavior, notification permission, and
foreground-service survival across app switching.
