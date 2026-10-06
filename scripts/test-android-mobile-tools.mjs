#!/usr/bin/env node
// HOST integration tests against the real installed DSH services, with a fixture native socket.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, symlink, copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { patchAndroidMobileTools } from "./patch-android-mobile-tools.mjs";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("usage: node scripts/test-android-mobile-tools.mjs <dsh-package-directory>");
const work = await mkdtemp(join(tmpdir(), "dsh-mobile-tools-test-"));
await symlink(resolve(packageRoot, "node_modules"), join(work, "node_modules"));
await copyFile(new URL("./android-mobile-tools.mjs", import.meta.url), join(work, "helper.mjs"));
const moduleAt = name => import(pathToFileURL(resolve(packageRoot, "node_modules/@deepseek-ai", name, "lib/index.js")));
const [{ Context }, { SystemPrompt }, { ToolRuntime }, { LocalAttachmentStore }, { createScope }, { LlmRuntime, LlmAdapter, createUserMessage }, plugin] = await Promise.all([
  moduleAt("cordis"), moduleAt("dsh-system-prompt"), moduleAt("dsh-tools"), moduleAt("dsh-attachment-local"), moduleAt("dsh-scope"), moduleAt("dsh-llm"), import(pathToFileURL(join(work, "helper.mjs"))),
]);
const { LIMITS, createMobileTransport } = plugin;
const oldEnv = Object.fromEntries(["DSH_ANDROID", "DSH_ANDROID_MOBILE_SOCKET", "DSH_ANDROID_MOBILE_TOKEN"].map(key => [key, process.env[key]]));
const resources = [];
after(async () => {
  for (const close of resources.reverse()) await close();
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(work, { recursive: true, force: true });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TOKEN = randomBytes(32).toString("hex"); // Fixture credentials only, never printed.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
const names = ["mobile_status", "mobile_observe", "mobile_click", "mobile_type", "mobile_swipe", "mobile_back", "mobile_stop"];
const SESSION = randomUUID();
function status(active = true) { return { enabled: true, connected: true, active, sessionId: active ? SESSION : null, reason: active ? "user_grant" : "user_paused", currentPackage: "fixture.screen" }; }
function observation(args) {
  return { sessionId: args.sessionId, observationId: randomUUID(), sampledAtMs: Date.now(), display: { widthPx: 360, heightPx: 640, rotation: 0 },
    window: { id: 1, packageName: "fixture.screen" }, nodes: [
      { id: "n0", className: "Button", viewId: "fixture:id/button", packageName: "fixture.screen", bounds: { left: 0, top: 0, right: 100, bottom: 44 }, text: "Open", clickable: true, editable: false, password: false },
      { id: "n1", className: "EditText", viewId: "fixture:id/input", packageName: "fixture.screen", bounds: { left: 0, top: 44, right: 100, bottom: 88 }, text: "old", clickable: true, editable: true, password: false },
      { id: "n2", className: "EditText", viewId: "fixture:id/password", packageName: "fixture.screen", bounds: { left: 0, top: 88, right: 100, bottom: 132 }, text: "fixture-secret", description: "fixture-secret", clickable: true, editable: true, password: true },
    ], truncated: false, screenshotRequested: args.screenshot, screenshot: args.screenshot ? { mimeType: "image/png", base64: png.toString("base64"), widthPx: 1, heightPx: 1, capturedAtMs: Date.now() } : null };
}
function androidClippedObservation(args, omitClippedNodes) {
  // Geometry reproduced from the actual h28 Android 11 Settings response:
  // 720x1280, window 1127, 50 nodes; nodes 31..49 had top > bottom.
  // Other node data is fixture data; no captured screen text is retained.
  const value = observation(args);
  value.sampledAtMs = 9938035;
  value.display = { widthPx: 720, heightPx: 1280, rotation: 0 };
  value.window = { id: 1127, packageName: "com.android.settings" };
  value.nodes = Array.from({ length: 31 }, (_, index) => ({
    id: `n${index}`, className: index === 30 ? "android.widget.EditText" : "android.widget.TextView",
    viewId: `com.android.settings:id/fixture_${index}`, packageName: "com.android.settings",
    bounds: { left: 0, top: index * 40, right: 720, bottom: index * 40 + 40 },
    text: `Fixture node ${index}`, description: `Fixture description ${index} 🌻`,
    clickable: true, editable: index === 30, password: false,
  }));
  if (!omitClippedNodes) {
    const captured = [
      [144, 1298, 688], [0, 1344, 720], [144, 1344, 267], [144, 1344, 584],
      [0, 1344, 720], [144, 1344, 259], [144, 1344, 429], [0, 1344, 720],
      [144, 1344, 280], [144, 1344, 386], [0, 1344, 720], [144, 1344, 325],
      [144, 1344, 681], [0, 1344, 720], [144, 1344, 250], [144, 1344, 573],
      [0, 1344, 720], [144, 1344, 471], [144, 1344, 492],
    ];
    value.nodes.push(...captured.map(([left, top, right], index) => ({
      id: `n${index + 31}`, className: "android.widget.TextView", viewId: "", packageName: "com.android.settings",
      bounds: { left, top, right, bottom: 1280 }, clickable: false, editable: false, password: false,
    })));
  }
  return value;
}
async function bridge(handler) {
  const socket = "dsh-mobile-test-" + randomBytes(12).toString("hex");
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const call = { path: req.url, method: req.method, auth: req.headers.authorization, args: JSON.parse(Buffer.concat(parts).toString("utf8")) };
    calls.push(call);
    if (call.auth !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: TOKEN } })); return; }
    try {
      const result = await handler(call, res);
      if (result !== undefined && !res.destroyed) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); }
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: { code: "internal", message: TOKEN } })); } }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen("\0" + socket, resolve); });
  resources.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, server, env: { DSH_ANDROID_MOBILE_SOCKET: socket, DSH_ANDROID_MOBILE_TOKEN: TOKEN } };
}
async function runtime(handler, { modalities = ["text"], android = true, modelInfoError = false } = {}) {
  const native = await bridge(handler ?? (call => {
    const action = call.path.split("/").at(-1);
    return { ok: true, value: action === "observe" ? observation(call.args) : action === "status" || action === "stop" ? status(action !== "stop") : { performed: true, action, observationId: call.args.observationId } };
  }));
  Object.assign(process.env, native.env, { DSH_ANDROID: android ? "1" : "0" });
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(work, "home-" + randomUUID()) });
  const resolutions = [];
  await ctx.plugin(LlmRuntime);
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model, signal) {
      signal?.throwIfAborted(); resolutions.push({ provider, model });
      if (modelInfoError) throw new Error("fixture metadata unavailable");
      return { provider, id: model, name: model, ...(modalities === null ? {} : { inputModalities: modalities }) };
    }
    async *stream() { throw new Error("No external model requests are permitted by this fixture."); }
  }
  const adapter = new FixtureAdapter();
  ctx.llm.registerAdapter(["fixture-provider", "fallback"], adapter);
  const fiber = ctx.plugin(plugin);
  await fiber;
  const presetKey = { id: "standard-fixture" };
  const preset = createScope(ctx, presetKey);
  const agent = { id: randomUUID(), options: { provider: "fallback", model: "fallback-model" }, session: { requestHeader: () => ({ config: { provider: "fixture-provider", model: "fixture-model" } }) } };
  const scoped = createScope(preset.ctx, agent, { parent: presetKey });
  resources.push(async () => { await scoped.dispose(); await preset.dispose(); await ctx.fiber.dispose(); });
  const execute = (name, args = {}, signal = new AbortController().signal, owner = agent) => ctx.tools.execute({ name, arguments: args, callId: randomUUID(), signal, agent: owner });
  const observe = async () => {
    const result = await execute("mobile_observe", { sessionId: SESSION });
    assert.equal(result.isError, false, JSON.stringify(result.error)); return result.value;
  };
  return { ctx, agent, execute, observe, native, resolutions, fiber, adapter };
}
function code(result) { return result.error?.info?.code; }

test("APK patch uses the real web-app plugin entry, is idempotent, and preserves canonical input", async () => {
  const originalPath = resolve(packageRoot, "node_modules/@deepseek-ai/dsh-web-app/lib/index.js");
  const before = await readFile(originalPath, "utf8");
  const fixture = join(work, "patched-package");
  const lib = join(fixture, "node_modules/@deepseek-ai/dsh-web-app/lib");
  await mkdir(lib, { recursive: true });
  await writeFile(join(fixture, "node_modules/@deepseek-ai/dsh-web-app/package.json"), '{"type":"module"}');
  await writeFile(join(lib, "index.js"), before);
  await patchAndroidMobileTools(fixture);
  const first = await readFile(join(lib, "index.js"), "utf8");
  const helper = await readFile(join(lib, "android-mobile-tools.js"));
  await patchAndroidMobileTools(fixture);
  assert.equal(await readFile(join(lib, "index.js"), "utf8"), first);
  assert.deepEqual(await readFile(join(lib, "android-mobile-tools.js")), helper);
  assert.equal(await readFile(originalPath, "utf8"), before);
  assert.equal(first.match(/ctx\.plugin\(AndroidMobileTools\)/g).length, 1);
  const entry = await import(pathToFileURL(join(lib, "index.js")));
  let captured;
  const sentinel = new Error("fixture-capture");
  process.env.DSH_ANDROID = "1";
  assert.throws(() => entry.apply({ plugin(module) { captured = module; throw sentinel; } }, {}), error => error === sentinel);
  assert.equal(captured.name, "android-mobile-tools");
  captured = undefined;
  process.env.DSH_ANDROID = "0";
  assert.throws(() => entry.apply({ plugin(module) { captured = module; } }, {}));
  assert.equal(captured, undefined);
  await writeFile(join(lib, "index.js"), before.replace("function apply(ctx, config) {", "function apply_changed(ctx, config) {"));
  await assert.rejects(patchAndroidMobileTools(fixture), /Unsupported/);
});
test("real DSH prompt/tool registry exposes all seven tools through standing preset and agent scopes without secrets", async () => {
  const r = await runtime();
  const assembly = await r.ctx.systemPrompt.assemble({ scope: r.agent });
  assert.deepEqual(assembly.tools.map(tool => tool.name).filter(name => names.includes(name)).sort(), [...names].sort());
  assert.match(JSON.stringify(assembly), /tools:android-mobile/);
  const publicSurface = JSON.stringify(assembly);
  assert.ok(!publicSurface.includes(TOKEN) && !publicSurface.includes(r.native.env.DSH_ANDROID_MOBILE_SOCKET));
  for (const name of names) {
    const tool = r.ctx.tools.get(name, r.agent);
    assert.ok(tool); assert.equal(tool.isConcurrencySafe({}), false);
    assert.ok(!JSON.stringify(tool.parameters).includes("token"));
  }
  let policyCount = 0;
  r.ctx.on("tools/pre-execute", (_exec, _next) => { policyCount++; return { kind: "deny", reason: "fixture existing policy" }; });
  const denied = await r.execute("mobile_status");
  assert.equal(denied.isError, true); assert.equal(policyCount, 1); assert.equal(r.native.calls.length, 0);
});
test("the actual DSH AgentLoop discovers, dispatches and logs mobile tools through its model request/result cycle", async () => {
  const r = await runtime(undefined, { modalities: ["text", "image"] });
  const [{ AgentRegistry }, { SessionStore }, { SessionProjectionRegistry }, { AgentLoop }] = await Promise.all([
    moduleAt("dsh-agent"), moduleAt("dsh-session"), moduleAt("dsh-session-projection"), moduleAt("dsh-agent-loop"),
  ]);
  await r.ctx.plugin(AgentRegistry);
  await r.ctx.plugin(SessionStore);
  await r.ctx.plugin(SessionProjectionRegistry);
  await r.ctx.plugin(AgentLoop, {});
  const requests = [];
  const errors = [];
  r.ctx.on("agent/error", event => errors.push(event.error ?? event));
  r.adapter.stream = async function* (request) {
    requests.push(request);
    const step = requests.length;
    assert.deepEqual(request.tools.map(tool => tool.name).filter(name => names.includes(name)).sort(), [...names].sort());
    const previous = request.messages.filter(message => message.role === "tool").at(-1);
    const value = previous === undefined ? undefined : JSON.parse(previous.content.find(block => block.type === "text").text.split("\n")[0]);
    const calls = [
      ["mobile_status", {}], ["mobile_observe", { sessionId: value?.sessionId }],
      ["mobile_click", { sessionId: value?.sessionId, observationId: value?.observationId, nodeId: "n0" }],
      ["mobile_observe", { sessionId: SESSION }], ["mobile_stop", {}],
    ];
    if (step <= calls.length) {
      if (step === 3 || step === 5) assert.ok(previous.content.some(block => block.type === "image" && block.attachment.attachmentId));
      const [name, args] = calls[step - 1];
      const id = randomUUID();
      const block = { type: "tool-call", id, name, arguments: JSON.stringify(args) };
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: block.arguments };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    } else {
      assert.equal(step, 6);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "Fixture mobile task stopped." };
      yield { type: "block-end", index: 0, block: { type: "text", text: "Fixture mobile task stopped." } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  };
  const agent = await r.ctx.agentLoop.create("mobile-loop-" + randomUUID(), { provider: "fixture-provider", model: "fixture-model" });
  assert.equal(r.ctx.agents.get(agent.id), agent);
  agent.followup(createUserMessage({ content: [{ type: "text", text: "Fixture only: observe, click Open, verify, then stop." }] }));
  let timer;
  try { await Promise.race([agent.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => { agent.cancel({ kind: "user" }); reject(new Error("Fixture AgentLoop did not complete within 5 seconds.")); }, 5000); })]); }
  finally { clearTimeout(timer); }
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 6);
  const log = agent.session.snapshotEvents();
  assert.deepEqual(log.filter(event => event.type === "tool/call").map(event => event.data.name), ["mobile_status", "mobile_observe", "mobile_click", "mobile_observe", "mobile_stop"]);
  assert.equal(log.filter(event => event.type === "tool/result").length, 5);
  assert.deepEqual(r.native.calls.map(call => call.path.split("/").at(-1)), ["status", "observe", "click", "observe", "stop"]);
  assert.ok(!JSON.stringify(log).includes(TOKEN) && !JSON.stringify(log).includes(png.toString("base64")));
});
test("desktop/Termux never registers mobile tools", async () => {
  const r = await runtime(undefined, { android: false });
  assert.deepEqual((await r.ctx.systemPrompt.assemble({ scope: r.agent })).tools.filter(tool => names.includes(tool.name)), []);
  assert.equal(r.native.calls.length, 0);
});
test("status/stop use authenticated real UDS POSTs and reflect native grant, including paused state", async () => {
  const r = await runtime();
  const current = await r.execute("mobile_status");
  assert.equal(current.isError, false); assert.deepEqual(current.value, status());
  const stopped = await r.execute("mobile_stop");
  assert.equal(stopped.isError, false); assert.equal(stopped.value.active, false); assert.equal(stopped.value.sessionId, null);
  assert.match(stopped.content[0].text, /Mobile control/);
  for (const call of r.native.calls) { assert.equal(call.method, "POST"); assert.deepEqual(call.args, {}); assert.equal(call.auth, `Bearer ${TOKEN}`); }
});
test("nonvision, unknown and unresolved model routes request no screenshot and return only real nodes", async () => {
  for (const options of [{ modalities: ["text"] }, { modalities: null }, { modelInfoError: true }]) {
    const r = await runtime(undefined, options);
    const value = await r.observe();
    assert.deepEqual(r.resolutions, [{ provider: "fixture-provider", model: "fixture-model" }]);
    assert.equal(r.native.calls[0].args.screenshot, false); assert.equal(value.screenshotRequested, false);
    assert.equal(value.screenshotOmittedReason, "text_only_model"); assert.equal(value.image, undefined);
    assert.equal(value.nodes[0].text, "Open"); assert.equal(value.nodes[2].text, undefined); assert.equal(value.nodes[2].description, undefined);
  }
});
test("vision observation stores a real durable DSH image attachment and renders its actual reference, without base64", async () => {
  const r = await runtime(undefined, { modalities: ["text", "image"] });
  const result = await r.execute("mobile_observe", { sessionId: SESSION });
  assert.equal(result.isError, false, JSON.stringify(result.error));
  const image = result.value.image;
  assert.ok(image.attachmentId); assert.equal(image.width, 1); assert.equal(image.height, 1);
  assert.equal(r.native.calls[0].args.screenshot, true);
  const stored = await r.ctx.attachments.readImage(image);
  assert.ok(stored);
  assert.equal(createHash("sha256").update(await readFile(r.ctx.attachments.imageHostPath(image))).digest("hex"), createHash("sha256").update(png).digest("hex"));
  assert.deepEqual(result.content.find(block => block.type === "image").attachment, image);
  assert.ok(!JSON.stringify(result).includes(png.toString("base64")) && !JSON.stringify(result).includes(TOKEN));
});
test("all action variants bind fresh observation, enforce coordinates/text/password limits, and require verification", async () => {
  const r = await runtime();
  for (const [action, extra] of [["click", { nodeId: "n0" }], ["click", { x: 359.5, y: 639.5 }], ["type", { nodeId: "n1", text: "replacement 🌻" }], ["swipe", { fromX: 0, fromY: 10, toX: 359, toY: 639, durationMs: 300 }], ["back", {}]]) {
    const value = await r.observe();
    const args = { sessionId: SESSION, observationId: value.observationId, ...extra };
    const result = await r.execute("mobile_" + action, args);
    assert.equal(result.isError, false, JSON.stringify(result.error)); assert.equal(result.value.verificationRequired, true);
    assert.deepEqual(r.native.calls.at(-1).args, args);
    const stale = await r.execute("mobile_" + action, args);
    assert.equal(code(stale), "MOBILE_STALE_OBSERVATION");
  }
  const invalid = [
    ["click", { nodeId: "n0", x: 1, y: 1 }], ["click", { x: 360, y: 0 }], ["click", { x: -1, y: 0 }], ["click", { nodeId: "n999" }],
    ["type", { nodeId: "n0", text: "not editable" }], ["type", { nodeId: "n1", text: "x".repeat(4097) }],
    ["type", { nodeId: "n1", text: "\0" }], ["type", { nodeId: "n1", text: "\ud800" }], ["swipe", { fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 99 }],
  ];
  for (const [action, extra] of invalid) {
    const value = await r.observe(); const count = r.native.calls.length;
    assert.equal(code(await r.execute("mobile_" + action, { sessionId: SESSION, observationId: value.observationId, ...extra })), "MOBILE_INVALID_REQUEST");
    assert.equal(r.native.calls.length, count);
  }
  const value = await r.observe();
  assert.equal(code(await r.execute("mobile_type", { sessionId: SESSION, observationId: value.observationId, nodeId: "n2", text: "blocked" })), "MOBILE_PASSWORD_FIELD");
  const other = { ...r.agent, id: randomUUID() };
  assert.equal(code(await r.execute("mobile_back", { sessionId: SESSION, observationId: value.observationId }, undefined, other)), "MOBILE_STALE_OBSERVATION");
});
test("native errors propagate stable safe codes; failed dispatched actions invalidate the observation", async () => {
  const r = await runtime(call => call.path.endsWith("/observe") ? { ok: true, value: observation(call.args) } : { ok: false, error: { code: "paused", message: TOKEN + " sensitive server detail" } });
  const value = await r.observe();
  const args = { sessionId: SESSION, observationId: value.observationId };
  const failed = await r.execute("mobile_back", args);
  assert.equal(code(failed), "MOBILE_PAUSED"); assert.match(failed.content[0].text, /Mobile control/); assert.ok(!JSON.stringify(failed).includes(TOKEN));
  assert.equal(code(await r.execute("mobile_back", args)), "MOBILE_STALE_OBSERVATION");
  const errors = await bridge(call => ({ ok: false, error: { code: call.args.fixtureCode, message: TOKEN } }));
  for (const nativeCode of ["timeout", "no_window", "not_enabled", "not_editable", "not_visible", "unknown_node", "invalid_display", "secure_window", "screenshot_failed", "screen_too_large", "response_too_large", "action_cancelled", "forbidden"]) {
    await assert.rejects(createMobileTransport(errors.env)("status", { fixtureCode: nativeCode }), error => error.code === "MOBILE_" + nativeCode.toUpperCase() && !error.message.includes(TOKEN));
  }
});
test("malformed native observations and screenshots fail before attachment/model output", async () => {
  for (const mutate of [v => { v.nodes = Array(1001).fill(v.nodes[0]); }, v => { v.nodes[0].text = "x".repeat(2049); }, v => { v.sessionId = randomUUID(); }, v => { v.screenshot.base64 = "bad!"; }, v => { v.screenshot.widthPx = 2; }]) {
    const r = await runtime(call => { const value = observation(call.args); mutate(value); return { ok: true, value }; }, { modalities: ["image"] });
    const result = await r.execute("mobile_observe", { sessionId: SESSION });
    assert.equal(code(result), "MOBILE_INVALID_RESPONSE"); assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});
test("actual Android 11 clipped offscreen geometry is rejected without granting an action binding", async () => {
  const r = await runtime(call => ({ ok: true, value: androidClippedObservation(call.args, false) }));
  const result = await r.execute("mobile_observe", { sessionId: SESSION });
  assert.equal(r.native.calls[0].args.screenshot, false);
  assert.equal(code(result), "MOBILE_INVALID_RESPONSE");
  assert.equal(result.error.message, "The native mobile bridge returned an invalid or oversized response.");
  assert.ok(!result.content.some(block => block.type === "image"));
  const actionsBefore = r.native.calls.length;
  const stale = await r.execute("mobile_click", { sessionId: SESSION, observationId: randomUUID(), nodeId: "n0" });
  assert.equal(code(stale), "MOBILE_STALE_OBSERVATION");
  assert.equal(r.native.calls.length, actionsBefore);
});
test("native omission of clipped nodes preserves retained IDs, descriptions, action binding and real PNG attachments", async () => {
  for (const modalities of [["text"], ["text", "image"]]) {
    let issued;
    const r = await runtime(call => {
      const action = call.path.split("/").at(-1);
      if (action === "observe") {
        issued = androidClippedObservation(call.args, true);
        return { ok: true, value: issued };
      }
      return { ok: true, value: { performed: true, action, observationId: call.args.observationId } };
    }, { modalities });
    const result = await r.execute("mobile_observe", { sessionId: SESSION });
    assert.equal(result.isError, false, JSON.stringify(result.error));
    assert.equal(result.value.nodes.length, 31);
    assert.deepEqual(result.value.nodes, issued.nodes);
    assert.deepEqual(result.value.nodes.map(node => node.id), Array.from({ length: 31 }, (_, index) => `n${index}`));
    assert.deepEqual(result.value.display, { widthPx: 720, heightPx: 1280, rotation: 0 });
    assert.deepEqual(result.value.window, { id: 1127, packageName: "com.android.settings" });
    assert.equal(result.value.screenshotRequested, modalities.includes("image"));
    if (modalities.includes("image")) {
      const image = result.value.image;
      assert.ok(image.attachmentId);
      assert.equal(image.width, 1); assert.equal(image.height, 1);
      assert.deepEqual(result.content.find(block => block.type === "image").attachment, image);
      assert.deepEqual(await readFile(r.ctx.attachments.imageHostPath(image)), png);
    } else {
      assert.equal(result.value.screenshotOmittedReason, "text_only_model");
      assert.equal(result.value.image, undefined);
      assert.ok(!result.content.some(block => block.type === "image"));
    }
    assert.ok(!JSON.stringify(result).includes(png.toString("base64")) && !JSON.stringify(result).includes(TOKEN));
    const binding = { sessionId: SESSION, observationId: result.value.observationId };
    const callsBefore = r.native.calls.length;
    assert.equal(code(await r.execute("mobile_click", { ...binding, nodeId: "n31" })), "MOBILE_INVALID_REQUEST");
    assert.equal(r.native.calls.length, callsBefore);
    const typed = await r.execute("mobile_type", { ...binding, nodeId: "n30", text: "Fixture replacement" });
    assert.equal(typed.isError, false, JSON.stringify(typed.error));
    assert.deepEqual(r.native.calls.at(-1).args, { ...binding, nodeId: "n30", text: "Fixture replacement" });
  }
});
test("bounded FIFO serializes actual UDS requests and cancels a queued call before dispatch", async () => {
  let active = 0, maximum = 0;
  const r = await runtime(async () => { active++; maximum = Math.max(maximum, active); await sleep(80); active--; return { ok: true, value: status() }; });
  const first = r.execute("mobile_status");
  const cancel = new AbortController();
  const second = r.execute("mobile_status", {}, cancel.signal);
  const third = r.execute("mobile_status");
  await sleep(20); cancel.abort();
  const results = await Promise.all([first, second, third]);
  assert.equal(results[0].isError, false); assert.equal(results[2].isError, false); assert.equal(results[1].isError, true);
  assert.equal(maximum, 1); assert.equal(r.native.calls.length, 2);
});
test("transport rejects wrong/missing credentials, caps response bytes, rejects bad envelopes, and honors abort/deadline", async () => {
  const good = await bridge(() => ({ ok: true, value: status() }));
  await assert.rejects(createMobileTransport({ ...good.env, DSH_ANDROID_MOBILE_TOKEN: "0".repeat(64) })("status", {}), error => error.code === "MOBILE_UNAUTHORIZED" && !error.message.includes(TOKEN));
  await assert.rejects(createMobileTransport({})("status", {}), { code: "MOBILE_UNAVAILABLE" });
  await assert.rejects(createMobileTransport({ ...good.env, DSH_ANDROID_MOBILE_SOCKET: "../../socket" })("status", {}), { code: "MOBILE_UNAVAILABLE" });
  assert.equal(good.calls.length, 1);
  for (const handler of [(_call, res) => { res.writeHead(200, { "Content-Length": LIMITS.responseBytes + 1 }); res.end(); }, (_call, res) => { res.writeHead(200); res.end("not json"); }, () => ({ ok: true, value: null })]) {
    const b = await bridge(handler);
    await assert.rejects(createMobileTransport(b.env)("status", {}), { code: "MOBILE_INVALID_RESPONSE" });
  }
  const slow = await bridge(async () => { await sleep(200); return { ok: true, value: status() }; });
  await assert.rejects(createMobileTransport(slow.env, { deadlineMs: 30 })("status", {}), { code: "MOBILE_TIMEOUT" });
  const controller = new AbortController();
  const pending = createMobileTransport(slow.env)("status", {}, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { code: "MOBILE_ABORTED" });
  assert.equal((await createMobileTransport(good.env)("status", {})).active, true);
});
