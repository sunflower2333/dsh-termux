#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const nativeLoader = '\tconst addon = createRequire(import.meta.url)("node-addon-require-builtin");';
const exposedLoader = `\t// dsh-android-node-internals: use Node's real internal module loader.
\t// The upstream native helper has no Android/Bionic build. Keep its normal
\t// path for runtimes without the flag and retain the checks below either way.
\tconst require = createRequire(import.meta.url);
\tconst addon = process.execArgv.includes("--expose-internals")
\t\t? { requireBuiltin: (id) => require(id) }
\t\t: require("node-addon-require-builtin");`;

export async function patchNodeInternals(root) {
  for (const relativePath of [
    "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js",
    "node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js",
  ]) {
    const filename = join(root, relativePath);
    const source = await readFile(filename, "utf8");
    if (source.includes(exposedLoader)) continue;
    const matches = source.split(nativeLoader).length - 1;
    if (matches !== 1) throw new Error(`Node internal loader: expected one implementation in ${relativePath}, found ${matches}`);
    await writeFile(filename, source.replace(nativeLoader, exposedLoader));
  }

  const binPath = join(root, "lib/bin.js");
  const bin = await readFile(binPath, "utf8");
  const shebang = "#!/usr/bin/env -S node --expose-internals\n";
  if (!bin.startsWith(shebang)) {
    if (!bin.startsWith("#!/usr/bin/env node\n")) throw new Error("unrecognized DSH CLI shebang");
    await writeFile(binPath, bin.replace("#!/usr/bin/env node\n", shebang));
  }
  console.log("patched: dsh Android: Node internal loader and CLI flag");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("usage: patch-node-internals.mjs <dsh-package-directory>");
  await patchNodeInternals(process.argv[2]);
}
