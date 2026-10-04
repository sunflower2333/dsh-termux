#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const [root, expectedVersion] = process.argv.slice(2);
if (!root || !expectedVersion) {
  throw new Error("usage: verify-package.mjs <package-directory> <expected-version>");
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.name !== "dsh-termux" || manifest.version !== expectedVersion) {
  throw new Error(`unexpected package identity ${manifest.name}@${manifest.version}`);
}

const required = [
  "lib/bin.js",
  "node_modules/node-pty/prebuilds/android-arm64/pty.node",
  "node_modules/koffi/build/koffi/android_arm64/koffi.node",
  "node_modules/@esbuild/android-arm64/bin/esbuild",
  "node_modules/@img/sharp-wasm32/lib",
];
for (const relativePath of required) {
  await access(join(root, relativePath));
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
for (const [relativePath, needle] of checks) {
  const source = await readFile(join(root, relativePath), "utf8");
  if (!source.includes(needle)) throw new Error(`missing patch marker in ${relativePath}`);
}
if (profileSource.includes("watchUserPatches(ctx") && !profileSource.includes("process.execArgv.includes(\"--expose-internals\")")) {
  throw new Error(`missing HMR startup guard in lib/${profileFiles[0]}`);
}

console.log(`verified ${manifest.name}@${manifest.version}`);
