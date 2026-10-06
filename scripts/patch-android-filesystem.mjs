#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "/* dsh-android-filesystem-no-replace-v1 */";
const originalAtomicSha256 = "b9724adbc6a2e67498f405037a34a31274923e60d992bc7360a579afdf93ecb4";
const publication = "\t\t\tawait linkFile(tempPath, absolutePath);";
const androidPublication = "\t\t\tif (usesAndroidFilePublication()) await renameAndroidFileNoReplace(tempPath, absolutePath, signal);\n\t\t\telse await linkFile(tempPath, absolutePath);";
const createFailure = "\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);";
const androidCreateFailure = "\t\t\tif (error instanceof FsError && error.code === \"FS_ABORTED\") throw error;\n" + createFailure;
const anchor = "/**\n* Atomically replace a file through a private, synced staging file in the same directory.";
const helper = `${marker}
// Android untrusted_app cannot hard-link app data. Publish the complete,
// synced sibling with the kernel's atomic no-replace rename instead. This
// changes only guarded creation; observed replacements keep their old path.
let androidFilePublication;
function usesAndroidFilePublication() {
\treturn process.platform === "android" || process.env.DSH_ANDROID === "1";
}
async function renameAndroidFileNoReplace(source, target, signal) {
\tif (androidFilePublication === undefined) {
\t\tconst koffi = (await import("koffi")).default;
\t\tconst libc = koffi.load(process.platform === "android" ? "libc.so" : "libc.so.6");
\t\tandroidFilePublication = {
\t\t\tkoffi,
\t\t\tlibc,
\t\t\trename: libc.func("int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)")
\t\t};
\t}
\t// Initial lazy loading can yield. Recheck cancellation at the actual commit.
\tthrowIfAborted(signal, "write");
\tconst { koffi, rename } = androidFilePublication;
\tconst result = rename(-100, source, -100, target, 1);
\t// errno belongs to this synchronous native thread; never await before reading it.
\tconst errno = result === -1 ? koffi.errno() : 0;
\tif (result === 0) return;
\tif (result !== -1 || !Number.isInteger(errno) || errno <= 0 || errno > 4095) {
\t\tthrow new FsError("Android file atomic publication returned an invalid native result.", "FS_IO_ERROR");
\t}
\tconst error = new Error("Android file atomic publication failed with errno " + errno + ".");
\terror.code = errno === 17 ? "EEXIST" : errno === 13 ? "EACCES" : errno === 1 ? "EPERM" : "EANDROID_RENAME";
\terror.errno = errno;
\terror.syscall = "renameat2";
\tthrow error;
}
`;

function requireOnce(source, value, description) {
  if (source.split(value).length !== 2) throw new Error(`Android filesystem: unknown or duplicate ${description}`);
}

function validateOriginal(source) {
  const functions = [...source.matchAll(/^async function writeFileAtomic\([^]*?^\}/gm)];
  if (functions.length !== 1 || createHash("sha256").update(functions[0][0]).digest("hex") !== originalAtomicSha256) {
    throw new Error("Android filesystem: unknown upstream atomic staging/publication function");
  }
  requireOnce(source, anchor, "atomic documentation anchor");
  requireOnce(source, publication, "guarded no-replace publication");
  requireOnce(source, createFailure, "guarded-create error mapping");
  if (source.includes("usesAndroidFilePublication") || source.includes("renameAndroidFileNoReplace") || source.includes("dsh-android-filesystem-no-replace")) {
    throw new Error("Android filesystem: unexpected existing Android publication helper");
  }
}

export async function patchAndroidFileSystem(root) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-fs-local/lib/index.js");
  const source = await readFile(filename, "utf8");
  if (source.includes(marker)) {
    requireOnce(source, marker, "patch marker");
    requireOnce(source, helper, "Android no-replace helper");
    requireOnce(source, androidPublication, "Android guarded publication dispatch");
    requireOnce(source, androidCreateFailure, "Android late-cancellation propagation");
    validateOriginal(source.replace(helper, "").replace(androidPublication, publication).replace(androidCreateFailure, createFailure));
    return { changed: false };
  }
  validateOriginal(source);
  const patched = source.replace(anchor, helper + anchor).replace(publication, androidPublication).replace(createFailure, androidCreateFailure);
  await writeFile(filename, patched);
  console.log("patched: Android guarded file creation uses atomic Bionic no-replace rename; file policy unchanged");
  return { changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-filesystem.mjs <dsh-package-directory>");
  await patchAndroidFileSystem(resolve(process.argv[2]));
}
