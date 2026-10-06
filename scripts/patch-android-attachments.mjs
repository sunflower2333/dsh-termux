#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "/* dsh-android-attachment-durable-boundary-v3 */";
const pathImport = 'import { dirname, join, parse, resolve } from "node:path";';
const androidPathImport = 'import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";';
const fsImport = 'import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";';
const androidFsImport = 'import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";';
const originalHome = `async function ensureDurableHome(path) {
	const home = resolve(path);
	if (!durableHomes.has(home)) {
		await ensureDurableDirectory(home, parse(home).root);
		durableHomes.add(home);
	}
	return home;
}`;
const androidHome = `${marker}
function androidDurableBoundaryError(message) {
	return new AttachmentError(message, "ATTACHMENT_WRITE_FAILED");
}
function androidAttachmentUid() {
	// Android Node does not expose process.getuid(). The native launcher binds
	// its own Process.myUid() to this private child environment instead.
	const configured = process.env.DSH_ANDROID_APP_UID;
	let carried;
	if (configured !== undefined) {
		if (!/^(?:0|[1-9][0-9]*)$/.test(configured)) {
			throw androidDurableBoundaryError("Android attachment app UID must be a native unsigned integer.");
		}
		carried = Number(configured);
		if (!Number.isSafeInteger(carried) || carried > 2147483647) {
			throw androidDurableBoundaryError("Android attachment app UID is outside the native UID range.");
		}
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : carried;
	if (!Number.isSafeInteger(uid) || uid < 0 || uid > 2147483647 || (carried !== undefined && carried !== uid)) {
		throw androidDurableBoundaryError("Android attachment app UID must match the native process owner.");
	}
	return uid;
}
async function validateAndroidDurableHome(home, boundary, complete, uid) {
	let level = home;
	for (;;) {
		let stat;
		try {
			stat = await lstat(level);
		} catch (error) {
			if (complete || error?.code !== "ENOENT") throw error;
		}
		if (stat) {
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
				throw androidDurableBoundaryError("Android attachment home requires app-owned directories without symbolic links.");
			}
			if (await realpath(level) !== level) {
				throw androidDurableBoundaryError("Android attachment home must use its canonical app-private path.");
			}
		} else if (level === boundary) {
			throw androidDurableBoundaryError("Android attachment durable root does not exist.");
		}
		if (level === boundary) return;
		level = dirname(level);
	}
}
async function ensureDurableHome(path) {
	const home = resolve(path);
	if (process.platform === "android" || process.env.DSH_ANDROID === "1") {
		const configuredRoot = process.env.DSH_ANDROID_DURABLE_ROOT;
		if (!configuredRoot || !isAbsolute(configuredRoot)) {
			throw androidDurableBoundaryError("Android attachment durable root must be an absolute app-private directory.");
		}
		const uid = androidAttachmentUid();
		const boundary = resolve(configuredRoot);
		const within = relative(boundary, home);
		if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
			throw androidDurableBoundaryError("Android attachment home must be inside the app-private durable root.");
		}
		// Android's OS-created dataDir is the durability boundary. Validate only
		// the app-owned chain; its inaccessible OS-owned parents are not opened.
		await validateAndroidDurableHome(home, boundary, false, uid);
		await ensureDurableDirectory(home, boundary);
		await validateAndroidDurableHome(home, boundary, true, uid);
		await syncDirectory(home);
		// Revalidate/re-sync on every save, including a recreated private home.
		// Existing file fsync, publication, and digest-verified dedup stay intact.
		return home;
	}
	if (!durableHomes.has(home)) {
		await ensureDurableDirectory(home, parse(home).root);
		durableHomes.add(home);
	}
	return home;
}`;

const androidPublication = `
// Android 11 forbids hard links in the untrusted_app SELinux domain. Keep
// complete-file, atomic, no-replace publication with Bionic API 30 instead.
const requireAndroidAttachmentKoffi = createLazyRequire("koffi", import.meta.url);
let androidAttachmentRename;
function usesAndroidAttachmentPublication() {
\treturn process.platform === "android" || process.env.DSH_ANDROID === "1";
}
function renameAndroidAttachmentNoReplace(source, target) {
\tif (androidAttachmentRename === undefined) {
\t\tconst koffi = requireAndroidAttachmentKoffi();
\t\tconst libc = koffi.load(process.platform === "android" ? "libc.so" : "libc.so.6");
\t\tandroidAttachmentRename = {
\t\t\tkoffi,
\t\t\tlibc,
\t\t\trename: libc.func("int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)")
\t\t};
\t}
\tconst { koffi, rename } = androidAttachmentRename;
\tconst result = rename(-100, source, -100, target, 1);
\t// Read errno synchronously on the same native thread, before any await.
\tconst errno = result === -1 ? koffi.errno() : 0;
\tif (result === 0) return;
\tif (result !== -1 || !Number.isInteger(errno) || errno <= 0) {
\t\tthrow androidDurableBoundaryError("Android attachment atomic publication returned an invalid native result.");
\t}
\tconst error = new Error("Android attachment atomic publication failed with errno " + errno + ".");
\terror.code = errno === 17 ? "EEXIST" : "EANDROID_RENAME";
\terror.errno = errno;
\tthrow error;
}
async function publishAndroidStagedObject(root, target, staged) {
\tconst parent = dirname(target);
\ttry {
\t\tawait ensureDurableDirectory(parent, staged.boundary);
\t\ttry {
\t\t\trenameAndroidAttachmentNoReplace(staged.path, target);
\t\t} catch (error) {
\t\t\tif (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
\t\t\tif (await digestFile(target) !== staged.sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
\t\t\t// A matching object won the race. Only remove our own staging name.
\t\t\tawait removeTemporary(staged.path);
\t\t}
\t\t// A successful rename consumed the staging name; never unlink the target.
\t\tawait chmod(target, 256);
\t\tconst stop = resolve(root);
\t\tfor (let level = parent; level !== stop; level = dirname(level)) {
\t\t\tawait syncDirectory(level);
\t\t\tif (dirname(level) === level) break;
\t\t}
\t} catch (error) {
\t\tawait removeTemporary(staged.path);
\t\tif (error instanceof AttachmentError) throw error;
\t\tthrow new AttachmentError("Unable to persist attachment.", "ATTACHMENT_WRITE_FAILED", { cause: error });
\t}
}
async function publishAndroidImmutableAlias(root, source, target, sha256) {
\t// Copies have distinct inodes on Android. Preserve bounded reads, hashing,
\t// file fsync and atomic publication rather than exposing a partial alias.
\t// Open only when staging starts consumption, so a read error cannot fire
\t// before the async iterator has installed its error handler.
\tconst staged = await stageImmutableObject(root, (async function* () {
\t\tyield* createReadStream(source, { highWaterMark: 65536 });
\t})());
\tif (staged.sha256 !== sha256) {
\t\tawait removeTemporary(staged.path);
\t\tthrow new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
\t}
\tawait publishAndroidStagedObject(root, target, staged);
}`;
const androidDispatch = {
  publishStagedObject: '\n\tif (usesAndroidAttachmentPublication()) return publishAndroidStagedObject(root, target, staged);',
  publishImmutableAlias: '\n\tif (usesAndroidAttachmentPublication()) return publishAndroidImmutableAlias(root, source, target, sha256);',
};

// Original bodies remain exact. Two publishers gain only an Android dispatch;
// stripping those audited lines must reproduce each upstream peer hash.
const peerHashes = {
  syncDirectory: "2eff7df0f259801f329cc54890a3d0a204fc90e759e6c78d0e1a1124d809a0a7",
  ensureDurableDirectory: "b1d154a3432e535f51270fa2d9a6e0ffcb19b889715a1dcfb5bf45ce7a727966",
  stageImmutableObject: "ae82e12af79bed7c8e890fe7a43a6433ef63eba8b79cae05a762d38c9c76ef53",
  publishStagedObject: "b204df329b2eb929542063eeb57251961b7ce57b3ce0b22460381acf85368467",
  publishImmutableAlias: "c2220954df400c8eb20cf4a95bcf4a01a7a460d1c8b6ef5e6c7ef1cce8c7875b",
};

function verifyPeers(source, patched = false) {
  for (const [name, expected] of Object.entries(peerHashes)) {
    const matches = [...source.matchAll(new RegExp(`^async function ${name}\\([^]*?^\\}`, "gm"))];
    let body = matches.length === 1 ? matches[0][0] : "";
    if (patched && androidDispatch[name]) {
      const dispatch = androidDispatch[name];
      if (!exactlyOnce(body, dispatch) || !body.startsWith(body.split("{")[0] + "{" + dispatch)) {
        throw new Error(`Android attachments: modified ${name} platform dispatch`);
      }
      body = body.replace(dispatch, "");
    }
    if (matches.length !== 1 || createHash("sha256").update(body).digest("hex") !== expected) {
      throw new Error(`Android attachments: unknown upstream ${name}; refusing to alter durability barriers`);
    }
  }
}
function exactlyOnce(source, value) {
  return source.split(value).length === 2;
}
function functionCount(source, name) {
  return [...source.matchAll(new RegExp(`^(?:async )?function ${name}\\(`, "gm"))].length;
}

export async function patchAndroidAttachments(root) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js");
  const source = await readFile(filename, "utf8");
  verifyPeers(source, source.includes(marker));
  if (source.includes(marker)) {
    if (!exactlyOnce(source, marker) || !exactlyOnce(source, androidHome) || !exactlyOnce(source, androidPublication) || !exactlyOnce(source, androidPathImport)
        || !exactlyOnce(source, androidFsImport) || functionCount(source, "ensureDurableHome") !== 1
        || functionCount(source, "validateAndroidDurableHome") !== 1 || functionCount(source, "androidDurableBoundaryError") !== 1
        || functionCount(source, "androidAttachmentUid") !== 1
        || functionCount(source, "usesAndroidAttachmentPublication") !== 1
        || functionCount(source, "renameAndroidAttachmentNoReplace") !== 1
        || functionCount(source, "publishAndroidStagedObject") !== 1
        || functionCount(source, "publishAndroidImmutableAlias") !== 1) {
      throw new Error("Android attachments: modified or incomplete existing durable-boundary patch");
    }
    return { changed: false };
  }
  if (!exactlyOnce(source, originalHome) || !exactlyOnce(source, pathImport) || !exactlyOnce(source, fsImport)
      || functionCount(source, "ensureDurableHome") !== 1 || source.includes("validateAndroidDurableHome")
      || source.includes("androidDurableBoundaryError") || source.includes("androidAttachmentUid")
      || source.includes("AndroidAttachment") || source.includes("dsh-android-attachment-durable-boundary-")) {
    throw new Error("Android attachments: unknown upstream home/import shape");
  }
  let patched = source.replace(pathImport, androidPathImport).replace(fsImport, androidFsImport).replace(originalHome, androidHome + androidPublication);
  for (const [name, dispatch] of Object.entries(androidDispatch)) {
    patched = patched.replace(new RegExp(`^(async function ${name}\\([^\\n]*\\{)$`, "m"), "$1" + dispatch);
  }
  verifyPeers(patched, true);
  await writeFile(filename, patched);
  return { changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("usage: patch-android-attachments.mjs <copied-dsh-package-directory>");
  const result = await patchAndroidAttachments(resolve(process.argv[2]));
  console.log(`Android attachment app-private durability boundary: ${result.changed ? "patched" : "verified (unchanged)"}`);
}
