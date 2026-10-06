#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function patchAndroidSettings(root) {
  const lib = join(root, "node_modules/@deepseek-ai/dsh-api-settings-controller/lib");
  const filename = join(lib, "index.js");
  const before = await readFile(filename, "utf8");
  const importLine = 'import { prepareAndroidSettingsDocument } from "./android-settings-document.js";';
  const original = "\t\t\t\tawait this.openTextFile(path, signal);";
  const replacement = "\t\t\t\tif (!(await prepareAndroidSettingsDocument(path))) await this.openTextFile(path, signal);";
  let after = before;
  if (!before.includes(importLine)) {
    if (before.split(original).length !== 2) throw new Error("Unsupported settings document opener");
    after = `${importLine}\n${before.replace(original, replacement)}`;
  } else if (before.split(replacement).length !== 2) {
    throw new Error("Unsupported Android settings opener patch");
  }
  const helper = await readFile(new URL("./android-settings-document.mjs", import.meta.url), "utf8");
  await writeFile(join(lib, "android-settings-document.js"), helper);
  if (after !== before) await writeFile(filename, after);
  console.log("patched: Android settings document preparation; native opener owns handoff");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-settings.mjs <dsh-package-directory>");
  await patchAndroidSettings(process.argv[2]);
}
