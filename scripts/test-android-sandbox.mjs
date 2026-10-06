#!/usr/bin/env node
// HOST integration: real DSH Bash tool/approval algorithm and filesystem fence.
// Approval and shell execution are bounded fixtures; this is not Android guest QA.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, cp, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { patchAndroidSandbox } from "./patch-android-sandbox.mjs";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("usage: test-android-sandbox.mjs <dsh-package-directory>");
const work = await mkdtemp(join(tmpdir(), "dsh-android-sandbox-test-"));
const scope = join(work, "node_modules/@deepseek-ai");
await mkdir(scope, { recursive: true });
for (const entry of await readdir(join(packageRoot, "node_modules"))) {
  if (entry !== "@deepseek-ai") await symlink(resolve(packageRoot, "node_modules", entry), join(work, "node_modules", entry));
}
for (const entry of await readdir(join(packageRoot, "node_modules/@deepseek-ai"))) {
  const source = resolve(packageRoot, "node_modules/@deepseek-ai", entry);
  if (["dsh-sandbox", "dsh-sandbox-local", "dsh-tool-bash"].includes(entry)) await cp(source, join(scope, entry), { recursive: true });
  else await symlink(source, join(scope, entry));
}
const bashFile = join(scope, "dsh-tool-bash/lib/index.js");
const originalBash = await readFile(bashFile, "utf8");
await patchAndroidSandbox(work);
assert.equal(await readFile(bashFile, "utf8"), originalBash, "default/Termux patch must leave Bash byte-identical");
await patchAndroidSandbox(work, { nativeShell: true });
const patchedBash = await readFile(bashFile, "utf8");
await patchAndroidSandbox(work, { nativeShell: true });
assert.equal(await readFile(bashFile, "utf8"), patchedBash, "APK patch is idempotent");
const moduleAt = name => import(pathToFileURL(join(scope, name, "lib/index.js")));
const [{ apply }, { SandboxUnavailableError, SANDBOX_UNAVAILABLE }, { Context }, { LocalSandboxProvider }, { SandboxedFileSystem }] = await Promise.all([
  moduleAt("dsh-tool-bash"), moduleAt("dsh-sandbox"), moduleAt("cordis"), moduleAt("dsh-sandbox-local"), moduleAt("dsh-fs-sandbox"),
]);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalAndroid = process.env.DSH_ANDROID;
// Outside /tmp, because DSH intentionally permits platform temp writes.
const fileArea = await mkdtemp(join(process.cwd(), ".dsh-file-fence-test-"));
after(async () => {
  Object.defineProperty(process, "platform", originalPlatform);
  if (originalAndroid === undefined) delete process.env.DSH_ANDROID; else process.env.DSH_ANDROID = originalAndroid;
  await rm(work, { recursive: true, force: true });
  await rm(fileArea, { recursive: true, force: true });
});
async function native(task, { platform = "android", flag = "1" } = {}) {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  process.env.DSH_ANDROID = flag;
  try { return await task(); } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalAndroid === undefined) delete process.env.DSH_ANDROID; else process.env.DSH_ANDROID = originalAndroid;
  }
}
function fixture({ mode = "workspace-write", outcome = "allowed-once", approver = true, agent = true, onAsk } = {}) {
  const policy = Object.freeze({ mode, workspaceRoot: fileArea });
  const approvals = [], executions = [];
  const controller = new AbortController();
  let tool;
  const ctx = {
    shell: {
      sandboxMode: "workspace-write",
      resolve: request => ({ ...request, timeoutMs: request.timeoutMs ?? 30000 }),
      execute: async spec => {
        spec.signal?.throwIfAborted(); executions.push(spec);
        return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: "fixture result", truncated: false }, stderr: { text: "", truncated: false }, sandbox: { mode: spec.sandboxPolicy.mode, denied: false } }) };
      },
    },
    systemPrompt: { section() {}, getSectionOrder() { return 0; } },
    shellEnv: { collect() { return {}; } },
    tools: { register(value) { tool = value; return () => {}; } },
    get(name) {
      if (name === "sandboxPolicy") return { resolve: () => policy };
      if (name === "approval" && approver) return { async request(ask) { approvals.push(ask); await onAsk?.(ask, controller); return outcome; } };
    },
  };
  apply(ctx, { enableRunInBackground: false });
  const exec = { signal: controller.signal, callId: "fixture-call", ...(agent ? { agent: { session: { header: { cwd: fileArea } } } } : {}) };
  const args = { command: "printf fixture", description: "Print fixture output" };
  return { policy, approvals, executions, controller, run: extra => tool.execute({ ...args, ...extra }, exec) };
}
test("native restricted Bash asks once before execution and retains standing file policy", async () => native(async () => {
  const f = fixture({ onAsk() { assert.equal(f.executions.length, f.approvals.length - 1); } });
  const result = await f.run();
  assert.equal(result.sandbox.mode, "danger-full-access");
  assert.equal(f.approvals.length, 1);
  assert.match(f.approvals[0].displayReason.zh, /本次/);
  assert.equal(f.executions[0].sandboxPolicy.mode, "danger-full-access");
  assert.equal(f.policy.mode, "workspace-write");
  await f.run();
  assert.equal(f.approvals.length, 2, "each command needs its own grant");
}));
test("read-only Bash approval does not change session read-only mode", async () => native(async () => {
  const f = fixture({ mode: "read-only" }); await f.run();
  assert.equal(f.policy.mode, "read-only"); assert.equal(f.approvals.length, 1);
}));
for (const outcome of ["rejected", "cancelled", "unavailable"]) {
  test(`${outcome} prevents all shell execution`, async () => native(async () => {
    const f = fixture({ outcome }); await assert.rejects(f.run()); assert.equal(f.executions.length, 0);
  }));
}
for (const missing of ["approver", "agent"]) {
  test(`missing ${missing} fails closed before shell execution`, async () => native(async () => {
    const f = fixture({ [missing]: false }); await assert.rejects(f.run()); assert.equal(f.executions.length, 0);
  }));
}
test("cancellation while approval is pending prevents an obsolete grant from running", async () => native(async () => {
  const f = fixture({ onAsk(ask, controller) { controller.abort(); } });
  await assert.rejects(f.run(), { name: "AbortError" }); assert.equal(f.executions.length, 0);
}));
test("explicit one-command escalation uses the existing prompt only once", async () => native(async () => {
  const f = fixture(); await f.run({ sandbox_permissions: "danger-full-access", justification: "Run this fixture once." });
  assert.equal(f.approvals.length, 1); assert.equal(f.policy.mode, "workspace-write");
}));
test("an explicitly selected Full Access policy retains upstream behavior", async () => native(async () => {
  const f = fixture({ mode: "danger-full-access" }); await f.run(); assert.equal(f.approvals.length, 0);
}));
for (const options of [{ platform: "android", flag: "0" }, { platform: "linux", flag: "1" }]) {
  test(`native guard does not alter ${options.platform}/DSH_ANDROID=${options.flag}`, async () => native(async () => {
    const f = fixture(); await f.run(); assert.equal(f.approvals.length, 0); assert.equal(f.executions[0].sandboxPolicy.mode, "workspace-write");
  }, options));
}
test("Android sandbox provider refuses confined commands without probing desktop backends", async () => native(async () => {
  const ctx = new Context();
  const provider = new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 });
  provider.internals = { platform: "android", probeBwrap() { throw new Error("unexpected desktop probe"); }, probeLandlock() { throw new Error("unexpected desktop probe"); } };
  await assert.rejects(provider.confine(["bash", "-c", "printf fixture"], { mode: "workspace-write", workspaceRoot: fileArea }), error => error.code === SANDBOX_UNAVAILABLE && /not workspace confinement/.test(error.message));
}));
test("native unavailable error explains app isolation and remaining file fence", async () => native(async () => {
  const error = new SandboxUnavailableError("workspace-write");
  assert.match(error.message, /this command did not run/); assert.match(error.message, /not workspace confinement/);
  assert.doesNotMatch(error.message, /Install bubblewrap|switch the consumer/);
}));
function fileFence(cwd, mode = "workspace-write") {
  const ctx = new Context();
  ctx.reflect.provide("sandboxPolicy", { defaultMode: mode, resolve() { return { mode, workspaceRoot: cwd }; } });
  return new SandboxedFileSystem(ctx, { cwd, diffBasisMaxBytes: 1024 * 1024 });
}
test("real filesystem fence writes inside workspace and refuses an outside app-data path", async () => {
  const cwd = join(fileArea, "workspace"); await mkdir(cwd); const fs = fileFence(cwd);
  const inside = await fs.resolve(join(cwd, "inside.txt")); await fs.writeText(inside, "inside");
  assert.equal(await readFile(join(cwd, "inside.txt"), "utf8"), "inside");
  const outside = await fs.resolve(join(fileArea, "outside.txt"));
  await assert.rejects(fs.writeText(outside, "outside"), error => error.code === "FS_SANDBOX_DENIED");
});
test("real filesystem fence re-canonicalizes symlinks before mutation", async () => {
  const cwd = join(fileArea, "symlink-workspace"); const outside = join(fileArea, "symlink-outside");
  await mkdir(cwd); await mkdir(outside); await symlink(outside, join(cwd, "link"));
  const fs = fileFence(cwd); const target = await fs.resolve(join(cwd, "link", "escaped.txt"));
  await assert.rejects(fs.writeText(target, "escape"), error => error.code === "FS_SANDBOX_DENIED");
});
test("real read-only filesystem fence refuses even workspace writes after Bash approval", async () => {
  const cwd = join(fileArea, "readonly-workspace"); await mkdir(cwd); const fs = fileFence(cwd, "read-only");
  await native(async () => { const f = fixture({ mode: "read-only" }); await f.run(); assert.equal(f.policy.mode, "read-only"); });
  await assert.rejects(fs.writeText(await fs.resolve(join(cwd, "denied.txt")), "deny"), error => error.code === "FS_SANDBOX_DENIED");
});
