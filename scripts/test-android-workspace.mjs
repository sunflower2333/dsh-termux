#!/usr/bin/env node
// HOST integration with real default resolver, browse backend and durable registry.
// Session-agent admission is a fixture; native chooser/UI requires device QA.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, cp, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { patchAndroidWorkspace } from "./patch-android-workspace.mjs";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("usage: test-android-workspace.mjs <dsh-package-directory>");
const work = await mkdtemp(join(tmpdir(), "dsh-android-workspace-test-"));
const scope = join(work, "node_modules/@deepseek-ai");
await mkdir(scope, { recursive: true });
for (const entry of await readdir(join(packageRoot, "node_modules"))) {
  if (entry !== "@deepseek-ai") await symlink(resolve(packageRoot, "node_modules", entry), join(work, "node_modules", entry));
}
for (const entry of await readdir(join(packageRoot, "node_modules/@deepseek-ai"))) {
  const source = resolve(packageRoot, "node_modules/@deepseek-ai", entry);
  if (["dsh-api-workspace-controller", "dsh-host-directory-picker-browse", "dsh-api-session-controller"].includes(entry)) await cp(source, join(scope, entry), { recursive: true });
  else await symlink(source, join(scope, entry));
}
const controllerFile = join(scope, "dsh-api-workspace-controller/lib/index.js");
const browseFile = join(scope, "dsh-host-directory-picker-browse/lib/index.js");
const originalBrowse = await readFile(browseFile, "utf8");
await patchAndroidWorkspace(work);
assert.equal(await readFile(browseFile, "utf8"), originalBrowse, "Termux patch leaves browse behavior byte-identical");
await patchAndroidWorkspace(work, { nativeShell: true });
const patched = await readFile(controllerFile, "utf8");
const patchedBrowse = await readFile(browseFile, "utf8");
await patchAndroidWorkspace(work, { nativeShell: true });
assert.equal(await readFile(controllerFile, "utf8"), patched); assert.equal(await readFile(browseFile, "utf8"), patchedBrowse);
// Export private upstream entry points only from this temporary test copy.
await writeFile(controllerFile, patched + "\nexport { defaultWorkspaceDirectory as testDefaultWorkspaceDirectory };\n");
const sessionFile = join(scope, "dsh-api-session-controller/lib/index.js");
await writeFile(sessionFile, await readFile(sessionFile, "utf8") + "\nexport { SessionCommandController as TestSessionCommands };\n");
const at = name => import(pathToFileURL(join(scope, name, "lib/index.js")));
const [{ testDefaultWorkspaceDirectory: defaultDirectory }, { default: BrowsePicker }, { Context, Service }, { WorkspaceRegistry }, { DomainFacility }, { JsonStorageBackend }, { TestSessionCommands }] = await Promise.all([
  at("dsh-api-workspace-controller"), at("dsh-host-directory-picker-browse"), at("cordis"), at("dsh-workspace"), at("dsh-storage-domain"), at("dsh-storage-json"), at("dsh-api-session-controller"),
]);
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const envKeys = ["DSH_ANDROID", "DSH_ANDROID_DOCUMENTS_DIR", "DSH_ANDROID_DURABLE_ROOT", "DSH_ANDROID_APP_UID"];
const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const app = join(work, "app-data"), docs = join(app, "files/Documents");
await mkdir(docs, { recursive: true }); await writeFile(join(docs, "preserve.txt"), "untouched");
await mkdir(join(work, "outside"));
after(async () => {
  Object.defineProperty(process, "platform", platform);
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(work, { recursive: true, force: true });
});
async function native(task, changes = {}, platformName = "android") {
  Object.defineProperty(process, "platform", { ...platform, value: platformName });
  Object.assign(process.env, { DSH_ANDROID: "1", DSH_ANDROID_DOCUMENTS_DIR: docs, DSH_ANDROID_DURABLE_ROOT: app, DSH_ANDROID_APP_UID: String(process.getuid()) });
  for (const [key, value] of Object.entries(changes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await task(); } finally {
    Object.defineProperty(process, "platform", platform);
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const signal = () => new AbortController().signal;
function picker() { return new BrowsePicker(new Context(), { maxEntries: 1000 }); }
test("native default resolves canonical app Documents/deepseek-harness/default-workspace", async () => native(async () => {
  assert.equal(await defaultDirectory(undefined, signal()), join(await realpath(docs), "deepseek-harness/default-workspace"));
  assert.equal(await readFile(join(docs, "preserve.txt"), "utf8"), "untouched");
}));
test("native browse starts in Documents, not runtime HOME or filesystem root", async () => native(async () => {
  const listing = await picker().list(undefined, signal()); assert.equal(listing.path, docs); assert.equal(listing.home, docs);
  assert.notEqual(listing.path, "/");
}));
for (const value of [undefined, "", "relative/Documents", "content://com.android.externalstorage.documents/tree/primary%3ADocuments", "/", app, join(work, "outside"), join(docs, "preserve.txt")]) {
  test(`invalid native Documents ${String(value)} never falls back`, async () => native(async () => {
    await assert.rejects(defaultDirectory(undefined, signal())); await assert.rejects(picker().list(undefined, signal()));
  }, { DSH_ANDROID_DOCUMENTS_DIR: value }));
}
test("missing native app root or mismatched UID fails instead of browsing HOME", async () => {
  await native(async () => assert.rejects(defaultDirectory(undefined, signal())), { DSH_ANDROID_DURABLE_ROOT: undefined });
  await native(async () => assert.rejects(picker().list(undefined, signal())), { DSH_ANDROID_APP_UID: String(process.getuid() + 1) });
});
test("a linked native Documents directory is refused", async () => {
  const link = join(app, "linked-documents"); await symlink(docs, link);
  await native(async () => assert.rejects(defaultDirectory(undefined, signal())), { DSH_ANDROID_DOCUMENTS_DIR: link });
});
test("cancelled default lookup and browser scan return no fallback directory", async () => native(async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(defaultDirectory(undefined, controller.signal), { name: "AbortError" });
  await assert.rejects(picker().list(undefined, controller.signal), { name: "AbortError" });
}));
test("original Termux Android default behavior remains when native flag is absent", async () => native(async () => {
  assert.equal(await defaultDirectory(undefined, signal(), { home: join(work, "termux-home") }), join(work, "termux-home/Documents/deepseek-harness/default-workspace"));
}, { DSH_ANDROID: "0", DSH_ANDROID_DOCUMENTS_DIR: undefined }));
test("Linux default lookup retains its original host command", async () => native(async () => {
  const calls = [];
  assert.equal(await defaultDirectory(undefined, signal(), { run: async (...args) => { calls.push(args); return { stdout: docs + "\n" }; } }), join(docs, "deepseek-harness/default-workspace"));
  assert.deepEqual(calls[0].slice(0, 2), ["xdg-user-dir", ["DOCUMENTS"]]);
}, {}, "linux"));
test("real browse creates a Documents child and rejects SAF URI paths", async () => native(async () => {
  const browse = picker(), path = await browse.createDirectory(docs, "qa-created-child");
  assert.equal(path, join(docs, "qa-created-child"));
  const listing = await browse.list(docs, signal()); assert.ok(listing.entries.some(entry => entry.path === path));
  await assert.rejects(browse.list("content://example/tree/Documents", signal()));
  await assert.rejects(browse.createDirectory(docs, "../escape"));
}));
async function registry(storageRoot, sessions = new Map()) {
  const ctx = new Context(), backend = new JsonStorageBackend(storageRoot);
  ctx.reflect.provide("storage", { backend: { get: () => backend } });
  const facility = new DomainFacility(ctx, { backend: "json" }); ctx.reflect.provide("storageDomain", facility);
  ctx.reflect.provide("sessionPersistence", { async list() { return [...sessions.values()].map(session => ({ header: session.header })); } });
  ctx.reflect.provide("sessions", { list: () => [...sessions.values()], get: id => sessions.get(id) });
  const workspace = new WorkspaceRegistry(ctx); await workspace[Service.init]();
  return { ctx, workspace, close: async () => { await facility.closeAll(); await backend.close(); } };
}
test("real registry persists default and child Workspace across reopening without changing original path", async () => {
  const store = join(work, "registry-store"), first = await registry(store);
  let initial, child;
  try {
    initial = await native(() => first.workspace.initializeDefault(() => defaultDirectory(undefined, signal())));
    child = await first.workspace.create(join(docs, "qa-created-child"));
    assert.notEqual(initial.id, child.id);
    assert.equal((await first.workspace.initializeDefault(() => { throw new Error("must reuse default"); })).id, initial.id);
    assert.equal(initial.path, join(docs, "deepseek-harness/default-workspace"));
    await assert.rejects(first.workspace.create("content://example/tree/Documents"));
    assert.equal(first.workspace.list().length, 2, "invalid selection does not replace or create a fallback");
  } finally { await first.close(); }
  const reopened = await registry(store);
  try { assert.equal(reopened.workspace.get(initial.id).path, initial.path); assert.equal(reopened.workspace.get(child.id).path, child.path); }
  finally { await reopened.close(); }
});
test("real Session create command uses selected canonical Workspace cwd and preserves another session", async () => {
  const sessions = new Map(), state = await registry(join(work, "session-registry-store"), sessions);
  try {
    const originalWorkspace = await state.workspace.create(docs), child = await state.workspace.create(join(docs, "qa-created-child"));
    const agents = {
      async ensureSession(id, cwd) {
        let session = sessions.get(id);
        if (session && session.header.cwd !== cwd) throw new Error("fixture refuses cwd reassignment");
        if (!session) { session = { header: { id, cwd } }; sessions.set(id, session); }
        return { session };
      },
      presetForSession() {},
    };
    const commands = new TestSessionCommands(state.ctx, agents, "/unused-fallback");
    const first = await commands.create({ workspaceId: originalWorkspace.id });
    const second = await commands.create({ workspaceId: child.id });
    assert.equal(sessions.get(first.sessionId).header.cwd, docs);
    assert.equal(sessions.get(second.sessionId).header.cwd, child.path);
    assert.deepEqual(originalWorkspace.sessionIds, [first.sessionId]); assert.deepEqual(child.sessionIds, [second.sessionId]);
    assert.equal((await commands.create({ workspaceId: child.id, sessionId: second.sessionId })).sessionId, second.sessionId);
    assert.equal(sessions.get(first.sessionId).header.cwd, docs);
  } finally { await state.close(); }
});
