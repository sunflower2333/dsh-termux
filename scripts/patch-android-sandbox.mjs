#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function patchAndroidSandbox(root) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-sandbox/lib/index.js");
  const source = await readFile(filename, "utf8");
  if (source.includes("/* dsh-android-sandbox-guidance */")) return;
  const original = 'super(`sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.` + (detail === void 0 ? "" : ` Runner failure: ${detail}`), SANDBOX_UNAVAILABLE);';
  if (source.split(original).length !== 2) throw new Error("Android sandbox guidance: unknown upstream error constructor");
  const replacement = `/* dsh-android-sandbox-guidance */
\t\t${original.replace("super(`sandbox", "super((process.platform === \"android\" ? 'Android cannot enforce the requested workspace shell sandbox; this command did not run. For the Bash tool, retry this exact command once with sandbox_permissions=\"danger-full-access\" and a justification to request user approval. Run only if allowed; keep the session permission preset unchanged.' : `sandbox").replace('` + (detail', '`) + (detail')}`;
  await writeFile(filename, source.replace(original, replacement));
  console.log("patched: Android unavailable sandbox explains single-command approval; policy unchanged");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-sandbox.mjs <dsh-package-directory>");
  await patchAndroidSandbox(resolve(process.argv[2]));
}
