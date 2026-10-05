#!/usr/bin/env node
import { readFile, writeFile, readdir, access, copyFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const TARGET = "chrome83";
const MARKER = "/* dsh-android-webview83-v1 */";
const SEGMENTER_MARKER = "/* dsh-android-webview83-intl-segmenter-v1 */";
const NATIVE_API_MARKER = "/* dsh-android-webview83-native-apis-v1 */";
const RESOURCE_URL_MARKER = "/* dsh-android-webview83-resource-url-v1 */";
const HTML_MARKER = "/* dsh-android-webview83-html */";
const POLYFILL_TAG = '<script data-dsh-android-webview83 src="./assets/dsh-webview83-polyfills.js"></script>';
const TOOLS = { esbuild: "0.28.2", "core-js-bundle": "3.50.0", "wicg-inert": "3.1.3",
  "@formatjs/intl-segmenter": "12.2.15", "@formatjs/intl-localematcher": "0.9.0",
  "@formatjs/fast-memoize": "3.1.7" };

// core-js covers the observed ES library gaps (at/hasOwn/toSorted/withResolvers/
// structuredClone/etc.). DOM/Abort additions below cover actual unguarded uses
// in the shipped DSH browser modules; native implementations remain untouched.
const BROWSER_ADDITIONS = `
(function () {
  var g = globalThis;
  // WebView 83 has cryptographic random bytes but predates randomUUID. Keep
  // RFC 4122 version/variant bits and never substitute Math.random entropy.
  if (g.crypto && typeof g.crypto.getRandomValues === 'function' && !g.crypto.randomUUID) {
    Object.defineProperty(g.crypto, 'randomUUID', { configurable: true, writable: true, enumerable: true,
      value: function () {
        if (this !== g.crypto) throw new TypeError('Illegal invocation');
        var bytes = g.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
          hex.slice(16, 20) + '-' + hex.slice(20);
      }
    });
  }
  // Android's stock WebView advertises clipboard.writeText but its native
  // permission manager always denies sanitized writes. Copy synchronously
  // during the real user gesture instead; awaiting that denial would consume
  // the activation needed by execCommand. Retain the native method as a real
  // fallback when synchronous copy fails; leave other browsers untouched.
  if (g.document && g.navigator && g.navigator.clipboard &&
      /Android/.test(g.navigator.userAgent) && /; wv\\)/.test(g.navigator.userAgent) &&
      typeof g.document.execCommand === 'function') {
    var nativeClipboardWrite = g.navigator.clipboard.writeText;
    Object.defineProperty(g.navigator.clipboard, 'writeText', { configurable: true, writable: true,
      value: function (text) {
        if (!arguments.length || typeof text === 'symbol') return Promise.reject(new TypeError('Invalid clipboard text'));
        var active = document.activeElement;
        var selection = document.getSelection();
        var ranges = [];
        if (selection) for (var at = 0; at < selection.rangeCount; at++) ranges.push(selection.getRangeAt(at).cloneRange());
        var selectionDirection = selection && selection.rangeCount ?
          [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] : null;
        var inputSelection = active && typeof active.selectionStart === 'number' ?
          [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
        var scrollX = g.scrollX, scrollY = g.scrollY;
        var input = document.createElement('textarea');
        input.value = String(text);
        input.readOnly = true;
        input.setAttribute('aria-hidden', 'true');
        input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
        var copied = false, error;
        try {
          document.body.appendChild(input); input.select();
          copied = document.execCommand('copy');
        } catch (caught) { error = caught; }
        finally {
          input.remove();
          if (active && active.isConnected && typeof active.focus === 'function') active.focus({ preventScroll: true });
          if (selection) {
            selection.removeAllRanges();
            ranges.forEach(function (range) { selection.addRange(range); });
            if (selectionDirection && typeof selection.setBaseAndExtent === 'function') {
              selection.setBaseAndExtent(selectionDirection[0], selectionDirection[1], selectionDirection[2], selectionDirection[3]);
            }
          }
          // Restoring document ranges can reset an input's caret. Restore its
          // own selection last, including a backwards selection direction.
          if (inputSelection) active.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2]);
          g.scrollTo(scrollX, scrollY);
        }
        if (copied) return Promise.resolve();
        if (typeof nativeClipboardWrite === 'function') {
          try { return nativeClipboardWrite.call(g.navigator.clipboard, text); }
          catch (caught) { error = caught; }
        }
        return Promise.reject(error || new DOMException('Copy was not allowed', 'NotAllowedError'));
      }
    });
  }
  var abortReasons = new WeakMap();
  var Signal = g.AbortSignal;
  var Controller = g.AbortController;
  function abortError() { return new DOMException('This operation was aborted', 'AbortError'); }
  if (Signal && Controller) {
    if (!('reason' in Signal.prototype)) {
      var nativeAbort = Controller.prototype.abort;
      Controller.prototype.abort = function (reason) {
        if (!this.signal.aborted) abortReasons.set(this.signal, reason === undefined ? abortError() : reason);
        return nativeAbort.call(this);
      };
      Object.defineProperty(Signal.prototype, 'reason', { configurable: true, get: function () {
        if (!this.aborted) return undefined;
        if (!abortReasons.has(this)) abortReasons.set(this, abortError());
        return abortReasons.get(this);
      }});
    }
    if (!Signal.prototype.throwIfAborted) Signal.prototype.throwIfAborted = function () {
      if (this.aborted) throw this.reason;
    };
    if (!Signal.abort) Signal.abort = function (reason) {
      var controller = new Controller(); controller.abort(reason); return controller.signal;
    };
    if (!Signal.any) Signal.any = function (sources) {
      var signals = Array.from(sources);
      signals.forEach(function (signal) {
        if (!(signal instanceof Signal)) throw new TypeError('AbortSignal.any requires AbortSignals');
      });
      var controller = new Controller();
      var listeners = [];
      function finish(signal) {
        controller.abort(signal.reason);
        listeners.forEach(function (entry) { entry[0].removeEventListener('abort', entry[1]); });
        listeners.length = 0;
      }
      for (var i = 0; i < signals.length; i++) {
        if (signals[i].aborted) { finish(signals[i]); return controller.signal; }
      }
      signals.forEach(function (signal) {
        var handler = function () { finish(signal); };
        listeners.push([signal, handler]);
        signal.addEventListener('abort', handler, { once: true });
      });
      return controller.signal;
    };
    if (!Signal.timeout) Signal.timeout = function (milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new TypeError('Invalid timeout');
      var controller = new Controller();
      var remaining = milliseconds;
      // Browsers clamp/overflow setTimeout delays above the signed 32-bit
      // boundary. Schedule long AbortSignal timeouts in bounded segments.
      function schedule() {
        var delay = Math.min(remaining, 2147483647);
        remaining -= delay;
        setTimeout(function () {
          if (remaining > 0) schedule();
          else controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
        }, delay);
      }
      schedule();
      return controller.signal;
    };
  }
  [g.Element, g.Document, g.DocumentFragment].forEach(function (Constructor) {
    if (!Constructor || Constructor.prototype.replaceChildren) return;
    Object.defineProperty(Constructor.prototype, 'replaceChildren', { configurable: true, writable: true,
      value: function () {
        var document = this.nodeType === 9 ? this : this.ownerDocument;
        for (var i = 0; i < arguments.length; i++) {
          var node = arguments[i];
          if (node === this || (node && typeof node.contains === 'function' && node.contains(this))) {
            throw new DOMException('Replacement contains its parent', 'HierarchyRequestError');
          }
        }
        var fragment = document.createDocumentFragment();
        fragment.append.apply(fragment, arguments);
        // Validate a Document's single-root/text/doctype constraints before
        // removing its existing children, as the native method does.
        if (this.nodeType === 9) this.cloneNode(false).appendChild(fragment.cloneNode(true));
        while (this.firstChild) this.removeChild(this.firstChild);
        this.appendChild(fragment);
      }
    });
  });
  if (g.Response && !g.Response.prototype.bytes) g.Response.prototype.bytes = function () {
    return this.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
  };
  if (g.Blob && !g.Blob.prototype.bytes) g.Blob.prototype.bytes = function () {
    return this.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
  };
  if (g.ReadableStream && g.Symbol && Symbol.asyncIterator) {
    var streamPrototype = ReadableStream.prototype;
    var nativeGetReader = streamPrototype.getReader;
    if (!streamPrototype.values) Object.defineProperty(streamPrototype, 'values', {
      configurable: true, writable: true, value: function (options) {
        if (options != null && typeof options !== 'object' && typeof options !== 'function') {
          throw new TypeError('ReadableStream.values requires an options dictionary');
        }
        var preventCancel = !!(options && options.preventCancel);
        // Acquire eagerly, just as native values() does, and serialize next/
        // return calls so cancellation cannot release a reader with a pending read.
        var reader = nativeGetReader.call(this);
        var finished = false;
        var ongoing = Promise.resolve();
        function enqueue(operation) {
          var result = ongoing.then(operation);
          ongoing = result.catch(function () {});
          return result;
        }
        function release() { finished = true; reader.releaseLock(); }
        var iterator = {
          next: function () {
            return enqueue(function () {
              if (finished) return { value: undefined, done: true };
              return reader.read().then(function (result) {
                if (result.done) release();
                return result;
              }, function (error) { release(); throw error; });
            });
          },
          return: function (value) {
            return enqueue(async function () {
              if (finished) return { value: value, done: true };
              finished = true;
              try {
                if (!preventCancel) await reader.cancel(value);
                return { value: value, done: true };
              } finally { reader.releaseLock(); }
            });
          }
        };
        Object.defineProperty(iterator, Symbol.asyncIterator, { value: function () { return this; } });
        return iterator;
      }
    });
    if (!streamPrototype[Symbol.asyncIterator]) Object.defineProperty(streamPrototype, Symbol.asyncIterator, {
      configurable: true, writable: true, value: streamPrototype.values
    });
  }
  if (g.ResizeObserverEntry && !('borderBoxSize' in g.ResizeObserverEntry.prototype)) {
    Object.defineProperty(g.ResizeObserverEntry.prototype, 'borderBoxSize', { configurable: true, get: function () {
      var target = this.target;
      return [{ inlineSize: target && typeof target.offsetWidth === 'number' ? target.offsetWidth : this.contentRect.width,
                blockSize: target && typeof target.offsetHeight === 'number' ? target.offsetHeight : this.contentRect.height }];
    }});
  }
  if (g.EventTarget && Signal) {
    // Chrome 83 accepts options objects but silently ignores options.signal.
    // Enable abort-driven removal only when that option is not implemented.
    var nativeAdd = EventTarget.prototype.addEventListener;
    var nativeRemove = EventTarget.prototype.removeEventListener;
    var probe = new Controller();
    var probeTarget = new EventTarget();
    var called = false;
    nativeAdd.call(probeTarget, 'dsh-abort-probe', function () { called = true; }, { signal: probe.signal });
    probe.abort();
    probeTarget.dispatchEvent(new Event('dsh-abort-probe'));
    if (called) {
      var registrations = new WeakMap();
      var abortedGetter = Object.getOwnPropertyDescriptor(Signal.prototype, 'aborted').get;
      function eventType(type) {
        if (typeof type === 'symbol') throw new TypeError('Event type cannot be a Symbol');
        return String(type);
      }
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        type = eventType(type);
        var objectOptions = options !== null && (typeof options === 'object' || typeof options === 'function');
        var capture = objectOptions ? !!options.capture : !!options;
        var once = objectOptions && !!options.once;
        var passive = objectOptions ? options.passive : undefined;
        var signal = objectOptions ? options.signal : undefined;
        // Use the native brand check so real signals from another Window are
        // accepted, while objects that merely imitate a signal are rejected.
        if (signal !== undefined && signal !== null) abortedGetter.call(signal);
        if (listener === null || listener === undefined) return;
        if (typeof listener !== 'function' && typeof listener !== 'object') throw new TypeError('Invalid event listener');
        if (signal && signal.aborted) return;
        var entries = registrations.get(this);
        if (!entries) registrations.set(this, entries = []);
        // All registrations are tracked, including listeners without a signal.
        // A duplicate cannot acquire a new signal or change its once option.
        if (entries.some(function (entry) {
          return entry.type === type && entry.listener === listener && entry.capture === capture;
        })) return;
        var target = this;
        var entry = { type: type, listener: listener, capture: capture, remove: null };
        var remove = function () {
          nativeRemove.call(target, type, wrapped, capture);
          if (signal) nativeRemove.call(signal, 'abort', remove);
          var at = entries.indexOf(entry);
          if (at !== -1) entries.splice(at, 1);
        };
        var wrapped = function (event) {
          // Native once removal happens before invoking the callback. Drop our
          // record at the same point, allowing re-registration in the callback.
          if (once) remove();
          if (typeof listener === 'function') return listener.call(this, event);
          return listener.handleEvent.call(listener, event);
        };
        entry.remove = remove;
        var nativeOptions = { capture: capture, once: once };
        if (passive !== undefined) nativeOptions.passive = !!passive;
        nativeAdd.call(target, type, wrapped, nativeOptions);
        entries.push(entry);
        if (signal) {
          if (signal.aborted) remove();
          else nativeAdd.call(signal, 'abort', remove, { once: true });
        }
      };
      EventTarget.prototype.removeEventListener = function (type, listener, options) {
        type = eventType(type);
        var objectOptions = options !== null && (typeof options === 'object' || typeof options === 'function');
        var capture = objectOptions ? !!options.capture : !!options;
        var entries = registrations.get(this);
        if (entries) entries.slice().forEach(function (entry) {
          if (entry.type === type && entry.listener === listener && entry.capture === capture) entry.remove();
        });
        return nativeRemove.call(this, type, listener, options);
      };
    }
  }
  g.__DSH_ANDROID_VISIBLE_QUERY__ = function (root, selector, first) {
    if (!root) return first ? null : [];
    var rows = Array.from(root.querySelectorAll(selector.split(':not([hidden] *)').join('')))
      .filter(function (node) { return !node.closest('[hidden]'); });
    Object.defineProperty(rows, 'item', { value: function (index) {
      if (!arguments.length) throw new TypeError('NodeList.item requires an index');
      return rows[Number(index) >>> 0] || null;
    } });
    return first ? rows[0] || null : rows;
  };
  // Chrome 83 has ReadableStream but cannot transfer one to a Worker or send
  // it as fetch's request body. Keep the existing Worker/XHR Blob path; only
  // the incompatible stream path buffers into a Blob, retaining cancellation.
  var streamUploadNative = false;
  if (g.document && g.ReadableStream && g.MessageChannel && g.Request) {
    try {
      var duplexRead = false;
      var stream = new ReadableStream({ start: function (controller) { controller.close(); } });
      new Request('https://dsh.invalid', { method: 'POST', body: stream,
        get duplex() { duplexRead = true; return 'half'; }
      });
      var channel = new MessageChannel();
      var transferable = new ReadableStream({ start: function (controller) { controller.close(); } });
      channel.port1.postMessage(transferable, [transferable]);
      channel.port1.close(); channel.port2.close();
      streamUploadNative = duplexRead;
    } catch (_) {}
  }
  g.__DSH_ANDROID_STREAM_UPLOAD_NATIVE__ = streamUploadNative;
  g.__DSH_ANDROID_BUFFER_UPLOAD__ = async function (request) {
    var signal = request.signal;
    if (signal) signal.throwIfAborted();
    var reader = request.body.getReader();
    var parts = [];
    var cancel = function () { reader.cancel(signal.reason).catch(function () {}); };
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        var item = await reader.read();
        if (signal) signal.throwIfAborted();
        if (item.done) break;
        if (!(item.value instanceof Uint8Array)) throw new TypeError('Upload stream requires Uint8Array chunks');
        parts.push(item.value);
      }
      return new Blob(parts, { type: 'application/octet-stream' });
    } finally {
      if (signal) signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  };
  // No global WeakRef/GC emulation. These bounded owner references are used
  // only at the audited terminal window-chain and PDF active-image call sites.
  g.__DSH_ANDROID_OWNER_REFERENCE__ = function (value) {
    if (typeof WeakRef === 'function') return new WeakRef(value);
    return { deref: function () { return value; } };
  };
  g.__DSH_ANDROID_WEBVIEW_COMPAT__ = {
    target: 'chrome83',
    weakReferences: typeof WeakRef === 'function' ? 'native' : 'bounded owner references; diagnostic fiber metadata omitted'
  };
})();
`;

const ANIMATION_FINISHED_ADDITIONS = `
/* Only the missing Animation.finished Promise API; native rendering is retained. */
(function () {
  var g = globalThis;
  if (!g.Animation || !g.Promise || !g.WeakMap || 'finished' in Animation.prototype) return;
  var prototype = Animation.prototype;
  var records = new WeakMap();
  var nativeAdd = prototype.addEventListener;
  function deferred() {
    var promise = { status: 'pending', value: null, resolve: null, reject: null };
    promise.value = new Promise(function (resolve, reject) { promise.resolve = resolve; promise.reject = reject; });
    return promise;
  }
  function fulfill(record) {
    if (record.finished.status !== 'pending') return;
    record.finished.status = 'fulfilled'; record.finished.resolve(record.animation);
  }
  function cancel(record) {
    if (record.finished.status === 'pending') {
      record.finished.status = 'rejected';
      // Cancellation marks the current promise handled internally, as the
      // Web Animations algorithm specifies; consumers still catch AbortError.
      record.finished.value.catch(function () {});
      record.finished.reject(new DOMException('The animation was canceled', 'AbortError'));
    }
    record.finished = deferred();
  }
  function queueFinish(record) {
    if (record.notificationQueued) return;
    record.notificationQueued = true;
    Promise.resolve().then(function () {
      record.notificationQueued = false;
      // A same-task seek to the end and then back must not fulfill the promise.
      if (record.animation.playState === 'finished' && !record.animation.pending) fulfill(record);
    });
  }
  function update(record, synchronous, explicitCancel) {
    var state = record.animation.playState;
    if ((explicitCancel || state === 'idle') && record.lastState !== 'idle') cancel(record);
    if (state !== 'finished' && record.finished.status === 'fulfilled') record.finished = deferred();
    if (state === 'finished' && !record.animation.pending && record.finished.status === 'pending') {
      if (synchronous) fulfill(record);
      else queueFinish(record);
    }
    record.lastState = state;
  }
  function recordFor(animation) {
    var record = records.get(animation);
    if (record) return record;
    // The native getter validates the Animation receiver without replacing it.
    record = { animation: animation, finished: deferred(), lastState: animation.playState,
      notificationQueued: false };
    records.set(animation, record);
    // Existing onfinish/oncancel callbacks remain intact. Queued events inspect
    // current native state, so an old cancel/finish cannot invalidate a replay.
    nativeAdd.call(animation, 'finish', function () { update(record, true); });
    nativeAdd.call(animation, 'cancel', function () { update(record, false); });
    return record;
  }
  Object.defineProperty(prototype, 'finished', {
    configurable: true, enumerable: true, get: function () {
      var record = recordFor(this); update(record, false); return record.finished.value;
    }
  });
  ['play', 'pause', 'reverse', 'finish', 'cancel', 'updatePlaybackRate'].forEach(function (name) {
    var descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    var native = descriptor.value;
    descriptor.value = function () {
      var record = records.get(this);
      // finish() must fulfill before its caller queues another microtask,
      // even if no consumer has read the finished getter yet.
      if (!record && name === 'finish') record = recordFor(this);
      if (record) update(record, false);
      var result = native.apply(this, arguments);
      if (record) update(record, name === 'finish', name === 'cancel');
      return result;
    };
    Object.defineProperty(prototype, name, descriptor);
  });
  ['currentTime', 'startTime', 'playbackRate', 'effect'].forEach(function (name) {
    var descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || !descriptor.set) return;
    var native = descriptor.set;
    descriptor.set = function (value) {
      var record = records.get(this);
      if (record) update(record, false);
      native.call(this, value);
      if (record) update(record, false);
    };
    Object.defineProperty(prototype, name, descriptor);
  });
})();
`;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export function patchCoreResourceUrlDetection(source) {
  // core-js 3.50's native detector checks HTTP URLs but misses WebView 83's
  // opaque-path parsing of custom schemes. Extend the real detector so its
  // existing USE_NATIVE_URL gate selects the complete WHATWG URL and matching
  // URLSearchParams implementations together, including Request/fetch support.
  // Its URL implementation already binds native Blob URL static methods.
  const before = `module.exports = !fails(function () {
  // eslint-disable-next-line unicorn/relative-url-style -- required for testing
  var url = new URL('b?a=1&b=2&c=3', 'https://a');`;
  if (source.split(before).length !== 2) {
    throw new Error("WebView compatibility: unknown core-js 3.50 native URL detector");
  }
  const after = `module.exports = !fails(function () {
  ${RESOURCE_URL_MARKER}
  var resource = new URL('dsh-resource://file/session/url-probe/a%2Fb.md?q=one+two&tag=1&tag=2#anchor');
  var subagent = new URL('dsh-resource://subagentchat/session/child%2Fid?parent=parent%2Bid&mode=one-shot');
  var relative = new URL('next.md?q=ok', 'dsh-resource://file/session/url-probe/base.md');
  if (resource.protocol !== 'dsh-resource:' || resource.hostname !== 'file' ||
      resource.pathname !== '/session/url-probe/a%2Fb.md' || resource.hash !== '#anchor' ||
      resource.searchParams.get('q') !== 'one two' || resource.searchParams.getAll('tag').join(',') !== '1,2' ||
      subagent.protocol !== 'dsh-resource:' || subagent.hostname !== 'subagentchat' ||
      subagent.pathname !== '/session/child%2Fid' || subagent.searchParams.get('parent') !== 'parent+id' ||
      subagent.searchParams.get('mode') !== 'one-shot' ||
      relative.hostname !== 'file' || relative.pathname !== '/session/url-probe/next.md' ||
      relative.searchParams.get('q') !== 'ok') return true;
  // eslint-disable-next-line unicorn/relative-url-style -- required for testing
  var url = new URL('b?a=1&b=2&c=3', 'https://a');`;
  return source.replace(before, after);
}

export function patchPdfTextRenderer(source, esbuild) {
  const before = `function pdfTextRenderer(host) {
    return (page, viewport) => {
      const layer = new TextLayerBuilder({ pdfPage: page });
      const container = layer.div;
      container.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit));
      container.style.setProperty("--scale-round-x", "1px");
      container.style.setProperty("--scale-round-y", "1px");
      host.append(container);
      const resize = () => {
        container.style.scale = String(host.getBoundingClientRect().width / viewport.width);
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();
      return {
        promise: layer.render({ viewport }),
        cancel() {
          observer.disconnect();
          layer.cancel();
          container.remove();
        }
      };
    };
  }`;
  const after = `function pdfTextRenderer(host) {
    return (page, viewport) => {
      const layer = new TextLayerBuilder({ pdfPage: page });
      const container = layer.div;
      container.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit));
      container.style.setProperty("--scale-round-x", "1px");
      container.style.setProperty("--scale-round-y", "1px");
      const dshAndroidPdfTextScale = typeof CSS !== "undefined" && CSS.supports("scale", "1");
      const dshAndroidPdfTextDimensions = typeof CSS !== "undefined" && CSS.supports("width", "round(down, 1px, 1px)");
      host.append(container);
      const resize = () => {
        const ratio = host.getBoundingClientRect().width / viewport.width;
        if (dshAndroidPdfTextScale) container.style.scale = String(ratio);
        else {
          const rotation = (viewport.rotation % 360 + 360) % 360;
          const rotated = rotation === 90 ? " rotate(90deg) translateY(-100%)" :
            rotation === 180 ? " rotate(180deg) translate(-100%, -100%)" :
            rotation === 270 ? " rotate(270deg) translate(-100%)" : "";
          container.style.transformOrigin = "0 0";
          container.style.transform = "scale(" + ratio + ")" + rotated;
        }
        if (!dshAndroidPdfTextDimensions) {
          const totalScale = viewport.scale * viewport.userUnit;
          container.style.width = Math.floor(viewport.rawDims.pageWidth * totalScale) + "px";
          container.style.height = Math.floor(viewport.rawDims.pageHeight * totalScale) + "px";
        }
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();
      const promise = layer.render({ viewport });
      // TextLayer construction writes its round() dimensions synchronously.
      // Restore only unsupported layout properties after that real render call.
      if (!dshAndroidPdfTextScale || !dshAndroidPdfTextDimensions) resize();
      return {
        promise,
        cancel() {
          observer.disconnect();
          layer.cancel();
          container.remove();
        }
      };
    };
  }`;
  const normalize = value => value.replace(/\s+/g, "");
  const matches = [...source.matchAll(/function pdfTextRenderer\(host\) \{[\s\S]*?\n[\t ]*\};\n[\t ]*\};\n[\t ]*\}/g)];
  if (matches.length !== 1) throw new Error("WebView compatibility: unknown PDF text renderer boundary");
  const renderer = matches[0][0];
  // Support official source and this helper's already lowered source. A fresh
  // build and a repeated local build must receive exactly the same renderer.
  const normalized = normalize(renderer);
  const lowered = esbuild.transformSync(after, { target: TARGET, legalComments: "inline", minify: false }).code;
  if (normalized === normalize(after) || normalized === normalize(lowered)) return source;
  if (normalized !== normalize(before)) throw new Error("WebView compatibility: unknown PDF text renderer layout");
  return source.slice(0, matches[0].index) + after + source.slice(matches[0].index + renderer.length);
}

export function patchExcelWorkerBootstrap(source, esbuild) {
  const before = `function parseExcel(bytes, format, limits, signal) {
    signal.throwIfAborted();
    if (bytes.byteLength > limits.maxBytes) return Promise.reject(/* @__PURE__ */ new Error("tooLarge"));
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([_dsh_excel_worker_source_default], { type: "text/javascript" }));
      let worker;
      try {
        worker = new Worker(url, { name: "dsh-excel" });
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(new Error("invalid", { cause: error }));
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        URL.revokeObjectURL(url);
      };
      const abort = () => {
        finish();
        reject(new DOMException("Excel preview closed", "AbortError"));
      };
      const fail = () => {
        finish();
        reject(/* @__PURE__ */ new Error("invalid"));
      };
      const timer = setTimeout(() => {
        finish();
        reject(/* @__PURE__ */ new Error("timeout"));
      }, limits.timeoutMs);
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.onmessage = (event) => {
        const message = event.data;
        if (typeof message !== "object" || message === null || !("ok" in message)) {
          fail();
          return;
        }
        if (message.ok === true && "value" in message && validPreview(message.value)) {
          finish();
          resolve(message.value);
        } else if (message.ok === false && "code" in message && [
          "invalid", "tooLarge", "timeout", "encoding"
        ].includes(String(message.code))) {
          finish();
          reject(new Error(String(message.code)));
        } else fail();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const copy = bytes.slice();
        worker.postMessage({ bytes: copy, format, limits }, [copy.buffer]);
      } catch (error) {
        finish();
        reject(new Error("invalid", { cause: error }));
      }
    });
  }`;
  const after = `function parseExcel(bytes, format, limits, signal) {
    signal.throwIfAborted();
    if (bytes.byteLength > limits.maxBytes) return Promise.reject(/* @__PURE__ */ new Error("tooLarge"));
    return new Promise((resolve, reject) => {
      // The business bundle remains unchanged. Only acknowledge readiness
      // after its real message handler has been installed. A new line and
      // semicolon also separate this fragment from any final source-map comment.
      const dshAndroidExcelWorkerBootstrap = "\\n;/* dsh-android-excel-worker-ready-v1 */\\nif (typeof globalThis.onmessage !== 'function') throw new Error('Excel Worker handler unavailable');\\nglobalThis.postMessage({type:'dsh-excel-worker-ready',version:1});\\n";
      let url, worker, initTimer, parseTimer;
      let settled = false;
      let phase = "initializing";
      let timingMark;
      const startTiming = () => {
        try {
          if (typeof performance === "undefined" || !["now", "mark", "measure", "clearMarks", "clearMeasures"]
              .every(name => typeof performance[name] === "function")) return;
          timingMark = "dsh-excel-worker-" + phase + "-" + performance.now() + "-" + Math.random();
          performance.mark(timingMark);
        } catch (_) { timingMark = undefined; }
      };
      const finishTiming = () => {
        if (timingMark === undefined) return;
        const start = timingMark, end = start + "-end";
        timingMark = undefined;
        try {
          performance.mark(end);
          // Keep only the latest numeric measurement for each of our phases;
          // never clear another module's Performance entries.
          const name = "dsh-excel-worker-" + phase;
          performance.clearMeasures(name);
          performance.measure(name, start, end);
        } catch (_) {
          // Diagnostics cannot affect worker behavior on partial Performance APIs.
        } finally {
          try { performance.clearMarks(start); performance.clearMarks(end); } catch (_) {}
        }
      };
      const finish = () => {
        if (settled) return false;
        settled = true;
        finishTiming();
        clearTimeout(initTimer);
        clearTimeout(parseTimer);
        signal.removeEventListener("abort", abort);
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.terminate();
        }
        if (url !== undefined) URL.revokeObjectURL(url);
        return true;
      };
      const fail = (code = "invalid", cause) => {
        const error = new Error(code, { cause });
        error.phase = phase;
        if (finish()) reject(error);
      };
      const abort = () => {
        if (finish()) reject(new DOMException("Excel preview closed", "AbortError"));
      };
      // Bootstrap has its own bounded budget. The original parse budget only
      // begins once the worker is ready to receive the real transferred bytes.
      startTiming();
      initTimer = setTimeout(() => fail("timeout", new Error("Excel Worker initialization timed out")), 60000);
      try {
        url = URL.createObjectURL(new Blob([_dsh_excel_worker_source_default, dshAndroidExcelWorkerBootstrap], { type: "text/javascript" }));
        worker = new Worker(url, { name: "dsh-excel" });
      } catch (error) {
        fail("invalid", error);
        return;
      }
      worker.onerror = (event) => fail("invalid", new Error("Excel Worker " + phase + " failed", { cause: event.error }));
      worker.onmessageerror = () => fail("invalid", new Error("Excel Worker " + phase + " message could not be decoded"));
      worker.onmessage = (event) => {
        if (settled) return;
        const message = event.data;
        if (typeof message !== "object" || message === null || Object.keys(message).length !== 2) {
          fail();
          return;
        }
        if (phase === "initializing") {
          if (message.type !== "dsh-excel-worker-ready" || message.version !== 1) {
            fail();
            return;
          }
          clearTimeout(initTimer);
          initTimer = undefined;
          finishTiming();
          phase = "parsing";
          startTiming();
          parseTimer = setTimeout(() => fail("timeout", new Error("Excel Worker parsing timed out")), limits.timeoutMs);
          try {
            const copy = bytes.slice();
            worker.postMessage({ bytes: copy, format, limits }, [copy.buffer]);
          } catch (error) { fail("invalid", error); }
          return;
        }
        if (message.ok === true && "value" in message && validPreview(message.value)) {
          if (finish()) resolve(message.value);
        } else if (message.ok === false && "code" in message && [
          "invalid", "tooLarge", "timeout", "encoding"
        ].includes(String(message.code))) {
          fail(String(message.code));
        } else fail();
      };
      signal.addEventListener("abort", abort, { once: true });
      // Abort may occur while the native constructor is returning, before
      // registration above. Do not leave that operation waiting for ready.
      if (signal.aborted) abort();
    });
  }`;
  const matches = [...source.matchAll(/function parseExcel\(bytes, format, limits, signal\) \{[\s\S]*?(?=\n[\t ]*function validPreview\()/g)];
  if (matches.length !== 1 || [...source.matchAll(/\bfunction parseExcel\(/g)].length !== 1) {
    throw new Error("WebView compatibility: unknown Excel parser boundary");
  }
  // The outer official/lowered bundle gives these two locals different names.
  // Ignore only those audited aliases and whitespace, not upstream behavior.
  const normalize = value => esbuild.transformSync(value, { target: TARGET, legalComments: "inline", minifyWhitespace: true }).code
    .replace(/\berror2\b/g, "error").replace(/\bcopy2\b/g, "copy");
  const parser = matches[0][0];
  const normalized = normalize(parser);
  if (normalized === normalize(after)) return source;
  if (normalized !== normalize(before)) throw new Error("WebView compatibility: unknown Excel worker lifecycle");
  return source.slice(0, matches[0].index) + after + source.slice(matches[0].index + parser.length);
}

export function patchExcelDefaultRowHeight(source, esbuild) {
  const declaration = `function dshAndroidExcelWorksheetRows(sheets, format) {
    if (format !== "xlsx") return sheets;
    let changed = false;
    const normalized = sheets.map((sheet) => {
      const height = sheet.defaultRowHeight;
      if (height !== undefined && !(typeof height === "number" && !Number.isFinite(height))) return sheet;
      changed = true;
      // ExcelJS normally initializes worksheets to 15 points. Loading an XLSX
      // without the optional sheetFormatPr replaces those properties with {},
      // so upstream conversion emits NaN instead of a usable pixel height.
      // Keep finite heights (including explicit zero), custom rows and hiding.
      return { ...sheet, defaultRowHeight: 15 * 96 / 72 };
    });
    return changed ? normalized : sheets;
  }`;
  const memo = `const dshAndroidExcelSheets = (0, react.useMemo)(() =>
    state && "value" in state ? dshAndroidExcelWorksheetRows(state.value.sheets, format) : undefined,
    [state, format]);`;
  const ref = "const workbookRef = (0, react.useRef)(null);";
  const originalData = "data: state.value.sheets,";
  const normalizedData = "data: dshAndroidExcelSheets,";
  const normalize = value => esbuild.transformSync(value, { target: TARGET, legalComments: "inline" }).code;
  const body = [...source.matchAll(/\bfunction ExcelBody\(/g)];
  if (body.length !== 1 || source.split(ref).length !== 2) {
    throw new Error("WebView compatibility: unknown Excel default row-height boundary");
  }
  if (source.includes("dshAndroidExcelWorksheetRows") || source.includes("dshAndroidExcelSheets")) {
    if ([...source.matchAll(/\bfunction dshAndroidExcelWorksheetRows\(/g)].length !== 1) {
      throw new Error("WebView compatibility: duplicate Excel default row-height fallback");
    }
    const declarations = [...source.matchAll(/function dshAndroidExcelWorksheetRows\(sheets, format\) \{[\s\S]*?\}(?=\s*function ExcelBody\()/g)];
    const memos = [...source.matchAll(/const dshAndroidExcelSheets\s*=[\s\S]*?;/g)];
    if (declarations.length !== 1 || memos.length !== 1 ||
        normalize(declarations[0][0]) !== normalize(declaration) || normalize(memos[0][0]) !== normalize(memo) ||
        source.includes(originalData) || source.split(normalizedData).length !== 2) {
      throw new Error("WebView compatibility: unknown existing Excel default row-height fallback");
    }
    return source;
  }
  if (source.split(originalData).length !== 2 || source.includes(normalizedData)) {
    throw new Error("WebView compatibility: unknown Excel workbook data property");
  }
  source = source.slice(0, body[0].index) + declaration + "\n" + source.slice(body[0].index);
  return source.replace(ref, ref + "\n" + memo).replace(originalData, normalizedData);
}

export function prefixExcelStylesheet(css) {
  // This pinned Fortune stylesheet contains only qualified rules. Do not
  // silently reinterpret future nested CSS, @rules or changed selector syntax.
  if (Buffer.byteLength(css) !== 49984 ||
      createHash("sha256").update(css).digest("hex") !== "121488ced1e2e3b62b986ec0b56105f870dc8eb162650a0375bc208281adb6a7") {
    throw new Error("WebView compatibility: unknown Fortune scoped stylesheet");
  }
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  if (rules.length !== 449 || rules.map(rule => rule[0]).join("") !== css || css.includes("@")) {
    throw new Error("WebView compatibility: unsupported Fortune scoped rule");
  }
  return rules.map(([, selector, declarations]) => {
    const selectors = [];
    let start = 0, parentheses = 0, brackets = 0, quote = "";
    for (let at = 0; at < selector.length; at++) {
      const token = selector[at];
      if (token === "\\") { at++; continue; }
      if (quote) { if (token === quote) quote = ""; continue; }
      if (token === '"' || token === "'") { quote = token; continue; }
      if (token === "(") parentheses++;
      else if (token === ")") parentheses--;
      else if (token === "[") brackets++;
      else if (token === "]") brackets--;
      else if (token === "," && parentheses === 0 && brackets === 0) {
        selectors.push(selector.slice(start, at).trim()); start = at + 1;
      }
      if (parentheses < 0 || brackets < 0) throw new Error("WebView compatibility: unbalanced Fortune selector");
    }
    selectors.push(selector.slice(start).trim());
    if (quote || parentheses || brackets || selectors.some(value => !value)) {
      throw new Error("WebView compatibility: unknown Fortune selector boundary");
    }
    return selectors.map(value => "[data-excel-preview] " + value).join(",") + "{" + declarations + "}";
  }).join("");
}

export function patchExcelScopedStyles(source, esbuild) {
  if ([...source.matchAll(/\b(?:var|const) index_css_default\s*=/g)].length !== 1) {
    throw new Error("WebView compatibility: unknown Fortune stylesheet definition");
  }
  const stylesheet = quotedWorker(source, "index_css_default").value;
  const prefixed = prefixExcelStylesheet(stylesheet);
  const before = 'const scopedStyles = `@scope ([data-excel-preview]) { ${index_css_default} }`;';
  const after = `const dshAndroidExcelScopedStyles = ${JSON.stringify(prefixed)};
    const dshAndroidExcelNativeScope = (() => {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("@scope ([data-excel-preview]) { .fortune-container { display: block; } }");
        return typeof CSSScopeRule === "function" && sheet.cssRules.length === 1 &&
          sheet.cssRules[0] instanceof CSSScopeRule && sheet.cssRules[0].cssRules.length === 1 &&
          sheet.cssRules[0].cssRules[0].style.display === "block";
      } catch (_) { return false; }
    })();
    const scopedStyles = dshAndroidExcelNativeScope ? \`@scope ([data-excel-preview]) { \${index_css_default} }\` : dshAndroidExcelScopedStyles;`;
  const normalize = value => value.replace(/\s+/g, "");
  if (source.includes("dshAndroidExcelScopedStyles")) {
    const patched = [...source.matchAll(/const dshAndroidExcelScopedStyles\s*=[\s\S]*?\n[\t ]*const scopedStyles\s*=[\s\S]*?;/g)];
    if (patched.length !== 1 ||
        esbuild.transformSync(patched[0][0], { target: TARGET }).code !== esbuild.transformSync(after, { target: TARGET }).code) {
      throw new Error("WebView compatibility: unknown existing Fortune scope fallback");
    }
    return source;
  }
  const matches = [...source.matchAll(/const scopedStyles\s*=[\s\S]*?;/g)];
  if (matches.length !== 1 || normalize(matches[0][0]) !== normalize(before)) {
    throw new Error("WebView compatibility: unknown Fortune scope wrapper");
  }
  return source.slice(0, matches[0].index) + after + source.slice(matches[0].index + matches[0][0].length);
}

function patchWeakReferences(source, label) {
  if (!source.includes("new WeakRef(")) return source;
  if (/dsh-web-frontend\/dist\/assets\/index-[^/]+\.js$/.test(label)) {
    const matcher = /meta:\{fiber:new WeakRef\(([A-Za-z_$][\w$]*)\)\}/g;
    const matches = [...source.matchAll(matcher)];
    if (matches.length !== 1) throw new Error(`WebView compatibility: unexpected logger WeakRef in ${label}`);
    source = source.replace(matcher, (_, fiber) =>
      `meta:typeof WeakRef==='function'?{fiber:new WeakRef(${fiber})}:{}`);
  } else if (/dsh-client-ui-sidebar-terminal\/lib\/client\.terminal\.js$/.test(label)) {
    const matches = [...source.matchAll(/new WeakRef\(([A-Za-z_$][\w$]*)\)/g)];
    if (matches.length !== 2) throw new Error(`WebView compatibility: unexpected terminal WeakRef in ${label}`);
    source = source.replace(/new WeakRef\(([A-Za-z_$][\w$]*)\)/g,
      (_, value) => `globalThis.__DSH_ANDROID_OWNER_REFERENCE__(${value})`);
  } else if (/dsh-client-ui-sidebar-documentpreview\/lib\/client\.pdf\.js$/.test(label)) {
    if (source.split("new WeakRef(imgElement)").length !== 2) {
      throw new Error(`WebView compatibility: unexpected PDF WeakRef in ${label}`);
    }
    source = source.replace("new WeakRef(imgElement)",
      "globalThis.__DSH_ANDROID_OWNER_REFERENCE__(imgElement)");
  } else {
    throw new Error(`WebView compatibility: unaudited WeakRef use in ${label}`);
  }
  return source;
}

function embeddedCss(source, esbuild) {
  return source.replace(/\b(const|var|let)\s+(css(?:\$\d+)?)\s*=\s*("(?:\\.|[^"\\])*")\s*;/g,
    (statement, declaration, name, literal) => {
      const css = JSON.parse(literal);
      const lowered = esbuild.transformSync(css, { loader: "css", target: TARGET, minify: true }).code.trim();
      return `${declaration} ${name} = ${JSON.stringify(lowered)};`;
    });
}

function quotedWorker(source, name = "_dsh_pdf_worker_default") {
  const declaration = new RegExp(`(?:var|const) ${name}\\s*=\\s*`).exec(source);
  if (!declaration) throw new Error(`WebView compatibility: missing ${name} literal`);
  const start = declaration.index + declaration[0].length;
  const quote = source[start];
  if (quote !== '"' && quote !== "'") throw new Error(`WebView compatibility: unknown ${name} literal`);
  let end = start + 1;
  while (end < source.length) {
    if (source[end] === "\\") { end += 2; continue; }
    if (source[end++] === quote) break;
  }
  // Evaluate only the scanned quoted data literal, never the module or Worker.
  const value = runInNewContext(source.slice(start, end), {}, { timeout: 1000 });
  if (typeof value !== "string") throw new Error(`WebView compatibility: ${name} is not a string`);
  return { start, end, value };
}

function patchBrowserCases(source, label, esbuild, workerPolyfills) {
  if (/dsh-client-ui-sidebar-right\/lib\/client\.js$/.test(label) &&
      !source.includes('"data-dsh-sidebar-instant"')) {
    const before = 'const entering = shown && fullscreen ? panelRef.current.getAnimations({ subtree: true })';
    if (source.split(before).length !== 2) {
      throw new Error("WebView compatibility: unknown fullscreen sidebar transition reporter");
    }
    // Stock WebView 83 renders CSS transitions but cannot enumerate them.
    // Do not pretend to implement getAnimations: explicitly cancel transitions
    // for this panel/subtree before reporting instantaneous coverage. Updated
    // WebViews keep their native enumeration and finished-promise wait.
    const after = `const sidebarAnimationsAvailable = panelRef.current !== null &&
            typeof panelRef.current.getAnimations === "function";
          if (panelRef.current !== null) {
            if (sidebarAnimationsAvailable) panelRef.current.removeAttribute("data-dsh-sidebar-instant");
            else panelRef.current.setAttribute("data-dsh-sidebar-instant", "");
          }
          const entering = shown && fullscreen && sidebarAnimationsAvailable ? panelRef.current.getAnimations({ subtree: true })`;
    source = source.replace(before, after);
  }
  if (/dsh-client-ui-chat\/lib\/client\.js$/.test(label) &&
      !source.includes("globalThis.__DSH_ANDROID_VISIBLE_QUERY__")) {
    let count = 0;
    source = source.replace(/([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*)\.querySelector(All)?\(("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\)/g,
      (call, receiver, all, literal) => {
        if (!literal.includes(":not([hidden] *)")) return call;
        count++;
        return `globalThis.__DSH_ANDROID_VISIBLE_QUERY__(${receiver}, ${literal}, ${all ? "false" : "true"})`;
      });
    if (count !== 5) throw new Error(`WebView compatibility: expected 5 chat visible queries, found ${count}`);
  }
  if (/dsh-client-file-upload\/lib\/client\.js$/.test(label) &&
      !source.includes("globalThis.__DSH_ANDROID_BUFFER_UPLOAD__")) {
    const matcher = /function workerTransport\(\) \{\s*return \{\s*post\(request\) \{/g;
    const matches = [...source.matchAll(matcher)];
    if (matches.length !== 1) throw new Error("WebView compatibility: unknown upload Worker transport");
    source = source.replace(matcher, original => `${original}
      if (request.body instanceof ReadableStream && !globalThis.__DSH_ANDROID_STREAM_UPLOAD_NATIVE__) {
        return globalThis.__DSH_ANDROID_BUFFER_UPLOAD__(request).then(body => this.post({ ...request, body }));
      }`);
  }
  if (/dsh-client-ui-sidebar-documentpreview\/lib\/client\.excel\.js$/.test(label)) {
    source = patchExcelWorkerBootstrap(source, esbuild);
    source = patchExcelDefaultRowHeight(source, esbuild);
    source = patchExcelScopedStyles(source, esbuild);
    const worker = quotedWorker(source, "_dsh_excel_worker_source_default");
    const workerMarker = "/* dsh-android-webview83-excel-worker-v1 */";
    const workerBodyMarker = "/* dsh-android-webview83-excel-worker-body */";
    let lowered;
    if (worker.value.startsWith(workerMarker)) {
      const at = worker.value.indexOf(workerBodyMarker);
      if (at === -1) throw new Error("WebView compatibility: missing Excel worker body boundary");
      lowered = worker.value.slice(at + workerBodyMarker.length).trimStart();
    } else {
      // A Blob-created Worker is embedded as data in the outer browser module;
      // transforming that module alone leaves its 303 modern assignments intact.
      lowered = esbuild.transformSync(worker.value, { target: TARGET,
        legalComments: "inline", minify: true }).code;
    }
    const value = `${workerMarker}\n${workerPolyfills}\n${workerBodyMarker}\n${lowered}`;
    if (worker.value !== value) {
      source = source.slice(0, worker.start) + JSON.stringify(value) + source.slice(worker.end);
    }
  }
  if (/dsh-client-ui-sidebar-documentpreview\/lib\/client\.pdf\.js$/.test(label)) {
    source = patchPdfTextRenderer(source, esbuild);
    if (source.includes("adoptedStyleSheets.push(styleSheet);")) {
      if (source.split("adoptedStyleSheets.push(styleSheet);").length !== 2) throw new Error("WebView compatibility: unknown PDF font stylesheet");
      source = source.replace("adoptedStyleSheets.push(styleSheet);",
        "this._document.adoptedStyleSheets = [...adoptedStyleSheets, styleSheet];");
    }
    const worker = quotedWorker(source);
    const workerMarker = "/* dsh-android-webview83-worker-v2 */";
    const workerBodyMarker = "/* dsh-android-webview83-worker-body */";
    let lowered;
    if (worker.value.startsWith(workerMarker)) {
      const at = worker.value.indexOf(workerBodyMarker);
      if (at === -1) throw new Error("WebView compatibility: missing PDF worker body boundary");
      lowered = worker.value.slice(at + workerBodyMarker.length).trimStart();
    } else if (worker.value.startsWith("/* dsh-android-webview83-worker-v1 */")) {
      // Upgrade this helper's first version without retranspiling server code
      // or retaining an older copy of its worker-local API additions.
      const boundary = /\n\n(?=var [A-Za-z_$][\w$]*=Object\.defineProperty;)/.exec(worker.value);
      if (!boundary) throw new Error("WebView compatibility: unknown legacy PDF worker boundary");
      lowered = worker.value.slice(boundary.index).trimStart();
    } else {
      const icc = "static get isUsable(){let e=!1;if(this.#T)";
      if (worker.value.split(icc).length !== 2) throw new Error("WebView compatibility: unknown PDF ICC capability guard");
      const guarded = worker.value.replace(icc,
        'static get isUsable(){if(typeof FinalizationRegistry!=="function")return shadow(this,"isUsable",false);let e=!1;if(this.#T)');
      // The upstream PDF parser already falls back to Alternate/Device color
      // spaces when ICC is unavailable. Avoid allocating the GC-managed WASM
      // transformer on engines without FinalizationRegistry; no fake GC shim.
      lowered = esbuild.transformSync(guarded, { target: TARGET, format: "esm", legalComments: "inline", minify: true }).code;
    }
    const value = `${workerMarker}\n${workerPolyfills}\n${workerBodyMarker}\n${lowered}`;
    if (worker.value !== value) {
      source = source.slice(0, worker.start) + JSON.stringify(value) + source.slice(worker.end);
    }
  }
  return source;
}

async function patchHtmlRenderer(root, esbuild) {
  const path = join(root, "node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js");
  let source = await readFile(path, "utf8");
  if (source.includes(HTML_MARKER)) return;
  const ready = /const READY_MARKUP = ("(?:\\.|[^"\\])*");/;
  const readyMatches = [...source.matchAll(new RegExp(ready.source, "g"))];
  if (readyMatches.length !== 1) throw new Error("WebView compatibility: unknown boot-readiness HTML renderer");
  const markup = JSON.parse(readyMatches[0][1]);
  const script = /^<script>([\s\S]*)<\/script>$/.exec(markup);
  if (!script) throw new Error("WebView compatibility: unknown boot-readiness script");
  const readyCode = esbuild.transformSync(script[1], { target: TARGET, minify: true }).code.trim();
  source = source.replace(ready, `const READY_MARKUP = ${JSON.stringify(`<script>${readyCode}</script>`)};`);
  const before = 'function renderIndexInjections(html, rows) {\n\tlet head = "";';
  if (source.split(before).length !== 2) throw new Error("WebView compatibility: unknown head injection renderer");
  // The server prepends injection rows before the original index head. Extract
  // our ordinary blocking script and prepend it to those rows, so polyfills run
  // before EVERY bootstrap/global/inline script, including Promise.withResolvers.
  const after = `function renderIndexInjections(html, rows) {
\t${HTML_MARKER}
\tconst compatibilityTag = ${JSON.stringify(POLYFILL_TAG)};
\tconst compatibilityAt = html.indexOf(compatibilityTag);
\tlet head = "";
\tif (compatibilityAt !== -1) {
\t\thead = compatibilityTag;
\t\thtml = html.slice(0, compatibilityAt) + html.slice(compatibilityAt + compatibilityTag.length);
\t}`;
  source = source.replace(before, after);
  await writeFile(path, source);
}

function verifyIntlSegmenter(polyfill) {
  const context = {};
  runInNewContext("delete Intl.Segmenter", context);
  runInNewContext(polyfill, context, { timeout: 10000 });
  const result = runInNewContext(`JSON.stringify({
    graphemes: Array.from(new Intl.Segmenter(undefined, {granularity: 'grapheme'})
      .segment('e\\u0301👨‍👩‍👧‍👦🇨🇳👍🏽\\r\\n'), function (part) { return [part.segment, part.index]; }),
    words: Array.from(new Intl.Segmenter('en', {granularity: 'word'})
      .segment('Hello, naïve world!'), function (part) { return [part.segment, part.index, part.isWordLike]; }),
    containing: new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment('e\\u0301x').containing(1).segment
  })`, context, { timeout: 10000 });
  const expected = JSON.stringify({
    graphemes: [["e\u0301", 0], ["👨‍👩‍👧‍👦", 2], ["🇨🇳", 13], ["👍🏽", 17], ["\r\n", 21]],
    words: [["Hello", 0, true], [",", 5, false], [" ", 6, false], ["naïve", 7, true],
      [" ", 12, false], ["world", 13, true], ["!", 18, false]],
    containing: "e\u0301",
  });
  if (result !== expected) throw new Error(`WebView compatibility: Unicode Segmenter validation failed: ${result}`);
  const nativeContext = {};
  runInNewContext("var segmenterSentinel = function () {}; Intl.Segmenter = segmenterSentinel", nativeContext);
  runInNewContext(polyfill, nativeContext, { timeout: 10000 });
  if (!runInNewContext("Intl.Segmenter === segmenterSentinel", nativeContext)) {
    throw new Error("WebView compatibility: Segmenter polyfill replaced an existing implementation");
  }
}

export async function patchAndroidWebView(root, toolsDirectory) {
  // The guarded reporter can skip waiting only when this real stylesheet
  // cancels the panel's CSS transitions. Fail closed on an outdated mobile
  // layer rather than silently reporting coverage during a moving transition.
  const frontend = join(root, "node_modules/@deepseek-ai/dsh-web-frontend/dist");
  const frontendIndex = await readFile(join(frontend, "index.html"), "utf8");
  const styleLinks = [...frontendIndex.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g)]
    .map(match => match[1]).filter(href => /(?:^|\/)index-[^/]+\.css$/.test(href));
  if (styleLinks.length !== 1) throw new Error("WebView compatibility: unknown sidebar fallback stylesheet");
  const frontendCss = await readFile(join(frontend, styleLinks[0]), "utf8");
  if (!/\[data-dsh-sidebar-instant\],\s*\[data-dsh-sidebar-instant\]\s*\*\s*\{\s*transition:\s*none\s*!important\s*;\s*\}/.test(frontendCss)) {
    throw new Error("WebView compatibility: apply the current Android mobile stylesheet before patching sidebar transitions");
  }
  const toolRequire = createRequire(join(resolve(toolsDirectory), "package.json"));
  for (const [name, version] of Object.entries(TOOLS)) {
    // FormatJS intentionally does not export package.json. Read metadata from
    // the explicit host tool directory rather than importing that private path.
    const found = JSON.parse(await readFile(join(resolve(toolsDirectory), "node_modules", name, "package.json"), "utf8")).version;
    if (found !== version) throw new Error(`WebView build tools: ${name} must be ${version}, found ${found}`);
  }
  const esbuild = toolRequire("esbuild");
  const corePath = toolRequire.resolve("core-js-bundle/index.js");
  const inertPath = toolRequire.resolve("wicg-inert/dist/inert.min.js");
  const core = patchCoreResourceUrlDetection(await readFile(corePath, "utf8"));
  // Stock API30 WebView 83 cannot activate dsh-client-ui-chat without
  // Intl.Segmenter. Its live tool text requires Unicode grapheme boundaries;
  // PDF selection also uses grapheme/word segment records and UTF-16 indices.
  // FormatJS supplies CLDR/UAX #29 segmentation, preserving native Segmenter
  // on updated WebViews. Bundle its pinned locale-matcher dependencies too.
  const segmenter = esbuild.buildSync({
    entryPoints: [toolRequire.resolve("@formatjs/intl-segmenter/polyfill.js")],
    bundle: true, format: "iife", platform: "browser", target: TARGET,
    legalComments: "inline", minify: true, write: false,
  }).outputFiles[0].text;
  verifyIntlSegmenter(segmenter);
  const workerPolyfills = RESOURCE_URL_MARKER + "\n" + esbuild.transformSync(core + "\n" + BROWSER_ADDITIONS,
    { target: TARGET, legalComments: "inline", minify: true }).code;
  const modules = join(root, "node_modules");
  const deepseek = join(modules, "@deepseek-ai");
  const dist = join(deepseek, "dsh-web-frontend/dist");
  const files = new Set();
  async function collectStatic(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collectStatic(path);
      else if (/\.js$/.test(entry.name)) files.add(path);
      else if (/\.css$/.test(entry.name)) {
        const before = await readFile(path, "utf8");
        // Keep the separately versioned Android mobile layer intact.
        const mobile = before.indexOf("/* dsh-android-mobile */");
        const base = mobile === -1 ? before : before.slice(0, mobile);
        const tail = mobile === -1 ? "" : before.slice(mobile);
        const lowered = esbuild.transformSync(base, { loader: "css", target: TARGET, minify: true }).code;
        if (before !== lowered + tail) await writeFile(path, lowered + tail);
      }
    }
  }
  await collectStatic(dist);
  let packages = 0;
  for (const entry of await readdir(deepseek, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDirectory = join(deepseek, entry.name);
    const packageFile = join(packageDirectory, "package.json");
    if (!await exists(packageFile)) continue;
    const metadata = JSON.parse(await readFile(packageFile, "utf8"));
    let client = metadata.exports?.["./client"];
    if (client && typeof client === "object") client = client.default;
    if (typeof client !== "string") {
      if (metadata.dsh?.client) throw new Error(`WebView compatibility: missing ${entry.name} client export`);
      continue;
    }
    const main = join(packageDirectory, client);
    if (!await exists(main)) throw new Error(`WebView compatibility: missing ${entry.name} client bundle`);
    files.add(main);
    packages++;
    for (const chunk of await readdir(dirname(main), { withFileTypes: true })) {
      if (chunk.isFile() && /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(chunk.name)) {
        files.add(join(dirname(main), chunk.name));
      }
    }
  }
  let transformed = 0;
  for (const file of [...files].sort()) {
    const before = await readFile(file, "utf8");
    const marked = before.startsWith(MARKER);
    const label = file.slice(modules.length + 1);
    let source = marked ? before : patchWeakReferences(before, label);
    source = patchBrowserCases(source, label, esbuild, workerPolyfills);
    if (marked && source === before) continue;
    if (source.startsWith(MARKER)) source = source.slice(MARKER.length).trimStart();
    source = embeddedCss(source, esbuild);
    const format = file.startsWith(dist) ? "esm" : undefined;
    const result = esbuild.transformSync(source, { target: TARGET, format, sourcefile: label,
      legalComments: "inline", minify: false, sourcemap: false });
    await writeFile(file, `${MARKER}\n${result.code}`);
    transformed++;
  }
  const polyfill = core + "\n" + segmenter + "\n" +
    (await readFile(inertPath, "utf8")) + "\n" + BROWSER_ADDITIONS + "\n" + ANIMATION_FINISHED_ADDITIONS;
  const compiled = esbuild.transformSync(polyfill, { target: TARGET, legalComments: "inline", minify: true });
  await writeFile(join(dist, "assets/dsh-webview83-polyfills.js"), `${MARKER}\n${SEGMENTER_MARKER}\n${NATIVE_API_MARKER}\n${RESOURCE_URL_MARKER}\n${compiled.code}`);
  for (const name of ["core-js-bundle", "wicg-inert", "@formatjs/intl-segmenter",
    "@formatjs/intl-localematcher", "@formatjs/fast-memoize"]) {
    const packagePath = join(resolve(toolsDirectory), "node_modules", name);
    let license;
    for (const candidate of ["LICENSE", "LICENSE.md"]) {
      if (await exists(join(packagePath, candidate))) { license = candidate; break; }
    }
    if (!license) throw new Error(`WebView compatibility: missing ${name} license`);
    const label = name.replace(/^@/, "").replace(/\//g, "-");
    await copyFile(join(packagePath, license), join(dist, `dsh-webview83-${label}-LICENSE.txt`));
  }
  const indexPath = join(dist, "index.html");
  let index = await readFile(indexPath, "utf8");
  if (!index.includes(POLYFILL_TAG)) {
    if (!/<head(?:\s[^>]*)?>/i.test(index)) throw new Error("WebView compatibility: frontend has no head");
    index = index.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n    ${POLYFILL_TAG}`);
  }
  index = index.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attributes, script) => {
    if (/\bsrc\s*=/.test(attributes) || !script.trim()) return tag;
    const lowered = esbuild.transformSync(script, { target: TARGET, minify: true }).code.trim();
    return `<script${attributes}>${lowered}</script>`;
  });
  await writeFile(indexPath, index);
  await patchHtmlRenderer(root, esbuild);
  console.log(`patched: Android WebView 83: ${transformed}/${files.size} browser scripts, ${packages} client packages; pinned polyfills precede boot`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    console.log("usage: patch-android-webview.mjs <dsh-package-directory> <host-build-tools-directory>");
    console.log("tools: npm install --prefix <tools> --no-save esbuild@0.28.2 core-js-bundle@3.50.0 wicg-inert@3.1.3 @formatjs/intl-segmenter@12.2.15");
  } else {
    if (!process.argv[2] || !process.argv[3]) throw new Error("usage: patch-android-webview.mjs <dsh-package-directory> <host-build-tools-directory>");
    await patchAndroidWebView(resolve(process.argv[2]), resolve(process.argv[3]));
  }
}
