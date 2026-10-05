#!/usr/bin/env python3
"""Local, deterministic Messages fixtures; this is not a real DeepSeek model."""

from __future__ import annotations

import argparse
import errno
import json
import math
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

DUMMY_KEY = "dsh-loopback-test-key"
COMMAND = "printf 'ANDROID_DSH_LOOPBACK_OK\\n'"
MARKER = "ANDROID_DSH_LOOPBACK_OK"
JUSTIFICATION = "安卓无法提供命令沙箱，请批准执行这条仅输出测试标记的命令，以验证审批界面。"
SCENARIOS = {
    "dsh-test-text": "text",
    "dsh-test-longstream": "longstream",
    "dsh-test-bash": "bash",
    "dsh-test-approval": "approval",
}
MAX_BODY_BYTES = 8 * 1024 * 1024


def text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def controlled_results(messages: Any) -> list[dict[str, Any]]:
    """Summarize only this fixture's fixed command in the current user turn."""
    if not isinstance(messages, list):
        return []
    boundary = 0
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        blocks = message.get("content", [])
        if isinstance(blocks, list) and any(
            isinstance(block, dict) and block.get("type") == "tool_result"
            for block in blocks
        ):
            continue
        if text_of(blocks):
            boundary = index
    calls: dict[str, dict[str, Any]] = {}
    results = []
    for message in messages[boundary:]:
        if not isinstance(message, dict) or not isinstance(message.get("content"), list):
            continue
        for block in message["content"]:
            if not isinstance(block, dict):
                continue
            if message.get("role") == "assistant" and block.get("type") == "tool_use":
                arguments = block.get("input", {})
                call_id = block.get("id")
                if (
                    block.get("name") == "bash"
                    and isinstance(arguments, dict)
                    and arguments.get("command") == COMMAND
                    and isinstance(call_id, str)
                    and call_id.startswith("toolu_dsh-loopback-")
                ):
                    calls[call_id] = arguments
            elif message.get("role") == "user" and block.get("type") == "tool_result":
                call_id = block.get("tool_use_id")
                if not isinstance(call_id, str) or call_id not in calls:
                    continue
                text = text_of(block.get("content"))
                results.append(
                    {
                        "tool_use_id": call_id,
                        "approved_attempt": calls[call_id].get("sandbox_permissions")
                        == "danger-full-access",
                        "is_error": block.get("is_error") is True,
                        "sandbox_unavailable": "SANDBOX_UNAVAILABLE" in text
                        or "Android cannot enforce the requested workspace shell sandbox" in text,
                        "marker_present": MARKER in text,
                    }
                )
    return results


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, output_dir: Path, chunk_delay: float,
                 long_delay: float, long_chunks: int):
        self.output_dir = output_dir
        self.chunk_delay = chunk_delay
        self.long_delay = long_delay
        self.long_chunks = long_chunks
        self.stopping = threading.Event()
        self._log_lock = threading.Lock()
        self._counter = 0
        output_dir.mkdir(parents=True, exist_ok=True)
        self.log_path = output_dir / "requests.jsonl"
        super().__init__(("127.0.0.1", port), FixtureHandler)

    def next_id(self) -> str:
        with self._log_lock:
            self._counter += 1
            return f"dsh-loopback-{self._counter:06d}"

    def record(self, request_id: str, event: str, **facts: Any) -> None:
        record = {"request_id": request_id, "event": event, "time_ns": time.time_ns(), **facts}
        with self._log_lock:
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: FixtureServer

    def log_message(self, _format: str, *_arguments: Any) -> None:
        # BaseHTTPRequestHandler prints raw paths/headers in some error cases.
        # Only the allowlisted structured lifecycle log is retained.
        pass

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"fixture": True, "real_deepseek": False})
        else:
            self.send_json(404, {"error": {"type": "not_found_error", "message": "Unknown fixture route"}})

    def do_POST(self) -> None:
        request_id = self.server.next_id()
        path = urlsplit(self.path).path
        routes = {"/v1/messages": "text", "/default/v1/messages": "text"}
        routes.update({f"/{scenario}/v1/messages": scenario for scenario in SCENARIOS.values()})
        if path not in routes:
            self.send_json(404, {"error": {"type": "not_found_error", "message": "Unknown fixture route"}})
            return
        if self.headers.get("x-api-key") != DUMMY_KEY:
            self.server.record(request_id, "request_rejected", reason="dummy_key_required")
            self.send_json(401, {"type": "error", "error": {
                "type": "authentication_error", "message": "The fixed local fixture key is required"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY_BYTES:
                raise ValueError("body length")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or body.get("stream") is not True:
                raise ValueError("stream request")
            if not isinstance(body.get("model"), str) or not isinstance(body.get("messages"), list):
                raise ValueError("messages request")
        except (ValueError, UnicodeError, json.JSONDecodeError):
            self.server.record(request_id, "request_rejected", reason="invalid_messages_request")
            self.send_json(400, {"type": "error", "error": {
                "type": "invalid_request_error", "message": "Expected a streaming Messages JSON request"}})
            return
        model = body["model"]
        tools = body.get("tools", [])
        tool_names = [tool["name"] for tool in tools
                      if isinstance(tool, dict) and isinstance(tool.get("name"), str)] if isinstance(tools, list) else []
        scenario = SCENARIOS.get(model, routes[path])
        results = controlled_results(body["messages"])
        self.server.record(request_id, "request_received", model=model[:120], scenario=scenario,
                           tool_names=[name[:120] for name in tool_names], tool_results=results)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("request-id", request_id)
        self.end_headers()
        self.close_connection = True
        started = time.monotonic()
        chunks = 0
        self.server.record(request_id, "stream_started")
        try:
            for event, delay in self.events(request_id, body, scenario, tool_names, results):
                if self.server.stopping.wait(delay):
                    self.server.record(request_id, "stream_cancelled", reason="server_shutdown", chunks=chunks)
                    return
                frame = f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
                chunks += 1
            self.server.record(request_id, "stream_finished", chunks=chunks,
                               elapsed_ms=round((time.monotonic() - started) * 1000))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as error:
            self.server.record(request_id, "stream_cancelled", reason=type(error).__name__, chunks=chunks)
        except OSError as error:
            if error.errno in {errno.EPIPE, errno.ECONNRESET, errno.ECONNABORTED, errno.ENOTCONN}:
                self.server.record(request_id, "stream_cancelled", reason="client_disconnected", chunks=chunks)
            else:
                self.server.record(request_id, "stream_failed", reason=type(error).__name__, chunks=chunks)
                raise

    def events(self, request_id: str, body: dict[str, Any], scenario: str,
               tool_names: list[str], results: list[dict[str, Any]]):
        delay = self.server.chunk_delay
        yield {"type": "message_start", "message": {
            "id": f"msg_{request_id}", "type": "message", "role": "assistant",
            "model": body["model"], "content": [], "stop_reason": None,
            "stop_sequence": None, "usage": {"input_tokens": 8, "output_tokens": 0}}}, 0
        index = 0
        # Session-title requests have no tools. Always finish them promptly.
        if not tool_names:
            text = "Android 受控测试"
            scenario = "text"
        else:
            text = "本地受控 Messages 流式响应正常。"
            thinking = body.get("thinking", {})
            if isinstance(thinking, dict) and thinking.get("type") == "enabled":
                yield {"type": "content_block_start", "index": index,
                       "content_block": {"type": "thinking", "thinking": ""}}, delay
                yield {"type": "content_block_delta", "index": index,
                       "delta": {"type": "thinking_delta", "thinking": "这是本地受控协议测试。"}}, delay
                yield {"type": "content_block_delta", "index": index,
                       "delta": {"type": "signature_delta", "signature": "dsh-loopback-test-signature"}}, delay
                yield {"type": "content_block_stop", "index": index}, delay
                index += 1
        tool_input = None
        if scenario in {"bash", "approval"}:
            if "bash" not in tool_names:
                text = "受控请求未提供 bash 工具，未执行命令。"
            elif not results:
                tool_input = {"command": COMMAND, "description": "输出 Android 本地受控验证标记"}
            elif (scenario == "approval" and not results[-1]["approved_attempt"]
                  and results[-1]["sandbox_unavailable"]):
                tool_input = {"command": COMMAND, "description": "输出 Android 本地受控验证标记",
                              "sandbox_permissions": "danger-full-access", "justification": JUSTIFICATION}
            elif results[-1]["marker_present"] and not results[-1]["is_error"]:
                text = "受控 Bash 工具结果已收到：ANDROID_DSH_LOOPBACK_OK。"
            elif results[-1]["sandbox_unavailable"]:
                text = "受控 Bash 工具返回 SANDBOX_UNAVAILABLE，命令未执行。"
            else:
                text = "受控工具调用已结束；未收到成功标记，请检查工具结果或审批决定。"
        stop_reason = "end_turn"
        if tool_input is not None:
            suffix = "approved" if "sandbox_permissions" in tool_input else "default"
            call_id = f"toolu_{request_id}_{suffix}"
            yield {"type": "content_block_start", "index": index, "content_block": {
                "type": "tool_use", "id": call_id, "name": "bash", "input": {}}}, delay
            encoded = json.dumps(tool_input, ensure_ascii=False)
            step = max(1, len(encoded) // 3)
            for start in range(0, len(encoded), step):
                yield {"type": "content_block_delta", "index": index, "delta": {
                    "type": "input_json_delta", "partial_json": encoded[start:start + step]}}, delay
            yield {"type": "content_block_stop", "index": index}, delay
            stop_reason = "tool_use"
        else:
            yield {"type": "content_block_start", "index": index,
                   "content_block": {"type": "text", "text": ""}}, delay
            if scenario == "longstream":
                pieces = (f"受控流式片段 {number + 1}。 " for number in range(self.server.long_chunks))
                text_delay = self.server.long_delay
            else:
                pieces = (text[start:start + 5] for start in range(0, len(text), 5))
                text_delay = delay
            for piece in pieces:
                yield {"type": "content_block_delta", "index": index,
                       "delta": {"type": "text_delta", "text": piece}}, text_delay
            yield {"type": "content_block_stop", "index": index}, delay
        yield {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None},
               "usage": {"output_tokens": 16}}, delay
        yield {"type": "message_stop"}, 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 selects an available port")
    parser.add_argument("--output-dir", type=Path, required=True, help="Directory for server.json and privacy-filtered requests.jsonl")
    parser.add_argument("--chunk-delay", type=float, default=0.08, help="Seconds between ordinary SSE chunks")
    parser.add_argument("--long-delay", type=float, default=0.25, help="Seconds between longstream text chunks")
    parser.add_argument("--long-chunks", type=int, default=240, help="Longstream chunk count, allowing Stop cancellation testing")
    args = parser.parse_args()
    if (not 0 <= args.port <= 65535 or not math.isfinite(args.chunk_delay)
            or not math.isfinite(args.long_delay) or args.chunk_delay < 0
            or args.long_delay < 0 or args.long_chunks < 1):
        parser.error("port, delays, or long-chunks are out of range")
    server = FixtureServer(args.port, args.output_dir.resolve(), args.chunk_delay, args.long_delay, args.long_chunks)
    base = f"http://127.0.0.1:{server.server_port}"
    metadata = {"fixture": True, "real_deepseek": False, "host": "127.0.0.1", "port": server.server_port,
                "base_url": base, "scenario_base_urls": {name: f"{base}/{name}" for name in SCENARIOS.values()},
                "models": SCENARIOS, "request_log": str(server.log_path), "command": COMMAND}
    (server.output_dir / "server.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False), flush=True)

    def stop(_signum: int, _frame: Any) -> None:
        server.stopping.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.stopping.set()
        server.server_close()


if __name__ == "__main__":
    main()
