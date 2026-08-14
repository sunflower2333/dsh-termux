#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
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
  "node_modules/node-pty/build/Release/pty.node",
  "node_modules/koffi/build/koffi/android_arm64/koffi.node",
  "node_modules/@esbuild/android-arm64/bin/esbuild",
  "node_modules/@img/sharp-wasm32/lib",
];
for (const relativePath of required) {
  await access(join(root, relativePath));
}

const profileFiles = [];
for (const name of await (await import("node:fs/promises")).readdir(join(root, "lib"))) {
  if (!/^profile-boot-.*\.js$/.test(name)) continue;
  const source = await readFile(join(root, "lib", name), "utf8");
  if (source.includes("watchUserPatches(ctx")) profileFiles.push(name);
}
if (profileFiles.length !== 1) throw new Error(`expected one profile-boot implementation, found ${profileFiles.length}`);

const checks = [
  [join("node_modules", "koffi", "lib", "native", "base", "base.cc"), "defined(__ANDROID__)"],
  [join("node_modules", "koffi", "lib", "native", "base", "base.cc"), "__ANDROID_API__ < 28"],
  [join("node_modules", "koffi", "src", "koffi", "CMakeLists.txt"), "--unresolved-symbols=ignore-all"],
  [join("lib", profileFiles[0]), "process.execArgv.includes(\"--expose-internals\")"],
  [join("node_modules", "@deepseek-ai", "dsh-session-persistence-jsonl", "lib", "index.js"), "process.platform === \"android\""],
];
for (const [relativePath, needle] of checks) {
  const source = await readFile(join(root, relativePath), "utf8");
  if (!source.includes(needle)) throw new Error(`missing patch marker in ${relativePath}`);
}

console.log(`verified ${manifest.name}@${manifest.version}`);
