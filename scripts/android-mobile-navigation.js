/* Android-only navigation for the embedded DeepSeek Harness frontend. */
(function () {
  "use strict";
  document.documentElement.setAttribute("data-dsh-android-native", "");
  var layers = [];
  var nextId = 0;
  var mobile = window.matchMedia("(max-width: 600px), (pointer: coarse) and (max-width: 900px)");

  function visible(element) {
    if (!element || !document.documentElement.contains(element)) return false;
    var bounds = element.getBoundingClientRect();
    var style = window.getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  window.DshAndroidNavigation = {
    isMobile: function () { return mobile.matches; },
    // The callbacks are the original React actions, never simulated keys or
    // cosmetic DOM changes. Higher-priority child surfaces close first.
    register: function (element, close, priority) {
      if (!mobile.matches || !element || typeof close !== "function") return function () {};
      var layer = { id: ++nextId, element: element, close: close, priority: priority || 0 };
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
        if (visible(layer.element) && (!top || layer.priority > top.priority ||
          (layer.priority === top.priority && layer.id > top.id))) top = layer;
      });
      if (!top) return false;
      top.close();
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
          React.createElement("button", { type: "button", "aria-label": "Back",
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
