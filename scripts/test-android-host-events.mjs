#!/usr/bin/env node
// Actual DSH AgentLoop/services; only the model adapter and native UDS are fixtures.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { patchAndroidHostEvents } from "./patch-android-host-events.mjs";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("usage: node scripts/test-android-host-events.mjs <real-dsh-package-directory>");
const work = await mkdtemp(join(tmpdir(), "dsh-host-events-test-"));
await symlink(resolve(packageRoot, "node_modules"), join(work, "node_modules"));
await copyFile(new URL("./android-host-events.mjs", import.meta.url), join(work, "helper.mjs"));
const HostEvents = await import(pathToFileURL(join(work, "helper.mjs")));
const { createHostEventTransport, createNotificationTransport, observeHostEvents, registerNotificationTool } = HostEvents;
const moduleAt = name => import(pathToFileURL(resolve(packageRoot, "node_modules/@deepseek-ai", name, "lib/index.js")));
const [{ Context }, { SystemPrompt }, { ToolRuntime, defineTool }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
  { LlmRuntime, LlmAdapter, createUserMessage }, { AgentLoop }, { UserQuestionService, UserQuestionError }, { ApprovalService }, AskUser] = await Promise.all([
  moduleAt("cordis"), moduleAt("dsh-system-prompt"), moduleAt("dsh-tools"), moduleAt("dsh-agent"), moduleAt("dsh-session"), moduleAt("dsh-session-projection"),
  moduleAt("dsh-llm"), moduleAt("dsh-agent-loop"), moduleAt("dsh-user-questions"), moduleAt("dsh-user-approval"), moduleAt("dsh-tool-ask-user"),
]);
const resources = [];
after(async () => { for (const close of resources.reverse()) await close(); await rm(work, { recursive: true, force: true }); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = "condition", timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error(`Timeout awaiting ${label}`); await sleep(5); }
}
function gate() { return Promise.withResolvers(); }
const marker = "PRIVATE_FIXTURE_PROMPT_NOT_FOR_NOTIFICATIONS";
async function nativeBridge(handler = (_payload, _res, path) => ({ ok: true, value: path === "/android/notify" ? { posted: true } : { accepted: true } })) {
  const socket = "dsh-events-test-" + randomBytes(10).toString("hex"), token = randomBytes(32).toString("hex");
  const calls = [], requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.ok(req.url === "/android/events" || req.url === "/android/notify"); assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, `Bearer ${token}`);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); calls.push(payload); requests.push({ path: req.url, payload });
    const value = await handler(payload, res, req.url);
    if (value !== undefined && !res.destroyed) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen("\0" + socket, resolve); });
  resources.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, requests, token, env: { DSH_ANDROID_MOBILE_SOCKET: socket, DSH_ANDROID_MOBILE_TOKEN: token } };
}
async function runtime({ mode = "legacy", policy = "ask", native, heartbeatMs = 15000, notices = false } = {}) {
  native ??= await nativeBridge();
  const ctx = new Context();
  for (const [plugin, config] of [[SystemPrompt, {}], [ToolRuntime, {}], [AgentRegistry], [SessionStore], [SessionProjectionRegistry], [LlmRuntime], [UserQuestionService], [ApprovalService, { policy }]]) await ctx.plugin(plugin, config);
  const questions = gate(), approvals = gate(), busy = gate();
  const errors = [], resolutions = [], modelSteps = new Map();
  ctx.on("agent/error", event => errors.push(event.error), { global: true });
  ctx.on("user-questions/request", request => {
    if (mode === "timed") return Promise.reject(new UserQuestionError("No connected fixture UI", "NO_PROVIDER"));
    return Promise.race([questions.promise, new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new UserQuestionError("Cancelled fixture", "ASK_ABORTED")), { once: true }))]);
  }, { global: true });
  ctx.on("approval/request", () => approvals.promise, { global: true });
  ctx.tools.register(defineTool({ name: "fixture_approval", description: "Harmless fixture only.", parameters: {},
    output: { schema: { type: "object", additionalProperties: false, properties: { granted: { type: "boolean", required: true } } }, render: (_, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(_, exec) { const outcome = await ctx.approval.request({ agent: exec.agent, signal: exec.signal, callId: exec.callId, toolName: "fixture_approval", reason: marker }); resolutions.push(outcome); return { granted: outcome === "allowed-once" }; },
  }));
  await ctx.plugin(AskUser, { mode, timeout: 1 });
  if (notices) registerNotificationTool(ctx, createNotificationTransport(native.env));
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ["text"] }; }
    async *stream(request) {
      const agent = ctx.agents.requireInitiator();
      const step = (modelSteps.get(agent.id) ?? 0) + 1; modelSteps.set(agent.id, step);
      const text = request.messages.find(message => message.role === "user")?.content.find(block => block.type === "text")?.text ?? "";
      if (text.startsWith("busy")) await busy.promise;
      if (step === 1 && !text.startsWith("busy")) {
        const name = text.startsWith("approval") ? "fixture_approval" : text.startsWith("notice") ? "notify_user" : "ask_user_question";
        const args = name === "fixture_approval" ? {} : name === "notify_user" ? { title: "Task ready", message: "Return to this conversation." } : { questions: [{ id: "fixture-choice", question: marker, options: [{ label: "Continue" }] }], ...(mode === "timed" ? { timeout: 1 } : {}) };
        const block = { type: "tool-call", id: randomUUID(), name, arguments: JSON.stringify(args) };
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: 0, id: block.id, name, argumentsDelta: block.arguments };
        yield { type: "block-end", index: 0, block };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "Fixture complete." };
        yield { type: "block-end", index: 0, block: { type: "text", text: "Fixture complete." } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  }
  ctx.llm.registerAdapter(["fixture-native-notifications"], new FixtureAdapter());
  await ctx.plugin(AgentLoop, {});
  const observer = observeHostEvents(ctx, createHostEventTransport(native.env), { heartbeatMs });
  resources.push(async () => { questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] }); approvals.resolve("cancelled"); busy.resolve(); await observer.close(); await ctx.fiber.dispose(); });
  const run = async kind => {
    const agent = await ctx.agentLoop.create("session-" + randomUUID(), { provider: "fixture-native-notifications", model: "fixture" });
    agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: `${kind} ${marker}` }] }));
    return agent;
  };
  return { ctx, observer, native, questions, approvals, busy, resolutions, errors, run };
}

test("APK patch is checked/idempotent and canonical real web-app input stays byte identical", async () => {
  const sourcePath = resolve(packageRoot, "node_modules/@deepseek-ai/dsh-web-app/lib/index.js");
  const source = await readFile(sourcePath, "utf8"), target = join(work, "patch", "node_modules/@deepseek-ai/dsh-web-app/lib");
  await mkdir(target, { recursive: true }); await writeFile(join(target, "index.js"), source);
  await patchAndroidHostEvents(join(work, "patch"));
  const first = await readFile(join(target, "index.js"), "utf8");
  await patchAndroidHostEvents(join(work, "patch"));
  assert.equal(await readFile(join(target, "index.js"), "utf8"), first);
  assert.equal(await readFile(sourcePath, "utf8"), source);
  assert.equal(first.match(/ctx\.plugin\(AndroidHostEvents\)/g).length, 1);
  assert.match(first, /DSH_ANDROID === "1"/);
  await writeFile(join(target, "index.js"), source.replace("function apply(ctx, config) {", "function unknown_apply(ctx, config) {"));
  await assert.rejects(patchAndroidHostEvents(join(work, "patch")), /Unsupported/);
});
test("real AgentLoop legacy question yields waiting notification, delegates answer unchanged, resolves and completes", async () => {
  const r = await runtime(); const agent = await r.run("question");
  await until(() => r.native.calls.some(value => value.kind === "question"), "native question");
  await r.observer.flush();
  const pending = r.native.calls.find(value => value.kind === "question");
  assert.equal(pending.sessionId, agent.id); assert.equal(pending.waiting, 1); assert.equal(pending.running, 0);
  assert.equal(agent.status, "running"); assert.equal(agent.session.snapshotEvents().filter(event => event.type === "tool/result").length, 0);
  assert.ok(!JSON.stringify(r.native.calls).includes(marker)); assert.ok(!JSON.stringify(r.native.calls).includes(r.native.token));
  r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] });
  await agent.whenIdle(); await r.observer.flush();
  assert.ok(r.native.calls.some(value => value.kind === "resolved" && value.eventId === pending.eventId));
  assert.ok(r.native.calls.some(value => value.kind === "completed" && value.sessionId === agent.id));
  assert.deepEqual(r.errors, []); assert.equal(r.native.calls.at(-1).running, 0); assert.equal(r.native.calls.at(-1).waiting, 0);
  assert.ok(agent.session.snapshotEvents().some(event => event.type === "tool/result" && event.data.message.content.some(block => block.type === "text" && block.text.includes("Continue"))));
});
test("real Cordis plugin injection activates only for Android with a native bridge, and owns reset on unload", async () => {
  const r = await runtime(); await r.observer.close();
  const keys = ["DSH_ANDROID", "DSH_ANDROID_MOBILE_SOCKET", "DSH_ANDROID_MOBILE_TOKEN"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let fiber;
  try {
    Object.assign(process.env, r.native.env, { DSH_ANDROID: "0" });
    const before = r.native.calls.length;
    fiber = r.ctx.plugin(HostEvents); await fiber; await fiber.dispose(); await sleep(10);
    assert.equal(r.native.calls.length, before);
    Object.assign(process.env, r.native.env, { DSH_ANDROID: "1" });
    fiber = r.ctx.plugin(HostEvents); await fiber;
    const agent = await r.run("question");
    await until(() => r.native.calls.some(value => value.kind === "question" && value.sessionId === agent.id), "injected production listener");
    r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] }); await agent.whenIdle();
    await until(() => r.native.calls.some(value => value.kind === "completed" && value.sessionId === agent.id), "injected completion");
    await fiber.dispose();
    assert.equal(r.native.calls.at(-1).running, 0); assert.equal(r.native.calls.at(-1).waiting, 0); assert.equal(r.native.calls.at(-1).sequence, 1);
  } finally {
    await fiber?.dispose();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
test("actual ApprovalService stays pending until normal answerer decides; never policy emits no notification", async () => {
  const r = await runtime(); const agent = await r.run("approval");
  await until(() => r.native.calls.some(value => value.kind === "approval"), "approval");
  assert.deepEqual(r.resolutions, []); assert.equal(agent.status, "running");
  const request = r.native.calls.find(value => value.kind === "approval"); assert.equal(request.waiting, 1);
  r.approvals.resolve("allowed-once"); await agent.whenIdle(); await r.observer.flush();
  assert.deepEqual(r.resolutions, ["allowed-once"]);
  assert.ok(r.native.calls.some(value => value.kind === "resolved" && value.eventId === request.eventId));
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type.startsWith("approval/")).map(event => event.type), ["approval/asked", "approval/decided"]);
  const never = await runtime({ policy: "never" }); const denied = await never.run("approval"); await denied.whenIdle(); await never.observer.flush();
  assert.deepEqual(never.resolutions, ["rejected"]); assert.equal(never.native.calls.filter(value => value.kind === "approval").length, 0);
});
test("timed question uses real projection: timeout continues answerability without holding CPU, late reply resolves", async () => {
  const r = await runtime({ mode: "timed" }); const agent = await r.run("question");
  await until(() => r.native.calls.some(value => value.kind === "question"), "timed question");
  await agent.whenIdle(); await r.observer.flush();
  const continued = r.ctx.userQuestions.continued(agent); assert.equal(continued.length, 1);
  const notices = r.native.calls.filter(value => value.kind === "question"); assert.equal(new Set(notices.map(value => value.eventId)).size, 1);
  assert.equal(r.native.calls.at(-1).running, 0); assert.equal(r.native.calls.at(-1).waiting, 0);
  assert.equal(r.native.calls.filter(value => value.kind === "resolved" && value.eventId === notices[0].eventId).length, 0);
  assert.equal(r.native.calls.filter(value => value.kind === "completed").length, 0);
  assert.equal(r.ctx.userQuestions.answer(agent, continued[0].callId, { answers: [{ id: "fixture-choice", selected: ["Continue"] }] }), true);
  await agent.whenIdle(); await r.observer.flush();
  assert.equal(r.ctx.userQuestions.continued(agent).length, 0);
  assert.ok(r.native.calls.some(value => value.kind === "resolved" && value.eventId === notices[0].eventId));
  assert.ok(r.native.calls.some(value => value.kind === "completed")); assert.deepEqual(r.errors, []);
});
test("two real agents retain one running CPU hold while another waits; cancellation resolves without false completion", async () => {
  const r = await runtime(); const busy = await r.run("busy"), waiting = await r.run("question");
  await until(() => r.native.calls.some(value => value.running === 1 && value.waiting === 1), "two-agent aggregate");
  waiting.cancel({ kind: "user" }); await waiting.whenIdle(); await r.observer.flush();
  assert.equal(r.native.calls.filter(value => value.kind === "completed" && value.sessionId === waiting.id).length, 0);
  assert.equal(r.native.calls.at(-1).running, 1); assert.equal(r.native.calls.at(-1).waiting, 0);
  r.busy.resolve(); await busy.whenIdle(); await r.observer.flush(); assert.equal(r.native.calls.at(-1).running, 0);
});
test("real job registry preserves promoted work after AgentLoop idle and releases after actual producer settlement", async () => {
  const r = await runtime(); const agent = await r.run("busy");
  const { LocalJobRegistry } = await moduleAt("dsh-jobs-local");
  await r.ctx.plugin(LocalJobRegistry, {});
  const detach = r.ctx.jobs.attachController("native-notification-fixture"); resources.push(detach);
  const done = gate();
  const id = r.ctx.jobs.start({ kind: "fixture", owner: agent.id, label: marker,
    run() { return { done: done.promise, cancel() { done.resolve({ status: "killed" }); } }; } });
  await until(() => r.native.calls.at(-1)?.running === 1, "job work aggregate");
  r.busy.resolve(); await agent.whenIdle(); await r.observer.flush();
  assert.equal(r.ctx.jobs.get(id, agent.id).status, "running");
  assert.equal(r.native.calls.at(-1).running, 1); assert.equal(r.native.calls.at(-1).waiting, 0);
  assert.equal(r.native.calls.filter(value => value.kind === "completed" && value.sessionId === agent.id).length, 0);
  done.resolve({ status: "completed", result: marker });
  await until(() => r.ctx.jobs.get(id, agent.id).status === "completed", "producer job settlement"); await r.observer.flush();
  assert.equal(r.native.calls.at(-1).running, 0);
  assert.ok(r.native.calls.some(value => value.kind === "completed" && value.sessionId === agent.id));
  assert.ok(!JSON.stringify(r.native.calls).includes(marker));
});
test("native transport failure rotates epoch, replays stable pending IDs, and disposal revokes all targets", async () => {
  let fail = false, rejected = 0;
  const bridge = await nativeBridge((_value, res) => { if (fail) { rejected++; res.writeHead(503); res.end(); return; } return { ok: true, value: { accepted: true } }; });
  const r = await runtime({ native: bridge, heartbeatMs: 35 }); const agent = await r.run("question");
  await until(() => bridge.calls.some(value => value.kind === "question"), "first notification");
  const initial = bridge.calls.find(value => value.kind === "question"); fail = true;
  await until(() => rejected > 0, "actual HTTP 503 heartbeat"); fail = false;
  await until(() => bridge.calls.some(value => value.kind === "question" && value.epoch !== initial.epoch), "resync replay");
  const replay = bridge.calls.find(value => value.kind === "question" && value.epoch !== initial.epoch); assert.equal(replay.eventId, initial.eventId);
  await r.observer.close(); const last = bridge.calls.at(-1); assert.equal(last.running, 0); assert.equal(last.waiting, 0); assert.equal(last.sequence, 1); assert.notEqual(last.epoch, replay.epoch);
  r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] }); await agent.whenIdle();
});
test("ACKed completion is not reannounced after heartbeat or recovered native epoch", async () => {
  let fail = false, rejected = 0;
  const bridge = await nativeBridge((_value, res) => { if (fail) { rejected++; res.writeHead(503); res.end(); return; } return { ok: true, value: { accepted: true } }; });
  const r = await runtime({ native: bridge, heartbeatMs: 35 }); const agent = await r.run("busy");
  r.busy.resolve(); await agent.whenIdle(); await r.observer.flush();
  const first = bridge.calls.find(value => value.kind === "completed"); assert.ok(first);
  const firstEpoch = first.epoch; fail = true;
  await until(() => rejected > 0, "actual failed heartbeat after completion"); fail = false;
  await until(() => bridge.calls.some(value => value.epoch !== firstEpoch && value.epoch !== bridge.calls[0].epoch), "recovered new epoch");
  await sleep(50); await r.observer.flush();
  assert.equal(bridge.calls.filter(value => value.kind === "completed" && value.eventId === first.eventId).length, 1);
});
test("128 actual finished roots cannot crowd out a new question or approval; completion cache evicts oldest at 64", async () => {
  const r = await runtime(); r.busy.resolve();
  for (let index = 0; index < 128; index++) {
    const agent = await r.run("busy"); await agent.whenIdle(); await r.observer.flush();
  }
  const visible = new Map();
  for (const value of r.native.calls) {
    if (value.kind === "completed") visible.set(value.eventId, value);
    if (value.kind === "resolved") visible.delete(value.eventId);
  }
  assert.equal(r.native.calls.filter(value => value.kind === "completed").length, 128);
  assert.equal(visible.size, 64);
  const question = await r.run("question"), approval = await r.run("approval");
  await until(() => r.native.calls.some(value => value.kind === "question" && value.sessionId === question.id) && r.native.calls.some(value => value.kind === "approval" && value.sessionId === approval.id), "attention requests after 128 completions");
  r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] }); r.approvals.resolve("rejected");
  await Promise.all([question.whenIdle(), approval.whenIdle()]); await r.observer.flush(); assert.deepEqual(r.errors, []);
});
test("transport fails quietly and boundedly for missing config, oversized or invalid ACKs and dead socket", async () => {
  assert.equal(createHostEventTransport({}), undefined);
  const bad = await nativeBridge(() => ({ ok: true, value: { accepted: false, irrelevant: marker } }));
  assert.equal(await createHostEventTransport(bad.env)({ version: 1 }), false);
  const huge = await nativeBridge((_value, res) => { res.writeHead(200, { "Content-Length": "9000" }); res.end(); });
  assert.equal(await createHostEventTransport(huge.env)({ version: 1 }), false);
  const disconnected = createHostEventTransport({ DSH_ANDROID_MOBILE_SOCKET: "not-present-" + randomBytes(8).toString("hex"), DSH_ANDROID_MOBILE_TOKEN: randomBytes(32).toString("hex") }, { deadlineMs: 50 });
  assert.equal(await disconnected({ version: 1 }), false);
});
test("notify_user is discovered and called by actual AgentLoop/ToolRuntime, with private root binding and truthful posted result", async () => {
  const r = await runtime({ notices: true }); const agent = await r.run("notice");
  await agent.whenIdle(); await r.observer.flush();
  const request = r.native.requests.find(request => request.path === "/android/notify"); assert.ok(request);
  assert.deepEqual(Object.keys(request.payload).sort(), ["eventId", "message", "sessionId", "title", "version"]);
  assert.equal(request.payload.sessionId, agent.id); assert.equal(request.payload.version, 1); assert.equal(request.payload.title, "Task ready");
  const events = agent.session.snapshotEvents();
  assert.equal(events.filter(event => event.type === "tool/call" && event.data.name === "notify_user").length, 1);
  assert.ok(events.find(event => event.type === "request/header").data.header.tools.some(tool => tool.name === "notify_user"));
  assert.equal(JSON.parse(events.find(event => event.type === "tool/result").data.message.content[0].text).posted, true);
  assert.ok(!JSON.stringify(events).includes(r.native.token)); assert.ok(!JSON.stringify(events).includes(r.native.env.DSH_ANDROID_MOBILE_SOCKET));
  assert.deepEqual(r.errors, []);
});
test("notify_user maps a real owned child to its initiating root and refuses forged caller identities", async () => {
  const r = await runtime({ notices: true }); const root = await r.run("busy");
  const handle = await r.ctx.agentLoop.createAgent(r.ctx, { sessionId: "child-" + randomUUID(), parentAgent: root, agentOptions: { provider: "fixture-native-notifications", model: "fixture" } });
  const exec = agent => r.ctx.tools.execute({ name: "notify_user", arguments: { title: "Child update", message: "Return to the root conversation." }, callId: randomUUID(), signal: new AbortController().signal, agent });
  const child = await exec(handle.agent); assert.equal(child.isError, false); assert.deepEqual(child.value, { posted: true });
  assert.equal(r.native.requests.filter(value => value.path === "/android/notify").at(-1).payload.sessionId, root.id);
  const before = r.native.requests.filter(value => value.path === "/android/notify").length;
  const forged = await exec({ ...root, session: root.session }); assert.equal(forged.isError, true); assert.equal(forged.error.info.code, "NOTIFY_INVALID_AGENT");
  assert.equal(r.native.requests.filter(value => value.path === "/android/notify").length, before);
  r.busy.resolve(); await root.whenIdle(); await handle.dispose();
});
test("notify_user honors normal DSH tool policy and reports permission/channel/rate failures without claiming posted", async () => {
  for (const reason of ["notifications_disabled", "channel_disabled", "rate_limited", "host_unavailable"]) {
    const native = await nativeBridge((_payload, _res, path) => ({ ok: true, value: path === "/android/notify" ? { posted: false, reason } : { accepted: true } }));
    const r = await runtime({ notices: true, native }); const agent = await r.run("notice"); await agent.whenIdle();
    const result = agent.session.snapshotEvents().find(event => event.type === "tool/result"); assert.deepEqual(JSON.parse(result.data.message.content[0].text), { posted: false, reason });
  }
  const r = await runtime({ notices: true }); const agent = await r.run("busy");
  const dispose = r.ctx.on("tools/pre-execute", () => ({ kind: "deny", reason: "Fixture normal policy" }), { global: true });
  const before = r.native.requests.length;
  const result = await r.ctx.tools.execute({ name: "notify_user", arguments: { title: "Denied", message: "Must not post." }, callId: randomUUID(), signal: new AbortController().signal, agent });
  assert.equal(result.isError, true); assert.equal(r.native.requests.filter(value => value.path === "/android/notify").length, 0); assert.ok(r.native.requests.length >= before);
  dispose(); r.busy.resolve(); await agent.whenIdle();
});
test("notify_user bounds text/Unicode, honors abort, and sanitizes malformed or unavailable native ACKs", async () => {
  const r = await runtime({ notices: true }); const agent = await r.run("busy");
  const exec = (title, message, signal = new AbortController().signal) => r.ctx.tools.execute({ name: "notify_user", arguments: { title, message }, callId: randomUUID(), signal, agent });
  for (const [title, message] of [["", "valid"], [" ", "valid"], ["a".repeat(65), "valid"], ["valid", "a".repeat(1025)], ["\ud800", "valid"], ["valid", "x\0y"]]) {
    assert.equal((await exec(title, message)).isError, true);
  }
  assert.equal(r.native.requests.filter(value => value.path === "/android/notify").length, 0);
  const signal = new AbortController(); signal.abort(); assert.equal((await exec("cancelled", "valid", signal.signal)).isError, true);
  assert.equal(r.native.requests.filter(value => value.path === "/android/notify").length, 0);
  const tooLate = await nativeBridge((_payload, _res, path) => path === "/android/notify" ? undefined : { ok: true, value: { accepted: true } });
  const transport = createNotificationTransport(tooLate.env, { deadlineMs: 30 });
  assert.equal(await transport({ version: 1, title: "x", message: "y" }), undefined);
  const abort = new AbortController(); const request = transport({ version: 1, title: "x", message: "y" }, abort.signal); abort.abort();
  await assert.rejects(request, error => error.code === "NOTIFY_ABORTED");
  const invalid = await nativeBridge((_payload, _res, path) => ({ ok: true, value: path === "/android/notify" ? { posted: false, reason: marker } : { accepted: true } }));
  const bad = await runtime({ notices: true, native: invalid }); const badAgent = await bad.run("notice"); await badAgent.whenIdle();
  const result = JSON.parse(badAgent.session.snapshotEvents().find(event => event.type === "tool/result").data.message.content[0].text);
  assert.deepEqual(result, { posted: false, reason: "bridge_unavailable" }); assert.ok(!JSON.stringify(result).includes(marker));
  r.busy.resolve(); await agent.whenIdle();
});
