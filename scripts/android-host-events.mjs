// APK-only host observer. Native notifications contain no prompts, arguments or credentials.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";

export const name = "android-host-events";
export const inject = ["agents", "sessionProjections", "tools", "systemPrompt"];
export const LIMITS = Object.freeze({ requests: 256, notifications: 128, completions: 64, responseBytes: 32768, replyText: 4096, replyTtlMs: 30 * 60 * 1000, sessions: 64, deadlineMs: 3000, heartbeatMs: 15000 });
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SOCKET = /^[A-Za-z0-9._-]{1,80}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const NOTICE_REASONS = new Set(["notifications_disabled", "channel_disabled", "rate_limited", "host_unavailable"]);
const aborted = signal => { if (signal?.aborted) throw new HarnessError("Android notification cancelled.", "NOTIFY_ABORTED"); };

/** No TCP fallback, redirects, shell commands, logs or credential-bearing errors. */
function createPrivateTransport(environment, { deadlineMs = LIMITS.deadlineMs } = {}) {
  const socket = environment.DSH_ANDROID_MOBILE_SOCKET;
  const token = environment.DSH_ANDROID_MOBILE_TOKEN;
  if (!SOCKET.test(socket ?? "") || !TOKEN.test(token ?? "")) return undefined;
  return (path, payload, signal) => new Promise((resolve, reject) => {
    let done = false, request, response;
    const finish = (value, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (value === undefined) { response?.destroy(); request?.destroy(); }
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(undefined, new HarnessError("Android notification cancelled.", "NOTIFY_ABORTED"));
    const timer = setTimeout(() => finish(undefined), deadlineMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length > 32768) { finish(undefined); return; }
    request = http.request({ socketPath: "\0" + socket, method: "POST", path, agent: false,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": body.length, Connection: "close" } }, res => {
      response = res;
      if (res.statusCode !== 200) { finish(undefined); return; }
      const declared = res.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LIMITS.responseBytes)) { finish(undefined); return; }
      const chunks = [];
      let bytes = 0;
      res.on("data", chunk => { bytes += chunk.length; if (bytes > LIMITS.responseBytes) finish(undefined); else chunks.push(chunk); });
      res.on("error", () => finish(undefined));
      res.on("end", () => {
        let envelope;
        try { envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { finish(undefined); return; }
        finish(object(envelope) && envelope.ok === true && object(envelope.value) ? envelope.value : undefined);
      });
    });
    request.on("error", () => finish(undefined));
    request.end(body);
  });
}
export function createHostEventTransport(environment, options) {
  const request = createPrivateTransport(environment, options);
  if (!request) return undefined;
  let answer;
  const transport = async payload => {
    const value = await request("/android/events", payload);
    if (value?.accepted !== true) return false;
    if (Array.isArray(value.replies) && value.replies.length <= 1 && answer) {
      for (const reply of value.replies) {
        if (object(reply) && Object.keys(reply).every(key => key === "ticket" || key === "text") &&
          ID.test(reply.ticket ?? "") && validNoticeText(reply.text, LIMITS.replyText)) {
          try { answer(reply.ticket, reply.text); } catch { /* Never expose a private answer or error. */ }
        }
      }
    }
    return true;
  };
  transport.setReplyHandler = handler => { answer = handler; };
  return transport;
}
export function createNotificationTransport(environment, options) {
  const request = createPrivateTransport(environment, options);
  return request && ((payload, signal) => request("/android/notify", payload, signal));
}
function validNoticeText(value, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !value.trim() || value.includes("\0")) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
/** Follow actual runtime ownership, never persistent session lineage or model-provided IDs. */
function initiatingRoot(ctx, caller) {
  if (!caller || !ID.test(caller.id ?? "") || ctx.agents.get(caller.id) !== caller) throw new HarnessError("Android notifications require a registered calling agent.", "NOTIFY_INVALID_AGENT");
  const seen = new Set();
  let current = caller;
  while (seen.size < 64 && !seen.has(current)) {
    seen.add(current);
    if (ctx.agents.roots().includes(current)) return current;
    const parent = ctx.agents.list().find(agent => ctx.agents.isOwnedBy(current.id, agent));
    if (!parent || ctx.agents.get(parent.id) !== parent) break;
    current = parent;
  }
  throw new HarnessError("Android notification owner is unavailable.", "NOTIFY_INVALID_AGENT");
}
export function registerNotificationTool(ctx, request) {
  ctx.systemPrompt.section({ name: "tools:android-notifications", order: ctx.systemPrompt.getSectionOrder("TOOL_COMPUTER_USE"), text:
    "Android notify_user optionally waits for a text reply when request_reply is true; this uses the real question service and never approves an operation. Android notify_user posts a user-facing notification in this app. Use it when a notification helps the user's requested task. Keep its title and message concise and avoid secrets or credentials. Notification taps return to the initiating conversation; they do not answer questions or approve actions. Android permission/channel settings and a 10-second per-conversation rate limit apply. A posted result confirms Android accepted the notification, not that the user read it. Questions and approvals also have automatic native attention notifications."
  });
  ctx.tools.register(defineTool({ name: "notify_user", description: "Post an Android notification for the initiating conversation. Respects Android permission and a 10-second conversation rate limit; no Accessibility grant needed. Posted means Android accepted it, not that the user read it.",
    parameters: { request_reply: { type: "boolean", description: "When true, ask for one freeform reply through Android notification or DSH and wait for the real answer. Default false." }, title: { type: "string", required: true, description: "Nonblank title, at most 64 UTF-16 code units." }, message: { type: "string", required: true, description: "Nonblank message, at most 1024 UTF-16 code units. Do not include secrets." } },
    output: { schema: { type: "object", additionalProperties: false, properties: { posted: { type: "boolean", required: true }, reply: { type: "string" }, reason: { type: "string", enum: ["notifications_disabled", "channel_disabled", "rate_limited", "host_unavailable", "bridge_unavailable"] } } }, render: (_, value) => [{ type: "text", text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      aborted(exec.signal);
      const agent = initiatingRoot(ctx, exec.agent);
      if (args.request_reply === true && agent !== exec.agent) throw new HarnessError("Notification reply requires the exact calling root agent.", "NOTIFY_REPLY_UNAVAILABLE");
      if (!validNoticeText(args.title, 64) || !validNoticeText(args.message, 1024)) throw new HarnessError("Android notification title or message is blank, oversized or invalid Unicode.", "NOTIFY_INVALID_ARGUMENT");
      if (!request) return { posted: false, reason: "bridge_unavailable" };
      const noticeId = randomUUID();
      const value = await request({ version: 1, sessionId: agent.id, eventId: noticeId, title: args.title, message: args.message }, exec.signal);
      aborted(exec.signal);
      if (!object(value) || typeof value.posted !== "boolean" || Object.keys(value).some(key => key !== "posted" && key !== "reason")) return { posted: false, reason: "bridge_unavailable" };
      if (value.posted === true && value.reason === undefined) {
        if (args.request_reply !== true) return { posted: true };
        const questions = ctx.get("userQuestions");
        if (!questions) throw new HarnessError("Android reply requires the live question service.", "NOTIFY_REPLY_UNAVAILABLE");
        const answer = await questions.ask({ agent, signal: exec.signal, wait: { callId: exec.callId },
          questions: [{ id: "android-notification-reply", question: args.message }],
          androidNotification: { eventId: noticeId, title: args.title, message: args.message } });
        aborted(exec.signal);
        const reply = answer.answers.find(item => item.id === "android-notification-reply");
        return { posted: true, reply: reply?.custom ?? reply?.selected?.join(", ") ?? "" };
      }
      if (value.posted === false && NOTICE_REASONS.has(value.reason)) return { posted: false, reason: value.reason };
      return { posted: false, reason: "bridge_unavailable" };
    },
  }));
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const finite = value => Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
/** Exact SDK counters: no text estimates, provider guesses or absent cache-as-zero. */
export function createSessionMetrics() {
  const states = new WeakMap();
  const empty = () => ({ turns: 0, steps: 0, name: null, usage: null, capacity: null, firstTime: null, lastTime: null });
  const times = (state, records) => {
    state.firstTime = null; state.lastTime = null;
    for (const record of records ?? []) {
      const first = count(record.type === "chunk" ? record.time : record.time0);
      if (first === null) continue;
      const offsets = Array.isArray(record.dt) && record.dt.every(value => count(value) !== null) ? record.dt.reduce((sum, value) => sum + value, 0) : 0;
      const last = first + offsets;
      state.firstTime = state.firstTime === null ? first : Math.min(state.firstTime, first);
      state.lastTime = state.lastTime === null ? last : Math.max(state.lastTime, last);
    }
  };
  const fold = (state, event) => {
    if (event.type === "turn/start") state.turns++;
    if (event.type === "step/start") state.steps++;
    if (event.type === "session/title") {
      const value = event.data.title;
      state.name = typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
    }
    if (event.type === "request/context") state.capacity = count(event.data.contextWindow) > 0 ? count(event.data.contextWindow) : null;
    if (event.type === "assistant/message" || event.type === "assistant/attempt") {
      state.usage = object(event.data.usage) ? event.data.usage : null;
      times(state, event.data.stream);
    }
  };
  const stateOf = session => {
    let state = states.get(session);
    if (!state) { state = empty(); for (const event of session.snapshotEvents()) fold(state, event); states.set(session, state); }
    return state;
  };
  return {
    event(session, event) { const state = states.get(session); if (state) fold(state, event); },
    stream(_agent, _frame) { /* Latest completed-call counters remain stable while another call streams. */ },
    read(agent, status, ctx) {
      const state = stateOf(agent.session), usage = state.usage;
      const inputTokens = count(usage?.inputTokens), outputTokens = count(usage?.outputTokens);
      const totalTokens = count(usage?.totalTokens), cachedInputTokens = count(usage?.cacheReadTokens), cacheWriteTokens = count(usage?.cacheWriteTokens);
      // Context occupancy is exposed only by an authoritative token-meter
      // projection. Provider prompt usage alone is not the current context.
      let pressure, total;
      try {
        pressure = ctx?.sessionProjections.snapshot(agent.session, ["contextPressure"]).values.contextPressure;
        const cumulative = ctx?.sessionProjections.stateOf(agent.session, "tokenUsage");
        if (cumulative?.last) total = cumulative.totals;
      } catch { /* The optional meter has not mounted; leave these unavailable. */ }
      const contextUsed = count(pressure?.projectedTokens ?? pressure?.pressureTokens);
      const contextCapacity = count(pressure?.contextWindow) > 0 ? count(pressure.contextWindow) : state.capacity;
      const buckets = [total?.uncachedInputTokens, total?.outputTokens, total?.cacheReadTokens, total?.cacheWriteTokens];
      const sessionTokens = buckets.every(value => count(value) !== null) ? count(buckets.reduce((sum, value) => sum + value, 0)) : null;
      const seconds = state.firstTime !== null && state.lastTime > state.firstTime ? (state.lastTime - state.firstTime) / 1000 : null;
      return { sessionId: agent.id, name: state.name, state: status, turns: state.turns, steps: state.steps,
        inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheWriteTokens, sessionTokens,
        tokensPerSecond: outputTokens !== null && seconds !== null ? finite(outputTokens / seconds) : null,
        contextUsed, contextCapacity };
    },
  };
}

/** Observe the production registry, durable question fold and existing answerer waterfalls. */
export function observeHostEvents(ctx, send, { heartbeatMs = LIMITS.heartbeatMs, now = Date.now } = {}) {
  let closed = false, epoch = randomUUID(), sequence = 0, pumping = false, needsResync = false;
  const metrics = createSessionMetrics(), foregroundReplies = new Map(), replyTickets = new Map();
  const queue = [], notifications = new Map(), deliveredCompletions = new Set(), blocking = new Map(), activeJobs = new Map(), disposers = [];
  const root = agent => ID.test(agent?.id ?? "") && ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent);
  const activeQuestions = agent => {
    try { return ctx.sessionProjections.stateOf(agent.session, "userQuestions")?.questions.active ?? []; }
    catch { return []; } // Optional question capability is absent until its preset is mounted.
  };
  const counts = () => {
    const executing = new Set();
    let waiting = 0;
    for (const agent of ctx.agents.list()) {
      if (agent.status !== "running") continue;
      const blocked = (blocking.get(agent)?.size ?? 0) > 0 || activeQuestions(agent).some(question => question.state === "open");
      if (blocked) waiting++; else executing.add(`owner:${agent.id}`);
    }
    // A promoted Bash/subagent job may outlive its AgentLoop turn. Count each
    // executing owner once; an owned job still protects work while its agent awaits input.
    for (const job of activeJobs.values()) executing.add(job.owner === undefined ? `job:${job.id}` : `owner:${job.owner}`);
    return { running: Math.min(executing.size, 1000), waiting: Math.min(waiting, 1000) };
  };
  const sessions = () => {
    const roots = ctx.agents.roots(), rootSet = new Set(roots), active = new Set(), waiting = new Set();
    const owner = agent => {
      if (rootSet.has(agent)) return agent;
      return roots.find(candidate => ctx.agents.isOwnedBy(agent.id, candidate));
    };
    for (const agent of ctx.agents.list()) if (agent.status === "running") {
      const parent = owner(agent); if (parent) active.add(parent);
    }
    for (const job of activeJobs.values()) {
      const agent = ctx.agents.get(job.owner);
      if (agent) { const parent = owner(agent); if (parent) active.add(parent); }
    }
    for (const agent of blocking.keys()) if (rootSet.has(agent)) { active.add(agent); waiting.add(agent); }
    for (const notice of notifications.values()) if (notice.kind === "question" || notice.kind === "approval") {
      const agent = ctx.agents.get(notice.sessionId);
      if (rootSet.has(agent)) { active.add(agent); waiting.add(agent); }
    }
    const rows = roots.filter(agent => active.has(agent)).map(agent => metrics.read(agent, waiting.has(agent) ? "waiting" : "running", ctx));
    return { sessions: rows.slice(0, LIMITS.sessions), sessionsComplete: rows.length <= LIMITS.sessions };
  };
  const packet = change => {
    const value = { version: 1, epoch, sequence: ++sequence, ...counts(), ...sessions(), ...change };
    while (value.sessions.length && Buffer.byteLength(JSON.stringify(value)) > 30000) { value.sessions.pop(); value.sessionsComplete = false; }
    return value;
  };
  const ticketFor = (agent, callId, questionId, request) => {
    const ticket = randomUUID();
    replyTickets.set(ticket, { epoch, agent, callId, questionId, request, expires: now() + LIMITS.replyTtlMs });
    while (replyTickets.size > LIMITS.notifications) replyTickets.delete(replyTickets.keys().next().value);
    return ticket;
  };
  const reply = (ticket, text) => {
    const value = replyTickets.get(ticket);
    if (!value || !validNoticeText(text, LIMITS.replyText)) return false;
    replyTickets.delete(ticket);
    if (!closed) push({ replyAck: ticket });
    if (!closed && value.expires <= now() && root(value.agent) && !value.request?.signal?.aborted) {
      for (const item of notifications.values()) if (item.replyTicket === ticket) {
        item.replyTicket = ticketFor(value.agent, value.callId, value.questionId, value.request); push(item);
      }
    }
    if (closed || value.epoch !== epoch || value.expires <= now() || !root(value.agent) || value.request?.signal?.aborted) return false;
    const active = activeQuestions(value.agent).find(question => question.callId === value.callId);
    const foreground = foregroundReplies.get(questionKey(value.agent, value.callId));
    if (!active && foreground?.request !== value.request) return false;
    if (active && (active.questions.length !== 1 || active.questions[0].id !== value.questionId)) return false;
    try { return ctx.get("userQuestions")?.answer(value.agent, value.callId, { answers: [{ id: value.questionId, selected: [], custom: text }] }) === true; }
    catch { return false; }
  };
  send.setReplyHandler?.(reply);
  const questionsFiber = ctx.inject(["userQuestions"], questionCtx => {
    const service = questionCtx.userQuestions, original = service.answer;
    const previousAnswer = Object.getOwnPropertyDescriptor(service, "answer");
    const dispatch = function (agent, callId, answer) {
      const current = foregroundReplies.get(questionKey(agent, callId));
      if (!current) return original.call(this, agent, callId, answer);
      if (!root(agent) || current.request.agent !== agent || current.request.signal?.aborted || current.settled) return false;
      const answers = answer?.answers;
      if (!Array.isArray(answers) || answers.length !== 1 || answers[0].id !== current.question.id || !Array.isArray(answers[0].selected) || answers[0].selected.length !== 0 || !validNoticeText(answers[0].custom, LIMITS.replyText)) return false;
      current.settled = true;
      current.resolve(answer);
      return true;
    };
    service.answer = dispatch;
    questionCtx.effect(() => () => {
      // Cordis returns a fresh method proxy on reads; compare the installed own descriptor.
      if (Object.getOwnPropertyDescriptor(service, "answer")?.value !== dispatch) return;
      if (previousAnswer) Object.defineProperty(service, "answer", previousAnswer);
      else Reflect.deleteProperty(service, "answer");
    });
  });
  disposers.push(() => questionsFiber.dispose());
  const pump = async () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (queue.length && !closed) {
        const value = queue.shift();
        let accepted = false;
        try { accepted = await send(value); } catch { /* No server or private errors enter logs. */ }
        if (!accepted) { queue.length = 0; needsResync = true; break; }
        if (value.kind === "completed" && [...notifications.values()].some(notification => notification.eventId === value.eventId)) deliveredCompletions.add(value.eventId);
      }
    } finally { pumping = false; }
  };
  const push = change => {
    if (closed || needsResync) return;
    if (queue.length >= LIMITS.requests) { queue.length = 0; needsResync = true; return; }
    queue.push(packet(change));
    void pump();
  };
  const resolve = key => {
    const old = notifications.get(key);
    if (!old) return;
    notifications.delete(key);
    deliveredCompletions.delete(old.eventId);
    if (old.replyTicket) replyTickets.delete(old.replyTicket);
    push({ kind: "resolved", sessionId: old.sessionId, eventId: old.eventId });
  };
  const pending = (key, agent, kind, extra = {}) => {
    if (!root(agent) || notifications.has(key)) return;
    const completions = [...notifications].filter(([, value]) => value.kind === "completed");
    if (kind === "completed") {
      if (completions.length >= LIMITS.completions) resolve(completions[0][0]);
    } else if (notifications.size - completions.length >= LIMITS.notifications) return;
    const value = { sessionId: agent.id, kind, eventId: randomUUID(), ...extra };
    notifications.set(key, value);
    push(value);
  };
  const questionKey = (agent, callId) => `question:${agent.id}:${callId}`;
  const syncQuestions = agent => {
    if (!root(agent)) return;
    const keys = new Set();
    for (const question of activeQuestions(agent)) {
      if (!ID.test(question.callId ?? "")) continue;
      const key = questionKey(agent, question.callId);
      keys.add(key);
      const safe = question.questions.length === 1 && !question.questions[0].intent;
      if (!notifications.has(key)) pending(key, agent, "question", safe ? { replyTicket: ticketFor(agent, question.callId, question.questions[0].id) } : {});
    }
    const prefix = `question:${agent.id}:`;
    for (const key of notifications.keys()) if (key.startsWith(prefix) && !keys.has(key) && !blocking.get(agent)?.has(key)) resolve(key);
  };
  const resync = () => {
    if (closed) return;
    if (needsResync) { epoch = randomUUID(); sequence = 0; queue.length = 0; needsResync = false; }
    for (const value of notifications.values()) if (value.replyTicket) {
      const old = replyTickets.get(value.replyTicket);
      if (old && (old.epoch !== epoch || old.expires <= now())) {
        replyTickets.delete(value.replyTicket);
        value.replyTicket = ticketFor(old.agent, old.callId, old.questionId, old.request);
      }
    }
    push({});
    // Replay stable event identities after transport loss; native deduplicates them.
    for (const value of notifications.values()) if (value.kind !== "completed" || !deliveredCompletions.has(value.eventId)) push(value);
  };
  const begin = (agent, key, kind, extra) => {
    const set = blocking.get(agent) ?? new Set();
    set.add(key); blocking.set(agent, set);
    pending(key, agent, kind, extra);
    push({});
  };
  const end = (agent, key) => {
    blocking.get(agent)?.delete(key);
    if (!blocking.get(agent)?.size) blocking.delete(agent);
    resolve(key); push({});
  };
  const wrap = kind => async (request, next) => {
    const agent = request.agent;
    if (!root(agent) || request.signal?.aborted) return next();
    // Timed calls are tracked by DSH's authoritative question projection, including timeout continuation.
    if (kind === "question" && request.wait?.timed === true) { syncQuestions(agent); push({}); return next(); }
    const key = kind === "question" && ID.test(request.wait?.callId ?? "")
      ? questionKey(agent, request.wait.callId) : `${kind}:${agent.id}:${randomUUID()}`;
    const question = kind === "question" && request.questions?.length === 1 && !request.questions[0].intent && ID.test(request.wait?.callId ?? "") ? request.questions[0] : undefined;
    let answerPromise, providerLifetime;
    if (question) {
      providerLifetime = new AbortController();
      request.signal = request.signal ? AbortSignal.any([request.signal, providerLifetime.signal]) : providerLifetime.signal;
      let resolve;
      answerPromise = new Promise(done => { resolve = done; });
      foregroundReplies.set(key, { request, question, resolve, settled: false });
    }
    const notice = request.androidNotification;
    const explicitNotice = object(notice) && ID.test(notice.eventId ?? "") && validNoticeText(notice.title, 64) && validNoticeText(notice.message, 1024);
    begin(agent, key, kind, question ? { replyTicket: notifications.get(key)?.replyTicket ?? ticketFor(agent, request.wait.callId, question.id, request),
      ...(explicitNotice ? { eventId: notice.eventId, noticeTitle: notice.title, noticeMessage: notice.message } : {}) } : undefined);
    let finished = false;
    const finish = () => { if (finished) return; finished = true; end(agent, key); };
    const onAbort = () => finish();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try { return await (answerPromise ? Promise.race([next(), answerPromise]) : next()); }
    finally { providerLifetime?.abort(new HarnessError("Question was settled by another answerer.", "ASK_ABORTED")); foregroundReplies.delete(key); request.signal?.removeEventListener("abort", onAbort); finish(); }
  };
  const on = (event, listener, options = {}) => disposers.push(ctx.on(event, listener, { global: true, ...options }));
  const hasJobs = agent => [...activeJobs.values()].some(job => job.owner === agent.id);
  const jobsFiber = ctx.inject(["jobs"], jobCtx => {
    const remember = job => {
      if (job.status === "running" || job.status === "stopping") activeJobs.set(job.id, { id: job.id, owner: job.owner });
      else activeJobs.delete(job.id);
    };
    for (const job of jobCtx.jobs.list()) remember(job);
    for (const agent of ctx.agents.list()) for (const job of jobCtx.jobs.list(agent.id)) remember(job);
    jobCtx.jobs.events.subscribe({ owners: "all" }, event => {
      if (closed || event.type === "output" || event.type === "progress") return;
      if (event.type === "removed") activeJobs.delete(event.job.id); else remember(event.job);
      const agent = ctx.agents.get(event.job.owner);
      if (event.type === "registered" && agent) resolve(`completed:${agent.id}`);
      if (event.type === "settled" && event.cause === "producer" && !event.awaited && event.job.status === "completed" && agent?.status === "idle" && !hasJobs(agent) && activeQuestions(agent).length === 0) pending(`completed:${agent.id}`, agent, "completed");
      push({});
    });
    jobCtx.effect(() => () => { activeJobs.clear(); push({}); });
    push({});
  });
  disposers.push(() => jobsFiber.dispose());
  on("approval/request", wrap("approval"), { prepend: true });
  on("user-questions/request", wrap("question"), { prepend: true });
  on("agent/created", ({ agent }) => { syncQuestions(agent); push({}); });
  on("agent/status", ({ agent }) => { if (ctx.agents.get(agent.id) !== agent) return; syncQuestions(agent); push({}); });
  on("agent/disposed", ({ agent }) => {
    blocking.delete(agent);
    for (const [key, value] of notifications) if (value.sessionId === agent.id) resolve(key);
    push({});
  });
  on("agent/assistant-stream", ({ agent, frame }) => { if (root(agent)) { metrics.stream(agent, frame); if (frame.type !== "chunk" || frame.chunk.type === "usage") push({}); } });
  on("session/event", (session, event) => {
    metrics.event(session, event);
    if (!["request/header", "tool/call", "tool/result", "tool/ptc-dispatch", "user/message", "turn/start", "turn/end"].includes(event.type)) return;
    const agent = ctx.agents.get(session.id);
    if (agent?.session !== session) return;
    syncQuestions(agent);
    if (event.type === "turn/start") resolve(`completed:${agent.id}`);
    if (event.type === "turn/end" && event.data.reason?.kind === "completed" && !hasJobs(agent) && activeQuestions(agent).length === 0) pending(`completed:${agent.id}`, agent, "completed");
    if (["tool/call", "tool/result", "tool/ptc-dispatch", "user/message", "turn/start", "turn/end"].includes(event.type)) push({});
  });
  for (const agent of ctx.agents.roots()) syncQuestions(agent);
  push({});
  const timer = setInterval(resync, heartbeatMs);
  timer.unref?.();
  return {
    answerReply: reply,
    async flush() { while (pumping || queue.length) await new Promise(resolve => setTimeout(resolve, 1)); },
    async close() {
      if (closed) return;
      // A final new epoch revokes all old native notification targets, without touching session state.
      closed = true; clearInterval(timer);
      for (const dispose of disposers.reverse()) await dispose();
      queue.length = 0; notifications.clear(); deliveredCompletions.clear(); blocking.clear(); activeJobs.clear(); replyTickets.clear(); foregroundReplies.clear(); send.setReplyHandler?.(undefined);
      // Keep reset after the last in-flight ACK so a delayed old request cannot resurrect state.
      while (pumping) await new Promise(resolve => setTimeout(resolve, 1));
      try { await send({ version: 1, epoch: randomUUID(), sequence: 1, running: 0, waiting: 0, sessions: [], sessionsComplete: true }); } catch { /* Native stale lease is the fallback. */ }
    },
  };
}

export function apply(ctx) {
  if (process.env.DSH_ANDROID !== "1") return;
  registerNotificationTool(ctx, createNotificationTransport(process.env));
  const transport = createHostEventTransport(process.env);
  if (!transport) return;
  const observer = observeHostEvents(ctx, transport);
  ctx.effect(() => () => observer.close());
}
