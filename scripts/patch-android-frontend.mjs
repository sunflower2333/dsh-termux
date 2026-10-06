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

async function patchMobileUseSettings(root) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js");
  let source = await readFile(filename, "utf8");
  const marker = "/* dsh-android-mobile-use-settings-v1 */";
  const route = "/__dsh_android__/mobile-control";
  if (source.includes(marker)) {
    for (const anchor of [marker, 'function AndroidMobileUseSection({ t }) {',
      'id: "android-mobile-use",', `window.location.assign("${route}")`]) {
      if (source.split(anchor).length !== 2) {
        throw new Error(`dsh Android UI patch: damaged Mobile use settings (${anchor})`);
      }
    }
    return;
  }
  const updates = [
    ['    function GeneralSection({ renderSlot }) {', `    function AndroidMobileUseSection({ t }) {
      return (0, react_jsx_runtime.jsxs)("section", {
        "data-dsh-android-mobile-use": "",
        "aria-label": t("mobileUse.nav"),
        style: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 16 },
        children: [
          (0, react_jsx_runtime.jsx)("h2", {
            style: { margin: 0, fontSize: 18, lineHeight: "26px", fontWeight: 600 },
            children: t("mobileUse.nav")
          }),
          (0, react_jsx_runtime.jsx)("p", {
            style: { margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-secondary)" },
            children: t("mobileUse.description")
          }),
          (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
            variant: "outline",
            size: "sm",
            style: { minHeight: 44, maxWidth: "100%", whiteSpace: "normal" },
            onClick: () => window.location.assign("${route}"),
            children: t("mobileUse.open")
          })
        ]
      });
    }
    function GeneralSection({ renderSlot }) {`],
    ['    const zh = {', `    const zh = {
      "mobileUse.nav": "手机操作",
      "mobileUse.description": "查看手机控制状态，打开系统无障碍设置，并手动允许或暂停本次手机控制。开启无障碍服务不会自动允许控制。",
      "mobileUse.open": "打开手机控制设置",`],
    ['    const en = {', `    const en = {
      "mobileUse.nav": "Mobile use",
      "mobileUse.description": "View phone control status, open Android Accessibility settings, and allow or pause control for this session. Enabling the service does not allow control automatically.",
      "mobileUse.open": "Open phone control settings",`],
    ['      ctx.slots.inject("settings.section", () => ctx.slots.register({\n        name: "settings.section",\n        id: "general",', `      if (window.DshAndroidNavigation) ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "android-mobile-use",
        order: 5,
        label: () => t("mobileUse.nav"),
        locale: NS
      }, AndroidMobileUseSection));
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "general",`],
  ];
  // Match the production SettingsGeneral module and write only after all
  // anchors pass. An upstream refactor must fail rather than silently add a
  // detached or duplicate settings entry. No host API result grants access.
  for (const [anchor, replacement] of updates) {
    if (source.split(anchor).length !== 2) {
      throw new Error(`dsh Android UI patch: unsupported Mobile use settings anchor (${anchor.slice(0, 90)})`);
    }
    source = source.replace(anchor, replacement);
  }
  await writeFile(filename, `${marker}\n${source}`);
  console.log("patched: dsh Android UI: native Mobile use settings section");
}

async function patchRuntimeExperience(root) {
  const base = join(root, "node_modules/@deepseek-ai");
  const patch = async (plugin, marker, updates) => {
    const filename = join(base, `dsh-client-ui-${plugin}/lib/client.js`);
    let source = await readFile(filename, "utf8");
    if (source.includes(marker)) return;
    for (const [anchor, replacement] of updates) {
      if (source.split(anchor).length !== 2) {
        throw new Error(`dsh Android UI patch: unsupported ${plugin} runtime experience (${anchor.slice(0, 80)})`);
      }
      source = source.replace(anchor, replacement);
    }
    await writeFile(filename, `${marker}\n${source}`);
  };
  await patch("workspace", "/* dsh-android-notification-navigation-v1 */", [
    ['        ctx.effect(() => {\n          const stop = this.watchNavigation();', `        ctx.effect(() => {
          const stopAndroidOpener = window.DshAndroidNavigation?.installSessionOpener(sessions, this) ?? (() => {});
          const stop = this.watchNavigation();`],
    ['          return () => {\n            stop();\n            this.lifetime.abort();', `          return () => {
            stopAndroidOpener();
            stop();
            this.lifetime.abort();`],
  ]);
  await patch("settings-general", "/* dsh-android-runtime-settings-v1 */", [
    ['    function GeneralSection({ renderSlot }) {', `    function AndroidRuntimeSection({ t }) {
      return (0, react_jsx_runtime.jsxs)("section", {
        "data-dsh-android-runtime-settings": "",
        "aria-label": t("androidRuntime.nav"),
        children: [
          (0, react_jsx_runtime.jsx)("h2", { children: t("androidRuntime.nav") }),
          (0, react_jsx_runtime.jsx)("p", { children: t("androidRuntime.background") }),
          (0, react_jsx_runtime.jsx)("p", { children: t("androidRuntime.notifications") }),
          (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
            variant: "outline", size: "sm",
            onClick: () => window.location.assign("/__dsh_android__/runtime-settings"),
            children: t("androidRuntime.open")
          })
        ]
      });
    }
    function GeneralSection({ renderSlot }) {`],
    ['    const zh = {', `    const zh = {
      "androidRuntime.nav": "后台与通知",
      "androidRuntime.background": "切换到其他 App 后，DSH 会通过前台服务继续运行任务；回到 App 可继续查看原会话。系统强制停止或清理进程仍会中断当前任务，已保存的会话会保留。",
      "androidRuntime.notifications": "开启通知后，等待回答或操作确认时会提醒你。点击通知返回对应会话，在 DSH 中回答或确认。通知权限与手机控制权限分别设置。",
      "androidRuntime.open": "打开后台与通知设置",`],
    ['    const en = {', `    const en = {
      "androidRuntime.nav": "Background & notifications",
      "androidRuntime.background": "DSH uses a foreground service to continue tasks when you switch apps. Return to view the same session. A system force-stop or process cleanup still interrupts the current task; saved conversations remain available.",
      "androidRuntime.notifications": "Enable notifications for questions and approval requests. Tap a notification to open its conversation, then answer or approve in DSH. Notification and phone control permissions are configured separately.",
      "androidRuntime.open": "Open background & notification settings",`],
    ['      ctx.slots.inject("settings.section", () => ctx.slots.register({\n        name: "settings.section",\n        id: "general",', `      if (window.DshAndroidNavigation) ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "android-runtime", order: 6,
        label: () => t("androidRuntime.nav"), locale: NS
      }, AndroidRuntimeSection));
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "general",`],
  ]);
  const filename = join(base, "dsh-client-ui-permission-presets/lib/client.js");
  let source = await readFile(filename, "utf8");
  const marker = "/* dsh-android-file-access-description-v1 */";
  if (!source.includes(marker)) {
    for (const [language, title, description] of [
      ["zh", "文件写入权限", "文件工具保留所选写入限制。Android 不支持工作区命令沙盒；使用受限权限时，Bash 命令需单次授权。完整访问会取消这些限制。"],
      ["en", "File write access", "File tools retain the selected write restrictions. Android has no workspace command sandbox; restricted modes require approval for each Bash invocation. Full access removes these restrictions."],
    ]) {
      const dictionary = new RegExp(`(    const ${language} = \\{)([\\s\\S]*?)(\\n    \\};)`);
      const match = dictionary.exec(source);
      if (!match) throw new Error(`dsh Android UI patch: unsupported ${language} permission dictionary`);
      let body = match[2];
      for (const [key, value] of [["title", title], ["description", description]]) {
        const entry = new RegExp(`("${key}": )"(?:[^"\\\\]|\\\\.)*"`, "g");
        if ([...body.matchAll(entry)].length !== 1) throw new Error(`dsh Android UI patch: unsupported permission ${language}.${key}`);
        body = body.replace(entry, (_, prefix) => prefix + JSON.stringify(value));
      }
      source = source.replace(match[0], match[1] + body + match[3]);
    }
    await writeFile(filename, `${marker}\n${source}`);
  }
  console.log("patched: dsh Android UI: background settings, notification navigation, file access disclosure");
}

async function patchSidebarDestinations(root) {
  const base = join(root, "node_modules/@deepseek-ai");
  const marker = "/* dsh-android-sidebar-destinations-v1 */";
  for (const [plugin, updates] of [
    ["sidebar", [
      ['          ctx.layout.selectPanel(id);', '          ctx.layout.selectPanel(id);\n          window.DshAndroidNavigation?.closeSidebar();'],
    ]],
    ["workspace", [
      ['        if (panel === "reveal") this.ctx.layout.selectPanel(null);', `        if (panel === "reveal") {
          this.ctx.layout.selectPanel(null);
          window.DshAndroidNavigation?.closeSidebar();
        }`],
      ['        this.ctx.layout.selectPanel(null);\n      }\n      replaceMain(', '        this.ctx.layout.selectPanel(null);\n        window.DshAndroidNavigation?.closeSidebar();\n      }\n      replaceMain('],
      ['        setFlowOpen(true);\n      }, [onClose]);', '        setFlowOpen(true);\n        window.DshAndroidNavigation?.closeSidebar();\n      }, [onClose]);'],
    ]],
    ["settings-general", [
      ['                  actions.open();', '                  actions.open();\n                  window.DshAndroidNavigation?.closeSidebar();'],
      ['              openSettings: actions.open,', '              openSettings: () => { actions.open(); window.DshAndroidNavigation?.closeSidebar(); },'],
    ]],
    ["model-selection", [
      ['      const androidModelBack = (0, react.useRef)(null);', `      const androidModelDismiss = (0, react.useRef)(close);
      androidModelDismiss.current = close;
      const androidModelBack = (0, react.useRef)(null);`],
      ['return window.DshAndroidNavigation.register(menuRef.current, () => androidModelBack.current(), 100);', 'return window.DshAndroidNavigation.register(menuRef.current, () => androidModelBack.current(), 100, () => androidModelDismiss.current(true));'],
    ]],
  ]) {
    const filename = join(base, `dsh-client-ui-${plugin}/lib/client.js`);
    let source = await readFile(filename, "utf8");
    if (source.includes(marker)) continue;
    for (const [anchor, replacement] of updates) {
      if (source.split(anchor).length !== 2) throw new Error(`dsh Android UI patch: unsupported ${plugin} sidebar destination (${anchor.slice(0, 80)})`);
      source = source.replace(anchor, replacement);
    }
    await writeFile(filename, `${marker}\n${source}`);
  }
  console.log("patched: dsh Android UI: sidebar closes after actual destination navigation");
}

async function patchAndroidThemeController(root) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js");
  let source = await readFile(filename, "utf8");
  const marker = "/* dsh-android-native-theme-controller-v1 */";
  if (source.includes(marker)) return;
  const updates = [
    ['        this.media = typeof matchMedia === "undefined" ? void 0 : matchMedia("(prefers-color-scheme: dark)");', `        this.media = window.DshAndroidNavigation
          ? window.DshAndroidNavigation.systemThemeMedia()
          : typeof matchMedia === "undefined" ? void 0 : matchMedia("(prefers-color-scheme: dark)");`],
    ['        this.adopt();\n      }\n      /**\n      * Read the current immutable theme snapshot.', `        this.adopt();
        if (window.DshAndroidNavigation) ctx.effect(() => {
          const syncAndroidTheme = () => {
            if (host.getSnapshot().value !== void 0) window.DshAndroidNavigation.syncTheme(this.getTheme());
          };
          const stopHost = host.subscribe(syncAndroidTheme);
          const stopTheme = ctx.on("theme/change", syncAndroidTheme);
          syncAndroidTheme();
          return () => { stopTheme(); stopHost(); };
        }, "ui-theme: Android preference projection");
      }
      /**
      * Read the current immutable theme snapshot.`],
  ];
  for (const [anchor, replacement] of updates) {
    if (source.split(anchor).length !== 2) throw new Error(`dsh Android UI patch: unsupported native theme controller (${anchor.slice(0, 80)})`);
    source = source.replace(anchor, replacement);
  }
  await writeFile(filename, `${marker}\n${source}`);
  console.log("patched: dsh Android UI: controller-owned Android light/dark/system projection");
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
    await patchMobileUseSettings(root);
    await patchRuntimeExperience(root);
    await patchSidebarDestinations(root);
    await patchAndroidThemeController(root);
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
    ["Mbwy4a", "user-questions", "headingBlock"],
    ["LVzXQa", "user-questions", "previewActions"],
    ["mna1RW", "approval", "actionRow"],
    ["_7yHdaG", "conversation", "fileSize"],
    ["xzv4MW", "chat", "timeStart"],
    ["Sixlwa", "chat", "userStack"],
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
