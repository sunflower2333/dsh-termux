#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Apply only to the isolated APK package, never the Termux source package. */
export async function patchAndroidMobileTools(root) {
  const lib = join(root, "node_modules/@deepseek-ai/dsh-web-app/lib");
  const entry = join(lib, "index.js");
  const before = await readFile(entry, "utf8");
  const importLine = 'import * as AndroidMobileTools from "./android-mobile-tools.js";';
  const original = "function apply(ctx, config) {\n";
  const replacement = original + '  if (process.env.DSH_ANDROID === "1") ctx.plugin(AndroidMobileTools);\n';
  const pluginLine = replacement.slice(original.length);
  const hostFirst = original + '  if (process.env.DSH_ANDROID === "1") ctx.plugin(AndroidHostEvents);\n' + pluginLine;
  let after;
  if (before.includes(importLine)) {
    if (before.split(importLine).length !== 2 || before.split(original).length !== 2 ||
        before.split(pluginLine).length !== 2 || (!before.includes(replacement) && !before.includes(hostFirst)))
      throw new Error("Unsupported existing Android mobile tools patch");
    after = before;
  } else {
    if (before.split(original).length !== 2 || before.includes("AndroidMobileTools")) throw new Error("Unsupported DSH web-app plugin entry");
    after = importLine + "\n" + before.replace(original, replacement);
  }
  const helper = await readFile(new URL("./android-mobile-tools.mjs", import.meta.url), "utf8");
  await writeFile(join(lib, "android-mobile-tools.js"), helper);
  if (after !== before) await writeFile(entry, after);
  console.log("patched: APK-only native Android mobile tools in the DSH tool runtime");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-mobile-tools.mjs <isolated-apk-dsh-package>");
  await patchAndroidMobileTools(process.argv[2]);
}
