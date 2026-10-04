#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  throw new Error("usage: patch-dsh.mjs <dsh-package-directory>");
}

/**
 * The desktop Web surface intentionally starts with a DockKit layout tuned
 * for a mouse and a wide window.  Android WebView has no window chrome and
 * commonly runs at 360–600 CSS px. Keep this as a tiny post-build layer so
 * upstream UI code remains untouched while the packaged Android client gets
 * safe scrolling, touch targets, and viewport-bounded overlays.
 */
const ANDROID_MOBILE_CSS_MARKER = "/* dsh-android-mobile */";
const ANDROID_MOBILE_CSS = `
${ANDROID_MOBILE_CSS_MARKER}
@media screen and (max-width: 600px), screen and (pointer: coarse) and (max-width: 900px) {
  html, body, #root {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    overscroll-behavior: none;
  }

  body {
    -webkit-text-size-adjust: 100%;
    touch-action: manipulation;
  }

  /* DockKit panes must be allowed to shrink below the desktop tab width. */
  [data-dockkit-surface], dockkit-surface,
  [data-dockkit-split], dockkit-split {
    min-width: 0 !important;
    min-height: 0 !important;
  }
  [data-dockkit-split], dockkit-split {
    flex-direction: column !important;
  }
  [data-dockkit-cell], dockkit-cell {
    min-width: 0 !important;
    min-height: 0 !important;
    flex-basis: 0 !important;
  }
  [data-dockkit-divider], dockkit-divider {
    width: 100% !important;
    height: 0 !important;
    touch-action: none;
  }
  [data-dockkit-strip], dockkit-strip {
    box-sizing: border-box;
    min-width: 0;
    height: 44px;
    padding-top: max(8px, env(safe-area-inset-top, 0px));
    padding-inline: max(8px, env(safe-area-inset-left, 0px));
    touch-action: pan-x;
  }
  [data-dockkit-strip-tabs], dockkit-strip-tabs {
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  [data-dockkit-tab], dockkit-tab {
    min-width: 48px;
    min-height: 36px;
    max-width: 68vw;
    flex: 0 1 auto;
  }
  [data-dockkit-strip-chrome], dockkit-strip-chrome {
    gap: 4px;
    margin-left: 2px;
  }
  [data-dockkit-split-button], dockkit-split-button,
  [data-dockkit-add-tab], dockkit-add-tab,
  [data-dockkit-tab-close], dockkit-tab-close {
    min-width: 40px;
    min-height: 40px;
  }
  [data-dockkit-float], dockkit-float {
    box-sizing: border-box !important;
    left: 8px !important;
    top: max(8px, env(safe-area-inset-top, 0px)) !important;
    width: calc(100vw - 16px) !important;
    max-width: calc(100vw - 16px) !important;
    max-height: calc(100vh - 16px) !important;
    max-height: calc(100dvh - 16px) !important;
  }
  [data-dockkit-float-resize] {
    display: none;
  }

  /* Menus, listboxes and dialogs stay inside the WebView viewport. */
  [role="menu"], [role="listbox"] {
    box-sizing: border-box;
    min-width: 0 !important;
    max-width: calc(100vw - 16px) !important;
    max-height: min(60vh, 420px);
    max-height: min(60dvh, 420px);
    overflow-x: hidden;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"] {
    min-height: 44px;
    box-sizing: border-box;
    padding-block: 10px;
  }
  [role="dialog"][aria-modal="true"], [role="alertdialog"] {
    box-sizing: border-box;
    width: min(100%, calc(100vw - 24px)) !important;
    max-width: calc(100vw - 24px) !important;
    max-height: calc(100vh - 24px) !important;
    max-height: calc(100dvh - 24px) !important;
    overflow: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  button, input, select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"] {
    touch-action: manipulation;
  }
  textarea {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    max-height: 38vh;
    max-height: 38dvh;
    resize: vertical;
  }
  input, select {
    max-width: 100%;
    min-height: 44px;
    box-sizing: border-box;
  }
  pre, code, [data-terminal], [data-read], [data-search], [data-diff] {
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  table {
    max-width: 100%;
  }
  img, video, iframe {
    max-width: 100%;
    height: auto;
  }
}
`;

async function patchAndroidFrontend() {
  const frontendDist = join(root, "node_modules/@deepseek-ai/dsh-web-frontend/dist");
  const indexPath = join(frontendDist, "index.html");
  const index = await readFile(indexPath, "utf8");
  const stylesheetHrefs = [...index.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g)]
    .map((match) => match[1]);
  const candidates = stylesheetHrefs.filter((href) => /(?:^|\/)index-[^/]+\.css$/.test(href));
  if (candidates.length !== 1) {
    throw new Error(`dsh Android UI patch: expected one frontend index stylesheet, found ${candidates.length}`);
  }
  const cssPath = join(frontendDist, candidates[0]);
  const css = await readFile(cssPath, "utf8");
  if (css.includes(ANDROID_MOBILE_CSS_MARKER)) {
    console.log("skipped: dsh Android UI: mobile stylesheet already present");
    return;
  }
  await writeFile(cssPath, `${css}\n${ANDROID_MOBILE_CSS}`);
  console.log(`patched: dsh Android UI: responsive WebView stylesheet (${candidates[0]})`);
}

await patchAndroidFrontend();

async function replaceOnce(relativePath, before, after, label) {
  const filename = join(root, relativePath);
  const source = await readFile(filename, "utf8");
  const matches = source.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`${label}: expected exactly one match in ${relativePath}, found ${matches}`);
  }
  await writeFile(filename, source.replace(before, after));
  console.log(`patched: ${label}`);
}

const koffiPath = "node_modules/koffi/lib/native/base/base.cc";
const koffiFilename = join(root, koffiPath);
const koffiSource = await readFile(koffiFilename, "utf8");
const koffiVariants = [
  [
    "#if defined(__linux__)\n    const char *pathname = filename;",
    "#if defined(__linux__) && !defined(__ANDROID__)\n    const char *pathname = filename;",
  ],
  [
    "#if defined(__linux__) && defined(STATX_TYPE) && !defined(CORE_NO_STATX)\n    const char *pathname = filename;",
    "#if defined(__linux__) && !defined(__ANDROID__) && defined(STATX_TYPE) && !defined(CORE_NO_STATX)\n    const char *pathname = filename;",
  ],
  [
    "#if defined(__linux__) && defined(STATX_TYPE)\n    {\n        const char *pathname = filename;",
    "#if defined(__linux__) && !defined(__ANDROID__) && defined(STATX_TYPE)\n    {\n        const char *pathname = filename;",
  ],
];
const koffiMatches = koffiVariants.filter(([before]) => koffiSource.split(before).length - 1 === 1);
if (koffiMatches.length !== 1) {
  throw new Error(`koffi: expected exactly one known statx condition in ${koffiPath}, found ${koffiMatches.length}`);
}
await writeFile(koffiFilename, koffiSource.replace(...koffiMatches[0]));
console.log("patched: koffi: use fstatat fallback on Android");

await replaceOnce(
  koffiPath,
  `bool ExecuteCommandLine(const char *cmd_line, const ExecuteInfo &info,
                        FunctionRef<Span<const uint8_t>()> in_func,
                        FunctionRef<void(Span<uint8_t> buf)> out_func, int *out_code)
{
    BlockAllocator temp_alloc;`,
  `bool ExecuteCommandLine(const char *cmd_line, const ExecuteInfo &info,
                        FunctionRef<Span<const uint8_t>()> in_func,
                        FunctionRef<void(Span<uint8_t> buf)> out_func, int *out_code)
{
#if defined(__ANDROID__) && __ANDROID_API__ < 28
    errno = ENOSYS;
    return false;
#else
    BlockAllocator temp_alloc;`,
  "koffi: disable command execution below Android API 28",
);

await replaceOnce(
  koffiPath,
  `    return true;
}

#endif

bool ExecuteCommandLine(const char *cmd_line, const ExecuteInfo &info,`,
  `    return true;
#endif
}

#endif

bool ExecuteCommandLine(const char *cmd_line, const ExecuteInfo &info,`,
  "koffi: close Android command execution guard",
);

await replaceOnce(
  "node_modules/koffi/src/koffi/CMakeLists.txt",
  "    target_link_options(koffi PRIVATE -Wl,--gc-sections)",
  `    target_link_options(koffi PRIVATE -Wl,--gc-sections)
    if(ANDROID)
        target_link_options(koffi PRIVATE -Wl,--unresolved-symbols=ignore-all)
    endif()`,
  "koffi: resolve Node-API symbols at module load time on Android",
);

const { readdir } = await import("node:fs/promises");

// Node reports the Android target as `android`, while the subprocess package
// uses Linux's /proc and process-group APIs for its POSIX inspector. Android
// also has no /bin/sh symlink in the app sandbox; use the system shell path
// for the fallback and default terminal shell.
const subprocessLocalLib = join(root, "node_modules/@deepseek-ai/dsh-subprocess-local/lib");
const subprocessLaunchName = (await readdir(subprocessLocalLib)).find((name) => /^runner-launch-.*\.js$/.test(name));
if (!subprocessLaunchName) throw new Error("dsh Android patch: subprocess runner launch chunk is missing");
await replaceOnce(
  join("node_modules/@deepseek-ai/dsh-subprocess-local/lib", subprocessLaunchName),
  "if (platform === \"linux\") return new LinuxProcessInspector(arch, internals);",
  "if (platform === \"linux\" || platform === \"android\") return new LinuxProcessInspector(arch, internals);",
  "dsh Android: use Linux process inspector",
);

await replaceOnce(
  "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js",
  "\t\tconst defaultShell = platform === \"windows\" ? process.env.ComSpec || void 0 : process.env.SHELL || userInfo().shell || void 0;",
  "\t\tconst defaultShell = platform === \"windows\" ? process.env.ComSpec || void 0 : process.env.SHELL || userInfo().shell || (process.platform === \"android\" ? \"/system/bin/sh\" : void 0);",
  "dsh Android: select system shell",
);

await replaceOnce(
  "node_modules/@deepseek-ai/dsh-api-terminal-controller/lib/index.js",
  "\t\tshell = profile(environment.defaultShell ?? (environment.platform === \"windows\" ? \"cmd.exe\" : \"/bin/sh\"));",
  "\t\tshell = profile(environment.defaultShell ?? (environment.platform === \"windows\" ? \"cmd.exe\" : environment.platform === \"posix\" && process.platform === \"android\" ? \"/system/bin/sh\" : \"/bin/sh\"));",
  "dsh Android: terminal controller shell fallback",
);

await replaceOnce(
  "node_modules/@deepseek-ai/dsh-api-terminal-controller/lib/types/shells.js",
  "        shell = profile(environment.defaultShell ?? (environment.platform === 'windows' ? 'cmd.exe' : '/bin/sh'));",
  "        shell = profile(environment.defaultShell ?? (environment.platform === 'windows' ? 'cmd.exe' : environment.platform === 'posix' && process.platform === 'android' ? '/system/bin/sh' : '/bin/sh'));",
  "dsh Android: terminal shell type fallback",
);

const runnerPath = "node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js";
const runnerFilename = join(root, runnerPath);
const runnerSource = await readFile(runnerFilename, "utf8");
const runnerNeedle = "internals.execve(\"/bin/sh\", [\n\t\t\t\"/bin/sh\",";
const runnerMatches = runnerSource.split(runnerNeedle).length - 1;
if (runnerMatches !== 2) throw new Error(`dsh Android: expected two /bin/sh fallbacks in runner.js, found ${runnerMatches}`);
await writeFile(
  runnerFilename,
  runnerSource.replaceAll(
    runnerNeedle,
    "internals.execve(process.platform === \"android\" ? \"/system/bin/sh\" : \"/bin/sh\", [\n\t\t\tprocess.platform === \"android\" ? \"/system/bin/sh\" : \"/bin/sh\","),
);
console.log("patched: dsh Android: process inspector and shell paths");

const profileBootMatches = [];
for (const name of await readdir(join(root, "lib"))) {
  if (!/^profile-boot-.*\.js$/.test(name)) continue;
  const source = await readFile(join(root, "lib", name), "utf8");
  if (source.includes("watchUserPatches(ctx")) profileBootMatches.push(join("lib", name));
}
if (profileBootMatches.length > 1) {
  throw new Error(`dsh HMR patch: expected one implementation chunk, found ${profileBootMatches.length}`);
}
if (profileBootMatches.length === 1) {
  const [profileBoot] = profileBootMatches;
  await replaceOnce(
    profileBoot,
    `\t\tif (ctx.get("hmr") === void 0) {
\t\t\tif (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
\t\t\tawait ctx.loader.create({
\t\t\t\tname: "@deepseek-ai/cordis-plugin-hmr",
\t\t\t\tconfig: { root: [] }
\t\t\t});
\t\t}
		await watchUserPatches(ctx, {
			binName: NAME,
			filename: composed.profile.patchPath,
			compose: composeLive
		});
		await watchUserPatches(ctx, {
			binName: NAME,
			filename: homePatchPath(),
			compose: composeLive
		});`,
    `\t\tif (ctx.get("hmr") === void 0 && process.execArgv.includes("--expose-internals")) {
\t\t\tif (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
\t\t\tawait ctx.loader.create({
\t\t\t\tname: "@deepseek-ai/cordis-plugin-hmr",
\t\t\t\tconfig: { root: [] }
\t\t\t});
\t\t}
		if (ctx.get("hmr") !== void 0) {
			await watchUserPatches(ctx, {
				binName: NAME,
				filename: composed.profile.patchPath,
				compose: composeLive
			});
			await watchUserPatches(ctx, {
				binName: NAME,
				filename: homePatchPath(),
				compose: composeLive
			});
		}`,
    "dsh: skip patch-file HMR without --expose-internals",
  );
} else {
  console.log("skipped: dsh HMR patch: upstream launcher has no patch-file watcher");
}

const sessionPersistencePath = "node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js";
const sessionPersistenceFilename = join(root, sessionPersistencePath);
const sessionPersistenceSource = await readFile(sessionPersistenceFilename, "utf8");
const sessionImportVariants = [
  [
    "import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from \"node:fs/promises\";",
    "import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from \"node:fs/promises\";",
  ],
  [
    "import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from \"node:fs/promises\";",
    "import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from \"node:fs/promises\";",
  ],
];
const sessionImportMatches = sessionImportVariants.filter(([before]) => sessionPersistenceSource.split(before).length - 1 === 1);
if (sessionImportMatches.length !== 1) {
  throw new Error(`session persistence: expected exactly one known import in ${sessionPersistencePath}, found ${sessionImportMatches.length}`);
}
await writeFile(sessionPersistenceFilename, sessionPersistenceSource.replace(...sessionImportMatches[0]));
console.log("patched: session persistence: import rename");

await replaceOnce(
  sessionPersistencePath,
  "\t\t\tawait link(tmp, finalPath);",
  "\t\t\tif (process.platform === \"android\") await rename(tmp, finalPath);\n\t\t\telse await link(tmp, finalPath);",
  "session persistence: publish with rename on Android",
);
