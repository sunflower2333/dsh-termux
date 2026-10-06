#!/usr/bin/env node
// HOST integration with the real DSH filesystem providers and real Linux
// Koffi/libc renameat2. Native-fault cases are explicitly injected below.
// This does not establish Android Bionic/SELinux or ARM64 guest success.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { patchAndroidFileSystem } from "./patch-android-filesystem.mjs";

const packageRoot = process.argv[2];
const hostKoffiRoot = process.argv[3];
if (!packageRoot) throw new Error("usage: test-android-filesystem.mjs <dsh-package-directory> [host-koffi-package-directory]");
if (process.platform !== "linux") throw new Error("Android filesystem HOST verification requires Linux libc renameat2");
const work = await fsp.mkdtemp(join(tmpdir(), "dsh-android-filesystem-test-"));
const scope = join(work, "node_modules/@deepseek-ai");
await fsp.mkdir(scope, { recursive: true });
for (const entry of await fsp.readdir(join(packageRoot, "node_modules"))) {
  if (entry !== "@deepseek-ai") await fsp.symlink(
    resolve(entry === "koffi" && hostKoffiRoot ? hostKoffiRoot : join(packageRoot, "node_modules", entry)),
    join(work, "node_modules", entry));
}
// Only these two small JS providers are copied. Dependencies and the source
// runtime stay read-only; no full runtime or native binary is duplicated.
for (const entry of await fsp.readdir(join(packageRoot, "node_modules/@deepseek-ai"))) {
  const source = resolve(packageRoot, "node_modules/@deepseek-ai", entry);
  const destination = join(scope, entry);
  if (["dsh-fs-local", "dsh-fs-sandbox"].includes(entry)) {
    await fsp.mkdir(join(destination, "lib"), { recursive: true });
    await fsp.copyFile(join(source, "lib/index.js"), join(destination, "lib/index.js"));
    await fsp.copyFile(join(source, "package.json"), join(destination, "package.json"));
  } else await fsp.symlink(source, destination);
}
const filename = join(scope, "dsh-fs-local/lib/index.js");
const original = await fsp.readFile(filename, "utf8");
assert(!original.includes("dsh-android-filesystem-no-replace"), "use an original pre-APK filesystem provider for patch integration tests");
await patchAndroidFileSystem(work);
const patched = await fsp.readFile(filename, "utf8");
const originalEnv = { DSH_ANDROID: process.env.DSH_ANDROID };
let nativeFault, bindingFault, bindingHook;
const nativeCalls = [];
const syncedSources = new Set();
const realOpen = fsp.open;
fsp.open = async function(path, ...args) {
  const handle = await realOpen(path, ...args);
  if (String(path).includes(".tmpdir/")) {
    const actualSync = handle.sync.bind(handle);
    handle.sync = async () => { await actualSync(); syncedSources.add(String(path)); };
  }
  return handle;
};
syncBuiltinESMExports();
const [{ Context }, { LocalFileSystem }, { SandboxedFileSystem }, { default: koffi }] = await Promise.all([
  import(pathToFileURL(join(scope, "cordis/lib/index.js"))),
  import(pathToFileURL(filename)),
  import(pathToFileURL(join(scope, "dsh-fs-sandbox/lib/index.js"))),
  import(pathToFileURL(join(work, "node_modules/koffi/index.js"))),
]);
const realLoad = koffi.load;
const realErrno = koffi.errno;
const libraries = [];
koffi.load = library => {
  if (bindingFault) throw new Error(bindingFault);
  libraries.push(library);
  const libc = realLoad(library);
  bindingHook?.();
  return { libc, func(declaration) {
    const native = libc.func(declaration);
    return (...args) => {
      nativeCalls.push({ args, synced: syncedSources.has(args[1]), sourceBytes: fs.readFileSync(args[1]),
        sourceMode: fs.statSync(args[1]).mode & 0o777, targetExisted: fs.existsSync(args[3]) });
      if (nativeFault) return nativeFault.result;
      return native(...args);
    };
  } };
};
koffi.errno = () => nativeFault ? nativeFault.errno : realErrno();
after(async () => {
  koffi.load = realLoad; koffi.errno = realErrno; fsp.open = realOpen;
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(await fsp.readFile(resolve(packageRoot, "node_modules/@deepseek-ai/dsh-fs-local/lib/index.js"), "utf8"), original);
  await fsp.rm(work, { recursive: true, force: true });
});

async function fixture(name, { android = true, Provider = LocalFileSystem, mode = "workspace-write", Class = Provider } = {}) {
  process.env.DSH_ANDROID = android ? "1" : "0";
  const directory = join(work, "cases", name);
  await fsp.mkdir(directory, { recursive: true });
  const ctx = new Context();
  ctx.reflect.provide("sandboxPolicy", { defaultMode: mode, resolve: () => ({ mode, workspaceRoot: directory }) });
  const provider = new Class(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 });
  const target = await provider.resolve(join(directory, "target.txt"));
  return { directory, provider, target };
}
async function clean(directory, expected = []) {
  assert.deepEqual((await fsp.readdir(directory)).sort(), [...expected].sort(), "only own staging may be removed");
}
async function noFile(path) { await assert.rejects(fsp.lstat(path), { code: "ENOENT" }); }
const guarded = { kind: "createIfAbsent" };

test("patch is idempotent and changes only the publication dispatch plus its helper", async () => {
  const before = await fsp.stat(filename);
  assert.deepEqual(await patchAndroidFileSystem(work), { changed: false });
  const after = await fsp.stat(filename);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(before.ino, after.ino);
  const stripped = patched.replace(/\/\* dsh-android-filesystem-no-replace-v1 \*\/[^]*?(?=\/\*\*\n\* Atomically replace)/, "")
    .replace("\t\t\tif (usesAndroidFilePublication()) await renameAndroidFileNoReplace(tempPath, absolutePath, signal);\n\t\t\telse await linkFile(tempPath, absolutePath);", "\t\t\tawait linkFile(tempPath, absolutePath);")
    .replace('\t\t\tif (error instanceof FsError && error.code === "FS_ABORTED") throw error;\n', "");
  assert.equal(stripped, original, "staging, fsync, permissions, abort, observed replacements, error mapping and cleanup are byte-identical");
});
for (const [name, source] of [
  ["changed fsync", original.replace("await handle.sync();", "await handle.datasync();")],
  ["changed cancellation", original.replace('throwIfAborted(signal, "write");', 'throwIfAborted(signal, "edit");')],
  ["changed publication", original.replace("await linkFile(tempPath, absolutePath);", "await rename(tempPath, absolutePath);")],
  ["changed patched errno", patched.replace('errno === 17 ? "EEXIST"', 'errno === 18 ? "EEXIST"')],
  ["missing patched dispatch", patched.replace("if (usesAndroidFilePublication()) await renameAndroidFileNoReplace(tempPath, absolutePath, signal);", "if (false) await renameAndroidFileNoReplace(tempPath, absolutePath, signal);")],
  ["duplicate marker", patched + "\n/* dsh-android-filesystem-no-replace-v1 */\n"],
]) {
  test(`patch rejects ${name} without modifying its input`, async () => {
    const root = join(work, "guards", name.replaceAll(" ", "-"));
    const file = join(root, "node_modules/@deepseek-ai/dsh-fs-local/lib/index.js");
    await fsp.mkdir(dirname(file), { recursive: true }); await fsp.writeFile(file, source);
    await assert.rejects(patchAndroidFileSystem(root), /Android filesystem:/);
    assert.equal(await fsp.readFile(file, "utf8"), source);
  });
}
test("non-Android creation retains the original link hook and never loads libc", async () => {
  const f = await fixture("non-android", { android: false });
  let calls = 0;
  f.provider.internals.linkFile = async (source, target) => { calls++; await fsp.link(source, target); };
  await f.provider.writeText(f.target, "desktop\n", guarded);
  assert.equal(calls, 1); assert.deepEqual(libraries, []); assert.equal(nativeCalls.length, 0);
  assert.equal(await f.provider.readText(f.target), "desktop\n"); await clean(f.directory, ["target.txt"]);
});
test("real Linux renameat2 publishes a complete synced private file through the actual SDK", async () => {
  const f = await fixture("native-create");
  f.provider.internals.linkFile = () => { throw new Error("Android must not hard-link"); };
  const content = "Android complete file 🌻\n";
  let staged = false;
  f.provider.internals.inspectTemp = async ({ stagingDir, tempPath }) => {
    staged = true;
    assert.equal((await fsp.stat(stagingDir)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(tempPath)).mode & 0o777, 0o600);
    assert.equal(await fsp.readFile(tempPath, "utf8"), content); await noFile(f.target.targetKey);
  };
  const result = await f.provider.writeText(f.target, content, guarded);
  assert.equal(staged, true); assert.equal(result.operation, "create");
  assert.equal(await f.provider.readText(f.target), content);
  assert.equal((await fsp.stat(f.target.targetKey)).mode & 0o777, 0o600);
  const call = nativeCalls.at(-1);
  assert.equal(call.synced, true); assert.equal(call.sourceMode, 0o600);
  assert.equal(call.sourceBytes.toString(), content); assert.equal(call.targetExisted, false);
  assert.deepEqual([call.args[0], call.args[2], call.args[4]], [-100, -100, 1]);
  assert.deepEqual(libraries, ["libc.so.6"]); await clean(f.directory, ["target.txt"]);
});
test("a real concurrent creator is preserved and native EEXIST maps to FS_NOT_OBSERVED", async () => {
  const f = await fixture("concurrent-creator");
  f.provider.internals.inspectTemp = () => fsp.writeFile(f.target.targetKey, "winner\n", { flag: "wx" });
  await assert.rejects(f.provider.writeText(f.target, "loser\n", guarded), error => error.code === "FS_NOT_OBSERVED" && error.cause?.code === "EEXIST" && error.cause.errno === 17);
  assert.equal(await fsp.readFile(f.target.targetKey, "utf8"), "winner\n"); await clean(f.directory, ["target.txt"]);
});
test("eight actual SDK writers racing at publication commit exactly one complete file", async () => {
  const f = await fixture("eight-writers");
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const before = nativeCalls.length;
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => {
    const provider = new LocalFileSystem(new Context(), { cwd: f.directory, diffBasisMaxBytes: 1024 });
    provider.internals.inspectTemp = async () => { if (++arrived === 8) release(); await barrier; };
    return provider.writeText(f.target, `complete-writer-${index}\n`, guarded);
  }));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "FS_NOT_OBSERVED").length, 7);
  assert.equal(nativeCalls.length - before, 8);
  assert.match(await fsp.readFile(f.target.targetKey, "utf8"), /^complete-writer-[0-7]\n$/);
  await clean(f.directory, ["target.txt"]);
});
test("an existing unobserved target is refused before staging or native publication", async () => {
  const f = await fixture("existing"); await fsp.writeFile(f.target.targetKey, "preserved");
  const before = nativeCalls.length;
  await assert.rejects(f.provider.writeText(f.target, "overwrite", guarded), { code: "FS_NOT_OBSERVED" });
  assert.equal(nativeCalls.length, before); assert.equal(await fsp.readFile(f.target.targetKey, "utf8"), "preserved");
  await clean(f.directory, ["target.txt"]);
});
test("a symlink planted at publication is preserved without writing its referent", async () => {
  const f = await fixture("symlink-race");
  const outside = join(f.directory, "sentinel.txt"); await fsp.writeFile(outside, "untouched");
  f.provider.internals.inspectTemp = () => fsp.symlink(outside, f.target.targetKey);
  await assert.rejects(f.provider.writeText(f.target, "escape", guarded), { code: "FS_NOT_REGULAR_FILE" });
  assert.equal((await fsp.lstat(f.target.targetKey)).isSymbolicLink(), true);
  assert.equal(await fsp.readFile(outside, "utf8"), "untouched"); await clean(f.directory, ["target.txt", "sentinel.txt"]);
});
test("pre-aborted creation does not create a missing parent or call the native commit", async () => {
  const f = await fixture("pre-abort"); const controller = new AbortController(); controller.abort();
  const target = await f.provider.resolve(join(f.directory, "missing-parent", "target.txt"));
  const before = nativeCalls.length;
  await assert.rejects(f.provider.writeText(target, "obsolete", guarded, controller.signal), { code: "FS_ABORTED" });
  assert.equal(nativeCalls.length, before); await clean(f.directory);
});
test("cancellation after fsync removes staging and leaves the target absent", async () => {
  const f = await fixture("staged-abort"); const controller = new AbortController();
  f.provider.internals.inspectTemp = () => controller.abort(); const before = nativeCalls.length;
  await assert.rejects(f.provider.writeText(f.target, "obsolete", guarded, controller.signal), { code: "FS_ABORTED" });
  assert.equal(nativeCalls.length, before); await clean(f.directory);
});
test("cancellation during real lazy native initialization preserves FS_ABORTED and never reaches commit", async () => {
  const { LocalFileSystem: FreshProvider } = await import(pathToFileURL(filename).href + "?lazy-abort");
  const f = await fixture("lazy-abort", { Class: FreshProvider }); const controller = new AbortController();
  const before = nativeCalls.length; let initialized = false;
  bindingHook = () => { initialized = true; controller.abort(); };
  try { await assert.rejects(f.provider.writeText(f.target, "obsolete", guarded, controller.signal), { code: "FS_ABORTED" }); }
  finally { bindingHook = undefined; }
  assert.equal(initialized, true); assert.equal(nativeCalls.length, before); await clean(f.directory);
});
test("observed replacement, literal edit, mode preservation and stale-version checks keep their original path", async () => {
  const f = await fixture("replace-edit"); await f.provider.writeText(f.target, "first line\n", guarded);
  await fsp.chmod(f.target.targetKey, 0o640);
  const before = nativeCalls.length; const version = (await f.provider.stat(f.target)).version;
  await f.provider.writeText(f.target, "second line\n", { kind: "replaceIfVersion", version });
  const next = (await f.provider.stat(f.target)).version;
  await f.provider.editText(f.target, { oldString: "second", newString: "edited", replaceAll: false }, { version: next });
  assert.equal(await f.provider.readText(f.target), "edited line\n");
  assert.equal((await fsp.stat(f.target.targetKey)).mode & 0o777, 0o640); assert.equal(nativeCalls.length, before);
  await assert.rejects(f.provider.writeText(f.target, "stale", { kind: "replaceIfVersion", version }), { code: "FS_STALE_VERSION" });
  await clean(f.directory, ["target.txt"]);
});
for (const [name, result, errno] of [
  ["unexpected success value", 1, 0], ["zero errno", -1, 0], ["fractional errno", -1, 1.5],
  ["negative errno", -1, -13], ["overflow errno", -1, 4096], ["permission denial", -1, 13],
  ["unsupported syscall", -1, 38],
]) {
  test(`injected native ${name} fails closed, cleans staging and never creates a partial target`, async () => {
    const f = await fixture("fault-" + name.replaceAll(" ", "-"));
    nativeFault = { result, errno };
    try { await assert.rejects(f.provider.writeText(f.target, "must not commit", guarded), { code: "FS_IO_ERROR" }); }
    finally { nativeFault = undefined; }
    await clean(f.directory);
  });
}
test("an unavailable native binding fails closed without a link or ordinary rename fallback", async () => {
  const { LocalFileSystem: FreshProvider } = await import(pathToFileURL(filename).href + "?binding-unavailable");
  const f = await fixture("binding-unavailable", { Class: FreshProvider });
  f.provider.internals.linkFile = () => { throw new Error("forbidden fallback"); };
  const before = nativeCalls.length; bindingFault = "fixture native library unavailable";
  try { await assert.rejects(f.provider.writeText(f.target, "must not commit", guarded), { code: "FS_IO_ERROR" }); }
  finally { bindingFault = undefined; }
  assert.equal(nativeCalls.length, before); await clean(f.directory);
});
test("the real patched sandbox provider permits guarded workspace creation and refuses read-only or outside writes", async () => {
  // DSH intentionally permits /tmp writes. Use a missing /proc target to
  // exercise the outside-policy denial without any writable outside fixture.
  // Assert the policy error, rather than a later OS permission/IO failure.
  const f = await fixture("sandbox-workspace", { Provider: SandboxedFileSystem });
  await f.provider.writeText(f.target, "inside\n", guarded);
  assert.equal(await f.provider.readText(f.target), "inside\n");
  const before = nativeCalls.length; const outside = await f.provider.resolve(join("/proc", basename(work) + "-outside.txt"));
  await assert.rejects(f.provider.writeText(outside, "outside", guarded), { code: "FS_SANDBOX_DENIED" });
  await noFile(outside.targetKey); assert.equal(nativeCalls.length, before);
  await assert.rejects(f.provider.writeText(f.target, "readonly", guarded, undefined, { mode: "read-only", workspaceRoot: f.directory }), { code: "FS_SANDBOX_DENIED" });
  assert.equal(await f.provider.readText(f.target), "inside\n"); await clean(f.directory, ["target.txt"]);
});
