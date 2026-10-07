#!/usr/bin/env node
// HOST tests use the actual production WorkspaceCommands and UiWorkspaceService
// bodies with real filesystem and registry storage. Session admission and the
// DOM/React host are controlled fixtures; Android permission/picker requires QA.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { access, lstat, opendir, realpath, mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { posix, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomFillSync } from 'node:crypto';
import vm from 'node:vm';
import { patchAndroidWorkspacePicker } from './patch-android-frontend.mjs';
import { patchAndroidWorkspaceSelectedPath } from './patch-android-workspace.mjs';

const packageRoot = process.argv[2], dependencies = process.argv[3] ?? packageRoot;
if (!packageRoot) throw new Error('usage: test-android-workspace-picker.mjs <dsh-package-directory> [unchanged-dependency-directory]');
const work = await mkdtemp(join(tmpdir(), 'dsh-workspace-picker-test-'));
const scope = join(work, 'node_modules/@deepseek-ai');
const clientFile = join(scope, 'dsh-client-ui-workspace/lib/client.js');
const backendFile = join(scope, 'dsh-api-workspace-controller/lib/index.js');
for (const [file, module] of [[clientFile, 'dsh-client-ui-workspace'], [backendFile, 'dsh-api-workspace-controller']]) {
  await mkdir(join(scope, module, 'lib'), { recursive: true });
  await writeFile(file, await readFile(join(packageRoot, 'node_modules/@deepseek-ai', module, 'lib', module === 'dsh-client-ui-workspace' ? 'client.js' : 'index.js'), 'utf8'));
}
await patchAndroidWorkspacePicker(work);
await patchAndroidWorkspaceSelectedPath(work);
const client = await readFile(clientFile, 'utf8'), backend = await readFile(backendFile, 'utf8');
const bridge = await readFile(new URL('./android-mobile-navigation.js', import.meta.url), 'utf8');
const at = name => import(pathToFileURL(join(dependencies, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const [{ WorkspaceRegistry }, { Context }, { DomainFacility }, { JsonStorageBackend }, { RemoteError, remoteErrorOf }] = await Promise.all([
  at('dsh-workspace'), at('cordis'), at('dsh-storage-domain'), at('dsh-storage-json'), at('dsh-typert-protocol'),
]);
after(async () => rm(work, { recursive: true, force: true }));
function between(source, start, end) {
  assert.equal(source.split(start).length, 2, `one ${start}`);
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(to > from, `boundary ${end}`);
  return source.slice(from, to);
}
const backendBody = between(backend, 'var WorkspaceCommands = class {', '\n//#endregion');
const backendHelper = backend.slice(backend.indexOf('/* dsh-android-workspace-selected-path-v1 */'));
const viewBody = between(backend, 'function workspaceView(workspace) {', '\nfunction changedWorkspaceView(');
function commands(registry, native = true, overrides = {}) {
  const sandbox = {
    process: { platform: native ? 'android' : 'linux', env: { DSH_ANDROID: native ? '1' : '0' } },
    posix, androidWorkspaceAccess: access, androidWorkspaceLstat: lstat,
    androidWorkspaceOpendir: opendir, androidWorkspaceRealpath: realpath,
    androidWorkspaceFsConstants: fsConstants, RemoteError, remoteErrorOf, ...overrides,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${viewBody}\n${backendBody}\n${backendHelper}\nglobalThis.Commands = WorkspaceCommands;`, sandbox);
  return new sandbox.Commands({ workspaceRegistry: registry });
}
function page() {
  const routes = [], children = new Set(), storage = new Map();
  const window = {
    location: { origin: 'http://127.0.0.1:10000', assign: value => routes.push(value) },
    matchMedia: query => ({ matches: true, media: query }),
    crypto: { getRandomValues: array => randomFillSync(array) },
    addEventListener() {}, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  };
  const document = { documentElement: { setAttribute() {}, contains: element => children.has(element) } };
  const sandbox = { window, document, Uint8Array, console, Promise, Error, AbortController, AbortSignal };
  vm.createContext(sandbox); vm.runInContext(bridge, sandbox);
  return { window, sandbox, routes, children, id: () => new URL(routes.at(-1), window.location.origin).searchParams.get('request') };
}
function createSnapshotStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return { getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { snapshot = next; for (const listener of listeners) listener(); } };
}
const settled = () => new Promise(resolve => setImmediate(resolve));
function callbacks() {
  const calls = [];
  return { calls, value: Object.fromEntries(['onSuccess', 'onBrowse', 'onCancel', 'onError'].map(name => [name, (...args) => calls.push([name, ...args])])) };
}
const uiBody = between(client, 'var UiWorkspaceService = class extends _deepseek_ai_cordis.Service {', '\n    function recentWorkspace(');
function uiService(page, { createFailure, sessionFailure, sessionGate, navigationSignal, delayedWorkspaceFeed } = {}) {
  const effects = [], items = [{ workspaceId: 'original-workspace', path: '/original', sessionIds: ['original-session'] }];
  const summaries = { 'original-session': { id: 'original-session', cwd: '/original', blank: false } };
  const wsStore = createSnapshotStore({ phase: 'ready', items, archivedSessionIds: [] });
  const sessionStore = createSnapshotStore({ phase: 'ready', ids: ['original-session'], byId: summaries });
  const history = [], panels = [], drafts = new Map([['original-session', 'original unsent draft']]);
  const workspaces = {
    list: wsStore,
    async create({ path }) {
      history.push(['workspace.create', path]);
      if (createFailure) throw createFailure;
      let workspace = items.find(item => item.path === path);
      if (!workspace) { workspace = { workspaceId: 'selected-workspace', path, sessionIds: [] }; items.push(workspace); }
      wsStore.set({ phase: 'ready', items: [...items], archivedSessionIds: [] });
      return workspace;
    },
  };
  const sessions = {
    list: sessionStore,
    async create({ workspaceId }) {
      history.push(['sessions.create', workspaceId]);
      if (sessionGate) await sessionGate;
      if (sessionFailure) throw sessionFailure;
      const workspace = items.find(item => item.workspaceId === workspaceId);
      if (!delayedWorkspaceFeed) workspace.sessionIds.push('selected-session');
      summaries['selected-session'] = { id: 'selected-session', cwd: workspace.path, blank: true };
      sessionStore.set({ phase: 'ready', ids: Object.keys(summaries), byId: { ...summaries } });
      return 'selected-session';
    },
    retain(id) { history.push(['sessions.retain', id]); return { sessionId: id, release() { history.push(['sessions.release', id]); } }; },
    subagentAddress() {},
  };
  const ctx = { effect: effect => effects.push(effect), layout: { beginNavigation: () => navigationSignal ?? new AbortController().signal, selectPanel: value => panels.push(value) } };
  page.sandbox._deepseek_ai_cordis = { Service: class { constructor(ctx) { this.ctx = ctx; } } };
  // Snapshot persistence and observers are controlled HOST fixtures.
  page.sandbox._deepseek_ai_dsh_client_store = { createSnapshotStore: initial => createSnapshotStore(initial) };
  vm.runInContext(`${uiBody}\nglobalThis.UiService = UiWorkspaceService;`, page.sandbox);
  const service = new page.sandbox.UiService(ctx, {}, workspaces, sessions, {}, () => {});
  service.selection.set({ sessionId: 'original-session' });
  service.mainReference = sessions.retain('original-session');
  // Constructor effect installs actual controller callbacks; initial restoration is
  // disabled in this fixture because a ready original reference was already set.
  const stops = effects.map(effect => effect());
  return { service, history, panels, drafts, cleanup: () => stops.forEach(stop => stop()) };
}

test('production patches are byte-idempotent and damaged installed markers fail closed', async () => {
  await patchAndroidWorkspacePicker(work); await patchAndroidWorkspaceSelectedPath(work);
  assert.equal(await readFile(clientFile, 'utf8'), client); assert.equal(await readFile(backendFile, 'utf8'), backend);
  await writeFile(clientFile, client.replace('stopAndroidWorkspaceChooser();', '/* damaged */'));
  await assert.rejects(patchAndroidWorkspacePicker(work), /damaged/);
  await writeFile(clientFile, client);
  await writeFile(backendFile, backend.replace('await androidWorkspaceAccess(canonical,', 'await wrongAccess(canonical,'));
  await assert.rejects(patchAndroidWorkspaceSelectedPath(work), /damaged/); await writeFile(backendFile, backend);
});

test('unsolicited, wrong request, stale and URI callbacks cannot invoke controllers', async () => {
  const p = page(), cb = callbacks(), calls = [];
  p.window.DshAndroidNavigation.installWorkspaceChooser(path => calls.push(path));
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', 'unknown'), false);
  assert.equal(p.window.DshAndroidNavigation.chooseWorkspace(cb.value), true);
  assert.match(p.id(), /^[a-f0-9]{32}$/);
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', 'unknown'), false);
  for (const path of ['content://provider/tree/primary%3AProjects', 'relative', '/', '/a/../b', '/a/./b', '/a\0b', '/a\nb', '/' + 'a'.repeat(4096)]) assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__(path, p.id()), false);
  assert.equal(p.window.__DSH_ANDROID_WORKSPACE_RESULT__(p.id(), 'cancelled'), true);
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', p.id()), false);
  await settled(); assert.equal(calls.length, 0); assert.equal(cb.calls[0][0], 'onCancel');
});

test('duplicate native callbacks are rejected and controller Promise completion controls success', async () => {
  const p = page(), cb = callbacks(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  p.window.DshAndroidNavigation.installWorkspaceChooser(async () => gate);
  assert.equal(p.window.DshAndroidNavigation.chooseWorkspace(cb.value), true);
  assert.equal(p.window.DshAndroidNavigation.chooseWorkspace(cb.value), false);
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', p.id()), true);
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', p.id()), false);
  assert.equal(p.window.__DSH_ANDROID_WORKSPACE_RESULT__(p.id(), 'cancelled'), false);
  await settled(); assert.equal(cb.calls.length, 0);
  release(); await settled(); assert.deepEqual(cb.calls, [['onSuccess']]);
});

test('original app folder flow and cancellation run no workspace mutation', () => {
  const p = page(), cb = callbacks(); let mutations = 0;
  p.window.DshAndroidNavigation.installWorkspaceChooser(() => mutations++);
  p.window.DshAndroidNavigation.chooseWorkspace(cb.value);
  assert.equal(p.window.__DSH_ANDROID_BROWSE_WORKSPACE__(p.id()), true);
  assert.equal(p.window.__DSH_ANDROID_BROWSE_WORKSPACE__(p.id()), false);
  assert.equal(mutations, 0); assert.deepEqual(cb.calls, [['onBrowse']]);
});

test('controller failure is visible and never reported as successful folder selection', async () => {
  const p = page(), cb = callbacks();
  p.window.DshAndroidNavigation.installWorkspaceChooser(async () => { throw new Error('write permission denied'); });
  p.window.DshAndroidNavigation.chooseWorkspace(cb.value);
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', p.id()), true);
  await settled(); assert.deepEqual(cb.calls, [['onError', 'write permission denied']]);
});

test('disposing the originating controller rejects late results', async () => {
  const p = page(), cb = callbacks(); let select = 0;
  const dispose = p.window.DshAndroidNavigation.installWorkspaceChooser(() => select++);
  p.window.DshAndroidNavigation.chooseWorkspace(cb.value); const id = p.id(); dispose();
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', id), false);
  assert.equal(p.window.__DSH_ANDROID_WORKSPACE_RESULT__(id, 'error', 'permission-denied'), false);
  assert.equal(select, 0); assert.equal(cb.calls.length, 0);
});

test('actual UiWorkspaceService creates selected cwd and closes sidebar only after Session admission succeeds', async () => {
  const p = page(), cb = callbacks(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const state = uiService(p, { sessionGate: gate }); let closed = 0;
  const sidebar = { getBoundingClientRect: () => ({ width: 360, height: 568 }) };
  p.children.add(sidebar); p.window.DshAndroidNavigation.register(sidebar, () => closed++, 10);
  p.window.DshAndroidNavigation.chooseWorkspace(cb.value);
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected-canonical', p.id()), true);
  await settled(); assert.equal(state.service.selection.getSnapshot().sessionId, 'original-session'); assert.equal(closed, 0);
  release(); await settled();
  assert.equal(state.service.selection.getSnapshot().sessionId, 'selected-session');
  assert.equal(closed, 1); assert.deepEqual(cb.calls, [['onSuccess']]);
  assert.deepEqual(state.history.filter(([name]) => name === 'workspace.create' || name === 'sessions.create'), [['workspace.create', '/selected-canonical'], ['sessions.create', 'selected-workspace']]);
  assert.equal(state.drafts.get('original-session'), 'original unsent draft'); state.cleanup();
});
for (const [phase, errors] of [['registration', { createFailure: new Error('unreadable folder') }], ['session admission', { sessionFailure: new Error('session unavailable') }]]) {
  test(`actual UiWorkspaceService ${phase} failure preserves original SID, draft and sidebar`, async () => {
    const p = page(), cb = callbacks(), state = uiService(p, errors); let closed = 0;
    const sidebar = { getBoundingClientRect: () => ({ width: 360, height: 568 }) };
    p.children.add(sidebar); p.window.DshAndroidNavigation.register(sidebar, () => closed++, 10);
    p.window.DshAndroidNavigation.chooseWorkspace(cb.value); p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/failed-canonical', p.id()); await settled();
    assert.equal(state.service.selection.getSnapshot().sessionId, 'original-session');
    assert.equal(state.drafts.get('original-session'), 'original unsent draft'); assert.equal(closed, 0);
    assert.equal(cb.calls.length, 1); assert.equal(cb.calls[0][0], 'onError'); state.cleanup();
  });
}

test('separate Workspace feed may lag a successful actual Session selection', async () => {
  const p = page(), cb = callbacks(), state = uiService(p, { delayedWorkspaceFeed: true });
  p.window.DshAndroidNavigation.chooseWorkspace(cb.value);
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', p.id()), true);
  await settled(); assert.equal(state.service.selection.getSnapshot().sessionId, 'selected-session');
  assert.deepEqual(cb.calls, [['onSuccess']]); state.cleanup();
});

test('interrupted navigation reports failure before replacing the original main Session', async () => {
  const p = page(), cb = callbacks(), navigation = new AbortController(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const state = uiService(p, { sessionGate: gate, navigationSignal: navigation.signal });
  p.window.DshAndroidNavigation.chooseWorkspace(cb.value); p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', p.id());
  await settled(); navigation.abort(); release(); await settled();
  assert.equal(state.service.selection.getSnapshot().sessionId, 'original-session');
  assert.equal(state.drafts.get('original-session'), 'original unsent draft'); assert.equal(state.panels.length, 0);
  assert.equal(cb.calls.length, 1); assert.equal(cb.calls[0][0], 'onError'); state.cleanup();
});

test('a new Controller generation invalidates the old request and admits a fresh one', () => {
  const p = page(), old = callbacks(), fresh = callbacks(); let selects = 0;
  p.window.DshAndroidNavigation.installWorkspaceChooser(() => selects++);
  p.window.DshAndroidNavigation.chooseWorkspace(old.value); const stale = p.id();
  p.window.DshAndroidNavigation.installWorkspaceChooser(() => selects++);
  assert.equal(p.window.__DSH_ANDROID_SELECT_WORKSPACE__('/selected', stale), false);
  assert.equal(p.window.DshAndroidNavigation.chooseWorkspace(fresh.value), true);
  assert.notEqual(p.id(), stale); assert.equal(selects, 0);
});

test('Android backend rejects invalid paths before registry lookup or mutation', async () => {
  let mutations = 0;
  const c = commands({ resolveByPath() { mutations++; }, create() { mutations++; } });
  for (const path of ['', '/', 'relative', 'content://provider/tree/project', '/a/../b', '/a/./b', '/a\0b', '/a\nb', '/' + 'a'.repeat(4096), join(work, 'missing')]) {
    await assert.rejects(c.create({ path }), error => error.code === 'workspace/invalid-path');
  }
  assert.equal(mutations, 0);
});

test('Android backend refuses regular files and an inaccessible real directory without registering', async () => {
  const file = join(work, 'not-directory'), dir = join(work, 'inaccessible');
  await writeFile(file, 'sentinel'); await mkdir(dir);
  let mutations = 0;
  const registry = { resolveByPath() { mutations++; }, create() { mutations++; } };
  await assert.rejects(commands(registry).create({ path: file }), error => error.code === 'workspace/invalid-path');
  await assert.rejects(commands(registry, true, { androidWorkspaceAccess: async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; } }).create({ path: dir }), error => error.code === 'workspace/invalid-path');
  assert.equal(mutations, 0); assert.equal(await readFile(file, 'utf8'), 'sentinel');
});

test('canonical directory read probe precedes real durable registry creation; reopening preserves selected path', async () => {
  const target = join(work, 'shared-project'), alias = join(work, 'shared-link'), store = join(work, 'durable');
  await mkdir(target); await symlink(target, alias); await writeFile(join(target, 'preserve.txt'), 'untouched');
  async function registry() {
    const ctx = new Context(), backend = new JsonStorageBackend(store);
    ctx.reflect.provide('storage', { backend: { get: () => backend } });
    const facility = new DomainFacility(ctx, { backend: 'json' }); ctx.reflect.provide('storageDomain', facility);
    ctx.reflect.provide('sessionPersistence', { async list() { return []; } });
    ctx.reflect.provide('sessions', { list: () => [], get() {} });
    const workspace = new WorkspaceRegistry(ctx);
    // Cordis exposes its actual Service.init symbol; resolve it from the package.
    const { Service } = await at('cordis'); await workspace[Service.init]();
    return { workspace, close: async () => { await facility.closeAll(); await backend.close(); } };
  }
  const first = await registry(); let id;
  try {
    const result = await commands(first.workspace).create({ path: alias }); id = result.workspace.workspaceId;
    assert.equal(result.created, true); assert.equal(result.workspace.path, await realpath(target));
    const again = await commands(first.workspace).create({ path: target }); assert.equal(again.created, false); assert.equal(again.workspace.workspaceId, id);
    assert.equal(first.workspace.list().length, 1);
    assert.equal(await readFile(join(target, 'preserve.txt'), 'utf8'), 'untouched');
  } finally { await first.close(); }
  const reopened = await registry(); try { assert.equal(reopened.workspace.get(id).path, await realpath(target)); } finally { await reopened.close(); }
});

test('desktop backend retains original registry path seam without Android access probes', async () => {
  const paths = [], c = commands({ async resolveByPath(path) { paths.push(path); return { id: 'existing', path, title: '', sessionIds: [], createdAt: 1, updatedAt: 1 }; } }, false, {
    androidWorkspaceRealpath: () => { throw new Error('must not probe'); },
  });
  assert.equal((await c.create({ path: '/desktop-original' })).workspace.path, '/desktop-original'); assert.deepEqual(paths, ['/desktop-original']);
});

test('workspace permission explanation and failures use DSH locale dictionaries and themed primitives', () => {
  const keys = ['title', 'description', 'access', 'limits', 'choose', 'appFolder', 'permissionDenied', 'pickerUnavailable', 'settingsUnavailable', 'unsupportedProvider', 'folderUnavailable', 'requestExpired', 'selectionFailed'];
  for (const locale of ['zh', 'en']) {
    const dictionary = between(client, `const ${locale} = {`, '\n    };');
    for (const key of keys) assert.equal(dictionary.split(`"androidFolder.${key}":`).length, 2);
  }
  const flow = between(client, 'function WorkspacePickFlow(', '\n    function WorkspacePicker(');
  assert.ok(flow.includes('(_deepseek_ai_dsh_client_ui_primitives.Modal'));
  assert.ok(flow.includes('(_deepseek_ai_dsh_client_ui_primitives.Button'));
  assert.ok(flow.includes('t("androidFolder.title")'));
  assert.ok(flow.includes('flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0, width: "100%"'));
  assert.equal(flow.split('minHeight: 44, minWidth: 0, width: "100%"').length, 4);
  assert.equal(flow.split('marginTop: 10, whiteSpace: "normal"').length, 3);
  assert.ok(flow.includes('onCancel: () => { setPickingFolder(false); setAndroidChooserOpen(true); }'));
  assert.equal(flow.includes('AndroidWorkspaceStorageActivity'), false);
});
