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
import { patchAndroidHostEvents, patchAndroidQuestionCallIds } from "./patch-android-host-events.mjs";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("usage: node scripts/test-android-host-events.mjs <real-dsh-package-directory>");
const work = await mkdtemp(join(tmpdir(), "dsh-host-events-test-"));
await symlink(resolve(packageRoot, "node_modules"), join(work, "node_modules"));
await copyFile(new URL("./android-host-events.mjs", import.meta.url), join(work, "helper.mjs"));
const HostEvents = await import(pathToFileURL(join(work, "helper.mjs")));
const { createHostEventTransport, createNotificationTransport, observeHostEvents, registerNotificationTool, createSessionMetrics, livePreviewText } = HostEvents;
const askFile = join(work, "ask-user.mjs");
const askPatchRoot = join(work, "ask-patch");
const askPatchFile = join(askPatchRoot, "node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js");
await mkdir(join(askPatchRoot, "node_modules/@deepseek-ai/dsh-tool-ask-user/lib"), { recursive: true });
await copyFile(resolve(packageRoot, "node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js"), askPatchFile);
await patchAndroidQuestionCallIds(askPatchRoot);
await copyFile(askPatchFile, askFile);
const previousAndroidFlag = process.env.DSH_ANDROID;
process.env.DSH_ANDROID = "1";
after(() => { if (previousAndroidFlag === undefined) delete process.env.DSH_ANDROID; else process.env.DSH_ANDROID = previousAndroidFlag; });
// The helper and SDK must share one module URL namespace, including with --preserve-symlinks.
const moduleAt = name => import(pathToFileURL(name === "dsh-tool-ask-user" ? askFile : join(work, "node_modules/@deepseek-ai", name, "lib/index.js")));
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
async function runtime({ mode = "legacy", policy = "ask", native, heartbeatMs = 15000, notices = false, replyClock, usage, previewMs = 1000 } = {}) {
  native ??= await nativeBridge();
  const ctx = new Context();
  for (const [plugin, config] of [[SystemPrompt, {}], [ToolRuntime, {}], [AgentRegistry], [SessionStore], [SessionProjectionRegistry], [LlmRuntime], [UserQuestionService], [ApprovalService, { policy }]]) await ctx.plugin(plugin, config);
  const questions = gate(), approvals = gate(), busy = gate();
  const previewRespond = gate(), previewFinish = gate();
  const errors = [], resolutions = [], modelSteps = new Map();
  ctx.on("agent/error", event => errors.push(event.error), { global: true });
  let providerActive = 0, providerCancelled = 0, providerFinished = 0;
  ctx.on("user-questions/request", async request => {
    if (mode === "timed") throw new UserQuestionError("No connected fixture UI", "NO_PROVIDER");
    providerActive++;
    let abort;
    try {
      return await Promise.race([questions.promise, new Promise((_, reject) => {
        abort = () => { providerCancelled++; reject(new UserQuestionError("Cancelled fixture", "ASK_ABORTED")); };
        request.signal?.addEventListener("abort", abort, { once: true });
        if (request.signal?.aborted) abort();
      })]);
    } finally { request.signal?.removeEventListener("abort", abort); providerActive--; providerFinished++; }
  }, { global: true });
  ctx.on("approval/request", () => approvals.promise, { global: true });
  ctx.tools.register(defineTool({ name: "fixture_approval", description: "Harmless fixture only.", parameters: {},
    output: { schema: { type: "object", additionalProperties: false, properties: { granted: { type: "boolean", required: true } } }, render: (_, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(_, exec) { const outcome = await ctx.approval.request({ agent: exec.agent, signal: exec.signal, callId: exec.callId, toolName: "fixture_approval", reason: marker }); resolutions.push(outcome); return { granted: outcome === "allowed-once" }; },
  }));
  await ctx.plugin(AskUser, { mode, timeout: 1 });
  if (notices) registerNotificationTool(ctx, createNotificationTransport(native.env));
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ["text"], context: { contextWindow: 8000 } }; }
    async *stream(request) {
      const agent = ctx.agents.requireInitiator();
      const step = (modelSteps.get(agent.id) ?? 0) + 1; modelSteps.set(agent.id, step);
      const text = request.messages.find(message => message.role === "user")?.content.find(block => block.type === "text")?.text ?? "";
      if (text.startsWith("busy")) await busy.promise;
      if (text.startsWith("preview")) {
        yield { type: "block-start", index: 0, blockType: "reasoning" };
        for (let index = 0; index < 300; index++) yield { type: "reasoning-delta", index: 0, text: "思考片段 " };
        await previewRespond.promise;
        yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考片段 ".repeat(300) } };
        yield { type: "block-start", index: 1, blockType: "text" };
        yield { type: "text-delta", index: 1, text: "Live response fixture." };
        await previewFinish.promise;
        yield { type: "block-end", index: 1, block: { type: "text", text: "Live response fixture." } };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      if (step === 1 && !text.startsWith("busy")) {
        const name = text.startsWith("approval") ? "fixture_approval" : text.startsWith("notice") ? "notify_user" : "ask_user_question";
        const args = name === "fixture_approval" ? {} : name === "notify_user" ? { title: "Task ready", message: "Return to this conversation.", ...(text.startsWith("notice-reply") ? { request_reply: true } : {}) } : { questions: [{ id: "fixture-choice", question: marker, options: [{ label: "Continue" }] }], ...(mode === "timed" ? { timeout: 1 } : {}) };
        const block = { type: "tool-call", id: randomUUID(), name, arguments: JSON.stringify(args) };
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: 0, id: block.id, name, argumentsDelta: block.arguments };
        yield { type: "block-end", index: 0, block };
        if (usage) { await sleep(5); yield { type: "usage", usage }; }
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "Fixture complete." };
        yield { type: "block-end", index: 0, block: { type: "text", text: "Fixture complete." } };
        if (usage) { await sleep(5); yield { type: "usage", usage }; }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  }
  ctx.llm.registerAdapter(["fixture-native-notifications"], new FixtureAdapter());
  await ctx.plugin(AgentLoop, {});
  const sdkAnswerDescriptor = Object.getOwnPropertyDescriptor(ctx.userQuestions, "answer");
  const observer = observeHostEvents(ctx, createHostEventTransport(native.env), { heartbeatMs, previewMs, ...(replyClock ? { now: replyClock } : {}) });
  resources.push(async () => { questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] }); approvals.resolve("cancelled"); busy.resolve(); previewRespond.resolve(); previewFinish.resolve(); await observer.close(); await ctx.fiber.dispose(); });
  const run = async kind => {
    const agent = await ctx.agentLoop.create("session-" + randomUUID(), { provider: "fixture-native-notifications", model: "fixture" });
    agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: `${kind} ${marker}` }] }));
    return agent;
  };
  return { ctx, observer, native, questions, approvals, busy, previewRespond, previewFinish, resolutions, errors, run, sdkAnswerDescriptor, providerState: () => ({ active: providerActive, cancelled: providerCancelled, finished: providerFinished }) };
}

test("APK patch is checked/idempotent and canonical real web-app input stays byte identical", async () => {
  const sourcePath = resolve(packageRoot, "node_modules/@deepseek-ai/dsh-web-app/lib/index.js");
  const source = await readFile(sourcePath, "utf8"), target = join(work, "patch", "node_modules/@deepseek-ai/dsh-web-app/lib");
  await mkdir(target, { recursive: true }); await writeFile(join(target, "index.js"), source);
  const askTarget = join(work, "patch/node_modules/@deepseek-ai/dsh-tool-ask-user/lib");
  await mkdir(askTarget, { recursive: true }); await copyFile(resolve(packageRoot, "node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js"), join(askTarget, "index.js"));
  await patchAndroidHostEvents(join(work, "patch"));
  const first = await readFile(join(target, "index.js"), "utf8");
  await patchAndroidHostEvents(join(work, "patch"));
  assert.equal(await readFile(join(target, "index.js"), "utf8"), first);
  assert.equal(await readFile(sourcePath, "utf8"), source);
  assert.equal(first.match(/ctx\.plugin\(AndroidHostEvents\)/g).length, 1);
  assert.match(first, /DSH_ANDROID === "1"/);
  const hostLine = '  if (process.env.DSH_ANDROID === "1") ctx.plugin(AndroidHostEvents);\n';
  const mobileLine = '  if (process.env.DSH_ANDROID === "1") ctx.plugin(AndroidMobileTools);\n';
  for (const lines of [mobileLine + hostLine, hostLine + mobileLine]) {
    const composed = first.replace(mobileLine, "").replace(hostLine, lines);
    await writeFile(join(target, "index.js"), composed);
    await patchAndroidHostEvents(join(work, "patch"));
    assert.equal(await readFile(join(target, "index.js"), "utf8"), composed);
  }
  await writeFile(join(target, "index.js"), first.replace(hostLine, hostLine + hostLine));
  await assert.rejects(patchAndroidHostEvents(join(work, "patch")), /Unsupported/);
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


test("real foreground notification reply reaches tool result once and cancels the competing normal provider", async () => {
  const r = await runtime(), agent = await r.run("question");
  await until(() => r.native.calls.some(value => value.kind === "question" && value.replyTicket), "reply-ready question");
  await until(() => r.providerState().active === 1, "normal provider registered");
  const pending = r.native.calls.find(value => value.kind === "question" && value.replyTicket);
  assert.equal(r.observer.answerReply(pending.replyTicket, "Actual HOST inline text"), true);
  assert.equal(r.observer.answerReply(pending.replyTicket, "duplicate must not arrive"), false);
  await agent.whenIdle(); await r.observer.flush();
  assert.deepEqual(r.providerState(), { active: 0, cancelled: 1, finished: 1 });
  const result = agent.session.snapshotEvents().filter(event => event.type === "tool/result");
  assert.equal(result.length, 1); assert.ok(JSON.stringify(result[0].data).includes("Actual HOST inline text"));
  assert.ok(!JSON.stringify(result[0].data).includes("duplicate must not arrive"));
  assert.ok(r.native.calls.some(value => value.replyAck === pending.replyTicket));
  assert.deepEqual(r.errors, []);
  r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["late provider"] }] });
  await sleep(10); assert.equal(agent.session.snapshotEvents().filter(event => event.type === "tool/result").length, 1);
});

test("normal provider wins the real foreground race and old native reply is rejected", async () => {
  const r = await runtime(), agent = await r.run("question");
  await until(() => r.native.calls.some(value => value.kind === "question" && value.replyTicket), "reply ticket");
  const pending = r.native.calls.find(value => value.kind === "question");
  r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] });
  await agent.whenIdle(); await r.observer.flush();
  assert.equal(r.observer.answerReply(pending.replyTicket, "stale native answer"), false);
  assert.equal(r.providerState().active, 0); assert.equal(agent.session.snapshotEvents().filter(event => event.type === "tool/result").length, 1);
});

test("cancelled and expired foreground tickets cannot answer or approve any other operation", async () => {
  let now = 1000;
  const expired = await runtime({ replyClock: () => now }), agent = await expired.run("question");
  await until(() => expired.native.calls.some(value => value.kind === "question" && value.replyTicket));
  const ticket = expired.native.calls.find(value => value.kind === "question").replyTicket;
  now += HostEvents.LIMITS.replyTtlMs + 1;
  assert.equal(expired.observer.answerReply(ticket, "expired text"), false);
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === "tool/result").length, 0);
  agent.cancel({ kind: "user" }); await agent.whenIdle(); await expired.observer.flush();
  assert.equal(expired.providerState().active, 0); assert.equal(expired.observer.answerReply(ticket, "cancelled text"), false);
  const approvals = await runtime(), guarded = await approvals.run("approval");
  await until(() => approvals.native.calls.some(value => value.kind === "approval"));
  assert.equal(approvals.native.calls.find(value => value.kind === "approval").replyTicket, undefined);
  approvals.approvals.resolve("rejected"); await guarded.whenIdle(); assert.deepEqual(approvals.resolutions, ["rejected"]);
});

test("real continued timed question uses unchanged SDK answer and rejects a duplicate notification reply", async () => {
  const r = await runtime({ mode: "timed" }), agent = await r.run("question");
  await agent.whenIdle(); await r.observer.flush();
  const pending = r.native.calls.find(value => value.kind === "question" && value.replyTicket);
  assert.ok(pending); assert.equal(r.ctx.userQuestions.continued(agent).length, 1);
  assert.equal(r.observer.answerReply(pending.replyTicket, "Real late reply"), true);
  assert.equal(r.observer.answerReply(pending.replyTicket, "duplicate"), false);
  await agent.whenIdle(); await r.observer.flush();
  assert.equal(r.ctx.userQuestions.continued(agent).length, 0);
  assert.ok(agent.session.snapshotEvents().some(event => event.type === "user/message" && event.data.source.kind === "user-question-reply"));
});

test("notify_user request_reply invokes real UserQuestionService and returns actual text after native private transport delivery", async () => {
  let submitted, r;
  const native = await nativeBridge((payload, _res, path) => path === "/android/notify" ? { ok: true, value: { posted: true } }
    : { ok: true, value: { accepted: true, ...(submitted ? { replies: [submitted] } : {}) } });
  r = await runtime({ notices: true, native, heartbeatMs: 20 }); const agent = await r.run("notice-reply");
  await until(() => native.calls.some(value => value.kind === "question" && value.replyTicket));
  const pending = native.calls.find(value => value.kind === "question" && value.replyTicket);
  submitted = { ticket: pending.replyTicket, text: "Model tool reply received" };
  await until(() => agent.status === "idle", "notification tool reply completed"); await r.observer.flush();
  const tool = agent.session.snapshotEvents().filter(event => event.type === "tool/result");
  assert.equal(tool.length, 1); assert.ok(JSON.stringify(tool[0].data).includes('Model tool reply received'));
  assert.equal(JSON.parse(tool[0].data.message.content.find(block => block.type === 'text').text).posted, true);
  assert.equal(r.providerState().active, 0); assert.equal(r.providerState().cancelled, 1); assert.deepEqual(r.errors, []);
});

test("SDK metrics preserve disjoint cache buckets, real context projection, completed call timing and cumulative total", async () => {
  const usage = { inputTokens: 100, outputTokens: 400, totalTokens: 2800, cacheReadTokens: 2000, cacheWriteTokens: 300 };
  const r = await runtime({ usage });
  const { TokenMeter } = await moduleAt("dsh-token-meter"); await r.ctx.plugin(TokenMeter, {});
  const agent = await r.run("question"); await until(() => r.native.calls.some(value => value.kind === "question"));
  const meter = createSessionMetrics(); const first = meter.read(agent, "waiting", r.ctx);
  assert.equal(first.inputTokens, 100); assert.equal(first.cachedInputTokens, 2000); assert.equal(first.cacheWriteTokens, 300);
  assert.equal(first.totalTokens, 2800); assert.equal(first.sessionTokens, 2800);
  assert.equal(first.contextCapacity, 8000); assert.equal(first.contextUsed, r.ctx.sessionProjections.snapshot(agent.session, ["contextPressure"]).values.contextPressure.projectedTokens);
  assert.ok(first.tokensPerSecond > 0); assert.equal(first.turns, 1); assert.equal(first.steps, 1);
  meter.stream(agent, { type: "start" }); assert.equal(meter.read(agent, "running", r.ctx).totalTokens, 2800);
  r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] }); await agent.whenIdle();
  // This metric object observes a fresh actual settled session snapshot.
  const final = createSessionMetrics().read(agent, "running", r.ctx);
  assert.equal(final.sessionTokens, 5600); assert.equal(final.totalTokens, 2800); assert.equal(final.steps, 2);
});

test("unreported provider usage stays nullable, and two actual live roots retain separate summary rows", async () => {
  const r = await runtime(), busy = await r.run("busy"), waiting = await r.run("question");
  await until(() => r.native.calls.some(value => value.sessions?.length === 2)); await r.observer.flush();
  const packet = [...r.native.calls].reverse().find(value => value.sessions?.length === 2);
  assert.equal(packet.sessionsComplete, true);
  assert.equal(packet.sessions.find(row => row.sessionId === busy.id).state, "running");
  assert.equal(packet.sessions.find(row => row.sessionId === waiting.id).state, "waiting");
  for (const row of packet.sessions) {
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "sessionTokens", "tokensPerSecond", "contextUsed"]) assert.equal(row[key], null);
    assert.ok(!JSON.stringify(row).includes(marker));
  }
  r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] }); r.busy.resolve(); await busy.whenIdle(); await waiting.whenIdle(); await r.observer.flush();
  assert.deepEqual(r.native.calls.at(-1).sessions, []);
});

test("repeated real question synchronizations retain the first one-use action without orphan ticket eviction", async () => {
  const r = await runtime({ mode: "timed" }), agent = await r.run("question");
  await agent.whenIdle(); await r.observer.flush();
  const pending = r.native.calls.find(value => value.kind === "question" && value.replyTicket);
  for (let index = 0; index < 200; index++) r.ctx.emit("agent/status", { agent, status: agent.status });
  await r.observer.flush();
  assert.equal(r.observer.answerReply(pending.replyTicket, "Still exact after repeated synchronization"), true);
  await agent.whenIdle(); await r.observer.flush(); assert.equal(r.ctx.userQuestions.continued(agent).length, 0);
});

test("recovered transport epoch revokes the old action and admits a fresh ticket for the same actual foreground question", async () => {
  let unavailable = false, rejected = 0;
  const native = await nativeBridge((_packet, res) => {
    if (unavailable) { rejected++; res.writeHead(503); res.end(); return; }
    return { ok: true, value: { accepted: true } };
  });
  const r = await runtime({ native, heartbeatMs: 20 }), agent = await r.run("question");
  await until(() => native.calls.some(value => value.kind === "question" && value.replyTicket));
  const initial = native.calls.find(value => value.kind === "question"); unavailable = true;
  await until(() => rejected > 0); unavailable = false;
  await until(() => native.calls.some(value => value.kind === "question" && value.epoch !== initial.epoch));
  const recovered = native.calls.find(value => value.kind === "question" && value.epoch !== initial.epoch);
  assert.equal(recovered.eventId, initial.eventId); assert.notEqual(recovered.replyTicket, initial.replyTicket);
  assert.equal(r.observer.answerReply(initial.replyTicket, "old epoch"), false);
  assert.equal(r.observer.answerReply(recovered.replyTicket, "recovered exact question"), true);
  await agent.whenIdle(); await r.observer.flush(); assert.equal(r.providerState().active, 0);
});

test("observer disposal restores the actual SDK answer method while the original UI request remains usable", async () => {
  const r = await runtime(), agent = await r.run("question");
  await until(() => r.native.calls.some(value => value.kind === "question" && value.replyTicket));
  const pending = r.native.calls.find(value => value.kind === "question"); await r.observer.close();
  assert.deepEqual(Object.getOwnPropertyDescriptor(r.ctx.userQuestions, "answer"), r.sdkAnswerDescriptor);
  assert.equal(r.observer.answerReply(pending.replyTicket, "disposed"), false);
  r.questions.resolve({ answers: [{ id: "fixture-choice", selected: ["Continue"] }] });
  await agent.whenIdle(); assert.equal(r.providerState().active, 0); assert.equal(r.providerState().finished, 1);
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === "tool/result").length, 1);
});

test("an actual owned child's notify_user request_reply cannot promote its call into the initiating root", async () => {
  const r = await runtime({ notices: true }), root = await r.run("busy");
  const handle = await r.ctx.agentLoop.createAgent(r.ctx, { sessionId: "child-reply-" + randomUUID(), parentAgent: root, agentOptions: { provider: "fixture-native-notifications", model: "fixture" } });
  const before = r.native.requests.filter(value => value.path === "/android/notify").length;
  const result = await r.ctx.tools.execute({ name: "notify_user", arguments: { request_reply: true, title: "Child", message: "Do not promote this request." }, callId: randomUUID(), signal: new AbortController().signal, agent: handle.agent });
  assert.equal(result.isError, true); assert.equal(result.error.info.code, "NOTIFY_REPLY_UNAVAILABLE");
  assert.equal(r.native.requests.filter(value => value.path === "/android/notify").length, before);
  r.busy.resolve(); await root.whenIdle(); await handle.dispose();
});

test("actual active root summaries bound the private packet and explicitly report incomplete lists", async () => {
  const r = await runtime({ heartbeatMs: 20 }), agents = [];
  for (let index = 0; index < 66; index++) agents.push(await r.run("busy"));
  await until(() => r.native.calls.some(packet => packet.running === 66), "all actual roots started");
  await r.observer.flush();
  const packet = [...r.native.calls].reverse().find(packet => packet.running === 66);
  assert.equal(packet.running, 66); assert.equal(packet.sessionsComplete, false); assert.equal(packet.sessions.length, 64);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 30000);
  assert.equal(new Set(packet.sessions.map(row => row.sessionId)).size, packet.sessions.length);
  r.busy.resolve(); await Promise.all(agents.map(agent => agent.whenIdle())); await r.observer.flush();
  assert.deepEqual(r.native.calls.at(-1).sessions, []); assert.equal(r.native.calls.at(-1).sessionsComplete, true);
});

test("real AgentLoop reasoning/text chunks coalesce, switch phases and vanish when the turn completes", async () => {
  const r = await runtime({ previewMs: 50 });
  const agent = await r.run("preview");
  await until(() => r.native.calls.some(packet => packet.sessions?.some(row => row.activity?.text.includes("思考片段"))), "live reasoning preview");
  const thinking = r.native.calls.flatMap(packet => packet.sessions ?? []).filter(row => row.activity?.text.includes("思考片段"));
  assert.ok(thinking.length < 10, "300 deltas must not become 300 notifications");
  assert.ok(thinking.every(row => row.activity.phase === "thinking" && Array.from(row.activity.text).length <= 240));
  assert.ok(!JSON.stringify(r.native.calls).includes(marker));
  r.previewRespond.resolve();
  await until(() => r.native.calls.some(packet => packet.sessions?.some(row => row.activity?.text === "Live response fixture.")), "live response preview");
  const response = r.native.calls.flatMap(packet => packet.sessions ?? []).find(row => row.activity?.text === "Live response fixture.");
  assert.equal(response.activity.phase, "responding");
  r.previewFinish.resolve(); await agent.whenIdle(); await r.observer.flush();
  assert.deepEqual(r.native.calls.at(-1).sessions, []);
  assert.deepEqual(r.errors, []);
});

test("preview bounds Unicode, strips controls and redacts recognized API-key forms", () => {
  const text = livePreviewText("\u0000line\nvalue nvapi-" + "q".repeat(50) + " sk-or-v1-" + "a".repeat(64));
  assert.ok(!text.includes("q".repeat(12)) && !text.includes("a".repeat(12)));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(text));
  const unicode = livePreviewText("🎉".repeat(1000));
  assert.equal(Array.from(unicode).length, 240); assert.equal(unicode.length, 480);
});
