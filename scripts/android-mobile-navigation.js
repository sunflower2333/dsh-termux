/* Android-only navigation for the embedded DeepSeek Harness frontend. */
(function () {
  "use strict";
  document.documentElement.setAttribute("data-dsh-android-native", "");
  var layers = [];
  var nextId = 0;
  var mobile = window.matchMedia("(max-width: 600px), (pointer: coarse) and (max-width: 900px)");
  var systemMedia = null;
  var themePort = null;
  var latestTheme = null;
  var workspaceChooser = null;
  var workspacePicker = null;

  function backLabel() {
    // DSH's LocaleRuntime writes the effective UI language to the document.
    return String(document.documentElement.lang || "").toLowerCase().split("-")[0] === "zh" ? "返回" : "Back";
  }
  if (typeof MutationObserver === "function") {
    new MutationObserver(function () {
      document.querySelectorAll("[data-dsh-android-back]").forEach(function (button) {
        button.setAttribute("aria-label", backLabel());
      });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  function workspacePath(path) {
    return typeof path === "string" && path.length > 1 && path.length <= 4096 &&
      path.charAt(0) === "/" && !/[\u0000-\u001f\u007f]/.test(path) &&
      !path.split("/").some(function (part) { return part === "." || part === ".."; });
  }

  function workspaceRequest(requestId) {
    return workspacePicker && workspacePicker.id === requestId && !workspacePicker.accepted &&
      workspaceChooser && workspacePicker.owner === workspaceChooser;
  }

  window.__DSH_ANDROID_SELECT_WORKSPACE__ = function (path, requestId) {
    if (!workspaceRequest(requestId) || !workspacePath(path)) return false;
    var request = workspacePicker;
    request.accepted = true;
    Promise.resolve().then(function () { return request.owner.select(path); }).then(function () {
      if (workspacePicker !== request || workspaceChooser !== request.owner) return;
      workspacePicker = null;
      request.onSuccess();
    }, function (error) {
      if (workspacePicker !== request || workspaceChooser !== request.owner) return;
      workspacePicker = null;
      request.onError(error instanceof Error ? error.message : String(error));
    });
    return true;
  };
  window.__DSH_ANDROID_BROWSE_WORKSPACE__ = function (requestId) {
    if (!workspaceRequest(requestId)) return false;
    var request = workspacePicker;
    workspacePicker = null;
    request.onBrowse();
    return true;
  };
  window.__DSH_ANDROID_WORKSPACE_RESULT__ = function (requestId, status, message) {
    if (!workspaceRequest(requestId) || ["cancelled", "error"].indexOf(status) === -1) return false;
    var request = workspacePicker;
    workspacePicker = null;
    if (status === "cancelled") request.onCancel();
    else request.onError(typeof message === "string" && message.length <= 2048 ? message : "Unable to open this folder. Choose it again or use an app folder.");
    return true;
  };

  function sendTheme() {
    if (!themePort || !latestTheme) return;
    try { themePort.postMessage(JSON.stringify(latestTheme)); }
    catch (_) { themePort = null; }
  }
  // Android transfers this port only to its checked main document. Keep the
  // writable endpoint in this closure; the interface visible to subframes can
  // only read the actual system mode.
  window.addEventListener("message", function (event) {
    if (event.data !== "dsh.android.theme.port.v1" || event.source !== null ||
      (event.origin !== "" && event.origin !== "null" && event.origin !== window.location.origin) ||
      !event.ports || event.ports.length !== 1) return;
    if (themePort && typeof themePort.close === "function") themePort.close();
    themePort = event.ports[0];
    if (typeof themePort.start === "function") themePort.start();
    sendTheme();
  });

  function visible(element) {
    if (!element || !document.documentElement.contains(element)) return false;
    var bounds = element.getBoundingClientRect();
    var style = window.getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function closeLayer(layer, reveal) {
    if (layer.closing) return;
    // React commits after the action returns. A second navigation in that
    // interval must not toggle the same sidebar back open. Other layers can
    // intentionally keep their surface open while Back changes an inner pane.
    if (layer.priority === 10) layer.closing = true;
    try { (reveal ? layer.dismiss : layer.close)(); }
    catch (error) { layer.closing = false; throw error; }
  }

  window.DshAndroidNavigation = {
    isMobile: function () { return mobile.matches; },
    systemThemeMedia: function () {
      if (!window.AndroidUiMode || typeof window.AndroidUiMode.isDark !== "function") {
        return window.matchMedia("(prefers-color-scheme: dark)");
      }
      if (systemMedia) return systemMedia;
      var dark = window.AndroidUiMode.isDark();
      if (typeof dark !== "boolean") return window.matchMedia("(prefers-color-scheme: dark)");
      var listeners = [];
      systemMedia = {
        media: "(prefers-color-scheme: dark)",
        matches: dark,
        addEventListener: function (type, callback) {
          if (type === "change" && listeners.indexOf(callback) === -1) listeners.push(callback);
        },
        removeEventListener: function (type, callback) {
          var index = type === "change" ? listeners.indexOf(callback) : -1;
          if (index !== -1) listeners.splice(index, 1);
        }
      };
      window.__DSH_ANDROID_SYSTEM_UI_MODE__ = function (nextDark) {
        if (typeof nextDark !== "boolean" || systemMedia.matches === nextDark) return;
        systemMedia.matches = nextDark;
        listeners.slice().forEach(function (callback) {
          callback({ matches: nextDark, media: systemMedia.media });
        });
      };
      return systemMedia;
    },
    syncTheme: function (snapshot) {
      var preference = snapshot && snapshot.preference;
      var scheme = snapshot && snapshot.active && snapshot.active.colorScheme;
      if (["light", "dark", "system"].indexOf(preference) === -1 ||
        ["light", "dark"].indexOf(scheme) === -1) return;
      latestTheme = { version: 1, preference: preference, resolvedScheme: scheme };
      sendTheme();
    },
    // The callbacks are the original React actions, never simulated keys or
    // cosmetic DOM changes. Higher-priority child surfaces close first.
    register: function (element, close, priority, dismiss) {
      if (!mobile.matches || !element || typeof close !== "function") return function () {};
      var layer = { id: ++nextId, element: element, close: close,
        dismiss: typeof dismiss === "function" ? dismiss : close, priority: priority || 0 };
      layers.push(layer);
      return function () {
        var index = layers.indexOf(layer);
        if (index !== -1) layers.splice(index, 1);
      };
    },
    back: function () {
      if (!mobile.matches) return false;
      var top = null;
      layers.forEach(function (layer) {
        if (!layer.closing && visible(layer.element) && (!top || layer.priority > top.priority ||
          (layer.priority === top.priority && layer.id > top.id))) top = layer;
      });
      if (!top) return layers.some(function (layer) { return layer.closing && visible(layer.element); });
      closeLayer(top);
      return true;
    },
    closeSidebar: function () {
      if (!mobile.matches) return false;
      var sidebar = null;
      layers.forEach(function (layer) {
        // Priority 10 belongs to the real sidebar's original toggle action.
        if (layer.priority === 10 && !layer.closing && visible(layer.element) &&
          (!sidebar || layer.id > sidebar.id)) sidebar = layer;
      });
      if (!sidebar) return false;
      closeLayer(sidebar);
      return true;
    },
    // A notification opens the same Controller-owned session as a sidebar
    // gesture. Close visible navigation surfaces through their real actions,
    // leaving the session stores (including unsent drafts) in their owners.
    revealSession: function () {
      var visibleLayers = layers.filter(function (layer) { return !layer.closing && visible(layer.element); });
      visibleLayers.sort(function (a, b) { return b.priority - a.priority || b.id - a.id; });
      visibleLayers.forEach(function (layer) { closeLayer(layer, true); });
    },
    installSessionOpener: function (sessions, navigation) {
      var open = function (id) {
        if (typeof id !== "string" || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) return false;
        var list = sessions.list.getSnapshot();
        if (list.phase !== "ready" || !Object.prototype.hasOwnProperty.call(list.byId, id)) return false;
        try {
          navigation.openSession(id);
          if (navigation.selection.getSnapshot().sessionId !== id) return false;
          window.DshAndroidNavigation.revealSession();
          return true;
        } catch (_) {
          return false;
        }
      };
      window.__DSH_ANDROID_OPEN_SESSION__ = open;
      return function () {
        if (window.__DSH_ANDROID_OPEN_SESSION__ === open) delete window.__DSH_ANDROID_OPEN_SESSION__;
      };
    },
    installWorkspaceChooser: function (select) {
      if (typeof select !== "function") throw new Error("Workspace chooser requires its Controller action");
      var owner = { select: select };
      workspacePicker = null;
      workspaceChooser = owner;
      return function () {
        if (workspaceChooser !== owner) return;
        workspaceChooser = null;
        if (workspacePicker && workspacePicker.owner === owner) workspacePicker = null;
      };
    },
    chooseWorkspace: function (callbacks) {
      if (!workspaceChooser || workspacePicker || !window.crypto || typeof window.crypto.getRandomValues !== "function") return false;
      if (!callbacks || ["onSuccess", "onBrowse", "onCancel", "onError"].some(function (name) { return typeof callbacks[name] !== "function"; })) return false;
      var random = new Uint8Array(16);
      window.crypto.getRandomValues(random);
      var requestId = Array.prototype.map.call(random, function (value) { return (value + 256).toString(16).slice(1); }).join("");
      var request = Object.assign({ id: requestId, owner: workspaceChooser, accepted: false }, callbacks);
      workspacePicker = request;
      try { window.location.assign("/__dsh_android__/choose-workspace?request=" + requestId); }
      catch (error) {
        if (workspacePicker === request) workspacePicker = null;
        callbacks.onError(error instanceof Error ? error.message : String(error));
      }
      return true;
    },
    wrapModal: function (original, React) {
      return function (dialog, open, close) {
        original(dialog, open, close);
        var callback = React.useRef(close);
        callback.current = close;
        React.useLayoutEffect(function () {
          if (!open) return;
          return window.DshAndroidNavigation.register(dialog.current, function () { callback.current(); }, 100);
        }, [dialog, open]);
      };
    },
    wrapOutside: function (original, React) {
      return function (root, open, close, portal) {
        original(root, open, close, portal);
        var callback = React.useRef(close);
        callback.current = close;
        React.useEffect(function () {
          if (!open) return;
          var panel = portal && portal.current;
          if (panel && mobile.matches) panel.setAttribute("data-dsh-mobile-popover", "");
          var unregister = window.DshAndroidNavigation.register(panel || root.current, function () { callback.current(false); }, 100);
          return function () {
            unregister();
            if (panel) panel.removeAttribute("data-dsh-mobile-popover");
          };
        }, [root, open, portal]);
      };
    },
    wrapMenu: function (original, React) {
      return function (props) {
        var className = "dsh-android-menu-" + React.useId().replace(/:/g, "");
        var close = React.useRef(props.onClose);
        close.current = props.onClose;
        React.useEffect(function () {
          if (!props.open) return;
          var element = document.getElementsByClassName(className)[0];
          return window.DshAndroidNavigation.register(element, function () { close.current(); }, 100);
        }, [props.open, className]);
        return React.createElement(original, Object.assign({}, props, {
          portal: mobile.matches || props.portal,
          listClassName: (props.listClassName || "") + " " + className
        }));
      };
    },
    wrapSurface: function (original, React, ReactDOM) {
      var ParentMenu = React.createContext(false);
      return React.forwardRef(function (props, ref) {
        var nested = React.useContext(ParentMenu);
        if (!mobile.matches) return React.createElement(original, Object.assign({}, props, { ref: ref }));
        var header = React.createElement("div", { "data-dsh-mobile-menu-header": "", key: "android-back" },
          React.createElement("button", { type: "button", "data-dsh-android-back": "", "aria-label": backLabel(),
            onClick: function () { window.__DSH_ANDROID_BACK__(); } }, "←"),
          React.createElement("span", null, props["aria-label"] || "DeepSeek Harness"));
        var surface = React.createElement(original, Object.assign({}, props, { ref: ref }), header, props.children);
        // Submenus remain descendants of the parent surface so its original
        // outside-pointer checks keep accepting their real item gestures.
        return React.createElement(ParentMenu.Provider, { value: true },
          nested ? surface : ReactDOM.createPortal(surface, document.body));
      });
    }
  };
  window.__DSH_ANDROID_BACK__ = function () { return window.DshAndroidNavigation.back(); };
}());
