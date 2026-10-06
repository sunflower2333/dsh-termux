#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const START = "/* dsh-android-mobile */";
const END = "/* dsh-android-mobile-end */";

async function patchSharedPrimitives(dist, index) {
  // These exports are bundled into the frontend's shared registry. Editing
  // dsh-client-ui-primitives/lib/index.js would not affect the running Web UI.
  const entries = [...index.matchAll(/<script\s+[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/g)]
    .map(match => match[1]).filter(name => /(?:^|\/)index-[^/]+\.js$/.test(name));
  if (entries.length !== 1) throw new Error("dsh Android UI patch: expected one frontend entry module");
  const filename = join(dist, entries[0]);
  let source = await readFile(filename, "utf8");
  const marker = "/* dsh-android-shared-navigation-v1 */";
  if (source.includes(marker)) return;
  const exported = name => {
    const matches = [...source.matchAll(new RegExp(`\\b${name}:\\s*([A-Za-z_$][\\w$]*)`, "g"))];
    if (matches.length !== 1) throw new Error(`dsh Android UI patch: unsupported shared ${name} export`);
    return matches[0];
  };
  const surface = exported("MenuSurface")[1];
  const item = exported("MenuItemButton")[1];
  const declaration = new RegExp(`\\bconst\\s+${surface}\\s*=\\s*([A-Za-z_$][\\w$]*)\\.forwardRef\\(`).exec(source);
  if (!declaration) throw new Error("dsh Android UI patch: unsupported shared MenuSurface declaration");
  const end = source.indexOf(`function ${item}(`, declaration.index);
  if (end === -1) throw new Error("dsh Android UI patch: unsupported shared MenuSurface boundary");
  const segment = source.slice(declaration.index, end);
  const portal = /([A-Za-z_$][\w$]*)\.createPortal\(/.exec(segment);
  if (!portal || !/\}\);\s*$/.test(segment)) throw new Error("dsh Android UI patch: unsupported shared MenuSurface portal");
  const React = declaration[1];
  const wrapped = segment.replace(declaration[0], `const ${surface} = window.DshAndroidNavigation.wrapSurface(${React}.forwardRef(`)
    .replace(/\}\);\s*$/, `}), ${React}, ${portal[1]});\n`);
  source = source.slice(0, declaration.index) + wrapped + source.slice(end);
  // Wrap the real declarations, also covering shared components that call
  // each other directly rather than consulting the exported plugin registry.
  for (const [name, nextName, wrapper, asyncNext] of [
    ["Menu", "MenuGroup", "wrapMenu", false],
    ["useModalLayer", "ShortcutKeys", "wrapModal", false],
    ["useDismissOnOutsidePointer", "writeClipboard", "wrapOutside", true],
  ]) {
    const symbol = exported(name)[1];
    const nextSymbol = exported(nextName)[1];
    const start = source.indexOf(`function ${symbol}(`);
    const end = source.indexOf(`${asyncNext ? "async " : ""}function ${nextSymbol}(`, start);
    if (start === -1 || end === -1) throw new Error(`dsh Android UI patch: unsupported shared ${name} declaration`);
    const segment = source.slice(start, end);
    if (!/\}\s*$/.test(segment)) throw new Error(`dsh Android UI patch: unsupported shared ${name} boundary`);
    const wrapped = segment.replace(`function ${symbol}(`, `const ${symbol} = window.DshAndroidNavigation.${wrapper}(function(`)
      .replace(/\}\s*$/, `}, ${React});\n`);
    source = source.slice(0, start) + wrapped + source.slice(end);
  }
  await writeFile(filename, `${marker}\n${source}`);
  console.log("patched: dsh Android UI: running shared primitives native Back actions");
}

async function patchNavigationControllers(root) {
  const base = join(root, "node_modules/@deepseek-ai");
  const marker = "/* dsh-android-navigation-v1 */";
  const patch = async (plugin, updates, primitive = false) => {
    const filename = join(base, `dsh-client-ui-${plugin}/lib/${primitive ? "index" : "client"}.js`);
    let source = await readFile(filename, "utf8");
    if (source.includes(marker)) return;
    for (const [anchor, replacement] of updates) {
      if (source.split(anchor).length !== 2) {
        throw new Error(`dsh Android UI patch: unsupported ${plugin} navigation anchor: ${anchor.slice(0, 90)}`);
      }
      source = source.replace(anchor, replacement);
    }
    await writeFile(filename, `${marker}\n${source}`);
    console.log(`patched: dsh Android UI: ${plugin} native Back actions`);
  };
  await patch("settings-general", [
    ["          const result = await this.ctx.remote.settings.openSettingsDocument();\n          if (!result.ok) {", `          const result = await this.ctx.remote.settings.openSettingsDocument();
          if (result.ok && window.DshAndroidNavigation) {
            window.location.assign("/__dsh_android__/open-configuration");
          }
          if (!result.ok) {`],
  ]);
  await patch("sidebar", [
    ['      const column = (0, react.useRef)(null);', `      const column = (0, react.useRef)(null);
      const androidToggle = (0, react.useRef)(toggleSidebar);
      androidToggle.current = toggleSidebar;
      (0, react.useEffect)(() => {
        if (collapsed || !window.DshAndroidNavigation) return;
        return window.DshAndroidNavigation.register(column.current, () => androidToggle.current(), 10);
      }, [collapsed]);`],
    ['(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutlineRegular, {\n              className: SidebarRoot_module_css_default.panelIcon,', '(0, react_jsx_runtime.jsx)(window.DshAndroidNavigation?.isMobile() && !collapsed ? _deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutlineRegular : _deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutlineRegular, {\n              className: SidebarRoot_module_css_default.panelIcon,'],
  ]);
  await patch("input-trigger", [
    ['      const viewportRef = (0, react.useRef)(null);', `      const viewportRef = (0, react.useRef)(null);
      const androidDismiss = (0, react.useRef)(onDismiss);
      androidDismiss.current = onDismiss;
      (0, react.useEffect)(() => {
        if (!state.open || !window.DshAndroidNavigation) return;
        return window.DshAndroidNavigation.register(listRef.current, () => androidDismiss.current(), 100);
      }, [state.open]);`],
  ]);
  await patch("model-selection", [
    ['      const onRootKeyDown = (event) => {', `      const androidModelBack = (0, react.useRef)(null);
      androidModelBack.current = () => {
        if (pane !== "root" && state.current !== null) back(pane);
        else close(true);
      };
      (0, react.useEffect)(() => {
        if (!open || !window.DshAndroidNavigation) return;
        return window.DshAndroidNavigation.register(menuRef.current, () => androidModelBack.current(), 100);
      }, [open]);
      const onRootKeyDown = (event) => {`],
  ]);
  await patch("commands", [
    ['      const maxHeight = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredMaxHeight)(cardRef, MAX_HEIGHT, state);', `      const maxHeight = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredMaxHeight)(cardRef, MAX_HEIGHT, state);
      (0, react.useEffect)(() => {
        if (!state.open || state.confirming !== null || !window.DshAndroidNavigation) return;
        return window.DshAndroidNavigation.register(cardRef.current, () => popup.dismiss(), 100);
      }, [state.open, state.confirming, popup]);`],
  ]);
  await patch("trajectory", [
    ['      return (0, react_jsx_runtime.jsxs)("div", {\n        ref: rootRef,\n        className: TrajectoryTable_module_css_default.split,', `      const androidDetailClose = (0, react.useRef)(clearAllSelections);
      androidDetailClose.current = clearAllSelections;
      (0, react.useEffect)(() => {
        if (!window.DshAndroidNavigation) return;
        const detail = rootRef.current?.querySelector("[data-dsh-mobile-detail]");
        if (detail) return window.DshAndroidNavigation.register(detail, () => androidDetailClose.current(), 20);
      }, [selectedRecordId, selectedRequest]);
      return (0, react_jsx_runtime.jsxs)("div", {
        ref: rootRef,
        className: TrajectoryTable_module_css_default.split,`],
    ['          className: TrajectoryTable_module_css_default.details,\n          "aria-label": t("details.event"),', '          className: TrajectoryTable_module_css_default.details,\n          "data-dsh-mobile-detail": "",\n          "aria-label": t("details.event"),'],
  ]);
  await patch("conversation", [
    ['      const showTabs = !hideChrome && tabs.length > 1;', `      const showTabs = !hideChrome && tabs.length > 1;
      (0, react.useEffect)(() => {
        if (!showTabs || !active || active.id === "chat" || !window.DshAndroidNavigation) return;
        return window.DshAndroidNavigation.register(document.querySelector("[data-conversation-tabs]"), () => selectView("chat"), 0);
      }, [showTabs, active?.id, selectView]);`],
  ]);
  await patch("jobs", [
    ['      const menuRef = (0, react.useRef)(null);', `      const menuRef = (0, react.useRef)(null);
      const androidPanelRef = (0, react.useRef)(null);`],
    ['(0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen);',
      '(0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen, androidPanelRef);'],
    ['        }), open ? (0, react_jsx_runtime.jsxs)("ul", {\n          ref: menuRef,', `        }), open ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuSurface, {
          ref: androidPanelRef,
          "aria-label": t("list.aria"),
          children: (0, react_jsx_runtime.jsxs)("ul", {
          ref: menuRef,
          "data-dsh-mobile-list": "jobs",`],
    ['            settledExpanded ? settledRows.map(item) : null\n          ]\n        }) : null]\n      });',
      '            settledExpanded ? settledRows.map(item) : null\n          ]\n          })\n        }) : null]\n      });'],
  ]);
  await patch("cordis", [
    ['      const rootRef = (0, react.useRef)(null);', `      const rootRef = (0, react.useRef)(null);
      const androidPanelRef = (0, react.useRef)(null);`],
    ['(0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen);',
      '(0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen, androidPanelRef);'],
    ['children: [open && anchor !== void 0 && (0, react_jsx_runtime.jsxs)("section", {\n          className: CordisPanel_module_css_default.panel,',
      'children: [open && anchor !== void 0 && (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.MenuSurface, {\n          ref: androidPanelRef,\n          className: CordisPanel_module_css_default.panel,'],
  ]);
}

/** Refresh only the mobile layer, including packages with the older marker. */
export async function patchAndroidFrontend(root, { nativeShell = false } = {}) {
  const dist = join(root, "node_modules/@deepseek-ai/dsh-web-frontend/dist");
  let index = await readFile(join(dist, "index.html"), "utf8");
  const navigationTag = '<script data-dsh-android-navigation src="./assets/dsh-android-mobile-navigation.js"></script>';
  if (nativeShell && !index.includes("data-dsh-android-navigation")) {
    if (index.split("<head>").length !== 2) throw new Error("dsh Android UI patch: missing unique frontend head");
    index = index.replace("<head>", `<head>\n    ${navigationTag}`);
    await writeFile(join(dist, "index.html"), index);
  }
  if (nativeShell) {
    await writeFile(join(dist, "assets/dsh-android-mobile-navigation.js"),
      await readFile(new URL("./android-mobile-navigation.js", import.meta.url), "utf8"));
    await patchSharedPrimitives(dist, index);
    await patchNavigationControllers(root);
  }
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
    ["Y0dWHa", "trajectory", "detailsResizeHandle"],
    ["rtSEdW", "agent-preset", "cardHead"],
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
  await patchAndroidFrontend(process.argv[2], { nativeShell: process.argv.includes("--native-shell") });
}
