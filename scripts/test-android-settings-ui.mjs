#!/usr/bin/env node
// HOST tests of the real staged settings patch and private-port transport.
// Native system screens, physical gestures and layout still require device QA.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { patchAndroidSettingsUi } from "./patch-android-settings-ui.mjs";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("usage: test-android-settings-ui.mjs <dsh-package-directory>");
const productionSource = await readFile(join(packageRoot, "node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js"), "utf8");
const productionIndex = await readFile(join(packageRoot, "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html"), "utf8");
const helperSource = await readFile(new URL("./android-settings-ui.js", import.meta.url), "utf8");
const work = await mkdtemp(join(tmpdir(), "dsh-android-settings-ui-test-"));
after(() => rm(work, { recursive: true, force: true }));
let fixtureCount = 0;
async function fixture(source = productionSource, index = productionIndex) {
  const root = join(work, String(++fixtureCount));
  const module = join(root, "node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js");
  const dist = join(root, "node_modules/@deepseek-ai/dsh-web-frontend/dist");
  await mkdir(join(root, "node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib"), { recursive: true });
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(module, source); await writeFile(join(dist, "index.html"), index);
  return { root, module, dist };
}
const actual = await fixture();
await patchAndroidSettingsUi(actual.root);
const patched = await readFile(actual.module, "utf8");
const nextIndex = await readFile(join(actual.dist, "index.html"), "utf8");
new vm.Script(patched, { filename: "actual-patched-settings-general-client.js" });

function status(changes = {}) {
  const result = {
    mobile: { enabled: true, connected: true, active: false, reason: "user_paused", currentPackage: "com.android.settings", feedback: true, canAllow: true },
    runtime: { hostRunning: true, connected: true, running: 2, waiting: 1, sessions: [], sessionsComplete: true },
    notifications: { enabled: true, permissionRequired: false, permissionGranted: true, channelsDisabled: false },
    battery: { unrestricted: false }
  };
  for (const [key, value] of Object.entries(changes)) Object.assign(result[key], value);
  return result;
}

function session(changes = {}) {
  return { sessionId: "qa-session-one", name: "QA conversation", state: "running", turns: 3, steps: 8, sessionTokens: 7680,
    inputTokens: 2048, outputTokens: 512, totalTokens: 2560, cachedInputTokens: 1024, cacheWriteTokens: 0,
    tokensPerSecond: 42.125, contextUsed: 4096, contextCapacity: 16384, ...changes };
}

function localeOwner(initial) {
  let active = initial, revision = 0, stops = 0;
  const listeners = new Set();
  return {
    getSnapshot() { return { active, locales: [{ id: "en" }, { id: "zh" }], revision }; },
    subscribe(listener) { listeners.add(listener); return () => { stops++; listeners.delete(listener); }; },
    change(value) { active = value; revision++; for (const listener of [...listeners]) listener(); },
    get stops() { return stops; }, get subscribers() { return listeners.size; }
  };
}

function transport() {
  const events = new Map(); const timers = new Map();
  let timerId = 0;
  const document = { visibilityState: "visible", addEventListener(type, callback) { events.set("document:" + type, callback); } };
  const window = {
    location: { origin: "http://127.0.0.1:8765" },
    addEventListener(type, callback) { events.set("window:" + type, callback); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, kind: "timeout" }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, kind: "interval" }); return id; },
    clearInterval(id) { timers.delete(id); }
  };
  vm.runInNewContext(helperSource, { window, document, Promise, Object, Number, Error, TypeError });
  function port() {
    return { sent: [], closed: false, started: false, close() { this.closed = true; }, start() { this.started = true; }, postMessage(raw) { this.sent.push(JSON.parse(raw)); } };
  }
  function connect(endpoint, changes = {}) {
    events.get("window:message")({ data: "dsh.android.settings.port.v1", source: null, origin: "", ports: [endpoint], ...changes });
  }
  function respond(endpoint, value) { endpoint.onmessage({ data: JSON.stringify(value) }); }
  return { window, document, events, timers, api: window.DshAndroidSettings, port, connect, respond };
}

test("real production sections compile, embed original DSH primitives and remove native page launches", () => {
  assert.ok(patched.includes('_deepseek_ai_dsh_client_ui_primitives.Button'));
  assert.ok(patched.includes('_deepseek_ai_dsh_client_ui_primitives.Switch'));
  assert.ok(patched.includes('id: "android-mobile-use"'));
  assert.ok(patched.includes('id: "android-runtime"'));
  assert.ok(!patched.includes('window.location.assign("/__dsh_android__/mobile-control")'));
  assert.ok(!patched.includes('window.location.assign("/__dsh_android__/runtime-settings")'));
  assert.equal(nextIndex.split('data-dsh-android-settings').length, 2);
  assert.ok(!patched.includes("返回 DSH"));
});

test("patch is byte-idempotent including helper and index", async () => {
  const helperBefore = await readFile(join(actual.dist, "assets/dsh-android-settings-ui.js"), "utf8");
  await patchAndroidSettingsUi(actual.root);
  assert.equal(await readFile(actual.module, "utf8"), patched);
  assert.equal(await readFile(join(actual.dist, "index.html"), "utf8"), nextIndex);
  assert.equal(await readFile(join(actual.dist, "assets/dsh-android-settings-ui.js"), "utf8"), helperBefore);
  assert.equal(helperBefore, helperSource);
});

test("missing production controller and damaged dictionaries fail before writing", async () => {
  for (const source of [patched.replace("const { close, openSection } = actions;", "const { close } = actions;"),
    patched.replace('"androidSettings.on": "On"', '"androidSettings.on": "BROKEN"'),
    patched.replace('function AndroidMobileUseSection({ t }) {', 'function BrokenAndroidSection({ t }) {')]) {
    const f = await fixture(source); await assert.rejects(patchAndroidSettingsUi(f.root));
    assert.equal(await readFile(f.module, "utf8"), source);
    assert.equal(await readFile(join(f.dist, "index.html"), "utf8"), productionIndex);
  }
});

test("duplicate or unknown index hooks fail before changing the module", async () => {
  for (const index of [productionIndex.replace("<head>", "<head><head>"),
    productionIndex.replace("<head>", '<head><script data-dsh-android-settings src="unrecognized.js"></script>')]) {
    const f = await fixture(productionSource, index); await assert.rejects(patchAndroidSettingsUi(f.root));
    assert.equal(await readFile(f.module, "utf8"), productionSource);
  }
});

test("only a native main-document port with allowed origin is accepted", () => {
  const t = transport();
  for (const change of [{ source: {} }, { origin: "https://foreign.example" }, { ports: [] }, { data: "dsh.android.theme.port.v1" }]) {
    const p = t.port(); t.connect(p, change); assert.equal(t.api.getSnapshot().connected, false);
  }
  const p = t.port(); t.connect(p); assert.equal(t.api.getSnapshot().connected, true); assert.equal(p.started, true);
  assert.equal(p.sent.length, 0, "a closed settings panel never polls");
});

test("visible section mount polls once and valid response strips nonpublic native payload", () => {
  const t = transport(), p = t.port(); t.connect(p); let updates = 0;
  const stop = t.api.subscribe(() => updates++);
  assert.equal(p.sent.length, 1); assert.equal(p.sent[0].type, "status");
  const value = status(); value.sessionId = "never-render"; value.mobile.nonce = "never-render";
  t.respond(p, { id: p.sent[0].id, ok: true, status: value });
  const snapshot = t.api.getSnapshot();
  assert.equal(snapshot.status.mobile.active, false); assert.equal(snapshot.status.runtime.running, 2);
  assert.equal(snapshot.status.sessionId, undefined); assert.equal(snapshot.status.mobile.nonce, undefined);
  assert.equal(Object.isFrozen(snapshot.status.mobile), true); assert.equal(updates, 1);
  stop(); assert.equal([...t.timers.values()].filter(item => item.kind === "interval").length, 0);
});

test("polling is bounded, paused while hidden, and refreshed on return", () => {
  const t = transport(), p = t.port(); t.connect(p); const stop = t.api.subscribe(() => {});
  const interval = [...t.timers.values()].find(item => item.kind === "interval");
  assert.equal(interval.ms, 2000); interval.fn(); interval.fn();
  assert.equal(p.sent.length, 1, "no second status request while the first is outstanding");
  t.respond(p, { id: p.sent[0].id, ok: true, status: status() });
  t.document.visibilityState = "hidden"; t.events.get("document:visibilitychange")();
  assert.equal([...t.timers.values()].filter(item => item.kind === "interval").length, 0);
  t.events.get("window:focus")(); assert.equal(p.sent.length, 1);
  t.document.visibilityState = "visible"; t.events.get("document:visibilitychange")();
  assert.equal(p.sent.length, 2); stop();
});

test("untrusted DOM commands and malformed feedback never reach native", async () => {
  const t = transport(), p = t.port(); t.connect(p);
  for (const [type, enabled, event, code] of [
    ["allow-control", undefined, { isTrusted: false }, "user_gesture_required"],
    ["open-accessibility", undefined, null, "user_gesture_required"],
    ["set-feedback", "true", { isTrusted: true }, "invalid_request"],
    ["allow-control", true, { isTrusted: true }, "invalid_request"],
    ["run-command", undefined, { isTrusted: true }, "invalid_request"]
  ]) await assert.rejects(t.api.request(type, enabled, event), { message: code });
  assert.equal(p.sent.length, 0);
});

test("trusted real UI actions send strict messages and use native authoritative state", async () => {
  const t = transport(), p = t.port(); t.connect(p);
  const result = t.api.request("allow-control", undefined, { isTrusted: true });
  assert.deepEqual(p.sent[0], { id: "settings-1", type: "allow-control" });
  assert.equal(t.api.getSnapshot().status, null, "no optimistic permission grant");
  t.respond(p, { id: "settings-1", ok: true, status: status({ mobile: { active: true, reason: "user_grant", canAllow: false } }) });
  assert.equal((await result).mobile.active, true);
  const feedback = t.api.request("set-feedback", false, { isTrusted: true });
  assert.deepEqual(p.sent[1], { id: "settings-2", type: "set-feedback", enabled: false });
  t.respond(p, { id: "settings-2", ok: true, status: status({ mobile: { feedback: false } }) });
  assert.equal((await feedback).mobile.feedback, false);
});

test("unknown response IDs, malformed status and native strings cannot inject state", async () => {
  const t = transport(), p = t.port(); t.connect(p);
  t.respond(p, { id: "unrequested", ok: true, status: status() }); assert.equal(t.api.getSnapshot().status, null);
  const request = t.api.request("allow-control", undefined, { isTrusted: true });
  t.respond(p, { id: p.sent[0].id, ok: true, status: status({ mobile: { currentPackage: "中文私密信息" } }) });
  await assert.rejects(request, { message: "unavailable" }); assert.equal(t.api.getSnapshot().status, null);
  const failed = t.api.request("open-battery", undefined, { isTrusted: true });
  t.respond(p, { id: p.sent[1].id, ok: false, error: "private exception body" });
  await assert.rejects(failed, { message: "unavailable" }); assert.equal(t.api.getSnapshot().error, "unavailable");
});

test("validated resume pushes update only public state", () => {
  const t = transport(), p = t.port(); t.connect(p);
  t.respond(p, { id: null, ok: true, status: status({ notifications: { enabled: false, permissionRequired: true, permissionGranted: false } }) });
  assert.equal(t.api.getSnapshot().status.notifications.permissionGranted, false);
  t.respond(p, { id: null, ok: true, status: status({ mobile: { reason: "unexpected native text" } }) });
  assert.equal(t.api.getSnapshot().status.mobile.reason, "user_paused");
});

test("a closed native port cannot publish stale state after a replacement", () => {
  const t = transport(), old = t.port(); t.connect(old);
  const next = t.port(); t.connect(next);
  t.respond(next, { id: null, ok: true, status: status({ mobile: { active: false } }) });
  t.respond(old, { id: null, ok: true, status: status({ mobile: { active: true } }) });
  assert.equal(t.api.getSnapshot().status.mobile.active, false);
});

test("missing native handshake shows bounded failure and panel unmount clears its timer", () => {
  const t = transport(); const stop = t.api.subscribe(() => {});
  const handshake = [...t.timers.values()].find(item => item.kind === "timeout");
  assert.equal(handshake.ms, 8000); handshake.fn();
  assert.equal(t.api.getSnapshot().error, "unavailable");
  stop(); assert.equal([...t.timers.values()].filter(item => item.kind === "interval").length, 0);
  const other = transport(); const stopOther = other.api.subscribe(() => {}); stopOther();
  assert.equal(other.timers.size, 0);
});

test("port replacement and page exit reject outstanding commands and stop polling", async () => {
  const t = transport(), p = t.port(); t.connect(p); t.api.subscribe(() => {});
  const first = t.api.request("open-accessibility", undefined, { isTrusted: true });
  const replacement = t.port(); t.connect(replacement); await assert.rejects(first, { message: "unavailable" });
  assert.equal(p.closed, true);
  const second = t.api.request("pause-control", undefined, { isTrusted: true });
  t.events.get("window:pagehide")(); await assert.rejects(second, { message: "unavailable" });
  assert.equal(replacement.closed, true); assert.equal(t.api.getSnapshot().status, null);
  assert.equal(t.timers.size, 0);
});

test("request timeout clears stale permission state and total outstanding messages are bounded", async () => {
  const t = transport(), p = t.port(); t.connect(p);
  const requests = Array.from({ length: 4 }, () => t.api.request("open-battery", undefined, { isTrusted: true }));
  await assert.rejects(t.api.request("open-battery", undefined, { isTrusted: true }), { message: "unavailable" });
  for (const item of [...t.timers.values()]) item.fn();
  for (const request of requests) await assert.rejects(request, { message: "unavailable" });
  assert.equal(t.api.getSnapshot().status, null); assert.equal(t.api.getSnapshot().error, "unavailable");
});

const dictionaries = Object.fromEntries(["zh", "en"].map(language => {
  const match = new RegExp(`    const ${language} = (\\{[\\s\\S]*?\\n    \\});`).exec(patched);
  return [language, JSON.parse(match[1])];
}));
function renderSection(name, locale, nativeStatus, overrides = {}, openSession) {
  const start = patched.indexOf('    const androidSettingsStyleId = ');
  const end = patched.indexOf('    function GeneralSection({ renderSlot }) {', start);
  const code = patched.slice(start, end);
  const capturedStyles = [];
  const doc = { querySelector() { return null; }, createElement() { return { dataset: {} }; }, head: { appendChild(tag) { capturedStyles.push(tag.textContent); } } };
  const requests = [];
  const host = { subscribe() { return () => {}; }, getSnapshot() { return { connected: true, status: nativeStatus, error: null, ...overrides }; }, request(type, enabled, event) { requests.push({ type, enabled, event }); return Promise.resolve(nativeStatus); } };
  const jsx = (type, props) => ({ type, props });
  const stateWrites = [];
  const react = { useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); }, useState(initial) { return [initial, value => stateWrites.push(value)]; }, useRef(value) { return { current: value }; }, useEffect() {} };
  const components = vm.runInNewContext(code + '\n({ AndroidMobileUseSection, AndroidRuntimeSection })', {
    window: { DshAndroidSettings: host, __DSH_ANDROID_OPEN_SESSION__: openSession }, document: doc, navigator: { language: "zh-CN" }, react,
    react_jsx_runtime: { jsx, jsxs: jsx }, _deepseek_ai_dsh_client_ui_primitives: { Button: "DSH.Button", Switch: "DSH.Switch" }, Promise, setTimeout
  });
  const dictionary = dictionaries[locale];
  const t = (key, args = {}) => {
    assert.ok(key in dictionary, `missing ${locale}.${key}`);
    return dictionary[key].replace(/\{(\w+)\}/g, (_, key) => String(args[key]));
  };
  const tree = components[name]({ t });
  const nodes = [], text = [];
  function visit(node) {
    if (node == null || node === false) return;
    if (typeof node === "string" || typeof node === "number") { text.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node.type === "function") { visit(node.type(node.props)); return; }
    nodes.push(node); visit(node.props.children);
  }
  visit(tree); assert.equal(requests.length, 0, "rendering must not mutate Android");
  return { tree, nodes, text: text.join(" "), styles: capturedStyles, requests, stateWrites };
}

test("live previews are automatic and do not add an app-level toggle", () => {
  const page = renderSection("AndroidRuntimeSection", "en", status());
  assert.equal(page.text.includes("Live update settings"), false);
  assert.equal(page.text.includes("Fluid Cloud"), false);
  assert.equal(page.nodes.some(node => node.props?.["data-dsh-android-action"] === "open-live-updates"), false);
  const native = status({ notifications: { enabled: true, permissionRequired: false, permissionGranted: true } });
  assert.ok(renderSection("AndroidRuntimeSection", "zh", native).text.includes("通知"));
});

test("real sections use English DSH labels even when Android locale is Chinese", () => {
  for (const name of ["AndroidMobileUseSection", "AndroidRuntimeSection"]) {
    const page = renderSection(name, "en", status());
    assert.equal(/[\u3400-\u9fff]/.test(page.text), false);
    assert.ok(page.nodes.filter(node => node.type === "DSH.Button").length >= 2);
    assert.ok(page.styles[0].includes("var(--dsw-alias-label-primary)"));
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(page.styles[0]), "no independent light/dark palette");
  }
  const mobile = renderSection("AndroidMobileUseSection", "en", status());
  assert.ok(mobile.text.includes("Accessibility service"));
  assert.ok(mobile.text.includes("Paused"));
  assert.ok(mobile.nodes.some(node => node.type === "DSH.Switch" && node.props.label === "Show action feedback"));
});

test("Chinese status, locked state, unknown state and all fixed errors are translated by DSH", () => {
  assert.ok(renderSection("AndroidMobileUseSection", "zh", status({ mobile: { reason: "device_locked", canAllow: false } })).text.includes("设备已锁定"));
  assert.ok(renderSection("AndroidRuntimeSection", "zh", null).text.includes("正在读取状态"));
  for (const error of ["user_gesture_required", "control_unavailable", "settings_unavailable", "permission_request_pending", "unavailable"]) {
    const zh = renderSection("AndroidMobileUseSection", "zh", status(), { error });
    const en = renderSection("AndroidMobileUseSection", "en", status(), { error });
    assert.ok(/[\u3400-\u9fff]/.test(zh.text)); assert.equal(/[\u3400-\u9fff]/.test(en.text), false);
    assert.ok(!en.text.includes(error));
  }
});

test("buttons follow actual permissions and Android13 permission request label", () => {
  const paused = renderSection("AndroidMobileUseSection", "en", status());
  const button = (page, type) => page.nodes.find(node => node.type === "DSH.Button" && node.props["data-dsh-android-action"] === type);
  assert.equal(button(paused, "allow-control").props.disabled, false);
  assert.equal(button(paused, "pause-control").props.disabled, true);
  const active = renderSection("AndroidMobileUseSection", "en", status({ mobile: { active: true, canAllow: false } }));
  assert.equal(button(active, "allow-control").props.disabled, true);
  assert.equal(button(active, "pause-control").props.disabled, false);
  const denied = renderSection("AndroidRuntimeSection", "en", status({ notifications: { enabled: false, permissionRequired: true, permissionGranted: false, channelsDisabled: true } }));
  assert.ok(denied.text.includes("Allow notifications")); assert.ok(denied.text.includes("Some notification categories"));
});

test("DSH feedback retains the native click across capture/bubble microtasks, consumes it once and expires it", async () => {
  const page = renderSection("AndroidMobileUseSection", "en", status());
  const event = { isTrusted: true };
  const button = page.nodes.find(node => node.type === "DSH.Button" && node.props["data-dsh-android-action"] === "open-accessibility");
  button.props.onClick(event);
  assert.equal(page.requests[0].type, "open-accessibility"); assert.equal(page.requests[0].event, event);
  const wrapper = page.nodes.find(node => node.props.className === "dshAndroidSettingsToggle");
  const control = page.nodes.find(node => node.type === "DSH.Switch");
  const reactCapture = { isTrusted: true, nativeEvent: event };
  wrapper.props.onClickCapture(reactCapture);
  await Promise.resolve();
  reactCapture.isTrusted = null;
  control.props.onChange(false);
  assert.equal(page.requests[1].type, "set-feedback"); assert.equal(page.requests[1].enabled, false);
  assert.equal(page.requests[1].event, event, "real native click survives the browser microtask boundary and React event recycling");
  control.props.onChange(true);
  assert.equal(page.requests[2].event, null, "the captured click is consumed once");
  wrapper.props.onClickCapture({ isTrusted: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  control.props.onChange(true);
  assert.equal(page.requests[3].event, null, "an unused capture expires before a later task");
});

test("legacy settings route opener uses live DSH actions, rejects invalid kinds and cleans up", () => {
  const anchor = '      const { close, openSection } = actions;';
  const start = patched.indexOf(anchor);
  const end = patched.indexOf('      const [requestedOnboarding', start);
  const calls = [], cleanups = [], window = { DshAndroidSettings: {}, DshAndroidNavigation: { closeSidebar() { calls.push("close-sidebar"); } } };
  vm.runInNewContext(patched.slice(start, end), { actions: { close() {}, openSection(id) { calls.push(id); } }, window, react: { useEffect(effect) { cleanups.push(effect()); } } });
  assert.equal(window.__DSH_ANDROID_OPEN_SETTINGS__("mobile"), true);
  assert.equal(window.__DSH_ANDROID_OPEN_SETTINGS__("runtime"), true);
  assert.equal(window.__DSH_ANDROID_OPEN_SETTINGS__("bad"), false);
  assert.deepEqual(calls, ["android-mobile-use", "close-sidebar", "android-runtime", "close-sidebar"]);
  cleanups[0](); assert.equal(window.__DSH_ANDROID_OPEN_SETTINGS__, undefined);
});

test("session summaries preserve nullable real SDK metrics, freeze state, and strip arbitrary content", () => {
  const t = transport(), p = t.port(); t.connect(p);
  const item = session({ outputTokens: null, totalTokens: null, tokensPerSecond: null, contextCapacity: null });
  item.prompt = "must-not-retain"; item.apiKey = "must-not-retain";
  t.respond(p, { id: null, ok: true, status: status({ runtime: { sessions: [item], sessionsComplete: false } }) });
  const saved = t.api.getSnapshot().status.runtime;
  assert.equal(saved.sessionsComplete, false); assert.equal(saved.sessions[0].outputTokens, null);
  assert.equal(saved.sessions[0].inputTokens, 2048); assert.equal(saved.sessions[0].prompt, undefined);
  assert.equal(saved.sessions[0].apiKey, undefined); assert.equal(Object.isFrozen(saved.sessions), true);
  assert.equal(Object.isFrozen(saved.sessions[0]), true);
});

test("session IDs, names, nullable counts and throughput are validated before accepting a native snapshot", () => {
  for (const item of [session({ sessionId: "../outside" }), session({ name: "private\nline" }), session({ turns: -1 }),
    session({ steps: 1.5 }), session({ sessionTokens: -1 }), session({ inputTokens: undefined }), session({ outputTokens: "512" }),
    session({ totalTokens: Number.MAX_SAFE_INTEGER + 1 }), session({ cachedInputTokens: -1 }), session({ cacheWriteTokens: -1 }),
    session({ contextUsed: -1 }), session({ contextCapacity: 0 }), session({ tokensPerSecond: -1 }),
    session({ tokensPerSecond: 1000000000001 }), session({ state: "raw native exception" })]) {
    const t = transport(), p = t.port(); t.connect(p);
    t.respond(p, { id: null, ok: true, status: status({ runtime: { sessions: [item] } }) });
    assert.equal(t.api.getSnapshot().status, null);
  }
  const t = transport(), p = t.port(); t.connect(p);
  t.respond(p, { id: null, ok: true, status: status({ runtime: { sessions: [session(), session()] } }) });
  assert.equal(t.api.getSnapshot().status, null, "duplicate IDs cannot replace another session card");
  t.respond(p, { id: null, ok: true, status: status({ runtime: { sessionsComplete: undefined } }) });
  assert.equal(t.api.getSnapshot().status, null, "completeness must be explicit");
  const overflow = JSON.stringify({ id: null, ok: true, status: status({ runtime: { sessions: [session()] } }) }).replace('"tokensPerSecond":42.125', '"tokensPerSecond":1e999');
  p.onmessage({ data: overflow }); assert.equal(t.api.getSnapshot().status, null, "an overflowing JSON number is rejected");
});

test("each running or waiting session renders its own actual metrics and localized scope", () => {
  const native = status({ runtime: { sessions: [session(), session({ sessionId: "qa-session-two", name: null, state: "waiting", turns: 12, steps: 31 })] } });
  const en = renderSection("AndroidRuntimeSection", "en", native);
  assert.equal(en.nodes.filter(node => node.props.className === "dshAndroidSession").length, 2);
  assert.ok(en.text.includes("QA conversation")); assert.ok(en.text.includes("Untitled conversation"));
  assert.ok(en.text.includes("Cumulative turns")); assert.ok(en.text.includes("Latest step uncached input tokens"));
  assert.ok(en.text.includes("Session token consumption")); assert.ok(en.text.includes("7,680"));
  assert.ok(en.text.includes("2,560")); assert.ok(en.text.includes("42.1 tok/s"));
  assert.ok(en.text.includes("1,024 tokens · 33.3%")); assert.ok(en.text.includes("4,096 / 16,384 tokens · 25%"));
  assert.ok(en.text.includes("latest completed step's provider statistics"));
  assert.equal(en.text.includes("qa-session-one"), false, "private identifier is not visible text");
  assert.equal(/[\u3400-\u9fff]/.test(en.text), false, "current DSH English ignores Chinese OS locale");
  const zh = renderSection("AndroidRuntimeSection", "zh", native);
  assert.ok(zh.text.includes("累计轮次")); assert.ok(zh.text.includes("最近步骤总 token"));
  assert.ok(zh.text.includes("未报告的数据不作估算"));
});

test("missing SDK values are unavailable, actual zero is zero, and no unknown capacity creates a percentage", () => {
  const nulls = session({ turns: null, steps: null, sessionTokens: null, inputTokens: null, outputTokens: null, totalTokens: null,
    cachedInputTokens: null, cacheWriteTokens: null, tokensPerSecond: null, contextUsed: 4096, contextCapacity: null });
  const page = renderSection("AndroidRuntimeSection", "en", status({ runtime: { sessions: [nulls] } }));
  assert.ok(page.text.includes("Unavailable")); assert.ok(page.text.includes("4,096 tokens"));
  assert.equal(page.text.includes("%"), false); assert.equal(page.text.includes("0 tok/s"), false);
  const zero = session({ turns: 0, steps: 0, sessionTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cachedInputTokens: 0, cacheWriteTokens: 0, tokensPerSecond: 0, contextUsed: 0, contextCapacity: null });
  const zeroPage = renderSection("AndroidRuntimeSection", "en", status({ runtime: { sessions: [zero] } }));
  assert.ok(zeroPage.text.includes("0 tok/s")); assert.ok(zeroPage.text.includes("0 cached tokens"));
  assert.equal(zeroPage.text.includes("%"), false, "zero input never fabricates a cache-hit denominator");
});

test("SDK disjoint input/cache buckets use the full actual denominator and session consumption stays cumulative", () => {
  const metric = (page, name) => page.nodes.find(node => node.props["data-dsh-android-metric"] === name).props.children[1].props.children;
  const real = session({ inputTokens: 100, cachedInputTokens: 2000, cacheWriteTokens: 300,
    outputTokens: 400, totalTokens: 2800, sessionTokens: 5600, contextUsed: 2400, contextCapacity: 8000 });
  const page = renderSection("AndroidRuntimeSection", "en", status({ runtime: { sessions: [real] } }));
  assert.equal(metric(page, "cacheHit"), "2,000 tokens · 83.3%");
  assert.equal(metric(page, "sessionTokens"), "5,600"); assert.equal(metric(page, "totalTokens"), "2,800");
  assert.equal(metric(page, "context"), "2,400 / 8,000 tokens · 30%");
  for (const changes of [{ cacheWriteTokens: null }, { inputTokens: null },
    { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 1, cacheWriteTokens: 0 }]) {
    const partial = renderSection("AndroidRuntimeSection", "en", status({ runtime: { sessions: [session(changes)] } }));
    assert.equal(metric(partial, "cacheHit").includes("%"), false, "a missing or overflowing bucket never fabricates cache-hit percentage");
  }
  const context = renderSection("AndroidRuntimeSection", "en", status({ runtime: { sessions: [session({ contextUsed: null, contextCapacity: 8000 })] } }));
  assert.equal(metric(context, "context"), "Capacity 8,000 tokens · usage unavailable");
});

test("incomplete or disconnected session lists do not claim there are no active tasks", () => {
  const partial = renderSection("AndroidRuntimeSection", "en", status({ runtime: { sessionsComplete: false } }));
  assert.ok(partial.text.includes("Conversations not shown may still be running"));
  assert.equal(partial.text.includes("No active conversations"), false);
  const disconnected = renderSection("AndroidRuntimeSection", "en", status({ runtime: { connected: false, running: 0, waiting: 0 } }));
  assert.ok(disconnected.text.includes("Conversation details are unavailable"));
  const idle = renderSection("AndroidRuntimeSection", "en", status({ runtime: { connected: true, running: 0, waiting: 0, sessionsComplete: true } }));
  assert.ok(idle.text.includes("No active conversations"));
});

test("a finished session disappears on a fresh native snapshot and replayed old response cannot restore it", () => {
  const t = transport(), p = t.port(); t.connect(p); t.api.subscribe(() => {});
  const id = p.sent[0].id;
  t.respond(p, { id, ok: true, status: status({ runtime: { sessions: [session()] } }) });
  assert.equal(t.api.getSnapshot().status.runtime.sessions.length, 1);
  t.respond(p, { id: null, ok: true, status: status({ runtime: { sessions: [], running: 0, waiting: 0 } }) });
  t.respond(p, { id, ok: true, status: status({ runtime: { sessions: [session()] } }) });
  assert.equal(t.api.getSnapshot().status.runtime.sessions.length, 0);
});

test("session buttons use the existing Controller-owned exact-session opener and never issue a permission command", () => {
  const calls = [], original = status({ runtime: { sessions: [session()] } });
  const before = JSON.stringify(original);
  const page = renderSection("AndroidRuntimeSection", "en", original, {}, id => { calls.push(id); return true; });
  const button = page.nodes.find(node => node.type === "DSH.Button" && "data-dsh-android-open-session" in node.props);
  assert.equal(button.props.disabled, false);
  button.props.onClick({ isTrusted: false }); assert.equal(calls.length, 0);
  button.props.onClick({ isTrusted: true }); assert.deepEqual(calls, ["qa-session-one"]);
  assert.equal(page.requests.length, 0); assert.equal(JSON.stringify(original), before);
  const unavailable = renderSection("AndroidRuntimeSection", "en", original, {}, () => false);
  unavailable.nodes.find(node => node.type === "DSH.Button" && "data-dsh-android-open-session" in node.props).props.onClick({ isTrusted: true });
  assert.deepEqual(unavailable.stateWrites, [false, true], "failed opener shows local error without creating a session");
});

test("native language follows actual DSH locale even while settings panels are closed", () => {
  const t = transport(), dsh = localeOwner("zh"); t.api.installLocale(dsh);
  const p = t.port(); t.connect(p);
  assert.deepEqual(p.sent, [{ id: "settings-1", type: "sync-language", locale: "zh" }]);
  assert.equal([...t.timers.values()].filter(item => item.kind === "interval").length, 0);
  assert.equal(t.api.getSnapshot().status, null, "synchronization does not invent Android state");
  t.respond(p, { id: p.sent[0].id, ok: true, status: status() });
  assert.equal(t.api.getSnapshot().status.mobile.active, false, "language command never grants phone control");
});

test("locale changes coalesce to the newest actual language and dictionary revisions do not spam native", async () => {
  const t = transport(), p = t.port(), dsh = localeOwner("zh"); t.connect(p); t.api.installLocale(dsh);
  dsh.change("en"); dsh.change("en"); assert.equal(p.sent.length, 1, "one outstanding language message");
  t.respond(p, { id: p.sent[0].id, ok: true, status: status() });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(p.sent[1], { id: "settings-2", type: "sync-language", locale: "en" });
  t.respond(p, { id: p.sent[1].id, ok: true, status: status() });
  await Promise.resolve(); await Promise.resolve(); dsh.change("en");
  assert.equal(p.sent.length, 2);
});

test("unknown DSH language falls back to English and a new native port resynchronizes without old-port replay", async () => {
  const t = transport(), old = t.port(), dsh = localeOwner("custom-locale"); t.connect(old); t.api.installLocale(dsh);
  assert.equal(old.sent[0].locale, "en");
  const next = t.port(); t.connect(next);
  assert.deepEqual(next.sent[0], { id: "settings-2", type: "sync-language", locale: "en" });
  t.respond(old, { id: old.sent[0].id, ok: true, status: status({ mobile: { active: true } }) });
  assert.equal(t.api.getSnapshot().status, null);
  t.respond(next, { id: next.sent[0].id, ok: true, status: status() });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(t.api.getSnapshot().status.mobile.active, false); assert.equal(next.sent.length, 1);
});

test("replacing or disposing the global locale owner releases only its own subscription", async () => {
  const t = transport(), p = t.port(); t.connect(p);
  const first = localeOwner("zh"), next = localeOwner("en");
  const stopFirst = t.api.installLocale(first); const stopNext = t.api.installLocale(next);
  assert.equal(first.stops, 1); assert.equal(first.subscribers, 0); stopFirst();
  assert.equal(first.stops, 1); assert.equal(next.subscribers, 1);
  t.respond(p, { id: p.sent[0].id, ok: true, status: status() }); await Promise.resolve(); await Promise.resolve();
  assert.equal(p.sent[1].locale, "en");
  t.respond(p, { id: p.sent[1].id, ok: true, status: status() }); await Promise.resolve(); await Promise.resolve();
  stopNext(); next.change("zh"); assert.equal(next.stops, 1); assert.equal(next.subscribers, 0);
  assert.equal(p.sent.length, 2);
});

test("real settings plugin globally installs its actual LocaleFace independently from section rendering", () => {
  const start = patched.indexOf('      const t = ctx.locale.bind(NS);');
  const end = patched.indexOf('      const documentController', start);
  assert.ok(start >= 0 && end > start, "real production global locale hook boundaries exist");
  const code = patched.slice(start, end);
  assert.ok(code.includes("Android global language synchronization"));
  const owner = localeOwner("zh"), bound = [], effects = [], cleanups = [], calls = [];
  owner.bind = ns => { bound.push(ns); return () => "DSH translation"; };
  const ctx = { locale: owner, effect(effect, name) { effects.push(name); cleanups.push(effect()); } };
  const window = { DshAndroidSettings: { installLocale(actual) { calls.push(actual); return () => calls.push("dispose"); } } };
  vm.runInNewContext(code, { ctx, NS: "settings", window });
  assert.deepEqual(bound, ["settings"]); assert.equal(calls[0], owner);
  assert.equal(effects.length, 1); cleanups[0](); assert.equal(calls[1], "dispose");
});
