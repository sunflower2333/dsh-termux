#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { verifyNodeInternals } from "./verify-node-internals.mjs";

const [root, expectedVersion, packedArchive] = process.argv.slice(2);
if (!root || !expectedVersion) {
  throw new Error("usage: verify-package.mjs <package-directory> <expected-version> [packed-archive]");
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.name !== "dsh-termux" || manifest.version !== expectedVersion) {
  throw new Error(`unexpected package identity ${manifest.name}@${manifest.version}`);
}
if (manifest.devDependencies) throw new Error("offline runtime must not retain development dependency classifications");
for (const [name, version] of Object.entries(manifest.dependencies)) {
  const dependency = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
  if (dependency.name !== name || dependency.version !== version) {
    throw new Error(`offline dependency mismatch: ${name}@${version}`);
  }
}

const required = [
  "lib/bin.js",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/dsh-webview83-polyfills.js",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-webview83-core-js-bundle-LICENSE.txt",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-webview83-wicg-inert-LICENSE.txt",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-webview83-formatjs-intl-segmenter-LICENSE.txt",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-webview83-formatjs-intl-localematcher-LICENSE.txt",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-webview83-formatjs-fast-memoize-LICENSE.txt",
  "node_modules/node-pty/prebuilds/android-arm64/pty.node",
  "node_modules/koffi/build/koffi/android_arm64/koffi.node",
  "node_modules/@esbuild/android-arm64/bin/esbuild",
  "node_modules/@img/sharp-wasm32/lib",
];
for (const relativePath of required) {
  await access(join(root, relativePath));
}
if (packedArchive) {
  const paths = new Set(execFileSync("tar", ["-tzf", packedArchive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\n"));
  for (const name of Object.keys(manifest.dependencies)) {
    if (!paths.has(`package/node_modules/${name}/package.json`)) {
      throw new Error(`packed offline runtime is missing dependency ${name}`);
    }
  }
  for (const relativePath of required.filter((name) => !name.endsWith("/lib"))) {
    if (!paths.has(`package/${relativePath}`)) throw new Error(`packed offline runtime is missing ${relativePath}`);
  }
}

const profileFiles = [];
for (const name of await readdir(join(root, "lib"))) {
  if (!/^profile-boot-.*\.js$/.test(name)) continue;
  profileFiles.push(name);
}
if (profileFiles.length !== 1) throw new Error(`expected one profile-boot implementation, found ${profileFiles.length}`);

const profileSource = await readFile(join(root, "lib", profileFiles[0]), "utf8");
const subprocessLib = join(root, "node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib");
const subprocessLaunch = (await readdir(subprocessLib)).find((name) => /^runner-launch-.*\.js$/.test(name));
if (!subprocessLaunch) throw new Error("missing subprocess runner launch chunk");

const checks = [
  [join("node_modules", "@deepseek-ai", "node-addon-system", "lib", "flock.js"), "dsh-android-file-lock"],
  [join("node_modules", "@deepseek-ai", "dsh-sandbox", "lib", "index.js"), "dsh-android-sandbox-guidance"],
  [join("node_modules", "@deepseek-ai", "dsh-api-workspace-controller", "lib", "index.js"), "dsh-android-documents"],
  [join("node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js"), "dsh-android-node-internals"],
  [join("node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "worker", "profile-resolution-bootstrap.js"), "dsh-android-node-internals"],
  [join("node_modules", "koffi", "lib", "native", "base", "base.cc"), "defined(__ANDROID__)"],
  [join("node_modules", "koffi", "lib", "native", "base", "base.cc"), "__ANDROID_API__ < 28"],
  [join("node_modules", "koffi", "src", "koffi", "CMakeLists.txt"), "--unresolved-symbols=ignore-all"],
  [join("node_modules", "@deepseek-ai", "dsh-session-persistence-jsonl", "lib", "index.js"), "process.platform === \"android\""],
  [join("node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", subprocessLaunch), "platform === \"linux\" || platform === \"android\""],
  [join("node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "index.js"), "/system/bin/sh"],
  [join("node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "runner.js"), "/system/bin/sh"],
  [join("node_modules", "@deepseek-ai", "dsh-api-terminal-controller", "lib", "index.js"), "/system/bin/sh"],
  [join("node_modules", "@deepseek-ai", "dsh-api-terminal-controller", "lib", "types", "shells.js"), "/system/bin/sh"],
];
const bin = await readFile(join(root, "lib/bin.js"), "utf8");
if (!bin.startsWith("#!/usr/bin/env -S node --expose-internals\n")) {
  throw new Error("DSH launcher must enable Node's internal module loader");
}
for (const [relativePath, needle] of checks) {
  const source = await readFile(join(root, relativePath), "utf8");
  if (!source.includes(needle)) throw new Error(`missing patch marker in ${relativePath}`);
}
const frontendDist = join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist");
const frontendIndex = await readFile(join(frontendDist, "index.html"), "utf8");
const compatibilityTag = '<script data-dsh-android-webview83 src="./assets/dsh-webview83-polyfills.js"></script>';
if (frontendIndex.split(compatibilityTag).length !== 2) {
  throw new Error("WebView compatibility script must be included exactly once");
}
const htmlRenderer = await readFile(join(root, "node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js"), "utf8");
if (!htmlRenderer.includes("dsh-android-webview83-html")) {
  throw new Error("WebView polyfills must precede the server's bootstrap scripts");
}
const frontendStylesheet = [...frontendIndex.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g)]
  .map((match) => match[1])
  .find((href) => /(?:^|\/)index-[^/]+\.css$/.test(href));
if (!frontendStylesheet) throw new Error("frontend index stylesheet is missing");
const frontendCss = await readFile(join(frontendDist, frontendStylesheet), "utf8");
for (const marker of ["/* dsh-android-mobile */", "data-dockkit-split", "max-width: calc(100vw - 16px)"]) {
  if (!frontendCss.includes(marker)) throw new Error(`missing Android UI patch marker ${marker}`);
}
if (profileSource.includes("watchUserPatches(ctx") && !profileSource.includes("process.execArgv.includes(\"--expose-internals\")")) {
  throw new Error(`missing HMR startup guard in lib/${profileFiles[0]}`);
}

verifyNodeInternals(root);
console.log(`verified ${manifest.name}@${manifest.version}`);
