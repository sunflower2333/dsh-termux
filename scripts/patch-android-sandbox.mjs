#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function patchAndroidSandbox(root, { nativeShell = false } = {}) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-sandbox/lib/index.js");
  const source = await readFile(filename, "utf8");
  const original = 'super(`sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.` + (detail === void 0 ? "" : ` Runner failure: ${detail}`), SANDBOX_UNAVAILABLE);';
  const replacement = `/* dsh-android-sandbox-guidance */
\t\t${original.replace("super(`sandbox", "super((process.platform === \"android\" ? 'Android cannot enforce the requested workspace shell sandbox; this command did not run. For the Bash tool, retry this exact command once with sandbox_permissions=\"danger-full-access\" and a justification to request user approval. Run only if allowed; keep the session permission preset unchanged.' : `sandbox").replace('` + (detail', '`) + (detail')}`;
  if (!source.includes("/* dsh-android-sandbox-guidance */")) {
    if (source.split(original).length !== 2) throw new Error("Android sandbox guidance: unknown upstream error constructor");
    await writeFile(filename, source.replace(original, replacement));
    console.log("patched: Android unavailable sandbox explains single-command approval; policy unchanged");
  }
  if (!nativeShell) return;

  const guided = await readFile(filename, "utf8");
  if (!guided.includes("/* dsh-android-native-sandbox */")) {
    const before = 'super((process.platform === "android" ?';
    if (guided.split(before).length !== 2) throw new Error("Android native sandbox: unknown guidance constructor");
    const after = '/* dsh-android-native-sandbox */\n\t\tsuper((process.platform === "android" && process.env.DSH_ANDROID === "1" ? \'Android does not provide this app with a workspace command sandbox; this command did not run. A restricted Bash call requires DSH single-command approval. Android app-UID isolation is not workspace confinement. The selected filesystem-tool write policy remains active.\' : process.platform === "android" ?';
    await writeFile(filename, guided.replace(before, after));
  }

  // The native app cannot launch a desktop confinement backend. Keep the
  // existing file policy and ask through DSH's normal escalation channel
  // before execution, rather than failing first and relying on a model retry.
  // This patch is staged into the APK copy only; both guards must hold.
  const bashFilename = join(root, "node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js");
  const bash = await readFile(bashFilename, "utf8");
  if (bash.includes("/* dsh-android-bash-single-command-approval */")) return;
  const before = '\t\t\t\tconst approvedMode = args.sandbox_permissions !== void 0 && args.justification !== void 0 ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy) : void 0;';
  if (bash.split(before).length !== 2) throw new Error("Android Bash approval: unknown upstream per-call policy resolution");
  const after = `\t\t\t\tlet approvedMode = args.sandbox_permissions !== void 0 && args.justification !== void 0 ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy) : void 0;
\t\t\t\t/* dsh-android-bash-single-command-approval */
\t\t\t\tif (process.platform === "android" && process.env.DSH_ANDROID === "1" && standingPolicy !== void 0 && standingPolicy.mode !== "danger-full-access" && args.sandbox_permissions === void 0) {
\t\t\t\t\texec.signal.throwIfAborted();
\t\t\t\t\tapprovedMode = await approveBashEscalation("danger-full-access", "Android lacks a workspace command sandbox; allow this command within the app's OS permissions for this call only. 本次命令需在 Android 应用权限内运行，文件工具的工作区限制保持不变。", exec, standingPolicy);
\t\t\t\t\texec.signal.throwIfAborted();
\t\t\t\t}
`;
  await writeFile(bashFilename, bash.replace(before, after.trimEnd()));
  console.log("patched: Android restricted Bash requires existing single-command approval before execution; file policy unchanged");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-sandbox.mjs <dsh-package-directory>");
  await patchAndroidSandbox(resolve(process.argv[2]), { nativeShell: process.argv.includes("--native-shell") });
}
