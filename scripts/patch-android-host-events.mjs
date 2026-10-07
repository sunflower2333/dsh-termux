#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function patchAndroidQuestionCallIds(root) {
  const file = join(root, "node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js");
  const before = await readFile(file, "utf8");
  const marker = "/* dsh-android-question-call-id-v1 */";
  const anchor = "return { answers: (await ctx.userQuestions.ask({\n\t\t\t\tquestions: args.questions.map";
  const replacement = "return { answers: (await ctx.userQuestions.ask({\n\t\t\t\t...(process.env.DSH_ANDROID === \"1\" ? { wait: { callId: exec.callId } } : {}),\n\t\t\t\tquestions: args.questions.map";
  if (before.includes(marker)) {
    if (before.split(marker).length !== 2 || before.split(replacement).length !== 2) throw new Error("Damaged Android legacy question identity patch");
    return;
  }
  if (before.split(anchor).length !== 2) throw new Error("Unsupported Android legacy question identity anchor");
  await writeFile(file, marker + "\n" + before.replace(anchor, replacement));
}

/** Install only in the isolated APK staging package. */
export async function patchAndroidHostEvents(root) {
  const lib = join(root, "node_modules/@deepseek-ai/dsh-web-app/lib");
  const entry = join(lib, "index.js");
  const before = await readFile(entry, "utf8");
  const importLine = 'import * as AndroidHostEvents from "./android-host-events.js";';
  const anchor = "function apply(ctx, config) {\n";
  const replacement = anchor + '  if (process.env.DSH_ANDROID === "1") ctx.plugin(AndroidHostEvents);\n';
  const pluginLine = replacement.slice(anchor.length);
  const mobileFirst = anchor + '  if (process.env.DSH_ANDROID === "1") ctx.plugin(AndroidMobileTools);\n' + pluginLine;
  let after;
  if (before.includes(importLine)) {
    if (before.split(importLine).length !== 2 || before.split(anchor).length !== 2 ||
        before.split(pluginLine).length !== 2 || (!before.includes(replacement) && !before.includes(mobileFirst)))
      throw new Error("Unsupported existing Android host events patch");
    after = before;
  } else {
    if (before.split(anchor).length !== 2 || before.includes("AndroidHostEvents")) throw new Error("Unsupported DSH web-app entry for Android host events");
    after = importLine + "\n" + before.replace(anchor, replacement);
  }
  await patchAndroidQuestionCallIds(root);
  const helper = await readFile(new URL("./android-host-events.mjs", import.meta.url), "utf8");
  await writeFile(join(lib, "android-host-events.js"), helper);
  if (after !== before) await writeFile(entry, after);
  console.log("patched: APK-only production host task and interaction events");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-host-events.mjs <isolated-apk-dsh-package>");
  await patchAndroidHostEvents(process.argv[2]);
}
