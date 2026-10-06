#!/usr/bin/env python3
"""Temporary HOST-only, byte-preserving transport for real Android DSH tests.

NIM credentials come ONLY from DSH_NIM_API_KEY. The Android provider receives a
random relay credential, never the NIM credential. The caller owns ADB reverse.
No prompts, headers, responses, screenshots, or credentials are logged. This is
not an agent and never generates tool calls or changes model requests/responses.

Start only after the environment's NVIDIA domain/key configuration is applied:
  python3 scripts/test-support/nim-test-relay.py --control-file /private/relay.json
The control file is created exclusively with mode 0600 and removed on exit.
Kill the recorded PID to tear down; the default lifetime is fifteen minutes.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import signal
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import (
    HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener,
    getproxies, proxy_bypass,
)

MODEL = "deepseek-ai/deepseek-v4.1-flash"
UPSTREAM = "https://integrate.api.nvidia.com/v1/chat/completions"
MAX_BODY = 8 * 1024 * 1024
SAFE_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,95}\Z")
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}


def private_json(path: Path, value: dict) -> None:
    """Never follow or overwrite an existing control file."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(value, out, separators=(",", ":"))
        out.write("\n")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Metadata:
    """Inspect only numeric usage and tool names; raw stream stays unchanged."""
    def __init__(self):
        self.pending = bytearray()
        self.tools: set[str] = set()
        self.tool_calls = 0
        self.usage: dict[str, int] = {}
        self.chunks = 0
        self.bytes = 0

    def feed(self, chunk: bytes) -> None:
        self.chunks += 1
        self.bytes += len(chunk)
        self.pending.extend(chunk)
        while b"\n" in self.pending:
            line, _, rest = self.pending.partition(b"\n")
            self.pending = bytearray(rest)
            if not line.startswith(b"data:"):
                continue
            try:
                value = json.loads(line[5:].strip())
            except (ValueError, UnicodeError):
                continue
            if not isinstance(value, dict):
                continue
            usage = value.get("usage")
            if isinstance(usage, dict):
                for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
                    number = usage.get(key)
                    if type(number) is int and number >= 0:
                        self.usage[key] = number
            for choice in value.get("choices", []) if isinstance(value.get("choices"), list) else []:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta", {})
                if not isinstance(delta, dict):
                    continue
                calls = delta.get("tool_calls", [])
                for call in calls if isinstance(calls, list) else []:
                    if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
                        continue
                    name = call["function"].get("name")
                    if isinstance(name, str) and SAFE_NAME.fullmatch(name):
                        self.tools.add(name)
                        self.tool_calls += 1
        # Malformed or non-SSE data must not grow a metadata buffer unboundedly.
        if len(self.pending) > 1024 * 1024:
            self.pending.clear()


class RelayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, token, api_key, opener, ttl, max_requests, max_tokens, metadata_path):
        super().__init__(("127.0.0.1", 0), RelayHandler)
        self.token, self.api_key, self.opener = token, api_key, opener
        self.deadline = time.monotonic() + ttl
        self.max_requests, self.max_tokens = max_requests, max_tokens
        self.count = 0
        self.lock = threading.Lock()
        self.metadata_path = metadata_path
        self.metadata_fd = os.open(metadata_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)

    def event(self, event: dict) -> None:
        with self.lock:
            os.write(self.metadata_fd, (json.dumps(event, separators=(",", ":")) + "\n").encode())

    def reserve(self):
        with self.lock:
            if time.monotonic() >= self.deadline:
                return None, 410
            if self.count >= self.max_requests:
                return None, 429
            self.count += 1
            return self.count, None

    def handle_error(self, request, client_address):
        # Base implementation prints tracebacks and potentially private data.
        self.event({"event": "handler_failure"})


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DSHTestRelay"
    sys_version = ""

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def reject(self, status: int):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def do_GET(self):
        self.reject(405)

    do_HEAD = do_GET
    do_OPTIONS = do_GET
    do_PUT = do_GET
    do_DELETE = do_GET

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self.reject(404)
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode(), ("Bearer " + self.server.token).encode()):
            return self.reject(401)
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
            return self.reject(400)
        try:
            size = int(self.headers["Content-Length"])
        except (ValueError, TypeError):
            return self.reject(400)
        if size < 1 or size > MAX_BODY:
            return self.reject(413)
        raw = self.rfile.read(size)
        if len(raw) != size:
            return self.reject(400)
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError):
            return self.reject(400)
        if not isinstance(body, dict) or body.get("model") != MODEL or body.get("stream") is not True:
            return self.reject(422)
        caps = [body[k] for k in ("max_tokens", "max_completion_tokens") if k in body]
        if not caps or any(type(cap) is not int or not 1 <= cap <= self.server.max_tokens for cap in caps):
            return self.reject(422)
        if body.get("n", 1) != 1 or not isinstance(body.get("messages"), list):
            return self.reject(422)
        request_id, refusal = self.server.reserve()
        if refusal:
            return self.reject(refusal)
        request_tools = []
        for tool in body.get("tools", []) if isinstance(body.get("tools"), list) else []:
            name = tool.get("function", {}).get("name") if isinstance(tool, dict) and isinstance(tool.get("function"), dict) else None
            if isinstance(name, str) and SAFE_NAME.fullmatch(name):
                request_tools.append(name)
        self.server.event({"event": "request", "request_id": request_id,
                           "tools": sorted(set(request_tools)), "message_count": len(body["messages"]),
                           "max_tokens": max(caps)})
        req = Request(UPSTREAM, data=raw, method="POST", headers={
            "Authorization": "Bearer " + self.server.api_key,
            "Content-Type": "application/json", "Accept": "text/event-stream",
            "Accept-Encoding": "identity",
        })
        stream = None
        headers_sent = False
        metadata = Metadata()
        status = None
        outcome = "transport_failure"
        try:
            try:
                stream = self.server.opener.open(req, timeout=min(45, max(1, self.server.deadline - time.monotonic())))
            except HTTPError as error:
                stream = error  # Preserve upstream error status and body too.
            status = stream.status if hasattr(stream, "status") else stream.code
            self.send_response(status)
            connection_tokens = {part.strip().lower() for part in stream.headers.get("Connection", "").split(",")}
            for name, value in stream.headers.items():
                if name.lower() not in HOP_HEADERS | connection_tokens | {"content-length"}:
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.end_headers()
            headers_sent = True
            self.close_connection = True
            while time.monotonic() < self.server.deadline:
                chunk = stream.read1(4096) if hasattr(stream, "read1") else stream.read(4096)
                if not chunk:
                    outcome = "complete"
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                metadata.feed(chunk)
            else:
                outcome = "expired"
        except (BrokenPipeError, ConnectionResetError):
            outcome = "client_disconnected"
        except Exception:
            if not headers_sent:
                self.reject(502)
        finally:
            if stream is not None:
                stream.close()
            self.server.event({"event": "response", "request_id": request_id, "status": status,
                               "outcome": outcome, "chunks": metadata.chunks, "bytes": metadata.bytes,
                               "tools": sorted(metadata.tools), "tool_calls": metadata.tool_calls,
                               "usage": metadata.usage})


def make_opener():
    proxies = getproxies()
    proxy = proxies.get("https") or proxies.get("http")
    if not proxy or proxy_bypass("integrate.api.nvidia.com"):
        raise RuntimeError("Inherited HTTPS proxy is required; direct upstream access is refused")
    # Honor the existing trust bundle, with standard certificate verification.
    cafile = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    context = ssl.create_default_context(cafile=cafile)
    return build_opener(ProxyHandler({"https": proxy}), HTTPSHandler(context=context), NoRedirect())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control-file", type=Path, required=True)
    parser.add_argument("--ttl-seconds", type=int, default=900)
    parser.add_argument("--max-requests", type=int, default=8)
    parser.add_argument("--max-tokens", type=int, choices=(256, 512), default=512)
    args = parser.parse_args()
    if not 30 <= args.ttl_seconds <= 1800 or not 1 <= args.max_requests <= 8:
        parser.error("lifetime must be 30..1800 seconds and request budget 1..8")
    api_key = os.environ.get("DSH_NIM_API_KEY")
    if not api_key:
        print("DSH_NIM_API_KEY is not configured; no network request made", file=sys.stderr)
        return 2
    token = secrets.token_urlsafe(48)
    control = args.control_file.absolute()
    metadata_path = control.with_suffix(".metadata.jsonl")
    if control.exists() or control.is_symlink():
        print("Control file already exists; refusing overwrite", file=sys.stderr)
        return 2
    server = RelayServer(token, api_key, make_opener(), args.ttl_seconds,
                         args.max_requests, args.max_tokens, metadata_path)
    control_created = False
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        private_json(control, {"version": 1, "pid": os.getpid(), "port": server.server_port,
                              "relay_token": token, "expires_at": int(time.time()) + args.ttl_seconds,
                              "model": MODEL, "max_requests": args.max_requests,
                              "max_tokens": args.max_tokens, "metadata_file": str(metadata_path)})
        control_created = True
        print("NIM test relay ready; control is private; no upstream request made", flush=True)
        while time.monotonic() < server.deadline and not stop.wait(0.5):
            pass
    finally:
        server.shutdown()
        server.server_close()
        if control_created:
            control.unlink(missing_ok=True)
        # Active workers are daemon threads. Exit closes their upstream sockets.
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print("NIM test relay failed; private diagnostics omitted", file=sys.stderr)
        raise SystemExit(1)
