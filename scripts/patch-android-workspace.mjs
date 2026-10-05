#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function patchAndroidWorkspace(root) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js");
  const source = await readFile(filename, "utf8");
  const marker = "// dsh-android-documents: app-private default workspace";
  if (!source.includes(marker)) {
    const before = "\tlet directory = documentsDirectory;";
    if (source.split(before).length !== 2) throw new Error("Android workspace: expected one Documents resolver");
    const after = `${before}
  \t${marker}
  \tif (directory === void 0 && platform === "android") {
  \t\tdirectory = process.env.DSH_ANDROID_DOCUMENTS_DIR ?? paths.join(internals.home ?? homedir(), "Documents");
  \t}`;
    await writeFile(filename, source.replace(before, after));
  }
  console.log("patched: dsh Android: app-private Documents workspace");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("usage: patch-android-workspace.mjs <dsh-package-directory>");
  await patchAndroidWorkspace(process.argv[2]);
}
