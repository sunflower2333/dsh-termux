#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  throw new Error("usage: patch-dsh.mjs <dsh-package-directory>");
}

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

await replaceOnce(
  "node_modules/koffi/lib/native/base/base.cc",
  "#if defined(__linux__)\n    const char *pathname = filename;",
  "#if defined(__linux__) && !defined(__ANDROID__)\n    const char *pathname = filename;",
  "koffi: use fstatat fallback on Android",
);

const profileBootCandidates = [
  "lib/profile-boot-DG5t9aNs.js",
  "lib/profile-boot-BnJoK_kl.js",
];
let profileBoot;
for (const candidate of profileBootCandidates) {
  try {
    await readFile(join(root, candidate));
    profileBoot = candidate;
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
if (!profileBoot) {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(root, "lib"));
  const matches = files.filter((name) => /^profile-boot-.*\.js$/.test(name));
  if (matches.length !== 1) {
    throw new Error(`dsh HMR patch: expected one profile-boot chunk, found ${matches.length}`);
  }
  profileBoot = join("lib", matches[0]);
}

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

await replaceOnce(
  "node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js",
  "import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from \"node:fs/promises\";",
  "import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from \"node:fs/promises\";",
  "session persistence: import rename",
);

await replaceOnce(
  "node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js",
  "\t\t\tawait link(tmp, finalPath);",
  "\t\t\tif (process.platform === \"android\") await rename(tmp, finalPath);\n\t\t\telse await link(tmp, finalPath);",
  "session persistence: publish with rename on Android",
);
