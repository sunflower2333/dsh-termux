#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const START = "/* dsh-android-mobile */";
const END = "/* dsh-android-mobile-end */";

/** Refresh only the mobile layer, including packages with the older marker. */
export async function patchAndroidFrontend(root) {
  const dist = join(root, "node_modules/@deepseek-ai/dsh-web-frontend/dist");
  const index = await readFile(join(dist, "index.html"), "utf8");
  const candidates = [...index.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g)]
    .map(match => match[1]).filter(href => /(?:^|\/)index-[^/]+\.css$/.test(href));
  if (candidates.length !== 1) {
    throw new Error(`dsh Android UI patch: expected one frontend index stylesheet, found ${candidates.length}`);
  }
  const filename = join(dist, candidates[0]);
  const before = await readFile(filename, "utf8");
  let css = before;
  const start = css.indexOf(START);
  if (start !== -1) {
    if (css.indexOf(START, start + START.length) !== -1) {
      throw new Error("dsh Android UI patch: duplicate mobile stylesheet markers");
    }
    let end = css.indexOf(END, start);
    if (end !== -1) {
      end += END.length;
    } else {
      // The first implementation appended one @media block without an end marker.
      const media = css.indexOf("@media", start + START.length);
      const open = css.indexOf("{", media);
      if (media === -1 || open === -1) throw new Error("dsh Android UI patch: malformed legacy layer");
      let depth = 1;
      end = open + 1;
      while (end < css.length && depth) {
        if (css[end] === "{") depth++;
        if (css[end] === "}") depth--;
        end++;
      }
      if (depth) throw new Error("dsh Android UI patch: unclosed legacy layer");
    }
    css = css.slice(0, start) + css.slice(end);
  }
  let mobile = await readFile(new URL("./android-mobile.css", import.meta.url), "utf8");
  const excel = await readFile(join(root,
    "node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.excel.js"), "utf8");
  for (const selector of ["luckysheet-sheet-area", "fortune-zoom-ratio-current"]) {
    if (!excel.includes(selector)) {
      throw new Error(`dsh Android UI patch: unsupported Excel footer (${selector})`);
    }
  }
  const conversation = await readFile(join(root,
    "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"), "utf8");
  for (const hook of ["data-conversation-content", "data-conversation-scroll",
    "data-content-phase", "data-composer-seat", "data-composer-input",
    "data-conversation-header-leading", "data-conversation-tabs",
    'setProperty("--dsh-composer-height"',
    'setProperty("--dsh-conversation-viewport-height"']) {
    if (!conversation.includes(hook)) {
      throw new Error(`dsh Android UI patch: unsupported conversation layout hook (${hook})`);
    }
  }
  const inputTrigger = await readFile(join(root,
    "node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js"), "utf8");
  if (!inputTrigger.includes('"data-trigger-menu"')) {
    throw new Error("dsh Android UI patch: unsupported input menu layout hook");
  }
  // Client plugins inject their CSS after the initial stylesheet. Resolve the
  // actual CSS-module names from those plugin bundles, so a new upstream build
  // cannot silently turn the mobile overrides into unmatched selectors.
  const bindings = [
    ["pI_x6G", "layout", "frame"],
    ["hHd-Xa", "sidebar", "logoRow"],
    ["bhn1Oq", "workspace", "searchButton"],
    ["VOzbGW", "settings-general", "navList"],
    ["wSkVaW", "conversation", "scrollBody"],
    ["qBU-ya", "trajectory", "ledger"],
    ["fV0t5q", "trajectory", "inner"],
    ["pXSMma", "conversation", "fishHitbox"],
    ["uV2eYG", "conversation", "cardWorkspaceTrigger"],
    ["gSkjMW", "attachment", "body"],
    ["cubgiG", "agent-preset", "seatLabel"],
    ["bVCLcG", "theme", "stepper"],
    ["_8HJdBW", "theme", "cubeRow"],
    ["zGbnIq", "settings-models", "rowHead"],
  ];
  for (const [prefix, plugin, anchor] of bindings) {
    const source = await readFile(join(root, `node_modules/@deepseek-ai/dsh-client-ui-${plugin}/lib/client.js`), "utf8");
    const matches = [...source.matchAll(new RegExp(`\\.([A-Za-z0-9_-]+)_${anchor}\\{`, "g"))];
    const actual = [...new Set(matches.map(match => match[1]))];
    if (actual.length !== 1) throw new Error(`dsh Android UI patch: unsupported ${plugin} CSS (${anchor})`);
    const suffixes = [...mobile.matchAll(new RegExp(`\\.${prefix}_([A-Za-z0-9]+)`, "g"))].map(match => match[1]);
    for (const suffix of new Set(suffixes)) {
      if (!source.includes(`.${actual[0]}_${suffix}`)) {
        throw new Error(`dsh Android UI patch: missing ${plugin} style ${suffix}`);
      }
    }
    mobile = mobile.replaceAll(`.${prefix}_`, `.${actual[0]}_`);
  }
  const after = `${css.trimEnd()}\n${mobile}`;
  if (before === after) {
    console.log("skipped: dsh Android UI: mobile stylesheet current");
    return;
  }
  await writeFile(filename, after);
  console.log(`patched: dsh Android UI: responsive WebView stylesheet (${candidates[0]})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-frontend.mjs <dsh-package-directory>");
  await patchAndroidFrontend(process.argv[2]);
}
