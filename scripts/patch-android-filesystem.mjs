#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "/* dsh-android-filesystem-no-replace-v2 */";
const legacyMarker = "/* dsh-android-filesystem-no-replace-v1 */";
const legacyHelperSha256 = "7374ae62544aba43b369bd5acc7aa8c4f46d49ebe33f6ddd4a2148f3952444f6";
const originalAtomicSha256 = "b9724adbc6a2e67498f405037a34a31274923e60d992bc7360a579afdf93ecb4";
const publication = "\t\t\tawait linkFile(tempPath, absolutePath);";
const androidPublication = "\t\t\tif (usesAndroidFilePublication()) await renameAndroidFileNoReplace(tempPath, absolutePath, signal, content);\n\t\t\telse await linkFile(tempPath, absolutePath);";
const legacyPublication = "\t\t\tif (usesAndroidFilePublication()) await renameAndroidFileNoReplace(tempPath, absolutePath, signal);\n\t\t\telse await linkFile(tempPath, absolutePath);";
const createFailure = "\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);";
const androidCreateFailure = "\t\t\tif ((error instanceof FsError && error.code === \"FS_ABORTED\") || error instanceof AndroidExclusiveCreateFailure) throw error;\n" + createFailure;
const anchor = "/**\n* Atomically replace a file through a private, synced staging file in the same directory.";
const helper = "/* dsh-android-filesystem-no-replace-v2 */\n// Keep atomic no-replace publication where the filesystem supports it. Android\n// shared-storage FUSE may reject rename flags; claim the destination exclusively\n// there, then copy and verify the staged bytes. This fallback never overwrites\n// an existing name, but other processes may see the new file before completion.\nlet androidFilePublication;\nclass AndroidExclusiveCreateFailure extends FsError {}\nasync function createAndroidSharedFileExclusive(source, target, signal, expectedContent) {\n\tconst { constants: flags } = await import(\"node:fs\");\n\tconst expected = Buffer.from(expectedContent, \"utf8\");\n\tlet stage;\n\tlet payload;\n\ttry {\n\t\tthrowIfAborted(signal, \"write\");\n\t\tstage = await open(source, flags.O_RDONLY | flags.O_NOFOLLOW);\n\t\tconst identity = await stage.stat({ bigint: true });\n\t\tif (!identity.isFile() || identity.size !== BigInt(expected.length))\n\t\t\tthrow new Error(\"Synced staging file changed before shared-storage creation.\");\n\t\tpayload = await stage.readFile(signal ? { signal } : undefined);\n\t\tconst current = await lstat(source, { bigint: true });\n\t\tif (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino ||\n\t\t\tcurrent.size !== identity.size || !payload.equals(expected))\n\t\t\tthrow new Error(\"Synced staging bytes no longer match the requested content.\");\n\t} catch (error) {\n\t\tif (isAbortError(error)) throw new FsError(\"write aborted\", \"FS_ABORTED\", { cause: error });\n\t\tthrow error;\n\t} finally {\n\t\tif (stage) await stage.close();\n\t}\n\tthrowIfAborted(signal, \"write\");\n\tlet handle;\n\tlet created = false;\n\ttry {\n\t\thandle = await open(target, flags.O_RDWR | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, 0o600);\n\t\tcreated = true;\n\t\tconst owned = await handle.stat({ bigint: true });\n\t\tif (!owned.isFile()) throw new Error(\"Exclusively created file is not regular.\");\n\t\tthrowIfAborted(signal, \"write\");\n\t\tawait handle.writeFile(payload, signal ? { signal } : undefined);\n\t\tthrowIfAborted(signal, \"write\");\n\t\tawait handle.sync();\n\t\tthrowIfAborted(signal, \"write\");\n\t\tconst observed = Buffer.alloc(payload.length);\n\t\tlet offset = 0;\n\t\twhile (offset < observed.length) {\n\t\t\tconst { bytesRead } = await handle.read(observed, offset, observed.length - offset, offset);\n\t\t\tif (bytesRead <= 0) throw new Error(\"Shared-storage file verification was incomplete.\");\n\t\t\toffset += bytesRead;\n\t\t\tthrowIfAborted(signal, \"write\");\n\t\t}\n\t\tconst { bytesRead: extra } = await handle.read(Buffer.alloc(1), 0, 1, payload.length);\n\t\tconst actual = await handle.stat({ bigint: true });\n\t\tconst current = await lstat(target, { bigint: true });\n\t\tthrowIfAborted(signal, \"write\");\n\t\tif (extra !== 0 || !observed.equals(payload) || !current.isFile() ||\n\t\t\tactual.dev !== owned.dev || actual.ino !== owned.ino ||\n\t\t\tcurrent.dev !== owned.dev || current.ino !== owned.ino ||\n\t\t\tactual.size !== BigInt(payload.length) || current.size !== actual.size) {\n\t\t\tthrow new Error(\"Shared-storage file contents or destination changed during creation.\");\n\t\t}\n\t\tawait handle.close();\n\t\thandle = undefined;\n\t\tthrowIfAborted(signal, \"write\");\n\t} catch (error) {\n\t\tif (!created) throw error;\n\t\tconst aborted = isAbortError(error) || (error instanceof FsError && error.code === \"FS_ABORTED\");\n\t\t// Do not unlink a public destination on failure. A different process could\n\t\t// have replaced it; preserve it and require a fresh read before repair.\n\t\tthrow new AndroidExclusiveCreateFailure(\n\t\t\t\"Shared-storage creation did not complete; the newly created file may be partial. Read it before retrying. \" + errorMessage(error),\n\t\t\taborted ? \"FS_ABORTED\" : \"FS_IO_ERROR\", { cause: error });\n\t} finally {\n\t\tif (handle) try { await handle.close(); } catch {}\n\t}\n}\nfunction usesAndroidFilePublication() {\n\treturn process.platform === \"android\" || process.env.DSH_ANDROID === \"1\";\n}\nasync function renameAndroidFileNoReplace(source, target, signal, expectedContent) {\n\tif (androidFilePublication === undefined) {\n\t\tconst koffi = (await import(\"koffi\")).default;\n\t\tconst libc = koffi.load(process.platform === \"android\" ? \"libc.so\" : \"libc.so.6\");\n\t\tandroidFilePublication = {\n\t\t\tkoffi,\n\t\t\tlibc,\n\t\t\trename: libc.func(\"int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)\")\n\t\t};\n\t}\n\tthrowIfAborted(signal, \"write\");\n\tconst { koffi, rename } = androidFilePublication;\n\tconst result = rename(-100, source, -100, target, 1);\n\tconst errno = result === -1 ? koffi.errno() : 0;\n\tif (result === 0) return;\n\tif (result !== -1 || !Number.isInteger(errno) || errno <= 0 || errno > 4095) {\n\t\tthrow new FsError(\"Android file atomic publication returned an invalid native result.\", \"FS_IO_ERROR\");\n\t}\n\t// These errors describe unsupported rename flags, not denied file access.\n\tif (errno === 22 || errno === 95) return createAndroidSharedFileExclusive(source, target, signal, expectedContent);\n\tconst error = new Error(\"Android file atomic publication failed with errno \" + errno + \".\");\n\terror.code = errno === 17 ? \"EEXIST\" : errno === 13 ? \"EACCES\" : errno === 1 ? \"EPERM\" : \"EANDROID_RENAME\";\n\terror.errno = errno;\n\terror.syscall = \"renameat2\";\n\tthrow error;\n}\n";

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
  let source = await readFile(filename, "utf8");
  if (source.includes(legacyMarker)) {
    requireOnce(source, legacyMarker, "legacy patch marker");
    const legacy = source.match(/\/\* dsh-android-filesystem-no-replace-v1 \*\/[^]*?(?=\/\*\*\n\* Atomically replace)/)?.[0];
    if (!legacy || createHash("sha256").update(legacy).digest("hex") !== legacyHelperSha256)
      throw new Error("Android filesystem: damaged legacy Android publication helper");
    requireOnce(source, legacyPublication, "legacy publication dispatch");
    const legacyCatch = "\t\t\tif (error instanceof FsError && error.code === \"FS_ABORTED\") throw error;\n" + createFailure;
    requireOnce(source, legacyCatch, "legacy cancellation propagation");
    source = source.replace(legacy, "").replace(legacyPublication, publication).replace(legacyCatch, createFailure);
    validateOriginal(source);
  }
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
  console.log("patched: Android guarded file creation keeps no-replace rename with exclusive shared-storage fallback; file policy unchanged");
  return { changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-filesystem.mjs <dsh-package-directory>");
  await patchAndroidFileSystem(resolve(process.argv[2]));
}
