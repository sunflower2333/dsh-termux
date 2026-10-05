#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

// Exercise DSH's actual profile resolver in both its main and worker paths.
// This needs no host version of the Android-only PTY or FFI dependencies.
export function verifyNodeInternals(root) {
  const result = spawnSync(process.execPath, [
    "--expose-internals", fileURLToPath(import.meta.url), resolve(root),
  ], { stdio: "inherit", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DSH Node internal resolver verification failed (${result.status ?? result.signal})`);
}

async function verifyResolver(root) {
  assert(process.execArgv.includes("--expose-internals"), "the verifier must use the production Node flag");
  const anchor = join(root, "package.json");
  const require = createRequire(anchor);
  const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")));
  const { PluginPackages, createRuntimeResolution } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot")));
  const home = await mkdtemp(join(tmpdir(), "dsh-node-internals-"));
  const ctx = new Context();
  try {
    const resolution = await createRuntimeResolution({ installAnchor: anchor, home });
    new PluginPackages(ctx, { resolution });
    const packageName = "@deepseek-ai/dsh-home-paths";
    const esmLoader = require("internal/modules/esm/loader").getOrInitializeCascadedLoader();
    const cjs = require(packageName);
    const esm = await esmLoader.import(packageName, pathToFileURL(anchor).href, {});
    assert.equal(typeof cjs.resolveDshHome, "function");
    assert.equal(esm.resolveDshHome(), cjs.resolveDshHome());

    const bootstrap = pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap")).href;
    const code = `
      import ${JSON.stringify(bootstrap)};
      import { createRequire } from "node:module";
      import { parentPort } from "node:worker_threads";
      const require = createRequire(${JSON.stringify(anchor)});
      const cjs = require(${JSON.stringify(packageName)});
      const loader = require("internal/modules/esm/loader").getOrInitializeCascadedLoader();
      const esm = await loader.import(${JSON.stringify(packageName)}, ${JSON.stringify(pathToFileURL(anchor).href)}, {});
      parentPort.postMessage({ cjs: cjs.resolveDshHome(), esm: esm.resolveDshHome() });
    `;
    const workerResult = await new Promise((resolveResult, reject) => {
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`));
      let message;
      worker.once("message", (value) => { message = value; });
      worker.once("error", reject);
      worker.once("exit", (exitCode) => {
        if (exitCode === 0 && message) resolveResult(message);
        else reject(new Error(`profile resolution worker exited (${exitCode})`));
      });
    });
    assert.deepEqual(workerResult, { cjs: cjs.resolveDshHome(), esm: cjs.resolveDshHome() });
    console.log(`verified DSH main/worker ESM and CommonJS resolution (${resolution.entries.length} packages)`);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("usage: verify-node-internals.mjs <dsh-package-directory>");
  if (!process.execArgv.includes("--expose-internals")) verifyNodeInternals(process.argv[2]);
  else await verifyResolver(resolve(process.argv[2]));
}
