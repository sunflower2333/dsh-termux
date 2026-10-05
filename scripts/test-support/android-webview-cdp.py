#!/usr/bin/env python3
"""Small, dependency-free CDP client for an already running Android WebView.

Examples after forwarding WebView's debugger socket to host port 9223:
  android-webview-cdp.py inspect
  android-webview-cdp.py screenshot /tmp/dsh-webview.png
  android-webview-cdp.py events --seconds 5
  android-webview-cdp.py click '[data-slot="settings.launcher"] button'

`inspect`, `viewport`, `screenshot`, and `events` do not change the DOM, emulated
viewport, storage, or browser context. `click` sends trusted input to the real
page; `evaluate` executes the supplied expression and can change the page.
Do not use evaluate to read credentials or page bodies. URLs are omitted from
target reports and redacted from diagnostic output. Screenshots can contain
visible private information and are written only to the requested local file.
No Browser.setDownloadBehavior or browser-context creation is required.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import ssl
import struct
import sys
import time
from typing import Any
from urllib.parse import urlsplit
from urllib.request import urlopen


class CdpError(RuntimeError):
    pass


SENSITIVE_KEYS = re.compile(
    r"^(?:password|secret|authorization|cookie|set-cookie|api[_-]?key|"
    r"(?:access|refresh|auth)[_-]?token|token|webSocketDebuggerUrl|url)$", re.I
)


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[redacted]" if SENSITIVE_KEYS.match(key) else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"(?:https?|wss?)://[^\s\"'<>]+", "[redacted URL]", value)
        value = re.sub(
            r"(?i)\bauthorization\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+",
            "authorization=[redacted]", value,
        )
        return re.sub(
            r"(?i)([\"']?\b(?:token|secret|password|authorization|api[_-]?key|cookie)"
            r"[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)",
            r"\1[redacted]", value,
        )
    return value


class WebSocket:
    """RFC6455 text messages, including fragmented frames and ping replies."""

    def __init__(self, endpoint: str, timeout: float):
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ("ws", "wss") or not parsed.hostname:
            raise CdpError("Debugger endpoint is not a WebSocket URL")
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        self.sock = socket.create_connection((parsed.hostname, port), timeout)
        if parsed.scheme == "wss":
            self.sock = ssl.create_default_context().wrap_socket(
                self.sock, server_hostname=parsed.hostname
            )
        self.buffer = bytearray()
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        host = parsed.hostname
        if ":" in host:
            host = "[" + host + "]"
        request = (
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        while b"\r\n\r\n" not in self.buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise CdpError("Debugger closed during WebSocket handshake")
            self.buffer.extend(chunk)
            if len(self.buffer) > 65536:
                raise CdpError("WebSocket handshake headers exceed 64 KiB")
        raw_headers, remaining = self.buffer.split(b"\r\n\r\n", 1)
        self.buffer = bytearray(remaining)
        lines = raw_headers.decode("iso-8859-1").split("\r\n")
        if len(lines[0].split()) < 2 or lines[0].split()[1] != "101":
            self.close()
            raise CdpError("Debugger refused WebSocket upgrade")
        headers = dict(
            (line.split(":", 1)[0].strip().lower(), line.split(":", 1)[1].strip())
            for line in lines[1:] if ":" in line
        )
        expected = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
        ).digest()).decode("ascii")
        if headers.get("sec-websocket-accept") != expected:
            self.close()
            raise CdpError("Invalid WebSocket upgrade response")

    def close(self):
        self.sock.close()

    def _read(self, count: int, deadline: float) -> bytes:
        while len(self.buffer) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("CDP receive timed out")
            self.sock.settimeout(remaining)
            chunk = self.sock.recv(min(65536, count - len(self.buffer)))
            if not chunk:
                raise CdpError("Debugger closed the WebSocket")
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def _send_frame(self, opcode: int, payload: bytes):
        size = len(payload)
        header = bytes([0x80 | opcode])
        if size < 126:
            header += bytes([0x80 | size])
        elif size < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", size)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", size)
        mask = os.urandom(4)
        body = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(header + mask + body)

    def send_json(self, value: Any):
        self._send_frame(1, json.dumps(value).encode("utf-8"))

    def receive_json(self, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        chunks = []
        total = 0
        while True:
            first, second = self._read(2, deadline)
            opcode = first & 0x0F
            size = second & 0x7F
            if size == 126:
                size = struct.unpack("!H", self._read(2, deadline))[0]
            elif size == 127:
                size = struct.unpack("!Q", self._read(8, deadline))[0]
            if size > 64 * 1024 * 1024:
                raise CdpError("CDP frame exceeds 64 MiB")
            mask = self._read(4, deadline) if second & 0x80 else None
            payload = self._read(size, deadline)
            if mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 8:
                raise CdpError("Debugger closed the WebSocket")
            if opcode == 9:
                self._send_frame(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise CdpError("CDP sent an unsupported WebSocket message")
            chunks.append(payload)
            total += len(payload)
            if total > 64 * 1024 * 1024:
                raise CdpError("CDP message exceeds 64 MiB")
            if first & 0x80:
                return json.loads(b"".join(chunks).decode("utf-8"))


FEATURES = """(() => ({
  userAgent: navigator.userAgent,
  viewport: {
    innerWidth, innerHeight, devicePixelRatio,
    screenWidth: screen.width, screenHeight: screen.height,
    documentWidth: document.documentElement.clientWidth,
    documentHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    visual: window.visualViewport ? {
      width: visualViewport.width, height: visualViewport.height,
      scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft,
      offsetTop: visualViewport.offsetTop
    } : null
  },
  features: {
    intlSegmenter: typeof Intl.Segmenter === 'function',
    intlDisplayNames: typeof Intl.DisplayNames === 'function',
    objectHasOwn: typeof Object.hasOwn === 'function',
    structuredClone: typeof structuredClone === 'function',
    arrayAt: typeof Array.prototype.at === 'function',
    arrayFindLast: typeof Array.prototype.findLast === 'function',
    stringReplaceAll: typeof String.prototype.replaceAll === 'function',
    cryptoRandomUUID: typeof crypto.randomUUID === 'function',
    resizeObserver: typeof ResizeObserver === 'function',
    intersectionObserver: typeof IntersectionObserver === 'function',
    clipboard: typeof navigator.clipboard !== 'undefined',
    visualViewport: typeof window.visualViewport !== 'undefined',
    cssHas: CSS.supports('selector(:has(*))'),
    cssDvh: CSS.supports('height: 100dvh'),
    cssColorMix: CSS.supports('color', 'color-mix(in srgb, red, blue)'),
    cssGap: CSS.supports('gap', '1px')
  },
  dom: {
    readyState: document.readyState,
    buttons: document.querySelectorAll('button').length,
    fileInputs: document.querySelectorAll('input[type=file]').length,
    composer: !!document.querySelector('[data-composer-input]'),
    settingsLauncher: !!document.querySelector('[data-slot="settings.launcher"] button')
  }
}))()"""


def diagnostic_event(message: dict) -> dict | None:
    method, params = message.get("method"), message.get("params", {})
    if method == "Runtime.consoleAPICalled":
        # Do not resolve object previews/properties, which can contain app data.
        arguments = []
        for item in params.get("args", []):
            if item.get("type") == "string":
                # Ordinary app logs can contain request/response bodies. Only
                # error/warning messages are needed for startup diagnostics.
                if params.get("type") in ("error", "warning", "warn"):
                    arguments.append(str(item.get("value", ""))[:2000])
                else:
                    arguments.append({"type": "string", "characters": len(str(item.get("value", "")))})
            elif item.get("subtype") == "error":
                arguments.append(str(item.get("description", ""))[:2000])
            else:
                arguments.append({"type": item.get("type"), "class": item.get("className")})
        return redact({"method": method, "type": params.get("type"), "arguments": arguments})
    if method == "Runtime.exceptionThrown":
        detail = params.get("exceptionDetails", {})
        exception = detail.get("exception", {})
        return redact({
            "method": method, "text": detail.get("text"),
            "description": str(exception.get("description", ""))[:4000],
            "line": detail.get("lineNumber"), "column": detail.get("columnNumber"),
        })
    if method == "Log.entryAdded":
        entry = params.get("entry", {})
        return redact({
            "method": method, "source": entry.get("source"),
            "level": entry.get("level"), "text": str(entry.get("text", ""))[:2000],
        })
    return None


class CdpClient:
    def __init__(self, endpoint: str, timeout: float = 15):
        self.websocket = WebSocket(endpoint, timeout)
        self.timeout = timeout
        self.next_id = 0
        self.events: list[dict] = []

    def __enter__(self):
        self.call("Runtime.enable")
        self.call("Page.enable")
        try:
            self.call("Log.enable")
        except CdpError:
            pass  # Some old WebViews do not expose the optional Log domain.
        return self

    def __exit__(self, *_):
        self.websocket.close()

    def call(self, method: str, params: dict | None = None, timeout: float | None = None):
        self.next_id += 1
        command_id = self.next_id
        self.websocket.send_json({"id": command_id, "method": method, "params": params or {}})
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        while True:
            message = self.websocket.receive_json(max(0, deadline - time.monotonic()))
            if message.get("id") == command_id:
                if "error" in message:
                    raise CdpError(f"{method}: {redact(message['error'].get('message', 'CDP error'))}")
                return message.get("result", {})
            if "method" in message:
                self.events.append(message)

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
        })
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            description = detail.get("exception", {}).get("description", detail.get("text"))
            raise CdpError("Runtime.evaluate exception: " + str(redact(description)))
        remote = result.get("result", {})
        if "value" in remote:
            return remote["value"]
        if "unserializableValue" in remote:
            return remote["unserializableValue"]
        return None

    def collect(self, seconds: float) -> list[dict]:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                message = self.websocket.receive_json(deadline - time.monotonic())
            except (TimeoutError, socket.timeout):
                break
            if "method" in message:
                self.events.append(message)
        return [event for message in self.events if (event := diagnostic_event(message)) is not None]

    def screenshot(self, path: Path):
        try:
            result = self.call("Page.captureScreenshot", {"format": "png", "fromSurface": True})
            encoded = result["data"]
            source = "Page.captureScreenshot"
        except CdpError:
            # Old Android WebViews may expose screencast but not captureScreenshot.
            self.call("Page.startScreencast", {"format": "png", "everyNthFrame": 1})
            deadline = time.monotonic() + self.timeout
            frame = None
            try:
                while frame is None:
                    for index, message in enumerate(self.events):
                        if message.get("method") == "Page.screencastFrame":
                            frame = self.events.pop(index)["params"]
                            break
                    if frame is None:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("WebView did not produce a screencast frame")
                        message = self.websocket.receive_json(deadline - time.monotonic())
                        if "method" in message:
                            self.events.append(message)
                encoded = frame["data"]
                self.call("Page.screencastFrameAck", {"sessionId": frame["sessionId"]})
                source = "Page.screencastFrame"
            finally:
                self.call("Page.stopScreencast")
        image = base64.b64decode(encoded, validate=True)
        if not image.startswith(b"\x89PNG\r\n\x1a\n"):
            raise CdpError("Screenshot did not contain a PNG")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(image)
        return {"path": str(path), "bytes": len(image), "source": source}

    def click(self, selector: str, touch: bool = False):
        expression = """(() => {
          const el = document.querySelector(SELECTOR);
          if (!el) throw new Error('Click selector did not match an element');
          if (!(el instanceof HTMLElement)) throw new Error('Click target is not an HTMLElement');
          if (el.disabled || el.getAttribute('aria-disabled') === 'true')
            throw new Error('Click target is disabled');
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          if (!rect.width || !rect.height || style.visibility === 'hidden' ||
              style.display === 'none' || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
            throw new Error('Click target is not visible within the real viewport');
          const top = document.elementFromPoint(x, y);
          if (!top || (top !== el && !el.contains(top)))
            throw new Error('Click target is covered by another element');
          return {x, y, tag: el.tagName.toLowerCase()};
        })()""".replace("SELECTOR", json.dumps(selector))
        position = self.evaluate(expression)
        point = {"x": position["x"], "y": position["y"]}
        if touch:
            self.call("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point]})
            self.call("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        else:
            for kind in ("mousePressed", "mouseReleased"):
                self.call("Input.dispatchMouseEvent", {
                    "type": kind, "button": "left", "clickCount": 1, **point,
                })
        return {"clicked": True, "input": "touch" if touch else "mouse", **position}


def page_targets(base: str, timeout: float) -> list[dict]:
    with urlopen(base.rstrip("/") + "/json/list", timeout=timeout) as response:
        targets = json.load(response)
    return [target for target in targets if target.get("type") == "page" and target.get("webSocketDebuggerUrl")]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--endpoint", default="http://127.0.0.1:9223")
    parser.add_argument("--target", help="exact page target id; required when multiple pages exist")
    parser.add_argument("--timeout", type=float, default=20)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("targets", "inspect", "viewport"):
        commands.add_parser(name)
    commands.add_parser("evaluate").add_argument("expression")
    commands.add_parser("screenshot").add_argument("path", type=Path)
    events = commands.add_parser("events")
    events.add_argument("--seconds", type=float, default=5)
    click = commands.add_parser("click")
    click.add_argument("selector")
    click.add_argument("--touch", action="store_true")
    args = parser.parse_args()
    if args.timeout <= 0 or args.timeout > 60:
        raise CdpError("Timeout must be between 0 and 60 seconds")
    if args.command == "events" and not 0 <= args.seconds <= 60:
        raise CdpError("Event collection must be between 0 and 60 seconds")
    targets = page_targets(args.endpoint, args.timeout)
    if args.command == "targets":
        result = [{"id": target["id"], "type": target["type"], "title": target.get("title")} for target in targets]
    else:
        matches = [target for target in targets if not args.target or target["id"] == args.target]
        if len(matches) != 1:
            raise CdpError("Select exactly one page target with --target; use targets to list safe metadata")
        target = matches[0]
        with CdpClient(target["webSocketDebuggerUrl"], args.timeout) as client:
            if args.command == "inspect":
                result = {
                    "target": target["id"], "page": client.evaluate(FEATURES),
                    "diagnostics": client.collect(0.2),
                }
            elif args.command == "viewport":
                result = client.evaluate(FEATURES)["viewport"]
            elif args.command == "evaluate":
                result = client.evaluate(args.expression)
            elif args.command == "screenshot":
                result = client.screenshot(args.path)
            elif args.command == "events":
                result = client.collect(args.seconds)
            elif args.command == "click":
                result = client.click(args.selector, args.touch)
    print(json.dumps(redact(result), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (CdpError, OSError, ValueError) as error:
        print(json.dumps({"error": redact(str(error))}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
